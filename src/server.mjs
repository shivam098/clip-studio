import http from 'node:http';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, open, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { Store, id, json, now, parse } from './store.mjs';
import { Jobs, AnalysisLeases } from './jobs.mjs';
import { readConfig, dataDir } from './config.mjs';
import { probe, render, transcribe, validateSegments } from './media.mjs';
import { run } from './process.mjs';
import { download, supportedUrl, importRecovery, YouTubeVerificationRequired } from './imports.mjs';
import { modelEndpoint, suggestions } from './analysis.mjs';
import { Vault } from './vault.mjs';
import { Providers } from './providers.mjs';
import { Publishing } from './publishing.mjs';
import { Live } from './live.mjs';
import { OwnerAccess } from './remote-auth.mjs';
import { Tunnel } from './tunnel.mjs';
import { Uploads, maxVideo } from './uploads.mjs';

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const limit = maxVideo;
const publicAsset = ({ path, ...asset }) => asset;
const publicClip = ({ output, ...clip }) => ({ ...clip, rendered: !!output, captions: parse(clip.captions) });
function publicJob({ payload, result, ...job }) {
  const output = ['import', 'demo', 'analyze'].includes(job.type) ? parse(result) : null;
  const recovery = importRecovery(job, output);
  return { ...job, error: recovery ? 'YouTube requires verification to import this video.' : job.error,
    result: job.state === 'succeeded' ? output : null, recovery: recovery && !parse(payload)?.recoveryDismissed ? recovery : null };
}
const text = (value, label, max = 160) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must contain 1-${max} characters`);
  return value.trim();
};
const optionalText = (value, max) => {
  if (value == null || value === '') return '';
  return text(value, 'Text', max);
};
const integer = (value, min, max, label) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be ${min}-${max}`);
  return value;
};
async function body(req) {
  let length = 0, chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 2_000_000) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(json(value));
}
async function mediaResponse(req, res, file, downloadName) {
  const size = (await stat(file)).size;
  let start = 0, end = size - 1, code = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else start = Number(match[1]);
    if (match[1] && match[2]) end = Math.min(end, Number(match[2]));
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    code = 206;
  }
  res.writeHead(code, { 'Content-Type': file.endsWith('.webm') ? 'video/webm' : 'video/mp4',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
    ...(code === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    ...(downloadName ? { 'Content-Disposition': `attachment; filename="${downloadName}"` } : {}) });
  try { await pipeline(createReadStream(file, { start, end }), res); }
  catch (error) { if (!['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET'].includes(error.code)) throw error; }
}

