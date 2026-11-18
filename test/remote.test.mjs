import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { StudioAccess } from '../src/remote-auth.mjs';
import { Store } from '../src/store.mjs';
import { Uploads } from '../src/uploads.mjs';
import { destination, verifyBeacon, pagesOrigin, beacon, leaseMs, offline } from '../launcher/policy.mjs';
import { waitForBeacon } from '../scripts/remote.mjs';

const origin = 'https://test-studio.trycloudflare.com', instance = 'af'.repeat(16);
const fixture = { origin, instance };
test('a late-resolving issued hostname gets at least 90 seconds to verify; permanent failure is bounded', async () => {
  let elapsed = 0, available = true;
  const delayed = new Error('DNS not ready');
  const options = { now: () => elapsed, wait: async delay => { elapsed += delay; }, verify: async (target, expected) => {
    assert.equal(target, origin); assert.equal(expected, instance);
    if (!available || elapsed < 92_000) throw delayed;
  } };
  await waitForBeacon(fixture, options);
  assert.ok(elapsed >= 92_000 && elapsed < 100_000);
  elapsed = 0; available = false;
  await assert.rejects(waitForBeacon(fixture, options), error => error === delayed);
  assert.equal(elapsed, 100_000);
});
test('one form registers a new email, authenticates a returning account and records the session actor', async () => {
  const store = new Store(':memory:'), auth = new StudioAccess(store);
  let active = true;
  const server = createServer(async (req,res) => {
    const session = await auth.gate(req,res,fixture,() => active);
    if (session) res.end(JSON.stringify({ csrf: session.csrf, email: session.email }));
  });
  await new Promise(ok => server.listen(0,'127.0.0.1',ok));
  // Node's native http client preserves the supplied Host for the simulated tunnel ingress.
  const { request } = await import('node:http');
  const send = (path, method = 'GET', headers = {}, body = '') => new Promise((ok,fail) => {
    const req = request({ host:'127.0.0.1',port:server.address().port,path,method,
      headers:{host:new URL(origin).host,...headers} }, res => {
      let text=''; res.on('data',chunk => text+=chunk); res.on('end',()=>ok({status:res.statusCode,headers:res.headers,text}));
    }); req.once('error',fail); req.end(body);
  });
  const email = 'fixture@example.invalid', password = randomBytes(24).toString('hex'), wrong = 'not-the-fixture-password';
  const login = (value, site = origin, address = email) => send('/auth/login','POST',{Origin:site,'Content-Type':'application/x-www-form-urlencoded'},new URLSearchParams({email:address,password:value}).toString());
  try {
    const locked = await send('/');
    assert.match(locked.text,/name="email"/);
    assert.match(locked.text,/name="password"/);
    assert.doesNotMatch(locked.text,/set the owner password/i);
    assert.equal(locked.headers['referrer-policy'],'same-origin');
    assert.equal((await send('/api/state')).status,401);
    assert.equal((await send('/api/remote/password','POST',{Origin:origin})).status,401);
    assert.equal((await login(password,'https://different.example')).status,403);
    assert.equal((await login(password,'null')).status,403);
    assert.equal((await login('short')).status,400);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM studio_users').n,0);
    const success = await login(password); assert.equal(success.status,303);
    assert.ok(!JSON.stringify(store.get('SELECT * FROM studio_users')).includes(password));
    const set = success.headers['set-cookie'][0]; assert.match(set, /Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Strict$/);
    const Cookie = set.split(';')[0], session = JSON.parse((await send('/api/state','GET',{Cookie})).text);
    assert.ok(session.csrf); assert.equal(session.email,email);
    const write = {Cookie,Origin:origin,'X-Studio-Token':session.csrf};
    assert.equal((await send('/api/remote/password','POST',write)).status,403);
    assert.equal((await send('/api/shutdown','POST',write)).status,403);
    assert.equal((await send('/api/workspaces','POST',{Cookie,Origin:origin})).status,403);
    assert.equal((await send('/api/workspaces','POST',{...write,Origin:'https://different.example'})).status,403);
    assert.equal((await send('/api/workspaces','POST',write)).status,200);
    assert.equal((await send('/api/state','GET',{Cookie,host:'localhost:4318'})).status,403);
    const ping = await send(beacon,'GET',{Origin:pagesOrigin}); assert.equal(ping.status,200);
    assert.equal(ping.headers['access-control-allow-origin'],pagesOrigin);
    assert.deepEqual(Object.keys(JSON.parse(ping.text)).sort(),['instance','service']);
    assert.equal((await send('/api/state','GET',{Cookie,Origin:pagesOrigin})).status,403);
    assert.equal((await send('/auth/logout','POST',write)).status,200);
    assert.equal((await send('/api/state','GET',{Cookie})).status,401);
    assert.equal((await login(password,origin,email.toUpperCase())).status,303);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM studio_users').n,1);
    assert.deepEqual(store.all('SELECT email,action FROM activity ORDER BY id').map(({email,action})=>[email,action]), [
      [email,'Created studio account'],[email,'Signed in'],[email,'Signed out'],[email,'Signed in'],
    ]);
    assert.equal((await login(password,origin,'second@example.invalid')).status,303);
    for(let i=0;i<4;i++) assert.equal((await login(wrong)).status,401);
    assert.equal((await login(password)).status,429);
    active=false; assert.equal((await send(beacon)).status,403);
  } finally { server.closeAllConnections(); await new Promise(ok=>server.close(ok)); store.close(); }
});

