import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { beacon, pagesOrigin, service } from '../launcher/policy.mjs';

const derive = promisify(scrypt), lifetime = 12 * 60 * 60_000, windowMs = 10 * 60_000;
const cookie = '__Host-clip-studio', digest = s => createHash('sha256').update(s).digest('hex');
const hashPassword = (password, salt) => derive(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 ** 2 });
const cookieString = (value, age) => `${cookie}=${value}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Strict`;
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
}
function signInPage(res, status, message = '') {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in | Clip Studio</title>
<style>html{color-scheme:dark;background:#10171d;color:#eef6f1;font:16px/1.5 system-ui}main{max-width:26rem;margin:12vh auto;padding:2rem}small{color:#a5dbb9;letter-spacing:.15em}label,input,button{display:block;font:inherit}input{width:95%;padding:.55rem;margin:.5rem 0 1rem}button{background:#b6f0cd;color:#15261c;border:0;border-radius:6px;padding:.6rem 1.2rem;cursor:pointer}</style></head>
<body><main><small>CLIP STUDIO / SHARED STUDIO</small><h1>Sign in to Clip Studio</h1>${message ? `<p role="alert">${message}</p>` : ''}
<p>New here? Enter your email and choose a password. Already registered? Use the same email and password.</p>
<form method="post" action="/auth/login"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" maxlength="254" required>
<label for="password">Studio password (at least 12 characters)</label><input id="password" name="password" type="password" autocomplete="current-password" minlength="12" maxlength="256" required><button>Continue</button></form>
<p>Everyone who signs up has full access to the shared studio. Activity shows your email beside your actions. Email addresses are not verified.</p></main></body></html>`);
}

export class StudioAccess {
  constructor(store, clock = Date.now) {
    this.store = store; this.clock = clock; this.sessions = new Map(); this.attempts = []; this.inFlight = 0;
  }
  async registerOrLogin(email, password, active) {
    const lookup = () => this.store.get('SELECT salt,password_hash FROM studio_users WHERE email=?', email);
    let record = lookup();
    if (!record) {
      const salt = randomBytes(16).toString('hex');
      const hash = await hashPassword(password, salt);
      if (!active()) return false;
      const created = this.store.tx(() => {
        const inserted = this.store.run('INSERT INTO studio_users VALUES (?,?,?,?) ON CONFLICT(email) DO NOTHING',
          email, salt, hash.toString('hex'), this.clock()).changes;
        if (inserted) {
          this.store.recordAction(email, 'Created studio account', null, 201);
          this.store.recordAction(email, 'Signed in', null, 200);
        }
        return inserted;
      });
      if (created) return true;
      // Another first visit registered this email during scrypt. Only its password can now sign in.
      record = lookup();
    }
    if (!record) return false;
    const hash = await hashPassword(password, record.salt);
    if (!active() || !timingSafeEqual(hash, Buffer.from(record.password_hash, 'hex')) || lookup()?.password_hash !== record.password_hash) return false;
    this.store.recordAction(email, 'Signed in', null, 200);
    return true;
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
    // A native form POST with no-referrer can send Origin: null. Keep the true origin
    // for same-site sign-in and writes, but never send a referrer to another origin.
    res.setHeader('Vary', 'Origin, Cookie'); res.setHeader('Referrer-Policy', 'same-origin');
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
      if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') { json(res, 415, { error: 'Use the sign-in form.' }); return; }
      this.attempts = this.attempts.filter(a => a.time > now - windowMs);
      const ip = req.headers['cf-connecting-ip'];
      const bucket = typeof ip === 'string' && isIP(ip) ? ip : 'unknown';
      if (this.inFlight >= 3 || this.attempts.length >= 30 || this.attempts.filter(a => a.bucket === bucket).length >= 5) {
        res.setHeader('Retry-After', '600'); signInPage(res, 429, 'Too many attempts. Try again in ten minutes.'); return;
      }
      const attempt = { bucket, time: now };
      this.attempts.push(attempt); this.inFlight++;
      try {
        let length = 0; const chunks = [];
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 4096) { json(res, 413, { error: 'Sign-in form too large.' }); return; }
          chunks.push(chunk);
        }
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const email = (form.get('email') ?? '').trim().toLowerCase(), password = form.get('password') ?? '';
        if (email.length > 254 || /[\u0000-\u001f\u007f]/.test(email) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ||
            password.length < 12 || password.length > 256) {
          signInPage(res, 400, 'Enter an email address and a password of 12 to 256 characters.'); return;
        }
        if (!(await this.registerOrLogin(email, password, active)) || !active()) {
          signInPage(res, 401, 'That email and password did not match.'); return;
        }
        const token = randomBytes(32).toString('hex');
        for (const [k,s] of this.sessions) if (s.expires <= now) this.sessions.delete(k);
        if (this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value);
        this.sessions.set(digest(token), { email, csrf: randomBytes(32).toString('hex'), expires: now + lifetime, instance: binding.instance });
        this.attempts = this.attempts.filter(a => a !== attempt);
        res.writeHead(303, { Location: '/', 'Set-Cookie': cookieString(token, lifetime / 1000) }); res.end();
      } finally { this.inFlight--; }
      return;
    }
    const key = this.token(req), session = this.sessions.get(key);
    if (!session || session.instance !== binding.instance || session.expires <= now) {
      if (key) this.sessions.delete(key);
      if (req.method === 'GET' && path === '/') signInPage(res, 200);
      else json(res, 401, { error: 'Sign in with your studio email and password.' });
      return;
    }
    if (!['GET','HEAD'].includes(req.method) && req.headers['x-studio-token'] !== session.csrf) {
      json(res, 403, { error: 'Invalid session token; reload the studio.' }); return;
    }
    if (path === '/auth/logout' && req.method === 'POST') {
      this.store.recordAction(session.email, 'Signed out', null, 200);
      this.sessions.delete(key); res.setHeader('Set-Cookie', cookieString('', 0)); json(res, 200, { signedOut: true }); return;
    }
    if (path === '/api/shutdown' || path.startsWith('/api/remote/')) {
      json(res, 403, { error: 'Machine administration is available only on the studio PC.' }); return;
    }
    return session;
  }
}
