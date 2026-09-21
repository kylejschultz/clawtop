import type { AgentEvent, AgentSummary, GatewayAgentRuntime, ProgressCard, SessionPlacement, SessionRow } from "@openclaw/gateway-protocol";

export type ActivityState = "active" | "idle" | "unknown";
export type ConnectionState = "connecting" | "connected" | "reconnecting" | "error";
export type GatewayRef = { id: string; name: string; host?: string };

export type SafeActivity = {
  id: string;
  sessionKey: string;
  at: number;
  kind: "agent" | "tool" | "progress" | "session";
  label: string;
  detail?: string;
  status?: string;
  runId?: string;
};

export type DashboardGateway = GatewayRef & {
  connection: { state: ConnectionState; since: number; error?: string; serverVersion?: string };
  totalSessions?: number;
  activeSessions?: number;
  inactiveSessionsShown?: number;
  inactiveHistoryTruncated?: boolean;
  omittedInactiveSessions?: number;
};
export type DashboardRuntime = Pick<GatewayAgentRuntime, "id" | "source" | "fallback" | "cloudPlacementSupported" | "cloudPlacementExecutionMode" | "devicePlacementSupported"> & {
  devicePlacement?: { consumesWorkerSlot: boolean };
};
export type DashboardPlacement = {
  state: SessionPlacement["state"];
  providerId?: string;
  profileId?: string;
  machine?: { class?: string; os?: string; osLabel?: string };
  runner?: { kind: "device"; status: "available" | "offline"; deviceId?: string };
};
export type DashboardProgress = {
  revision: number;
  updatedAt: number;
  completed: number;
  total: number;
  step?: string;
  stepStatus?: "in_progress" | "pending";
};
export type DashboardSession = {
  key: string;
  historyId?: string;
  activityCursor?: string;
  activityHistoryComplete?: boolean;
  sourceKey: string;
  gatewayId: string;
  sessionId?: string;
  agentId: string;
  title: string;
  kind: string;
  channel?: string;
  parentSessionKey?: string;
  childSessions: string[];
  state: ActivityState;
  lifecycleSince: number;
  activeSince?: number;
  updatedAt?: number;
  lastSignalAt?: number;
  model?: string;
  modelProvider?: string;
  agentRuntime?: DashboardRuntime;
  placement?: DashboardPlacement;
  status?: string;
  progress?: DashboardProgress;
  activeRunIds?: string[];
  terminalRunId?: string | null;
  activity: SafeActivity[];
};
export type DashboardAgent = { id: string; sourceId: string; gatewayId: string; name: string; emoji?: string; model?: string; agentRuntime?: DashboardRuntime };
export type DashboardState = {
  mode: "demo" | "live";
  gateways: Record<string, DashboardGateway>;
  agents: Record<string, DashboardAgent>;
  sessions: Record<string, DashboardSession>;
  updatedAt: number;
};

export type DashboardAction =
  | { type: "connection"; gateway: GatewayRef; state: ConnectionState; at: number; error?: string; serverVersion?: string }
  | { type: "snapshot"; gateway: GatewayRef; agents: AgentSummary[]; sessions: SessionWire[]; at: number; totalSessions?: number; activeSessions?: number; inactiveSessionsShown?: number; inactiveHistoryTruncated?: boolean; omittedInactiveSessions?: number }
  | { type: "progressCard"; gateway: GatewayRef; sourceKey: string; sourceAgentId?: string; card: ProgressCard | null; at: number }
  | { type: "event"; gateway: GatewayRef; event: string; payload: unknown; at: number }
  | { type: "removeGateway"; gatewayId: string; at: number };

export type SessionWire = Omit<SessionRow, "status"> & {
  status?: string;
  hasActiveRun?: boolean;
  activeRunIds?: string[] | null;
  hasActiveSubagentRun?: boolean;
  agentRuntime?: GatewayAgentRuntime;
  placement?: SessionPlacement;
};

export function createState(mode: "demo" | "live", now = Date.now()): DashboardState {
  return { mode, gateways: {}, agents: {}, sessions: {}, updatedAt: now };
}