export async function createApp({ root = dataDir, config = readConfig(root), port = 4318, providers = new Providers(), importVideo = download } = {}) {
  await mkdir(root, { recursive: true });
  const lockPath = join(root, 'server.lock');
  try {
    const previous = JSON.parse(await readFile(lockPath, 'utf8'));
    try { process.kill(previous.pid, 0); throw new Error('This data directory is already in use by a running server'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await unlink(lockPath);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(json({ pid: process.pid }));
  await lock.close();
  const store = new Store(join(root, 'studio.sqlite'));
  const jobs = new Jobs(store), leases = new AnalysisLeases(store), vault = new Vault(root);
  const publishing = new Publishing(store, providers, vault);
  const csrf = randomBytes(32).toString('hex');
  const getAsset = assetId => {
    const asset = store.get('SELECT * FROM assets WHERE id=?', assetId);
    if (!asset) throw new Error('Video not found');
    if (store.get("SELECT owner FROM leases WHERE resource_id=? AND owner LIKE 'cleanup:%'", assetId)) throw new Error('Video is being deleted');
    return asset;
  };
  const getClip = clipId => {
    const clip = store.get('SELECT * FROM clips WHERE id=?', clipId);
    if (!clip) throw new Error('Clip not found');
    return clip;
  };
  const getWorkspace = workspaceId => {
    if (!store.get('SELECT id FROM workspaces WHERE id=?', workspaceId)) throw new Error('Workspace not found');
    return workspaceId;
  };
  const getRecoveryJob = jobId => {
    const row = store.get('SELECT type,state,resource_id,error,result,payload FROM jobs WHERE id=?', jobId);
    if (!row || !publicJob(row).recovery) throw new Error('Import recovery is no longer available');
    return row;
  };
  const dismissRecovery = jobId => store.run("UPDATE jobs SET payload=json_set(payload,'$.recoveryDismissed',1) WHERE id=?", jobId);
  async function addAsset(path, workspaceId, name, signal, recoveryJobId) {
    const info = await probe(path, config, signal), assetId = id();
    signal?.throwIfAborted();
    store.tx(() => {
      if (recoveryJobId) getRecoveryJob(recoveryJobId);
      store.run('INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?)', assetId, workspaceId, name, path,
        info.duration, info.width, info.height, info.audio, now());
      if (recoveryJobId) dismissRecovery(recoveryJobId);
    });
    return { id: assetId, ...info };
  }
  const live = new Live(store, leases, root, config, addAsset);
  const uploads = new Uploads(root, addAsset);
  await uploads.init();
  const access = new OwnerAccess(store);
  // Binding must succeed before startup recovery; another server must never reset live ownership.
  let ticking = false;
  const tasks = new Set();
  const track = promise => {
    tasks.add(promise);
    promise.catch(error => console.error(`Background task failed: ${error.message}`)).finally(() => tasks.delete(promise));
    return promise;
  };
  function startAssetJob(asset, type, execute, commit) {
    const max = type === 'transcribe' ? 1 : 4;
    if (store.get("SELECT COUNT(*) AS count FROM jobs WHERE type=? AND state='running'", type).count >= max) {
      throw new Error(`${type} capacity reached; wait or cancel an existing job. Manual clipping remains available.`);
    }
    const jobId = jobs.create(type, asset.id);
    const segment = store.get('SELECT session_id FROM live_segments WHERE asset_id=?', asset.id);
    track(leases.run(segment?.session_id ?? asset.id, [asset.id], () => jobs.start(jobId, execute, { commit })));
    return { jobId };
  }
  const requests = new Set();
  let stopping = false;
  const handle = async (req, res, remote) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (stopping) return send(res, 503, { error: 'Server is stopping' });
      let token = csrf;
      if (remote) {
        const session = await access.gate(req, res, remote.binding, remote.active);
        if (!session) return;
        token = session.csrf;
      } else {
        const actualPort = server.address()?.port ?? port;
        const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
        if (!allowedHosts.includes(req.headers.host) || ['cf-ray','cf-connecting-ip','forwarded','x-forwarded-host','x-forwarded-proto','x-forwarded-for'].some(k => k in req.headers)) {
          return send(res, 403, { error: 'Direct localhost connection required' });
        }
        if (req.headers.origin && !allowedHosts.map(h => `http://${h}`).includes(req.headers.origin)) return send(res, 403, { error: 'Cross-origin access denied' });
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      const parts = url.pathname.split('/').filter(Boolean);
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-studio-token'] !== token) return send(res, 403, { error: 'Missing session token; reload the page' });
      if (!remote && url.pathname === '/api/remote/control') {
        if (req.method === 'GET') return send(res, 200, { service: 'clip-studio-full-control-v1', token, ...access.status(), ...tunnel.status() });
        if (req.method === 'POST') {
          const input = await body(req);
          if (!['start','stop'].includes(input.action)) throw new Error('Use start or stop.');
          return send(res, 200, await tunnel.change(input.action));
        }
      }
      if (!remote && req.method === 'POST' && url.pathname === '/api/remote/password') {
        const input = await body(req);
        return send(res, 200, await access.set(input.password, input.revision));
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, name: 'Clip Studio', version: '0.1.0' });
      if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        const input = await body(req);
        if (input.confirm !== 'stop-local-studio') throw new Error('Explicit shutdown confirmation required');
        send(res, 202, { stopping: true });
        setTimeout(() => close().catch(error => console.error(`Shutdown failed: ${error.message}`)), 50);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return send(res, 200, {
          token, access: remote ? { remote: true } : { remote: false, ...access.status() },
          workspaces: store.all('SELECT * FROM workspaces ORDER BY created'),
          assets: store.all('SELECT * FROM assets ORDER BY created DESC').map(publicAsset),
          clips: store.all('SELECT * FROM clips ORDER BY created DESC').map(publicClip),
          jobs: store.all('SELECT id,type,resource_id,state,error,created,started,finished,result,payload FROM jobs ORDER BY created DESC LIMIT 100').map(publicJob),
          live: store.all('SELECT id,workspace_id,name,state,error,created FROM live_sessions ORDER BY created DESC'),
          segments: store.all('SELECT id,session_id,asset_id FROM live_segments ORDER BY created,id'),
          accounts: store.all('SELECT a.*,b.remote_id,b.display_name,b.verified FROM accounts a LEFT JOIN account_bindings b ON b.account_id=a.id')
            .map(account => ({ ...account, config: parse(account.config), credential: vault.has(account.id) })),
          publications: store.all('SELECT id,account_id,clip_id,scheduled,state,metadata,error,result,created,provider_ref FROM publications ORDER BY created DESC')
            .map(p => { const ref = parse(p.provider_ref); return { ...p, metadata: parse(p.metadata), result: parse(p.result),
              provider_ref: { phase: ref.phase, id: ref.videoId ?? ref.mediaId ?? ref.containerId ?? ref.publishId, hasSession: !!ref.session } }; }),
          settings: { publishingEnabled: store.setting('publishingEnabled', false),
            ai: store.setting('ai', null), aiCredential: vault.has('ai'), model: config.model,
            storage: root, secrets: process.platform === 'win32' ? 'Windows DPAPI, current user' : 'Owner-readable credential file' },
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
        const checks = {};
        for (const [name, command, args] of [
          ['ffmpeg', config.ffmpeg, ['-version']], ['ffprobe', config.ffprobe, ['-version']],
          ['speech', config.python, ['-c', "from faster_whisper import WhisperModel; print('faster-whisper available')"]],
          ['downloader', config.python, ['-m', 'yt_dlp', '--version']],
          ['downloaderScripts', config.python, ['-c', "from importlib.metadata import version; print('yt-dlp-ejs ' + version('yt-dlp-ejs'))"]],
          ['javascriptRuntime', process.execPath, ['--version']],
        ]) {
          try { checks[name] = { ok: true, detail: (await run(command, args, { signal: AbortSignal.timeout(15000) })).stdout.split('\n')[0] }; }
          catch (error) { checks[name] = { ok: false, detail: error.message }; }
        }
        return send(res, 200, checks);
      }
      if (parts[0] === 'api' && parts[1] === 'assets' && parts[3] === 'video' && req.method === 'GET') {
        return await mediaResponse(req, res, getAsset(parts[2]).path);
      }
      if (parts[0] === 'api' && parts[1] === 'clips' && parts[3] === 'video' && req.method === 'GET') {
        const clip = getClip(parts[2]);
        if (!clip.output) throw new Error('Render this clip first');
        return await mediaResponse(req, res, clip.output, url.searchParams.has('download') ? `clip-${clip.id}.mp4` : null);
      }
      if (parts[0] === 'api' && parts[1] === 'assets' && parts[3] === 'transcript' && req.method === 'GET') {
        getAsset(parts[2]);
        const transcript = store.get('SELECT * FROM transcripts WHERE asset_id=?', parts[2]);
        return send(res, 200, transcript ? { source: transcript.source, segments: parse(transcript.segments) } : { source: 'Not transcribed', segments: [] });
      }
      if (url.pathname === '/api/uploads' && req.method === 'POST') {
        const input = await body(req), workspace = getWorkspace(input.workspace), name = text(input.name, 'Filename', 255);
        if (input.recovery && getRecoveryJob(input.recovery).resource_id !== workspace) throw new Error('Choose a file for the original import workspace');
        return send(res, 201, await uploads.begin(token, { workspace, name, size: input.size, recovery: input.recovery || null }));
      }
      if (parts[0] === 'api' && parts[1] === 'uploads' && parts.length === 4) {
        const uploadId = parts[2], action = parts[3];
        if (req.method === 'POST' && action === 'piece') {
          const offset = url.searchParams.get('offset');
          if (!/^(0|[1-9]\d*)$/.test(offset ?? '')) throw new Error('Expected the acknowledged byte offset.');
          return send(res, 200, await uploads.append(uploadId, token, req, Number(offset)));
        }
        if (req.method === 'POST' && action === 'finish') return send(res, 201, await uploads.finish(uploadId, token));
        if (req.method === 'POST' && action === 'cancel') { await uploads.cancel(uploadId, token); return send(res, 200, { cancelled: true }); }
        if (req.method === 'GET' && action === 'status') return send(res, 200, { offset: uploads.get(uploadId, token).offset });
      }
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        const workspaceId = getWorkspace(url.searchParams.get('workspace'));
        const recoveryJobId = url.searchParams.get('recovery');
        if (recoveryJobId && getRecoveryJob(recoveryJobId).resource_id !== workspaceId) throw new Error('Choose a file for the original import workspace');
        const name = text(url.searchParams.get('name'), 'Filename', 255);
        const folder = join(root, 'uploads', id());
        await mkdir(folder, { recursive: true });
        const file = join(folder, 'source.mp4');
        let bytes = 0, success = false;
        try {
          await pipeline(req, new Transform({ transform(chunk, encoding, cb) {
            bytes += chunk.length; cb(bytes > limit ? new Error('Upload exceeds 2 GiB') : null, chunk);
          } }), createWriteStream(file, { flags: 'wx' }));
          const asset = await addAsset(file, workspaceId, name, AbortSignal.timeout(30000), recoveryJobId);
          success = true;
          return send(res, 201, asset);
        } finally { if (!success) await rm(folder, { recursive: true, force: true }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/workspaces') {
        const input = await body(req), workspaceId = id();
        store.run('INSERT INTO workspaces VALUES (?,?,?,?)', workspaceId, text(input.name, 'Workspace'), text(input.creator, 'Creator'), now());
        return send(res, 201, { id: workspaceId });
      }
      if (req.method === 'POST' && ['/api/demo', '/api/import'].includes(url.pathname)) {
        const input = await body(req), workspaceId = getWorkspace(input.workspaceId);
        const isDemo = url.pathname === '/api/demo';
        if (!isDemo && input.networkConsent !== true) throw new Error('URL import contacts the source host; explicit consent required');
        if (!isDemo) supportedUrl(input.url);
        const jobId = jobs.create(isDemo ? 'demo' : 'import', workspaceId);
        track(jobs.start(jobId, async ctx => {
          const folder = join(root, 'uploads', ctx.attempt);
          await mkdir(folder, { recursive: true });
          let path;
          if (isDemo) {
            path = join(folder, 'source.mp4');
            const speech = join(folder, 'speech.wav');
            if (process.platform === 'win32') {
              await run('powershell.exe', ['-NoProfile', '-File', join(sourceRoot, 'scripts', 'demo-speech.ps1'), '-OutputPath', speech], { signal: ctx.signal });
            }
            const audio = process.platform === 'win32' ? ['-i', speech] : ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '12'];
            await run(config.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=30',
              ...audio, '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path], { signal: ctx.signal });
          } else path = await importVideo(input.url, folder, config, ctx.signal);
          const info = await probe(path, config, ctx.signal);
          return { id: id(), path, workspaceId, name: isDemo ? 'Studio demo (synthetic)' : 'Imported video', ...info };
        }, { timeout: 30 * 60_000, failureResult: error => error instanceof YouTubeVerificationRequired
          ? { reason: 'youtube-verification', videoId: error.videoId } : { reason: 'other' }, commit: asset => {
          store.run('INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?)', asset.id, asset.workspaceId, asset.name, asset.path,
            asset.duration, asset.width, asset.height, asset.audio, now());
          // Paths are retained only in assets, not in the publicly returned job result.
          delete asset.path;
        } }));
        return send(res, 202, { jobId });
      }
      if (parts[0] === 'api' && parts[1] === 'assets' && ['transcribe','analyze','transcript'].includes(parts[3]) && req.method === 'POST') {
        const input = await body(req), asset = getAsset(parts[2]);
        if (parts[3] === 'transcript') {
          const segments = validateSegments(input.segments, asset.duration);
          store.run('INSERT INTO transcripts VALUES (?,?,?) ON CONFLICT(asset_id) DO UPDATE SET segments=excluded.segments,source=excluded.source',
            asset.id, json(segments), 'Manually edited');
          return send(res, 200, { saved: true });
        }
        if (parts[3] === 'transcribe') {
          if (!asset.audio) throw new Error('This video has no audio track');
          const previous = store.get('SELECT segments FROM transcripts WHERE asset_id=?', asset.id)?.segments;
          return send(res, 202, startAssetJob(asset, 'transcribe',
            ctx => transcribe(asset.path, config, ctx.signal), result => {
              if (store.get('SELECT segments FROM transcripts WHERE asset_id=?', asset.id)?.segments !== previous) {
                throw new Error('Transcript was edited during transcription; the newer edit was preserved');
              }
              const segments = validateSegments(result.segments.map(s => ({ ...s, end: Math.min(s.end, asset.duration) })), asset.duration);
              store.run('INSERT INTO transcripts VALUES (?,?,?) ON CONFLICT(asset_id) DO UPDATE SET segments=excluded.segments,source=excluded.source',
                asset.id, json(segments), `Local faster-whisper (${result.language})`);
            }));
        }
        const segments = parse(store.get('SELECT segments FROM transcripts WHERE asset_id=?', asset.id)?.segments, []);
        let ai = null;
        if (input.method === 'model') {
          ai = store.setting('ai', null);
          if (!ai?.enabled) throw new Error('Configure and enable the model first');
          if (!modelEndpoint(ai.endpoint).local && input.networkConsent !== true) throw new Error('Explicit transcript egress consent is required');
        }
        return send(res, 202, startAssetJob(asset, 'analyze',
          async ctx => suggestions(segments, asset.duration, ai, ai && vault.has('ai') ? await vault.get('ai') : null, ctx.signal),
          () => {}));
      }
      if (parts[0] === 'api' && parts[1] === 'clips' && req.method === 'POST' && !parts[3]) {
        const input = await body(req);
        const existing = parts[2] ? getClip(parts[2]) : null;
        const asset = getAsset(existing?.asset_id ?? input.assetId);
        const start = Number(input.start), end = Number(input.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > asset.duration || end - start > 180) {
          throw new Error('Choose a clip between 0 and the video duration, at most 180 seconds long');
        }
        if (!['fit','crop'].includes(input.framing)) throw new Error('Choose fit or crop framing');
        const captions = validateSegments(input.captions ?? parse(store.get('SELECT segments FROM transcripts WHERE asset_id=?', asset.id)?.segments, []), asset.duration);
        const clipId = existing?.id ?? id(), name = text(input.name, 'Clip name'), hook = optionalText(input.hook, 160);
        if (existing) {
          if (input.revision !== existing.revision) throw new Error('Clip changed; reload before saving');
          store.run('UPDATE clips SET name=?,start=?,end=?,hook=?,framing=?,captions=?,output=NULL,render_owner=NULL,revision=revision+1 WHERE id=?',
            name, start, end, hook, input.framing, json(captions), clipId);
        } else store.run('INSERT INTO clips(id,asset_id,name,start,end,hook,framing,captions,created) VALUES (?,?,?,?,?,?,?,?,?)',
          clipId, asset.id, name, start, end, hook, input.framing, json(captions), now());
        return send(res, 201, { id: clipId });
      }
      if (parts[0] === 'api' && parts[1] === 'clips' && parts[3] === 'render' && req.method === 'POST') {
        const clip = getClip(parts[2]), asset = getAsset(clip.asset_id);
        if (clip.render_owner) jobs.cancel(clip.render_owner);
        if (store.get("SELECT COUNT(*) AS count FROM jobs WHERE type='render' AND state='running'").count >= 2) throw new Error('Two renders are already running. Wait or cancel one.');
        const jobId = jobs.create('render', clip.id);
        store.run('UPDATE clips SET render_owner=? WHERE id=?', jobId, clip.id);
        track(leases.run(asset.id, [asset.id], () => jobs.start(jobId, ctx =>
          render(asset, { ...clip, captions: parse(clip.captions) }, join(root, 'renders', ctx.attempt), config, ctx.signal), {
          commit: result => {
            const change = store.run('UPDATE clips SET output=? WHERE id=? AND revision=? AND render_owner=?', result.output, clip.id, clip.revision, jobId);
            if (change.changes !== 1) throw new Error('Clip changed during rendering; stale render was not attached');
          },
        })));
        return send(res, 202, { jobId });
      }
      if (parts[0] === 'api' && parts[1] === 'jobs' && parts[3] === 'dismiss-recovery' && parts.length === 4 && req.method === 'POST') {
        getRecoveryJob(parts[2]); dismissRecovery(parts[2]); return send(res, 200, { dismissed: true });
      }
      if (parts[0] === 'api' && parts[1] === 'jobs' && parts[3] === 'cancel' && req.method === 'POST') {
        jobs.cancel(parts[2]); return send(res, 200, { cancelled: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/live') {
        const input = await body(req);
        if (live.running.size >= 2) throw new Error('At most two concurrent captures are supported');
        if (!input.synthetic && input.networkConsent !== true) throw new Error('Live capture contacts the provider; explicit consent required');
        if (!input.synthetic) supportedUrl(input.url, true);
        return send(res, 202, { id: await live.start(getWorkspace(input.workspaceId), text(input.name, 'Stream name'), input.url, input.synthetic === true) });
      }
      if (parts[0] === 'api' && parts[1] === 'live' && req.method === 'POST' && ['stop','cleanup'].includes(parts[3])) {
        return send(res, 200, parts[3] === 'stop' ? (await live.stop(parts[2]), { stopped: true }) : await live.cleanup(parts[2]));
      }
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const input = await body(req);
        if ('publishingEnabled' in input) {
          if (typeof input.publishingEnabled !== 'boolean') throw new Error('Invalid publishing setting');
          store.setSetting('publishingEnabled', input.publishingEnabled);
        }
        if ('ai' in input) {
          const ai = input.ai;
          modelEndpoint(ai.endpoint);
          if (ai.enabled && input.networkConsent !== true && !modelEndpoint(ai.endpoint).local) throw new Error('Approve remote transcript processing before enabling this endpoint');
          if (ai.token) await vault.put('ai', text(ai.token, 'API key', 8192));
          store.setSetting('ai', { endpoint: ai.endpoint, model: text(ai.model, 'Model name'), enabled: ai.enabled === true });
        }
        return send(res, 200, { saved: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/accounts') {
        const input = await body(req);
        if (!['youtube','instagram','tiktok'].includes(input.platform)) throw new Error('Unsupported platform');
        const accountId = id();
        const config = {};
        if (input.platform === 'instagram') {
          if (!/^\d+$/.test(input.userId) || !/^v\d+\.\d+$/.test(input.version)) throw new Error('Instagram requires numeric professional-account ID and a Graph API version, e.g. v24.0');
          Object.assign(config, { userId: input.userId, version: input.version });
        }
        const name = text(input.name, 'Account name');
        const spacing = integer(input.spacing, 60, 86400, 'Spacing in seconds');
        const cap = integer(input.dailyCap, 1, 100, 'Rolling daily cap');
        await vault.put(accountId, text(input.token, 'Access token', 16384));
        store.run('INSERT INTO accounts VALUES (?,?,?,?,?,?,?)', accountId, input.platform, name, json(config), 0, spacing, cap);
        return send(res, 201, { id: accountId });
      }
      if (parts[0] === 'api' && parts[1] === 'accounts' && req.method === 'POST' && parts[3] === 'verify') {
        const input = await body(req), account = store.get('SELECT * FROM accounts WHERE id=?', parts[2]);
        if (!account || input.networkConsent !== true) throw new Error('Approve contacting this provider to verify the account');
        const identity = await providers.identify({ ...account, config: parse(account.config) }, await vault.get(account.id), AbortSignal.timeout(90000));
        const previous = store.get('SELECT remote_id FROM account_bindings WHERE account_id=?', account.id);
        if (previous && previous.remote_id !== identity.id) throw new Error('Token belongs to a different destination. Create a separate account; existing approvals cannot be retargeted.');
        if (store.get('SELECT account_id FROM account_bindings WHERE platform=? AND remote_id=? AND account_id<>?', account.platform, identity.id, account.id)) {
          throw new Error('This provider account is already configured. Use the existing account so caps and spacing cannot be split across duplicate entries.');
        }
        store.run('INSERT INTO account_bindings VALUES (?,?,?,?,1) ON CONFLICT(account_id) DO UPDATE SET display_name=excluded.display_name,verified=1',
          account.id, account.platform, identity.id, identity.displayName);
        return send(res, 200, { verified: true, displayName: identity.displayName, id: identity.id });
      }
      if (parts[0] === 'api' && parts[1] === 'accounts' && req.method === 'POST' && parts[2] && !parts[3]) {
        const input = await body(req), accountId = parts[2];
        if (!store.get('SELECT id FROM accounts WHERE id=?', accountId)) throw new Error('Account not found');
        if (input.token) {
          store.tx(() => {
            store.run('UPDATE accounts SET enabled=0 WHERE id=?', accountId);
            store.run('UPDATE account_bindings SET verified=0 WHERE account_id=?', accountId);
          });
          await vault.put(accountId, text(input.token, 'Access token', 16384));
        }
        if (typeof input.enabled === 'boolean') {
          if (input.enabled && !store.get('SELECT account_id FROM account_bindings WHERE account_id=? AND verified=1', accountId)) throw new Error('Verify the account identity before enabling it');
          store.run('UPDATE accounts SET enabled=? WHERE id=?', Number(input.enabled), accountId);
        }
        if (input.spacing != null || input.dailyCap != null) store.run('UPDATE accounts SET spacing=?,daily_cap=? WHERE id=?',
          integer(input.spacing, 60, 86400, 'Spacing'), integer(input.dailyCap, 1, 100, 'Daily cap'), accountId);
        return send(res, 200, { saved: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/publications') {
        const input = await body(req), clip = getClip(input.clipId);
        const account = store.get('SELECT * FROM accounts WHERE id=?', input.accountId);
        if (!account || !clip.output || !existsSync(clip.output)) throw new Error('Choose a configured account and a rendered clip');
        const binding = store.get('SELECT * FROM account_bindings WHERE account_id=? AND verified=1', account.id);
        if (!binding) throw new Error('Verify the destination identity before approving a post');
        if (input.approved !== true) throw new Error('Explicit approval to send this clip and metadata is required');
        const schedule = input.scheduled == null ? now() : Number(input.scheduled);
        if (!Number.isFinite(schedule) || schedule < 0) throw new Error('Invalid scheduled time');
        const allowed = account.platform === 'youtube' ? ['private','unlisted','public']
          : account.platform === 'tiktok' ? ['SELF_ONLY','PUBLIC_TO_EVERYONE','MUTUAL_FOLLOW_FRIENDS','FOLLOWER_OF_CREATOR'] : ['public'];
        if (!allowed.includes(input.privacy)) throw new Error('Select a privacy option for this platform');
        const metadata = { title: text(input.title, 'Post title', account.platform === 'youtube' ? 100 : 150),
          description: optionalText(input.description, 1800), privacy: input.privacy, madeForKids: input.madeForKids === true,
          duration: clip.end - clip.start, approvedAt: now(), clipRevision: clip.revision, destinationId: binding.remote_id };
        const publicationId = id();
        store.run('INSERT INTO publications(id,account_id,clip_id,scheduled,state,metadata,output,created) VALUES (?,?,?,?,?,?,?,?)',
          publicationId, account.id, clip.id, schedule, 'scheduled', json(metadata), clip.output, now());
        return send(res, 201, { id: publicationId });
      }
      if (parts[0] === 'api' && parts[1] === 'publications' && req.method === 'POST' && ['cancel','reconcile','resolve'].includes(parts[3])) {
        if (parts[3] === 'cancel') { publishing.cancel(parts[2]); return send(res, 200, { cancelled: true }); }
        if (parts[3] === 'reconcile') return send(res, 200, await publishing.reconcile(parts[2]));
        const input = await body(req);
        if (publishing.running.has(parts[2])) throw new Error('Wait for the cancelled dispatch task to settle before resolving its outcome');
        if (!['succeeded','failed'].includes(input.outcome) || input.confirmed !== true) throw new Error('Confirm the outcome after checking the provider');
        const note = text(input.note, 'Reconciliation evidence', 1000);
        const changed = store.run("UPDATE publications SET state=?,result=?,finished=? WHERE id=? AND state IN ('uncertain','processing')",
          input.outcome, json({ message: note, resolvedManually: true }), now(), parts[2]);
        if (!changed.changes) throw new Error('Publication is not unresolved');
        return send(res, 200, { resolved: true });
      }
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'text/javascript', 'Cache-Control': remote ? 'private, no-store' : 'no-cache' });
        return res.end(await readFile(join(sourceRoot, 'public', file)));
      }
      send(res, 404, { error: 'Not found' });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) send(res, 400, { error: error.message });
      else if (!res.destroyed) res.destroy();
    }
  };
  const dispatch = (req, res, remote) => {
    const request = handle(req, res, remote);
    requests.add(request);
    request.finally(() => requests.delete(request)).catch(error => console.error(`Request failed: ${error.message}`));
  };
  const tunnel = new Tunnel(root, dispatch, () => access.revoke());
  const server = http.createServer((req, res) => dispatch(req, res, null));
  server.requestTimeout = 30 * 60_000;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) { store.close(); await unlink(lockPath); throw error; }
  store.recover();
  const pruneTimer = setInterval(() => track(uploads.prune()), 60000);
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    track(publishing.tick().finally(() => { ticking = false; }));
  }, 3000);
  let closing;
  function close() {
    closing ??= shutdown();
    return closing;
  }
  async function shutdown() {
    stopping = true;
    clearInterval(timer); clearInterval(pruneTimer);
    await tunnel.change('stop');
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await Promise.allSettled([...requests]);
    publishing.shutdown();
    await live.shutdown(); await jobs.shutdown();
    await Promise.allSettled([...tasks]);
    await uploads.prune(true);
    await closed;
    store.close();
    await unlink(lockPath);
  }
  return { server, store, jobs, leases, publishing, live, root, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createApp({ port: Number(process.env.PORT ?? 4318) });
  console.log(`Clip Studio: http://localhost:${app.server.address().port}`);
  console.log(`Local data: ${app.root}`);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (stopping) return; stopping = true; await app.close(); process.exit(0);
  });
}
