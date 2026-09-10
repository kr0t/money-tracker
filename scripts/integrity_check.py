#!/usr/bin/env python3
"""API integrity checks for a running money-tracker instance.

Covers concurrency (overdraft, repay races), linked-records consistency,
undo (/api/transactions/delete) and request_id idempotency.

WIPES all transactions and debts. Point BASE_URL at a disposable instance
(fresh local python server or a wrangler pages dev copy) and confirm with
CONFIRM_DESTRUCTIVE=1.

Usage:
  BASE_URL=http://127.0.0.1:8081 AUTH_PIN=1234 CONFIRM_DESTRUCTIVE=1 \
    python3 scripts/integrity_check.py
"""

import json
import os
import sys
import threading
import urllib.error
import urllib.request

BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:8080").rstrip("/")
PIN = os.environ.get("AUTH_PIN", "")

if os.environ.get("CONFIRM_DESTRUCTIVE") != "1":
    print("The check WIPES all transactions and debts.")
    print("Set CONFIRM_DESTRUCTIVE=1 and point BASE_URL at a disposable instance.")
    sys.exit(2)

if not PIN:
    print("Set AUTH_PIN to the server's PIN.")
    sys.exit(2)

COOKIE = None
PASSED = 0
FAILED = 0


def check(desc, ok, detail=""):
    global PASSED, FAILED
    if ok:
        PASSED += 1
        print("ok   - " + desc)
    else:
        FAILED += 1
        print("FAIL - " + desc + (" " + detail if detail else ""))


def request(method, path, body=None, with_auth=True):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE_URL + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if with_auth and COOKIE:
        req.add_header("Cookie", COOKIE)
    try:
        with urllib.request.urlopen(req) as resp:
            status = resp.status
            headers = resp.headers
            raw = resp.read()
    except urllib.error.HTTPError as err:
        status = err.code
        headers = err.headers
        raw = err.read()
    except urllib.error.URLError as err:
        return 0, None, None, str(err)

    payload = None
    if raw:
        try:
            payload = json.loads(raw.decode("utf-8"))
        except ValueError:
            payload = None
    return status, payload, headers, None


def login():
    global COOKIE
    status, payload, headers, err = request(
        "POST", "/api/auth/login", {"pin": PIN}, with_auth=False
    )
    if err:
        print("cannot reach server: " + err)
        sys.exit(2)
    if status != 200:
        print("login failed: HTTP {} {}".format(status, payload))
        sys.exit(2)
    set_cookie = headers.get("Set-Cookie") or ""
    token_part = set_cookie.split(";")[0].strip()
    if not token_part.startswith("mt_auth="):
        print("no mt_auth cookie in login response")
        sys.exit(2)
    COOKIE = token_part


def run_concurrently(count, fn):
    barrier = threading.Barrier(count)
    results = [None] * count

    def worker(i):
        barrier.wait()
        results[i] = fn(i)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(count)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results


def reset_state():
    request("POST", "/api/transactions/clear")
    request("POST", "/api/debt/clear")


def test_expense_overdraft():
    print("\n[1] expense overdraft race")
    reset_state()
    status, _, _, _ = request("POST", "/api/income", {"amount": "100.00", "note": "seed"})
    check("seed income 100.00 accepted", status == 201, "(got HTTP %s)" % status)

    statuses = run_concurrently(
        20,
        lambda i: request("POST", "/api/expense", {"amount": "10.00", "note": "race %d" % i})[0],
    )
    accepted = sum(1 for s in statuses if s == 201)
    rejected = sum(1 for s in statuses if s == 400)
    check("exactly 10 of 20 expenses accepted", accepted == 10, "(got %d)" % accepted)
    check("other 10 rejected with 400", rejected == 10, "(got %d)" % rejected)

    status, summary, _, _ = request("GET", "/api/summary")
    balance = summary["balance"] if summary else None
    check("balance is 0.00 after race", balance == 0.0, "(got %s)" % balance)
    check("balance never negative", balance is not None and balance >= 0)


