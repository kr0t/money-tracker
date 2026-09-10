# PLAN.md — п.6 паритет бэкендов + п.7 единый фронтенд + п.9 чистка processed_requests

Решения: паритет (оба бэкенда остаются, Docker-деплой зависит от Python); п.7 и п.9
в том же блоке; проверка — расширение `scripts/integrity_check.py`.

## A. Python-паритет (п.6) — `db.py`, `app.py`

- [x] `init_db`: добавить `CREATE TABLE IF NOT EXISTS processed_requests`
      (таблица уже есть в `schema.sql`/миграции 0002 — новых миграций не нужно)
- [x] `add_transaction(..., request_id)`: резерв ключа `INSERT OR IGNORE` → дубликат
      возвращает `{duplicate: true, transaction: None}`; весь блок в одной транзакции
      `BEGIN IMMEDIATE` — отказ по балансу откатывает и резерв (компенсация не нужна,
      строгее JS-варианта); условный INSERT расхода из п.5 сохраняется
- [x] `app.py _handle_add`: принимать `request_id` (не-строка → игнор, как в JS),
      отвечать `200 {transaction: null, summary, duplicate: true}` на дубликат /
      `201 {transaction, summary, duplicate: false}`
- [x] `get_summary`/`_serialize_tx`: поле `linked_to_debt` через
      `EXISTS(SELECT 1 FROM debt_transactions WHERE linked_tx_id = t.id)`
- [x] Новый `db.delete_transaction(tx_id)`: в `_transaction` — удаление связанной
      записи долга + операции; `rowcount = 0` → «операция не найдена»
- [x] Новый роут `POST /api/transactions/delete` в `app.py` → `{summary}`

## B. Чистка processed_requests (п.9) — `_db.js` + `db.py`

- [x] Оппортунистический `DELETE` строк старше 24 ч сразу после резерва ключа
      (в обеих реализациях, по образцу `login_attempts`)

## C. Единый фронтенд (п.7)

- [x] Удалить `static/`; `app.py`: `STATIC_DIR = ROOT / "public"`;
      `Dockerfile`: `COPY public/ public/` (`.dockerignore` не блокирует)
- [x] `public/_headers` остаётся (для Pages важен, Python-серверу безвреден);
      кэш-бастер `?v=N` инкрементится в одном месте

## D. Верификация — расширение `scripts/integrity_check.py`

- [x] Тест 4 (undo): расход с `linked_to_debt=False` → delete → баланс восстановлен,
      повтор → 400; расход возврата долга с `linked_to_debt=True` → delete →
      долг восстановлен, repay-запись исчезла из истории долга
- [x] Тест 5 (идемпотентность): один `request_id` дважды → 201 + 200 `duplicate:true`,
      баланс вырос один раз; отклонённый expense (> баланса) → 400 → повтор тем же
      `request_id` с корректной суммой → 201 (ключ не сгорел)
- [x] Прогоны против обоих бэкендов (герметичные инстансы): `integrity_check.py` +
      `auth_smoke.sh`; проверка отдачи `/` и `/app.js` из `public/`;
      опционально `docker build`

## Порядок, эффекты, ограничения

A → B → C → D. Миграций нет. Осознанные изменения: раскладка Docker-образа
(`static/` → `public/`), Python-ответ income/expense получает поле `duplicate`
(фронтенд совместим: `res.ok` пропускает 200).

## Вне скоупа

п.10 (тесты/CI), N+1 в `getSummary`.
