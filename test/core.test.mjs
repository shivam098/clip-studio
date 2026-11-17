import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store, id, json, parse } from '../src/store.mjs';
import { Jobs, AnalysisLeases } from '../src/jobs.mjs';
import { Publishing } from '../src/publishing.mjs';
import { run } from '../src/process.mjs';
import { validateSegments, selectMoments, subtitles } from '../src/media.mjs';
import { suggestions, modelEndpoint } from '../src/analysis.mjs';
import { supportedUrl } from '../src/imports.mjs';

function seed(store) {
  const workspace = store.get('SELECT id FROM workspaces').id;
  store.run('INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?)', 'asset', workspace, 'Synthetic', 'synthetic.mp4', 60, 1280, 720, 1, 0);
  store.run('INSERT INTO clips(id,asset_id,name,start,end,output,created) VALUES (?,?,?,?,?,?,?)', 'clip', 'asset', 'Clip', 0, 30, 'render.mp4', 0);
  store.run('INSERT INTO accounts VALUES (?,?,?,?,?,?,?)', 'account', 'youtube', 'Test account', '{}', 1, 60, 2);
  store.run('INSERT INTO account_bindings VALUES (?,?,?,?,?)', 'account', 'youtube', 'destination', 'Synthetic channel', 1);
  store.setSetting('publishingEnabled', true);
}
function enqueue(store, suffix, when = 0) {
  store.run('INSERT INTO publications(id,account_id,clip_id,scheduled,state,metadata,output,created) VALUES (?,?,?,?,?,?,?,?)',
    suffix, 'account', 'clip', when, 'scheduled', '{"destinationId":"destination"}', 'render.mp4', 0);
}
const vault = { has: () => true, get: async () => 'synthetic-token' };
const testPublishing = (store, providers, testVault, clock) => new Publishing(store,
  { identify: async () => ({ id: 'destination' }), ...providers }, testVault, clock);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('cancel rejects a late successful render and never invokes its commit callback', async () => {
  const store = new Store(':memory:'), jobs = new Jobs(store), gate = deferred();
  let attached = 0, published = 0;
  const jobId = jobs.create('render', 'clip');
  const work = jobs.start(jobId, () => gate.promise, { commit: () => { attached++; published++; } });
  jobs.cancel(jobId); gate.resolve({ output: 'late.mp4' }); await work;
  assert.equal(store.get('SELECT state FROM jobs WHERE id=?', jobId).state, 'cancelled');
  assert.equal(attached, 0); assert.equal(published, 0); assert.equal(jobs.running.size, 0);
  store.close();
});

test('timeout aborts work, holds ownership until settlement and rejects late callbacks', async () => {
  const store = new Store(':memory:'), jobs = new Jobs(store), gate = deferred();
  let signal, published = 0;
  const jobId = jobs.create('render', 'clip');
  const work = jobs.start(jobId, ctx => { signal = ctx.signal; return gate.promise; }, { timeout: 10, commit: () => published++ });
  await sleep(30);
  assert.equal(signal.aborted, true);
  assert.equal(jobs.running.size, 1);
  gate.resolve({ output: 'late.mp4' }); await work;
  assert.equal(store.get('SELECT state FROM jobs').state, 'timed_out');
  assert.equal(published, 0); store.close();
});

test('old attempt cannot attach results after another attempt takes its row', async () => {
  const store = new Store(':memory:'), jobs = new Jobs(store), first = deferred(), second = deferred();
  const jobId = jobs.create('render', 'clip');
  const results = [];
  const older = jobs.start(jobId, () => first.promise, { commit: result => results.push(result) });
  store.run("UPDATE jobs SET state='queued' WHERE id=?", jobId);
  const newer = jobs.start(jobId, () => second.promise, { commit: result => results.push(result) });
  first.resolve('old'); await older;
  assert.equal(jobs.running.size, 1);
  assert.equal(store.get('SELECT state FROM jobs').state, 'running');
  second.resolve('new'); await newer;
  assert.deepEqual(results, ['new']); store.close();
});

test('overlapping analysis keeps every buffer leased; older completion cannot clear replacement', async () => {
  const store = new Store(':memory:'), leases = new AnalysisLeases(store), old = deferred(), latest = deferred();
  const a = leases.run('stream', ['a', 'shared'], () => old.promise);
  const b = leases.run('stream', ['b', 'shared'], () => latest.promise);
  const newerOwner = leases.current.get('stream');
  old.resolve(); await a;
  assert.equal(leases.current.get('stream'), newerOwner);
  assert.equal(leases.tasks.size, 1);
  assert.equal(leases.canDelete('shared'), false);
  assert.equal(leases.canDelete('a'), true);
  latest.resolve(); await b;
  assert.equal(leases.canDelete('shared'), true); store.close();
});

test('timed-out analysis retains buffer until ignored abort actually settles', async () => {
  const store = new Store(':memory:'), leases = new AnalysisLeases(store), jobs = new Jobs(store), gate = deferred();
  const jobId = jobs.create('analyze', 'asset');
  const task = leases.run('stream', ['buffer'], () => jobs.start(jobId, () => gate.promise, { timeout: 10 }));
  await sleep(30);
  assert.equal(leases.canDelete('buffer'), false);
  gate.resolve(); await task; assert.equal(leases.canDelete('buffer'), true); store.close();
});

