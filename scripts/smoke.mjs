import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../src/server.mjs';
import { probe } from '../src/media.mjs';
import { readConfig } from '../src/config.mjs';
import { run } from '../src/process.mjs';

const root = await mkdtemp(join(tmpdir(), 'clip-real-smoke-'));
const config = readConfig();
const app = await createApp({ root, config, port: 0 });
const base = `http://127.0.0.1:${app.server.address().port}`;
let token;
async function api(path, body) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token ?? '' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result)); return result;
}
async function waitJob(jobId) {
  for (let i = 0; i < 600; i++) {
    const job = (await api('/api/state')).jobs.find(j => j.id === jobId);
    if (job.state === 'succeeded') return job;
    assert.ok(['queued','running'].includes(job.state), `${job.type}: ${job.error}`);
    await sleep(500);
  }
  throw new Error('Smoke job timed out');
}
try {
  const initial = await api('/api/state'); token = initial.token;
  const workspaceId = initial.workspaces[0].id;
  const source = join(root, 'source.mp4');
  await run(config.ffmpeg, ['-hide_banner','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=15',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','8','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','aac', source]);
  const upload = await fetch(`${base}/api/upload?workspace=${workspaceId}&name=synthetic-upload.mp4`,
    { method: 'POST', headers: { 'X-Studio-Token': token }, body: await readFile(source) });
  assert.equal(upload.status, 201); const asset = await upload.json();
  const range = await fetch(`${base}/api/assets/${asset.id}/video`, { headers: { Range: 'bytes=0-31' } });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32);
  await api(`/api/assets/${asset.id}/transcript`, { segments: [{ start: 0, end: 4, text: 'Synthetic caption: local media test' }] });
  await waitJob((await api(`/api/assets/${asset.id}/analyze`, { method: 'heuristic' })).jobId);
  const clip = await api('/api/clips', { assetId: asset.id, name: 'Synthetic vertical clip', start: 0, end: 6,
    hook: 'LOCAL FIRST', framing: 'fit', captions: [{ start: 0, end: 4, text: 'Synthetic caption: local media test' }] });
  await waitJob((await api(`/api/clips/${clip.id}/render`, {})).jobId);
  const output = app.store.get('SELECT output FROM clips WHERE id=?', clip.id).output;
  const info = await probe(output, config);
  assert.equal(info.width, 720); assert.equal(info.height, 1280); assert.equal(info.audio, 1);
  assert.ok(Math.abs(info.duration - 6) < 0.3);
  const download = await fetch(`${base}/api/clips/${clip.id}/video?download`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /attachment/);
  const cancelledClip = await api('/api/clips', { assetId: asset.id, name: 'Cancelled render must not attach', start: 0, end: 8, framing: 'crop' });
  const cancelledJob = await api(`/api/clips/${cancelledClip.id}/render`, {});
  await sleep(50);
  await api(`/api/jobs/${cancelledJob.jobId}/cancel`, {});
  for (let attempt = 0; attempt < 100 && app.jobs.running.size; attempt++) await sleep(50);
  assert.equal(app.jobs.running.size, 0, 'underlying cancelled media work settled');
  assert.equal(app.store.get('SELECT state FROM jobs WHERE id=?', cancelledJob.jobId).state, 'cancelled');
  assert.equal(app.store.get('SELECT output FROM clips WHERE id=?', cancelledClip.id).output, null);
  if (process.env.CLIP_SMOKE_SPEECH === '1') {
    const demo = await waitJob((await api('/api/demo', { workspaceId })).jobId);
    await waitJob((await api(`/api/assets/${demo.result.id}/transcribe`, {})).jobId);
    const transcript = await api(`/api/assets/${demo.result.id}/transcript`);
    assert.ok(transcript.segments.length > 0);
    assert.match(transcript.segments.map(s => s.text).join(' ').toLowerCase(), /caption|video|studio/);
    console.log(`REAL OFFLINE SPEECH: ${transcript.segments.length} timed segments`);
  }
  if (process.env.CLIP_SMOKE_LIVE === '1') {
    const session = await api('/api/live', { workspaceId, name: 'Synthetic live', synthetic: true });
    let segment, during;
    for (let attempt = 0; attempt < 42; attempt++) {
      await sleep(1000);
      during = await api('/api/state');
      segment = during.segments.find(s => s.session_id === session.id);
      if (segment) break;
      assert.equal(during.live.find(s => s.id === session.id).state, 'recording', JSON.stringify(during.live));
    }
    assert.ok(segment, `completed live buffer is visible while capture continues: ${JSON.stringify(during.live)}`);
    assert.equal(during.live.find(s => s.id === session.id).state, 'recording');
    assert.equal(during.assets.find(a => a.id === segment.asset_id).audio, 1, 'live segment retains audio');
    const manual = await api('/api/clips', { assetId: segment.asset_id, name: 'Manual live clip', start: 0, end: 5, framing: 'crop' });
    await waitJob((await api(`/api/clips/${manual.id}/render`, {})).jobId);
    await api(`/api/live/${session.id}/stop`, {});
    const cleanup = await api(`/api/live/${session.id}/cleanup`, {});
    assert.ok(cleanup.retained >= 1, 'source used by manual clip retained');
    console.log('REAL LIVE: completed segment -> manual clip -> render; in-use buffer retained');
  }
  assert.equal(app.store.get('SELECT COUNT(*) AS n FROM publications').n, 0);
  if (process.env.CLIP_SMOKE_ARTIFACTS) {
    await mkdir(process.env.CLIP_SMOKE_ARTIFACTS, { recursive: true });
    await run(config.ffmpeg, ['-hide_banner','-y','-ss','2','-i',output,'-frames:v','1',join(process.env.CLIP_SMOKE_ARTIFACTS,'render-frame.png')]);
  }
  console.log('REAL MEDIA PASS: upload, probe, range playback, caption edit, heuristic, render, downloadable 720x1280 H.264/AAC; zero publications');
} finally {
  await app.close();
  await rm(root, { recursive: true, force: true });
}
