import { join } from "node:path";
import { GatewayClient } from "@openclaw/gateway-client";
import { GATEWAY_CLIENT_CAPS, GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "@openclaw/gateway-protocol/client-info";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import type { AgentSummary, ProgressCard } from "@openclaw/gateway-protocol";
import type { EventFrame, HelloOk } from "@openclaw/gateway-protocol/frame-guards";
import type { Config, GatewayConfig } from "./config.js";
import { createIdentityHost } from "./identity.js";
import type { DashboardAction, GatewayRef, SessionWire } from "./model.js";

type Dispatch = (action: DashboardAction) => void;
export type ActivityAdapter = { start(): void; stop(): Promise<void> };
type AgentsResult = { agents: AgentSummary[] };
export type SessionsResult = { sessions: SessionWire[]; hasMore?: boolean; totalCount?: number; nextOffset?: number };
export type SessionViewResult = SessionsResult & {
  activeSessions: number;
  inactiveSessionsShown: number;
  inactiveHistoryTruncated?: boolean;
  omittedInactiveSessions?: number;
};
type ProgressCardGetResult = { card: ProgressCard | null };
type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
const SESSION_PAGE_SIZE = 200;

export class ExactSessionSubscriptions {
  private readonly current = new Map<string, { key: string; agentId?: string }>();
  constructor(private readonly request: Request) {}

  reset(): void { this.current.clear(); }

  async reconcile(sessions: SessionWire[]): Promise<void> {
    const desired = new Map(sessions.map((session) => {
      const target = compact({ key: session.key, agentId: session.agentId });
      return [subscriptionId(target), target];
    }));
    for (const [id, target] of this.current) {
      if (desired.has(id)) continue;
      try {
        await this.request("sessions.messages.unsubscribe", target);
        this.current.delete(id);
      } catch { /* best effort; retry on the next snapshot */ }
    }
    for (const [id, target] of desired) {
      if (this.current.has(id)) continue;
      try {
        await this.request("sessions.messages.subscribe", target);
        this.current.set(id, target);
      } catch { /* best effort; retry on the next snapshot */ }
    }
  }
}

export function createAdapter(config: Config, dispatch: Dispatch): ActivityAdapter {
  if (config.mode === "demo") return new DemoAdapter(dispatch);
  const adapters = config.gateways.map((gateway) => new LiveAdapter(gateway, config.dataDir, dispatch));
  return {
    start: () => { for (const adapter of adapters) adapter.start(); },
    stop: async () => { await Promise.all(adapters.map((adapter) => adapter.stop())); }
  };
}

class LiveAdapter implements ActivityAdapter {
  private readonly client: GatewayClient;
  private readonly dispatch: Dispatch;
  private readonly gateway: GatewayRef;
  private readonly secrets: string[];
  private readonly subscriptions: ExactSessionSubscriptions;
  private readonly sessionRequest: Request;
  private readonly readActiveSessions: () => Promise<SessionsResult | undefined>;
  private stopped = false;
  private refreshTimer?: NodeJS.Timeout;
  private bootstrapInFlight = false;
  private bootstrapDirty = false;
  private snapshotRevision = 0;
  private progressAgentScope = false;
  private sessions: SessionWire[] = [];
  private agents: AgentSummary[] = [];

  constructor(config: GatewayConfig, dataDir: string, dispatch: Dispatch) {
    const { identity, hostDeps } = createIdentityHost(join(dataDir, "gateways", config.id));
    this.gateway = { id: config.id, name: config.name, host: config.host };
    this.dispatch = dispatch;
    this.secrets = [config.token, config.password, config.bootstrapToken].filter((value): value is string => Boolean(value));
    this.client = new GatewayClient({
      url: config.url,
      token: config.token,
      password: config.password,
      bootstrapToken: config.bootstrapToken,
      tlsFingerprint: config.tlsFingerprint,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: `Clawtop (${config.name})`,
      clientVersion: "0.1.0",
      platform: process.platform,
      deviceFamily: "server",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      role: "operator",
      scopes: ["operator.read"],
      caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS, GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      deviceIdentity: identity,
      hostDeps,
      onHelloOk: (hello) => { void this.connected(hello); },
      onEvent: (event) => this.event(event),
      onConnectError: (error) => this.connection("error", { error: safeError(error, this.secrets) }),
      onReconnectPaused: (info) => this.connection("error", { error: `${info.detailCode ?? "connection paused"}: ${safeText(info.reason, this.secrets)}` }),
      onClose: () => {
        this.snapshotRevision += 1;
        this.subscriptions.reset();
        if (!this.stopped) this.connection("reconnecting");
      },
      onGap: () => this.scheduleRefresh()
    });
    const request = (method: string, params: Record<string, unknown>) => this.client.request(method, params);
    this.sessionRequest = createDerivedTitleRequest(request);
    this.subscriptions = new ExactSessionSubscriptions(request);
    this.readActiveSessions = createActiveSessionFetcher(this.sessionRequest);
  }

  start(): void {
    this.connection("connecting");
    this.client.start();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    await this.client.stopAndWait();
  }
  private connection(state: "connecting" | "connected" | "reconnecting" | "error", extra: { error?: string; serverVersion?: string } = {}): void {
    this.dispatch({ type: "connection", gateway: this.gateway, state, at: Date.now(), ...extra });
  }
  private async connected(hello: HelloOk): Promise<void> {
    const revision = ++this.snapshotRevision;
    this.connection("connected", { serverVersion: hello.server.version });
    this.progressAgentScope = hello.features.capabilities?.includes("progress-card-agent-scope-v1") === true;
    this.subscriptions.reset();
    this.bootstrapInFlight = true;
    this.bootstrapDirty = false;
    try {
      const [agents, recent, active] = await Promise.all([
        this.client.request<AgentsResult>("agents.list", {}),
        subscribeSessions(this.sessionRequest),
        this.readActiveSessions()
      ]);
      const nextAgents = validAgents(agents);
      const view = mergeSessionViews(recent, active ?? activeSessionsFromRecent(recent));
      if (revision !== this.snapshotRevision) return;
      this.agents = nextAgents;
      const needsTrailingRefresh = this.bootstrapDirty;
      this.bootstrapInFlight = false;
      if (needsTrailingRefresh) await this.refresh();
      else {
        this.sessions = view.sessions;
        await this.publishSnapshot(view);
      }
    } catch (error) {
      if (revision !== this.snapshotRevision) return;
      this.bootstrapInFlight = false;
      this.connection("error", { error: `snapshot failed: ${safeError(error, this.secrets)}` });
    }
  }
  private event(frame: EventFrame): void {
    if (frame.event === "sessions.changed") {
      if (this.bootstrapInFlight) this.bootstrapDirty = true;
      else this.scheduleRefresh();
    }
    if (frame.event === "progressCard.changed") {
      const event = record(frame.payload);
      const value = event?.sessionKey;
      const key = typeof value === "string" && value ? value : undefined;
      const agentId = typeof event?.agentId === "string" ? event.agentId : undefined;
      const session = key ? findProgressSession(this.sessions, key, agentId) : undefined;
      if (session) void this.refreshProgress(session);
    }
    const payload = attachKnownSession(frame.payload, this.sessions);
    this.dispatch({ type: "event", gateway: this.gateway, event: frame.event, payload, at: Date.now() });
  }
  private scheduleRefresh(delay = 200): void {
    if (this.refreshTimer || this.stopped) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; void this.refresh(); }, delay);
  }
  private async refresh(): Promise<void> {
    const revision = ++this.snapshotRevision;
    try {
      const [recent, active] = await Promise.all([
        this.sessionRequest("sessions.list", { limit: SESSION_PAGE_SIZE }).then(validSessions),
        this.readActiveSessions()
      ]);
      if (revision !== this.snapshotRevision) return;
      const view = mergeSessionViews(recent, active ?? activeSessionsFromRecent(recent));
      this.sessions = view.sessions;
      await this.publishSnapshot(view);
    } catch (error) {
      if (revision !== this.snapshotRevision) return;
      this.connection("error", { error: `refresh failed: ${safeError(error, this.secrets)}` });
      this.scheduleRefresh(2000);
    }
  }
  private async publishSnapshot(result: SessionViewResult): Promise<void> {
    this.dispatch({
      type: "snapshot", gateway: this.gateway, agents: this.agents, sessions: this.sessions, at: Date.now(),
      totalSessions: validCount(result.totalCount),
      activeSessions: result.activeSessions,
      inactiveSessionsShown: result.inactiveSessionsShown,
      inactiveHistoryTruncated: result.inactiveHistoryTruncated,
      omittedInactiveSessions: result.omittedInactiveSessions
    });
    await this.subscriptions.reconcile(this.sessions);
    await Promise.all(this.sessions.filter(wantsProgressCard).map((session) => this.refreshProgress(session)));
  }
  private async refreshProgress(session: SessionWire): Promise<void> {
    if (session.key === "global" && session.agentId && !this.progressAgentScope) return;
    try {
      const params = compact({ sessionKey: session.key, agentId: this.progressAgentScope ? session.agentId : undefined });
      const result = await this.client.request<ProgressCardGetResult>("progressCard.get", params);
      this.dispatch({ type: "progressCard", gateway: this.gateway, sourceKey: session.key, sourceAgentId: session.agentId, card: result.card, at: Date.now() });
    } catch { /* optional read-only enrichment; retain the last safe projection */ }
  }
}

