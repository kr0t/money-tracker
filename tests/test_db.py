import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="mt-tests-"))

import db


class DbTest(unittest.TestCase):
    def setUp(self):
        db.init_db()
        db.clear_debt_transactions()
        db.clear_transactions()

    def test_income_updates_balance(self):
        result = db.add_transaction(db.KIND_INCOME, 10000, "зарплата")
        self.assertFalse(result["duplicate"])
        self.assertEqual(result["transaction"]["amount"], 100.0)
        self.assertEqual(db.get_summary()["balance"], 100.0)

    def test_expense_overdraft_rejected(self):
        db.add_transaction(db.KIND_INCOME, 5000)
        with self.assertRaises(ValueError):
            db.add_transaction(db.KIND_EXPENSE, 5001)
        self.assertEqual(db.get_summary()["balance"], 50.0)

    def test_expense_exact_balance_allowed(self):
        db.add_transaction(db.KIND_INCOME, 5000)
        db.add_transaction(db.KIND_EXPENSE, 5000)
        self.assertEqual(db.get_summary()["balance"], 0.0)

    def test_duplicate_request_id_ignored(self):
        first = db.add_transaction(db.KIND_INCOME, 1000, request_id="req-1")
        second = db.add_transaction(db.KIND_INCOME, 1000, request_id="req-1")
        self.assertFalse(first["duplicate"])
        self.assertTrue(second["duplicate"])
        self.assertIsNone(second["transaction"])
        self.assertEqual(db.get_summary()["balance"], 10.0)

    def test_rejected_expense_frees_request_id(self):
        db.add_transaction(db.KIND_INCOME, 1000)
        with self.assertRaises(ValueError):
            db.add_transaction(db.KIND_EXPENSE, 9999, request_id="req-2")
        result = db.add_transaction(db.KIND_EXPENSE, 500, request_id="req-2")
        self.assertFalse(result["duplicate"])
        self.assertEqual(db.get_summary()["balance"], 5.0)

    def test_create_debt_with_initial_amount(self):
        debt = db.create_debt("Тест", 5000)
        self.assertEqual(debt["balance"], 50.0)
        self.assertEqual(debt["transactions"][0]["kind"], "borrow")
        self.assertEqual(db.get_summary()["debt"], 50.0)

    def test_create_debt_without_initial_amount(self):
        debt = db.create_debt("Тест")
        self.assertEqual(debt["balance"], 0.0)
        self.assertEqual(debt["transactions"], [])

    def test_repay_reduces_debt_and_balance(self):
        db.add_transaction(db.KIND_INCOME, 10000)
        debt = db.create_debt("Тест", 5000)
        debt_tx = db.add_debt(debt["id"], db.DEBT_REPAY, 2000)
        self.assertIsNotNone(debt_tx["linked_tx_id"])
        summary = db.get_summary()
        self.assertEqual(summary["balance"], 80.0)
        self.assertEqual(summary["debt"], 30.0)

    def test_repay_more_than_debt_rejected(self):
        debt = db.create_debt("Тест", 1000)
        with self.assertRaises(ValueError):
            db.add_debt(debt["id"], db.DEBT_REPAY, 1001)

    def test_repay_more_than_balance_rejected(self):
        debt = db.create_debt("Тест", 10000)
        with self.assertRaises(ValueError):
            db.add_debt(debt["id"], db.DEBT_REPAY, 5000)

    def test_borrow_increases_debt_only(self):
        db.add_transaction(db.KIND_INCOME, 10000)
        debt = db.create_debt("Тест")
        db.add_debt(debt["id"], db.DEBT_BORROW, 3000)
        summary = db.get_summary()
        self.assertEqual(summary["debt"], 30.0)
        self.assertEqual(summary["balance"], 100.0)

    def test_delete_transaction_restores_balance(self):
        db.add_transaction(db.KIND_INCOME, 10000)
        result = db.add_transaction(db.KIND_EXPENSE, 3000)
        summary = db.delete_transaction(result["transaction"]["id"])
        self.assertEqual(summary["balance"], 100.0)
        with self.assertRaises(ValueError):
            db.delete_transaction(result["transaction"]["id"])

    def test_delete_linked_repay_restores_debt(self):
        db.add_transaction(db.KIND_INCOME, 10000)
        debt = db.create_debt("Тест", 5000)
        debt_tx = db.add_debt(debt["id"], db.DEBT_REPAY, 2000)
        summary = db.delete_transaction(debt_tx["linked_tx_id"])
        self.assertEqual(summary["balance"], 100.0)
        target = next(d for d in summary["debts"] if d["id"] == debt["id"])
        self.assertEqual(target["balance"], 50.0)
        self.assertEqual([t for t in target["transactions"] if t["kind"] == "repay"], [])

    def test_summary_linked_to_debt_flag(self):
        db.add_transaction(db.KIND_INCOME, 10000)
        debt = db.create_debt("Тест", 5000)
        debt_tx = db.add_debt(debt["id"], db.DEBT_REPAY, 1000)
        plain = db.add_transaction(db.KIND_EXPENSE, 500)
        summary = db.get_summary()
        flags = {t["id"]: t["linked_to_debt"] for t in summary["transactions"]}
        self.assertTrue(flags[debt_tx["linked_tx_id"]])
        self.assertFalse(flags[plain["transaction"]["id"]])

    def test_processed_requests_cleanup(self):
        conn = sqlite3.connect(db.DB_PATH)
        try:
            stale = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()
            conn.execute(
                "INSERT INTO processed_requests (request_id, created_at) VALUES (?, ?)",
                ("stale-key", stale),
            )
            conn.commit()
        finally:
            conn.close()

        db.add_transaction(db.KIND_INCOME, 1000, request_id="fresh-key")

        conn = sqlite3.connect(db.DB_PATH)
        try:
            count = conn.execute(
                "SELECT COUNT(*) FROM processed_requests WHERE request_id = 'stale-key'"
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(count, 0)

    def test_category_analytics_and_manual_assignment(self):
        db.add_transaction(db.KIND_INCOME, 10000)
        food = db.create_category("Продукты")
        first = db.add_transaction(db.KIND_EXPENSE, 2500, category_id=food["id"])
        second = db.add_transaction(db.KIND_EXPENSE, 1000)

        month = datetime.now(timezone.utc).strftime("%Y-%m")
        report = db.get_analytics(month)
        self.assertEqual(report["total"], 35.0)
        self.assertEqual(report["categories"][0]["name"], "Продукты")

        db.set_transaction_category(second["transaction"]["id"], food["id"])
        report = db.get_analytics(month)
        self.assertEqual(len(report["categories"]), 1)
        self.assertEqual(report["categories"][0]["amount"], 35.0)
        self.assertEqual(first["transaction"]["category_id"], food["id"])

    def test_archived_category_cannot_be_assigned(self):
        db.add_transaction(db.KIND_INCOME, 10000)
        category = db.create_category("Дом")
        db.update_category(category["id"], archived=True)
        with self.assertRaises(ValueError):
            db.add_transaction(db.KIND_EXPENSE, 1000, category_id=category["id"])

    def test_debt_repayment_has_system_analytics_category(self):
        db.add_transaction(db.KIND_INCOME, 10000)
        debt = db.create_debt("Тест", 5000)
        db.add_debt(debt["id"], db.DEBT_REPAY, 1000)
        report = db.get_analytics(datetime.now(timezone.utc).strftime("%Y-%m"))
        self.assertEqual(report["categories"][0]["name"], "Возврат долга")
        self.assertTrue(report["categories"][0]["system"])


if __name__ == "__main__":
    unittest.main()
