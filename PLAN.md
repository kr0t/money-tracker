# PLAN.md — Устранение критических проблем безопасности (п.1–4)

Решения: fail-closed везде; счётчик попыток входа в D1; проверка curl-скриптом.

## A. Конфиг без дефолтов (п.1, п.2)
Файлы: `functions/api/_auth.js`, `functions/api/auth/login.js`, `functions/api/_middleware.js`

- [x] Удалить `DEFAULT_PIN = "1234"` и фолбэк `"money-tracker-default-secret"`
- [x] `getAuthConfig(env) -> {pin, secret}`: ошибка, если переменная отсутствует/пустая,
      `secret === pin` или `len(secret) < 16`; trim/снятие кавычек сохранить
- [x] `login.js`: `AuthConfigError` → 500 `{"error": "Сервер не настроен: задайте AUTH_PIN и AUTH_SECRET"}`
      + `console.error` для `wrangler tail`
- [x] `verifyAuthToken` без конфига → `false` (middleware отдаёт 401 всем — fail-closed)
- [x] Формат токена и имя куки `mt_auth` не меняются

## B. Защита от брутфорса (п.3)
Файлы: новый `functions/api/_ratelimit.js`, `migrations/0003_login_attempts.sql`, `schema.sql`, `functions/api/_db.js`

- [x] Таблица: `ip TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL`
      (миграция + CREATE в `schema.sql` и в `ensureSchema`)
- [x] Лимит 5 неудач / 15 мин на IP → 429 + `Retry-After`; успех → DELETE строки IP
- [x] Проверка lockout ДО сравнения PIN (заблокированный IP не пишет в D1)
- [x] Оппортунистическая чистка просроченных строк
- [x] IP: `CF-Connecting-IP` → `X-Forwarded-For` → `"local"`
- [x] Env-оверрайды `AUTH_MAX_ATTEMPTS` (5) и `AUTH_LOCKOUT_WINDOW_SECONDS` (900)

## C. Авторизация в Python-сервере (п.4)
Файл: `app.py`

- [x] Чтение `AUTH_PIN`/`AUTH_SECRET` из env; валидация в `main()` по правилам блока A
      → сообщение в stderr + `sys.exit(1)`
- [x] Тот же формат токена и куки (`mt_auth; HttpOnly; SameSite=Lax`, `Secure`
      при `X-Forwarded-Proto == https`); подпись через `hmac.compare_digest`
- [x] Эндпоинты, совместимые с CF по JSON: `POST /api/auth/login` (400/401/429/500),
      `GET /api/auth/check`, `POST /api/auth/logout`
- [x] Гейт: все `/api/*`, кроме auth-роутов, без куки → 401 `{"error": "Требуется авторизация"}`
- [x] Rate limit в памяти: `threading.Lock` + dict, те же лимиты и env-оверрайды;
      ключ — первый hop `X-Forwarded-For`, иначе `client_address`
- [x] `db.py` не трогать (п.5 вне скоупа)

## D. Docker / deploy
Файлы: `docker-compose.yml`, `deploy/docker-compose.prod.yml`, `deploy/.env.example`

- [x] Dev-compose: порт `127.0.0.1:8080:8080`; `AUTH_PIN`/`AUTH_SECRET` через `${VAR:?}`
- [x] Prod-compose: проброс обеих переменных в app; обновить `.env.example`

## E. Документация и гигиена секретов
Файлы: `.gitignore`, `.dev.vars.example`, `README.md`, новый `.env.example`

- [x] `.gitignore`: добавить `.dev.vars`, `.env`
- [x] `.dev.vars.example`: `AUTH_PIN="change-me"`, `AUTH_SECRET=""` + комментарий `openssl rand -hex 32`
- [x] README: обе переменные обязательны; установка в Pages как секреты + redeploy;
      запуск Python `AUTH_PIN=… AUTH_SECRET=… python3 app.py`; убрать упоминания дефолтного PIN

## F. Smoke-скрипт — новый `scripts/auth_smoke.sh`

Bash + curl (без jq), параметр `BASE_URL`, работает против обоих бэкендов:
1. `/api/summary` без куки → 401
2. login без PIN → 400
3. 5 неверных PIN → 401
4. 6-я попытка (даже верная) → 429 + `Retry-After`
5. после окна (запуск с `AUTH_LOCKOUT_WINDOW_SECONDS=5`) верный PIN → 200 + Set-Cookie
6. `/api/summary` с кукой → 200
7. `/api/auth/check` → true / false
8. logout → снова 401
9. без переменных: CF login → 500 misconfig; Python → не стартует

## Порядок работ и проверка

A → B → C → D → E → F.
- `npx wrangler d1 migrations apply money-tracker-db --local` (remote — только по запросу)
- `BASE_URL=http://127.0.0.1:8788 ./scripts/auth_smoke.sh` (wrangler dev)
- `BASE_URL=http://127.0.0.1:8081 ./scripts/auth_smoke.sh` (python)

## Breaking changes

- Деплой без `AUTH_SECRET` больше никого не пускает — задать ДО деплоя
- Все текущие сессии инвалидируются (ключ подписи меняется) — один перелогин
- `python3 app.py` и dev-compose без env больше не работают «из коробки»

## Вне скоупа

П.5–7 (атомарность D1/SQLite, консолидация бэкендов, дубль `public/` vs `static/`),
п.9–10, префикс `__Host-` для куки.
