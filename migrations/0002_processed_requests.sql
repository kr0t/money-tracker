-- Migration 0002: Idempotency keys for income/expense requests

CREATE TABLE IF NOT EXISTS processed_requests (
    request_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);
