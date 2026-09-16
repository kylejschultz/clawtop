import { DatabaseSync } from "node:sqlite";
import type { DashboardSession, DashboardState, SafeActivity } from "./model.js";

export type HistoryPage = { sessions: DashboardSession[]; nextBefore?: number };

export class HistoryStore {
  private readonly db: DatabaseSync;
  private lastPrune = 0;
  constructor(path: string, private readonly retentionDays = 90, private readonly maxBytes = 1024 * 1024 * 1024) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA auto_vacuum=INCREMENTAL;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY, gateway_id TEXT NOT NULL, updated_at INTEGER NOT NULL, metadata TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC, key);
      CREATE TABLE IF NOT EXISTS events (
        session_key TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
        label TEXT NOT NULL, detail TEXT, status TEXT, run_id TEXT,
        PRIMARY KEY(session_key, id)
      );
      CREATE INDEX IF NOT EXISTS events_session_at ON events(session_key, at DESC);
    `);
  }

  persist(previous: DashboardState, next: DashboardState): void {
    const saveSession = this.db.prepare("INSERT INTO sessions(key,gateway_id,updated_at,metadata) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET gateway_id=excluded.gateway_id,updated_at=excluded.updated_at,metadata=excluded.metadata");
    const saveEvent = this.db.prepare("INSERT OR REPLACE INTO events(session_key,id,at,kind,label,detail,status,run_id) VALUES(?,?,?,?,?,?,?,?)");
    this.db.exec("BEGIN");
    try {
      for (const session of Object.values(next.sessions)) {
        const old = previous.sessions[session.key];
        if (old === session) continue;
        const metadata = { ...session, activity: [] };
        saveSession.run(session.key, session.gatewayId, session.lastSignalAt ?? session.updatedAt ?? next.updatedAt, JSON.stringify(metadata));
        for (const event of session.activity) {
          if (old?.activity.some((item) => item.id === event.id && item.at === event.at)) continue;
          saveEvent.run(eventKey(session), event.id, event.at, event.kind, event.label, event.detail ?? null, event.status ?? null, event.runId ?? null);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    if (Date.now() - this.lastPrune > 60 * 60 * 1000) this.prune();
  }

  restore(session: DashboardSession, limit = 40): DashboardSession {
    if (!session.sessionId) return session;
    const activity = this.activityRows(eventKey(session), session.key, limit);
    return activity.length ? { ...session, activity: merge(session.activity, activity).slice(0, limit) } : session;
  }

  page(before = Number.MAX_SAFE_INTEGER, limit = 25): HistoryPage {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.db.prepare("SELECT metadata,updated_at FROM sessions WHERE updated_at < ? ORDER BY updated_at DESC,key LIMIT ?").all(before, bounded + 1) as Array<{ metadata: string; updated_at: number }>;
    const more = rows.length > bounded;
    const selected = rows.slice(0, bounded);
    const sessions = selected.flatMap((row) => {
      try {
        const session = JSON.parse(row.metadata) as DashboardSession;
        return [{ ...session, activity: session.sessionId ? this.activityRows(eventKey(session), session.key, 40) : [] }];
      } catch { return []; }
    });
    return { sessions, nextBefore: more ? selected.at(-1)?.updated_at : undefined };
  }

  activities(sessionKey: string, limit = 40, before = Number.MAX_SAFE_INTEGER): SafeActivity[] {
    const row = this.db.prepare("SELECT metadata FROM sessions WHERE key=?").get(sessionKey) as { metadata: string } | undefined;
    if (!row) return [];
    try {
      const session = JSON.parse(row.metadata) as DashboardSession;
      return session.sessionId ? this.activityRows(eventKey(session), sessionKey, limit, before) : [];
    } catch { return []; }
  }

  private activityRows(storageKey: string, sessionKey: string, limit: number, before = Number.MAX_SAFE_INTEGER): SafeActivity[] {
    const rows = this.db.prepare("SELECT id,at,kind,label,detail,status,run_id FROM events WHERE session_key=? AND at<? ORDER BY at DESC LIMIT ?").all(storageKey, before, Math.max(1, Math.min(100, Math.trunc(limit)))) as Array<{ id: string; at: number; kind: SafeActivity["kind"]; label: string; detail: string | null; status: string | null; run_id: string | null }>;
    return rows.map((row) => compact({ id: row.id, sessionKey, at: row.at, kind: row.kind, label: row.label, detail: row.detail ?? undefined, status: row.status ?? undefined, runId: row.run_id ?? undefined }));
  }

  prune(now = Date.now()): void {
    this.lastPrune = now;
    const cutoff = now - this.retentionDays * 86400000;
    this.db.prepare("DELETE FROM events WHERE at < ?").run(cutoff);
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    for (let pass = 0; pass < 100 && this.databaseBytes() > this.maxBytes; pass += 1) {
      const changed = this.db.prepare("DELETE FROM events WHERE rowid IN (SELECT rowid FROM events ORDER BY at LIMIT 1000)").run();
      if (Number(changed.changes) === 0) break;
      this.db.exec("PRAGMA incremental_vacuum(1000)");
    }
  }

  close(): void { this.db.close(); }
  private databaseBytes(): number {
    const pageCount = Number((this.db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
    const pageSize = Number((this.db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
    return pageCount * pageSize;
  }
}

function eventKey(session: DashboardSession): string { return `${session.key}\u0000${session.sessionId ?? ""}`; }
function merge(current: SafeActivity[], stored: SafeActivity[]): SafeActivity[] {
  const values = new Map(stored.map((item) => [item.id, item]));
  for (const item of current) values.set(item.id, item);
  return [...values.values()].sort((a, b) => b.at - a.at);
}
function compact<T extends object>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T; }
