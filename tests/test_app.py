import os
import tempfile
import unittest

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="mt-tests-"))

import app


class ParseAmountTest(unittest.TestCase):
    def test_accepts_valid_amounts(self):
        self.assertEqual(app._parse_amount_to_cents("10"), 1000)
        self.assertEqual(app._parse_amount_to_cents("10.5"), 1050)
        self.assertEqual(app._parse_amount_to_cents("10.55"), 1055)
        self.assertEqual(app._parse_amount_to_cents("10,50"), 1050)
        self.assertEqual(app._parse_amount_to_cents(10), 1000)
        self.assertEqual(app._parse_amount_to_cents(10.25), 1025)
        self.assertEqual(app._parse_amount_to_cents(" 7.00 "), 700)
        self.assertEqual(app._parse_amount_to_cents("0.01"), 1)
        self.assertEqual(app._parse_amount_to_cents("1000000"), 100000000)

    def test_rejects_invalid_amounts(self):
        for bad in (None, True, False, 0, -3, "abc", "", "-5", "0", "10.555", "1e5", [], {}):
            with self.assertRaises(ValueError):
                app._parse_amount_to_cents(bad)


class AuthConfigTest(unittest.TestCase):
    SECRET = "unit-test-secret-0123456789abcdef"

    def setUp(self):
        self._saved = {
            key: os.environ.get(key) for key in ("AUTH_PIN", "AUTH_SECRET")
        }
        os.environ["AUTH_PIN"] = "1234"
        os.environ["AUTH_SECRET"] = self.SECRET

    def tearDown(self):
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_valid_config(self):
        pin, secret = app._get_auth_config()
        self.assertEqual(pin, "1234")
        self.assertEqual(secret, self.SECRET)

    def test_strips_quotes_and_spaces(self):
        os.environ["AUTH_PIN"] = ' " 1234 " '
        os.environ["AUTH_SECRET"] = '"{}"'.format(self.SECRET)
        pin, secret = app._get_auth_config()
        self.assertEqual(pin, "1234")
        self.assertEqual(secret, self.SECRET)

    def test_missing_pin(self):
        os.environ.pop("AUTH_PIN", None)
        with self.assertRaises(app.AuthConfigError):
            app._get_auth_config()

    def test_missing_secret(self):
        os.environ.pop("AUTH_SECRET", None)
        with self.assertRaises(app.AuthConfigError):
            app._get_auth_config()

    def test_short_secret(self):
        os.environ["AUTH_SECRET"] = "short"
        with self.assertRaises(app.AuthConfigError):
            app._get_auth_config()

    def test_secret_equals_pin(self):
        os.environ["AUTH_PIN"] = self.SECRET
        os.environ["AUTH_SECRET"] = self.SECRET
        with self.assertRaises(app.AuthConfigError):
            app._get_auth_config()


class AuthTokenTest(unittest.TestCase):
    SECRET = "unit-test-secret-0123456789abcdef"

    def test_roundtrip(self):
        token = app._create_auth_token(self.SECRET)
        self.assertTrue(app._verify_auth_token(token, self.SECRET))

    def test_wrong_secret(self):
        token = app._create_auth_token(self.SECRET)
        self.assertFalse(
            app._verify_auth_token(token, "other-secret-0123456789abcdef")
        )

    def test_tampered_signature(self):
        token = app._create_auth_token(self.SECRET)
        payload, signature = token.split(".")
        flipped = ("0" if signature[0] != "0" else "1") + signature[1:]
        self.assertFalse(app._verify_auth_token(payload + "." + flipped, self.SECRET))

    def test_tampered_payload(self):
        token = app._create_auth_token(self.SECRET)
        payload, signature = token.split(".")
        self.assertFalse(app._verify_auth_token("x" + payload + "." + signature, self.SECRET))

    def test_expired_token(self):
        import base64
        import hashlib
        import hmac
        import json

        raw = json.dumps({"iat": 1, "exp": 1}, separators=(",", ":")).encode("utf-8")
        payload_b64 = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
        signature = hmac.new(
            self.SECRET.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256
        ).hexdigest()
        self.assertFalse(app._verify_auth_token(payload_b64 + "." + signature, self.SECRET))

    def test_malformed_tokens(self):
        for bad in (None, "", "abc", "a.b.c", ".", "a." + "z" * 64):
            self.assertFalse(app._verify_auth_token(bad, self.SECRET))


if __name__ == "__main__":
    unittest.main()
