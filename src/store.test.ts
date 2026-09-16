import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HistoryStore } from "./history.js";
import { DashboardStore } from "./store.js";

test("a reconnect snapshot restores persisted workstream activity and publishes it immediately", () => {
  const history = new HistoryStore(join(mkdtempSync(join(tmpdir(), "clawtop-store-")), "history.sqlite"));
  const gateway = { id: "one", name: "One" };
  const first = new DashboardStore("live", history);
  first.dispatch({ type: "snapshot", gateway, agents: [], sessions: [{ key: "session", sessionId: "stable", kind: "direct" }], at: 1 });
  first.dispatch({ type: "event", gateway, event: "session.message", payload: { sessionKey: "session", status: "running" }, at: 2 });
  const restored = new DashboardStore("live", history);
  let visible = 0;
  restored.subscribe((state) => { visible = state.sessions["one::session"]?.activity.length ?? 0; });
  restored.dispatch({ type: "snapshot", gateway, agents: [], sessions: [{ key: "session", sessionId: "stable", kind: "direct" }], at: 3 });
  assert.equal(visible, 1);
  history.close();
});