export function reduceDashboard(state: DashboardState, action: DashboardAction): DashboardState {
  if (action.type === "removeGateway") {
    const gateways = { ...state.gateways };
    delete gateways[action.gatewayId];
    return { ...state, gateways, agents: withoutGateway(state.agents, action.gatewayId), sessions: withoutGateway(state.sessions, action.gatewayId), updatedAt: action.at };
  }
  if (action.type === "connection") {
    const previous = state.gateways[action.gateway.id]?.connection;
    return {
      ...state,
      gateways: {
        ...state.gateways,
        [action.gateway.id]: {
          ...state.gateways[action.gateway.id],
          ...action.gateway,
          connection: compact({
            state: action.state,
            since: previous?.state === action.state ? previous.since : action.at,
            error: action.error,
            serverVersion: action.serverVersion ?? previous?.serverVersion
          })
        }
      },
      updatedAt: action.at
    };
  }
  if (action.type === "snapshot") return applySnapshot(state, action);
  if (action.type === "progressCard") return applyProgressCard(state, action);
  return applyEvent(state, action.gateway, action.event, action.payload, action.at);
}

function applySnapshot(state: DashboardState, action: Extract<DashboardAction, { type: "snapshot" }>): DashboardState {
  const gatewayId = action.gateway.id;
  const agents = withoutGateway(state.agents, gatewayId);
  for (const agent of action.agents) {
    const id = scoped(gatewayId, agent.id);
    agents[id] = compact({ id, sourceId: agent.id, gatewayId, name: agent.identity?.name ?? agent.name ?? agent.id, emoji: agent.identity?.emoji, model: agent.model?.primary, agentRuntime: projectRuntime(agent.agentRuntime) });
  }
  const sessions = withoutGateway(state.sessions, gatewayId);
  for (const row of action.sessions) {
    const key = scopedSession(gatewayId, row.key, row.agentId);
    const agentId = scoped(gatewayId, row.agentId ?? "unknown");
    const old = state.sessions[key];
    const sessionId = sourceScope(gatewayId, row.sessionId);
    const prior = old && sessionId && old.sessionId === sessionId ? old : undefined;
    if (!agents[agentId]) agents[agentId] = { id: agentId, sourceId: row.agentId ?? "unknown", gatewayId, name: row.agentId ?? "unknown" };
    const nextState = activityFromRow(row);
    const rowStatus = row.status?.trim().toLowerCase();
    sessions[key] = compact({
      key,
      sourceKey: row.key,
      gatewayId,
      sessionId,
      agentId,
      title: row.label ?? row.derivedTitle ?? row.displayName ?? row.autoLabel ?? shortKey(row.key),
      kind: row.kind,
      channel: row.channel,
      parentSessionKey: sessionSourceScope(gatewayId, row.parentSessionKey ?? row.spawnedBy, row.agentId),
      childSessions: (row.childSessions ?? []).map((child) => scopedSession(gatewayId, child, row.agentId)),
      state: nextState,
      lifecycleSince: prior?.lifecycleSince ?? action.at,
      activeSince: nextState === "active" ? prior?.activeSince ?? action.at : undefined,
      updatedAt: row.lastActivityAt ?? row.updatedAt ?? undefined,
      lastSignalAt: prior?.lastSignalAt ?? row.lastActivityAt ?? row.updatedAt ?? undefined,
      model: row.activeModel ?? row.model,
      modelProvider: row.activeModelProvider ?? row.modelProvider,
      agentRuntime: projectRuntime(row.agentRuntime),
      placement: projectPlacement(row.placement),
      status: row.status,
      progress: prior?.progress,
      activeRunIds: nextState === "active" ? runIds(row.activeRunIds) ?? prior?.activeRunIds : undefined,
      terminalRunId: nextState === "active" ? undefined : isTerminalStatus(rowStatus) ? prior?.terminalRunId ?? null : prior?.terminalRunId,
      activity: prior?.activity ?? []
    });
  }
  const previousConnection = state.gateways[gatewayId]?.connection;
  const liveSessions = Object.values(sessions).filter((session) => session.gatewayId === gatewayId);
  const gateway = {
    ...action.gateway,
    totalSessions: action.totalSessions,
    activeSessions: liveSessions.filter((session) => session.state === "active").length,
    inactiveSessionsShown: action.inactiveSessionsShown,
    inactiveHistoryTruncated: action.inactiveHistoryTruncated,
    omittedInactiveSessions: action.omittedInactiveSessions,
    connection: compact({
      state: "connected" as const,
      since: previousConnection?.state === "connected" ? previousConnection.since : action.at,
      serverVersion: previousConnection?.serverVersion
    })
  };
  return { ...state, gateways: { ...state.gateways, [gatewayId]: gateway }, agents, sessions, updatedAt: action.at };
}

