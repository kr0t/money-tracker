import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmountToCents } from "../functions/api/_db.js";

test("parseAmountToCents accepts valid amounts", () => {
  assert.equal(parseAmountToCents("10"), 1000);
  assert.equal(parseAmountToCents("10.5"), 1050);
  assert.equal(parseAmountToCents("10.55"), 1055);
  assert.equal(parseAmountToCents("10,50"), 1050);
  assert.equal(parseAmountToCents(10), 1000);
  assert.equal(parseAmountToCents(10.25), 1025);
  assert.equal(parseAmountToCents(" 7.00 "), 700);
  assert.equal(parseAmountToCents("0.01"), 1);
  assert.equal(parseAmountToCents("1000000"), 100000000);
});

test("parseAmountToCents rejects invalid input", () => {
  for (const bad of [null, undefined, true, false, 0, -3, "abc", "", "-5", "0", "10.555", "1e5", [], {}]) {
    assert.throws(() => parseAmountToCents(bad));
  }
});
