// Items and how two devices' changes meet: each item (one anime in 내 목록, one entry of 시청 기록) is kept whole, and
// the change made last wins (its "updated" time, set by the device that made it). A removal is kept as a tombstone
// (deleted: true) so the other devices remove it too.

export const COLLECTIONS = ['library', 'history'];
export const MAX_ITEMS = 500, MAX_ITEM_BYTES = 64 * 1024, PAGE = 500;

const memberOf = (collection, id) => `${collection}\n${id}`;

// An item as a device sends it, or the reason it is refused.
export function checkItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return '항목이 객체가 아닙니다.';
  if (!COLLECTIONS.includes(item.collection)) return `collection은 ${COLLECTIONS.join(', ')} 중 하나여야 합니다.`;
  if (typeof item.id !== 'string' || !item.id || item.id.length > 512 || item.id.includes('\n')) return 'id는 512자 이하의 문자열이어야 합니다.';
  if (!Number.isSafeInteger(item.updated) || item.updated <= 0) return 'updated는 변경 시각(ms)이어야 합니다.';
  if (item.deleted !== undefined && typeof item.deleted !== 'boolean') return 'deleted는 boolean이어야 합니다.';
  if (!item.deleted && (!item.data || typeof item.data !== 'object' || Array.isArray(item.data))) return '삭제가 아닌 항목에는 data 객체가 있어야 합니다.';
  if (Buffer.byteLength(JSON.stringify(normalized(item))) > MAX_ITEM_BYTES) return '항목은 64KB 이하여야 합니다.';
  return null;
}

// Stores the items that are newer than what the server has. Returns the revision after the write and which were kept.
export async function push(store, items) {
  // The same item twice in one batch: the later change only.
  const latest = new Map();
  for (const item of items) { const member = memberOf(item.collection, item.id), seen = latest.get(member); if (!seen || item.updated >= seen.updated) latest.set(member, item); }
  const entries = [...latest].map(([member, item]) => ({ member, updated: item.updated, value: JSON.stringify(normalized(item)) }));
  return store.commit(entries);
}

export const normalized = item => item.deleted
  ? { collection: item.collection, id: item.id, updated: item.updated, deleted: true }
  : { collection: item.collection, id: item.id, updated: item.updated, data: item.data };

// The items changed after revision "since", oldest change first, a page at a time.
export async function pull(store, since, limit = PAGE) {
  const { rows, rev } = await store.changes(since, limit + 1);
  const page = []; let bytes = 0;
  for (const row of rows.slice(0, limit)) {
    const size = Buffer.byteLength(row.value) + 64;
    if (page.length && bytes + size > 3 * 1024 * 1024) break;
    page.push(row); bytes += size;
  }
  const more = rows.length > page.length;
  const items = page.map(row => ({ ...JSON.parse(row.value), rev: row.rev }));
  return { items, more, rev: more ? page[page.length - 1].rev : Math.max(since, rev) };
}
