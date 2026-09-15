import assert from "node:assert/strict";
import test from "node:test";
import { validBasicAuthorization } from "./http-auth.js";

const auth = { username: "clawtop", password: "correct:horse" };
const basic = (value: string) => `Basic ${Buffer.from(value).toString("base64")}`;

test("accepts only the configured Basic credentials", () => {
  assert.equal(validBasicAuthorization(basic("clawtop:correct:horse"), auth), true);
  assert.equal(validBasicAuthorization(basic("clawtop:wrong"), auth), false);
  assert.equal(validBasicAuthorization(basic("wrong:correct:horse"), auth), false);
  assert.equal(validBasicAuthorization("Bearer secret", auth), false);
  assert.equal(validBasicAuthorization(undefined, auth), false);
});