function applyProgressCard(state: DashboardState, action: Extract<DashboardAction, { type: "progressCard" }>): DashboardState {
  const key = scopedSession(action.gateway.id, action.sourceKey, action.sourceAgentId);
  const current = state.sessions[key];
  if (!current) return { ...state, updatedAt: action.at };
  const session = compact({ ...current, progress: projectProgress(action.card) });
  return { ...state, sessions: { ...state.sessions, [key]: session }, updatedAt: action.at };
}

function applyEvent(state: DashboardState, gateway: GatewayRef, event: string, payload: unknown, at: number): DashboardState {
  if (event === "session.observer") return { ...state, updatedAt: at };
  const value = record(payload);
  if (!value) return { ...state, updatedAt: at };
  const nested = record(value.data);
  const sourceKey = string(value.sessionKey) ?? string(value.key) ?? string(nested?.sessionKey);
  if (!sourceKey) return { ...state, updatedAt: at };
  const sourceAgentId = string(value.agentId) ?? string(nested?.agentId);
  const candidates = Object.values(state.sessions).filter((session) => session.gatewayId === gateway.id && session.sourceKey === sourceKey);
  const current = sourceAgentId
    ? candidates.find((session) => session.agentId === scoped(gateway.id, sourceAgentId))
    : candidates.length === 1 ? candidates[0] : undefined;
  if (!current) return { ...state, updatedAt: at };
  const sessionKey = current.key;

  const activity = normalizeActivity(event, value, nested, sessionKey, at);
  const runId = string(value.runId) ?? string(nested?.runId);
  let nextState = current.state;
  let nextStatus = current.status;
  let activeRunIds = current.activeRunIds;
  let terminalRunId = current.terminalRunId;
  if (event === "sessions.changed") {
    const status = string(value.status)?.trim().toLowerCase();
    const changedRunIds = runIds(value.activeRunIds);
    nextStatus = status ?? current.status;
    if (isTerminalStatus(status)) { nextState = "idle"; activeRunIds = undefined; terminalRunId = runId ?? current.terminalRunId ?? null; }
    else if (status === "running" || status === "queued") { nextState = "active"; activeRunIds = changedRunIds ?? (runId ? [runId] : activeRunIds); terminalRunId = undefined; }
    else if (isTerminalStatus(current.status) || current.terminalRunId !== undefined) nextState = "idle";
    else if (typeof value.hasActiveRun === "boolean") { nextState = value.hasActiveRun ? "active" : "idle"; activeRunIds = nextState === "active" ? changedRunIds ?? activeRunIds : undefined; }
    else if (changedRunIds) { nextState = changedRunIds.length ? "active" : "idle"; activeRunIds = changedRunIds.length ? changedRunIds : undefined; }
  } else if (event === "agent") {
    const stream = string(value.stream);
    const phase = string(nested?.type) ?? string(nested?.phase);
    const commandPhase = string(nested?.phase) ?? string(nested?.status);
    if (stream === "lifecycle" && (phase === "end" || phase === "error")) {
      const belongsToOlderRun = Boolean(runId && activeRunIds?.length && !activeRunIds.includes(runId));
      if (!belongsToOlderRun) { nextState = "idle"; activeRunIds = undefined; terminalRunId = runId ?? null; }
    }
    else if ((stream === "lifecycle" && ["start", "working", "thinking"].includes(phase ?? "")) || ((stream === "tool" || (stream === "item" && nested?.commandBearing === true)) && ["start", "running"].includes(commandPhase ?? ""))) {
      const startsNewRun = Boolean(runId && terminalRunId && runId !== terminalRunId);
      if (terminalRunId === undefined || startsNewRun) { nextState = "active"; nextStatus = startsNewRun ? undefined : nextStatus; activeRunIds = runId ? [runId] : activeRunIds; terminalRunId = undefined; }
    }
  }

  const next: DashboardSession = compact({
    ...current,
    state: nextState,
    status: nextStatus,
    activeRunIds,
    terminalRunId,
    activeSince: nextState === "active" ? current.activeSince ?? at : undefined,
    lastSignalAt: at,
    activity: activity ? mergeActivity(current.activity, activity) : current.activity
  });
  const sessions = { ...state.sessions, [sessionKey]: next };
  const currentGateway = state.gateways[gateway.id];
  const gateways = currentGateway ? {
    ...state.gateways,
    [gateway.id]: { ...currentGateway, activeSessions: Object.values(sessions).filter((session) => session.gatewayId === gateway.id && session.state === "active").length }
  } : state.gateways;
  return { ...state, gateways, sessions, updatedAt: at };
}