class DemoAdapter implements ActivityAdapter {
  private timer?: NodeJS.Timeout;
  private step = 0;
  private readonly scruffy = { id: "scruffy", name: "Scruffy · Unraid" };
  private readonly morrow = { id: "morrow", name: "Morrow · Lantern" };
  constructor(private readonly dispatch: Dispatch) {}
  start(): void {
    const now = Date.now();
    for (const gateway of [this.scruffy, this.morrow]) this.dispatch({ type: "connection", gateway, state: "connected", at: now, serverVersion: "demo" });
    this.dispatch({
      type: "snapshot", gateway: this.scruffy, at: now,
      agents: [{ id: "main", name: "Scruffy", identity: { emoji: "◇" }, model: { primary: "anthropic/claude-opus-5", fallbacks: [] }, agentRuntime: { id: "openclaw", source: "agent", cloudPlacementSupported: true, devicePlacementSupported: true, devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true } } }],
      sessions: [
        { key: "agent:main:dashboard", sessionId: "demo-scruffy", kind: "direct", agentId: "main", displayName: "Monitor Unraid", hasActiveRun: false, activeRunIds: [], model: "anthropic/claude-opus-5", modelProvider: "anthropic", agentRuntime: { id: "openclaw", source: "agent", cloudPlacementSupported: true, devicePlacementSupported: true, devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true } }, placement: { state: "local", generation: 1, createdAtMs: now, updatedAtMs: now, stateChangedAtMs: now } },
        { key: "agent:main:child", sessionId: "demo-child", kind: "direct", agentId: "main", displayName: "Inspect media stack", parentSessionKey: "agent:main:dashboard", hasActiveRun: false, activeRunIds: [], status: "done" }
      ]
    });
    this.dispatch({
      type: "snapshot", gateway: this.morrow, at: now,
      agents: [{ id: "main", name: "Morrow", identity: { emoji: "🌒" }, model: { primary: "openai/gpt-5.6-sol", fallbacks: [] }, agentRuntime: { id: "codex", source: "model", fallback: "openclaw", cloudPlacementSupported: true, cloudPlacementExecutionMode: "remote-exec", devicePlacementSupported: true, devicePlacement: { requiredNodeCommands: ["codex.app-server"], consumesWorkerSlot: false } } }],
      sessions: [
        { key: "agent:main:dashboard", sessionId: "demo-morrow", kind: "direct", agentId: "main", displayName: "Build Clawtop fleet view", hasActiveRun: true, activeRunIds: ["run-demo"], model: "openai/gpt-5.6-sol", modelProvider: "openai", agentRuntime: { id: "codex", source: "model", fallback: "openclaw", cloudPlacementSupported: true, cloudPlacementExecutionMode: "remote-exec", devicePlacementSupported: true, devicePlacement: { requiredNodeCommands: ["codex.app-server"], consumesWorkerSlot: false } }, placement: { state: "active", generation: 2, createdAtMs: now, updatedAtMs: now, stateChangedAtMs: now, workspaceBaseManifestRef: "demo-redacted", remoteWorkspaceDir: "/demo-redacted", environmentId: "demo-env", activeOwnerEpoch: 1, workerBundleHash: "demo-redacted", providerId: "paired-device", profileId: "lantern", machine: { class: "NUC", os: "linux", osLabel: "Linux" }, runner: { kind: "device", status: "available", deviceId: "lantern-runner" } }, childSessions: ["agent:main:child"] },
        { key: "agent:main:child", sessionId: "demo-morrow-child", kind: "direct", agentId: "main", displayName: "Verify Gateway isolation", parentSessionKey: "agent:main:dashboard", hasActiveRun: false, activeRunIds: [], status: "done" }
      ]
    });
    this.dispatch({
      type: "progressCard", gateway: this.morrow, sourceKey: "agent:main:dashboard", at: now,
      card: {
        sessionKey: "agent:main:dashboard", revision: 3, updatedAt: now,
        markdown: "This demo Markdown is intentionally not sent to the browser.",
        steps: [
          { step: "Implement the multi-Gateway data path", status: "completed" },
          { step: "Verify safe projections", status: "in_progress" },
          { step: "Prepare deployment", status: "pending" }
        ]
      }
    });
    this.timer = setInterval(() => this.tick(), 2400);
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); }
  private tick(): void {
    const events = [
      { event: "session.tool", payload: { sessionKey: "agent:main:dashboard", toolName: "read", status: "completed" } },
      { event: "agent", payload: { runId: "run-demo", stream: "progress", data: { sessionKey: "agent:main:dashboard", type: "build", percent: 70 } } },
      { event: "session.tool", payload: { sessionKey: "agent:main:dashboard", toolName: "exec", status: "running", arguments: { intentionally: "discarded" } } }
    ];
    const item = events[this.step % events.length];
    this.step += 1;
    if (item) this.dispatch({ type: "event", gateway: this.morrow, event: item.event, payload: item.payload, at: Date.now() });
  }
}

