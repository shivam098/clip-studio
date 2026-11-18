import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { beacon, pagesOrigin, service } from '../launcher/policy.mjs';

const derive = promisify(scrypt), lifetime = 12 * 60 * 60_000, windowMs = 10 * 60_000;
const key = 'remoteOwnerPassword', cookie = '__Host-clip-studio', digest = s => createHash('sha256').update(s).digest('hex');
const cookieString = (value, age) => `${cookie}=${value}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Strict`;
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
}
function signInPage(res, status, configured, message = '') {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Owner sign-in | Clip Studio</title>
<style>html{color-scheme:dark;background:#10171d;color:#eef6f1;font:16px/1.5 system-ui}main{max-width:26rem;margin:12vh auto;padding:2rem}small{color:#a5dbb9;letter-spacing:.15em}label,input,button{display:block;font:inherit}input{width:95%;padding:.55rem;margin:.5rem 0 1rem}button{background:#b6f0cd;color:#15261c;border:0;border-radius:6px;padding:.6rem 1.2rem;cursor:pointer}</style></head>
<body><main><small>CLIP STUDIO / PRIVATE ACCESS</small><h1>Owner sign-in</h1>${message ? `<p role="alert">${message}</p>` : ''}
${configured ? '<p>Sign in to the same studio and library that run on your PC.</p><form method="post" action="/auth/login"><label for="password">Studio password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required><button>Sign in</button></form>' :
  '<p>Remote access is locked. On the studio PC, open <strong>localhost:4318 → Privacy &amp; setup → Remote access</strong> to set the owner password. It cannot be set here.</p>'}
<p>Not a Google, GitHub or social account sign-in.</p></main></body></html>`);
}

export class OwnerAccess {
  constructor(store, clock = Date.now) {
    this.store = store; this.clock = clock; this.sessions = new Map(); this.attempts = []; this.inFlight = 0;
  }
  current() { return this.store.setting(key, null); }
  status() { const record = this.current(); return { configured: !!record, revision: record?.revision ?? null }; }
  async set(password, expectedRevision) {
    const check = () => {
      if (expectedRevision !== this.status().revision) throw new Error('Owner password changed; refresh setup before changing it.');
    };
    check();
    let record = null;
    if (password !== null) {
      if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('Use a password of 12 to 256 characters.');
      const salt = randomBytes(16).toString('hex');
      const hash = await derive(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 ** 2 });
      record = { revision: randomBytes(16).toString('hex'), salt, hash: hash.toString('hex') };
    }
    check();
    this.store.setSetting(key, record); this.revoke();
    return this.status();
  }
  revoke() { this.sessions.clear(); this.attempts = []; }
  token(req) {
    const match = (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${cookie}=`));
    const value = match?.slice(cookie.length + 1);
    return value && /^[a-f0-9]{64}$/.test(value) ? digest(value) : null;
  }
  async gate(req, res, binding, active) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store'); res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Vary', 'Origin, Cookie'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    if (!binding || !active() || req.headers.host !== new URL(binding.origin).host ||
        !req.url?.startsWith('/') || req.url.startsWith('//')) { json(res, 403, { error: 'Remote origin is not active.' }); return; }
    const path = new URL(req.url, binding.origin).pathname, origin = req.headers.origin;
    if (req.method === 'GET' && path === beacon && (!origin || origin === pagesOrigin || origin === binding.origin)) {
      if (origin === pagesOrigin) res.setHeader('Access-Control-Allow-Origin', pagesOrigin);
      json(res, 200, { service, instance: binding.instance }); return;
    }
    if ((origin && origin !== binding.origin) || (!['GET','HEAD'].includes(req.method) && origin !== binding.origin)) {
      json(res, 403, { error: 'This request must come from the studio origin.' }); return;
    }
    const now = this.clock();
    if (path === '/auth/login' && req.method === 'POST') {
      const record = this.current();
      if (!record) { signInPage(res, 403, false); return; }
      if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') { json(res, 415, { error: 'Use the sign-in form.' }); return; }
      this.attempts = this.attempts.filter(a => a.time > now - windowMs);
      const ip = req.headers['cf-connecting-ip'];
      const bucket = typeof ip === 'string' && isIP(ip) ? ip : 'unknown';
      if (this.inFlight >= 3 || this.attempts.length >= 30 || this.attempts.filter(a => a.bucket === bucket).length >= 5) {
        res.setHeader('Retry-After', '600'); signInPage(res, 429, true, 'Too many attempts. Try again in ten minutes.'); return;
      }
      this.attempts.push({ bucket, time: now }); this.inFlight++;
      try {
        let length = 0; const chunks = [];
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 4096) { json(res, 413, { error: 'Sign-in form too large.' }); return; }
          chunks.push(chunk);
        }
        const password = new URLSearchParams(Buffer.concat(chunks).toString()).get('password');
        const hash = typeof password === 'string' && password.length <= 256
          ? await derive(password, record.salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 ** 2 }) : null;
        if (!hash || !timingSafeEqual(hash, Buffer.from(record.hash, 'hex')) || !active() || this.status().revision !== record.revision) {
          signInPage(res, 401, this.status().configured, 'Sign-in failed.'); return;
        }
        const token = randomBytes(32).toString('hex');
        for (const [k,s] of this.sessions) if (s.expires <= now) this.sessions.delete(k);
        if (this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value);
        this.sessions.set(digest(token), { csrf: randomBytes(32).toString('hex'), expires: now + lifetime, instance: binding.instance });
        this.attempts = this.attempts.filter(a => a.bucket !== bucket);
        res.writeHead(303, { Location: '/', 'Set-Cookie': cookieString(token, lifetime / 1000) }); res.end();
      } finally { this.inFlight--; }
      return;
    }
    const key = this.token(req), session = this.sessions.get(key);
    if (!session || session.instance !== binding.instance || session.expires <= now) {
      if (key) this.sessions.delete(key);
      if (req.method === 'GET' && path === '/') signInPage(res, 200, this.status().configured);
      else json(res, 401, { error: 'Owner sign-in required. Reload the studio to sign in.' });
      return;
    }
    if (!['GET','HEAD'].includes(req.method) && req.headers['x-studio-token'] !== session.csrf) {
      json(res, 403, { error: 'Invalid session token; reload the studio.' }); return;
    }
    if (path === '/auth/logout' && req.method === 'POST') {
      this.sessions.delete(key); res.setHeader('Set-Cookie', cookieString('', 0)); json(res, 200, { signedOut: true }); return;
    }
    if (path === '/api/shutdown' || path.startsWith('/api/remote/')) {
      json(res, 403, { error: 'Machine administration is available only on the studio PC.' }); return;
    }
    return session;
  }
}
