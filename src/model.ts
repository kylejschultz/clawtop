import type { AgentEvent, AgentSummary, GatewayAgentRuntime, ProgressCard, SessionPlacement, SessionRow } from "@openclaw/gateway-protocol";

export type ActivityState = "active" | "idle" | "unknown";
export type ConnectionState = "connecting" | "connected" | "reconnecting" | "error";
export type GatewayRef = { id: string; name: string };

export type SafeActivity = {
  id: string;
  sessionKey: string;
  at: number;
  kind: "agent" | "tool" | "progress" | "session";
  label: string;
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
  activeSince?: number;
  updatedAt?: number;
  lastSignalAt?: number;
  model?: string;
  modelProvider?: string;
  agentRuntime?: DashboardRuntime;
  placement?: DashboardPlacement;
  status?: string;
  progress?: DashboardProgress;
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
  | { type: "progressCard"; gateway: GatewayRef; sourceKey: string; card: ProgressCard | null; at: number }
  | { type: "event"; gateway: GatewayRef; event: string; payload: unknown; at: number };

export type SessionWire = SessionRow & {
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
    const key = scoped(gatewayId, row.key);
    const agentId = scoped(gatewayId, row.agentId ?? "unknown");
    const old = state.sessions[key];
    const sessionId = sourceScope(gatewayId, row.sessionId);
    const prior = old && sessionId && old.sessionId === sessionId ? old : undefined;
    if (!agents[agentId]) agents[agentId] = { id: agentId, sourceId: row.agentId ?? "unknown", gatewayId, name: row.agentId ?? "unknown" };
    const nextState = activityFromRow(row);
    sessions[key] = compact({
      key,
      sourceKey: row.key,
      gatewayId,
      sessionId,
      agentId,
      title: row.label ?? row.displayName ?? row.autoLabel ?? shortKey(row.key),
      kind: row.kind,
      channel: row.channel,
      parentSessionKey: sourceScope(gatewayId, row.parentSessionKey ?? row.spawnedBy),
      childSessions: (row.childSessions ?? []).map((child) => scoped(gatewayId, child)),
      state: nextState,
      activeSince: nextState === "active" ? prior?.activeSince ?? action.at : undefined,
      updatedAt: row.lastActivityAt ?? row.updatedAt ?? undefined,
      lastSignalAt: prior?.lastSignalAt ?? row.lastActivityAt ?? row.updatedAt ?? undefined,
      model: row.activeModel ?? row.model,
      modelProvider: row.activeModelProvider ?? row.modelProvider,
      agentRuntime: projectRuntime(row.agentRuntime),
      placement: projectPlacement(row.placement),
      status: row.status,
      progress: prior?.progress,
      activity: prior?.activity ?? []
    });
  }
  const previousConnection = state.gateways[gatewayId]?.connection;
  const gateway = {
    ...action.gateway,
    totalSessions: action.totalSessions,
    activeSessions: action.activeSessions,
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
  const key = scoped(action.gateway.id, action.sourceKey);
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
  const sessionKey = scoped(gateway.id, sourceKey);
  const current = state.sessions[sessionKey];
  if (!current) return { ...state, updatedAt: at };

  const activity = normalizeActivity(event, value, nested, sessionKey, at);
  let nextState = current.state;
  if (event === "sessions.changed") {
    if (typeof value.hasActiveRun === "boolean") nextState = value.hasActiveRun ? "active" : "idle";
    else if (Array.isArray(value.activeRunIds)) nextState = value.activeRunIds.length ? "active" : "idle";
  } else if (event === "agent") {
    const stream = string(value.stream);
    const dataType = string(nested?.type);
    if (stream === "lifecycle" && (dataType === "end" || dataType === "error")) nextState = "idle";
    else nextState = "active";
  }

  const next: DashboardSession = compact({
    ...current,
    state: nextState,
    activeSince: nextState === "active" ? current.activeSince ?? at : undefined,
    lastSignalAt: at,
    activity: activity ? [activity, ...current.activity].slice(0, 40) : current.activity
  });
  return { ...state, sessions: { ...state.sessions, [sessionKey]: next }, updatedAt: at };
}

function normalizeActivity(event: string, value: Record<string, unknown>, nested: Record<string, unknown> | undefined, sessionKey: string, at: number): SafeActivity | undefined {
  const runId = string(value.runId) ?? string(nested?.runId);
  if (event === "session.tool" || event.includes("tool")) {
    const tool = string(value.toolName) ?? string(value.name) ?? string(nested?.toolName) ?? string(nested?.name) ?? "tool";
    const status = string(value.status) ?? string(value.phase) ?? string(nested?.status) ?? string(nested?.phase);
    return activity(sessionKey, at, "tool", tool, status, runId);
  }
  if (event === "agent") {
    const stream = string(value.stream) ?? "agent";
    const label = string(nested?.type) ?? string(nested?.phase) ?? stream;
    return activity(sessionKey, at, stream.includes("progress") || label.includes("progress") ? "progress" : "agent", label, stream, runId);
  }
  if (event.startsWith("session.")) return activity(sessionKey, at, "session", event.slice(8), string(value.status) ?? string(value.phase), runId);
  return undefined;
}

function activity(sessionKey: string, at: number, kind: SafeActivity["kind"], label: string, status?: string, runId?: string): SafeActivity {
  return compact({ id: `${at}-${kind}-${runId ?? label}`, sessionKey, at, kind, label: label.slice(0, 120), status: status?.slice(0, 40), runId });
}
function activityFromRow(row: SessionWire): ActivityState {
  if (row.hasActiveRun === true || (row.activeRunIds?.length ?? 0) > 0 || row.status === "running" || row.status === "queued") return "active";
  if (row.hasActiveRun === false || Array.isArray(row.activeRunIds) || ["done", "failed", "killed", "timeout"].includes(row.status ?? "")) return "idle";
  return "unknown";
}
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
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function string(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function shortKey(key: string): string { const parts = key.split(":"); return parts.at(-1) || key; }
function boundedText(value: string, limit: number): string | undefined {
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim();
  return text ? [...text].slice(0, limit).join("") : undefined;
}
function compact<T extends object>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T; }

export function agentEventSessionKey(event: AgentEvent): string | undefined { return string(record(event.data)?.sessionKey); }
