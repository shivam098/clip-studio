import http from 'node:http';
import { closeSync, openSync, readFileSync, readSync, watchFile, unwatchFile } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { healthPath, isQuickOrigin, pagesOrigin, signature } from './pages/link-policy.js';

export const port = 4319;
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; media-src blob:; connect-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const files = [
  ['/', 'index.html', 'text/html'],
  ['/editor.css', 'editor.css', 'text/css'],
  ['/editor.js', 'editor.js', 'text/javascript'],
];

export function createEditor(pinFile = new URL('./state/pin.json', import.meta.url)) {
  const assets = new Map(files.map(([path, name, mime]) => [
    path, [mime, readFileSync(new URL(`./site/${name}`, import.meta.url))],
  ]));
  assets.set(healthPath, ['application/json', Buffer.from(JSON.stringify(signature))]);
  const instance = randomUUID();
  let publicOrigin = null, publicHost = null;
  function refreshPin() {
    publicOrigin = publicHost = null;
    let fd;
    try {
      fd = openSync(pinFile, 'r');
      const buffer = Buffer.alloc(256);
      const bytes = readSync(fd, buffer, 0, buffer.length);
      if (bytes >= buffer.length) return;
      const pin = JSON.parse(buffer.toString('utf8', 0, bytes));
      if (pin?.instance === instance && isQuickOrigin(pin.origin)) {
        publicOrigin = pin.origin;
        publicHost = new URL(publicOrigin).host;
      }
    } catch {
      // Missing, partial, malformed or unreadable local state disables all public hosts.
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  const server = http.createServer({
    maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 8000, connectionsCheckingInterval: 1000,
  }, (req, res) => {
    const { method, url, headers, headersDistinct } = req;
    const localHost = `127.0.0.1:${server.address().port}`;
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), display-capture=(), payment=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const reject = (status) => { res.writeHead(status, { Connection: 'close', 'Content-Length': 0 }); res.end(); };
    if (headersDistinct.host?.length !== 1 || (headers.host !== localHost && headers.host !== publicHost)) return reject(421);
    const local = headers.host === localHost;
    const pagesProbe = !local && url === healthPath && headers.origin === pagesOrigin;
    if (headersDistinct.origin?.length > 1 || (headers.origin !== undefined &&
        headers.origin !== (local ? `http://${localHost}` : publicOrigin) && !pagesProbe)) return reject(403);
    if (method !== 'GET' && method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); return reject(405); }
    if (headers['transfer-encoding'] !== undefined ||
        (headers['content-length'] !== undefined && headers['content-length'] !== '0')) return reject(400);

    // Nothing from the request becomes a filesystem path. There is no fallback, directory or upstream.
    const asset = assets.get(url);
    if (!asset) return reject(404);
    if (url === healthPath) {
      res.setHeader('Vary', 'Origin');
      res.setHeader('X-Clip-Editor-Instance', instance);
    }
    if (pagesProbe) {
      res.setHeader('Access-Control-Allow-Origin', pagesOrigin);
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
    const [mime, body] = asset;
    res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Content-Length': body.length });
    res.end(method === 'HEAD' ? undefined : body);
  });
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 32;
  server.keepAliveTimeout = 3000;
  server.setTimeout(8000, socket => socket.destroy());
  server.on('checkContinue', (_req, res) => { res.writeHead(417, { Connection: 'close' }); res.end(); });
  server.on('checkExpectation', (_req, res) => { res.writeHead(417, { Connection: 'close' }); res.end(); });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  server.once('listening', () => {
    refreshPin();
    watchFile(pinFile, { interval: 400, persistent: false }, refreshPin);
  });
  server.once('close', () => unwatchFile(pinFile, refreshPin));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('The public editor has no command-line options.');
  const server = createEditor();
  server.on('error', () => { console.error('Public editor did not start. Check its dedicated port and installation.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Clip Studio browser editor listening on 127.0.0.1:${port}.`));
}
