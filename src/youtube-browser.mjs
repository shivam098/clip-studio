import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { basename, delimiter, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isYouTubeDomain, sessionCookies } from './youtube-signin.mjs';

// Google's YouTube sign-in page. After sign-in it continues to youtube.com, which sets the youtube.com cookies.
export const signinUrl = 'https://accounts.google.com/ServiceLogin?service=youtube&uilel=3&passive=true&continue=' +
  encodeURIComponent('https://www.youtube.com/signin?action_handle_signin=true&app=desktop&hl=en&next=https%3A%2F%2Fwww.youtube.com%2F') +
  '&hl=en';

// Brave first, then Chrome, Chromium and Edge. A configured path (config.json "signinBrowser") wins.
export function findBrowser(configured, env = process.env, platform = process.platform) {
  const candidates = configured ? [configured] : [];
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
    for (const file of ['BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'Google\\Chrome\\Application\\chrome.exe',
      'Chromium\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe']) {
      for (const root of roots) candidates.push(join(root, file));
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    for (const name of ['brave-browser', 'brave', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) candidates.push(join(dir, name));
    }
  }
  return candidates.find(path => existsSync(path)) ?? null;
}

export function browserName(path) {
  const file = basename(path).toLowerCase();
  return file.includes('brave') ? 'Brave' : file.includes('edge') ? 'Edge' : file.includes('chromium') ? 'Chromium' : 'Chrome';
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  else { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

// Opens a separate browser with its own profile and reads its cookies through the DevTools protocol.
// Nothing is injected into pages; the browser looks and behaves like a normal window.
export async function openBrowser({ executable, profile, url, headless = false, args = [] }) {
  await mkdir(profile, { recursive: true });
  const child = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run',
    '--no-default-browser-check', ...(headless ? ['--headless=new'] : ['--new-window']), ...args, url],
  { stdio: 'ignore', windowsHide: headless });
  let failure = null, gone = false;
  const exited = new Promise(resolve => {
    child.once('exit', () => { gone = true; resolve(); });
    child.once('error', error => { failure = error; gone = true; resolve(); });
  });
  let endpoint;
  for (let i = 0; i < 150 && !endpoint && !gone; i++) {
    try {
      const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
      if (/^\d+$/.test(port) && path?.startsWith('/devtools/browser/')) endpoint = `ws://127.0.0.1:${port}${path}`;
    } catch {}
    if (!endpoint) await sleep(200);
  }
  if (!endpoint) {
    killTree(child.pid);
    throw new Error(failure ? `the browser could not start (${failure.message})` : 'the browser did not open its DevTools connection');
  }
  const socket = new WebSocket(endpoint);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('could not connect to the browser')), { once: true });
    });
  } catch (error) { killTree(child.pid); throw error; }
  const pending = new Map();
  let next = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) entry.reject(new Error('the browser connection closed'));
    pending.clear();
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) { reject(new Error('the browser connection closed')); return; }
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10_000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  let closing;
  return {
    pid: child.pid,
    exited,
    cookies: async () => (await call('Storage.getCookies')).cookies,
    pages: async () => (await call('Target.getTargets')).targetInfos.filter(t => t.type === 'page').map(t => ({ url: t.url, title: t.title })),
    close() {
      closing ??= (async () => {
        if (!gone) {
          await call('Browser.close').catch(() => {});
          if (!(await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)]))) {
            killTree(child.pid);
            await Promise.race([exited, sleep(5_000)]);
          }
        }
        try { socket.close(); } catch {}
      })();
      return closing;
    },
  };
}

