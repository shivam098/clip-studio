import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { YouTubeSigninWindow, browserName, findBrowser, openBrowser, signedIn, signinUrl, toNetscape } from '../src/youtube-browser.mjs';
import { youtubeCookies } from '../src/youtube-signin.mjs';
import { createApp } from '../src/server.mjs';

const cookie = (name, value, extra = {}) => ({ name, value, domain: '.youtube.com', path: '/', expires: 1900000000,
  httpOnly: true, secure: true, session: false, ...extra });
const anonymous = [cookie('YSC', 'anonymous', { session: true, expires: -1 }), cookie('VISITOR_INFO1_LIVE', 'visitor')];
const signedInCookies = [...anonymous, cookie('SID', 'synthetic-sid', { httpOnly: false }), cookie('LOGIN_INFO', 'synthetic-login'),
  cookie('NID', 'google-only', { domain: '.google.com' })];
const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error('Timed out waiting'); await sleep(5); }
};

// Each poll returns the next step's cookies and pages; the last step repeats.
function fakeBrowser(steps) {
  const calls = { opened: [], closed: 0, handle: null };
  const open = async ({ executable, profile, url }) => {
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'Cookies'), 'synthetic profile data');
    calls.opened.push({ executable, profile, url });
    let exit;
    const exited = new Promise(resolve => { exit = resolve; });
    let step = 0, closing = null;
    const current = () => steps[Math.min(step, steps.length - 1)];
    calls.handle = { exited, exit,
      cookies: async () => current().cookies,
      pages: async () => { const pages = current().pages ?? []; step++; return pages; },
      // Like the real handle, closing twice closes the browser once.
      close: () => (closing ??= (async () => { calls.closed++; exit(); })()) };
    return calls.handle;
  };
  return { open, calls };
}
function fakeSignin() {
  const saved = [];
  return { saved, save: async text => { const file = youtubeCookies(text); saved.push(file.contents); return { configured: true, cookies: file.count }; } };
}

