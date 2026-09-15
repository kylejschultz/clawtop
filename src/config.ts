import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type GatewayConfig = {
  id: string;
  name: string;
  url: string;
  token?: string;
  password?: string;
  bootstrapToken?: string;
  tlsFingerprint?: string;
};

export type Config = {
  mode: "demo" | "live";
  port: number;
  host: string;
  dataDir: string;
  httpAuth?: { username: string; password: string };
  maxSseClients: number;
  gateways: GatewayConfig[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.CLAWTOP_MODE === "live" ? "live" : env.CLAWTOP_MODE === "demo" || !env.CLAWTOP_MODE ? "demo" : fail("CLAWTOP_MODE must be demo or live");
  const port = Number(env.CLAWTOP_PORT ?? "3333");
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("CLAWTOP_PORT must be an integer from 1 to 65535");
  const maxSseClients = Number(env.CLAWTOP_MAX_SSE_CLIENTS ?? "32");
  if (!Number.isInteger(maxSseClients) || maxSseClients < 1 || maxSseClients > 1000) fail("CLAWTOP_MAX_SSE_CLIENTS must be an integer from 1 to 1000");
  const username = env.CLAWTOP_HTTP_USERNAME?.trim() || "clawtop";
  if (username.includes(":")) fail("CLAWTOP_HTTP_USERNAME must not contain a colon");
  const password = env.CLAWTOP_HTTP_PASSWORD;
  if (password !== undefined && !password.trim()) fail("CLAWTOP_HTTP_PASSWORD must not be empty");
  const allowUnauthenticated = boolean(env.CLAWTOP_ALLOW_UNAUTHENTICATED, "CLAWTOP_ALLOW_UNAUTHENTICATED");
  const gateways = mode === "live" ? loadGateways(env) : [];
  if (mode === "live" && !password && !allowUnauthenticated) fail("CLAWTOP_HTTP_PASSWORD is required in live mode unless CLAWTOP_ALLOW_UNAUTHENTICATED=true");

  return {
    mode,
    port,
    host: env.CLAWTOP_HTTP_HOST?.trim() || "0.0.0.0",
    dataDir: resolve(env.CLAWTOP_DATA_DIR?.trim() || ".data"),
    httpAuth: mode === "live" && password ? { username, password } : undefined,
    maxSseClients,
    gateways
  };
}

function loadGateways(env: NodeJS.ProcessEnv): GatewayConfig[] {
  const inline = env.CLAWTOP_GATEWAYS?.trim();
  const file = env.CLAWTOP_GATEWAYS_FILE?.trim();
  if (inline && file) fail("set only one of CLAWTOP_GATEWAYS or CLAWTOP_GATEWAYS_FILE");
  if ((inline || file) && env.OPENCLAW_GATEWAY_URL?.trim()) fail("do not combine a Gateway list with OPENCLAW_GATEWAY_URL shorthand");

  let source: unknown;
  if (file) {
    try { source = JSON.parse(readFileSync(resolve(file), "utf8")); }
    catch (error) { fail(`cannot read CLAWTOP_GATEWAYS_FILE: ${error instanceof Error ? error.message : String(error)}`); }
  } else if (inline) {
    try { source = JSON.parse(inline); }
    catch { fail("CLAWTOP_GATEWAYS must be valid JSON"); }
  } else {
    const url = env.OPENCLAW_GATEWAY_URL?.trim();
    if (!url) fail("configure CLAWTOP_GATEWAYS, CLAWTOP_GATEWAYS_FILE, or OPENCLAW_GATEWAY_URL in live mode");
    source = [{
      id: env.OPENCLAW_GATEWAY_ID,
      name: env.OPENCLAW_GATEWAY_NAME,
      url,
      token: env.OPENCLAW_GATEWAY_TOKEN,
      password: env.OPENCLAW_GATEWAY_PASSWORD,
      tlsFingerprint: env.OPENCLAW_GATEWAY_TLS_FINGERPRINT
    }];
  }

  if (!Array.isArray(source) || source.length === 0) fail("Gateway configuration must be a non-empty JSON array");
  const gateways = source.map(parseGateway);
  const ids = new Set<string>();
  for (const gateway of gateways) {
    if (ids.has(gateway.id)) fail(`Gateway ids must be unique: ${gateway.id}`);
    ids.add(gateway.id);
  }
  return gateways;
}

function parseGateway(value: unknown, index: number): GatewayConfig {
  const item = record(value);
  if (!item) fail(`Gateway ${index + 1} must be an object`);
  const id = requiredString(item.id, `Gateway ${index + 1} id`);
  const name = requiredString(item.name, `Gateway ${index + 1} name`);
  const url = requiredString(item.url, `Gateway ${name} url`);
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { fail(`Gateway ${name} url is invalid`); }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") fail(`Gateway ${name} url must use ws:// or wss://`);
  if (parsed.username || parsed.password) fail(`Gateway ${name} credentials must not be embedded in its URL`);

  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) fail(`Gateway ${name} id must match [a-z0-9][a-z0-9._-]{0,63}`);
  const fingerprint = optionalString(item.fingerprint);
  const tlsFingerprint = optionalString(item.tlsFingerprint);
  const token = optionalString(item.token);
  const password = optionalString(item.password);
  const bootstrapToken = optionalString(item.bootstrapToken);
  if (fingerprint && tlsFingerprint && fingerprint !== tlsFingerprint) fail(`Gateway ${name} must not set conflicting fingerprint and tlsFingerprint values`);
  if ([token, password, bootstrapToken].filter(Boolean).length > 1) fail(`Gateway ${name} must set at most one of token, password, or bootstrapToken`);
  return compact({
    id,
    name,
    url,
    token,
    password,
    bootstrapToken,
    tlsFingerprint: fingerprint ?? tlsFingerprint
  });
}

function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function requiredString(value: unknown, label: string): string { return optionalString(value) ?? fail(`${label} is required`); }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function boolean(value: string | undefined, label: string): boolean {
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  return fail(`${label} must be true or false`);
}
function compact<T extends object>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T; }
function fail(message: string): never { throw new Error(message); }
