import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../src/server.mjs';

test('actual HTTP app serves UI, gates mutations and defaults all egress off', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clip-http-'));
  const app = await createApp({ root, port: 0 });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const home = await fetch(url);
    assert.match(await home.text(), /Make the moment matter/);
    assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const state = await (await fetch(`${url}/api/state`)).json();
    assert.equal(state.settings.publishingEnabled, false);
    assert.equal(state.settings.ai, null);
    assert.equal((await fetch(`${url}/api/workspaces`, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await fetch(`${url}/api/state`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const headers = { 'X-Studio-Token': state.token, 'Content-Type': 'application/json' };
    const workspace = await fetch(`${url}/api/workspaces`, { method: 'POST', headers, body: JSON.stringify({ name: 'Creator A', creator: 'A' }) });
    assert.equal(workspace.status, 201);
    assert.equal((await fetch(`${url}/api/import`, { method: 'POST', headers, body: JSON.stringify({ workspaceId: state.workspaces[0].id, url: 'https://youtube.com/watch?v=x' }) })).status, 400);
    const badClip = await fetch(`${url}/api/clips`, { method: 'POST', headers, body: '{}' });
    assert.equal(badClip.status, 400);
    await assert.rejects(createApp({ root, port: 0 }), /already in use/);
    assert.equal((await fetch(`${url}/api/health`)).status, 200);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('failed media upload is removed rather than admitted as a video', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clip-upload-'));
  const app = await createApp({ root, port: 0, config: { ffprobe: 'missing-ffprobe-for-test' } });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const state = await (await fetch(`${url}/api/state`)).json();
    const response = await fetch(`${url}/api/upload?workspace=${state.workspaces[0].id}&name=synthetic.mp4`,
      { method: 'POST', headers: { 'X-Studio-Token': state.token }, body: 'not video' });
    assert.equal(response.status, 400);
    assert.equal(app.store.get('SELECT COUNT(*) AS n FROM assets').n, 0);
    assert.deepEqual(await readdir(join(root, 'uploads')), []);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('actual app keeps manual live clipping usable while replaced model analyses are slow', async () => {
  const pending = [];
  const model = http.createServer(async (req, res) => {
    for await (const chunk of req) assert.ok(chunk.length);
    pending.push(res);
  });

  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'clip-slow-model-'));
  const app = await createApp({ root, port: 0 });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const state = await (await fetch(`${url}/api/state`)).json(), workspace = state.workspaces[0].id;
    const post = async (path, data = {}) => {
      const response = await fetch(url + path, { method: 'POST',
        headers: { 'X-Studio-Token': state.token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      assert.ok(response.ok, await response.clone().text()); return response.json();
    };
    app.store.run('INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?)', 'buffer', workspace, 'Synthetic buffer', 'not-used.mp4', 30, 640, 360, 1, 0);
    app.store.run('INSERT INTO transcripts VALUES (?,?,?)', 'buffer', '[{"start":0,"end":10,"text":"Synthetic explanation"}]', 'test fixture');
    app.store.run('INSERT INTO live_sessions(id,workspace_id,name,state,path,created) VALUES (?,?,?,?,?,?)', 'live', workspace, 'Synthetic live', 'recording', root, 0);
    app.store.run('INSERT INTO live_segments VALUES (?,?,?,?,?)', 'segment', 'live', 'not-used.mp4', 'buffer', 0);
    await post('/api/settings', { ai: { endpoint: `http://127.0.0.1:${model.address().port}/v1/chat/completions`, model: 'synthetic', enabled: true } });
    const old = await post('/api/assets/buffer/analyze', { method: 'model' });
    const newer = await post('/api/assets/buffer/analyze', { method: 'model' });
    const newerOwner = app.leases.current.get('live');
    const manual = await post('/api/clips', { assetId: 'buffer', name: 'Manual while AI waits', start: 0, end: 5, framing: 'fit' });
    assert.ok(manual.id); assert.equal(app.leases.tasks.size, 2);
    for (let i = 0; i < 100 && pending.length < 2; i++) await sleep(10);
    assert.equal(pending.length, 2);
    await post(`/api/jobs/${old.jobId}/cancel`);
    for (let i = 0; i < 100 && app.leases.tasks.size > 1; i++) await sleep(10);
    assert.equal(app.leases.tasks.size, 1);
    assert.equal(app.leases.current.get('live'), newerOwner);
    assert.equal(app.leases.canDelete('buffer'), false);
    pending[1].writeHead(200, { 'Content-Type': 'application/json' });
    pending[1].end(JSON.stringify({ choices: [{ message: { content: '{"moments":[{"start":0,"end":10,"title":"Test","reason":"Synthetic"}]}' } }] }));
    for (let i = 0; i < 100 && app.leases.tasks.size; i++) await sleep(10);
    assert.equal(app.store.get('SELECT state FROM jobs WHERE id=?', newer.jobId).state, 'succeeded');
    assert.equal(app.leases.canDelete('buffer'), true);
    assert.equal(app.store.get('SELECT COUNT(*) AS n FROM publications').n, 0);
  } finally {
    await app.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('verified destinations are unique and token replacement cannot retarget existing approvals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clip-identity-'));
  let destination = 'destination-one', reads = 0, expectedToken = 'synthetic-only-test-token';
  const app = await createApp({ root, port: 0, providers: {
    identify: async (account, token) => {
      assert.equal(token, expectedToken);
      reads++; return { id: destination, displayName: 'Synthetic account' };
    },
  } });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const state = await (await fetch(`${url}/api/state`)).json();
    const post = (path, data) => fetch(url + path, { method: 'POST',
      headers: { 'X-Studio-Token': state.token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const data = { platform: 'youtube', name: 'Synthetic label', token: 'synthetic-only-test-token', spacing: 60, dailyCap: 2 };
    const created = await post('/api/accounts', data);
    assert.equal(created.status, 201, await created.clone().text());
    const account = await created.json();
    assert.equal(reads, 0, 'saving a token does not contact a provider');
    assert.equal((await post(`/api/accounts/${account.id}`, { enabled: true })).status, 400);
    const verified = await post(`/api/accounts/${account.id}/verify`, { networkConsent: true });
    assert.equal(verified.status, 200, await verified.clone().text());
    assert.equal((await post(`/api/accounts/${account.id}`, { enabled: true })).status, 200);
    const duplicate = await (await post('/api/accounts', data)).json();
    assert.equal((await post(`/api/accounts/${duplicate.id}/verify`, { networkConsent: true })).status, 400);
    await post(`/api/accounts/${account.id}`, { token: 'replacement-synthetic-token' });
    expectedToken = 'replacement-synthetic-token';
    assert.equal(app.store.get('SELECT enabled FROM accounts WHERE id=?', account.id).enabled, 0);
    destination = 'different-channel';
    assert.equal((await post(`/api/accounts/${account.id}/verify`, { networkConsent: true })).status, 400);
    assert.equal(app.store.get('SELECT remote_id FROM account_bindings WHERE account_id=?', account.id).remote_id, 'destination-one');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
