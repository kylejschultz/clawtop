import { createReadStream, existsSync, statSync, watch } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { createAdapter } from "./adapters.js";
import { applyGatewayUpdate, atomicWriteJson, loadConfig, maskGateways, parseGateways, parseSettings, type AppSettings, type GatewayConfig } from "./config.js";
import { HistoryStore } from "./history.js";
import { validBasicAuthorization } from "./http-auth.js";
import { SseBroadcaster } from "./sse.js";
import { DashboardStore } from "./store.js";

const config = loadConfig();
let gateways: GatewayConfig[] = config.gateways;
let settings: AppSettings = config.settings;
let configError: string | undefined;
let updateQueue = Promise.resolve();
const history = new HistoryStore(config.historyFile);
const store = new DashboardStore(config.mode, history);
const adapter = createAdapter(config, store.dispatch, () => settings);
const events = new SseBroadcaster<ReturnType<DashboardStore["get"]>>(config.maxSseClients);
store.subscribe((state) => events.publish(state));
const publicDir = join(import.meta.dirname, "public");
const assets: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" }, "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" }, "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" }
};

const server = createServer((request, response) => {
  setSecurityHeaders(response);
  void route(request, response).catch((error) => reply(response, 500, JSON.stringify({ error: safeError(error) }), "application/json; charset=utf-8"));
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (!authorized(request)) return unauthorized(response);
  if (request.method === "GET" && path === "/api/state") return json(response, 200, store.get());
  if (request.method === "GET" && path === "/api/settings") return json(response, 200, { settings, gateways: maskGateways(gateways), configError });
  if (request.method === "PUT" && path === "/api/settings") {
    if (!config.httpAuth) return json(response, 403, { error: "settings writes require CLAWTOP_HTTP_PASSWORD" });
    if (!sameOrigin(request) || request.headers["content-type"]?.split(";", 1)[0] !== "application/json") return json(response, 403, { error: "same-origin application/json request required" });
    const body = record(await readJson(request));
    if (!body) return json(response, 400, { error: "request body must be an object" });
    try {
      const nextSettings = parseSettings(body.settings);
      const nextGateways = body.gateways === undefined ? gateways : applyGatewayUpdate(gateways, body.gateways);
      await serialize(async () => {
        atomicWriteJson(config.settingsFile, nextSettings);
        if (body.gateways !== undefined) atomicWriteJson(config.gatewaysFile, nextGateways);
        settings = nextSettings;
        gateways = nextGateways;
        configError = undefined;
        await adapter.update?.(gateways);
        adapter.refresh?.();
      });
      return json(response, 200, { settings, gateways: maskGateways(gateways) });
    } catch (error) { return json(response, 400, { error: safeError(error) }); }
  }
  if (request.method === "GET" && path === "/api/history/sessions") {
    const before = positive(url.searchParams.get("before"), Number.MAX_SAFE_INTEGER);
    const limit = positive(url.searchParams.get("limit"), 25);
    return json(response, 200, history.page(before, Math.min(limit, 100)));
  }
  if (request.method === "GET" && path === "/api/history/events") {
    const key = url.searchParams.get("sessionKey");
    if (!key || key.length > 500) return json(response, 400, { error: "valid sessionKey required" });
    const before = positive(url.searchParams.get("before"), Number.MAX_SAFE_INTEGER);
    const limit = Math.min(positive(url.searchParams.get("limit"), 40), 100);
    const items = history.activities(key, limit + 1, before);
    return json(response, 200, { events: items.slice(0, limit), nextBefore: items.length > limit ? items[limit - 1]?.at : undefined });
  }
  if (request.method === "GET" && path === "/api/health") {
    const state = store.get(), allGateways = Object.values(state.gateways), sessions = Object.values(state.sessions);
    const connected = allGateways.filter((gateway) => gateway.connection.state === "connected").length;
    const ok = allGateways.length > 0 && connected === allGateways.length && !configError;
    return json(response, ok ? 200 : 503, { ok, mode: config.mode, configError, counts: { gateways: allGateways.length, connectedGateways: connected, agents: Object.keys(state.agents).length, sessions: sessions.length, activeSessions: sessions.filter((session) => session.state === "active").length }, gateways: Object.fromEntries(allGateways.map((gateway) => [gateway.id, gateway.connection.state])) });
  }
  if (request.method === "GET" && path === "/api/events") { if (!events.add(response, store.get())) reply(response, 503, "event stream capacity reached", "text/plain; charset=utf-8"); return; }
  if (request.method !== "GET") return reply(response, 405, "method not allowed", "text/plain; charset=utf-8");
  const asset = assets[path];
  if (!asset) return reply(response, 404, "not found", "text/plain; charset=utf-8");
  const file = join(publicDir, asset.file);
  if (!existsSync(file) || !statSync(file).isFile()) return reply(response, 500, "asset missing", "text/plain; charset=utf-8");
  response.writeHead(200, { "content-type": asset.type, "cache-control": asset.file === "index.html" ? "no-store" : "public, max-age=300" });
  createReadStream(file).pipe(response);
}

function serialize(task: () => Promise<void>): Promise<void> { const next = updateQueue.then(task, task); updateQueue = next.catch(() => undefined); return next; }
function reloadGateways(): void {
  void serialize(async () => {
    try {
      const source = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(config.gatewaysFile, "utf8")));
      const next = parseGateways(source);
      if (JSON.stringify(next) === JSON.stringify(gateways)) return;
      await adapter.update?.(next);
      gateways = next;
      configError = undefined;
    } catch (error) { configError = `gateways.json rejected: ${safeError(error)}`.slice(0, 300); }
  });
}
let watchTimer: NodeJS.Timeout | undefined;
const watcher = config.mode === "live" ? watch(dirname(config.gatewaysFile), (_event, filename) => {
  if (filename !== "gateways.json") return;
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(reloadGateways, 100);
}) : undefined;

function authorized(request: IncomingMessage): boolean { return !config.httpAuth || validBasicAuthorization(request.headers.authorization, config.httpAuth); }
function unauthorized(response: ServerResponse): void { response.setHeader("www-authenticate", 'Basic realm="Clawtop", charset="UTF-8"'); reply(response, 401, "authentication required", "text/plain; charset=utf-8"); }
function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin || !request.headers.host) return false;
  try { return new URL(origin).host === request.headers.host && ["http:", "https:"].includes(new URL(origin).protocol); } catch { return false; }
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) { body += String(chunk); if (body.length > 256 * 1024) throw new Error("request body too large"); }
  try { return JSON.parse(body); } catch { throw new Error("request body must be valid JSON"); }
}
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function positive(value: string | null, fallback: number): number { const parsed = Number(value); return value !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }
function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+\S+/giu, "Bearer ***").slice(0, 300); }
function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("referrer-policy", "no-referrer"); response.setHeader("x-content-type-options", "nosniff"); response.setHeader("x-frame-options", "DENY");
}
function json(response: ServerResponse, status: number, value: unknown): void { reply(response, status, JSON.stringify(value), "application/json; charset=utf-8"); }
function reply(response: ServerResponse, status: number, body: string, type: string): void { if (response.headersSent) return; response.writeHead(status, { "content-type": type, "cache-control": "no-store" }); response.end(body); }

server.listen(config.port, config.host, () => { console.log(`clawtop ${config.mode} listening on ${config.host}:${config.port}`); adapter.start(); });
async function shutdown(): Promise<void> { watcher?.close(); if (watchTimer) clearTimeout(watchTimer); await adapter.stop(); history.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 2000).unref(); }
process.once("SIGINT", () => { void shutdown(); }); process.once("SIGTERM", () => { void shutdown(); });
