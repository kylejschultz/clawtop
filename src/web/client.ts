type ActivityState = "active" | "idle" | "unknown";
type Activity = { id: string; at: number; kind: string; label: string; detail?: string; status?: string; runId?: string };
type ActivityView = Activity & { repeats?: number; oldestAt?: number };
type Gateway = { id: string; name: string; host?: string; totalSessions?: number; activeSessions?: number; inactiveSessionsShown?: number; inactiveHistoryTruncated?: boolean; omittedInactiveSessions?: number; connection: { state: string; since: number; error?: string; serverVersion?: string } };
type Runtime = { id: string; source: string; fallback?: string; cloudPlacementSupported?: boolean; cloudPlacementExecutionMode?: string; devicePlacementSupported?: boolean; devicePlacement?: { consumesWorkerSlot: boolean } };
type Placement = { state: string; providerId?: string; profileId?: string; machine?: { class?: string; os?: string; osLabel?: string }; runner?: { kind: "device"; status: "available" | "offline"; deviceId?: string } };
type Progress = { revision: number; updatedAt: number; completed: number; total: number; step?: string; stepStatus?: "in_progress" | "pending" };
type Session = { key: string; sourceKey: string; gatewayId: string; sessionId?: string; agentId: string; title: string; kind: string; channel?: string; parentSessionKey?: string; childSessions: string[]; state: ActivityState; activeSince?: number; updatedAt?: number; lastSignalAt?: number; model?: string; modelProvider?: string; agentRuntime?: Runtime; placement?: Placement; status?: string; progress?: Progress; activity: Activity[] };
type Agent = { id: string; sourceId: string; gatewayId: string; name: string; emoji?: string; model?: string; agentRuntime?: Runtime };
type State = { mode: "demo" | "live"; gateways: Record<string, Gateway>; agents: Record<string, Agent>; sessions: Record<string, Session>; updatedAt: number };

let state: State | undefined;
let selected = "";
let browserConnected = false;
const expandedGateways = new Set<string>();
const tree = get("tree");
const detailContent = get("detail-content") as HTMLElement;
const empty = get("empty") as HTMLElement;
const source = new EventSource("/api/events");

source.addEventListener("state", (event) => {
  state = JSON.parse((event as MessageEvent<string>).data) as State;
  browserConnected = true;
  if (!selected || !state.sessions[selected]) selected = initialSelection(state);
  render();
});
source.onopen = () => { browserConnected = true; renderConnection(); };
source.onerror = () => { browserConnected = false; renderConnection(); };
setInterval(() => { renderTimes(); }, 1000);

function render(): void {
  if (!state) return;
  get("mode").textContent = `mode: ${state.mode}`;
  const gateways = Object.values(state.gateways);
  const agents = Object.values(state.agents);
  const sessions = Object.values(state.sessions);
  const active = sessions.filter((session) => session.state === "active").length;
  const connected = gateways.filter((gateway) => gateway.connection.state === "connected").length;
  const hidden = gateways.reduce((sum, gateway) => sum + (gateway.omittedInactiveSessions ?? 0), 0);
  get("metric-gateways").textContent = `${connected}/${gateways.length}`;
  get("metric-agents").textContent = String(agents.length);
  get("metric-sessions").textContent = String(sessions.length);
  get("metric-active").textContent = String(active);
  get("metric-updated").textContent = relative(state.updatedAt);
  get("counts").textContent = `${sessions.length} shown${hidden ? ` · ${hidden} older inactive hidden` : ""}`;
  renderConnection();
  tree.replaceChildren(...gateways.sort((a, b) => a.name.localeCompare(b.name)).map((gateway) => renderGateway(
    gateway,
    agents.filter((agent) => agent.gatewayId === gateway.id),
    sessions.filter((session) => session.gatewayId === gateway.id)
  )));
  renderDetail();
}

