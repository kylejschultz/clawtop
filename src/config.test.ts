import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";

test("loads a multi-Gateway JSON list without exposing it to client config", () => {
  const config = loadConfig({
    CLAWTOP_MODE: "live",
    CLAWTOP_HTTP_PASSWORD: "dashboard-secret",
    CLAWTOP_GATEWAYS: JSON.stringify([
      { id: "scruffy", name: "Scruffy", url: "ws://127.0.0.1:18789", token: "one" },
      { id: "morrow", name: "Morrow / Lantern", url: "wss://lantern.example.ts.net", password: "two", fingerprint: "sha256:two" }
    ])
  });
  assert.deepEqual(config.gateways.map(({ id, name }) => ({ id, name })), [
    { id: "scruffy", name: "Scruffy" },
    { id: "morrow", name: "Morrow / Lantern" }
  ]);
  assert.equal(config.gateways[0]?.token, "one");
  assert.equal(config.gateways[1]?.tlsFingerprint, "sha256:two");
});

test("loads a Gateway list from a mounted JSON file", () => {
  const directory = mkdtempSync(join(tmpdir(), "clawtop-config-"));
  const path = join(directory, "gateways.json");
  writeFileSync(path, JSON.stringify([{ id: "lantern", name: "Lantern", url: "wss://lantern.example.ts.net" }]));
  const config = loadConfig({ CLAWTOP_MODE: "live", CLAWTOP_HTTP_PASSWORD: "dashboard-secret", CLAWTOP_GATEWAYS_FILE: path });
  assert.equal(config.gateways[0]?.id, "lantern");
});

test("retains the single-Gateway environment shorthand", () => {
  const config = loadConfig({
    CLAWTOP_MODE: "live",
    CLAWTOP_HTTP_PASSWORD: "dashboard-secret",
    OPENCLAW_GATEWAY_ID: "scruffy",
    OPENCLAW_GATEWAY_NAME: "Scruffy",
    OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
    OPENCLAW_GATEWAY_TOKEN: "secret"
  });
  assert.equal(config.gateways.length, 1);
  assert.equal(config.gateways[0]?.id, "scruffy");
});

test("rejects duplicate ids and credentials embedded in URLs", () => {
  assert.throws(() => loadConfig({
    CLAWTOP_MODE: "live",
    CLAWTOP_GATEWAYS: JSON.stringify([
      { id: "same", name: "Same", url: "wss://one.example" },
      { id: "same", name: "Same Again", url: "wss://two.example" }
    ])
  }), /unique/);
  assert.throws(() => loadConfig({
    CLAWTOP_MODE: "live",
    CLAWTOP_GATEWAYS: JSON.stringify([{ id: "bad", name: "Bad", url: "wss://user:pass@example.test" }])
  }), /must not be embedded/);
});

test("requires an explicit stable id for list and shorthand configuration", () => {
  assert.throws(() => loadConfig({
    CLAWTOP_MODE: "live",
    CLAWTOP_GATEWAYS: JSON.stringify([{ name: "Mutable Name", url: "wss://one.example" }])
  }), /id is required/);
  assert.throws(() => loadConfig({
    CLAWTOP_MODE: "live",
    OPENCLAW_GATEWAY_NAME: "Mutable Name",
    OPENCLAW_GATEWAY_URL: "wss://one.example"
  }), /id is required/);
  assert.throws(() => loadConfig({
    CLAWTOP_MODE: "live",
    OPENCLAW_GATEWAY_ID: "one",
    OPENCLAW_GATEWAY_URL: "wss://one.example"
  }), /name is required/);
});

test("rejects conflicting authentication and fingerprint settings", () => {
  assert.throws(() => loadConfig({
    CLAWTOP_MODE: "live",
    CLAWTOP_GATEWAYS: JSON.stringify([{ id: "one", name: "One", url: "wss://one.example", token: "a", password: "b" }])
  }), /both token and password/);
  assert.throws(() => loadConfig({
    CLAWTOP_MODE: "live",
    CLAWTOP_GATEWAYS: JSON.stringify([{ id: "one", name: "One", url: "wss://one.example", fingerprint: "a", tlsFingerprint: "b" }])
  }), /conflicting fingerprint/);
});

test("requires dashboard authentication in live mode unless break-glass is explicit", () => {
  const gateway = JSON.stringify([{ id: "one", name: "One", url: "wss://one.example" }]);
  assert.throws(() => loadConfig({ CLAWTOP_MODE: "live", CLAWTOP_GATEWAYS: gateway }), /HTTP_PASSWORD is required/);
  assert.throws(() => loadConfig({ CLAWTOP_MODE: "live", CLAWTOP_GATEWAYS: gateway, CLAWTOP_HTTP_PASSWORD: "   " }), /must not be empty/);
  const authenticated = loadConfig({
    CLAWTOP_MODE: "live", CLAWTOP_GATEWAYS: gateway,
    CLAWTOP_HTTP_USERNAME: "viewer", CLAWTOP_HTTP_PASSWORD: "secret", CLAWTOP_MAX_SSE_CLIENTS: "7"
  });
  assert.deepEqual(authenticated.httpAuth, { username: "viewer", password: "secret" });
  assert.equal(authenticated.maxSseClients, 7);
  const breakGlass = loadConfig({ CLAWTOP_MODE: "live", CLAWTOP_GATEWAYS: gateway, CLAWTOP_ALLOW_UNAUTHENTICATED: "true" });
  assert.equal(breakGlass.httpAuth, undefined);
  assert.throws(() => loadConfig({ CLAWTOP_MODE: "live", CLAWTOP_GATEWAYS: gateway, CLAWTOP_ALLOW_UNAUTHENTICATED: "yes" }), /must be true or false/);
});