export function signedIn(cookies, pages = []) {
  const youtube = cookies.filter(cookie => isYouTubeDomain(cookie.domain));
  if (youtube.some(cookie => cookie.name === 'LOGIN_INFO')) return true;
  return youtube.some(cookie => sessionCookies.has(cookie.name)) &&
    pages.some(page => /^https:\/\/(www|m)\.youtube\.com\//.test(page.url) && !/^https:\/\/[^/]+\/signin\b/.test(page.url));
}

// DevTools cookie objects to a Netscape cookies.txt with only youtube.com cookies (yt-dlp's --cookies format).
export function toNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const cookie of cookies) {
    if (!isYouTubeDomain(cookie.domain) || /[\t\r\n]/.test(`${cookie.name}${cookie.value}${cookie.path}`)) continue;
    const expires = cookie.session || !(cookie.expires > 0) ? 0 : Math.floor(cookie.expires);
    lines.push([`${cookie.httpOnly ? '#HttpOnly_' : ''}${cookie.domain}`, cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE',
      cookie.path || '/', cookie.secure ? 'TRUE' : 'FALSE', expires, cookie.name, cookie.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

// "Sign in to YouTube": opens a browser window on the studio PC with a fresh profile, waits until the person signs
// in, saves the youtube.com cookies as the studio's YouTube sign-in, then closes the window and deletes the profile.
export class YouTubeSigninWindow {
  constructor(root, signin, { findExecutable = () => findBrowser(), open = openBrowser, onSaved = () => {},
    pollMs = 1500, settleMs = 3000, timeoutMs = 15 * 60_000 } = {}) {
    this.folder = join(root, 'youtube-signin-window');
    this.signin = signin; this.findExecutable = findExecutable; this.open = open; this.onSaved = onSaved;
    this.pollMs = pollMs; this.settleMs = settleMs; this.timeoutMs = timeoutMs;
    this.current = { state: 'idle' };
    this.session = null;
    this.running = new Set();
  }
  // Removes profiles left behind if the server stopped while a window was open.
  async init() { await rm(this.folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {}); }
  status() { return { ...this.current }; }
  start(email = null) {
    if (this.session && !this.session.settled) return this.status();
    const executable = this.findExecutable();
    if (!executable) {
      this.current = { state: 'failed', finished: Date.now(),
        message: 'No Brave, Chrome or Edge browser was found on the studio PC. Install Brave, or add a cookies.txt file instead.' };
      return this.status();
    }
    const browser = browserName(executable), started = Date.now();
    const session = this.session = { cancelled: false, settled: false, handle: null };
    this.running.add(session);
    this.current = { state: 'opening', browser, started };
    session.done = this.run(session, executable, browser, started, email).finally(() => {
      this.running.delete(session);
      if (this.session === session) this.session = null;
    });
    return this.status();
  }
  async run(session, executable, browser, started, email) {
    const profile = join(this.folder, randomUUID());
    try {
      session.handle = await this.open({ executable, profile, url: signinUrl });
      if (session.cancelled) return;
      this.current = { state: 'waiting', browser, started };
      const outcome = await this.watch(session, session.handle, browser, started);
      // A sign-in that was saved stays saved, even if Cancel arrived while it was being stored.
      if (!outcome || (session.cancelled && outcome.state !== 'saved')) return;
      session.settled = true;
      if (outcome.state === 'saved') this.onSaved(email);
      this.current = { ...outcome, browser, started, finished: Date.now() };
    } catch (error) {
      if (!session.cancelled) {
        session.settled = true;
        this.current = { state: 'failed', browser, started, finished: Date.now(),
          message: `The ${browser} sign-in window did not work: ${error.message}. Select Sign in to YouTube to try again.` };
      }
    } finally {
      await session.handle?.close().catch(() => {});
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
    }
  }
  async watch(session, handle, browser, started) {
    let closed = false;
    handle.exited.then(() => { closed = true; });
    while (!session.cancelled) {
      if (closed) return { state: 'failed', message: `The ${browser} window was closed before the YouTube sign-in finished. Select Sign in to YouTube to try again.` };
      if (Date.now() - started > this.timeoutMs) {
        return { state: 'failed', message: 'The sign-in window was open for 15 minutes without a YouTube sign-in, so it was closed. Select Sign in to YouTube to try again.' };
      }
      let cookies, pages;
      try { [cookies, pages] = await Promise.all([handle.cookies(), handle.pages()]); }
      catch { await sleep(this.pollMs); continue; }
      if (pages.some(page => /^https:\/\/accounts\.google\.com\/[^?#]*signin\/rejected/i.test(page.url))) {
        return { state: 'failed', message: `Google refused to sign in in the ${browser} window. Add a cookies.txt file instead (under Other way).` };
      }
      if (signedIn(cookies, pages)) {
        // Let youtube.com finish setting its cookies after the sign-in redirect.
        await sleep(this.settleMs);
        const latest = await handle.cookies().catch(() => cookies);
        if (session.cancelled) return null;
        const saved = await this.signin.save(toNetscape(latest));
        return { state: 'saved', cookies: saved.cookies, message: `Saved the YouTube sign-in from the ${browser} window.` };
      }
      await sleep(this.pollMs);
    }
    return null;
  }
  async cancel() {
    const session = this.session;
    if (!session || session.settled) return this.status();
    session.cancelled = true;
    this.current = { state: 'cancelled', browser: this.current.browser, finished: Date.now(), message: 'YouTube sign-in cancelled. The window was closed.' };
    session.handle?.close().catch(() => {});
    await session.done;
    return this.status();
  }
  async close() {
    await this.cancel();
    await Promise.allSettled([...this.running].map(session => session.done));
  }
}
