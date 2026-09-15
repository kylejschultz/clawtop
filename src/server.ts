import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { createAdapter } from "./adapters.js";
import { loadConfig } from "./config.js";
import { validBasicAuthorization } from "./http-auth.js";
import { SseBroadcaster } from "./sse.js";
import { DashboardStore } from "./store.js";

const config = loadConfig();
const store = new DashboardStore(config.mode);
const adapter = createAdapter(config, store.dispatch);
const events = new SseBroadcaster<ReturnType<DashboardStore["get"]>>(config.maxSseClients);
store.subscribe((state) => events.publish(state));
const publicDir = join(import.meta.dirname, "public");
const assets: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" }
};

const server = createServer((request, response) => {
  setSecurityHeaders(response);
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (!authorized(request)) return unauthorized(response);
  if (request.method !== "GET") return reply(response, 405, "method not allowed", "text/plain; charset=utf-8");
  if (path === "/api/state") return reply(response, 200, JSON.stringify(store.get()), "application/json; charset=utf-8");
  if (path === "/api/health") {
    const state = store.get();
    const gateways = Object.values(state.gateways);
    const sessions = Object.values(state.sessions);
    const connected = gateways.filter((gateway) => gateway.connection.state === "connected").length;
    const ok = gateways.length > 0 && connected === gateways.length;
    return reply(response, ok ? 200 : 503, JSON.stringify({
      ok,
      mode: config.mode,
      counts: {
        gateways: gateways.length,
        connectedGateways: connected,
        agents: Object.keys(state.agents).length,
        sessions: sessions.length,
        activeSessions: sessions.filter((session) => session.state === "active").length
      },
      gateways: Object.fromEntries(gateways.map((gateway) => [gateway.id, gateway.connection.state]))
    }), "application/json; charset=utf-8");
  }
  if (path === "/api/events") {
    if (!events.add(response, store.get())) return reply(response, 503, "event stream capacity reached", "text/plain; charset=utf-8");
    return;
  }
  const asset = assets[path];
  if (!asset) return reply(response, 404, "not found", "text/plain; charset=utf-8");
  const file = join(publicDir, asset.file);
  if (!existsSync(file) || !statSync(file).isFile()) return reply(response, 500, "asset missing", "text/plain; charset=utf-8");
  response.writeHead(200, { "content-type": asset.type, "cache-control": asset.file === "index.html" ? "no-store" : "public, max-age=300" });
  createReadStream(file).pipe(response);
});

function authorized(request: IncomingMessage): boolean {
  return !config.httpAuth || validBasicAuthorization(request.headers.authorization, config.httpAuth);
}

function unauthorized(response: ServerResponse): void {
  response.setHeader("www-authenticate", 'Basic realm="Clawtop", charset="UTF-8"');
  reply(response, 401, "authentication required", "text/plain; charset=utf-8");
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function reply(response: ServerResponse, status: number, body: string, type: string): void {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
}

server.listen(config.port, config.host, () => {
  console.log(`clawtop ${config.mode} listening on ${config.host}:${config.port}`);
  adapter.start();
});

async function shutdown(): Promise<void> {
  await adapter.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
