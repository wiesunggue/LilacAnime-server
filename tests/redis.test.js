import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redisStore } from '../lib/store.js';
import { push, pull } from '../lib/sync.js';

const binary = process.env.REDIS_SERVER || 'redis-server';
const available = spawnSync(binary, ['--version']).status === 0;

// Minimal RESP client so the production Lua scripts run in a real Redis, without
// replacing EVAL with a mock implementation of the algorithm being tested.
function command(socket, args) {
  return new Promise((resolve, reject) => {
    const client = connect({ host: '127.0.0.1', port: socket });
    client.setTimeout(5000, () => client.destroy(new Error('Redis timeout'))); let buffer = Buffer.alloc(0);
    const parse = at => {
      const end = buffer.indexOf('\r\n', at); if (end < 0) return null;
      const kind = String.fromCharCode(buffer[at]), value = buffer.toString('utf8', at + 1, end);
      let next = end + 2;
      if (kind === '-') throw new Error(value);
      if (kind === '+' || kind === ':') return { value: kind === ':' ? Number(value) : value, next };
      if (kind === '$') {
        const size = Number(value); if (size === -1) return { value: null, next };
        if (buffer.length < next + size + 2) return null;
        return { value: buffer.toString('utf8', next, next + size), next: next + size + 2 };
      }
      if (kind === '*') {
        const items = [];
        for (let i = 0; i < Number(value); i++) { const item = parse(next); if (!item) return null; items.push(item.value); next = item.next; }
        return { value: items, next };
      }
      throw new Error('Invalid RESP');
    };
    client.on('connect', () => client.write(`*${args.length}\r\n` + args.map(x => `$${Buffer.byteLength(String(x))}\r\n${x}\r\n`).join('')));
    client.on('error', reject);
    client.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      try { const result = parse(0); if (result) { client.end(); resolve(result.value); } }
      catch (error) { client.destroy(); reject(error); }
    });
  });
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lilac-redis-'));
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const socket = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const proc = spawn(binary, ['--bind', '127.0.0.1', '--port', String(socket), '--save', '', '--appendonly', 'no', '--dir', dir]);
  t.after(async () => { if (proc.exitCode === null && proc.signalCode === null) { proc.kill(); await new Promise(resolve => proc.once('exit', resolve)); } await rm(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Redis startup timeout')), 5000);
    proc.once('exit', () => clearTimeout(timer));
    proc.stdout.on('data', () => clearTimeout(timer));
    proc.on('error', reject);
    proc.stdout.on('data', data => { if (data.toString().includes('ready to accept connections') || data.toString().includes('Ready to accept connections')) resolve(); });
    proc.once('exit', code => reject(new Error(`Redis exited ${code}`)));
  });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, auth: options.headers.Authorization });
    return { ok: true, json: async () => ({ result: await command(socket, JSON.parse(options.body)) }) };
  };
  return { store: redisStore({ KV_REST_API_URL: 'https://example.upstash.io/', KV_REST_API_TOKEN: 'tok' }, fetchImpl), calls };
}
const item = (id, updated) => ({ collection: 'library', id, updated, data: { title: `작품 ${updated}` } });

test('Redis: concurrent devices never overwrite a newer item or lose revision updates', { skip: !available }, async t => {
  const { store, calls } = await fixture(t);
  await Promise.all(Array.from({ length: 80 }, (_, i) => push(store, [item('same', 80 - i), item(`id-${i}`, i + 1)])));
  const result = await pull(store, 0);
  assert.equal(result.items.length, 81);
  assert.equal(result.items.find(x => x.id === 'same').updated, 80);
  assert.equal(new Set(result.items.map(x => x.rev)).size, 81);
  assert.ok(calls.every(x => x.url === 'https://example.upstash.io' && x.auth === 'Bearer tok'));
  const stale = await push(store, [item('same', 79)]);
  assert.equal(stale.accepted, 0); assert.equal(stale.current[0].updated, 80);
  const equal = await push(store, [{ ...item('same', 80), data: { title: 'wrong' } }]);
  assert.equal(equal.current[0].data.title, '작품 80');
  assert.deepEqual((await push(store, [item('same', 80)])).current, []);
});

test('Redis: paginated snapshots, tombstones, atomic login counters and TTL', { skip: !available }, async t => {
  const { store } = await fixture(t);
  await push(store, Array.from({ length: 8 }, (_, i) => item(String(i), i + 1)));
  const first = await pull(store, 0, 3);
  assert.equal(first.more, true); assert.equal(first.rev, 3);
  await push(store, [{ collection: 'library', id: '0', updated: 100, deleted: true }]);
  const second = await pull(store, first.rev, 20);
  assert.equal(second.more, false); assert.equal(second.items.at(-1).deleted, true);
  assert.equal(second.rev, 9);
  assert.deepEqual(await Promise.all(Array.from({ length: 10 }, () => store.hit('ip', 600))), [1,2,3,4,5,6,7,8,9,10]);
  await store.clearHits('ip'); assert.equal(await store.hit('ip', 600), 1);
});

test('Redis integrations select matching URL/token pairs', () => {
  assert.equal(redisStore({}), null);
  assert.equal(redisStore({ UPSTASH_REDIS_REST_URL: 'https://a', KV_REST_API_TOKEN: 'b' }), null);
  assert.ok(redisStore({ UPSTASH_REDIS_REST_URL: 'https://a', UPSTASH_REDIS_REST_TOKEN: 'b' }));
});