def test_repay_race():
    print("\n[2] concurrent debt repay race")
    reset_state()
    status, _, _, _ = request("POST", "/api/income", {"amount": "100.00", "note": "seed"})
    check("seed income 100.00 accepted", status == 201, "(got HTTP %s)" % status)

    status, payload, _, _ = request(
        "POST", "/api/debts", {"name": "Race Debt", "amount": "100.00"}
    )
    check("debt with initial 100.00 created", status == 201, "(got HTTP %s)" % status)
    debt_id = payload["debt"]["id"] if payload and payload.get("debt") else None
    check("debt id returned", debt_id is not None)

    statuses = run_concurrently(
        10,
        lambda i: request(
            "POST", "/api/debt/repay", {"debt_id": debt_id, "amount": "10.00"}
        )[0],
    )
    accepted = sum(1 for s in statuses if s == 201)
    check("all 10 concurrent repays accepted", accepted == 10, "(got %d)" % accepted)

    status, summary, _, _ = request("GET", "/api/summary")
    check(
        "debt is 0.00 after repays",
        summary and summary["debt"] == 0.0,
        "(got %s)" % (summary and summary["debt"]),
    )
    check(
        "balance is 0.00 after repays",
        summary and summary["balance"] == 0.0,
        "(got %s)" % (summary and summary["balance"]),
    )

    statuses = run_concurrently(
        5,
        lambda i: request(
            "POST", "/api/debt/repay", {"debt_id": debt_id, "amount": "10.00"}
        )[0],
    )
    check(
        "5 extra repays all rejected with 400",
        all(s == 400 for s in statuses),
        "(got %s)" % statuses,
    )
    return debt_id


def test_consistency(debt_id):
    print("\n[3] linked records consistency")
    status, summary, _, _ = request("GET", "/api/summary")
    check("summary available", status == 200 and summary is not None)

    debt = next((d for d in summary["debts"] if d["id"] == debt_id), None)
    check("debt present in summary", debt is not None)
    repays = [t for t in debt["transactions"] if t["kind"] == "repay"]
    linked = [t for t in repays if t.get("linked_tx_id")]
    check("10 repay records exist", len(repays) == 10, "(got %d)" % len(repays))
    check("every repay linked to an expense", len(linked) == 10, "(got %d)" % len(linked))

    txs = summary["transactions"]
    incomes = sum(t["amount"] for t in txs if t["kind"] == "income")
    expenses = sum(t["amount"] for t in txs if t["kind"] == "expense")
    check(
        "balance matches history",
        summary["balance"] == round(incomes - expenses, 2),
        "(balance %s vs history %s)" % (summary["balance"], round(incomes - expenses, 2)),
    )
    repay_expenses = [
        t
        for t in txs
        if t["kind"] == "expense" and str(t.get("note", "")).startswith("Вернул долг")
    ]
    check(
        "10 linked repay expenses in history",
        len(repay_expenses) == 10,
        "(got %d)" % len(repay_expenses),
    )


