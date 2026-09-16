import assert from "node:assert/strict";
import test from "node:test";
import { createState, reduceDashboard, safeCommand, type GatewayRef, type SessionWire } from "./model.js";

const alpha: GatewayRef = { id: "alpha", name: "Alpha" };
const beta: GatewayRef = { id: "beta", name: "Beta" };
const root = (overrides: Partial<SessionWire> = {}): SessionWire => ({ key: "agent:main:root", kind: "direct", agentId: "main", displayName: "Root", ...overrides });
const snapshot = (gateway: GatewayRef, sessions: SessionWire[], at: number) => ({ type: "snapshot" as const, gateway, at, agents: [], sessions });

test("snapshots namespace colliding agent and session ids by Gateway", () => {
  let state = createState("live", 100);
  state = reduceDashboard(state, snapshot(alpha, [root({ sessionId: "same", hasActiveRun: true })], 200));
  state = reduceDashboard(state, snapshot(beta, [root({ sessionId: "same", hasActiveRun: false })], 210));
  assert.equal(Object.keys(state.sessions).length, 2);
  assert.equal(state.sessions["alpha::agent:main:root"]?.gatewayId, "alpha");
  assert.equal(state.sessions["alpha::agent:main:root"]?.sourceKey, "agent:main:root");
  assert.equal(state.sessions["alpha::agent:main:root"]?.sessionId, "alpha::same");
  assert.equal(state.sessions["beta::agent:main:root"]?.sessionId, "beta::same");
  assert.equal(state.sessions["beta::agent:main:root"]?.state, "idle");
  assert.equal(Object.keys(state.agents).length, 2);
});

test("keeps per-agent sentinel sessions distinct", () => {
  let state = reduceDashboard(createState("live", 0), snapshot(alpha, [
    root({ key: "global", agentId: "main", hasActiveRun: true }),
    root({ key: "global", agentId: "research", hasActiveRun: true })
  ], 10));
  assert.ok(state.sessions["alpha::agent:main:global"]);
  assert.ok(state.sessions["alpha::agent:research:global"]);
  state = reduceDashboard(state, {
    type: "progressCard", gateway: alpha, sourceKey: "global", sourceAgentId: "research", at: 20,
    card: { sessionKey: "global", revision: 1, updatedAt: 20, markdown: "", steps: [{ step: "Research", status: "in_progress" }] }
  });
  assert.equal(state.sessions["alpha::agent:main:global"]?.progress, undefined);
  assert.equal(state.sessions["alpha::agent:research:global"]?.progress?.step, "Research");
});

test("projects useful tool commands while redacting credential-shaped values", () => {
  let state = reduceDashboard(createState("live", 0), snapshot(alpha, [root({ sessionId: "stable", hasActiveRun: true })], 10));
  state = reduceDashboard(state, {
    type: "event", gateway: alpha, at: 20, event: "agent",
    payload: {
      sessionKey: root().key, runId: "run", stream: "tool",
      data: { phase: "start", name: "exec", toolCallId: "call", args: { title: "Run checks", command: "npm test --token supersecret" } }
    }
  });
  const item = state.sessions["alpha::agent:main:root"]?.activity[0];
  assert.equal(item?.label, "exec");
  assert.equal(item?.detail, "Run checks · npm test --token ***");
  assert.equal(JSON.stringify(state).includes("supersecret"), false);
  assert.equal(safeCommand("git status --short"), "git status --short");
});

test("redacts sensitive titles and common command credential forms", () => {
  let state = reduceDashboard(createState("live", 0), snapshot(alpha, [root({ sessionId: "stable", hasActiveRun: true })], 10));
  state = reduceDashboard(state, {
    type: "event", gateway: alpha, at: 20, event: "agent",
    payload: {
      sessionKey: root().key, runId: "run", stream: "tool",
      data: { phase: "start", name: "exec", toolCallId: "call", args: { title: "Deploy token title-secret", command: "curl -u alice:hunter2 https://bob:password@example.test; aws configure set aws_secret_access_key aws-secret" } }
    }
  });
  const serialized = JSON.stringify(state);
  for (const secret of ["title-secret", "hunter2", "password", "aws-secret"]) assert.equal(serialized.includes(secret), false);
  assert.match(state.sessions["alpha::agent:main:root"]?.activity[0]?.detail ?? "", /Deploy token \*\*\*/u);
  assert.equal(safeCommand("curl -H 'Authorization: Bearer header-secret' https://example.test"), "curl -H 'Authorization: ***' https://example.test");
});

