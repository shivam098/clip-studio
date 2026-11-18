import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { dataDir } from '../src/config.mjs';
import { pagesUrl, destination, verifyBeacon, leaseMs, offline } from '../launcher/policy.mjs';

const port = Number(process.env.PORT ?? 4318), local = `http://127.0.0.1:${port}`;
const repo = 'repos/shivam098/clip-studio', app = fileURLToPath(new URL('../src/server.mjs', import.meta.url));

async function control(action, token) {
  const res = await fetch(local + '/api/remote/control', { redirect: 'error', signal: AbortSignal.timeout(90_000),
    ...(action ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify({ action }) } : {}) });
  if (!res.ok) throw new Error(`Local control returned HTTP ${res.status}. Check the installed version and port.`);
  const result = await res.json();
  if (!action && result.service !== 'clip-studio-full-control-v1') throw new Error('Not the expected Clip Studio console.');
  return result;
}
async function current(startApp) {
  try { return await control(); }
  catch (error) {
    if (error.cause?.code !== 'ECONNREFUSED') throw error;
    if (!startApp) return { active: false, stopped: true };
  }
  mkdirSync(dataDir, { recursive: true });
  const fd = openSync(join(dataDir, 'server.log'), 'a', 0o600);
  try {
    const env = { ...process.env, PORT: String(port), CLIP_STUDIO_DATA: dataDir };
    for (const k of Object.keys(env)) if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i.test(k)) delete env[k];
    const child = spawn(process.execPath, [app], { detached: true, cwd: dirname(dirname(app)),
      windowsHide: true, env, stdio: ['ignore',fd,fd] });
    child.unref();
  } finally { closeSync(fd); }
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try { return await control(); }
    catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw error; }
  }
  throw new Error('Local studio did not start. Check its data directory and server.log.');
}
function pointerStore() {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  for (const k of Object.keys(env)) if (/^(GH_TOKEN|GITHUB_TOKEN|GH_HOST|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_DEBUG)$/i.test(k)) delete env[k];
  const gh = (args, input) => {
    try { return execFileSync('gh', args, { env, input, encoding: 'utf8', windowsHide: true,
      stdio: ['pipe','pipe','pipe'], timeout: 25000, maxBuffer: 256 * 1024 }).trim(); }
    catch { throw new Error('GitHub request failed. Check the shivam098 login and connection; no alternate account was used.'); }
  };
  env.GH_TOKEN = gh(['auth','token','--hostname','github.com','--user','shivam098']);
  const api = (path, data) => JSON.parse(gh(['api','--hostname','github.com',path,
    ...(data ? ['--method','PUT','--input','-'] : [])], data ? JSON.stringify(data) : undefined));
  if (api('user').login !== 'shivam098') throw new Error('Wrong GitHub owner.');
  const pages = api(repo + '/pages');
  if (pages.html_url !== pagesUrl || pages.cname || pages.source?.branch !== 'gh-pages' || pages.source?.path !== '/') {
    throw new Error('Unexpected Pages configuration. Nothing was published.');
  }
  const path = repo + '/contents/link.json', file = api(path + '?ref=gh-pages');
  if (file.type !== 'file' || file.path !== 'link.json' || file.size > 1024 || !/^[0-9a-f]{40}$/.test(file.sha)) throw new Error('Unexpected launcher file.');
  const previous = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  if (previous.version !== 2) throw new Error('Deploy the full-studio launcher before using this operator.');
  return { previous, write(next) {
    if (JSON.stringify(next) === JSON.stringify(previous)) return;
    const owner = { name: 'shivam098', email: '39924466+shivam098@users.noreply.github.com' };
    api(path, { branch: 'gh-pages', sha: file.sha, author: owner, committer: owner,
      message: `Set full studio ${next.status}\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`,
      content: Buffer.from(JSON.stringify(next) + '\n').toString('base64') });
  } };
}
export async function waitForBeacon(binding, { verify = verifyBeacon, now = () => performance.now(), wait = sleep } = {}) {
  const deadline = now() + 100_000;
  for (;;) {
    try { await verify(binding.origin, binding.instance); return; }
    catch (error) {
      const remaining = deadline - now();
      if (remaining <= 0) throw error;
      await wait(Math.min(2500, remaining));
    }
  }
}
async function ready(binding) {
  await waitForBeacon(binding);
  const probe = await fetch(binding.origin + '/api/state', { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000) });
  await probe.body?.cancel();
  if (probe.status !== 401) throw new Error('Anonymous access was not rejected as expected; refusing publication.');
  const check = await control();
  if (check.origin !== binding.origin || check.instance !== binding.instance) throw new Error('Tunnel identity changed during verification.');
}
async function main() {
  const [action, ...rest] = process.argv.slice(2);
  if (!['start','status','stop'].includes(action) || rest.length) throw new Error('Use start, status or stop.');
  // An OS-owned lock disappears on exit, including a crash. Never interleave stop/renew/start writes.
  const lock = net.createServer(socket => socket.destroy());
  if (action !== 'status') await new Promise((ok, fail) => {
    lock.once('error', () => fail(new Error('Another sharing command is running or its local lock port is busy.')));
    lock.listen(4320, '127.0.0.1', ok);
  });
  try {
    const initial = await current(action === 'start');
    if (action === 'stop' && !initial.stopped) await control('stop', initial.token);
    const pointer = pointerStore();
    if (action === 'stop') { pointer.write(offline); console.log('Remote sharing stopped. Localhost is unchanged.'); return; }
    if (action === 'status') {
      let advertised;
      try { advertised = destination(pointer.previous); } catch { advertised = null; }
      const matches = !!initial.active && advertised === initial.origin && pointer.previous.instance === initial.instance;
      console.log(JSON.stringify({ local: !initial.stopped,
        tunnel: initial.active ? initial.origin : null, launcher: pagesUrl, publishedCurrent: matches,
        expiresAt: matches ? new Date(pointer.previous.expiresAt).toISOString() : null }));
      return;
    }
    let binding = await control('start', initial.token);
    // Replace a dead but not-yet-exited child once. Never publish an unverified replacement.
    if (initial.active) {
      try { await verifyBeacon(binding.origin, binding.instance); }
      catch { await control('stop', initial.token); binding = await control('start', initial.token); }
    }
    try { await ready(binding); }
    catch (error) { await control('stop', initial.token); throw error; }
    const now = Date.now(), previous = pointer.previous;
    if (previous.origin !== binding.origin || previous.instance !== binding.instance ||
        previous.status !== 'online' || previous.expiresAt <= now + 60 * 60_000 || destination(previous, now) !== binding.origin) {
      pointer.write({ version: 2, status: 'online', origin: binding.origin, instance: binding.instance, issuedAt: now, expiresAt: now + leaseMs });
    }
    console.log(`Full Clip Studio: ${pagesUrl} (sign up or sign in with a studio email and password).`);
  } finally { if (lock.listening) lock.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
