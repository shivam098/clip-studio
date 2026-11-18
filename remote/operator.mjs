// Local operator CLI only. Neither this module nor its state is an HTTP resource.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { destination, isEditor, isQuickOrigin, leaseMs, pagesOrigin, readSmallJson } from './pages/link-policy.js';

const local = 'http://127.0.0.1:4319', repo = 'repos/shivam098/clip-studio', pointerPath = `${repo}/contents/link.json`;
const pinFile = new URL('./state/pin.json', import.meta.url);
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
function writePin(pin) {
  const temp = new URL(`./state/${randomUUID()}.tmp`, import.meta.url);
  writeFileSync(temp, JSON.stringify(pin), { flag: 'wx' });
  renameSync(temp, pinFile);
}
async function probe(origin, expectedInstance) {
  let instance;
  const health = await readSmallJson(`${origin}/health`, {
    signal: AbortSignal.timeout(6000),
    headers: expectedInstance ? { Origin: pagesOrigin } : undefined,
    acceptHeaders(headers) {
      instance = headers.get('x-clip-editor-instance');
      return uuid.test(instance) && (!expectedInstance || (instance === expectedInstance &&
        headers.get('access-control-allow-origin') === pagesOrigin));
    },
  });
  if (!isEditor(health)) throw new Error('Not the public browser editor.');
  return instance;
}

async function tunnel() {
  const instance = await probe(local);
  const home = fileURLToPath(new URL('./state/', import.meta.url));
  const config = fileURLToPath(new URL('./quick.yml', import.meta.url));
  if (readFileSync(config, 'utf8').replace(/^\s*#[^\n]*/gm, '').trim() !== '{}') throw new Error('Expected the dedicated empty tunnel configuration.');
  if (JSON.parse(readFileSync(pinFile, 'utf8'))?.instance === instance) throw new Error('Already pinned; stop that share before rotating.');
  const child = spawn('cloudflared.exe', ['tunnel', '--config', config, '--no-autoupdate', '--metrics',
    '127.0.0.1:0', '--url', local], {
    env: { SystemRoot: process.env.SystemRoot, Path: process.env.Path, TEMP: home, TMP: home,
      USERPROFILE: home, HOME: home, APPDATA: home, LOCALAPPDATA: home },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let origin, stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    child.kill(); // Only the child this invocation created.
    if (origin) {
      try {
        const pin = JSON.parse(readFileSync(pinFile, 'utf8'));
        if (pin?.instance === instance && pin.origin === origin) writePin({});
      } catch {
        console.error('Tunnel stopped. Run the offline command to reset the local pin.');
      }
    }
  }
  const startup = setTimeout(stop, 90000);
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', line => {
      const candidate = /\|\s*(https:\/\/[a-z0-9-]+\.trycloudflare\.com)\s*\|\s*$/.exec(line)?.[1];
      if (stopping || origin || !isQuickOrigin(candidate)) return;
      try {
        writePin({ origin: candidate, instance });
        origin = candidate;
        clearTimeout(startup);
        console.log(`Pinned ${origin}\nPages was not changed. Keep this process running. Use the online command separately.`);
      } catch {
        console.error('Could not pin the public origin. Stopping this tunnel.');
        stop();
      }
    });
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const monitor = setInterval(async () => {
    try {
      const pin = JSON.parse(readFileSync(pinFile, 'utf8'));
      if ((origin && (pin?.instance !== instance || pin.origin !== origin)) || await probe(local) !== instance) stop();
    } catch { stop(); }
  }, 3500);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('Could not launch the installed cloudflared.')));
      child.once('exit', resolve);
    });
    if (!origin || (!stopping && code !== 0)) throw new Error('Cloudflare did not keep a Quick Tunnel open. No launcher update was made.');
  } finally {
    clearTimeout(startup);
    clearInterval(monitor);
    stop();
  }
}

