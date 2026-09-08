-- Migration 0003: Failed-login rate limiting (per client IP, fixed window)
CREATE TABLE IF NOT EXISTS login_attempts (
    ip TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    fail_count INTEGER NOT NULL
);