export async function subscribeSessions(request: Request): Promise<SessionsResult> {
  const value = record(await request("sessions.subscribe", { limit: SESSION_PAGE_SIZE }));
  if (value?.subscribed !== true) throw new Error("sessions.subscribe returned an invalid payload");
  return validSessions(await request("sessions.list", { limit: SESSION_PAGE_SIZE }));
}

export function createDerivedTitleRequest(request: Request): Request {
  let supported = true;
  return async (method, params) => {
    if (!supported || (method !== "sessions.list" && method !== "sessions.subscribe")) return request(method, params);
    try { return await request(method, { ...params, includeDerivedTitles: true }); }
    catch (error) {
      if (!rejectsDerivedTitles(error)) throw error;
      supported = false;
      return request(method, params);
    }
  };
}

export function createActiveSessionFetcher(request: Request): () => Promise<SessionsResult | undefined> {
  let supported = true;
  return async () => {
    if (!supported) return undefined;
    try { return await fetchActiveSessions(request); }
    catch (error) {
      if (!rejectsActiveOnly(error)) throw error;
      supported = false;
      return undefined;
    }
  };
}

export async function fetchActiveSessions(request: Request): Promise<SessionsResult> {
  const sessions = new Map<string, SessionWire>();
  let offset = 0;
  let totalCount: number | undefined;
  while (true) {
    const page = validSessions(await request("sessions.list", { activeOnly: true, limit: SESSION_PAGE_SIZE, offset }));
    totalCount = page.totalCount ?? totalCount;
    const before = sessions.size;
    for (const session of page.sessions) sessions.set(subscriptionId(session), session);
    if (page.hasMore === false || (page.hasMore === undefined && totalCount !== undefined && sessions.size >= totalCount)) break;
    if (page.hasMore === undefined && totalCount === undefined) throw new Error("active session list omitted pagination metadata");
    const nextOffset = page.nextOffset ?? offset + page.sessions.length;
    if (nextOffset <= offset || sessions.size === before) throw new Error("active session pagination did not advance");
    offset = nextOffset;
  }
  return { sessions: [...sessions.values()], hasMore: false, totalCount };
}

