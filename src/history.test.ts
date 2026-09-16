import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HistoryStore } from "./history.js";
import { createState, reduceDashboard } from "./model.js";

test("persists only normalized activity, restores it, and paginates compact session metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "clawtop-history-"));
  const path = join(directory, "history.sqlite");
  const history = new HistoryStore(path, 90, 1024 * 1024);
  const gateway = { id: "one", name: "One" };
  let state = createState("live", 1);
  const snapshot = reduceDashboard(state, { type: "snapshot", gateway, agents: [{ id: "main", name: "Main" }], sessions: [{ key: "session", sessionId: "stable", kind: "direct", agentId: "main", displayName: "Safe title", updatedAt: 10 }], at: 10 });
  history.persist(state, snapshot); state = snapshot;
  const event = reduceDashboard(state, { type: "event", gateway, event: "session.tool", payload: { sessionKey: "session", toolName: "exec", status: "completed", args: { command: "curl -H 'Authorization: Bearer credential' https://example.test" }, output: "PRIVATE OUTPUT" }, at: 20 });
  history.persist(state, event);
  const restored = history.restore({ ...event.sessions["one::session"]!, activity: [] });
  assert.equal(restored.activity[0]?.label, "exec");
  assert.doesNotMatch(restored.activity[0]?.detail ?? "", /credential/);
  assert.equal(history.page(Number.MAX_SAFE_INTEGER, 1).sessions[0]?.title, "Safe title");
  history.close();
  assert.doesNotMatch(readFileSync(path, "utf8"), /PRIVATE OUTPUT|credential/);
});

test("pruning removes detailed events while preserving session metadata", () => {
  const path = join(mkdtempSync(join(tmpdir(), "clawtop-history-")), "history.sqlite");
  const history = new HistoryStore(path, 1, 1024 * 1024);
  const gateway = { id: "one", name: "One" };
  const empty = createState("live", 1);
  const snapshot = reduceDashboard(empty, { type: "snapshot", gateway, agents: [], sessions: [{ key: "old", sessionId: "old-id", kind: "direct", updatedAt: 1 }], at: 1 });
  const event = reduceDashboard(snapshot, { type: "event", gateway, event: "session.message", payload: { sessionKey: "old", status: "done" }, at: 2 });
  history.persist(empty, snapshot); history.persist(snapshot, event); history.prune(3 * 86400000);
  assert.equal(history.activities("one::old").length, 0);
  assert.equal(history.page().sessions.length, 1);
  history.close();
});