function normalizeActivity(event: string, value: Record<string, unknown>, nested: Record<string, unknown> | undefined, sessionKey: string, at: number): SafeActivity | undefined {
  const runId = string(value.runId) ?? string(nested?.runId);
  if (event === "session.tool" || event.includes("tool")) {
    const tool = string(value.toolName) ?? string(value.name) ?? string(nested?.toolName) ?? string(nested?.name) ?? "tool";
    const status = string(value.status) ?? string(value.phase) ?? string(nested?.status) ?? string(nested?.phase);
    return activity(sessionKey, at, "tool", tool, status, runId, string(value.toolCallId) ?? string(nested?.toolCallId), toolDetail(tool, value, nested));
  }
  if (event === "agent") {
    const stream = string(value.stream) ?? "agent";
    const phase = string(nested?.phase);
    const tool = string(nested?.name) ?? string(nested?.toolName);
    const toolCallId = string(nested?.toolCallId);
    if (stream === "tool" || (stream === "item" && nested?.commandBearing === true)) {
      return activity(sessionKey, at, "tool", tool ?? "tool", string(nested?.status) ?? phase, runId, toolCallId, toolDetail(tool, value, nested));
    }
    const label = string(nested?.type) ?? phase ?? stream;
    if (stream === "item") return undefined;
    return activity(sessionKey, at, stream.includes("progress") || label.includes("progress") ? "progress" : "agent", label, stream, runId);
  }
  if (event.startsWith("session.")) return activity(sessionKey, at, "session", event.slice(8), string(value.status) ?? string(value.phase), runId);
  return undefined;
}

