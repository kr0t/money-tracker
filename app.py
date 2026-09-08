"""Local HTTP server and JSON API for the money tracker."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import sys
import threading
import time
from decimal import Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import db

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8080"))

AMOUNT_RE = re.compile(r"^\d+(\.\d{1,2})?$")

AUTH_COOKIE_NAME = "mt_auth"
AUTH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
AUTH_MIN_SECRET_LENGTH = 16
AUTH_PATHS = ("/api/auth/login", "/api/auth/check", "/api/auth/logout")


class AuthConfigError(Exception):
    """Raised when AUTH_PIN/AUTH_SECRET are missing or insecure."""


def _clean_env_value(raw: str) -> str:
    text = (raw or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("\"", "'"):
        text = text[1:-1].strip()
    return text


def _get_auth_config() -> tuple[str, str]:
    pin = _clean_env_value(os.environ.get("AUTH_PIN", ""))
    secret = _clean_env_value(os.environ.get("AUTH_SECRET", ""))

    if not pin:
        raise AuthConfigError("AUTH_PIN не задан")
    if not secret:
        raise AuthConfigError("AUTH_SECRET не задан")
    if len(secret) < AUTH_MIN_SECRET_LENGTH:
        raise AuthConfigError(
            f"AUTH_SECRET должен быть не короче {AUTH_MIN_SECRET_LENGTH} символов "
            "(сгенерируйте: openssl rand -hex 32)"
        )
    if secret == pin:
        raise AuthConfigError("AUTH_SECRET не должен совпадать с AUTH_PIN")

    return pin, secret


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)


def _create_auth_token(secret: str) -> str:
    now = int(time.time())
    payload = json.dumps(
        {"iat": now, "exp": now + AUTH_TOKEN_TTL_SECONDS},
        separators=(",", ":"),
    ).encode("utf-8")
    payload_b64 = _b64url_encode(payload)
    signature = hmac.new(
        secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256
    ).hexdigest()
    return f"{payload_b64}.{signature}"


def _verify_auth_token(token, secret: str) -> bool:
    if not token or not isinstance(token, str):
        return False

    parts = token.split(".")
    if len(parts) != 2:
        return False

    payload_b64, signature_hex = parts
    expected = hmac.new(
        secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, signature_hex):
        return False

    try:
        payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return False

    exp = payload.get("exp")
    if not isinstance(exp, int):
        return False
    return exp >= int(time.time())


def _rate_limit_settings() -> tuple[int, int]:
    def positive_int(name: str) -> int:
        try:
            value = int(os.environ.get(name, ""))
        except ValueError:
            return 0
        return value if value > 0 else 0

    max_attempts = positive_int("AUTH_MAX_ATTEMPTS") or 5
    window_seconds = positive_int("AUTH_LOCKOUT_WINDOW_SECONDS") or 900
    return max_attempts, window_seconds


class _LoginRateLimiter:
    """In-memory failed-login counter per client IP (fixed window)."""

    RETENTION_SECONDS = 24 * 60 * 60

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._attempts = {}  # ip -> (window_start, fail_count)

    def check(self, ip: str) -> tuple[bool, int]:
        """Return (locked, retry_after_seconds); call before comparing the PIN."""
        max_attempts, window_seconds = _rate_limit_settings()
        now = int(time.time())
        with self._lock:
            record = self._attempts.get(ip)
            if record is None:
                return False, 0
            window_start, fail_count = record
            if now - window_start >= window_seconds:
                return False, 0
            if fail_count >= max_attempts:
                return True, max(window_start + window_seconds - now, 1)
            return False, 0

    def register_failure(self, ip: str) -> None:
        _, window_seconds = _rate_limit_settings()
        now = int(time.time())
        with self._lock:
            record = self._attempts.get(ip)
            if record is None or now - record[0] >= window_seconds:
                self._attempts[ip] = (now, 1)
            else:
                self._attempts[ip] = (record[0], record[1] + 1)

            expired = [
                key
                for key, (start, _) in self._attempts.items()
                if now - start >= self.RETENTION_SECONDS
            ]
            for key in expired:
                del self._attempts[key]

    def clear(self, ip: str) -> None:
        with self._lock:
            self._attempts.pop(ip, None)


_LOGIN_LIMITER = _LoginRateLimiter()


def _parse_amount_to_cents(raw) -> int:
    if raw is None:
        raise ValueError("amount is required")
    if isinstance(raw, bool):
        raise ValueError("amount must be a number")
    if isinstance(raw, (int, float)):
        text = str(raw)
    elif isinstance(raw, str):
        text = raw.strip().replace(",", ".")
    else:
        raise ValueError("amount must be a number")

    if not AMOUNT_RE.fullmatch(text):
        raise ValueError("amount must be a positive number with at most 2 decimals")

    try:
        value = Decimal(text)
    except InvalidOperation as exc:
        raise ValueError("invalid amount") from exc

    if value <= 0:
        raise ValueError("amount must be positive")

    return int(value * 100)


class Handler(BaseHTTPRequestHandler):
    server_version = "MoneyTracker/1.0"

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} - {fmt % args}")

    def _send(self, status: int, body: bytes, content_type: str, extra_headers=None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, payload: dict, extra_headers=None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8", extra_headers)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("invalid JSON body") from exc
        if not isinstance(data, dict):
            raise ValueError("JSON body must be an object")
        return data

    def _parse_cookies(self) -> dict:
        header = self.headers.get("Cookie", "") or ""
        cookies = {}
        for part in header.split(";"):
            trimmed = part.strip()
            if not trimmed:
                continue
            eq_index = trimmed.find("=")
            if eq_index == -1:
                continue
            name = trimmed[:eq_index].strip()
            value = trimmed[eq_index + 1:]
            if name:
                cookies[name] = value
        return cookies

    def _client_ip(self) -> str:
        forwarded = self.headers.get("X-Forwarded-For", "")
        first = forwarded.split(",")[0].strip() if forwarded else ""
        return first or self.client_address[0]

    def _is_https(self) -> bool:
        return self.headers.get("X-Forwarded-Proto", "").strip().lower() == "https"

    def _auth_cookie_header(self, token: str) -> str:
        secure = "Secure; " if self._is_https() else ""
        return (
            f"{AUTH_COOKIE_NAME}={token}; Path=/; HttpOnly; "
            f"{secure}SameSite=Lax; Max-Age={AUTH_TOKEN_TTL_SECONDS}"
        )

    def _logout_cookie_header(self) -> str:
        secure = "Secure; " if self._is_https() else ""
        return f"{AUTH_COOKIE_NAME}=; Path=/; HttpOnly; {secure}SameSite=Lax; Max-Age=0"

    def _check_auth(self) -> bool:
        try:
            _, secret = _get_auth_config()
        except AuthConfigError:
            return False
        token = self._parse_cookies().get(AUTH_COOKIE_NAME)
        return _verify_auth_token(token, secret)

    def do_GET(self) -> None:
        path = urlparse(self.path).path

        if path == "/api/auth/check":
            self._handle_auth_check()
            return

        if path.startswith("/api/"):
            if not self._check_auth():
                self._send_json(401, {"error": "Требуется авторизация"})
                return

            if path == "/api/summary":
                self._send_json(200, db.get_summary())
                return

            self._send_json(404, {"error": "not found"})
            return

        if path in ("/", "/index.html"):
            self._serve_file(STATIC_DIR / "index.html")
            return

        if path in ("/style.css", "/app.js"):
            self._serve_file(STATIC_DIR / path.lstrip("/"))
            return

        if path.startswith("/static/"):
            rel = path[len("/static/") :]
            if ".." in rel or rel.startswith("/"):
                self._send_json(400, {"error": "invalid path"})
                return
            self._serve_file(STATIC_DIR / rel)
            return

        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path

        if path == "/api/auth/login":
            self._handle_auth_login()
            return
        if path == "/api/auth/logout":
            self._handle_auth_logout()
            return

        if path.startswith("/api/"):
            if not self._check_auth():
                self._send_json(401, {"error": "Требуется авторизация"})
                return

            if path == "/api/income":
                self._handle_add(db.KIND_INCOME)
                return
            if path == "/api/expense":
                self._handle_add(db.KIND_EXPENSE)
                return
            if path == "/api/debt/borrow":
                self._handle_debt(db.DEBT_BORROW)
                return
            if path == "/api/debt/repay":
                self._handle_debt(db.DEBT_REPAY)
                return
            if path == "/api/debts":
                self._handle_create_debt()
                return
            if path == "/api/transactions/clear":
                self._handle_clear(db.clear_transactions)
                return
            if path == "/api/debt/clear":
                self._handle_clear_debt()
                return

            self._send_json(404, {"error": "not found"})
            return

        self._send_json(404, {"error": "not found"})

    def _handle_auth_login(self) -> None:
        ip = self._client_ip()

        try:
            data = self._read_json()
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})
            return

        try:
            pin, secret = _get_auth_config()
        except AuthConfigError as exc:
            print(f"[auth] {exc}", file=sys.stderr)
            self._send_json(500, {"error": "Сервер не настроен: задайте AUTH_PIN и AUTH_SECRET"})
            return

        locked, retry_after = _LOGIN_LIMITER.check(ip)
        if locked:
            self._send_json(
                429,
                {"error": "Слишком много неудачных попыток. Попробуйте позже."},
                extra_headers={"Retry-After": str(retry_after)},
            )
            return

        raw_pin = data.get("pin")
        submitted = (raw_pin if isinstance(raw_pin, str) else str(raw_pin or "")).strip()
        if not submitted:
            self._send_json(400, {"error": "Введите PIN-код или пароль"})
            return

        if not hmac.compare_digest(submitted.encode("utf-8"), pin.encode("utf-8")):
            _LOGIN_LIMITER.register_failure(ip)
            self._send_json(401, {"error": "Неверный PIN-код или пароль"})
            return

        _LOGIN_LIMITER.clear(ip)
        token = _create_auth_token(secret)
        self._send_json(
            200,
            {"ok": True},
            extra_headers={"Set-Cookie": self._auth_cookie_header(token)},
        )

    def _handle_auth_check(self) -> None:
        try:
            _, secret = _get_auth_config()
            token = self._parse_cookies().get(AUTH_COOKIE_NAME)
            authenticated = _verify_auth_token(token, secret)
        except AuthConfigError:
            authenticated = False
        self._send_json(200, {"authenticated": authenticated})

    def _handle_auth_logout(self) -> None:
        self._send_json(
            200,
            {"ok": True},
            extra_headers={"Set-Cookie": self._logout_cookie_header()},
        )

    def _read_amount_and_note(self) -> tuple[int, str]:
        data = self._read_json()
        amount_cents = _parse_amount_to_cents(data.get("amount"))
        note = data.get("note", "")
        if note is None:
            note = ""
        if not isinstance(note, str):
            raise ValueError("note must be a string")
        return amount_cents, note

    def _read_debt_id(self, data: dict) -> int:
        raw = data.get("debt_id")
        if raw is None:
            raise ValueError("debt_id is required")
        if isinstance(raw, bool) or not isinstance(raw, int):
            raise ValueError("debt_id must be an integer")
        if raw <= 0:
            raise ValueError("debt_id must be positive")
        return raw

    def _handle_add(self, kind: str) -> None:
        try:
            amount_cents, note = self._read_amount_and_note()
            tx = db.add_transaction(kind, amount_cents, note)
            summary = db.get_summary()
            self._send_json(201, {"transaction": tx, "summary": summary})
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})

    def _handle_debt(self, kind: str) -> None:
        try:
            data = self._read_json()
            debt_id = self._read_debt_id(data)
            amount_cents = _parse_amount_to_cents(data.get("amount"))
            note = data.get("note", "")
            if note is None:
                note = ""
            if not isinstance(note, str):
                raise ValueError("note must be a string")
            debt_tx = db.add_debt(debt_id, kind, amount_cents, note)
            summary = db.get_summary()
            self._send_json(201, {"debt_transaction": debt_tx, "summary": summary})
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})

    def _handle_create_debt(self) -> None:
        try:
            data = self._read_json()
            name = data.get("name", "")
            if not isinstance(name, str):
                raise ValueError("name must be a string")
            initial_cents = 0
            if data.get("amount") not in (None, ""):
                initial_cents = _parse_amount_to_cents(data.get("amount"))
            debt = db.create_debt(name, initial_cents)
            summary = db.get_summary()
            self._send_json(201, {"debt": debt, "summary": summary})
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})

    def _handle_clear(self, clearer) -> None:
        try:
            summary = clearer()
            self._send_json(200, {"summary": summary})
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})

    def _handle_clear_debt(self) -> None:
        try:
            data = self._read_json()
            debt_id = data.get("debt_id")
            if debt_id is None:
                summary = db.clear_debt_transactions()
            else:
                if isinstance(debt_id, bool) or not isinstance(debt_id, int):
                    raise ValueError("debt_id must be an integer")
                if debt_id <= 0:
                    raise ValueError("debt_id must be positive")
                summary = db.clear_debt_transactions(debt_id)
            self._send_json(200, {"summary": summary})
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})

    def _serve_file(self, path: Path) -> None:
        try:
            resolved = path.resolve()
            if not str(resolved).startswith(str(STATIC_DIR.resolve())):
                self._send_json(403, {"error": "forbidden"})
                return
            data = resolved.read_bytes()
        except FileNotFoundError:
            self._send_json(404, {"error": "not found"})
            return
        except OSError:
            self._send_json(500, {"error": "failed to read file"})
            return

        content_type = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon",
        }.get(resolved.suffix.lower(), "application/octet-stream")
        self._send(200, data, content_type)


def main() -> None:
    try:
        _get_auth_config()
    except AuthConfigError as exc:
        print(f"Ошибка конфигурации: {exc}", file=sys.stderr)
        print(
            "Задайте переменные окружения AUTH_PIN и AUTH_SECRET "
            "(секрет: openssl rand -hex 32) и перезапустите сервер.",
            file=sys.stderr,
        )
        sys.exit(1)

    db.init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Money tracker: http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
