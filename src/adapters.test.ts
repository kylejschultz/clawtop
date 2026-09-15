import assert from "node:assert/strict";
import test from "node:test";
import { ExactSessionSubscriptions, fetchActiveSessions, mergeSessionViews } from "./adapters.js";
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

test("rejects ambiguous or non-advancing active pagination instead of publishing an incomplete set", async () => {
  await assert.rejects(fetchActiveSessions(async () => ({ sessions: [] })), /omitted pagination metadata/);
  await assert.rejects(
    fetchActiveSessions(async () => ({ sessions: [row("same")], hasMore: true, nextOffset: 0 })),
    /did not advance/
  );
});
