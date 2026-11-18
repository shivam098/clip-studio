import { id, json, now, parse } from './store.mjs';

export class Jobs {
  constructor(store) {
    this.store = store;
    this.running = new Map();
  }
  create(type, resourceId, payload = {}) {
    const jobId = id();
    this.store.run('INSERT INTO jobs(id,type,resource_id,state,payload,created) VALUES (?,?,?,?,?,?)',
      jobId, type, resourceId, 'queued', json(payload), now());
    return jobId;
  }
  owns(jobId, attempt) {
    return !!this.store.get("SELECT id FROM jobs WHERE id=? AND attempt=? AND state='running'", jobId, attempt);
  }
  start(jobId, execute, { timeout = 600_000, commit = () => {}, release = () => {}, failureResult = () => null } = {}) {
    const attempt = id();
    const row = this.store.get("SELECT * FROM jobs WHERE id=? AND state='queued'", jobId);
    if (!row) throw new Error('Job is not queued');
    this.store.run("UPDATE jobs SET state='running', attempt=?, started=? WHERE id=? AND state='queued'", attempt, now(), jobId);
    const controller = new AbortController();
    const key = `${jobId}:${attempt}`;
    const requireOwnership = () => {
      controller.signal.throwIfAborted();
      if (!this.owns(jobId, attempt)) throw new Error('Attempt no longer owns this job');
    };
    const stop = (state, message) => {
      this.store.run("UPDATE jobs SET state=?,error=?,finished=? WHERE id=? AND attempt=? AND state='running'",
        state, message, now(), jobId, attempt);
      controller.abort(new Error(message));
    };
    const timer = setTimeout(() => stop('timed_out', 'Job timed out; underlying work is being stopped.'), timeout);
    const entry = { attempt, controller, stop, promise: null };
    this.running.set(key, entry);
    entry.promise = (async () => {
      try {
        const result = await execute({ job: row, payload: parse(row.payload), attempt,
          signal: controller.signal, requireOwnership });
        requireOwnership();
        this.store.tx(() => {
          requireOwnership();
          commit(result, row);
          this.store.run("UPDATE jobs SET state='succeeded',result=?,finished=? WHERE id=? AND attempt=? AND state='running'",
            json(result ?? null), now(), jobId, attempt);
        });
      } catch (error) {
        this.store.run("UPDATE jobs SET state='failed',error=?,result=?,finished=? WHERE id=? AND attempt=? AND state='running'",
          error.message, json(failureResult(error)), now(), jobId, attempt);
      } finally {
        clearTimeout(timer);
        try { await release({ attempt, job: row }); }
        finally { this.running.delete(key); }
      }
    })();
    return entry.promise;
  }
  cancel(jobId) {
    this.store.run("UPDATE jobs SET state='cancelled',error='Cancelled by user',finished=? WHERE id=? AND state IN ('queued','running')", now(), jobId);
    for (const [key, entry] of this.running) {
      if (key.startsWith(`${jobId}:`)) entry.controller.abort(new Error('Cancelled by user'));
    }
  }
  async shutdown() {
    for (const entry of this.running.values()) entry.stop('interrupted', 'Server stopped');
    await Promise.all([...this.running.values()].map(entry => entry.promise));
  }
}

// Each analysis owns its own leases even if a newer task replaces the visible task.
export class AnalysisLeases {
  constructor(store) {
    this.store = store;
    this.current = new Map();
    this.tasks = new Map();
  }
  async run(streamId, resources, operation) {
    const owner = id();
    this.store.tx(() => {
      for (const resource of resources) this.store.run('INSERT INTO leases VALUES (?,?)', owner, resource);
    });
    this.current.set(streamId, owner);
    this.tasks.set(owner, { streamId, resources });
    try { return await operation(owner); }
    finally {
      this.store.run('DELETE FROM leases WHERE owner=?', owner);
      this.tasks.delete(owner);
      if (this.current.get(streamId) === owner) this.current.delete(streamId);
    }
  }
  canDelete(resource) { return !this.store.get('SELECT owner FROM leases WHERE resource_id=? LIMIT 1', resource); }
}
