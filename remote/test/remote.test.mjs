import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createEditor } from '../server.mjs';
import { checkLease } from '../operator.mjs';
import { destination, isQuickOrigin, leaseMs, pagesOrigin, readSmallJson, signature } from '../pages/link-policy.js';

test('lease keeper adopts without a write, renews only timestamps near expiry, then skips another build', async () => {
  const binding = { origin: 'https://test-clip.trycloudflare.com', instance: 'test-boot' };
  const issuedAt = 1000000000;
  const original = { version: 1, status: 'online', origin: binding.origin, issuedAt, expiresAt: issuedAt + leaseMs };
  let published = original, at = issuedAt, writes = 0, checks = 0;
  const ops = {
    now: () => at, verify: async value => { assert.deepEqual(value, binding); checks++; },
    read: () => ({ text: JSON.stringify(published), replace(next) { writes++; published = next; } }),
  };
  assert.equal((await checkLease(binding, ops)).renewed, false);
  assert.equal(writes, 0);
  at = original.expiresAt - 59 * 60000;
  assert.equal((await checkLease(binding, ops)).renewed, true);
  assert.deepEqual(published, { ...original, issuedAt: at, expiresAt: at + leaseMs });
  assert.equal((await checkLease(binding, ops)).renewed, false);
  assert.equal(writes, 1); assert.equal(checks, 3);
});

test('lease keeper cannot republish an expired, offline, replaced, or unverified share', async () => {
  const origin = 'https://test-clip.trycloudflare.com', at = 1000000000, binding = { origin, instance: 'test-boot' };
  const online = { version: 1, status: 'online', origin, issuedAt: at - 60000, expiresAt: at + 1000 };
  let writes = 0;
  const attempt = (pointer, verify, now = () => at) => checkLease(binding, { now, verify,
    read: () => ({ text: JSON.stringify(pointer), replace() { writes++; } }),
  });
  const noProbe = () => assert.fail('Unexpected probe');
  for (const bad of [{ version: 1, status: 'offline' }, { ...online, origin: 'https://other.trycloudflare.com' },
    { ...online, expiresAt: at }, { ...online, extra: true }]) {
    await assert.rejects(attempt(bad, noProbe), /lease changed, expired, or went offline/);
  }
  await assert.rejects(attempt(online, async () => { throw new Error('Public health failed'); }), /Public health failed/);
  let time = at;
  await assert.rejects(attempt(online, async () => { time = online.expiresAt; }, () => time), /lease changed, expired, or went offline/);
  assert.equal(writes, 0);
});

test('only an exact HTTPS Quick Tunnel origin in a current bounded lease can be opened', () => {
  const origin = 'https://desk-green.trycloudflare.com', now = 1000000000;
  const online = { version: 1, status: 'online', issuedAt: now, expiresAt: now + leaseMs, origin };
  assert.equal(destination(online, now), origin);
  assert.equal(destination({ version: 1, status: 'offline' }), null);
  for (const bad of [null, {}, { ...online, extra: 1 }, { ...online, issuedAt: now + 1 },
    { ...online, expiresAt: now }, { ...online, expiresAt: now + leaseMs + 1 }, { ...online, version: 2 }]) {
    assert.throws(() => destination(bad, now));
  }
  for (const bad of ['http://desk.trycloudflare.com', 'https://trycloudflare.com', origin + '.example',
    origin + '/', origin + ':443', origin + '?to=foo', origin + '#foo', origin + '\n',
    'https://desk.trycloudflare.com@elsewhere.example', 'https://two.labels.trycloudflare.com',
    'https://-invalid.trycloudflare.com', `https://${'a'.repeat(64)}.trycloudflare.com`]) {
    assert.equal(isQuickOrigin(bad), false);
    assert.throws(() => destination({ ...online, origin: bad }, now));
  }
});

test('pointer reader rejects redirects, wrong MIME, and streamed oversize data without content-length', async t => {
  let followed = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/followed' }); return res.end(); }
    if (req.url === '/followed') followed = true;
    res.setHeader('content-type', req.url === '/html' ? 'text/html' : 'application/json');
    res.write(' ');
    res.end(req.url === '/large' ? ' '.repeat(1024) + '{}' : '{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/redirect', '/html', '/large']) await assert.rejects(readSmallJson(base + route));
  assert.deepEqual(await readSmallJson(base + '/ok'), {});
  assert.equal(followed, false);
});

test('isolated read-only origin serves only static resources and the current exact pinned host', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'clip-editor-test-')), pin = join(temp, 'pin.json');
  await writeFile(pin, '{}');
  const server = createEditor(pin);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true }); });
  const local = `127.0.0.1:${server.address().port}`, publicHost = 'synthetic-only.trycloudflare.com';
  const request = (path, method = 'GET', headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', b => chunks.push(b));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end();
  });
  for (const path of ['/', '/editor.css', '/editor.js']) assert.equal((await request(path)).status, 200);
  for (const path of ['/mediabunny.js', '/mediabunny-license.txt']) assert.equal((await request(path, 'HEAD')).status, 200);
  const health = await request('/health');
  assert.deepEqual(JSON.parse(health.body), signature);
  assert.match(health.headers['content-security-policy'], /connect-src 'none'/);
  assert.equal((await request('/', 'HEAD')).body, '');
  for (const path of ['/api/state', '/api/jobs', '/api/config', '/api/accounts', '/api/live', '/media/sample',
    '/state/pin.json', '/server.mjs', '/operator.mjs', '/.git/HEAD', '/%2e%2e/server.mjs', '/?url=test']) {
    const res = await request(path); assert.equal(res.status, 404); assert.equal(res.body, '');
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await request('/', method)).status, 405);
  assert.equal((await request('/health', 'GET', { Origin: pagesOrigin })).status, 403);
  assert.equal((await request('/health', 'GET', { Host: publicHost, 'X-Forwarded-Host': local })).status, 421);
  const origin = `https://${publicHost}`, instance = health.headers['x-clip-editor-instance'];
  await writeFile(pin, JSON.stringify({ origin, instance: 'earlier-run' })); await delay(550);
  assert.equal((await request('/', 'GET', { Host: publicHost })).status, 421);
  await writeFile(pin, JSON.stringify({ origin, instance })); await delay(550);
  const probe = await request('/health', 'GET', { Host: publicHost, Origin: pagesOrigin });
  assert.equal(probe.status, 200);
  assert.equal(probe.headers['access-control-allow-origin'], pagesOrigin);
  assert.deepEqual(JSON.parse(probe.body), signature);
  assert.equal((await request('/', 'GET', { Host: publicHost, Origin: origin })).status, 200);
  assert.equal((await request('/', 'GET', { Host: publicHost, Origin: pagesOrigin })).status, 403);
  assert.equal((await request('/health', 'GET', { Host: publicHost, Origin: 'https://example.org' })).status, 403);
  assert.equal((await request('/', 'GET', { Host: 'other.trycloudflare.com', 'X-Forwarded-Host': publicHost })).status, 421);
  await writeFile(pin, '{'); await delay(550);
  assert.equal((await request('/', 'GET', { Host: publicHost })).status, 421);
});
