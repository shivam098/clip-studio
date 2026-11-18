import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { OwnerAccess } from '../src/remote-auth.mjs';
import { Store } from '../src/store.mjs';
import { Uploads } from '../src/uploads.mjs';
import { destination, verifyBeacon, pagesOrigin, beacon, leaseMs, offline } from '../launcher/policy.mjs';

const origin = 'https://test-studio.trycloudflare.com', instance = 'af'.repeat(16);
const fixture = { origin, instance };
test('isolated tunnel listener locks without a password, authenticates the exact origin, revokes sessions, and never grants local setup', async () => {
  const store = new Store(':memory:'), auth = new OwnerAccess(store);
  let active = true;
  const server = createServer(async (req,res) => {
    const session = await auth.gate(req,res,fixture,() => active);
    if (session) res.end(JSON.stringify({ csrf: session.csrf }));
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
  const password = randomBytes(24).toString('hex');
  const login = (value, site = origin) => send('/auth/login','POST',{Origin:site,'Content-Type':'application/x-www-form-urlencoded'},new URLSearchParams({password:value}).toString());
  try {
    assert.match((await send('/')).text,/cannot be set here/);
    assert.equal((await send('/api/state')).status,401);
    assert.equal((await send('/api/remote/password','POST',{Origin:origin})).status,401);
    const pw = await auth.set(password, null);
    assert.ok(!JSON.stringify(auth.current()).includes(password));
    assert.equal((await login(password,'https://different.example')).status,403);
    assert.equal((await login('wrong')).status,401);
    const success = await login(password); assert.equal(success.status,303);
    const set = success.headers['set-cookie'][0]; assert.match(set, /Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Strict$/);
    const Cookie = set.split(';')[0], session = JSON.parse((await send('/api/state','GET',{Cookie})).text);
    assert.ok(session.csrf);
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
    for(let i=0;i<5;i++) assert.equal((await login('wrong')).status,401);
    assert.equal((await login(password)).status,429);
    await auth.set(null,pw.revision);
    assert.equal((await login(password)).status,403);
    active=false; assert.equal((await send(beacon)).status,403);
  } finally { server.closeAllConnections(); await new Promise(ok=>server.close(ok)); store.close(); }
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