function renderGateway(gateway: Gateway, agents: Agent[], sessions: Session[]): HTMLElement {
  const expanded = expandedGateways.has(gateway.id);
  const section = element("section", `gateway${expanded ? " expanded" : " collapsed"}`);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = `gateway-toggle ${gateway.connection.state}`;
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.setAttribute("aria-controls", `gateway-${gateway.id}`);
  toggle.addEventListener("click", () => {
    if (expandedGateways.has(gateway.id)) expandedGateways.delete(gateway.id);
    else expandedGateways.add(gateway.id);
    render();
  });

  const active = gateway.activeSessions ?? sessions.filter((session) => session.state === "active").length;
  const focus = sortSessions(sessions.filter((session) => session.state === "active"))[0];
  const focusText = focus?.progress?.step ?? focus?.title ?? "No active sessions";
  const emoji = agents.find((agent) => agent.sourceId === "main")?.emoji ?? agents.find((agent) => agent.emoji)?.emoji;
  const heading = element("span", "gateway-heading");
  heading.append(text("", `gateway-caret${expanded ? " open" : ""}`));
  if (emoji) heading.append(text(emoji, "gateway-emoji"));
  heading.append(text(gateway.name, "gateway-name"));
  if (gateway.host) heading.append(text(gateway.host, "gateway-host"));
  heading.append(text(gateway.connection.state, "gateway-state"));
  const version = gateway.connection.serverVersion ? `v${gateway.connection.serverVersion}` : "version unknown";
  heading.append(text(version, "gateway-version"));

  const stats = element("span", "gateway-stats");
  stats.append(metric(`${active}`, "active"), metric(`${agents.length}`, "agents"));

  const now = element("span", `gateway-now${focus ? " live" : ""}`);
  now.append(text(focus ? "now" : "status", "gateway-now-label"), text(focusText, "gateway-now-text"));
  const since = text(`${gateway.connection.state} ${relative(gateway.connection.since)}`, "gateway-since");
  since.dataset.gateway = gateway.id;
  toggle.append(heading, stats, now, since);

  const body = element("div", "gateway-body");
  body.id = `gateway-${gateway.id}`;
  body.hidden = !expanded;
  for (const agent of agents.sort((a, b) => a.name.localeCompare(b.name))) body.append(renderAgent(agent, sessions.filter((session) => session.agentId === agent.id)));
  section.append(toggle, body);
  return section;
}

function metric(value: string, label: string): HTMLElement {
  const node = element("span", "gateway-metric");
  node.append(text(value, "gateway-metric-value"), text(label, "gateway-metric-label"));
  return node;
}

function renderAgent(agent: Agent, sessions: Session[]): HTMLElement {
  const section = element("section", "agent");
  const title = element("div", "agent-title");
  title.append(text(`${agent.emoji ?? "◇"} ${agent.name}`));
  if (agent.agentRuntime) title.append(text(agent.agentRuntime.id, "agent-runtime"));
  title.append(text(`${sessions.filter((session) => session.state === "active").length} active · ${sessions.length} total`, "agent-count"));
  section.append(title);
  const byKey = new Map(sessions.map((session) => [session.key, session]));
  const explicitChildren = new Set(sessions.map((session) => session.parentSessionKey).filter((key): key is string => Boolean(key && byKey.has(key))));
  const referenced = new Set(sessions.flatMap((session) => session.childSessions).filter((key) => byKey.has(key)));
  const roots = sessions.filter((session) => !session.parentSessionKey || !byKey.has(session.parentSessionKey)).filter((session) => !referenced.has(session.key));
  const orderedRoots = roots.length ? roots : sessions;
  const seen = new Set<string>();
  for (const root of sortSessions(orderedRoots)) appendSession(section, root, byKey, seen, 0);
  for (const session of sortSessions(sessions.filter((item) => !seen.has(item.key)))) appendSession(section, session, byKey, seen, explicitChildren.has(session.key) ? 1 : 0);
  return section;
}