test('DevTools cookies become a youtube.com-only cookies.txt that the sign-in store accepts', () => {
  const text = toNetscape(signedInCookies);
  assert.match(text, /^# Netscape HTTP Cookie File\n/);
  assert.match(text, /\n#HttpOnly_\.youtube\.com\tTRUE\t\/\tTRUE\t0\tYSC\tanonymous\n/);
  assert.match(text, /\n\.youtube\.com\tTRUE\t\/\tTRUE\t1900000000\tSID\tsynthetic-sid\n/);
  assert.doesNotMatch(text, /google-only/);
  assert.equal(youtubeCookies(text).count, 4);
});

test('a YouTube sign-in is recognized only from YouTube session cookies after the sign-in redirect', () => {
  const sidOnly = [...anonymous, cookie('SID', 'synthetic')];
  assert.equal(signedIn(anonymous, [{ url: 'https://www.youtube.com/' }]), false);
  assert.equal(signedIn(signedInCookies), true);
  assert.equal(signedIn(sidOnly, [{ url: 'https://accounts.google.com/v3/signin/challenge' }]), false);
  assert.equal(signedIn(sidOnly, [{ url: 'https://www.youtube.com/signin?action_handle_signin=true' }]), false);
  assert.equal(signedIn(sidOnly, [{ url: 'https://www.youtube.com/' }]), true);
  assert.equal(signedIn([cookie('LOGIN_INFO', 'synthetic', { domain: '.notyoutube.com' })]), false);
});

test('the sign-in browser is Brave when installed, then Chrome, unless config names one', async t => {
  assert.equal(browserName('C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'), 'Brave');
  assert.equal(browserName('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'), 'Brave');
  assert.equal(browserName('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'), 'Chrome');
  assert.equal(browserName('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'), 'Edge');
  if (process.platform === 'darwin') { t.skip('macOS uses fixed application paths'); return; }
  const root = await mkdtemp(join(tmpdir(), 'clip-browsers-'));
  try {
    const place = async (...parts) => { await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true }); await writeFile(join(root, ...parts), ''); return join(root, ...parts); };
    const windows = process.platform === 'win32';
    const env = windows ? { ProgramFiles: root } : { PATH: root };
    assert.equal(findBrowser(undefined, env), null);
    const chrome = windows ? await place('Google', 'Chrome', 'Application', 'chrome.exe') : await place('google-chrome');
    assert.equal(findBrowser(undefined, env), chrome);
    const brave = windows ? await place('BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') : await place('brave-browser');
    assert.equal(findBrowser(undefined, env), brave);
    const configured = await place('custom-browser');
    assert.equal(findBrowser(configured, env), configured);
    assert.equal(findBrowser(join(root, 'missing'), env), brave);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the sign-in window saves the YouTube sign-in after the person signs in, then closes and deletes its profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clip-signin-window-'));
  const { open, calls } = fakeBrowser([
    { cookies: anonymous, pages: [{ url: 'https://accounts.google.com/v3/signin/identifier' }] },
    { cookies: anonymous, pages: [{ url: 'https://accounts.google.com/v3/signin/challenge/pwd' }] },
    { cookies: signedInCookies, pages: [{ url: 'https://www.youtube.com/' }] }]);
  const signin = fakeSignin(), signedInBy = [];
  const window = new YouTubeSigninWindow(root, signin, { findExecutable: () => 'C:\\Browsers\\brave.exe', open,
    onSaved: email => signedInBy.push(email), pollMs: 5, settleMs: 5 });
  try {
    await window.init();
    assert.deepEqual(window.status(), { state: 'idle' });
    const started = window.start('owner@example.test');
    assert.equal(started.state, 'opening'); assert.equal(started.browser, 'Brave');
    assert.ok(['opening', 'waiting'].includes(window.start('other@example.test').state));
    await until(() => window.status().state === 'saved');
    assert.equal((await window.cancel()).state, 'saved');
    assert.equal(calls.opened.length, 1);
    assert.equal(calls.opened[0].url, signinUrl);
    assert.equal(signin.saved.length, 1);
    assert.match(signin.saved[0], /synthetic-sid/); assert.doesNotMatch(signin.saved[0], /google-only/);
    assert.equal(window.status().cookies, 4);
    assert.deepEqual(signedInBy, ['owner@example.test']);
    await until(() => window.session === null);
    assert.equal(calls.closed, 1);
    assert.deepEqual(await readdir(join(root, 'youtube-signin-window')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('closing, cancelling, a Google refusal or a timeout ends the attempt without saving anything', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clip-signin-window-'));
  const waiting = [{ cookies: anonymous, pages: [{ url: 'https://accounts.google.com/v3/signin/identifier' }] }];
  const attempt = async (steps, options = {}) => {
    const browser = fakeBrowser(steps), signin = fakeSignin();
    const window = new YouTubeSigninWindow(root, signin, { findExecutable: () => '/usr/bin/google-chrome', open: browser.open,
      pollMs: 5, settleMs: 5, ...options });
    window.start();
    await until(() => browser.calls.handle);
    return { window, signin, calls: browser.calls };
  };
  try {
    const closed = await attempt(waiting);
    closed.calls.handle.exit();
    await until(() => closed.window.status().state === 'failed');
    assert.match(closed.window.status().message, /Chrome window was closed before the YouTube sign-in finished/);

    const cancelled = await attempt(waiting);
    await until(() => cancelled.window.status().state === 'waiting');
    const result = await cancelled.window.cancel();
    assert.equal(result.state, 'cancelled'); assert.equal(cancelled.calls.closed, 1);
    assert.equal(cancelled.window.session, null);
    cancelled.window.current.finished -= 3 * 60_000;
    assert.deepEqual(cancelled.window.status(), { state: 'idle' });

    const refused = await attempt([{ cookies: anonymous, pages: [{ url: 'https://accounts.google.com/v3/signin/rejected?continue=x' }] }]);
    await until(() => refused.window.status().state === 'failed');
    assert.match(refused.window.status().message, /Google refused to sign in/);
    refused.window.current.finished -= 3 * 60_000;
    assert.equal(refused.window.status().state, 'failed');

    const slow = await attempt(waiting, { timeoutMs: 20 });
    await until(() => slow.window.status().state === 'failed');
    assert.match(slow.window.status().message, /without a YouTube sign-in/);

    for (const { signin } of [closed, cancelled, refused, slow]) assert.equal(signin.saved.length, 0);
    await until(async () => (await readdir(join(root, 'youtube-signin-window'))).length === 0);

    const missing = new YouTubeSigninWindow(root, fakeSignin(), { findExecutable: () => null, open: () => assert.fail('no browser') });
    assert.match(missing.start().message, /No Brave, Chrome or Edge browser was found/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Sign in to YouTube works through the studio API and Activity records who opened it and signed in', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clip-signin-api-'));
  const { open, calls } = fakeBrowser([{ cookies: anonymous, pages: [] }, { cookies: signedInCookies, pages: [{ url: 'https://www.youtube.com/' }] }]);
  const app = await createApp({ root, port: 0, config: { python: 'unused', ffmpeg: 'unused' },
    findSigninBrowser: () => 'C:\\Browsers\\brave.exe', openSigninBrowser: open });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const state = () => fetch(`${base}/api/state`).then(r => r.json());
  try {
    const initial = await state();
    const post = path => fetch(base + path, { method: 'POST', headers: { 'X-Studio-Token': initial.token, 'Content-Type': 'application/json' }, body: '{}' });
    const response = await post('/api/youtube-signin/start');
    assert.equal(response.status, 202);
    assert.equal((await response.json()).browser, 'Brave');
    await until(async () => (await state()).settings.youtubeSignin.window.state === 'saved', 20000);
    const after = await state();
    assert.equal(after.settings.youtubeSignin.configured, true);
    assert.equal(after.settings.youtubeSignin.cookies, 4);
    assert.ok(!JSON.stringify(after).includes('synthetic-sid'));
    const actions = after.activity.map(a => a.action);
    assert.ok(actions.includes('Opened YouTube sign-in window'));
    assert.ok(actions.includes('Signed in to YouTube in the sign-in window'));
    assert.equal((await (await post('/api/youtube-signin/cancel')).json()).state, 'saved');
    await until(() => calls.closed === 1);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('a real browser opened for sign-in exposes its cookies over DevTools and closes cleanly', async t => {
  const executable = findBrowser();
  if (!executable) { t.skip('No Chromium-based browser is installed'); return; }
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Set-Cookie': 'probe=synthetic; Path=/; HttpOnly', 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Sign-in probe</title>ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = await mkdtemp(join(tmpdir(), 'clip-signin-real-'));
  let handle;
  try {
    handle = await openBrowser({ executable, profile, url, headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] });
    let cookies = [];
    await until(async () => (cookies = await handle.cookies()).some(c => c.name === 'probe'), 20000);
    const probe = cookies.find(c => c.name === 'probe');
    assert.equal(probe.value, 'synthetic'); assert.equal(probe.httpOnly, true);
    assert.ok((await handle.pages()).some(page => page.url === url));
    await handle.close();
    assert.equal(await Promise.race([handle.exited.then(() => true), sleep(15000).then(() => false)]), true);
  } finally {
    await handle?.close();
    server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
  }
});
