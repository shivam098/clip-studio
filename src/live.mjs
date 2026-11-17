import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { run } from './process.mjs';
import { liveUrl } from './imports.mjs';
import { id, now } from './store.mjs';

export class Live {
  constructor(store, leases, root, config, addAsset) {
    this.store = store; this.leases = leases; this.root = root; this.config = config; this.addAsset = addAsset;
    this.running = new Map();
  }
  async start(workspaceId, name, url, synthetic = false) {
    const sessionId = id(), path = join(this.root, 'live', sessionId);
    await mkdir(path, { recursive: true });
    this.store.run('INSERT INTO live_sessions(id,workspace_id,name,state,path,created) VALUES (?,?,?,?,?,?)',
      sessionId, workspaceId, name, 'recording', path, now());
    const controller = new AbortController();
    const entry = { controller, promise: null, scan: Promise.resolve() };
    this.running.set(sessionId, entry);
    entry.promise = (async () => {
      let timer;
      try {
        const input = synthetic
          ? ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '45']
          : ['-protocol_whitelist', 'https,tls,tcp,crypto', '-i', await liveUrl(url, this.config, controller.signal)];
        const scan = () => {
          entry.scan = entry.scan.then(() => this.scan(sessionId)).catch(error => {
            this.store.run('UPDATE live_sessions SET error=? WHERE id=?', error.message, sessionId);
            controller.abort(error);
          });
        };
        timer = setInterval(scan, 3000);
        await run(this.config.ffmpeg, ['-hide_banner', '-nostdin', '-y', ...input,
          '-map', '0:v:0', '-map', synthetic ? '1:a:0' : '0:a:0?', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2',
          '-c:a', 'aac', '-force_key_frames', 'expr:gte(t,n_forced*20)',
          '-f', 'segment', '-segment_time', '20', '-reset_timestamps', '1',
          '-segment_list', 'segments.csv', '-segment_list_type', 'csv', 'part-%06d.mp4'],
        { cwd: path, signal: controller.signal });
        this.store.run("UPDATE live_sessions SET state='stopped' WHERE id=?", sessionId);
      } catch (error) {
        this.store.run('UPDATE live_sessions SET state=?,error=? WHERE id=?',
          controller.signal.aborted ? 'stopped' : 'failed', controller.signal.aborted ? 'Capture stopped; completed segments retained.' : error.message, sessionId);
      } finally {
        clearInterval(timer);
        await entry.scan;
        try { await this.scan(sessionId); }
        catch (error) { this.store.run('UPDATE live_sessions SET error=? WHERE id=?', error.message, sessionId); }
        this.running.delete(sessionId);
      }
    })();
    return sessionId;
  }
  async scan(sessionId) {
    const session = this.store.get('SELECT * FROM live_sessions WHERE id=?', sessionId);
    let csv;
    try { csv = await readFile(join(session.path, 'segments.csv'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const line of csv.trim().split('\n')) {
      const file = line.split(',')[0].replace(/^"|"$/g, '').trim();
      if (!/^part-\d{6}\.mp4$/.test(file)) continue;
      const path = join(session.path, file);
      if (this.store.get('SELECT id FROM live_segments WHERE path=?', path)) continue;
      const asset = await this.addAsset(path, session.workspace_id, `${session.name} / ${basename(file)}`);
      this.store.run('INSERT INTO live_segments VALUES (?,?,?,?,?)', id(), sessionId, path, asset.id, now());
    }
  }
  async stop(sessionId) {
    const entry = this.running.get(sessionId);
    if (!entry) throw new Error('Capture is not running');
    entry.controller.abort(new Error('Stopped by user'));
    await entry.promise;
  }
  async cleanup(sessionId) {
    if (this.running.has(sessionId)) throw new Error('Stop capture before deleting buffers');
    const segments = this.store.all('SELECT * FROM live_segments WHERE session_id=?', sessionId);
    let deleted = 0, retained = 0;
    for (const segment of segments) {
      if (!this.leases.canDelete(segment.asset_id) ||
        this.store.get('SELECT id FROM clips WHERE asset_id=? LIMIT 1', segment.asset_id)) { retained++; continue; }
      // Reserve a deletion lease before the async filesystem operation; API users reject leased deletion candidates.
      this.store.run('INSERT INTO leases VALUES (?,?)', `cleanup:${sessionId}`, segment.asset_id);
      try {
        await rm(segment.path, { force: true });
        this.store.tx(() => {
          this.store.run('DELETE FROM live_segments WHERE id=?', segment.id);
          this.store.run('DELETE FROM transcripts WHERE asset_id=?', segment.asset_id);
          this.store.run('DELETE FROM assets WHERE id=?', segment.asset_id);
        });
        deleted++;
      } finally { this.store.run('DELETE FROM leases WHERE owner=? AND resource_id=?', `cleanup:${sessionId}`, segment.asset_id); }
    }
    return { deleted, retained };
  }
  async shutdown() { await Promise.all([...this.running.keys()].map(sessionId => this.stop(sessionId))); }
}