function appendSession(parent: HTMLElement, session: Session, byKey: Map<string, Session>, seen: Set<string>, depth: number): void {
  if (seen.has(session.key)) return;
  seen.add(session.key);
  const button = document.createElement("button");
  button.type = "button";
  button.className = `session${selected === session.key ? " selected" : ""}`;
  button.style.setProperty("--depth", String(Math.min(depth, 6)));
  button.setAttribute("aria-pressed", String(selected === session.key));
  button.dataset.key = session.key;
  button.addEventListener("click", () => { selected = session.key; render(); });
  button.append(text("", `dot ${session.state}`));
  const label = element("span", "session-title");
  label.append(text(session.title), text(`${session.kind}${session.channel ? ` · ${session.channel}` : ""}${session.placement ? ` · ${session.placement.state}` : ""}`, "session-meta"));
  button.append(label, text(relative(session.lastSignalAt ?? session.updatedAt), "session-age"));
  parent.append(button);
  const children = new Set(session.childSessions);
  for (const item of byKey.values()) if (item.parentSessionKey === session.key) children.add(item.key);
  for (const child of sortSessions([...children].map((key) => byKey.get(key)).filter((item): item is Session => Boolean(item)))) appendSession(parent, child, byKey, seen, depth + 1);
}

function renderConnection(): void {
  const node = get("connection");
  if (!browserConnected) {
    node.className = "connection reconnecting";
    node.textContent = "reconnecting · browser stream";
    return;
  }
  const gateways = Object.values(state?.gateways ?? {});
  const connected = gateways.filter((gateway) => gateway.connection.state === "connected").length;
  const status = gateways.length > 0 && connected === gateways.length ? "connected" : connected > 0 ? "reconnecting" : gateways.some((gateway) => gateway.connection.state === "error") ? "error" : "connecting";
  node.className = `connection ${status}`;
  const failure = gateways.find((gateway) => gateway.connection.error);
  node.textContent = `${connected}/${gateways.length} gateways connected${failure ? ` · ${failure.name}: ${failure.connection.error}` : ""}`;
}

function renderDetail(): void {
  const session = state?.sessions[selected];
  empty.hidden = Boolean(session);
  detailContent.hidden = !session;
  if (!session) return;
  get("detail-title").textContent = session.title;
  const stateNode = get("detail-state");
  stateNode.className = `state ${session.state}`;
  stateNode.textContent = session.state;
  const facts = get("facts");
  facts.replaceChildren();
  const agent = state?.agents[session.agentId];
  const runtime = session.agentRuntime ?? agent?.agentRuntime;
  addFact(facts, "gateway", state?.gateways[session.gatewayId]?.name ?? session.gatewayId);
  addFact(facts, "agent", agent?.name ?? session.agentId);
  addFact(facts, "session", session.sourceKey);
  addFact(facts, "model", session.model);
  addFact(facts, "model provider", session.modelProvider);
  addFact(facts, "agent runtime / harness", runtime ? `${runtime.id} · source ${runtime.source}` : undefined);
  addFact(facts, "runtime fallback", runtime?.fallback);
  addFact(facts, "cloud placement", support(runtime?.cloudPlacementSupported, runtime?.cloudPlacementExecutionMode));
  addFact(facts, "device placement", support(runtime?.devicePlacementSupported, runtime?.devicePlacement ? runtime.devicePlacement.consumesWorkerSlot ? "uses worker slot" : "no worker slot" : undefined));
  addFact(facts, "placement state", session.placement?.state);
  addFact(facts, "placement provider", session.placement?.providerId);
  addFact(facts, "placement profile", session.placement?.profileId);
  addFact(facts, "machine", machine(session.placement?.machine));
  addFact(facts, "runner / device", session.placement?.runner ? `${session.placement.runner.status}${session.placement.runner.deviceId ? ` · ${session.placement.runner.deviceId}` : ""}` : undefined);
  addFact(facts, "runtime status", session.status);
  addFact(facts, "last signal", session.lastSignalAt || session.updatedAt ? relative(session.lastSignalAt ?? session.updatedAt) : undefined);
  const progress = get("progress") as HTMLElement;
  progress.hidden = !session.progress;
  progress.replaceChildren();
  if (session.progress) {
    const percent = session.progress.total ? Math.round((session.progress.completed / session.progress.total) * 100) : 0;
    const headline = element("div", "progress-head");
    headline.append(text(`current work`, "progress-kicker"), text(`${session.progress.completed}/${session.progress.total}`, "progress-count"));
    const bar = element("div", "progress-track");
    const fill = element("span", "progress-fill");
    fill.style.width = `${percent}%`;
    bar.append(fill);
    progress.append(headline);
    if (session.progress.step) progress.append(text(session.progress.step, "progress-step"));
    progress.append(bar, text(`updated ${relative(session.progress.updatedAt)} · revision ${session.progress.revision}`, "progress-meta", "small"));
  }
  renderActivity(session.activity);
  renderTimes();
}

