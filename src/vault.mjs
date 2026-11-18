import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './process.mjs';
import { writeJsonAtomic } from './config.mjs';

const script = fileURLToPath(new URL('../scripts/vault.ps1', import.meta.url));

export class Vault {
  constructor(root) { this.file = join(root, 'credentials.json'); }
  entries() { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {}; }
  has(key) { return !!this.entries()[key]; }
  moveIfPresent(from, to) {
    const entries = this.entries();
    if (!entries[from]) return;
    entries[to] ??= entries[from];
    delete entries[from];
    writeJsonAtomic(this.file, entries);
  }
  async put(key, secret) {
    let value = secret;
    if (process.platform === 'win32') {
      value = (await run('powershell.exe', ['-NoProfile', '-File', script, 'protect'], { input: secret })).stdout.trim();
    }
    const entries = this.entries();
    entries[key] = { protection: process.platform === 'win32' ? 'dpapi' : 'file-mode-600', value };
    writeJsonAtomic(this.file, entries);
  }
  async get(key) {
    const entry = this.entries()[key];
    if (!entry) throw new Error('No credential configured for this account');
    if (entry.protection === 'dpapi') {
      return (await run('powershell.exe', ['-NoProfile', '-File', script, 'unprotect'], { input: entry.value })).stdout.trim();
    }
    return entry.value;
  }
}
