import { createHash, timingSafeEqual } from "node:crypto";

export type HttpAuth = { username: string; password: string };

export function sameOriginRequest(headers: { origin?: string; host?: string; secFetchSite?: string }, protocol: "http:" | "https:"): boolean {
  if (headers.secFetchSite !== undefined && headers.secFetchSite !== "same-origin") return false;
  if (!headers.origin || !headers.host) return false;
  try { return new URL(headers.origin).origin === new URL(`${protocol}//${headers.host}`).origin; } catch { return false; }
}

export function validBasicAuthorization(header: string | undefined, auth: HttpAuth): boolean {
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header ?? "");
  let username = "";
  let password = "";
  if (match) {
    const decoded = Buffer.from(match[1] ?? "", "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator >= 0) {
      username = decoded.slice(0, separator);
      password = decoded.slice(separator + 1);
    }
  }
  const usernameOk = safeEqual(username, auth.username);
  const passwordOk = safeEqual(password, auth.password);
  return usernameOk && passwordOk;
}

function safeEqual(actual: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(actual), digest(expected));
}