function renderActivity(items: Activity[]): void {
  const tools = items.filter((item) => item.kind === "tool").length;
  get("activity-summary").textContent = items.length ? `${items.length} signals · ${tools} tool action${tools === 1 ? "" : "s"}` : "waiting for activity";
  const current = get("current-activity") as HTMLElement;
  current.hidden = items.length === 0;
  current.replaceChildren();
  const latest = items[0];
  if (latest) {
    const concrete = latest.kind === "agent" && latest.label === "thinking" ? items.find((item) => (item.kind === "tool" || item.kind === "progress") && item.runId === latest.runId && latest.at - item.at <= 60_000) : undefined;
    const head = element("div", "current-activity-head");
    const age = text(relative(latest.at), "current-activity-age");
    age.dataset.at = String(latest.at);
    head.append(text("Latest signal", "current-activity-kicker"), age);
    current.append(head, text(activityLabel(latest), "current-activity-title"));
    const detail = latest.detail ?? (concrete ? `Latest concrete action: ${concrete.detail ?? activityLabel(concrete)}` : activityDescription(latest));
    if (detail) current.append(text(detail, "current-activity-detail", "code"));
  }
  const events = get("events");
  events.replaceChildren(...(items.length ? activityRows(items).map(renderEvent) : [text("No sanitized live activity received in this process.", "empty-row", "li")]));
}

function activityRows(items: Activity[]): ActivityView[] {
  const rows: ActivityView[] = [];
  const repeated = new Map<string, ActivityView>();
  for (const item of items) {
    const canGroup = !item.detail && (item.kind === "agent" || item.kind === "session");
    const key = canGroup ? `${item.runId ?? ""}:${item.kind}:${item.label}:${item.status ?? ""}` : "";
    const current = key ? repeated.get(key) : undefined;
    if (current) {
      current.repeats = (current.repeats ?? 1) + 1;
      current.oldestAt = item.at;
    } else {
      const row: ActivityView = { ...item };
      rows.push(row);
      if (key) repeated.set(key, row);
    }
  }
  return rows;
}

function renderEvent(item: ActivityView): HTMLElement {
  const row = element("li", `event ${item.kind}`);
  const time = element("span", "event-time");
  const absolute = text(clock(item.at), "", "time");
  absolute.setAttribute("datetime", new Date(item.at).toISOString());
  const age = text(relative(item.at), "event-age");
  age.dataset.at = String(item.at);
  time.append(absolute, age);
  const content = element("span", "event-content");
  content.append(text(activityLabel(item), "event-label"));
  const description = item.detail ?? activityDescription(item);
  const detail = item.repeats && item.repeats > 1 ? `${item.repeats} similar signals over ${duration(item.at - (item.oldestAt ?? item.at))}${description ? ` · ${description}` : ""}` : description;
  if (detail) content.append(text(detail, "event-detail", "code"));
  const meta = element("span", "event-meta");
  if (item.status) meta.append(text(item.status, "event-status"));
  if (item.runId) meta.append(text(`run ${item.runId.slice(0, 8)}`, "event-run"));
  row.append(time, text(item.kind, "event-kind"), content, meta);
  return row;
}