function ownerApi() {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  for (const name of Object.keys(env)) if (/^(GH_HOST|GH_TOKEN|GITHUB_TOKEN|GH_DEBUG|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i.test(name)) delete env[name];
  const gh = (args, input) => {
    try {
      return execFileSync('gh', args, { env, input, encoding: 'utf8', timeout: 20000,
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 128 * 1024 }).trim();
    } catch { throw new Error('GitHub CLI request failed. Check the owner login, Pages source and concurrent changes; no automatic retry.'); }
  };
  env.GH_TOKEN = gh(['auth', 'token', '--hostname', 'github.com', '--user', 'shivam098']);
  const api = (path, body) => JSON.parse(gh(['api', '--hostname', 'github.com', path,
    ...(body ? ['--method', 'PUT', '--input', '-'] : [])], body && JSON.stringify(body)));
  if (!env.GH_TOKEN || api('user').login !== 'shivam098') throw new Error('The required GitHub owner is not available.');
  return api;
}
function launcherRecord() {
  const api = ownerApi(), pages = api(`${repo}/pages`);
  if (pages.html_url !== pagesOrigin + '/clip-studio/' || pages.cname ||
      pages.build_type !== 'legacy' || pages.source?.branch !== 'gh-pages' || pages.source?.path !== '/') {
    throw new Error('Pages configuration changed; refusing to publish.');
  }
  const file = api(pointerPath + '?ref=gh-pages');
  if (file.type !== 'file' || file.path !== 'link.json' || file.size > 1024 || !/^[a-f0-9]{40}$/.test(file.sha)) throw new Error('Unexpected pointer file.');
  const text = Buffer.from(file.content, 'base64').toString('utf8');
  return {
    text,
    replace(pointer) {
      const content = JSON.stringify(pointer) + '\n';
      if (text.trim() === content.trim()) return;
      const owner = { name: 'shivam098', email: '39924466+shivam098@users.noreply.github.com' };
      api(pointerPath, { branch: 'gh-pages', sha: file.sha, author: owner, committer: owner,
        message: `Set public editor ${pointer.status}\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`,
        content: Buffer.from(content).toString('base64') });
    },
  };
}

class ShareEnded extends Error {}
function readBinding() {
  let pin;
  try { pin = JSON.parse(readFileSync(pinFile, 'utf8')); }
  catch { throw new ShareEnded('No readable public pin; nothing renewed.'); }
  if (!isQuickOrigin(pin?.origin) || typeof pin.instance !== 'string' || !uuid.test(pin.instance)) {
    throw new ShareEnded('No active public pin; nothing renewed.');
  }
  return { origin: pin.origin, instance: pin.instance };
}
function samePin(binding) {
  const pin = readBinding();
  if (pin.origin !== binding.origin || pin.instance !== binding.instance) throw new ShareEnded('Public pin changed; nothing renewed.');
}
async function checkBinding(binding) {
  samePin(binding);
  if (await probe(local) !== binding.instance) throw new ShareEnded('Editor instance changed; nothing renewed.');
  await probe(binding.origin, binding.instance);
  samePin(binding);
}
async function publish(origin) {
  const pointer = { version: 1, status: origin ? 'online' : 'offline' };
  let binding;
  if (origin) {
    binding = readBinding();
    if (binding.origin !== origin) throw new Error('The exact tunnel is not pinned to this running editor.');
    await checkBinding(binding);
    const issuedAt = Date.now();
    Object.assign(pointer, { origin, issuedAt, expiresAt: issuedAt + leaseMs });
  } else {
    writePin({}); // Revocation must not depend on GitHub being reachable.
  }
  const record = launcherRecord();
  if (binding) samePin(binding);
  record.replace(pointer);
  console.log(`Launcher record: ${pointer.status}. Pages deployment and caches can take a few minutes.`);
}

const hour = 3600000, checkMs = 5 * 60000;
export async function checkLease(binding, { read = launcherRecord, verify = checkBinding, now = Date.now } = {}) {
  const record = read();
  let pointer;
  function requireCurrent(at) {
    try { if (destination(pointer, at) === binding.origin && isQuickOrigin(binding.origin)) return; }
    catch { /* Invalid and expired records are never revived. */ }
    throw new ShareEnded('The published lease changed, expired, or went offline; nothing renewed.');
  }
  try { pointer = JSON.parse(record.text); }
  catch { throw new ShareEnded('The published lease is invalid; nothing renewed.'); }
  requireCurrent(now());
  await verify(binding);
  const at = now();
  requireCurrent(at);
  if (pointer.expiresAt - at > hour) return { expiresAt: pointer.expiresAt, renewed: false };
  const next = { ...pointer, issuedAt: at, expiresAt: at + leaseMs };
  record.replace(next); // Compare-and-swap against the exact record read above.
  return { expiresAt: next.expiresAt, renewed: true };
}
async function keepOnline() {
  const binding = readBinding();
  let { expiresAt } = await checkLease(binding);
  console.log('Watching this live Clip Studio lease only. Ctrl+C stops renewal; the offline command stops sharing.');
  let wait = checkMs;
  while (Date.now() < expiresAt) {
    await sleep(Math.min(wait, expiresAt - Date.now()));
    if (Date.now() >= expiresAt) break;
    samePin(binding);
    if (expiresAt - Date.now() > hour) continue;
    try {
      const result = await checkLease(binding);
      expiresAt = result.expiresAt;
      wait = checkMs;
      if (result.renewed) console.log('Renewed the current editor lease without changing the address.');
    } catch (error) {
      if (error instanceof ShareEnded) throw error;
      wait = Math.min(wait * 2, 15 * 60000);
      console.error('Could not verify or renew the current lease. No replacement tunnel will be opened.');
    }
  }
  throw new ShareEnded('Lease expired. Renewal stopped.');
}

async function main() {
  const [action, origin, ...extra] = process.argv.slice(2);
  if (action === 'tunnel' && !origin) await tunnel();
  else if (action === 'online' && isQuickOrigin(origin) && !extra.length) await publish(origin);
  else if (action === 'keep-online' && !origin) await keepOnline();
  else if (action === 'offline' && !origin) await publish(null);
  else throw new Error('Use tunnel, online <exact HTTPS Quick Tunnel origin without slash>, keep-online, or offline.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  catch (error) {
    // Never emit CLI output, local paths, or request details.
    console.error(error.code || error instanceof TypeError ? 'Editor operation failed. Check the installation, editor and network.' : error.message);
    process.exitCode = 1;
  }
}
