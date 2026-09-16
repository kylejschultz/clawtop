import assert from "node:assert/strict";
import test from "node:test";
import { sameOriginRequest, validBasicAuthorization } from "./http-auth.js";

const auth = { username: "clawtop", password: "correct:horse" };
const basic = (value: string) => `Basic ${Buffer.from(value).toString("base64")}`;

test("requires the actual same origin and rejects browser cross-site writes", () => {
  assert.equal(sameOriginRequest({ origin: "https://clawtop.example", host: "clawtop.example", secFetchSite: "same-origin" }, "https:"), true);
  assert.equal(sameOriginRequest({ origin: "https://clawtop.example", host: "clawtop.example", secFetchSite: "same-origin" }, "http:"), true, "supports TLS-terminating reverse proxies when the browser proves same-origin");
  assert.equal(sameOriginRequest({ origin: "https://evil.example", host: "clawtop.example", secFetchSite: "same-origin" }, "http:"), false);
  assert.equal(sameOriginRequest({ origin: "https://clawtop.example", host: "clawtop.example", secFetchSite: "cross-site" }, "https:"), false);
  assert.equal(sameOriginRequest({ origin: "https://evil.example", host: "clawtop.example" }, "https:"), false);
  assert.equal(sameOriginRequest({ origin: "https://clawtop.example", host: "clawtop.example" }, "https:"), true);
  assert.equal(sameOriginRequest({ origin: "https://clawtop.example", host: "clawtop.example" }, "http:"), false);
});

test("accepts only the configured Basic credentials", () => {
  assert.equal(validBasicAuthorization(basic("clawtop:correct:horse"), auth), true);
  assert.equal(validBasicAuthorization(basic("clawtop:wrong"), auth), false);
  assert.equal(validBasicAuthorization(basic("wrong:correct:horse"), auth), false);
  assert.equal(validBasicAuthorization("Bearer secret", auth), false);
  assert.equal(validBasicAuthorization(undefined, auth), false);
});