function activity(sessionKey: string, at: number, kind: SafeActivity["kind"], label: string, status?: string, runId?: string, stableId?: string, detail?: string): SafeActivity {
  return compact({ id: `${kind}-${stableId ?? `${at}-${runId ?? label}`}`, sessionKey, at, kind, label: label.slice(0, 120), detail, status: status?.slice(0, 40), runId });
}
function mergeActivity(items: SafeActivity[], next: SafeActivity): SafeActivity[] {
  const current = items.find((item) => item.id === next.id);
  const merged = current ? compact({ ...current, ...next, detail: current.detail ?? next.detail }) : next;
  return [merged, ...items.filter((item) => item.id !== next.id)].slice(0, 40);
}
function toolDetail(tool: string | undefined, value: Record<string, unknown>, nested: Record<string, unknown> | undefined): string | undefined {
  const args = record(value.args) ?? record(nested?.args);
  const title = redactSensitiveText(string(nested?.title) ?? string(args?.title), 160);
  const command = tool === "exec" ? safeCommand(string(args?.command)) : undefined;
  return [title, command].filter((item, index, all): item is string => Boolean(item && all.indexOf(item) === index)).join(" · ") || undefined;
}
export function safeCommand(value: string | undefined): string | undefined {
  return redactSensitiveText(value, 320);
}
function redactSensitiveText(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  const text = value
    .replace(/\b(https?:\/\/)([^\s:/@]+):([^\s/@]+)@/giu, "$1***:***@")
    .replace(/((?:^|\s)(?:-u|--user)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s;&|]+)/giu, "$1***")
    .replace(/\bBearer\s+[^\s'";&|]+/giu, "Bearer ***")
    .replace(/\bBasic\s+[^\s'";&|]+/giu, "Basic ***")
    .replace(/(["'])((?:proxy-)?authorization\s*[:=]\s*)[^'"]*\1/giu, "$1$2***$1")
    .replace(/((?:proxy-)?authorization\s*[:=]\s*)[^\s'";&|]+/giu, "$1***")
    .replace(/(["'])(cookie\s*[:=]\s*)[^'"]*\1/giu, "$1$2***$1")
    .replace(/(cookie\s*[:=]\s*)[^\s'";&|]+/giu, "$1***")
    .replace(/((?:[a-z0-9_-]*(?:token|password|passwd|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[a-z0-9_-]*)\s*(?:[:=]|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/giu, "$1***")
    .replace(/[A-Za-z0-9+/_=-]{48,}/gu, "***");
  return boundedText(text, limit);
}
export function activityFromRow(row: SessionWire): ActivityState {
  const status = row.status?.trim().toLowerCase();
  if (isTerminalStatus(status)) return "idle";
  if (status === "running" || status === "queued" || row.hasActiveRun === true || row.hasActiveSubagentRun === true || (row.activeRunIds?.length ?? 0) > 0) return "active";
  if (row.hasActiveRun === false || Array.isArray(row.activeRunIds)) return "idle";
  return "unknown";
}
const TERMINAL_STATUSES = new Set(["done", "completed", "complete", "finished", "succeeded", "success", "failed", "error", "cancelled", "canceled", "aborted", "killed", "terminated", "timeout", "timed_out", "stopped", "idle", "skipped"]);
export function isTerminalStatus(status: string | undefined): boolean { return Boolean(status && TERMINAL_STATUSES.has(status)); }
function projectRuntime(runtime: GatewayAgentRuntime | undefined): DashboardRuntime | undefined {
  if (!runtime) return undefined;
  return compact({
    id: runtime.id,
    source: runtime.source,
    fallback: runtime.fallback,
    cloudPlacementSupported: runtime.cloudPlacementSupported,
    cloudPlacementExecutionMode: runtime.cloudPlacementExecutionMode,
    devicePlacementSupported: runtime.devicePlacementSupported,
    devicePlacement: runtime.devicePlacement ? { consumesWorkerSlot: runtime.devicePlacement.consumesWorkerSlot } : undefined
  });
}
function projectPlacement(placement: SessionPlacement | undefined): DashboardPlacement | undefined {
  if (!placement) return undefined;
  const value = placement as SessionPlacement & {
    providerId?: string;
    profileId?: string;
    machine?: { class?: string; os?: string; osLabel?: string };
    runner?: { kind: "device"; status: "available" | "offline"; deviceId?: string };
  };
  return compact({
    state: value.state,
    providerId: value.providerId,
    profileId: value.profileId,
    machine: value.machine && Object.values(value.machine).some(Boolean) ? compact({ class: value.machine.class, os: value.machine.os, osLabel: value.machine.osLabel }) : undefined,
    runner: value.runner ? compact({ kind: value.runner.kind, status: value.runner.status, deviceId: value.runner.deviceId }) : undefined
  });
}
function projectProgress(card: ProgressCard | null): DashboardProgress | undefined {
  if (!card) return undefined;
  const steps = card.steps ?? [];
  const current = steps.find((step) => step.status === "in_progress") ?? steps.find((step) => step.status === "pending");
  return compact({
    revision: card.revision,
    updatedAt: card.updatedAt,
    completed: steps.filter((step) => step.status === "completed").length,
    total: steps.length,
    step: current ? boundedText(current.step, 160) : undefined,
    stepStatus: current?.status === "in_progress" || current?.status === "pending" ? current.status : undefined
  });
}
function withoutGateway<T extends { gatewayId: string }>(items: Record<string, T>, gatewayId: string): Record<string, T> { return Object.fromEntries(Object.entries(items).filter(([, item]) => item.gatewayId !== gatewayId)); }
function scoped(gatewayId: string, id: string): string { return `${gatewayId}::${id}`; }
function sourceScope(gatewayId: string, id: string | undefined): string | undefined { return id ? scoped(gatewayId, id) : undefined; }
function scopedSession(gatewayId: string, key: string, agentId?: string): string { return scoped(gatewayId, (key === "global" || key === "unknown") && agentId ? `agent:${agentId}:${key}` : key); }
function sessionSourceScope(gatewayId: string, key: string | undefined, agentId?: string): string | undefined { return key ? scopedSession(gatewayId, key, agentId) : undefined; }
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function string(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function runIds(value: unknown): string[] | undefined { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item)) : undefined; }
function shortKey(key: string): string { const parts = key.split(":"); return parts.at(-1) || key; }
function boundedText(value: string, limit: number): string | undefined {
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim();
  return text ? [...text].slice(0, limit).join("") : undefined;
}
function compact<T extends object>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T; }

export function agentEventSessionKey(event: AgentEvent): string | undefined { return string(record(event.data)?.sessionKey); }
