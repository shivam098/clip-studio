import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Providers } from '../src/providers.mjs';

async function fixture(fn) {
  const folder = await mkdtemp(join(tmpdir(), 'clip-provider-'));
  try {
    const output = join(folder, 'synthetic.mp4'); await writeFile(output, 'synthetic-test-not-real-video');
    await fn({ output, metadata: { title: 'Synthetic', description: 'test', privacy: 'private', duration: 12 } });
  } finally { await rm(folder, { recursive: true, force: true }); }
}

test('YouTube stores resumable session before sending video bytes and reconciles without reupload', async () => fixture(async publication => {
  let reference, requests = [];
  const providers = new Providers({ fetcher: async (url, options) => {
    requests.push({ url, method: options.method });
    if (requests.length === 1) return new Response(null, { headers: { Location: 'https://www.googleapis.com/upload/test-session' } });
    assert.ok(reference.session);
    if (options.body) { for await (const chunk of options.body) assert.ok(chunk.length); }
    if (requests.length === 2) throw new Error('Lost final response');
    assert.equal(options.headers['Content-Range'].startsWith('bytes */'), true);
    assert.equal(options.body, undefined);
    return Response.json({ id: 'existing-video' });
  } });
  await assert.rejects(providers.upload(publication, { platform: 'youtube' }, 'test', value => { reference = value; }, new AbortController().signal));
  const result = await providers.reconcile({ ...publication, provider_ref: reference }, { platform: 'youtube' }, 'test');
  assert.equal(result.id, 'existing-video'); assert.equal(requests.filter(r => r.method === 'POST').length, 1);
}));

test('provider response cannot redirect credentials to a different upload host', async () => fixture(async publication => {
  let count = 0;
  const providers = new Providers({ fetcher: async () => { count++; return new Response(null, { headers: { Location: 'https://attacker.example/upload' } }); } });
  await assert.rejects(providers.upload(publication, { platform: 'youtube' }, 'test', () => {}, new AbortController().signal), /unexpected upload host/);
  assert.equal(count, 1);
}));

test('Instagram durable container precedes upload and publish; reconciliation only queries', async () => fixture(async publication => {
  let reference, calls = [];
  const providers = new Providers({ wait: async () => {}, fetcher: async (url, options) => {
    calls.push(url);
    if (url.endsWith('/123/media')) return Response.json({ id: '456' });
    assert.equal(reference.containerId, '456');
    if (url.includes('rupload')) { for await (const chunk of options.body) assert.ok(chunk.length); return Response.json({ success: true }); }
    if (url.endsWith('/media_publish')) throw new Error('Ambiguous publish response');
    return Response.json({ status_code: calls.length > 4 ? 'PUBLISHED' : 'FINISHED' });
  } });
  const account = { platform: 'instagram', config: { version: 'v24.0', userId: '123' } };
  await assert.rejects(providers.upload(publication, account, 'test', value => { reference = value; }, new AbortController().signal), /Ambiguous/);
  assert.equal(reference.phase, 'publishing');
  const result = await providers.reconcile({ ...publication, provider_ref: reference }, account, 'test');
  assert.equal(result.state, 'succeeded');
  assert.equal(calls.filter(url => url.endsWith('/media_publish')).length, 1);
}));

test('TikTok validates creator privacy and saves publish ID before uploading bytes', async () => fixture(async publication => {
  let reference;
  publication.metadata.privacy = 'SELF_ONLY';
  const providers = new Providers({ fetcher: async (url, options) => {
    if (url.includes('creator_info')) return Response.json({ error: { code: 'ok' }, data: { privacy_level_options: ['SELF_ONLY'], max_video_post_duration_sec: 60 } });
    if (url.includes('/video/init/')) return Response.json({ error: { code: 'ok' }, data: { publish_id: 'p-123', upload_url: 'https://open-upload.tiktokapis.com/video/?upload_id=synthetic' } });
    if (url.includes('status/fetch')) return Response.json({ error: { code: 'ok' }, data: { status: 'PUBLISH_COMPLETE' } });
    assert.equal(reference.publishId, 'p-123');
    for await (const chunk of options.body) assert.ok(chunk.length);
    return new Response(null, { status: 201 });
  } });
  const result = await providers.upload(publication, { platform: 'tiktok' }, 'test', value => { reference = value; }, new AbortController().signal);
  assert.equal(result.state, 'processing');
  assert.equal((await providers.reconcile({ ...publication, provider_ref: reference }, { platform: 'tiktok' }, 'test')).state, 'succeeded');
}));

test('provider account identities come from authenticated primary responses', async () => {
  const requests = [];
  const providers = new Providers({ fetcher: async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
    assert.equal(options.method, 'GET'); requests.push(url);
    if (url.includes('/channels')) return Response.json({ items: [{ id: 'yt-123', snippet: { title: 'Synthetic channel' } }] });
    if (url.includes('graph.facebook')) return Response.json({ id: '456', username: 'synthetic-ig' });
    return Response.json({ data: { user: { open_id: 'tt-789', display_name: 'Synthetic TikTok' } }, error: { code: 'ok' } });
  } });
  assert.equal((await providers.identify({ platform: 'youtube' }, 'synthetic-token')).id, 'yt-123');
  assert.equal((await providers.identify({ platform: 'instagram', config: { version: 'v24.0', userId: '456' } }, 'synthetic-token')).id, '456');
  assert.equal((await providers.identify({ platform: 'tiktok' }, 'synthetic-token')).id, 'tt-789');
  assert.equal(requests.length, 3);
});
