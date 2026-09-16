type ActivityState = "active" | "idle" | "unknown";
type Activity = { id: string; at: number; kind: string; label: string; detail?: string; status?: string; runId?: string };
type ActivityView = Activity & { repeats?: number; oldestAt?: number };
type WorkNote = { text: string; meta: string; at: number; priority: number };
type StableWorkNote = { shown: WorkNote; shownSince: number; pending?: { note: WorkNote; since: number } };
type Gateway = { id: string; name: string; host?: string; totalSessions?: number; activeSessions?: number; inactiveSessionsShown?: number; inactiveHistoryTruncated?: boolean; omittedInactiveSessions?: number; connection: { state: string; since: number; error?: string; serverVersion?: string } };
type Runtime = { id: string; source: string; fallback?: string; cloudPlacementSupported?: boolean; cloudPlacementExecutionMode?: string; devicePlacementSupported?: boolean; devicePlacement?: { consumesWorkerSlot: boolean } };
type Placement = { state: string; providerId?: string; profileId?: string; machine?: { class?: string; os?: string; osLabel?: string }; runner?: { kind: "device"; status: "available" | "offline"; deviceId?: string } };
type Progress = { revision: number; updatedAt: number; completed: number; total: number; step?: string; stepStatus?: "in_progress" | "pending" };
type Session = { key: string; historyId?: string; sourceKey: string; gatewayId: string; sessionId?: string; agentId: string; title: string; kind: string; channel?: string; parentSessionKey?: string; childSessions: string[]; state: ActivityState; lifecycleSince: number; activeSince?: number; updatedAt?: number; lastSignalAt?: number; model?: string; modelProvider?: string; agentRuntime?: Runtime; placement?: Placement; status?: string; progress?: Progress; activity: Activity[] };
type Agent = { id: string; sourceId: string; gatewayId: string; name: string; emoji?: string; model?: string; agentRuntime?: Runtime };
type State = { mode: "demo" | "live"; gateways: Record<string, Gateway>; agents: Record<string, Agent>; sessions: Record<string, Session>; updatedAt: number };

let state: State | undefined;
let selected = "";
let focusedSession: Session | undefined;
let browserConnected = false;
let renderedWorkNotes = new Map<string, WorkNote | undefined>();
let noteRefreshTimer: number | undefined;
let noteRefreshAt = 0;
const stableWorkNotes = new Map<string, StableWorkNote>();
const expandedGateways = new Set<string>();
const collapsedParents = new Set<string>();
type MobilePane = "fleet" | "session";
let mobilePane: MobilePane = "fleet";
const mobileQuery = window.matchMedia("(max-width: 700px)");
const workspaceNode = document.querySelector("main");
if (!(workspaceNode instanceof HTMLElement)) throw new Error("missing workspace");
const workspace: HTMLElement = workspaceNode;
const tree = get("tree");
const detailContent = get("detail-content") as HTMLElement;
const empty = get("empty") as HTMLElement;
const source = new EventSource("/api/events");

