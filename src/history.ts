import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { DashboardSession, DashboardState, SafeActivity } from "./model.js";

export type HistoryPage = { sessions: DashboardSession[]; nextBefore?: number };

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
    const activity = this.activityRows(historyId, session.key, limit);
    return { ...session, historyId, activity: activity.length ? merge(session.activity, activity).slice(0, limit) : session.activity };
  }

  page(before = Number.MAX_SAFE_INTEGER, limit = 25): HistoryPage {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.db.prepare("SELECT history_id,metadata,updated_at FROM sessions WHERE updated_at < ? ORDER BY updated_at DESC,history_id LIMIT ?").all(before, bounded + 1) as Array<{ history_id: string; metadata: string; updated_at: number }>;
    const more = rows.length > bounded;
    const selected = rows.slice(0, bounded);
    const sessions = selected.flatMap((row) => {
      try {
        const stored = JSON.parse(row.metadata) as StoredSession;
        return [{ ...stored, key: row.history_id, historyId: row.history_id, title: "Historical session", state: "idle" as const, activeSince: undefined, activity: this.activityRows(row.history_id, row.history_id, 40) }];
      } catch { return []; }
    });
    return { sessions, nextBefore: more ? selected.at(-1)?.updated_at : undefined };
  }

  activities(historyId: string, limit = 40, before = Number.MAX_SAFE_INTEGER): SafeActivity[] {
    const row = this.db.prepare("SELECT live_key FROM sessions WHERE history_id=?").get(historyId) as { live_key: string } | undefined;
    return row ? this.activityRows(historyId, row.live_key, limit, before) : [];
  }

  private activityRows(historyId: string, sessionKey: string, limit: number, before = Number.MAX_SAFE_INTEGER): SafeActivity[] {
    const rows = this.db.prepare("SELECT id,at,kind,label,status,run_id FROM events WHERE history_id=? AND at<? ORDER BY at DESC LIMIT ?").all(historyId, before, Math.max(1, Math.min(100, Math.trunc(limit)))) as Array<{ id: string; at: number; kind: SafeActivity["kind"]; label: string; status: string | null; run_id: string | null }>;
    return rows.map((row) => compact({ id: row.id, sessionKey, at: row.at, kind: row.kind, label: row.label, status: row.status ?? undefined, runId: row.run_id ?? undefined }));
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
  return [...values.values()].sort((a, b) => b.at - a.at);
}
function compact<T extends object>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T; }
