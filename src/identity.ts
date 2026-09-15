import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceAuthTokenRecord, DeviceIdentity, GatewayClientHostDeps } from "@openclaw/gateway-client";

const SPKI_PREFIX_BYTES = 12;

type StoredAuth = { token: string; scopes: string[] };
type StoredIdentity = DeviceIdentity & { createdAtMs: number };

export function createIdentityHost(dataDir: string): { identity: DeviceIdentity; hostDeps: GatewayClientHostDeps } {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const identityPath = join(dataDir, "device.json");
  const authPath = join(dataDir, "auth.json");
  const identity = loadOrCreateIdentity(identityPath);

  return {
    identity,
    hostDeps: {
      signDevicePayload: (privateKeyPem, payload) => sign(null, Buffer.from(payload, "utf8"), createPrivateKey(privateKeyPem)).toString("base64url"),
      publicKeyRawBase64UrlFromPem: rawPublicKey,
      loadDeviceAuthToken: () => readAuth(authPath),
      storeDeviceAuthToken: ({ token, scopes }) => writePrivateJson(authPath, { token, scopes }),
      clearDeviceAuthToken: () => { if (existsSync(authPath)) writePrivateJson(authPath, { token: "", scopes: [] }); },
      redactForLog: () => "[gateway detail redacted]",
      logDebug: () => {},
      logError: () => {}
    }
  };
}

function loadOrCreateIdentity(path: string): DeviceIdentity {
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, "utf8")) as StoredIdentity;
    const raw = rawPublicKey(saved.publicKeyPem);
    const expectedId = createHash("sha256").update(Buffer.from(raw, "base64url")).digest("hex");
    const derived = createPublicKey(saved.privateKeyPem).export({ type: "spki", format: "pem" }) as string;
    if (saved.deviceId !== expectedId || derived !== saved.publicKeyPem) throw new Error("persisted device identity is invalid; restore it or remove the data volume and re-pair");
    chmodSync(path, 0o600);
    return saved;
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const raw = rawPublicKey(publicKeyPem);
  const saved: StoredIdentity = {
    deviceId: createHash("sha256").update(Buffer.from(raw, "base64url")).digest("hex"),
    publicKeyPem,
    privateKeyPem,
    createdAtMs: Date.now()
  };
  writePrivateJson(path, saved);
  return saved;
}

function rawPublicKey(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("device public key must be Ed25519");
  const der = Buffer.from(key.export({ type: "spki", format: "der" }));
  if (der.length !== SPKI_PREFIX_BYTES + 32) throw new Error("device public key encoding is invalid");
  return der.subarray(SPKI_PREFIX_BYTES).toString("base64url");
}

function readAuth(path: string): DeviceAuthTokenRecord | null {
  if (!existsSync(path)) return null;
  const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredAuth>;
  chmodSync(path, 0o600);
  return typeof saved.token === "string" && saved.token ? { token: saved.token, scopes: Array.isArray(saved.scopes) ? saved.scopes.filter((scope): scope is string => typeof scope === "string") : [] } : null;
}

function writePrivateJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
