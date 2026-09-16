import assert from "node:assert/strict";
import test from "node:test";
import { createActiveSessionFetcher, createDerivedTitleRequest, ExactSessionSubscriptions, fetchActiveSessions, mergeSessionViews, subscribeSessions } from "./adapters.js";
import type { SessionWire } from "./model.js";

const row = (key: string, agentId = "main"): SessionWire => ({ key, kind: "direct", agentId });

test("reconciles exact-session subscriptions without approval access", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const subscriptions = new ExactSessionSubscriptions(async (method, params) => {
    calls.push({ method, params });
    return {};
  });

  await subscriptions.reconcile([row("one"), row("global", "research")]);
  await subscriptions.reconcile([row("global", "research"), row("three")]);

  assert.deepEqual(calls, [
    { method: "sessions.messages.subscribe", params: { key: "one", agentId: "main" } },
    { method: "sessions.messages.subscribe", params: { key: "global", agentId: "research" } },
    { method: "sessions.messages.unsubscribe", params: { key: "one", agentId: "main" } },
    { method: "sessions.messages.subscribe", params: { key: "three", agentId: "main" } }
  ]);
  assert.equal(JSON.stringify(calls).includes("includeApprovals"), false);

  subscriptions.reset();
  await subscriptions.reconcile([row("global", "research")]);
  assert.deepEqual(calls.at(-1), { method: "sessions.messages.subscribe", params: { key: "global", agentId: "research" } });
});

test("retries failed session subscriptions on the next reconciliation", async () => {
  let attempts = 0;
  const subscriptions = new ExactSessionSubscriptions(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient");
    return {};
  });
  await subscriptions.reconcile([row("one")]);
  await subscriptions.reconcile([row("one")]);
  assert.equal(attempts, 2);
});

test("merges every active session into the bounded recent page and counts hidden inactive history", () => {
  const recent = { sessions: [row("recent"), { ...row("shared"), status: "done" as const }], hasMore: true, totalCount: 4 };
  const active = { sessions: [{ ...row("shared"), status: "running" as const }, row("active-outside-recent")] };
  const view = mergeSessionViews(recent, active);
  assert.deepEqual(view.sessions.map(({ key, status }) => ({ key, status })), [
    { key: "shared", status: "running" },
    { key: "active-outside-recent", status: undefined },
    { key: "recent", status: undefined }
  ]);
  assert.equal(view.activeSessions, 2);
  assert.equal(view.inactiveSessionsShown, 1);
  assert.equal(view.inactiveHistoryTruncated, true);
  assert.equal(view.omittedInactiveSessions, 1);
  assert.equal(mergeSessionViews({ sessions: [row("global", "main")] }, { sessions: [row("global", "research")] }).sessions.length, 2);
});

test("paginates activeOnly reads until every active session is present", async () => {
  const calls: Record<string, unknown>[] = [];
  const first = Array.from({ length: 200 }, (_, index) => row(`active-${index}`));
  const result = await fetchActiveSessions(async (method, params) => {
    assert.equal(method, "sessions.list");
    calls.push(params);
    return params.offset === 0
      ? { sessions: first, hasMore: true, nextOffset: 200, totalCount: 201 }
      : { sessions: [row("active-200")], hasMore: false, nextOffset: null, totalCount: 201 };
  });
  assert.equal(result.sessions.length, 201);
  assert.equal(result.sessions.at(-1)?.key, "active-200");
  assert.deepEqual(calls, [
    { activeOnly: true, limit: 200, offset: 0 },
    { activeOnly: true, limit: 200, offset: 200 }
  ]);
});

test("fetches a recent page when legacy sessions.subscribe omits its list", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const result = await subscribeSessions(async (method, params) => {
    calls.push({ method, params });
    return method === "sessions.subscribe" ? { subscribed: true } : { sessions: [row("legacy")] };
  });

  assert.deepEqual(result.sessions, [row("legacy")]);
  assert.deepEqual(calls, [
    { method: "sessions.subscribe", params: { limit: 200 } },
    { method: "sessions.list", params: { limit: 200 } }
  ]);
});

test("keeps the modern sessions.subscribe list without an extra read", async () => {
  let calls = 0;
  const result = await subscribeSessions(async () => {
    calls += 1;
    return { subscribed: true, list: { sessions: [row("modern")] } };
  });
  assert.deepEqual(result.sessions, [row("modern")]);
  assert.equal(calls, 1);
});

test("requests derived titles and caches the compatibility fallback", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const request = createDerivedTitleRequest(async (method, params) => {
    calls.push({ method, params });
    if (params.includeDerivedTitles) throw new Error(`invalid ${method} params: at root: unexpected property 'includeDerivedTitles'`);
    return { sessions: [row("legacy")] };
  });

  await request("sessions.list", { limit: 200 });
  await request("sessions.list", { limit: 200 });
  await request("agents.list", {});
  assert.deepEqual(calls, [
    { method: "sessions.list", params: { limit: 200, includeDerivedTitles: true } },
    { method: "sessions.list", params: { limit: 200 } },
    { method: "sessions.list", params: { limit: 200 } },
    { method: "agents.list", params: {} }
  ]);
});

test("caches the legacy sessions.list fallback when activeOnly is unsupported", async () => {
  let calls = 0;
  const read = createActiveSessionFetcher(async () => {
    calls += 1;
    throw new Error("invalid sessions.list params: at root: unexpected property 'activeOnly'");
  });

  assert.equal(await read(), undefined);
  assert.equal(await read(), undefined);
  assert.equal(calls, 1);
});

test("does not mask unrelated sessions.list errors", async () => {
  const read = createActiveSessionFetcher(async () => {
    throw new Error("invalid sessions.list params: limit is too large");
  });
  await assert.rejects(read(), /limit is too large/);
});

test("rejects ambiguous or non-advancing active pagination instead of publishing an incomplete set", async () => {
  await assert.rejects(fetchActiveSessions(async () => ({ sessions: [] })), /omitted pagination metadata/);
  await assert.rejects(
    fetchActiveSessions(async () => ({ sessions: [row("same")], hasMore: true, nextOffset: 0 })),
    /did not advance/
  );
});
