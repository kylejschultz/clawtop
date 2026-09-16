import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HistoryStore } from "./history.js";
import { createState, reduceDashboard } from "./model.js";

const gateway = { id: "one", name: "One" };

test("durable history stores only structural activity and omits commands and titles", () => {
  const directory = mkdtempSync(join(tmpdir(), "clawtop-history-"));
  const path = join(directory, "history.sqlite");
  const history = new HistoryStore(path, 90, 1024 * 1024);
  let state = createState("live", 1);
  const title = "ARBITRARY PRIVATE TITLE";
  const credential = "psql postgres://alice:correct-horse@db.internal/app";
  const snapshot = reduceDashboard(state, { type: "snapshot", gateway, agents: [{ id: "main", name: "Main" }], sessions: [{ key: "session", sessionId: "stable", kind: "direct", agentId: "main", displayName: title, updatedAt: 10 }], at: 10 });
  history.persist(state, snapshot); state = snapshot;
  const event = reduceDashboard(state, { type: "event", gateway, event: "session.tool", payload: { sessionKey: "session", toolName: "exec", status: "completed", args: { title, command: credential } }, at: 20 });
  history.persist(state, event);
  const restored = history.restore({ ...event.sessions["one::session"]!, activity: [] });
  const page = history.page(Number.MAX_SAFE_INTEGER, 1);
  assert.equal(restored.activity[0]?.label, "exec");
  assert.equal(restored.activity[0]?.detail, undefined);
  assert.equal(page.sessions[0]?.title, "Historical session");
  assert.equal(JSON.stringify(page).includes(title), false);
  assert.equal(JSON.stringify(history.activities(restored.historyId!)).includes(credential), false);
  history.close();
  const bytes = readFileSync(path).toString("latin1");
  assert.doesNotMatch(bytes, /ARBITRARY PRIVATE TITLE|correct-horse|db\.internal/);
});

test("migration scrubs unsafe legacy history pages", () => {
  const path = join(mkdtempSync(join(tmpdir(), "clawtop-history-")), "history.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE sessions(key TEXT PRIMARY KEY,gateway_id TEXT,updated_at INTEGER,metadata TEXT); CREATE TABLE events(session_key TEXT,id TEXT,at INTEGER,kind TEXT,label TEXT,detail TEXT,status TEXT,run_id TEXT);");
  legacy.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run("key", "one", 1, JSON.stringify({ title: "LEGACY PRIVATE TITLE" }));
  legacy.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)").run("key", "id", 1, "tool", "exec", "postgres://alice:legacy-secret@db.internal/app", null, null);
  legacy.close();
  const history = new HistoryStore(path);
  assert.equal(history.page().sessions.length, 0);
  history.close();
  assert.doesNotMatch(readFileSync(path).toString("latin1"), /LEGACY PRIVATE TITLE|legacy-secret|db\.internal/);
});

test("pruning removes detailed events while preserving session metadata", () => {
  const path = join(mkdtempSync(join(tmpdir(), "clawtop-history-")), "history.sqlite");
  const history = new HistoryStore(path, 1, 1024 * 1024);
  const empty = createState("live", 1);
  const snapshot = reduceDashboard(empty, { type: "snapshot", gateway, agents: [], sessions: [{ key: "old", sessionId: "old-id", kind: "direct", updatedAt: 1 }], at: 1 });
  const event = reduceDashboard(snapshot, { type: "event", gateway, event: "session.message", payload: { sessionKey: "old", status: "done" }, at: 2 });
  history.persist(empty, snapshot); history.persist(snapshot, event);
  const historyId = history.restore(event.sessions["one::old"]!).historyId!;
  history.prune(3 * 86400000);
  assert.equal(history.activities(historyId).length, 0);
  assert.equal(history.page().sessions.length, 1);
  history.close();
});

test("preserves two generations that reuse one live session key", () => {
  const path = join(mkdtempSync(join(tmpdir(), "clawtop-history-")), "history.sqlite");
  const history = new HistoryStore(path);
  const empty = createState("live", 1);
  const first = reduceDashboard(empty, { type: "snapshot", gateway, agents: [], sessions: [{ key: "same", sessionId: "generation-one", kind: "direct" }], at: 10 });
  const firstEvent = reduceDashboard(first, { type: "event", gateway, event: "session.message", payload: { sessionKey: "same", status: "first" }, at: 11 });
  history.persist(empty, first); history.persist(first, firstEvent);
  const second = reduceDashboard(firstEvent, { type: "snapshot", gateway, agents: [], sessions: [{ key: "same", sessionId: "generation-two", kind: "direct" }], at: 20 });
  const secondEvent = reduceDashboard(second, { type: "event", gateway, event: "session.message", payload: { sessionKey: "same", status: "second" }, at: 21 });
  history.persist(firstEvent, second); history.persist(second, secondEvent);
  const generations = history.page().sessions;
  assert.equal(generations.length, 2);
  assert.notEqual(generations[0]?.historyId, generations[1]?.historyId);
  assert.deepEqual(generations.map((item) => history.activities(item.historyId!)[0]?.status).sort(), ["first", "second"]);
  history.close();
});
