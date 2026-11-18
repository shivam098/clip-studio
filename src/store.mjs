import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const id = () => randomUUID();
export const now = () => Date.now();
export const json = (value) => JSON.stringify(value);
export const parse = (value, fallback = null) => value == null ? fallback : JSON.parse(value);

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, creator TEXT NOT NULL, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        name TEXT NOT NULL, path TEXT NOT NULL, duration REAL NOT NULL,
        width INTEGER NOT NULL, height INTEGER NOT NULL, audio INTEGER NOT NULL, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcripts (
        asset_id TEXT PRIMARY KEY REFERENCES assets(id), segments TEXT NOT NULL, source TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clips (
        id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), name TEXT NOT NULL,
        start REAL NOT NULL, end REAL NOT NULL, hook TEXT NOT NULL DEFAULT '',
        framing TEXT NOT NULL DEFAULT 'fit', captions TEXT NOT NULL DEFAULT '[]',
        output TEXT, revision INTEGER NOT NULL DEFAULT 1, render_owner TEXT, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, resource_id TEXT NOT NULL,
        state TEXT NOT NULL, attempt TEXT, payload TEXT NOT NULL, result TEXT,
        error TEXT, created INTEGER NOT NULL, started INTEGER, finished INTEGER
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, platform TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0, spacing INTEGER NOT NULL, daily_cap INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_bindings (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id), platform TEXT NOT NULL,
        remote_id TEXT NOT NULL, display_name TEXT NOT NULL, verified INTEGER NOT NULL,
        UNIQUE(platform, remote_id)
      );
      CREATE TABLE IF NOT EXISTS publications (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        clip_id TEXT NOT NULL REFERENCES clips(id), scheduled INTEGER NOT NULL,
        state TEXT NOT NULL, attempt TEXT, provider_ref TEXT NOT NULL DEFAULT '{}',
        metadata TEXT NOT NULL, output TEXT NOT NULL, error TEXT, result TEXT,
        created INTEGER NOT NULL, dispatched INTEGER, finished INTEGER
      );
      CREATE TABLE IF NOT EXISTS dispatches (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        publication_id TEXT NOT NULL REFERENCES publications(id), created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dispatch_account_time ON dispatches(account_id, created);
      CREATE TABLE IF NOT EXISTS live_sessions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        name TEXT NOT NULL, state TEXT NOT NULL, path TEXT NOT NULL, error TEXT, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS live_segments (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES live_sessions(id),
        path TEXT NOT NULL UNIQUE, asset_id TEXT REFERENCES assets(id), created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS leases (
        owner TEXT NOT NULL, resource_id TEXT NOT NULL, PRIMARY KEY(owner, resource_id)
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS studio_users (
        email TEXT PRIMARY KEY, salt TEXT NOT NULL, password_hash TEXT NOT NULL, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY, created INTEGER NOT NULL, email TEXT, action TEXT NOT NULL,
        resource TEXT, job_id TEXT, status INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS activity_job ON activity(job_id) WHERE job_id IS NOT NULL;
    `);
    if (!this.get('SELECT id FROM workspaces LIMIT 1')) {
      this.run('INSERT INTO workspaces VALUES (?,?,?,?)', id(), 'My studio', 'Independent creator', now());
    }
  }
  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setting(key, fallback) {
    const row = this.get('SELECT value FROM settings WHERE key=?', key);
    return row ? parse(row.value) : fallback;
  }
  setSetting(key, value) {
    this.run('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, json(value));
  }
  recordAction(email, action, resource = null, status = null) {
    return this.run('INSERT INTO activity(created,email,action,resource,status) VALUES (?,?,?,?,?)',
      now(), email, action, resource, status).lastInsertRowid;
  }
  recover() {
    this.tx(() => {
      this.run("DELETE FROM settings WHERE key='remoteOwnerPassword'");
      this.run("UPDATE jobs SET state='interrupted', error='Server restarted; start a new attempt explicitly.', finished=? WHERE state IN ('queued','running')", now());
      this.run("UPDATE publications SET state='uncertain', error='Server restarted during dispatch. Reconcile; do not blindly retry.' WHERE state='dispatching'");
      this.run("UPDATE live_sessions SET state='interrupted', error='Server restarted. Capture was not resumed.' WHERE state='recording'");
      this.run('UPDATE activity SET status=0 WHERE status IS NULL');
      // Stale leases deliberately survive crashes: an orphaned encoder may still be reading its buffers.
    });
  }
  close() { this.db.close(); }
}