source.addEventListener("state", (event) => {
  state = JSON.parse((event as MessageEvent<string>).data) as State;
  browserConnected = true;
  if (!selected) {
    selected = initialSelection(state);
  }
  if (state.sessions[selected]) focusedSession = state.sessions[selected];
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
  const liveAgentCount = agents.length;
  const sessions = Object.values(state.sessions);
  const active = sessions.filter((session) => session.state === "active").length;
  const connected = gateways.filter((gateway) => gateway.connection.state === "connected").length;
  const hidden = gateways.reduce((sum, gateway) => sum + (gateway.omittedInactiveSessions ?? 0), 0);
  renderedWorkNotes = new Map();
  const sessionKeys = new Set(sessions.map(noteCacheKey));
  for (const key of stableWorkNotes.keys()) if (!sessionKeys.has(key)) stableWorkNotes.delete(key);
  get("metric-gateways").textContent = `${connected}/${gateways.length}`;
  get("metric-agents").textContent = String(liveAgentCount);
  get("metric-sessions").textContent = String(sessions.length);
  get("metric-active").textContent = String(active);
  get("metric-updated").textContent = relative(state.updatedAt);
  get("counts").textContent = `${sessions.length} shown${hidden ? ` · ${hidden} inactive hidden` : ""}`;
  renderConnection();
  const visibleGateways = [...gateways];
  for (const session of sessions) if (!visibleGateways.some((gateway) => gateway.id === session.gatewayId)) visibleGateways.push({ id: session.gatewayId, name: session.gatewayId, connection: { state: "offline", since: 0 } });
  tree.replaceChildren(...visibleGateways.sort((a, b) => a.name.localeCompare(b.name)).map((gateway) => renderGateway(
    gateway,
    agents.filter((agent) => agent.gatewayId === gateway.id),
    sessions.filter((session) => session.gatewayId === gateway.id)
  )));
  renderDetail();
  syncMobileNavigation();
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

  const active = sessions.filter((session) => session.state === "active").length;
  const activeFocus = active === 1 ? sessions.find((session) => session.state === "active") : undefined;
  const focus = activeFocus ?? sortSessions(sessions).find((session) => Boolean(workNoteCandidate(session)));
  const note = focus ? workNote(focus) : undefined;
  const focusText = active > 1 ? `${active} sessions working` : note?.text ?? focus?.title ?? "No recent work";
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

  const now = element("span", `gateway-now${activeFocus ? " live" : ""}`);
  now.append(text(activeFocus ? "now" : note ? "last" : "status", "gateway-now-label"), text(focusText, "gateway-now-text"));
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
  const children = new Set(session.childSessions);
  for (const item of byKey.values()) if (item.parentSessionKey === session.key) children.add(item.key);
  children.delete(session.key);
  const childItems = sortSessions([...children].map((key) => byKey.get(key)).filter((item): item is Session => Boolean(item && !seen.has(item.key))));
  const wrapper = element("div", "session-row");
  wrapper.style.setProperty("--depth", String(Math.min(depth, 6)));
  if (childItems.length) {
    const disclosure = document.createElement("button");
    const expanded = !collapsedParents.has(session.key);
    disclosure.type = "button";
    disclosure.className = `session-disclosure${expanded ? " open" : ""}`;
    disclosure.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} child sessions for ${session.title}`);
    disclosure.setAttribute("aria-expanded", String(expanded));
    disclosure.setAttribute("aria-controls", `children-${domId(session.key)}`);
    disclosure.addEventListener("click", () => { if (expanded) collapsedParents.add(session.key); else collapsedParents.delete(session.key); render(); });
    wrapper.append(disclosure);
  } else wrapper.append(text("", "session-disclosure-spacer"));
  const button = document.createElement("button");
  button.type = "button";
  button.className = `session${selected === session.key ? " selected" : ""}`;
  button.setAttribute("aria-pressed", String(selected === session.key));
  button.dataset.key = session.key;
  button.addEventListener("click", () => {
    selected = session.key;
    focusedSession = session;
    eventBoundaryConsumed = false;
    get("events").scrollTop = 0;
    render();
    setMobilePane("session", true);
  });
  button.append(text("", `dot ${session.state}`));
  const label = element("span", "session-title");
  const note = workNote(session);
  label.append(text(session.title), text(note?.text ?? `${session.kind}${session.channel ? ` · ${session.channel}` : ""}`, "session-meta"));
  button.append(label, text(relative(session.lastSignalAt ?? session.updatedAt), "session-age"));
  wrapper.append(button);
  parent.append(wrapper);
  const childGroup = element("div", "session-children");
  childGroup.id = `children-${domId(session.key)}`;
  childGroup.hidden = collapsedParents.has(session.key);
  for (const child of childItems) appendSession(childGroup, child, byKey, seen, depth + 1);
  if (childItems.length) parent.append(childGroup);
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
  const session = state?.sessions[selected] ?? focusedSession;
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
  addFact(facts, "gateway", state?.gateways[session.gatewayId]?.name ?? session.gatewayId);
  addFact(facts, "agent", agent?.name ?? session.agentId);
  addFact(facts, "model", modelSummary(session.model, session.modelProvider));
  addFact(facts, "execution", executionSummary(session.placement));
  addFact(facts, "runtime status", session.status);
  addFact(facts, "last signal", session.lastSignalAt || session.updatedAt ? relative(session.lastSignalAt ?? session.updatedAt) : undefined);
  const progress = get("progress") as HTMLElement;
  const note = workNote(session);
  progress.hidden = !session.progress && !note;
  progress.replaceChildren();
  if (session.progress || note) {
    const headline = element("div", "progress-head");
    headline.append(text(session.state === "active" ? "current work" : "last work", "progress-kicker"));
    if (session.progress) headline.append(text(`${session.progress.completed}/${session.progress.total}`, "progress-count"));
    progress.append(headline);
    if (note) progress.append(text(note.text, "progress-step"));
    if (session.progress) {
      const percent = session.progress.total ? Math.round((session.progress.completed / session.progress.total) * 100) : 0;
      const bar = element("div", "progress-track");
      const fill = element("span", "progress-fill");
      fill.style.width = `${percent}%`;
      bar.append(fill);
      progress.append(bar);
    }
    const meta = [note?.meta, note ? relative(note.at) : undefined, session.progress ? `revision ${session.progress.revision}` : undefined].filter(Boolean).join(" · ");
    if (meta) progress.append(text(meta, "progress-meta", "small"));
  }
  const loaded = loadedEvents.get(session.key) ?? [];
  const activity = [...new Map([...session.activity, ...loaded].map((item) => [item.id, item])).values()].sort((a, b) => b.at - a.at);
  showPageState("event-page-state", eventEnded.has(session.key) ? "Start of recorded activity" : undefined);
  renderActivity(activity);
  renderTimes();
}

function renderActivity(items: Activity[]): void {
  const tools = items.filter((item) => item.kind === "tool").length;
  get("activity-summary").textContent = items.length ? `${items.length} signals · ${tools} tool action${tools === 1 ? "" : "s"}` : "waiting for activity";
  const events = get("events");
  events.replaceChildren(...(items.length ? activityRows(items).map(renderEvent) : [text("No sanitized live activity received in this process.", "empty-row", "li")]));
}

function activityRows(items: Activity[]): ActivityView[] {
  const rows: ActivityView[] = [];
  const repeated = new Map<string, ActivityView>();
  const lifecycle = new Set(["start", "finishing", "end"]);
  for (let index = 0; index < items.length; index += 1) {
    let item = items[index]!;
    if (item.kind === "agent" && lifecycle.has(item.label) && item.runId) {
      const phases = [item];
      while (items[index + 1]?.kind === "agent" && lifecycle.has(items[index + 1]!.label) && items[index + 1]!.runId === item.runId) phases.push(items[++index]!);
      item = phases.find((phase) => phase.label === "end") ?? phases.find((phase) => phase.label === "finishing") ?? item;
    }
    const canGroup = !item.detail && (item.kind === "agent" || item.kind === "session") && !(item.kind === "agent" && lifecycle.has(item.label) && !item.runId);
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
  const label = activityLabel(item);
  const description = activityDescription(item);
  const repeated = item.repeats && item.repeats > 1 ? `${item.repeats} similar signals over ${duration(item.at - (item.oldestAt ?? item.at))}` : undefined;
  const primary = item.detail ?? label;
  const secondary = item.detail ? [label, repeated].filter(Boolean).join(" · ") : [repeated, description].filter(Boolean).join(" · ");
  content.append(text(primary, "event-label", item.detail ? "code" : "span"));
  if (secondary) content.append(text(secondary, "event-detail"));
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
    end: "Response completed",
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

function workNote(session: Session): WorkNote | undefined {
  const key = noteCacheKey(session);
  if (renderedWorkNotes.has(key)) return renderedWorkNotes.get(key);
  const candidate = workNoteCandidate(session);
  const now = Date.now();
  const stable = stableWorkNotes.get(key);
  if (!candidate) {
    const shown = stable?.shown;
    renderedWorkNotes.set(key, shown);
    return shown;
  }
  if (!stable) {
    stableWorkNotes.set(key, { shown: candidate, shownSince: now });
    renderedWorkNotes.set(key, candidate);
    return candidate;
  }
  if (stable.shown.text === candidate.text) {
    stable.shown = candidate;
    stable.pending = undefined;
    renderedWorkNotes.set(key, candidate);
    return candidate;
  }
  const immediate = candidate.priority >= 5;
  if (immediate) {
    stable.shown = candidate;
    stable.shownSince = now;
    stable.pending = undefined;
  } else {
    if (stable.pending?.note.text !== candidate.text) stable.pending = { note: candidate, since: now };
    else stable.pending.note = candidate;
    const due = Math.max(stable.shownSince + 5_000, stable.pending.since + 2_000);
    if (now >= due) {
      stable.shown = stable.pending.note;
      stable.shownSince = now;
      stable.pending = undefined;
    } else scheduleNoteRefresh(due);
  }
  renderedWorkNotes.set(key, stable.shown);
  return stable.shown;
}

function workNoteCandidate(session: Session): WorkNote | undefined {
  const item = session.activity.find((activity) => activity.label === "error" || activity.status === "error" || activity.kind === "tool" || (activity.kind === "progress" && Boolean(activity.detail)) || (activity.kind === "agent" && activity.label === "final_answer"));
  if (session.progress?.step && session.progress.updatedAt >= (item?.at ?? 0)) {
    return { text: session.progress.step, meta: `progress · ${session.progress.completed}/${session.progress.total}`, at: session.progress.updatedAt, priority: 4 };
  }
  if (item) {
    const status = item.status ? ` · ${item.status}` : "";
    return { text: item.detail ?? activityLabel(item), meta: `${item.kind} · ${activityLabel(item)}${status}`, at: item.at, priority: item.label === "error" || item.status === "error" ? 5 : 3 };
  }
  if (session.state === "active") return { text: "Model working", meta: "agent · active", at: session.lastSignalAt ?? session.updatedAt ?? Date.now(), priority: 1 };
  return undefined;
}

function noteCacheKey(session: Session): string { return `${session.key}\u0000${session.lifecycleSince}`; }
function scheduleNoteRefresh(at: number): void {
  if (noteRefreshTimer !== undefined && noteRefreshAt <= at) return;
  if (noteRefreshTimer !== undefined) window.clearTimeout(noteRefreshTimer);
  noteRefreshAt = at;
  noteRefreshTimer = window.setTimeout(() => {
    noteRefreshTimer = undefined;
    noteRefreshAt = 0;
    if (state) render();
  }, Math.max(0, at - Date.now()));
}

function renderTimes(): void {
  const session = state?.sessions[selected] ?? focusedSession;
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
  document.querySelectorAll<HTMLElement>(".event-age[data-at]").forEach((node) => {
    const at = Number(node.dataset.at);
    if (Number.isFinite(at)) node.textContent = relative(at);
  });
  if (state) get("metric-updated").textContent = relative(state.updatedAt);
}
function initialSelection(value: State): string { return sortSessions(Object.values(value.sessions))[0]?.key ?? ""; }
function sortSessions(items: Session[]): Session[] {
  const rank: Record<ActivityState, number> = { active: 0, unknown: 1, idle: 2 };
  return [...items].sort((a, b) => rank[a.state] - rank[b.state]
    || (a.state === "active" && b.state === "active" ? (a.activeSince ?? a.lifecycleSince) - (b.activeSince ?? b.lifecycleSince) : (b.lastSignalAt ?? b.updatedAt ?? 0) - (a.lastSignalAt ?? a.updatedAt ?? 0))
    || a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
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
function modelSummary(model?: string, provider?: string): string | undefined {
  const providerLabel = provider === "openai" ? "OpenAI" : provider === "anthropic" ? "Anthropic" : provider;
  if (!model) return providerLabel;
  const name = provider && model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
  return providerLabel ? `${name} · ${providerLabel}` : name;
}
function executionSummary(placement?: Placement): string | undefined {
  if (!placement || placement.state === "local" || placement.state === "requested") return undefined;
  const target = placement.runner?.deviceId ?? placement.profileId ?? placement.providerId;
  const host = [target, machine(placement.machine)].filter(Boolean).join(" · ");
  return `${placement.runner ? "device" : placement.state}${host ? ` · ${host}` : ""}${placement.runner ? ` · ${placement.runner.status}` : ""}`;
}
function machine(value: Placement["machine"]): string | undefined {
  if (!value) return undefined;
  return [value.class, value.osLabel ?? value.os].filter(Boolean).join(" · ") || undefined;
}
function addFact(parent: HTMLElement, label: string, value: string | undefined): void { if (value) parent.append(text(label, "", "dt"), text(value, "", "dd")); }
function domId(value: string): string { return [...value].map((character) => /[a-z0-9_-]/iu.test(character) ? character : `-${character.codePointAt(0)?.toString(16)}`).join(""); }
function get(id: string): HTMLElement { const node = document.getElementById(id); if (!node) throw new Error(`missing #${id}`); return node; }
function element(tag: string, className = ""): HTMLElement { const node = document.createElement(tag); if (className) node.className = className; return node; }
function text(value: string, className = "", tag = "span"): HTMLElement { const node = element(tag, className); node.textContent = value; return node; }

type BrowserGatewaySetting = { id: string; originalId: string; name: string; host?: string; url: string; auth: { method: "none" | "token" | "password" | "bootstrapToken"; configured: boolean } };
type BrowserSettings = { settings: { inactiveSessionLimit: number; inactiveAgeDays: number | "all" }; gateways: BrowserGatewaySetting[]; configError?: string };
const loadedEvents = new Map<string, Activity[]>();
const eventLoading = new Set<string>();
const eventEnded = new Set<string>();
const eventCursors = new Map<string, string>();
let eventBoundaryConsumed = false;
const settingsDialog = get("settings-dialog") as HTMLDialogElement;
get("settings-open").addEventListener("click", () => { void openSettings(); });
get("settings-close").addEventListener("click", () => settingsDialog.close());
get("settings-cancel").addEventListener("click", () => settingsDialog.close());
get("gateway-add").addEventListener("click", () => appendGatewayForm());
get("mobile-fleet").addEventListener("click", () => setMobilePane("fleet", true));
get("mobile-session").addEventListener("click", () => setMobilePane("session", true));
document.querySelector(".skip")?.addEventListener("click", (event) => {
  if (!mobileQuery.matches) return;
  event.preventDefault();
  reconcileMobileBreakpoint();
  setMobilePane(mobilePane, true);
});
mobileQuery.addEventListener("change", reconcileMobileBreakpoint);
get("events").addEventListener("scroll", () => {
  const events = get("events");
  if (!nearEnd(events)) eventBoundaryConsumed = false;
  else if (!eventBoundaryConsumed) { eventBoundaryConsumed = true; void loadOlderEvents(); }
});
const settingsForm = get("settings-form");
settingsForm.addEventListener("invalid", (event) => { (event.target as HTMLElement).closest<HTMLDetailsElement>("details.gateway-form")?.setAttribute("open", ""); }, true);
settingsForm.addEventListener("submit", (event) => { event.preventDefault(); void saveSettings(); });

async function openSettings(): Promise<void> {
  const response = await fetch("/api/settings");
  const value = await response.json() as BrowserSettings & { error?: string };
  if (!response.ok) return showSettingsError(value.error ?? "Unable to load settings");
  (get("inactive-limit") as HTMLInputElement).value = String(value.settings.inactiveSessionLimit);
  (get("inactive-age") as HTMLSelectElement).value = String(value.settings.inactiveAgeDays);
  const forms = get("gateway-forms"); forms.replaceChildren();
  for (const gateway of value.gateways) appendGatewayForm(gateway);
  showSettingsError(value.configError);
  settingsDialog.showModal();
}
function appendGatewayForm(gateway?: BrowserGatewaySetting): void {
  const template = get("gateway-template") as HTMLTemplateElement;
  const form = template.content.firstElementChild?.cloneNode(true) as HTMLDetailsElement;
  const field = (name: string) => form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)!;
  for (const name of ["id", "name", "host", "url"] as const) field(name).value = gateway?.[name] ?? "";
  field("authMethod").value = gateway?.auth.method ?? "none";
  const secret = field("secret") as HTMLInputElement;
  secret.placeholder = gateway?.auth.configured ? "Configured; leave blank to preserve" : "Write-only replacement";
  form.dataset.authMethod = gateway?.auth.method ?? "none";
  form.dataset.originalId = gateway?.originalId ?? "";
  form.open = !gateway;
  const updateSummary = () => {
    const name = field("name").value.trim();
    const id = field("id").value.trim();
    const route = field("host").value.trim() || field("url").value.trim();
    form.querySelector(".gateway-summary-name")!.textContent = name || id || "New Gateway";
    form.querySelector(".gateway-summary-meta")!.textContent = [name && id, route].filter(Boolean).join(" · ");
  };
  for (const name of ["id", "name", "host", "url"]) field(name).addEventListener("input", updateSummary);
  updateSummary();
  form.querySelector(".gateway-remove")?.addEventListener("click", () => form.remove());
  get("gateway-forms").append(form);
}
async function saveSettings(): Promise<void> {
  const forms = [...get("gateway-forms").querySelectorAll<HTMLDetailsElement>(".gateway-form")];
  const gateways = forms.map((form) => {
    const field = (name: string) => form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)!.value.trim();
    const method = field("authMethod");
    const secret = field("secret");
    const clear = form.querySelector<HTMLInputElement>("[name=clearSecret]")!.checked;
    const action = clear ? "clear" : secret ? "replace" : "preserve";
    return { id: field("id"), originalId: form.dataset.originalId || undefined, name: field("name"), host: field("host"), url: field("url"), auth: { method: clear ? "none" : method, action, value: secret || undefined } };
  });
  const inactiveAge = (get("inactive-age") as HTMLSelectElement).value;
  const body = { settings: { inactiveSessionLimit: Number((get("inactive-limit") as HTMLInputElement).value), inactiveAgeDays: inactiveAge === "all" ? "all" : Number(inactiveAge) }, gateways };
  const response = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json() as { error?: string };
  if (!response.ok) return showSettingsError(value.error ?? "Unable to save settings");
  settingsDialog.close();
}
function showSettingsError(message?: string): void { const node = get("settings-error"); node.hidden = !message; node.textContent = message ?? ""; }
function selectedSession(): Session | undefined {
  return state?.sessions[selected] ?? focusedSession;
}
function syncMobileNavigation(): void {
  const available = Boolean(selectedSession());
  if (!available && mobilePane === "session") mobilePane = "fleet";
  workspace.dataset.mobilePane = mobilePane;
  const fleet = get("mobile-fleet") as HTMLButtonElement;
  const session = get("mobile-session") as HTMLButtonElement;
  fleet.setAttribute("aria-pressed", String(mobilePane === "fleet"));
  session.setAttribute("aria-pressed", String(mobilePane === "session"));
  if (mobilePane === "fleet") {
    fleet.setAttribute("aria-current", "page");
    session.removeAttribute("aria-current");
  } else {
    session.setAttribute("aria-current", "page");
    fleet.removeAttribute("aria-current");
  }
  session.disabled = !available;
  session.setAttribute("aria-label", available ? "Show selected session" : "Session unavailable; select a session from Fleet");
  if (!mobileQuery.matches) return;
  const hiddenPane = get(mobilePane === "fleet" ? "detail" : "fleet");
  if (document.activeElement instanceof HTMLElement && hiddenPane.contains(document.activeElement)) {
    window.requestAnimationFrame(() => {
      if (!mobileQuery.matches) return;
      const hidden = get(mobilePane === "fleet" ? "detail" : "fleet");
      if (document.activeElement instanceof HTMLElement && hidden.contains(document.activeElement)) get(mobilePane === "fleet" ? "fleet" : "detail").focus({ preventScroll: true });
    });
  }
}
function reconcileMobileBreakpoint(): void {
  if (!mobileQuery.matches) return;
  const active = document.activeElement;
  const fleet = get("fleet");
  const detail = get("detail");
  const available = Boolean(selectedSession());
  if (fleet.contains(active)) mobilePane = "fleet";
  else if (available && detail.contains(active)) mobilePane = "session";
  else if (mobilePane === "session" && !available) mobilePane = "fleet";
  syncMobileNavigation();
}
function setMobilePane(next: MobilePane, moveFocus: boolean): void {
  if (next === "session" && !selectedSession()) return;
  mobilePane = next;
  syncMobileNavigation();
  if (!moveFocus || !mobileQuery.matches) return;
  window.requestAnimationFrame(() => { if (mobileQuery.matches) get(next === "fleet" ? "fleet" : "detail").focus({ preventScroll: true }); });
}
function nearEnd(node: HTMLElement): boolean { return node.scrollHeight - node.scrollTop - node.clientHeight < 180; }
function showPageState(id: string, message?: string): void { const node = get(id); node.hidden = !message; node.textContent = message ?? ""; }
async function loadOlderEvents(): Promise<void> {
  const session = state?.sessions[selected] ?? focusedSession;
  if (!session || eventLoading.has(session.key) || eventEnded.has(session.key)) return;
  eventLoading.add(session.key);
  showPageState("event-page-state", "Loading earlier activity…");
  const query = new URLSearchParams({ historyId: session.historyId ?? session.key, limit: "40" });
  const cursor = eventCursors.get(session.key) ?? cursorAfter(session.activity);
  if (cursor) query.set("cursor", cursor);
  try {
    const response = await fetch(`/api/history/events?${query}`);
    if (!response.ok) return showPageState("event-page-state", "Earlier activity could not be loaded.");
    const page = await response.json() as { events: Activity[]; nextCursor?: string };
    loadedEvents.set(session.key, [...(loadedEvents.get(session.key) ?? []), ...page.events]);
    if (page.nextCursor) eventCursors.set(session.key, page.nextCursor);
    else eventEnded.add(session.key);
    showPageState("event-page-state", page.nextCursor ? undefined : "Start of recorded activity");
    renderDetail();
  } catch { showPageState("event-page-state", "Earlier activity could not be loaded."); }
  finally { eventLoading.delete(session.key); }
}
function cursorAfter(events: Activity[]): string | undefined {
  const last = [...events].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).at(-1);
  if (!last) return undefined;
  const bytes = new TextEncoder().encode(JSON.stringify([last.at, last.id]));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
