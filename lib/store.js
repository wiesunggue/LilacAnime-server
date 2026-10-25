// All comparisons, writes and revision allocation happen in one Redis script.
// A pipeline alone is not a transaction: another device can write between commands.
const PREFIX = 'lilac:v1:';
const KEY = { updated: `${PREFIX}updated`, items: `${PREFIX}items`, changes: `${PREFIX}changes`, rev: `${PREFIX}rev` };
const KEYS = Object.values(KEY);

const COMMIT = `
local accepted = 0
local current = {}
for i = 1, #ARGV, 3 do
  local member, updated, value = ARGV[i], tonumber(ARGV[i + 1]), ARGV[i + 2]
  local known = tonumber(redis.call('HGET', KEYS[1], member))
  if not known or updated > known then
    local rev = redis.call('INCR', KEYS[4])
    redis.call('HSET', KEYS[1], member, ARGV[i + 1])
    redis.call('HSET', KEYS[2], member, value)
    redis.call('ZADD', KEYS[3], rev, member)
    accepted = accepted + 1
  else
    table.insert(current, redis.call('HGET', KEYS[2], member))
  end
end
return {tonumber(redis.call('GET', KEYS[4])) or 0, accepted, current}
`;

// Read the values, scores and high-water revision in the same snapshot. A separate
// GET rev after reading rows could acknowledge a write that this device never saw.
const CHANGES = `
local rows = redis.call('ZRANGEBYSCORE', KEYS[3], '(' .. ARGV[1], '+inf', 'WITHSCORES', 'LIMIT', 0, ARGV[2])
local result = {}
for i = 1, #rows, 2 do
  table.insert(result, {rows[i], tonumber(rows[i + 1]), redis.call('HGET', KEYS[2], rows[i])})
end
return {tonumber(redis.call('GET', KEYS[4])) or 0, result}
`;

export function redisStore(env = process.env, fetchImpl = globalThis.fetch) {
  // Don't mix a URL from one integration with a token from a different one.
  const pair = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
    ? [env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN]
    : [env.KV_REST_API_URL, env.KV_REST_API_TOKEN];
  const [url, token] = pair;
  if (!url || !token) return null;
  async function command(args) {
    const response = await fetchImpl(url.replace(/\/+$/, ''), {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Upstash HTTP ${response.status}`);
    const result = await response.json();
    if (result.error) throw new Error(`Upstash: ${result.error}`);
    return result.result;
  }
  const evaluate = (script, args) => command(['EVAL', script, String(KEYS.length), ...KEYS, ...args]);
  return {
    async ping() { return await command(['PING']) === 'PONG'; },
    async commit(entries) {
      const [rev, accepted, values] = await evaluate(COMMIT, entries.flatMap(e => [e.member, String(e.updated), e.value]));
      const sent = new Map(entries.map(e => [e.member, e.value]));
      const current = values.filter(Boolean).map(value => JSON.parse(value))
        .filter(item => JSON.stringify(item) !== sent.get(`${item.collection}\n${item.id}`));
      return { rev: Number(rev), accepted: Number(accepted), current };
    },
    async changes(since, limit) {
      const [rev, rows] = await evaluate(CHANGES, [String(since), String(limit)]);
      return { rev: Number(rev), rows: rows.map(([member, rev, value]) => ({ member, rev: Number(rev), value })) };
    },
    async hit(key, ttl) {
      return Number(await command(['EVAL', `local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return n`, '1', `${PREFIX}${key}`, String(ttl)]));
    },
    async clearHits(key) { await command(['DEL', `${PREFIX}${key}`]); },
  };
}

export function memoryStore() {
  const updated = new Map(), items = new Map(), changes = new Map(), hits = new Map();
  let rev = 0;
  return {
    async ping() { return true; },
    async commit(entries) {
      let accepted = 0;
      const current = [];
      // No await inside the operation: same atomic contract as the Redis script.
      for (const entry of entries) {
        if (updated.has(entry.member) && updated.get(entry.member) >= entry.updated) {
          const value = items.get(entry.member);
          if (value !== entry.value) current.push(JSON.parse(value));
        } else {
          rev++; accepted++;
          updated.set(entry.member, entry.updated); items.set(entry.member, entry.value); changes.set(entry.member, rev);
        }
      }
      return { rev, accepted, current };
    },
    async changes(since, limit) {
      return { rev, rows: [...changes].filter(([, at]) => at > since).sort((a, b) => a[1] - b[1]).slice(0, limit)
        .map(([member, at]) => ({ member, rev: at, value: items.get(member) })) };
    },
    async hit(key, ttl) {
      const now = Date.now(), current = hits.get(key);
      const next = current && current.until > now ? { count: current.count + 1, until: current.until } : { count: 1, until: now + ttl * 1000 };
      hits.set(key, next); return next.count;
    },
    async clearHits(key) { hits.delete(key); },
  };
}