test('dispatch intent is committed and visible to another connection before external side effect', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'clip-store-'));
  const path = join(folder, 'test.sqlite'), store = new Store(path);
  try {
    seed(store); enqueue(store, 'post');
    let sends = 0;
    const scheduler = testPublishing(store, { upload: async (p, a, token, checkpoint) => {
      const observer = new Store(path);
      assert.equal(observer.get('SELECT state FROM publications WHERE id=?', p.id).state, 'dispatching');
      assert.equal(observer.get('SELECT COUNT(*) AS n FROM dispatches').n, 1);
      observer.close(); sends++;
      checkpoint({ session: 'provider-session-123' });
      throw new Error('Ambiguous connection loss after provider accepted upload');
    } }, vault, () => 100000);
    await scheduler.tick(); await scheduler.tick();
    assert.equal(sends, 1);
    assert.equal(store.get('SELECT state FROM publications').state, 'uncertain');
    assert.equal(parse(store.get('SELECT provider_ref FROM publications').provider_ref).session, 'provider-session-123');
  } finally { store.close(); await rm(folder, { recursive: true, force: true }); }
});

test('restart changes in-flight dispatch to uncertain; it never resubmits blindly', async () => {
  const store = new Store(':memory:'); seed(store); enqueue(store, 'post');
  let calls = 0;
  const scheduler = testPublishing(store, { upload: async () => { calls++; } }, vault, () => 100000);
  assert.ok(scheduler.claim('post')); store.recover(); await scheduler.tick();
  assert.equal(calls, 0); assert.equal(store.get('SELECT state FROM publications').state, 'uncertain'); store.close();
});

test('provider identifier arriving after cancellation is preserved without continuing upload', async () => {
  const store = new Store(':memory:'); seed(store); enqueue(store, 'post');
  const gate = deferred(); let uploaded = 0;
  const scheduler = testPublishing(store, { upload: async (p, a, t, checkpoint) => {
    await gate.promise; checkpoint({ publishId: 'remote-job' }); uploaded++;
    return { state: 'succeeded' };
  } }, vault, () => 100000);
  const dispatch = scheduler.dispatch('post');
  await sleep(0); scheduler.cancel('post'); gate.resolve(); await dispatch;
  assert.equal(uploaded, 0);
  const row = store.get('SELECT state,provider_ref FROM publications');
  assert.equal(row.state, 'uncertain'); assert.equal(parse(row.provider_ref).publishId, 'remote-job'); store.close();
});

test('dispatch rechecks rolling caps and spacing after pause and scheduler replacement', async () => {
  const store = new Store(':memory:'); seed(store);
  for (let i = 0; i < 5; i++) enqueue(store, `post${i}`);
  let time = 100000, sends = 0;
  const providers = { upload: async () => { sends++; return { state: 'succeeded' }; } };
  const scheduler = testPublishing(store, providers, vault, () => time);
  store.setSetting('publishingEnabled', false); await scheduler.tick(); assert.equal(sends, 0);
  store.setSetting('publishingEnabled', true); await scheduler.tick(); assert.equal(sends, 1);
  time += 59999; await scheduler.tick(); assert.equal(sends, 1);
  time++; const restarted = testPublishing(store, providers, vault, () => time);
  await restarted.tick(); assert.equal(sends, 2);
  time += 60000; await restarted.tick(); assert.equal(sends, 2);
  time += 86400000; await restarted.tick(); assert.equal(sends, 3); store.close();
});

test('new account policy is enforced at dispatch, not only scheduling', async () => {
  const store = new Store(':memory:'); seed(store); enqueue(store, 'one'); enqueue(store, 'two');
  let time = 100000, sends = 0;
  const scheduler = testPublishing(store, { upload: async () => { sends++; return { state: 'succeeded' }; } }, vault, () => time);
  await scheduler.dispatch('one');
  store.run('UPDATE accounts SET spacing=3600,daily_cap=1');
  time += 3600001; await scheduler.dispatch('two'); assert.equal(sends, 1); store.close();
});

test('slow publication completion does not collapse spacing before the next dispatch', async () => {
  const store = new Store(':memory:'); seed(store); enqueue(store, 'one'); enqueue(store, 'two');
  let time = 100000, sends = 0;
  const scheduler = testPublishing(store, { upload: async () => {
    sends++; time += 300000; return { state: 'succeeded' };
  } }, vault, () => time);
  await scheduler.dispatch('one');
  await scheduler.dispatch('two'); assert.equal(sends, 1);
  time += 60000; await scheduler.dispatch('two'); assert.equal(sends, 2); store.close();
});

