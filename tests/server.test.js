import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore, redisStore } from '../lib/store.js';
import { tokenFor } from '../lib/auth.js';
import { statusHandler } from '../api/status.js';
import { loginHandler, LOCK_AFTER } from '../api/login.js';
import { syncHandler } from '../api/sync.js';

const PASSWORD = 'correct horse';
async function call(handler, { method = 'GET', url = '/', body, headers = {}, ip = '1.2.3.4' } = {}) {
  const req = { method, url, body, headers: { 'x-forwarded-for': ip, ...headers } }, res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
  res.end = text => { res.text = text; };
  await handler(req, res);
  return { status: res.statusCode, body: res.text ? JSON.parse(res.text) : null, headers: res.headers };
}
function server(store = memoryStore(), password = PASSWORD) {
  const context = { store, password };
  return { status: statusHandler(context), login: loginHandler(context), sync: syncHandler(context), store };
}
const auth = { authorization: `Bearer ${tokenFor(PASSWORD)}` };
const anime = (id, updated, extra = {}) => ({ collection: 'library', id, updated, data: { mal_id: id, title: `작품 ${id}`, ...extra } });

test('status says what is missing before the owner finishes the setup', async () => {
  const missing = await call(statusHandler({ store: null, password: null }));
  assert.equal(missing.body.ready, false); assert.equal(missing.body.problems.length, 2);
  assert.equal(missing.headers['access-control-allow-origin'], '*');
  assert.deepEqual((await call(server().status)).body, { app: 'lilacanime-server', version: 1, ready: true, problems: [] });
  assert.equal((await call(syncHandler({ store: null, password: PASSWORD }), { headers: auth })).status, 503);
});

