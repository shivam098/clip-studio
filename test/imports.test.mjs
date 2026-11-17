import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { download, liveUrl } from '../src/imports.mjs';

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