test('unknown outcome blocks later posts on the same account', async () => {
  const store = new Store(':memory:'); seed(store); enqueue(store, 'one'); enqueue(store, 'two');
  let time = 100000, sends = 0;
  const scheduler = testPublishing(store, { upload: async () => { sends++; throw new Error('Lost response'); } }, vault, () => time);
  await scheduler.tick(); time += 86400001; await scheduler.tick();
  assert.equal(sends, 1); assert.equal(store.get("SELECT state FROM publications WHERE id='two'").state, 'scheduled'); store.close();
});

test('cancelled scheduled post has no external side effect', async () => {
  const store = new Store(':memory:'); seed(store); enqueue(store, 'one'); let sends = 0;
  const scheduler = testPublishing(store, { upload: async () => { sends++; } }, vault, () => 100000);
  scheduler.cancel('one'); await scheduler.tick(); assert.equal(sends, 0); store.close();
});

test('recovery does not release leases potentially held by an orphaned process', () => {
  const store = new Store(':memory:');
  store.run('INSERT INTO leases VALUES (?,?)', 'old-owner', 'buffer'); store.recover();
  assert.equal(new AnalysisLeases(store).canDelete('buffer'), false); store.close();
});

test('authenticated account mismatch causes zero upload calls', async () => {
  const store = new Store(':memory:'); seed(store); enqueue(store, 'one');
  let uploaded = 0;
  const scheduler = testPublishing(store, { identify: async () => ({ id: 'wrong-channel' }),
    upload: async () => { uploaded++; return { state: 'succeeded' }; } }, vault, () => 100000);
  await scheduler.dispatch('one');
  assert.equal(uploaded, 0);
  assert.match(store.get('SELECT error FROM publications').error, /no upload was started/);
  store.close();
});

test('cancellation during identity lookup never starts an upload', async () => {
  const store = new Store(':memory:'); seed(store); enqueue(store, 'one');
  const gate = deferred(); let uploaded = 0;
  const scheduler = testPublishing(store, { identify: () => gate.promise,
    upload: async () => { uploaded++; return { state: 'succeeded' }; } }, vault, () => 100000);
  const work = scheduler.dispatch('one'); await sleep(0);
  scheduler.cancel('one'); gate.resolve({ id: 'destination' }); await work;
  assert.equal(uploaded, 0); store.close();
});

test('process cancellation terminates the actual process tree before returning', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'clip-child-')), file = join(folder, 'pids.json');
  const controller = new AbortController();
  const code = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(file)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
  const work = run(process.execPath, ['-e', code], { signal: controller.signal });
  const rejected = assert.rejects(work, /Stop now/);
  try {
    let pids;
    for (let n = 0; n < 100; n++) {
      try { pids = JSON.parse(await readFile(file, 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; await sleep(20); }
    }
    assert.ok(pids, 'child started');
    controller.abort(new Error('Stop now')); await rejected; await sleep(100);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { controller.abort(new Error('Stop now')); await rejected; await rm(folder, { recursive: true, force: true }); }
});

test('caption validation rejects impossible intervals; ASS escapes injected formatting', () => {
  assert.throws(() => validateSegments([{ start: 5, end: 4, text: 'wrong' }], 10));
  assert.throws(() => validateSegments([{ start: 0, end: 12, text: 'too long' }], 10));
  const ass = subtitles({ start: 10, end: 15, hook: '{\\pos(1,1)}', captions: [{ start: 9, end: 11, text: 'hello' }] });
  assert.ok(ass.includes('0:00:00.00,0:00:01.00,Caption'));
  assert.ok(!ass.includes('{\\pos'));
});

test('fallback honestly selects windows without invoking any remote provider', async () => {
  let requests = 0;
  const result = await suggestions([], 65, null, null, new AbortController().signal, () => { requests++; });
  assert.equal(requests, 0); assert.match(result.method, /not AI/);
  assert.equal(result.moments.at(-1).end, 65);
  assert.ok(selectMoments([{ start: 0, end: 8, text: 'Why does this save time?' }], 20).length);
});

test('model request contains transcript only and invalid model output is rejected', async () => {
  let request;
  const fetcher = async (url, options) => { request = JSON.parse(options.body); return Response.json({ choices: [{ message: {
    content: json({ moments: [{ start: 0, end: 9999, title: 'Bad', reason: 'outside source' }] }),
  } }] }); };
  await assert.rejects(suggestions([{ start: 0, end: 3, text: 'hello' }], 30,
    { endpoint: 'https://example.com/v1/chat/completions', model: 'test' }, 'test', new AbortController().signal, fetcher), /invalid clip/);
  assert.ok(request.messages[1].content.includes('transcript'));
  assert.ok(!JSON.stringify(request).includes('image_url'));
  assert.throws(() => modelEndpoint('http://remote.example/v1/chat/completions'));
});

test('URL import rejects local paths, private endpoints, URL credentials and unsupported hosts', () => {
  for (const value of ['file:///C:/secret', 'http://localhost:4396', 'https://127.0.0.1/video', 'https://user:pass@youtube.com/watch?v=x', 'https://example.com/v.mp4']) assert.throws(() => supportedUrl(value));
  assert.equal(supportedUrl('https://www.youtube.com/watch?v=example'), 'https://www.youtube.com/watch?v=example');
});
