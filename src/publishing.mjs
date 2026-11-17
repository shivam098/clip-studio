import { id, json, now, parse } from './store.mjs';

export class Publishing {
  constructor(store, providers, vault, clock = now) {
    this.store = store; this.providers = providers; this.vault = vault; this.clock = clock;
    this.running = new Map();
  }
  claim(publicationId) {
    return this.store.tx(() => {
      if (!this.store.setting('publishingEnabled', false)) return null;
      const publication = this.store.get("SELECT * FROM publications WHERE id=? AND state='scheduled' AND scheduled<=?", publicationId, this.clock());
      if (!publication) return null;
      const account = this.store.get('SELECT * FROM accounts WHERE id=? AND enabled=1', publication.account_id);
      if (!account || !this.vault.has(account.id)) return null;
      const binding = this.store.get('SELECT * FROM account_bindings WHERE account_id=? AND verified=1', account.id);
      if (!binding) return null;
      account.remote_id = binding.remote_id;
      if (this.store.get("SELECT id FROM publications WHERE account_id=? AND state IN ('dispatching','uncertain','processing') LIMIT 1", account.id)) return null;
      const time = this.clock();
      const last = this.store.get(`SELECT MAX(MAX(d.created,COALESCE(p.finished,d.created))) AS latest
        FROM dispatches d JOIN publications p ON p.id=d.publication_id WHERE d.account_id=?`, account.id).latest;
      const count = this.store.get(`SELECT COUNT(*) AS count FROM dispatches d
        JOIN publications p ON p.id=d.publication_id WHERE d.account_id=?
        AND MAX(d.created,COALESCE(p.finished,d.created))>?`, account.id, time - 86400000).count;
      if ((last != null && time - last < account.spacing * 1000) || count >= account.daily_cap) return null;
      const attempt = id();
      this.store.run("UPDATE publications SET state='dispatching',attempt=?,dispatched=? WHERE id=?", attempt, time, publication.id);
      this.store.run('INSERT INTO dispatches VALUES (?,?,?,?)', attempt, account.id, publication.id, time);
      return { publication: { ...publication, attempt, metadata: parse(publication.metadata), provider_ref: parse(publication.provider_ref) },
        account: { ...account, config: parse(account.config) } };
    });
  }
  async dispatch(publicationId) {
    const claimed = this.claim(publicationId);
    if (!claimed) return false;
    const { publication, account } = claimed;
    const controller = new AbortController();
    this.running.set(publicationId, controller);
    const timer = setTimeout(() => controller.abort(new Error('Publishing timed out; reconcile before retrying')), 20 * 60_000);
    try {
      const token = await this.vault.get(account.id);
      controller.signal.throwIfAborted();
      const identity = await this.providers.identify(account, token, controller.signal);
      controller.signal.throwIfAborted();
      if (!this.store.get("SELECT id FROM publications WHERE id=? AND attempt=? AND state='dispatching'", publicationId, publication.attempt)) {
        throw new Error('Publication ownership was lost before upload');
      }
      if (identity.id !== account.remote_id || publication.metadata.destinationId !== account.remote_id) {
        throw new Error('Authenticated destination no longer matches the approved account; no upload was started');
      }
      const checkpoint = value => {
        const change = this.store.run("UPDATE publications SET provider_ref=? WHERE id=? AND attempt=? AND state IN ('dispatching','uncertain')",
          json(value), publicationId, publication.attempt);
        if (change.changes !== 1) throw new Error('Publication ownership was lost');
        controller.signal.throwIfAborted();
      };
      const result = await this.providers.upload(publication, account, token, checkpoint, controller.signal);
      controller.signal.throwIfAborted();
      this.store.run("UPDATE publications SET state=?,result=?,finished=? WHERE id=? AND attempt=? AND state='dispatching'",
        result.state, json(result), this.clock(), publicationId, publication.attempt);
    } catch (error) {
      this.store.run("UPDATE publications SET state='uncertain',error=? WHERE id=? AND attempt=? AND state='dispatching'",
        error.message, publicationId, publication.attempt);
    } finally { clearTimeout(timer); this.running.delete(publicationId); }
    return true;
  }
  async tick() {
    const due = this.store.all("SELECT id FROM publications WHERE state='scheduled' AND scheduled<=? ORDER BY scheduled,created LIMIT 20", this.clock());
    for (const row of due) {
      if (this.running.size >= 2) break;
      await this.dispatch(row.id);
    }
  }
  async reconcile(publicationId) {
    if (this.running.has(publicationId)) throw new Error('Wait for the cancelled dispatch task to settle before reconciliation');
    const row = this.store.get("SELECT * FROM publications WHERE id=? AND state IN ('uncertain','processing')", publicationId);
    if (!row) throw new Error('Only unresolved outcomes can be reconciled');
    const account = this.store.get('SELECT * FROM accounts WHERE id=?', row.account_id);
    const token = await this.vault.get(account.id);
    const parsedAccount = { ...account, config: parse(account.config) };
    const identity = await this.providers.identify(parsedAccount, token, AbortSignal.timeout(90_000));
    if (identity.id !== parse(row.metadata).destinationId) throw new Error('Token identity differs from the original approved destination');
    const result = await this.providers.reconcile({ ...row, provider_ref: parse(row.provider_ref) },
      parsedAccount, token, AbortSignal.timeout(90_000));
    this.store.run("UPDATE publications SET state=?,result=?,error=?,finished=? WHERE id=? AND state IN ('uncertain','processing')",
      result.state, json(result), result.message ?? null, this.clock(), publicationId);
    return result;
  }
  cancel(publicationId) {
    const row = this.store.get('SELECT state FROM publications WHERE id=?', publicationId);
    if (!row) throw new Error('Publication not found');
    if (row.state === 'scheduled') this.store.run("UPDATE publications SET state='cancelled' WHERE id=? AND state='scheduled'", publicationId);
    else if (row.state === 'dispatching') {
      this.store.run("UPDATE publications SET state='uncertain',error='Cancelled during dispatch; remote outcome may already exist.' WHERE id=?", publicationId);
      this.running.get(publicationId)?.abort(new Error('Cancelled; remote outcome must be reconciled'));
    } else throw new Error('A completed or unresolved external outcome cannot be cancelled locally');
  }
  shutdown() { for (const controller of this.running.values()) controller.abort(new Error('Server stopped; reconcile before retrying')); }
}
