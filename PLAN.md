# PLAN.md — п.10: тесты и CI

Решения: ноль новых зависимостей — stdlib `unittest` (Python) и встроенный
`node:test` (Node 18+). CI — GitHub Actions, два job'а (Python-стек и
Cloudflare-стек), каждый гоняет юнит- и e2e-проверки.

## A. Юнит-тесты

- [x] `tests/test_app.py` (unittest): `_parse_amount_to_cents` (валид/невалид,
      запятая, пробелы, bool), `_get_auth_config` (все правила fail-closed,
      снятие кавычек), токены (`_create_auth_token`/`_verify_auth_token`:
      roundtrip, чужой секрет, подделка подписи/payload, истёкший exp, мусор)
- [x] `tests/test_db.py` (unittest, `DATA_DIR` → temp до импорта `db`):
      баланс/овердрафт, точное совпадение с балансом, дубликат `request_id`,
      освобождение ключа после отказа, `create_debt` с начальной суммой,
      repay (списание + linked_tx_id), отказы repay, `delete_transaction`
      (обычный и связанный с долгом), флаг `linked_to_debt`, чистка
      `processed_requests` старше 24 ч
- [x] `tests/amount.test.js` (node:test): `parseAmountToCents` — зеркально Python
- [x] `tests/auth.test.js` (node:test): `getAuthConfig` (env-объекты, все правила),
      токены roundtrip/подделка/чужой секрет/fail-closed без конфига/истёкший
- [x] `package.json`: `"test": "node --test tests/"`

## B. CI — `.github/workflows/ci.yml`

- [x] Триггеры: push в `main` + все pull_request
- [x] Job `python` (ubuntu, setup-python): py_compile + bash -n → unittest →
      старт `app.py` (герметичный `DATA_DIR`, окно lockout 5 c) → `auth_smoke.sh`
      + `integrity_check.py`
- [x] Job `cloudflare` (ubuntu, setup-node 22, `npm ci`, кэш npm):
      node --check всех functions → `npm test` → генерация `.dev.vars` с
      тестовыми значениями → `wrangler pages dev` (локальная D1) →
      `auth_smoke.sh` + `integrity_check.py`

## C. Документация

- [x] README: бейдж CI, раздел «Тесты» (команды юнит/e2e, что гоняет CI)

## D. Верификация локально

- [x] `python3 -m unittest discover -s tests -p "test_*.py" -v` — все зелёные
- [x] `npm test` — все зелёные
- [x] e2e против обоих бэкендов не регрессировали (пattern из прошлых блоков)
- [x] YAML workflow валиден (парсер)

## Вне скоупа

Покрытие фронтенда (app.js) e2e-тестами браузера; линтеры (в репо не настроены).
