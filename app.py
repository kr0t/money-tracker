"""Local HTTP server and JSON API for the money tracker."""

from __future__ import annotations

import json
import os
import re
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

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

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

    def do_GET(self) -> None:
        path = urlparse(self.path).path

        if path == "/api/summary":
            self._send_json(200, db.get_summary())
            return

        if path in ("/", "/index.html"):
            self._serve_file(STATIC_DIR / "index.html")
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
