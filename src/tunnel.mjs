import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { isQuickOrigin } from '../launcher/policy.mjs';

// The tunnel targets only this ephemeral listener, never the trusted localhost console.
export class Tunnel {
  constructor(root, dispatch, revoke) {
    this.home = join(root, 'full-share'); this.dispatch = dispatch; this.revoke = revoke;
    this.entry = null; this.queue = Promise.resolve();
  }
  active(e) {
    return this.entry === e && !!e?.binding && !!e.child?.pid && !e.child.killed &&
      e.child.exitCode === null && e.child.signalCode === null && e.server.listening;
  }
  status() { return this.active(this.entry) ? { active: true, ...this.entry.binding } : { active: false }; }
  change(action) {
    const operation = this.queue.then(() => action === 'start' ? this.open() : this.close());
    this.queue = operation.catch(() => {}); // Failure is reported to this caller; later commands may proceed.
    return operation;
  }
  async open() {
    if (this.active(this.entry)) return this.status();
    await this.close();
    await mkdir(this.home, { recursive: true });
    const config = join(this.home, 'quick.yml');
    await writeFile(config, '{}\n', { mode: 0o600 });
    const e = { binding: null, child: null };
    e.server = http.createServer((req, res) => this.dispatch(req, res, {
      binding: e.binding, active: () => this.active(e),
    }));
    e.server.requestTimeout = 30 * 60_000;
    this.entry = e;
    try {
      await new Promise((ok, fail) => { e.server.once('error', fail); e.server.listen(0, '127.0.0.1', ok); });
      const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: this.home,
        USERPROFILE: this.home, LOCALAPPDATA: this.home, APPDATA: this.home, TEMP: this.home, TMP: this.home };
      const child = e.child = spawn(process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared',
        ['tunnel', '--config', config, '--no-autoupdate', '--metrics', '127.0.0.1:0', '--url',
          `http://127.0.0.1:${e.server.address().port}`], { env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
      const origin = await new Promise((ok, fail) => {
        const timer = setTimeout(() => fail(new Error('Cloudflare did not issue an address in time.')), 75_000);
        for (const stream of [child.stdout, child.stderr]) {
          createInterface({ input: stream }).on('line', line => {
            const candidate = /\|\s*(https:\/\/[a-z0-9-]+\.trycloudflare\.com)\s*\|\s*$/.exec(line)?.[1];
            if (isQuickOrigin(candidate)) { clearTimeout(timer); ok(candidate); }
          });
        }
        child.once('error', () => { clearTimeout(timer); fail(new Error('Could not launch cloudflared.')); });
        child.once('close', () => {
          clearTimeout(timer); fail(new Error('Cloudflare stopped before the studio connected.'));
          if (this.entry === e) {
            this.entry = null; this.revoke(); e.server.closeAllConnections(); e.server.close();
          }
        });
      });
      e.binding = { origin, instance: randomBytes(16).toString('hex') };
      if (!this.active(e)) throw new Error('Tunnel ended before binding.');
      return this.status();
    } catch (error) { await this.close(); throw error; }
  }
  async close() {
    const e = this.entry;
    this.entry = null; this.revoke();
    if (e) {
      e.binding = null;
      e.child?.kill();
      if (e.server.listening) {
        const stopped = new Promise(resolve => e.server.close(resolve));
        e.server.closeAllConnections(); await stopped;
      }
    }
    return this.status();
  }
}