def test_undo():
    print("\n[4] undo via /api/transactions/delete")
    reset_state()
    status, _, _, _ = request("POST", "/api/income", {"amount": "100.00", "note": "seed"})
    check("seed income 100.00 accepted", status == 201, "(got HTTP %s)" % status)
    status, _, _, _ = request("POST", "/api/expense", {"amount": "30.00", "note": "plain"})
    check("plain expense accepted", status == 201, "(got HTTP %s)" % status)

    status, summary, _, _ = request("GET", "/api/summary")
    expense = next(
        (
            t
            for t in summary["transactions"]
            if t["kind"] == "expense" and t["note"] == "plain"
        ),
        None,
    )
    check("plain expense found in history", expense is not None)
    check(
        "linked_to_debt is false",
        expense is not None and expense["linked_to_debt"] is False,
    )

    status, _, _, _ = request("POST", "/api/transactions/delete", {"id": expense["id"]})
    check("undo returns 200", status == 200, "(got HTTP %s)" % status)

    status, summary, _, _ = request("GET", "/api/summary")
    check(
        "balance restored to 100.00",
        summary and summary["balance"] == 100.0,
        "(got %s)" % (summary and summary["balance"]),
    )

    status, _, _, _ = request("POST", "/api/transactions/delete", {"id": expense["id"]})
    check("repeat undo rejected 400", status == 400, "(got HTTP %s)" % status)

    status, payload, _, _ = request(
        "POST", "/api/debts", {"name": "Undo Debt", "amount": "50.00"}
    )
    check("debt with initial 50.00 created", status == 201, "(got HTTP %s)" % status)
    debt_id = payload["debt"]["id"] if payload and payload.get("debt") else None

    status, _, _, _ = request("POST", "/api/debt/repay", {"debt_id": debt_id, "amount": "50.00"})
    check("repay 50.00 accepted", status == 201, "(got HTTP %s)" % status)

    status, summary, _, _ = request("GET", "/api/summary")
    repay_expense = next(
        (
            t
            for t in summary["transactions"]
            if t["kind"] == "expense" and t.get("linked_to_debt")
        ),
        None,
    )
    check("linked repay expense found", repay_expense is not None)

    status, _, _, _ = request(
        "POST", "/api/transactions/delete", {"id": repay_expense["id"]}
    )
    check("linked undo returns 200", status == 200, "(got HTTP %s)" % status)

    status, summary, _, _ = request("GET", "/api/summary")
    check(
        "balance restored to 100.00 after linked undo",
        summary and summary["balance"] == 100.0,
        "(got %s)" % (summary and summary["balance"]),
    )
    debt = next((d for d in summary["debts"] if d["id"] == debt_id), None)
    check(
        "debt restored to 50.00",
        debt is not None and debt["balance"] == 50.0,
        "(got %s)" % (debt and debt["balance"]),
    )
    repays = [t for t in debt["transactions"] if t["kind"] == "repay"]
    check("repay record removed from debt history", repays == [], "(got %d)" % len(repays))


def test_idempotency():
    print("\n[5] request_id idempotency")
    reset_state()

    body = {"amount": "10.00", "note": "idem", "request_id": "idem-fixed-income-1"}
    status, payload, _, _ = request("POST", "/api/income", body)
    check("first submit accepted 201", status == 201, "(got HTTP %s)" % status)
    check("first submit not duplicate", payload and payload.get("duplicate") is False)

    status, payload, _, _ = request("POST", "/api/income", body)
    check("retry returns 200", status == 200, "(got HTTP %s)" % status)
    check("retry flagged duplicate", payload and payload.get("duplicate") is True)
    check("retry transaction is null", payload and payload.get("transaction") is None)

    status, summary, _, _ = request("GET", "/api/summary")
    check(
        "balance incremented once",
        summary and summary["balance"] == 10.0,
        "(got %s)" % (summary and summary["balance"]),
    )

    status, _, _, _ = request(
        "POST",
        "/api/expense",
        {"amount": "999.00", "note": "idem2", "request_id": "idem-fixed-expense-2"},
    )
    check("oversized expense rejected 400", status == 400, "(got HTTP %s)" % status)

    status, payload, _, _ = request(
        "POST",
        "/api/expense",
        {"amount": "5.00", "note": "idem2", "request_id": "idem-fixed-expense-2"},
    )
    check("same request_id retry accepted 201", status == 201, "(got HTTP %s)" % status)
    check("retry not duplicate", payload and payload.get("duplicate") is False)

    status, summary, _, _ = request("GET", "/api/summary")
    check(
        "balance consistent after retry",
        summary and summary["balance"] == 5.0,
        "(got %s)" % (summary and summary["balance"]),
    )


def main():
    login()
    test_expense_overdraft()
    debt_id = test_repay_race()
    test_consistency(debt_id)
    test_undo()
    test_idempotency()
    print("\npassed: %d, failed: %d" % (PASSED, FAILED))
    sys.exit(0 if FAILED == 0 else 1)


if __name__ == "__main__":
    main()