test("snapshot refresh preserves event details and other Gateways", () => {
  let state = createState("live", 100);
  state = reduceDashboard(state, snapshot(alpha, [root({ sessionId: "stable-alpha", hasActiveRun: true })], 200));
  state = reduceDashboard(state, snapshot(beta, [root({ sessionId: "stable-beta" })], 210));
  state = reduceDashboard(state, { type: "event", gateway: alpha, at: 250, event: "session.tool", payload: { sessionKey: root().key, toolName: "exec", status: "running", args: { secret: "never retained" } } });
  state = reduceDashboard(state, snapshot(alpha, [root({ sessionId: "stable-alpha", hasActiveRun: true })], 300));
  const session = state.sessions["alpha::agent:main:root"];
  assert.equal(session?.activeSince, 200);
  assert.equal(session?.activity[0]?.label, "exec");
  assert.ok(state.sessions["beta::agent:main:root"]);
  assert.equal(JSON.stringify(state).includes("never retained"), false);
});

test("snapshot key reuse resets lifecycle state when the session id changes", () => {
  let state = reduceDashboard(createState("live", 0), snapshot(alpha, [root({ sessionId: "old", hasActiveRun: true })], 10));
  state = reduceDashboard(state, { type: "event", gateway: alpha, at: 20, event: "session.tool", payload: { sessionKey: root().key, toolName: "exec", status: "running" } });
  state = reduceDashboard(state, {
    type: "progressCard", gateway: alpha, sourceKey: root().key, at: 25,
    card: { sessionKey: root().key, revision: 1, updatedAt: 25, markdown: "old", steps: [{ step: "Old work", status: "in_progress" }] }
  });
  state = reduceDashboard(state, snapshot(alpha, [root({ sessionId: "new", hasActiveRun: true })], 40));
  const replacement = state.sessions["alpha::agent:main:root"];
  assert.equal(replacement?.sessionId, "alpha::new");
  assert.equal(replacement?.activeSince, 40);
  assert.equal(replacement?.lastSignalAt, undefined);
  assert.deepEqual(replacement?.activity, []);
  assert.equal(replacement?.progress, undefined);
});

test("snapshots without a session id reset lifecycle state conservatively", () => {
  let state = reduceDashboard(createState("live", 0), snapshot(alpha, [root({ hasActiveRun: true })], 10));
  state = reduceDashboard(state, { type: "event", gateway: alpha, at: 20, event: "session.tool", payload: { sessionKey: root().key, toolName: "exec", status: "running" } });
  state = reduceDashboard(state, snapshot(alpha, [root({ hasActiveRun: true })], 30));
  const replacement = state.sessions["alpha::agent:main:root"];
  assert.equal(replacement?.activeSince, 30);
  assert.equal(replacement?.lastSignalAt, undefined);
  assert.deepEqual(replacement?.activity, []);
});

test("uses only explicit session titles and exposes inactive-history coverage", () => {
  const state = reduceDashboard(createState("live", 0), {
    ...snapshot(alpha, [root({ displayName: undefined, label: undefined, autoLabel: undefined, derivedTitle: "Transcript-derived secret" })], 10),
    totalSessions: 275,
    activeSessions: 25,
    inactiveSessionsShown: 175,
    inactiveHistoryTruncated: true,
    omittedInactiveSessions: 75
  });
  assert.equal(state.sessions["alpha::agent:main:root"]?.title, "root");
  assert.equal(state.gateways.alpha?.inactiveHistoryTruncated, true);
  assert.equal(state.gateways.alpha?.omittedInactiveSessions, 75);
  assert.equal(state.gateways.alpha?.totalSessions, 275);
  assert.equal(JSON.stringify(state).includes("Transcript-derived secret"), false);
});

test("active run semantics distinguish idle, active, and unknown", () => {
  const state = reduceDashboard(createState("demo", 0), snapshot(alpha, [
    root({ key: "active", activeRunIds: ["run-1"] }),
    root({ key: "idle", activeRunIds: [] }),
    root({ key: "unknown", activeRunIds: null })
  ], 10));
  assert.equal(state.sessions["alpha::active"]?.state, "active");
  assert.equal(state.sessions["alpha::idle"]?.state, "idle");
  assert.equal(state.sessions["alpha::agent:main:unknown"]?.state, "unknown");
});

