#!/usr/bin/env bash
# Smoke-тесты авторизации money-tracker. Работает против обоих бэкендов
# (wrangler pages dev и python app.py).
#
# Использование:
#   AUTH_PIN=1234 BASE_URL=http://127.0.0.1:8788 ./scripts/auth_smoke.sh
#
# Требования к тестируемому серверу:
#   - запущен с тем же AUTH_PIN, что передан скрипту;
#   - AUTH_LOCKOUT_WINDOW_SECONDS=5 (чтобы проверить разблокировку быстро);
#   - AUTH_MAX_ATTEMPTS не задан или равен 5.
#
# Опционально:
#   CF_NOENV_URL — URL wrangler-инстанса, запущенного БЕЗ .dev.vars
#   (проверяется сценарий 500 misconfig для Cloudflare);
#   LOCKOUT_WAIT — сколько секунд ждать истечения окна блокировки (по умолчанию 6).

set -u

BASE_URL="${BASE_URL:-http://127.0.0.1:8788}"
PIN="${AUTH_PIN:?Set AUTH_PIN to the server PIN}"
LOCKOUT_WAIT="${LOCKOUT_WAIT:-6}"

PASS=0
FAIL=0
TMP_DIR="$(mktemp -d)"
COOKIE_JAR="$TMP_DIR/cookies"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

check() {
  desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1))
    printf 'ok   - %s\n' "$desc"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL - %s (expected: %s, got: %s)\n' "$desc" "$expected" "$actual"
  fi
}

code_of() {
  curl -s -o /dev/null -w '%{http_code}' "$@"
}

post_json() {
  url="$1" data="$2"
  curl -s -o /dev/null -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' -d "$data" "$url"
}

echo "Auth smoke tests against $BASE_URL"

# 1. Сводка без куки -> 401
check "1. summary without cookie -> 401" 401 "$(code_of "$BASE_URL/api/summary")"

# 2. Логин без PIN -> 400
check "2. login without pin -> 400" 400 "$(post_json "$BASE_URL/api/auth/login" '{}')"

# 3. Пять неверных PIN -> 401 каждая
BAD_PIN="wrong-pin-$$"
i=1
while [ "$i" -le 5 ]; do
  check "3.$i wrong pin -> 401" 401 \
    "$(post_json "$BASE_URL/api/auth/login" "{\"pin\":\"$BAD_PIN\"}")"
  i=$((i + 1))
done

# 4. Шестая попытка с ВЕРНЫМ PIN -> 429 + Retry-After
LOCKOUT_HEADERS="$TMP_DIR/lockout_headers"
LOCKOUT_CODE="$(curl -s -o /dev/null -D "$LOCKOUT_HEADERS" -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' -d "{\"pin\":\"$PIN\"}" "$BASE_URL/api/auth/login")"
check "4. sixth attempt (correct pin) -> 429" 429 "$LOCKOUT_CODE"
RETRY_AFTER="$(tr -d '\r' < "$LOCKOUT_HEADERS" | grep -i '^retry-after:' | cut -d' ' -f2)"
check "4b. 429 includes Retry-After" "yes" "$([ -n "$RETRY_AFTER" ] && echo yes || echo no)"

# 5. Ждём истечения окна блокировки, затем верный PIN -> 200 + Set-Cookie
echo "     waiting ${LOCKOUT_WAIT}s for the lockout window to expire..."
sleep "$LOCKOUT_WAIT"
LOGIN_CODE="$(curl -s -o /dev/null -c "$COOKIE_JAR" -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' -d "{\"pin\":\"$PIN\"}" "$BASE_URL/api/auth/login")"
check "5. correct pin after window -> 200" 200 "$LOGIN_CODE"
check "5b. cookie mt_auth received" "yes" "$(grep -q mt_auth "$COOKIE_JAR" && echo yes || echo no)"

# 6. Сводка с кукой -> 200
check "6. summary with cookie -> 200" 200 "$(code_of -b "$COOKIE_JAR" "$BASE_URL/api/summary")"

# 7. Проверка сессии
CHECK_TRUE="$(curl -s -b "$COOKIE_JAR" "$BASE_URL/api/auth/check")"
check "7. auth/check with cookie -> true" "yes" \
  "$(printf '%s' "$CHECK_TRUE" | grep -q '"authenticated":[[:space:]]*true' && echo yes || echo no)"
CHECK_FALSE="$(curl -s "$BASE_URL/api/auth/check")"
check "7b. auth/check without cookie -> false" "yes" \
  "$(printf '%s' "$CHECK_FALSE" | grep -q '"authenticated":[[:space:]]*false' && echo yes || echo no)"

# 8. Logout -> 200, затем сводка снова 401
LOGOUT_CODE="$(curl -s -o /dev/null -b "$COOKIE_JAR" -c "$COOKIE_JAR" -w '%{http_code}' \
  -X POST "$BASE_URL/api/auth/logout")"
check "8. logout -> 200" 200 "$LOGOUT_CODE"
check "8b. summary after logout -> 401" 401 "$(code_of -b "$COOKIE_JAR" "$BASE_URL/api/summary")"

# 9a. Python без env-переменных должен отказаться стартовать
if command -v python3 >/dev/null 2>&1; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  REPO_DIR="$(dirname "$SCRIPT_DIR")"
  (cd "$REPO_DIR" && env -u AUTH_PIN -u AUTH_SECRET HOST=127.0.0.1 PORT=18080 \
    python3 app.py > "$TMP_DIR/noenv.log" 2>&1) &
  NOENV_PID=$!
  sleep 2
  if kill -0 "$NOENV_PID" 2>/dev/null; then
    kill "$NOENV_PID" 2>/dev/null
    wait "$NOENV_PID" 2>/dev/null
    check "9a. python without env vars refuses to start" "yes" "no (still running)"
  else
    wait "$NOENV_PID" 2>/dev/null
    check "9a. python without env vars refuses to start" "yes" "yes"
  fi
else
  echo "skip - 9a. python3 not found"
fi

# 9b. Cloudflare без .dev.vars -> login 500 (опционально)
if [ -n "${CF_NOENV_URL:-}" ]; then
  check "9b. CF login without config -> 500" 500 \
    "$(post_json "$CF_NOENV_URL/api/auth/login" '{"pin":"x"}')"
else
  echo "skip - 9b. CF_NOENV_URL is not set"
fi

echo
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]
