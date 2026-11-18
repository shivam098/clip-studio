import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { now } from './store.mjs';

export const signinKey = 'youtube-signin';
const settingKey = 'youtubeSignin';
const maxFile = 1_000_000;
const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
// YouTube sets these only for a signed-in account.
const sessionCookies = new Set(['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'LOGIN_INFO',
  '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID']);

export function isYouTubeUrl(value) {
  try { return youtubeHosts.has(new URL(value).hostname); } catch { return false; }
}

// Accepts a Netscape-format cookies.txt export and keeps only its youtube.com cookies.
export function youtubeCookies(contents) {
  if (typeof contents !== 'string' || !contents.trim()) throw new Error('Choose the cookies.txt file you exported');
  if (contents.length > maxFile) throw new Error('Choose a cookies.txt file of up to 1 MB');
  const kept = [];
  let signedIn = false;
  for (const line of contents.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const entry = line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line;
    if (!entry.trim() || entry.startsWith('#')) continue;
    const fields = entry.split('\t');
    if (fields.length !== 7) continue;
    const domain = fields[0].replace(/^\./, '').toLowerCase();
    if (domain !== 'youtube.com' && !domain.endsWith('.youtube.com')) continue;
    kept.push(line);
    if (sessionCookies.has(fields[5])) signedIn = true;
  }
  if (!kept.length) throw new Error('This file has no youtube.com cookies. Export the cookies of youtube.com in cookies.txt (Netscape) format.');
  if (!signedIn) throw new Error('This file has no YouTube sign-in. Sign in to YouTube in the browser window you export from, then export again.');
  return { contents: ['# Netscape HTTP Cookie File', ...kept, ''].join('\n'), count: kept.length };
}

export class YouTubeSignin {
  constructor(root, vault, store) {
    this.folder = join(root, 'youtube-signin'); this.vault = vault; this.store = store;
    this.queue = Promise.resolve();
  }
  // Removes per-run copies left behind if the server stopped during a download.
  async init() {
    await rm(this.folder, { recursive: true, force: true });
    await mkdir(this.folder, { recursive: true });
  }
  serial(operation) {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
  saved() {
    const saved = this.store.setting(settingKey, null);
    return saved && this.vault.has(signinKey) ? saved : null;
  }
  status() {
    const saved = this.saved();
    return saved ? { configured: true, updated: saved.updated, cookies: saved.cookies } : { configured: false };
  }
  save(contents) {
    const file = youtubeCookies(contents);
    return this.serial(async () => {
      await this.vault.put(signinKey, file.contents);
      const revision = (this.store.setting(settingKey, null)?.revision ?? 0) + 1;
      this.store.setSetting(settingKey, { updated: now(), cookies: file.count, revision });
      return this.status();
    });
  }
  remove() {
    return this.serial(async () => {
      this.vault.remove(signinKey);
      this.store.setSetting(settingKey, null);
      return this.status();
    });
  }
  // Runs a downloader operation with a temporary copy of the saved sign-in, for YouTube URLs only.
  async use(url, operation) {
    const saved = isYouTubeUrl(url) ? this.saved() : null;
    if (!saved) return operation(null);
    const original = await this.vault.get(signinKey);
    const file = join(this.folder, `${randomUUID()}.txt`);
    await writeFile(file, original + '\n', { mode: 0o600 });
    try { return await operation(file); }
    finally {
      try {
        // yt-dlp writes cookies that YouTube rotated back to this file. Keep them so the sign-in lasts,
        // unless it was replaced or removed during the run.
        const updated = youtubeCookies(await readFile(file, 'utf8'));
        await this.serial(async () => {
          const current = this.saved();
          if (current?.revision !== saved.revision || updated.contents.trim() === original.trim()) return;
          await this.vault.put(signinKey, updated.contents);
          this.store.setSetting(settingKey, { ...current, cookies: updated.count });
        });
      } catch { /* Keep the saved sign-in unchanged if the downloader left no usable file. */ }
      await rm(file, { force: true });
    }
  }
}