test("events and connection failures remain isolated to their Gateway", () => {
  let state = reduceDashboard(createState("demo", 0), snapshot(alpha, [root()], 10));
  state = reduceDashboard(state, snapshot(beta, [root()], 11));
  state = reduceDashboard(state, { type: "event", gateway: alpha, at: 20, event: "agent", payload: { runId: "r", stream: "lifecycle", data: { sessionKey: root().key, type: "start" } } });
  state = reduceDashboard(state, { type: "connection", gateway: beta, state: "error", at: 25, error: "offline" });
  assert.equal(state.sessions["alpha::agent:main:root"]?.state, "active");
  assert.equal(state.sessions["beta::agent:main:root"]?.state, "unknown");
  assert.equal(state.gateways.beta?.connection.error, "offline");
  state = reduceDashboard(state, { type: "event", gateway: alpha, at: 30, event: "agent", payload: { runId: "r", stream: "lifecycle", data: { sessionKey: root().key, type: "end" } } });
  assert.equal(state.sessions["alpha::agent:main:root"]?.state, "idle");
});

test("a successful snapshot clears a transient Gateway error and preserves its version", () => {
  let state = createState("live", 0);
  state = reduceDashboard(state, { type: "connection", gateway: alpha, state: "connected", at: 10, serverVersion: "2026.9.4" });
  state = reduceDashboard(state, { type: "connection", gateway: alpha, state: "error", at: 20, error: "refresh failed" });
  state = reduceDashboard(state, snapshot(alpha, [root()], 30));
  assert.deepEqual(state.gateways.alpha?.connection, { state: "connected", since: 30, serverVersion: "2026.9.4" });
});

test("projects verified runtime and placement facts without raw placement internals", () => {
  const now = 100;
  const state = reduceDashboard(createState("live", 0), snapshot(alpha, [root({
    model: "openai/gpt-5.6-sol",
    modelProvider: "openai",
    agentRuntime: { id: "codex", source: "model", fallback: "openclaw", cloudPlacementSupported: true, cloudPlacementExecutionMode: "remote-exec", devicePlacementSupported: true, devicePlacement: { requiredNodeCommands: ["private.command"], consumesWorkerSlot: false } },
    placement: {
      state: "active", generation: 1, createdAtMs: now, updatedAtMs: now, stateChangedAtMs: now,
      workspaceBaseManifestRef: "private-manifest", remoteWorkspaceDir: "/private/path", environmentId: "private-env",
      activeOwnerEpoch: 1, workerBundleHash: "private-hash", providerId: "provider", profileId: "profile",
      machine: { class: "large", os: "linux", osLabel: "Linux" },
      runner: { kind: "device", status: "available", deviceId: "runner-1" }
    }
  })], now));
  const session = state.sessions["alpha::agent:main:root"];
  assert.deepEqual(session?.agentRuntime, {
    id: "codex", source: "model", fallback: "openclaw", cloudPlacementSupported: true,
    cloudPlacementExecutionMode: "remote-exec", devicePlacementSupported: true,
    devicePlacement: { consumesWorkerSlot: false }
  });
  assert.deepEqual(session?.placement, {
    state: "active", providerId: "provider", profileId: "profile",
    machine: { class: "large", os: "linux", osLabel: "Linux" },
    runner: { kind: "device", status: "available", deviceId: "runner-1" }
  });
  const serialized = JSON.stringify(state);
  for (const hidden of ["private.command", "private-manifest", "/private/path", "private-env", "private-hash"]) assert.equal(serialized.includes(hidden), false);
});

test("omits runtime and placement projections when the Gateway omits them", () => {
  const state = reduceDashboard(createState("live", 0), snapshot(alpha, [root()], 10));
  const session = state.sessions["alpha::agent:main:root"];
  assert.equal("agentRuntime" in (session ?? {}), false);
  assert.equal("placement" in (session ?? {}), false);
  assert.equal("modelProvider" in (session ?? {}), false);
});

test("projects a bounded progress summary without raw Markdown", () => {
  let state = reduceDashboard(createState("live", 0), snapshot(alpha, [root({ hasActiveRun: true })], 10));
  state = reduceDashboard(state, {
    type: "progressCard", gateway: alpha, sourceKey: root().key, at: 20,
    card: {
      sessionKey: root().key,
      revision: 7,
      updatedAt: 19,
      markdown: "Secret bearer token must never reach the browser",
      steps: [
        { step: "Inspect", status: "completed" },
        { step: `Repair\u202e ${"x".repeat(300)}`, status: "in_progress" },
        { step: "Verify", status: "pending" }
      ]
    }
  });
  const progress = state.sessions["alpha::agent:main:root"]?.progress;
  assert.equal(progress?.revision, 7);
  assert.equal(progress?.completed, 1);
  assert.equal(progress?.total, 3);
  assert.equal(progress?.stepStatus, "in_progress");
  assert.equal([...(progress?.step ?? "")].length, 160);
  assert.equal(JSON.stringify(state).includes("bearer token"), false);
  assert.equal(JSON.stringify(state).includes("markdown"), false);
});
