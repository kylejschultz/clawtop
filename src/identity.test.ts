import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIdentityHost } from "./identity.js";

test("persists device identities and auth tokens in separate Gateway directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawtop-identities-"));
  const alpha = createIdentityHost(join(root, "gateways", "alpha"));
  const beta = createIdentityHost(join(root, "gateways", "beta"));

  assert.ok(alpha.hostDeps.storeDeviceAuthToken);
  assert.ok(beta.hostDeps.storeDeviceAuthToken);
  await alpha.hostDeps.storeDeviceAuthToken({ deviceId: alpha.identity.deviceId, role: "operator", token: "alpha-token", scopes: ["operator.read"] });
  await beta.hostDeps.storeDeviceAuthToken({ deviceId: beta.identity.deviceId, role: "operator", token: "beta-token", scopes: ["operator.read"] });

  const alphaAuth = join(root, "gateways", "alpha", "auth.json");
  const betaAuth = join(root, "gateways", "beta", "auth.json");
  assert.ok(existsSync(alphaAuth));
  assert.ok(existsSync(betaAuth));
  assert.match(readFileSync(alphaAuth, "utf8"), /alpha-token/);
  assert.doesNotMatch(readFileSync(alphaAuth, "utf8"), /beta-token/);
  assert.notEqual(alpha.identity.deviceId, beta.identity.deviceId);
});