function activityLabel(item: Activity): string {
  if (item.kind === "tool") return item.status === "running" || item.status === "start" ? `Running ${item.label}` : item.status === "result" || item.status === "completed" ? `${item.label} completed` : item.label;
  if (item.kind === "progress") return "Progress updated";
  if (item.kind === "session" && item.label === "message") return item.status === "running" ? "Processing message" : "Message activity";
  const labels: Record<string, string> = {
    start: "Response started",
    thinking: "Model working",
    finishing: "Finishing response",
    final_answer: "Composing final answer",
    end: "Response finished",
    usage: "Usage updated"
  };
  return labels[item.label] ?? item.label.replaceAll("_", " ");
}

function activityDescription(item: Activity): string | undefined {
  if (item.kind === "agent" && item.label === "thinking") return "Reasoning is active; private reasoning content is not exposed.";
  if (item.kind === "session" && item.label === "message") return "The session is handling the current message.";
  if (item.kind === "agent" && item.label === "usage") return "Usage counters changed for this run.";
  if (item.kind === "agent") return `Agent lifecycle signal${item.status ? ` · ${item.status}` : ""}.`;
  if (item.kind === "tool") return `Tool activity${item.status ? ` · ${item.status}` : ""}.`;
  return undefined;
}
function renderTimes(): void {
  const session = state?.sessions[selected];
  if (session) get("elapsed").textContent = session.state === "active" && session.activeSince ? `elapsed ${duration(Date.now() - session.activeSince)}` : `last ${relative(session.lastSignalAt ?? session.updatedAt)}`;
  document.querySelectorAll<HTMLElement>(".session[data-key]").forEach((node) => {
    const item = state?.sessions[node.dataset.key ?? ""];
    const age = node.querySelector<HTMLElement>(".session-age");
    if (age && item) age.textContent = relative(item.lastSignalAt ?? item.updatedAt);
  });
  document.querySelectorAll<HTMLElement>(".gateway-since[data-gateway]").forEach((node) => {
    const gateway = state?.gateways[node.dataset.gateway ?? ""];
    if (gateway) node.textContent = `${gateway.connection.state} ${relative(gateway.connection.since)}`;
  });
  document.querySelectorAll<HTMLElement>(".event-age[data-at], .current-activity-age[data-at]").forEach((node) => {
    const at = Number(node.dataset.at);
    if (Number.isFinite(at)) node.textContent = relative(at);
  });
  if (state) get("metric-updated").textContent = relative(state.updatedAt);
}
function initialSelection(value: State): string { return sortSessions(Object.values(value.sessions))[0]?.key ?? ""; }
function sortSessions(items: Session[]): Session[] {
  const rank: Record<ActivityState, number> = { active: 0, unknown: 1, idle: 2 };
  return [...items].sort((a, b) => rank[a.state] - rank[b.state] || (b.lastSignalAt ?? b.updatedAt ?? 0) - (a.lastSignalAt ?? a.updatedAt ?? 0) || a.title.localeCompare(b.title));
}
function relative(at?: number): string {
  if (!at) return "never";
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  return seconds < 2 ? "now" : `${duration(seconds * 1000)} ago`;
}
function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
function clock(at: number): string { return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function support(value: boolean | undefined, detail?: string): string | undefined { return value === undefined ? undefined : `${value ? "supported" : "not supported"}${detail ? ` · ${detail}` : ""}`; }
function machine(value: Placement["machine"]): string | undefined {
  if (!value) return undefined;
  return [value.class, value.osLabel ?? value.os].filter(Boolean).join(" · ") || undefined;
}
function addFact(parent: HTMLElement, label: string, value: string | undefined): void { if (value) parent.append(text(label, "", "dt"), text(value, "", "dd")); }
function get(id: string): HTMLElement { const node = document.getElementById(id); if (!node) throw new Error(`missing #${id}`); return node; }
function element(tag: string, className = ""): HTMLElement { const node = document.createElement(tag); if (className) node.className = className; return node; }
function text(value: string, className = "", tag = "span"): HTMLElement { const node = element(tag, className); node.textContent = value; return node; }
