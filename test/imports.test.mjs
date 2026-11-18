import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { download, liveUrl, importRecovery, YouTubeVerificationRequired } from '../src/imports.mjs';
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

test('YouTube sign-in refusal stops after one call and explains the supported local-file path', async () => {
  for (const quote of ["'", '\u2019', '\uFFFD']) {
    let calls = 0;
    await assert.rejects(download(source, 'unused', config, undefined, async () => {
      calls++; throw new Error(`ERROR: Sign in to confirm you${quote}re not a bot. Use --cookies-from-browser`);
    }), /No browser cookies were read and no automatic retry was made.*Use Upload/);
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