test('concurrent first visits to one email never replace the first password or create two accounts', async () => {
  const store = new Store(':memory:'), auth = new StudioAccess(store), email = 'race@example.invalid';
  try {
    const passwords = [randomBytes(20).toString('hex'), randomBytes(20).toString('hex')];
    const results = await Promise.all(passwords.map(p => auth.registerOrLogin(email,p,()=>true)));
    assert.equal(results.filter(Boolean).length,1);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM studio_users').n,1);
    assert.equal(await auth.registerOrLogin(email,passwords[results.indexOf(false)],()=>true),false);
    assert.equal(await auth.registerOrLogin(email,passwords[results.indexOf(true)],()=>true),true);
  } finally { store.close(); }
});

test('chunk uploads bind ownership, validate offsets, and admit only complete verified bytes', async () => {
  const root = await mkdtemp(join(tmpdir(),'clip-chunks-')); let admitted=0;
  const uploads = new Uploads(root, async (file,workspace,name,signal,recovery) => {
    admitted++; assert.equal(await readFile(file,'utf8'),'abcdef');
    assert.equal(workspace,'original'); assert.equal(recovery,'job'); return {id:'asset'};
  });
  const stream = (text,n=text.length) => Object.assign(Readable.from([Buffer.from(text)]),{headers:{'content-length':String(n)}});
  try {
    await uploads.init();
    const {id} = await uploads.begin('session',{size:6,name:'video.mp4',workspace:'original',recovery:'job'});
    await assert.rejects(uploads.append(id,'other',stream('abc'),0),/owned/);
    await assert.rejects(uploads.finish(id,'session'),/incomplete/);
    await assert.rejects(uploads.append(id,'session',stream('ab',3),0),/Incomplete/);
    assert.equal(uploads.get(id,'session').offset,0);
    assert.deepEqual(await uploads.append(id,'session',stream('abc'),0),{offset:3});
    await assert.rejects(uploads.append(id,'session',stream('abc'),0),/offset/);
    await uploads.append(id,'session',stream('def'),3);
    assert.deepEqual(await uploads.finish(id,'session'),{id:'asset'});
    await assert.rejects(uploads.finish(id,'session'),/expired/);
    assert.equal(admitted,1);
    const extra = await uploads.begin('session',{size:1}); await uploads.cancel(extra.id,'session');
    assert.throws(()=>uploads.get(extra.id,'session'),/expired/);
  } finally { await rm(root,{force:true,recursive:true}); }
});

test('launcher follows only a current full-studio address and the matching live instance', async () => {
  const t = Date.now(), pointer={version:2,status:'online',origin,instance,issuedAt:t,expiresAt:t+leaseMs};
  assert.equal(destination(offline),null); assert.equal(destination(pointer,t),origin);
  for (const change of [{origin:'https://unrelated.example'}, {origin:origin+'/x'}, {expiresAt:t}, {version:1}]) {
    assert.throws(()=>destination({...pointer,...change},t));
  }
  await assert.rejects(verifyBeacon(origin,instance,async()=>Response.json({service:'clip-studio-public-editor-v1',instance})),/does not match/);
  await verifyBeacon(origin,instance,async()=>Response.json({service:'clip-studio-full-v1',instance}));
});
