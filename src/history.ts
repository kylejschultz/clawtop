import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { DashboardSession, DashboardState, SafeActivity } from "./model.js";

export type HistoryPage = { sessions: DashboardSession[]; nextCursor?: string };
export type ActivityPage = { events: SafeActivity[]; nextCursor?: string };

type StoredSession = Pick<DashboardSession, "key" | "sourceKey" | "gatewayId" | "sessionId" | "agentId" | "kind" | "channel" | "parentSessionKey" | "childSessions" | "state" | "lifecycleSince" | "activeSince" | "updatedAt" | "lastSignalAt" | "status">;

export class HistoryStore {
  private readonly db: DatabaseSync;
  private lastPrune = 0;
  constructor(private readonly path: string, private readonly retentionDays = 90, private readonly maxBytes = 1024 * 1024 * 1024) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    const version = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    const migrated = version < 2;
    if (migrated) this.db.exec("DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS sessions;");
    this.db.exec(`
      PRAGMA auto_vacuum=INCREMENTAL;
      CREATE TABLE IF NOT EXISTS sessions (
        history_id TEXT PRIMARY KEY, live_key TEXT NOT NULL, gateway_id TEXT NOT NULL, updated_at INTEGER NOT NULL, metadata TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC, history_id);
      CREATE INDEX IF NOT EXISTS sessions_live_key ON sessions(live_key, updated_at DESC);
      CREATE TABLE IF NOT EXISTS events (
        history_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
        label TEXT NOT NULL, status TEXT, run_id TEXT,
        PRIMARY KEY(history_id, id)
      );
      CREATE INDEX IF NOT EXISTS events_session_at ON events(history_id, at DESC);
      PRAGMA user_version=2;
    `);
    if (migrated) this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
  }

  persist(previous: DashboardState, next: DashboardState): void {
    const saveSession = this.db.prepare("INSERT INTO sessions(history_id,live_key,gateway_id,updated_at,metadata) VALUES(?,?,?,?,?) ON CONFLICT(history_id) DO UPDATE SET live_key=excluded.live_key,gateway_id=excluded.gateway_id,updated_at=excluded.updated_at,metadata=excluded.metadata");
    const saveEvent = this.db.prepare("INSERT OR REPLACE INTO events(history_id,id,at,kind,label,status,run_id) VALUES(?,?,?,?,?,?,?)");
    this.db.exec("BEGIN");
    try {
      for (const session of Object.values(next.sessions)) {
        const old = previous.sessions[session.key];
        if (old === session) continue;
        const historyId = eventKey(session);
        saveSession.run(historyId, session.key, session.gatewayId, session.lastSignalAt ?? session.updatedAt ?? next.updatedAt, JSON.stringify(storedSession(session)));
        for (const event of session.activity) {
          if (old && old.sessionId === session.sessionId && old.activity.some((item) => item.id === event.id && item.at === event.at)) continue;
          saveEvent.run(historyId, event.id, event.at, event.kind, event.label, event.status ?? null, event.runId ?? null);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    if (Date.now() - this.lastPrune > 60 * 60 * 1000) this.prune();
  }

  restore(session: DashboardSession, limit = 40): DashboardSession {
    if (!session.sessionId) return session;
    const historyId = eventKey(session);
    const page = this.activityPage(historyId, limit);
    return {
      ...session,
      historyId,
      activityCursor: page.nextCursor,
      activityHistoryComplete: !page.nextCursor,
      activity: page.events.length ? merge(session.activity, page.events).slice(0, limit) : session.activity
    };
  }

  page(cursor: string | undefined = undefined, limit = 25): HistoryPage {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const before = decodeCursor(cursor);
    const rows = this.db.prepare("SELECT history_id,metadata,updated_at FROM sessions WHERE updated_at < ? OR (updated_at = ? AND history_id > ?) ORDER BY updated_at DESC,history_id ASC LIMIT ?").all(before.at, before.at, before.id, bounded + 1) as Array<{ history_id: string; metadata: string; updated_at: number }>;
    const more = rows.length > bounded;
    const selected = rows.slice(0, bounded);
    const sessions = selected.flatMap((row) => {
      try {
        const stored = JSON.parse(row.metadata) as StoredSession;
        const page = this.activityPage(row.history_id, 40);
        return [{ ...stored, key: row.history_id, historyId: row.history_id, title: "Historical session", state: "idle" as const, activeSince: undefined, activityCursor: page.nextCursor, activityHistoryComplete: !page.nextCursor, activity: page.events.map((event) => ({ ...event, sessionKey: row.history_id })) }];
      } catch { return []; }
    });
    const last = selected.at(-1);
    return { sessions, nextCursor: more && last ? encodeCursor(last.updated_at, last.history_id) : undefined };
  }

  activities(historyId: string, limit = 40): SafeActivity[] { return this.activityPage(historyId, limit).events; }

  activityPage(historyId: string, limit = 40, cursor?: string): ActivityPage {
    const row = this.db.prepare("SELECT live_key FROM sessions WHERE history_id=?").get(historyId) as { live_key: string } | undefined;
    if (!row) return { events: [] };
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const before = decodeCursor(cursor);
    const rows = this.db.prepare("SELECT id,at,kind,label,status,run_id FROM events WHERE history_id=? AND (at < ? OR (at = ? AND id > ?)) ORDER BY at DESC,id ASC LIMIT ?").all(historyId, before.at, before.at, before.id, bounded + 1) as Array<{ id: string; at: number; kind: SafeActivity["kind"]; label: string; status: string | null; run_id: string | null }>;
    const more = rows.length > bounded;
    const selected = rows.slice(0, bounded);
    const events = selected.map((item) => activityRow(item, row.live_key));
    const last = selected.at(-1);
    return { events, nextCursor: more && last ? encodeCursor(last.at, last.id) : undefined };
  }

  prune(now = Date.now()): void {
    this.lastPrune = now;
    this.db.prepare("DELETE FROM events WHERE at < ?").run(now - this.retentionDays * 86400000);
    this.checkpoint();
    while (this.databaseBytes() > this.maxBytes) {
      const changed = this.db.prepare("DELETE FROM events WHERE rowid IN (SELECT rowid FROM events ORDER BY at LIMIT 1000)").run();
      if (Number(changed.changes) === 0) {
        const sessions = this.db.prepare("DELETE FROM sessions WHERE history_id IN (SELECT history_id FROM sessions ORDER BY updated_at LIMIT 100)").run();
        if (Number(sessions.changes) === 0) break;
      }
      this.db.exec("PRAGMA incremental_vacuum(1000)");
      this.checkpoint();
    }
  }

  close(): void { this.db.close(); }
  private checkpoint(): void { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
  private databaseBytes(): number {
    return [this.path, `${this.path}-wal`, `${this.path}-shm`].reduce((total, file) => {
      try { return total + statSync(file).size; } catch { return total; }
    }, 0);
  }
}

function eventKey(session: DashboardSession): string { return Buffer.from(JSON.stringify([session.key, session.sessionId ?? ""])).toString("base64url"); }
function storedSession(session: DashboardSession): StoredSession {
  const { key, sourceKey, gatewayId, sessionId, agentId, kind, channel, parentSessionKey, childSessions, state, lifecycleSince, activeSince, updatedAt, lastSignalAt, status } = session;
  return compact({ key, sourceKey, gatewayId, sessionId, agentId, kind, channel, parentSessionKey, childSessions, state, lifecycleSince, activeSince, updatedAt, lastSignalAt, status });
}
function merge(current: SafeActivity[], stored: SafeActivity[]): SafeActivity[] {
  const values = new Map(stored.map((item) => [item.id, item]));
  for (const item of current) values.set(item.id, item);
  return [...values.values()].sort((a, b) => b.at - a.at || compareIds(a.id, b.id));
}
function compareIds(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function activityRow(row: { id: string; at: number; kind: SafeActivity["kind"]; label: string; status: string | null; run_id: string | null }, sessionKey: string): SafeActivity {
  return compact({ id: row.id, sessionKey, at: row.at, kind: row.kind, label: row.label, status: row.status ?? undefined, runId: row.run_id ?? undefined });
}
function encodeCursor(at: number, id: string): string { return Buffer.from(JSON.stringify([at, id])).toString("base64url"); }
function decodeCursor(cursor: string | undefined): { at: number; id: string } {
  if (!cursor) return { at: Number.MAX_SAFE_INTEGER, id: "" };
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(value) && Number.isSafeInteger(value[0]) && typeof value[1] === "string") return { at: value[0], id: value[1] };
  } catch { /* invalid cursors start from the first page */ }
  return { at: Number.MAX_SAFE_INTEGER, id: "" };
}
function compact<T extends object>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T; }
