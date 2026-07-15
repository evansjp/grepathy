import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePack } from "../src/distiller/validator.js";
import { DistilledPack } from "../src/distiller/model.js";
import { CLERK_PACK } from "./helpers.js";

function pack(body: string): DistilledPack {
  return { intent: "x", decisions: [{ title: "t", status: "directed", touches: [], body }] };
}

test("clean pack passes", () => {
  assert.equal(validatePack(CLERK_PACK).ok, true);
});

test("secret patterns are caught", () => {
  assert.equal(validatePack(pack("key is sk-abcdefghijklmnop1234567890")).ok, false);
  assert.equal(validatePack(pack("AKIAIOSFODNN7EXAMPLE")).ok, false);
  assert.equal(validatePack(pack('password: "hunter2secret"')).ok, false);
});

test("privacy/narrative leaks are caught", () => {
  assert.equal(validatePack(pack("the user was unsure about the schema")).ok, false);
  assert.equal(validatePack(pack("you asked for a different approach")).ok, false);
  assert.equal(validatePack(pack("First the user tried JWT")).ok, false);
});

test("monetary figures are flagged as a business/financial leak", () => {
  assert.equal(validatePack(pack("charged $42/mo plus a $2,500 setup fee")).ok, false);
  assert.equal(validatePack(pack("the vendor quoted 500 USD per month")).ok, false);
  // Technical numerics must NOT trip it.
  assert.equal(validatePack(pack("retried up to 2 times with a 1-second delay on port 3000")).ok, true);
  assert.equal(validatePack(pack("generated a 512x512 PNG served before 11:59 PM")).ok, true);
});

test("custom redaction regex is honored", () => {
  const res = validatePack(pack("internal codename ORCA"), ["ORCA"]);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.includes("custom redaction")));
});
