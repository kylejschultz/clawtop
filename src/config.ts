import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type GatewayConfig = {
  id: string;
  name: string;
  host?: string;
  url: string;
  token?: string;
  password?: string;
  bootstrapToken?: string;
  tlsFingerprint?: string;
};
export type AppSettings = { inactiveSessionLimit: number; inactiveAgeDays: 1 | 3 | 7 | 14 | 30 | 90 | "all" };
export const DEFAULT_SETTINGS: AppSettings = { inactiveSessionLimit: 200, inactiveAgeDays: 90 };

export type Config = {
  mode: "demo" | "live";
  port: number;
  host: string;
  dataDir: string;
  gatewaysFile: string;
  settingsFile: string;
  historyFile: string;
  httpAuth?: { username: string; password: string };
  maxSseClients: number;
  gateways: GatewayConfig[];
  settings: AppSettings;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.CLAWTOP_MODE === "live" ? "live" : env.CLAWTOP_MODE === "demo" || !env.CLAWTOP_MODE ? "demo" : fail("CLAWTOP_MODE must be demo or live");
  const port = integer(env.CLAWTOP_PORT ?? "3333", 1, 65535, "CLAWTOP_PORT");
  const maxSseClients = integer(env.CLAWTOP_MAX_SSE_CLIENTS ?? "32", 1, 1000, "CLAWTOP_MAX_SSE_CLIENTS");
  const username = env.CLAWTOP_HTTP_USERNAME?.trim() || "clawtop";
  if (username.includes(":")) fail("CLAWTOP_HTTP_USERNAME must not contain a colon");
  const password = env.CLAWTOP_HTTP_PASSWORD;
  if (password !== undefined && !password.trim()) fail("CLAWTOP_HTTP_PASSWORD must not be empty");
  const allowUnauthenticated = boolean(env.CLAWTOP_ALLOW_UNAUTHENTICATED, "CLAWTOP_ALLOW_UNAUTHENTICATED");

  const dataDir = resolve(env.CLAWTOP_DATA_DIR?.trim() || ".data");
  const gatewaysFile = join(dataDir, "gateways.json");
  const settingsFile = join(dataDir, "settings.json");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let gateways: GatewayConfig[] = [];
  if (mode === "live") {
    try { gateways = parseGateways(JSON.parse(readFileSync(gatewaysFile, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      gateways = loadLegacyGateways(env);
      atomicWriteJson(gatewaysFile, gateways);
    }
  }
  if (mode === "live" && !password && !allowUnauthenticated) fail("CLAWTOP_HTTP_PASSWORD is required in live mode unless CLAWTOP_ALLOW_UNAUTHENTICATED=true");
  let settings = DEFAULT_SETTINGS;
  try { settings = parseSettings(JSON.parse(readFileSync(settingsFile, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`cannot read settings: ${safeError(error)}`);
    atomicWriteJson(settingsFile, settings);
  }
  return { mode, port, host: env.CLAWTOP_HTTP_HOST?.trim() || "0.0.0.0", dataDir, gatewaysFile, settingsFile, historyFile: join(dataDir, "history.sqlite"), httpAuth: mode === "live" && password ? { username, password } : undefined, maxSseClients, gateways, settings };
}

export function parseGateways(source: unknown): GatewayConfig[] {
  if (!Array.isArray(source)) fail("Gateway configuration must be a JSON array");
  const gateways = source.map(parseGateway);
  const ids = new Set<string>();
  for (const gateway of gateways) {
    if (ids.has(gateway.id)) fail(`Gateway ids must be unique: ${gateway.id}`);
    ids.add(gateway.id);
  }
  return gateways;
}

export function parseSettings(value: unknown): AppSettings {
  const item = record(value) ?? fail("settings must be an object");
  const inactiveSessionLimit = typeof item.inactiveSessionLimit === "number" ? item.inactiveSessionLimit : DEFAULT_SETTINGS.inactiveSessionLimit;
  if (!Number.isInteger(inactiveSessionLimit) || inactiveSessionLimit < 0 || inactiveSessionLimit > 200) fail("inactiveSessionLimit must be an integer from 0 to 200");
  const inactiveAgeDays = item.inactiveAgeDays ?? DEFAULT_SETTINGS.inactiveAgeDays;
  if (![1, 3, 7, 14, 30, 90, "all"].includes(inactiveAgeDays as never)) fail("inactiveAgeDays must be 1, 3, 7, 14, 30, 90, or all");
  return { inactiveSessionLimit, inactiveAgeDays: inactiveAgeDays as AppSettings["inactiveAgeDays"] };
}

export function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

export function maskGateways(gateways: GatewayConfig[]): unknown[] {
  return gateways.map(({ token, password, bootstrapToken, ...gateway }) => ({ ...gateway, auth: token ? { method: "token", configured: true } : password ? { method: "password", configured: true } : bootstrapToken ? { method: "bootstrapToken", configured: true } : { method: "none", configured: false } }));
}

export function applyGatewayUpdate(current: GatewayConfig[], input: unknown): GatewayConfig[] {
  if (!Array.isArray(input)) fail("gateways must be an array");
  const byId = new Map(current.map((gateway) => [gateway.id, gateway]));
  const candidate = input.map((raw, index) => {
    const item = record(raw) ?? fail(`Gateway ${index + 1} must be an object`);
    const id = optionalString(item.id) ?? "";
    const previous = byId.get(id);
    const auth = record(item.auth) ?? {};
    const method = auth.method;
    const action = auth.action ?? "preserve";
    if (!["none", "token", "password", "bootstrapToken"].includes(String(method))) fail(`Gateway ${index + 1} auth method is invalid`);
    if (!["preserve", "replace", "clear"].includes(String(action))) fail(`Gateway ${index + 1} auth action is invalid`);
    const value = optionalString(auth.value);
    let secret: Partial<GatewayConfig> = {};
    if (action === "preserve") {
      if (value) fail(`Gateway ${index + 1} replacement secret requires action replace`);
      if (previous) secret = { token: previous.token, password: previous.password, bootstrapToken: previous.bootstrapToken };
      if (method !== "none" && previous && !previous[method as "token" | "password" | "bootstrapToken"]) fail(`Gateway ${index + 1} cannot change auth method without replacement`);
    } else if (action === "replace") {
      if (method === "none" || !value) fail(`Gateway ${index + 1} replacement secret and auth method are required`);
      secret = { [String(method)]: value };
    } else if (action === "clear") {
      if (value) fail(`Gateway ${index + 1} clear action must not include a secret`);
      if (method !== "none") fail(`Gateway ${index + 1} clear action requires auth method none`);
    }
    return { id: item.id, name: item.name, host: item.host, url: item.url, tlsFingerprint: item.tlsFingerprint ?? item.fingerprint, ...secret };
  });
  return parseGateways(candidate);
}

function loadLegacyGateways(env: NodeJS.ProcessEnv): GatewayConfig[] {
  const inline = env.CLAWTOP_GATEWAYS?.trim();
  const file = env.CLAWTOP_GATEWAYS_FILE?.trim();
  if (inline && file) fail("set only one of CLAWTOP_GATEWAYS or CLAWTOP_GATEWAYS_FILE");
  if ((inline || file) && env.OPENCLAW_GATEWAY_URL?.trim()) fail("do not combine a Gateway list with OPENCLAW_GATEWAY_URL shorthand");
  let source: unknown;
  if (file) { try { source = JSON.parse(readFileSync(resolve(file), "utf8")); } catch (error) { fail(`cannot read CLAWTOP_GATEWAYS_FILE: ${safeError(error)}`); } }
  else if (inline) { try { source = JSON.parse(inline); } catch { fail("CLAWTOP_GATEWAYS must be valid JSON"); } }
  else {
    const url = env.OPENCLAW_GATEWAY_URL?.trim();
    if (!url) fail("create /data/gateways.json or configure a legacy Gateway source for first-run migration");
    source = [{ id: env.OPENCLAW_GATEWAY_ID, name: env.OPENCLAW_GATEWAY_NAME, url, token: env.OPENCLAW_GATEWAY_TOKEN, password: env.OPENCLAW_GATEWAY_PASSWORD, tlsFingerprint: env.OPENCLAW_GATEWAY_TLS_FINGERPRINT }];
  }
  return parseGateways(source);
}

function parseGateway(value: unknown, index: number): GatewayConfig {
  const item = record(value) ?? fail(`Gateway ${index + 1} must be an object`);
  const id = requiredString(item.id, `Gateway ${index + 1} id`);
  const name = requiredString(item.name, `Gateway ${index + 1} name`);
  const host = optionalString(item.host);
  const url = requiredString(item.url, `Gateway ${name} url`);
  let parsed: URL; try { parsed = new URL(url); } catch { fail(`Gateway ${name} url is invalid`); }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") fail(`Gateway ${name} url must use ws:// or wss://`);
  if (parsed.username || parsed.password) fail(`Gateway ${name} credentials must not be embedded in its URL`);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) fail(`Gateway ${name} id must match [a-z0-9][a-z0-9._-]{0,63}`);
  const fingerprint = optionalString(item.fingerprint);
  const tlsFingerprint = optionalString(item.tlsFingerprint);
  const token = optionalString(item.token), password = optionalString(item.password), bootstrapToken = optionalString(item.bootstrapToken);
  if (fingerprint && tlsFingerprint && fingerprint !== tlsFingerprint) fail(`Gateway ${name} must not set conflicting fingerprint and tlsFingerprint values`);
  if ([token, password, bootstrapToken].filter(Boolean).length > 1) fail(`Gateway ${name} must set at most one of token, password, or bootstrapToken`);
  return compact({ id, name, host, url, token, password, bootstrapToken, tlsFingerprint: fingerprint ?? tlsFingerprint });
}
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function requiredString(value: unknown, label: string): string { return optionalString(value) ?? fail(`${label} is required`); }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function boolean(value: string | undefined, label: string): boolean { if (value === undefined || value === "" || value === "false") return false; if (value === "true") return true; return fail(`${label} must be true or false`); }
function integer(value: string, min: number, max: number, label: string): number { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < min || parsed > max) fail(`${label} must be an integer from ${min} to ${max}`); return parsed; }
function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 300); }
function compact<T extends object>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T; }
function fail(message: string): never { throw new Error(message); }
