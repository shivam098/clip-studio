import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { download, liveUrl, importRecovery, YouTubeVerificationRequired } from '../src/imports.mjs';
import { YouTubeSignin, youtubeCookies, signinKey } from '../src/youtube-signin.mjs';
import { createApp } from '../src/server.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const config = { python: 'configured-python', ffmpeg: join('tools', 'ffmpeg.exe') };
const source = 'https://www.youtube.com/watch?v=synthetic-fixture';
function assertRuntime(command, args, options) {
  assert.equal(command, config.python);
  assert.ok(args.includes('--no-js-runtimes'));
  assert.equal(args[args.indexOf('--js-runtimes') + 1], `node:${process.execPath}`);
  assert.ok(args.includes('--no-remote-components'));
  assert.ok(!args.some(arg => arg.startsWith('--cookies')));
  assert.equal(options.env.PYTHONUTF8, '1');
  assert.equal(options.env.PYTHONIOENCODING, 'utf-8');
}

test('download uses the application Node executable and local EJS scripts without cookies', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'clip-download-'));
  try {
    await writeFile(join(folder, 'source.mp4'), 'synthetic fixture');
    let calls = 0;
    const output = await download(source, folder, config, undefined, async (...args) => {
      calls++; assertRuntime(...args); return { stdout: '', stderr: '' };
    });
    assert.equal(output, join(folder, 'source.mp4'));
    assert.equal(calls, 1);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('live URL lookup uses the same explicit runtime configuration', async () => {
  const result = await liveUrl(source, config, undefined, async (...args) => {
    assertRuntime(...args); return { stdout: 'https://cdn.example.test/synthetic.m3u8\n' };
  });
  assert.equal(result, 'https://cdn.example.test/synthetic.m3u8');
});

test('YouTube sign-in refusal stops after one call and points to adding a YouTube sign-in', async () => {
  for (const quote of ["'", '\u2019', '\uFFFD']) {
    let calls = 0;
    await assert.rejects(download(source, 'unused', config, undefined, async () => {
      calls++; throw new Error(`ERROR: Sign in to confirm you${quote}re not a bot. Use --cookies-from-browser`);
    }), error => error instanceof YouTubeVerificationRequired && !error.signedIn && /Add a YouTube sign-in \(cookies file\) in Privacy & setup/.test(error.message));
    assert.equal(calls, 1);
  }
});

test('cancellation and unrelated failures retain their original meaning', async () => {
  const cancelled = new Error('User cancelled');
  const controller = new AbortController(); controller.abort(cancelled);
  await assert.rejects(liveUrl(source, config, controller.signal, async () => { throw cancelled; }), error => error === cancelled);
  const network = new Error('Connection timed out');
  await assert.rejects(download(source, 'unused', config, undefined, async () => { throw network; }), error => error === network);
});

const syntheticId = 'Synth_Id-01';
const canonical = `https://www.youtube.com/watch?v=${syntheticId}`;
const refusal = `ERROR: [youtube] ${syntheticId}: Sign in to confirm you’re not a bot`;
const blocked = async () => { throw new Error(refusal); };

test('verification recovery only links to a validated first-party video, never a redirect or extra query data', async () => {
  for (const [url, expected] of [
    [`${canonical}&x=private-value#more`, syntheticId], [`https://youtu.be/${syntheticId}?t=2`, syntheticId],
    [`https://youtube.com/shorts/${syntheticId}`, syntheticId], [`${canonical}&v=SecondVid01`, null],
    ['https://youtube.com/redirect?q=https://example.test', null], ['https://youtube.com/watch?v=not-a-video-id', null],
  ]) {
    await assert.rejects(download(url, 'unused', config, undefined, blocked),
      e => e instanceof YouTubeVerificationRequired && e.videoId === expected);
  }
  await assert.rejects(download('https://vimeo.com/123', 'unused', config, undefined, blocked),
    e => !(e instanceof YouTubeVerificationRequired));
});

test('only recognized old import failures get recovery; never guess a missing or ambiguous video ID', () => {
  const job = { type: 'import', state: 'failed', error: `python.exe exited 1: ${refusal} [remote URL]` };
  assert.deepEqual(importRecovery(job, null), { watchUrl: canonical });
  assert.deepEqual(importRecovery({ ...job, error: refusal + '\n' + refusal.replace(syntheticId, 'SecondVid01') }, null), { watchUrl: null });
  const oldMessage = new YouTubeVerificationRequired(new URL(canonical), new Error('test')).message;
  assert.deepEqual(importRecovery({ ...job, error: oldMessage }, null), { watchUrl: null });
  for (const changes of [{ type: 'render' }, { state: 'cancelled' }, { error: 'Network error' },
    { error: 'The downloader JavaScript runtime is unavailable' }]) {
    assert.equal(importRecovery({ ...job, ...changes }, null), null);
  }
  assert.equal(importRecovery(job, { reason: 'other' }), null);
});

test('a failed import offers recovery only for its workspace, survives reload and can be dismissed without retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clip-recovery-'));
  let calls = 0;
  const app = await createApp({ root, port: 0, config, importVideo: (...args) => {
    calls++; return download(...args, blocked);
  } });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const state = () => fetch(`${base}/api/state`).then(r => r.json());
  try {
    const initial = await state();
    const headers = { 'X-Studio-Token': initial.token, 'Content-Type': 'application/json' };
    const post = (path, body = {}) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    const original = initial.workspaces[0].id;
    const other = (await (await post('/api/workspaces', { name: 'Another workspace', creator: 'Fixture' })).json()).id;
    const { jobId } = await (await post('/api/import', { workspaceId: original, url: `${canonical}&extra=discard-me`, networkConsent: true })).json();
    for (let i = 0; i < 100 && app.jobs.running.size; i++) await sleep(5);
    const failed = (await state()).jobs.find(j => j.id === jobId);
    assert.equal(failed.resource_id, original); assert.equal(failed.state, 'failed');
    assert.deepEqual(failed.recovery, { watchUrl: canonical }); assert.equal(failed.result, null);
    assert.ok(!JSON.stringify(failed).includes('discard-me'));
    assert.equal((await post(`/api/upload?workspace=${other}&recovery=${jobId}&name=test.mp4`)).status, 400);
    assert.equal((await state()).assets.length, 0);
    assert.deepEqual((await state()).jobs[0].recovery, failed.recovery);
    assert.equal((await post(`/api/jobs/${jobId}/dismiss-recovery`)).status, 200);
    const dismissed = (await state()).jobs[0];
    assert.equal(dismissed.state, 'failed'); assert.equal(dismissed.recovery, null); assert.equal(calls, 1);
    assert.equal((await post(`/api/upload?workspace=${original}&recovery=${jobId}&name=test.mp4`)).status, 400);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

const cookieLine = (domain, name, value) => [domain, 'TRUE', '/', 'TRUE', '1900000000', name, value].join('\t');
const exported = ['# Netscape HTTP Cookie File', cookieLine('.youtube.com', 'SID', 'synthetic-sid'),
  `#HttpOnly_${cookieLine('.youtube.com', 'LOGIN_INFO', 'synthetic-login')}`, cookieLine('.google.com', 'SID', 'other-site'),
  cookieLine('.example.com', 'session', 'unrelated'), ''].join('\r\n');
function memoryStore() {
  const settings = new Map();
  return { setting: (key, fallback) => settings.has(key) ? structuredClone(settings.get(key)) : fallback,
    setSetting: (key, value) => settings.set(key, structuredClone(value)) };
}
function memoryVault() {
  const entries = new Map();
  return { has: key => entries.has(key), get: async key => entries.get(key).trim(), put: async (key, value) => { entries.set(key, value); },
    remove: key => entries.delete(key) };
}

test('a YouTube sign-in file keeps only youtube.com cookies and must contain a signed-in session', () => {
  const file = youtubeCookies(exported);
  assert.equal(file.count, 2);
  assert.ok(file.contents.startsWith('# Netscape HTTP Cookie File\n'));
  assert.match(file.contents, /synthetic-sid/); assert.match(file.contents, /#HttpOnly_\.youtube\.com\t.*LOGIN_INFO/);
  assert.doesNotMatch(file.contents, /other-site|unrelated/);
  assert.throws(() => youtubeCookies(''), /Choose the cookies.txt file/);
  assert.throws(() => youtubeCookies('[{"domain":".youtube.com","name":"SID"}]'), /no youtube.com cookies/);
  assert.throws(() => youtubeCookies(cookieLine('.youtube.com', 'PREF', 'signed-out')), /no YouTube sign-in/);
  assert.throws(() => youtubeCookies('#'.repeat(1_000_001)), /up to 1 MB/);
});

test('a saved YouTube sign-in is passed to yt-dlp only through --cookies, and refusals say it was not accepted', async () => {
  let args;
  await liveUrl(source, { ...config, cookieFile: 'signin.txt' }, undefined, async (command, value) => {
    args = value; return { stdout: 'https://cdn.example.test/synthetic.m3u8\n' };
  });
  assert.equal(args[args.indexOf('--cookies') + 1], 'signin.txt');
  assert.equal(args.at(-1), source);
  await assert.rejects(download(source, 'unused', { ...config, cookieFile: 'signin.txt' }, undefined, blocked),
    error => error instanceof YouTubeVerificationRequired && error.signedIn && /fresh cookies file/.test(error.message));
});

test('each YouTube run gets a temporary sign-in copy; rotated cookies are kept unless the sign-in changed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clip-signin-unit-'));
  const vault = memoryVault(), signin = new YouTubeSignin(root, vault, memoryStore());
  try {
    await signin.init();
    assert.deepEqual(signin.status(), { configured: false });
    assert.equal(await signin.use(source, async file => file), null);
    assert.equal((await signin.save(exported)).cookies, 2);
    assert.equal(await signin.use('https://vimeo.com/123', async file => file), null);
    let copy;
    assert.equal(await signin.use(source, async file => {
      copy = file;
      assert.match(await readFile(file, 'utf8'), /synthetic-sid/);
      await writeFile(file, ['# Netscape HTTP Cookie File', cookieLine('.youtube.com', 'SID', 'rotated-sid'),
        cookieLine('.youtube.com', 'LOGIN_INFO', 'synthetic-login'), cookieLine('.google.com', 'NID', 'other-site')].join('\n'));
      return 'done';
    }), 'done');
    await assert.rejects(access(copy));
    assert.match(await vault.get(signinKey), /rotated-sid/); assert.doesNotMatch(await vault.get(signinKey), /other-site/);
    await signin.use(source, async file => {
      await signin.save(exported.replace('synthetic-sid', 'replacement-sid'));
      await writeFile(file, ['# Netscape HTTP Cookie File', cookieLine('.youtube.com', 'SID', 'stale-rotation')].join('\n'));
    });
    assert.match(await vault.get(signinKey), /replacement-sid/);
    await assert.rejects(signin.use(source, async file => { copy = file; throw new Error('blocked'); }), /blocked/);
    await assert.rejects(access(copy));
    await writeFile(join(root, 'youtube-signin', 'left-by-crash.txt'), 'x');
    await signin.init();
    assert.deepEqual(await readdir(join(root, 'youtube-signin')), []);
    assert.deepEqual(await signin.remove(), { configured: false });
    assert.equal(await signin.use(source, async file => file), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the studio saves a YouTube sign-in without exposing it and uses it only for YouTube imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clip-signin-'));
  const seen = [];
  const app = await createApp({ root, port: 0, config, importVideo: async (url, folder, options, signal) => {
    seen.push({ url, file: options.cookieFile ?? null, contents: options.cookieFile ? await readFile(options.cookieFile, 'utf8') : null });
    return download(url, folder, options, signal, blocked);
  } });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const state = () => fetch(`${base}/api/state`).then(r => r.json());
  const settled = async jobId => {
    for (let i = 0; i < 300; i++) {
      const job = (await state()).jobs.find(j => j.id === jobId);
      if (!['queued', 'running'].includes(job.state)) return job;
      await sleep(50);
    }
    throw new Error('Import did not finish');
  };
  try {
    const initial = await state();
    assert.equal(initial.settings.youtubeSignin.configured, false);
    assert.equal(initial.settings.youtubeSignin.window.state, 'idle');
    const headers = { 'X-Studio-Token': initial.token, 'Content-Type': 'application/json' };
    const post = (path, body = {}) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await post('/api/youtube-signin', { cookies: 'not a cookies file' })).status, 400);
    const saved = await (await post('/api/youtube-signin', { cookies: exported })).json();
    assert.equal(saved.configured, true); assert.equal(saved.cookies, 2);
    const after = await state();
    assert.ok(!JSON.stringify(after).includes('synthetic-sid'));
    assert.ok(after.activity.some(a => a.action === 'Saved YouTube sign-in' && a.status === 200));
    const workspaceId = after.workspaces[0].id;
    const youtube = await settled((await (await post('/api/import', { workspaceId, url: canonical, networkConsent: true })).json()).jobId);
    assert.match(seen[0].contents, /synthetic-sid/); assert.doesNotMatch(seen[0].contents, /other-site|unrelated/);
    await assert.rejects(access(seen[0].file));
    assert.deepEqual(youtube.recovery, { watchUrl: canonical, signedIn: true });
    assert.equal(youtube.error, 'YouTube did not accept the saved YouTube sign-in.');
    await settled((await (await post('/api/import', { workspaceId, url: 'https://vimeo.com/123', networkConsent: true })).json()).jobId);
    assert.equal(seen[1].file, null);
    assert.deepEqual(await (await post('/api/youtube-signin/remove')).json(), { configured: false });
    assert.equal((await state()).settings.youtubeSignin.configured, false);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
