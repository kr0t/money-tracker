# PLAN.md — Целостность данных (п.5): атомарность операций

Контекст: сейчас проверки баланса/долга и вставки — отдельные запросы. Гонки позволяют
уйти в минус, переплатить долг или записать расход без записи долга.

Инварианты после доработки:
- баланс «Доступно» никогда не уходит в минус;
- возврат долга: расход и запись долга применяются вместе или не применяются вовсе;
- повторный запрос с тем же `request_id` не создаёт вторую транзакцию.

Техническая основа (проверено прототипом на SQLite):
- D1: `db.batch` — единственная атомарная единица; проверки встраиваются в сами INSERT
  через `INSERT INTO ... SELECT ... WHERE <условие>`; `meta.changes === 0` = отказ;
- SQLite (Python): `isolation_level=None` + явные `BEGIN IMMEDIATE`-транзакции,
  `journal_mode=WAL`, `busy_timeout` (по умолчанию уже 5000 — задать явно);
  `cur.rowcount == 0` = отказ; `cur.lastrowid` внутри транзакции для связки.

## A. D1 — `functions/api/_db.js`

- [x] `addTransaction` (expense): резерв `request_id` → условный INSERT
      `SELECT 'expense', … WHERE ? <= (баланс)`; `changes === 0` → компенсирующий
      `DELETE FROM processed_requests WHERE request_id = ?` (повтор тем же ключом снова
      валиден) → свежее чтение баланса → ошибка «сумма больше доступного баланса»
- [x] `addTransaction` (income): без изменений (проверок нет)
- [x] `addDebt` (repay): две фазы. Фаза 1 — атомарный условный INSERT расхода
      (`? <= баланс AND ? <= баланс долга AND EXISTS(debts)`, все условия читают
      неизменённое состояние); `changes === 0` → свежие чтения → точная ошибка:
      «долг не найден» / «сумма больше текущего долга» / «сумма больше доступного баланса».
      Фаза 2 — INSERT записи долга с известным `linked_tx_id = txId` из фазы 1; при сбое —
      компенсирующий DELETE расхода. Замечание: единый `db.batch` из двух INSERT
      невозможен — условие второго INSERT видит вставку первого (баланс уже списан),
      а зеркалирование предусловия вырождается в тривиально-истинное (проверено на D1)
- [x] `addDebt` (borrow): INSERT с `WHERE EXISTS(SELECT 1 FROM debts WHERE id = ?)`;
      `changes === 0` → «долг не найден»
- [x] `createDebt`: `db.batch` [INSERT debts + INSERT debt_transactions (borrow,
      `debt_id = (SELECT MAX(id) FROM debts)`)] — создание долга с начальной суммой атомарно
- [x] `deleteTransaction`: один `db.batch` [DELETE debt_transactions WHERE linked_tx_id = ?,
      DELETE transactions WHERE id = ?]; `changes` по транзакции = 0 → «операция не найдена»
- [x] JSON-форматы ответов и тексты ошибок не меняются. Примечание: повтор уже
      обработанного expense-запроса теперь всегда возвращает `duplicate` (раньше при
      снизившемся балансе мог вернуть 400)

## B. SQLite — `db.py`

- [x] `_connect()`: `isolation_level=None` (ручное управление транзакциями),
      `PRAGMA busy_timeout = 5000`, `PRAGMA journal_mode = WAL`; все соединения
      закрываются явно (`conn.close()` в finally / closing)
- [x] Хелпер `_transaction(conn)`: `BEGIN IMMEDIATE` → COMMIT / ROLLBACK
- [x] `add_transaction` (expense): условный INSERT (тот же SQL, что в D1),
      `rowcount == 0` → ошибка «сумма больше доступного баланса»; income — автокоммит
- [x] `add_debt` (repay): внутри `_transaction`: проверка существования долга, баланса
      долга и доступного баланса, INSERT расхода, `lastrowid` → INSERT записи долга,
      COMMIT — всё атомарно и сериализовано IMMEDIATE-замком
- [x] `add_debt` (borrow): внутри `_transaction` (проверка существования + вставка)
- [x] `create_debt`: одна транзакция: INSERT debts → `lastrowid` → INSERT записи долга
- [x] `clear_transactions`, `clear_debt_transactions`, orphan-fix в `init_db`:
      многошаговые записи обернуть в `_transaction`
- [x] `app.py` не меняется — API-паритет сохраняется (консолидация бэкендов — п.6, вне скоупа)

## C. Скрипт проверки — новый `scripts/integrity_check.py`

Только stdlib (`urllib.request`, `threading`, `json`). Параметры: `BASE_URL`, `AUTH_PIN`.
**Затирает историю** (`/api/transactions/clear` + `/api/debt/clear`) — требует
`CONFIRM_DESTRUCTIVE=1`; запускать только против выбрасываемых инстансов.

1. Тест овердрафта: income 100.00 → 20 параллельных expense по 10.00 →
   ровно 10×201 и 10×400; итоговый баланс 0.00
2. Тест возврата долга: income 100.00 + долг с начальной суммой 100.00 →
   10 параллельных repay по 10.00 → все 201, долг 0.00, баланс 0.00;
   ещё 5 параллельных repay → 5×400
3. Тест связности: в summary число repay-записей долга == числу связанных расходов
   (`linked_tx_id`), баланс сходится с историей операций
4. Итоговый отчёт по каждому утверждению, ненулевой exit code при провале

## D. Верификация

- Python (герметично): `DATA_DIR=$(mktemp -d) PORT=8081 AUTH_PIN=… AUTH_SECRET=… python3 app.py`
  → `BASE_URL=http://127.0.0.1:8081 python3 scripts/integrity_check.py`
- Cloudflare (герметично): копия `public/`+`functions/` во временный каталог
  → `wrangler pages dev public --d1=DB=money-tracker-db --port 8789 --inspector-port 9230`
  (свежая локальная D1, дев-данные пользователя не затрагиваются) → тот же скрипт
- Регрессия: `scripts/auth_smoke.sh` против обоих бэкендов остаётся зелёным
- Миграции не нужны — схема не меняется

## Известные ограничения (осознанные)

- Краш-окно «резерв `request_id` записан, но INSERT не выполнен»: сгоревший ключ возможен
  только при падении процесса между двумя запросами; ручной повторный сабмит генерирует
  новый `request_id`, автоповторы не страдают
- Краш-окно возврата долга на D1 (две фазы): падение процесса между INSERT расхода и
  INSERT записи долга оставляет несвязанный расход; нетранзакционные сбои закрываются
  компенсирующим DELETE. SQLite-версия окна не имеет — обе вставки в одной транзакции
- Рост `processed_requests` (п.9) — вне скоупа

## Вне скоупа

п.6 (консолидация бэкендов: undo/delete и идемпотентность на Python, `linked_to_debt`
в summary), п.7 (дубль `public/` vs `static/`), N+1 в `getSummary`, п.9, п.10 (тесты/CI).