function activeSessionsFromRecent(recent: SessionsResult): SessionsResult {
  return { sessions: recent.sessions.filter(isActiveSession), hasMore: false };
}

export function mergeSessionViews(recent: SessionsResult, active: SessionsResult): SessionViewResult {
  const activeById = new Map(active.sessions.map((session) => [subscriptionId(session), session]));
  const merged = new Map(activeById);
  for (const session of recent.sessions) if (!merged.has(subscriptionId(session))) merged.set(subscriptionId(session), session);
  const inactiveSessionsShown = merged.size - activeById.size;
  const omittedInactiveSessions = recent.totalCount === undefined
    ? undefined
    : Math.max(0, recent.totalCount - activeById.size - inactiveSessionsShown);
  return compact({
    sessions: [...merged.values()],
    totalCount: recent.totalCount,
    activeSessions: activeById.size,
    inactiveSessionsShown,
    inactiveHistoryTruncated: omittedInactiveSessions === undefined ? undefined : omittedInactiveSessions > 0,
    omittedInactiveSessions
  });
}

function validAgents(value: unknown): AgentSummary[] {
  const result = record(value);
  if (!Array.isArray(result?.agents)) throw new Error("agents.list returned an invalid payload");
  return result.agents.filter((agent): agent is AgentSummary => Boolean(record(agent) && typeof record(agent)?.id === "string"));
}
function validSessions(value: unknown): SessionsResult {
  const result = record(value);
  if (!Array.isArray(result?.sessions)) throw new Error("sessions list returned an invalid payload");
  const sessions = result.sessions.filter((session): session is SessionWire => {
    const row = record(session);
    return typeof row?.key === "string" && typeof row.kind === "string";
  });
  return {
    sessions,
    hasMore: typeof result.hasMore === "boolean" ? result.hasMore : undefined,
    totalCount: validCount(result.totalCount),
    nextOffset: validCount(result.nextOffset)
  };
}
function attachKnownSession(payload: unknown, sessions: SessionWire[]): unknown {
  const value = record(payload);
  if (!value || value.sessionKey || value.key) return payload;
  const data = record(value.data);
  if (data?.sessionKey) return payload;
  const runId = typeof value.runId === "string" ? value.runId : undefined;
  if (!runId) return payload;
  const match = sessions.find((session) => session.activeRunIds?.includes(runId) || session.lastRunId === runId);
  return match ? { ...value, agentId: match.agentId, data: { ...data, sessionKey: match.key } } : payload;
}
function wantsProgressCard(session: SessionWire): boolean {
  return isActiveSession(session) && !session.parentSessionKey && !session.spawnedBy;
}
function isActiveSession(session: SessionWire): boolean {
  return session.hasActiveRun === true || session.hasActiveSubagentRun === true || (session.activeRunIds?.length ?? 0) > 0 || session.status === "running" || session.status === "queued";
}
function rejectsActiveOnly(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid sessions\.list params:.*unexpected property ['"]?activeOnly['"]?/iu.test(message);
}
function rejectsDerivedTitles(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid sessions\.(?:list|subscribe) params:.*unexpected property ['"]?includeDerivedTitles['"]?/iu.test(message);
}
function findProgressSession(sessions: SessionWire[], key: string, agentId?: string): SessionWire | undefined {
  return sessions.find((session) => (!agentId || session.agentId === agentId) && (session.key === key || (session.key === "global" && key === `agent:${session.agentId}:global`)));
}
function subscriptionId(target: { key: string; agentId?: string }): string { return `${target.agentId ?? ""}\u0000${target.key}`; }
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function compact<T extends object>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T; }
function validCount(value: unknown): number | undefined { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined; }
function safeError(error: unknown, secrets: string[]): string { return safeText(error instanceof Error ? error.message : String(error), secrets); }
function safeText(value: string, secrets: string[] = []): string {
  let safe = value;
  for (const secret of secrets) safe = safe.replaceAll(secret, "***");
  return safe.replace(/([?&](?:token|password|secret|key)=)[^&#\s]+/giu, "$1***").replace(/Bearer\s+\S+/giu, "Bearer ***").slice(0, 300);
}