test('signing in gives the token; a wrong password is refused and too many lock the address out', async () => {
  const s = server();
  const ok = await call(s.login, { method: 'POST', body: { password: PASSWORD } });
  assert.equal(ok.status, 200); assert.equal(ok.body.token, tokenFor(PASSWORD));
  for (let i = 0; i < LOCK_AFTER; i++) assert.equal((await call(s.login, { method: 'POST', body: { password: 'nope' }, ip: '9.9.9.9' })).status, 401);
  assert.equal((await call(s.login, { method: 'POST', body: { password: PASSWORD }, ip: '9.9.9.9' })).status, 200, 'the right password still works and clears the count');
  for (let i = 0; i <= LOCK_AFTER; i++) await call(s.login, { method: 'POST', body: { password: 'nope' }, ip: '8.8.8.8' });
  assert.equal((await call(s.login, { method: 'POST', body: { password: 'nope' }, ip: '8.8.8.8' })).status, 429);
  assert.equal((await call(s.login, { method: 'POST', body: { password: 'nope' }, ip: '7.7.7.7' })).status, 401, 'other addresses are not locked');
  assert.equal((await call(s.sync, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await call(s.sync)).status, 401);
});

test('two devices: the later change of an item wins, removals reach the other device, pages follow revisions', async () => {
  const s = server();
  const pushed = await call(s.sync, { method: 'POST', headers: auth, body: { items: [anime('a', 100), anime('b', 100), { collection: 'history', id: 'h1', updated: 100, data: { progress: 10 } }] } });
  assert.deepEqual(pushed.body, { rev: 3, accepted: 3, current: [] });
  // The other device: everything, then nothing new.
  const all = await call(s.sync, { headers: auth, url: '/api/sync?since=0' });
  assert.equal(all.body.items.length, 3); assert.equal(all.body.rev, 3); assert.equal(all.body.more, false);
  assert.deepEqual((await call(s.sync, { headers: auth, url: '/api/sync?since=3' })).body, { items: [], more: false, rev: 3 });
  // An older change loses; a newer one and a removal win.
  const behind = (await call(s.sync, { method: 'POST', headers: auth, body: { items: [anime('a', 50, { title: 'old' })] } })).body;
  assert.deepEqual([behind.rev, behind.accepted, behind.current.map(item => [item.id, item.updated, item.data.title])], [3, 0, [['a', 100, '작품 a']]], 'a device behind gets the copy on the server back');
  // The same item twice in one batch: its later change (the removal) only.
  const second = await call(s.sync, { method: 'POST', headers: auth, body: { items: [anime('a', 140, { title: 'mid' }), anime('b', 200, { title: 'new' }), { collection: 'library', id: 'a', updated: 150, deleted: true }] } });
  assert.deepEqual(second.body, { rev: 5, accepted: 2, current: [] });
  assert.deepEqual((await call(s.sync, { method: 'POST', headers: auth, body: { items: [{ collection: 'library', id: 'a', updated: 150, deleted: true }] } })).body, { rev: 5, accepted: 0, current: [] }, 'sent again: nothing new, and its own copy is not sent back');
  const changed = await call(s.sync, { headers: auth, url: '/api/sync?since=3' });
  assert.deepEqual(changed.body.items.map(item => [item.id, item.deleted || false, item.data?.title, item.rev]), [['a', true, undefined, 4], ['b', false, 'new', 5]]);
});

test('a long history comes a page at a time', async () => {
  const s = server(), items = Array.from({ length: 1200 }, (_, i) => ({ collection: 'history', id: `h${i}`, updated: 1000 + i, data: { i } }));
  for (let i = 0; i < items.length; i += 500) await call(s.sync, { method: 'POST', headers: auth, body: { items: items.slice(i, i + 500) } });
  let since = 0, seen = 0, pages = 0, more = true;
  while (more) { const page = (await call(s.sync, { headers: auth, url: `/api/sync?since=${since}` })).body; seen += page.items.length; since = page.rev; more = page.more; pages++; }
  assert.equal(seen, 1200); assert.equal(pages, 3); assert.equal(since, 1200);
});

test('bad requests are refused with the reason', async () => {
  const s = server();
  const bad = async items => (await call(s.sync, { method: 'POST', headers: auth, body: { items } }));
  assert.equal((await bad([{ collection: 'settings', id: 'x', updated: 1, data: {} }])).status, 400);
  assert.equal((await bad([{ collection: 'library', id: '', updated: 1, data: {} }])).status, 400);
  assert.equal((await bad([{ collection: 'library', id: 'x', updated: 'now', data: {} }])).status, 400);
  assert.equal((await bad([{ collection: 'library', id: 'x', updated: 1 }])).status, 400);
  assert.equal((await bad(Array.from({ length: 501 }, (_, i) => anime(`x${i}`, 1)))).status, 413);
  assert.match((await bad([{ collection: 'library', id: 'x', updated: 1 }])).body.error, /items\[0\]/);
  assert.equal((await call(s.sync, { headers: auth, url: '/api/sync?since=-1' })).status, 400);
  const huge = await bad([anime('big', 1, { blob: 'x'.repeat(70 * 1024) })]);
  assert.equal(huge.status, 400, 'oversized items fail visibly instead of being silently lost');
  assert.equal((await bad([anime('ok', 1), anime('big', 1, { blob: 'x'.repeat(70 * 1024) })])).status, 400);
  assert.equal((await call(s.sync, { headers: auth })).body.items.length, 0, 'a rejected batch writes nothing');
});


test('equal timestamps with different content return the authoritative copy', async () => {
  const s = server();
  await call(s.sync, { method: 'POST', headers: auth, body: { items: [anime('a', 100)] } });
  const result = await call(s.sync, { method: 'POST', headers: auth, body: { items: [anime('a', 100, { title: 'different' })] } });
  assert.equal(result.body.accepted, 0);
  assert.equal(result.body.current[0].data.title, '작품 a');
});

test('a write after the read snapshot remains available at the next cursor', async () => {
  const { push, pull } = await import('../lib/sync.js');
  const store = memoryStore();
  await push(store, [anime('a', 100)]);
  const racing = { ...store, async changes(since, limit) {
    const snapshot = await store.changes(since, limit);
    await push(store, [anime('b', 200)]);
    return snapshot;
  } };
  const first = await pull(racing, 0);
  assert.equal(first.rev, 1);
  assert.deepEqual((await pull(store, first.rev)).items.map(x => x.id), ['b']);
});

test('malformed types, unsafe cursors, UTF-8 buffers and body limits', async () => {
  const s = server();
  for (const item of [anime('a', 1.5), { ...anime('a', 1), data: [] }, { ...anime('a', 1), deleted: 'false' }]) {
    assert.equal((await call(s.sync, { method: 'POST', headers: auth, body: { items: [item] } })).status, 400);
  }
  assert.equal((await call(s.sync, { headers: auth, url: '/api/sync?since=9007199254740992' })).status, 400);
  assert.equal((await call(s.login, { method: 'POST', body: Buffer.from(JSON.stringify({ password: PASSWORD })) })).status, 200);
  assert.equal((await call(s.login, { method: 'POST', body: ' '.repeat(4 * 1024 * 1024 + 1) })).status, 413);
  const preflight = await call(s.sync, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204); assert.equal(preflight.body, null);
});

test('store outages stay JSON with CORS, without exposing credentials', async () => {
  const s = server({ async changes() { throw new Error('private token'); }, async hit() { throw new Error('private token'); } });
  const response = await call(s.sync, { headers: auth });
  assert.equal(response.status, 503);
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.doesNotMatch(response.body.error, /private token/);
  assert.equal((await call(s.login, { method: 'POST', body: { password: 'wrong' } })).status, 503);
});

test('readiness checks the database connection rather than only environment variable presence', async () => {
  const response = await call(statusHandler({ password: PASSWORD, store: { async ping() { throw new Error('bad token'); } } }));
  assert.equal(response.status, 200); assert.equal(response.body.ready, false);
  assert.match(response.body.problems[0], /Upstash Redis/);
  assert.doesNotMatch(response.body.problems[0], /bad token/);
});

test('large records use byte-bounded pages without skipping the remainder', async () => {
  const { push, pull } = await import('../lib/sync.js');
  const store = memoryStore();
  await push(store, Array.from({ length: 60 }, (_, i) => anime(String(i), i + 1, { text: 'x'.repeat(60 * 1024) })));
  const first = await pull(store, 0);
  assert.equal(first.more, true); assert.ok(first.items.length < 60);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 4 * 1024 * 1024);
  const second = await pull(store, first.rev);
  assert.equal(second.more, false); assert.equal(first.items.length + second.items.length, 60);
});
