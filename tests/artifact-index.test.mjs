import test from 'node:test';
import assert from 'node:assert/strict';
import { createArtifactIndexStore } from '../ui/assets/artifact-index-store.js';

/*
 * storage.global 目录索引测试（对应 Sol 设计 2.x / 测试清单 D）。
 * 契约：
 * - 固定键 fork-chat.artifacts.index.v1，独立锁，加锁→重读→校验→深拷贝→revision+1→set
 * - 分区按 ownerScopeKey，只做缓存隔离，永不是 ACL；后端永远不信索引
 * - 限额：32 分区 / 500 条 / 每条 10 binding / 512 KiB；超限可见失败，不删文件不覆盖他键
 * - 损坏/未知 schema：报 ARTIFACT_INDEX_CORRUPT 并保留原值，禁止清空回写
 * - 索引失败不影响文件已生成的事实
 */

const KEY = 'fork-chat.artifacts.index.v1';
const LOCK = 'fork-chat-artifact-index-v1';

function makeStorage(initial = {}, { failSet = false } = {}) {
  const store = { ...initial };
  const calls = { set: [], get: 0 };
  return {
    hana: {
      storage: {
        global: {
          async get(key) { calls.get += 1; return key === KEY ? (key in store ? structuredClone(store[key]) : undefined) : undefined; },
          async set(key, value) { calls.set.push(key); if (failSet) throw new Error('quota'); store[key] = structuredClone(value); },
        },
      },
    },
    store, calls,
  };
}

function makeLocks(locked = true) {
  const held = [];
  return {
    locks: {
      async request(name, mode, fn) {
        assert.equal(name, LOCK, '必须使用专用索引锁');
        assert.equal(mode, 'exclusive');
        held.push(name);
        return fn();
      },
    },
    held,
  };
}

const meta = id => ({
  artifactId: id, name: `doc-${id}.docx`, format: 'docx',
  mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  bytes: 9920, sha256: 'a'.repeat(64), createdAt: '2026-10-24T00:00:00.000Z',
});

const binding = { canvasId: 'cv1', cardId: 'card-1', requestId: 'req-1' };

test('索引：upsert 幂等，同 key 重复 upsert 不新增条目，binding 去重，revision 递增', async () => {
  const { hana: storage, store, calls } = makeStorage();
  const { locks } = makeLocks();
  const idx = createArtifactIndexStore({ hana: storage, locks, now: () => '2026-10-24T01:00:00.000Z' });
  await idx.upsert('a'.repeat(64), meta('b'.repeat(32)), binding);
  await idx.upsert('a'.repeat(64), meta('b'.repeat(32)), binding);                    // 完全重复 → 幂等
  await idx.upsert('a'.repeat(64), meta('b'.repeat(32)), { ...binding, cardId: 'card-2' }); // 新 binding
  const root = JSON.parse(JSON.stringify(store[KEY]));
  assert.equal(root.schemaVersion, 1);
  assert.equal(Object.keys(root.partitions['a'.repeat(64)].entries).length, 1);
  const entry = root.partitions['a'.repeat(64)].entries['b'.repeat(32)];
  assert.equal(entry.bindings.length, 2, 'binding 去重');
  assert.equal(entry.origin, 'generated');
  // 三次写入中第二次完全幂等（不递增 revision），第一、三次各 +1
  assert.equal(root.revision, 2, '两次实际变更递增 revision，幂等写不递增');
  assert.equal(calls.set.length, 2, '幂等写不产生 set 调用');
});

test('索引：分区按 scopeKey 隔离；不同 scope 的条目互不可见', async () => {
  const { hana: storage, store } = makeStorage();
  const { locks } = makeLocks();
  const idx = createArtifactIndexStore({ hana: storage, locks, now: () => '2026-10-24T01:00:00.000Z' });
  await idx.upsert('a'.repeat(64), meta('b'.repeat(32)), binding);
  await idx.upsert('b'.repeat(64), meta('c'.repeat(32)), binding);
  const a = await idx.read('a'.repeat(64));
  const b = await idx.read('b'.repeat(64));
  assert.deepEqual(Object.keys(a.entries), ['b'.repeat(32)]);
  assert.deepEqual(Object.keys(b.entries), ['c'.repeat(32)]);
});

test('索引：损坏根文档报 ARTIFACT_INDEX_CORRUPT，保留原值，不自动清空回写', async () => {
  const { hana: storage, store } = makeStorage({ [KEY]: { schemaVersion: 99, garbage: true } });
  const { locks } = makeLocks();
  const idx = createArtifactIndexStore({ hana: storage, locks, now: () => '2026-10-24T01:00:00.000Z' });
  await assert.rejects(() => idx.read('a'.repeat(64)), err => err.code === 'ARTIFACT_INDEX_CORRUPT');
  await assert.rejects(() => idx.upsert('a'.repeat(64), meta('b'.repeat(32)), binding), err => err.code === 'ARTIFACT_INDEX_CORRUPT');
  assert.deepEqual(store[KEY], { schemaVersion: 99, garbage: true }, '原值保持不动');
});

test('索引：quota 失败可见，不删除已有索引，不影响已生成文件', async () => {
  const { hana: storage } = makeStorage({}, { failSet: true });
  const { locks } = makeLocks();
  const idx = createArtifactIndexStore({ hana: storage, locks, now: () => '2026-10-24T01:00:00.000Z' });
  await assert.rejects(() => idx.upsert('a'.repeat(64), meta('b'.repeat(32)), binding), /quota/);
  const after = await idx.read('a'.repeat(64));
  assert.deepEqual(after.entries, {});
});

test('索引：条目超限时明确失败，不悄悄覆盖其它分区或超载写入', async () => {
  const { hana: storage, store } = makeStorage();
  const { locks } = makeLocks();
  const idx = createArtifactIndexStore({ hana: storage, locks, now: () => '2026-10-24T01:00:00.000Z' });
  for (let i = 0; i < 500; i++) {
    await idx.upsert('a'.repeat(64), meta(String(i).padStart(32, '0')), { ...binding, cardId: `card-${i}` });
  }
  await assert.rejects(() => idx.upsert('a'.repeat(64), meta('f'.repeat(32)), binding), err => err.code === 'ARTIFACT_INDEX_LIMIT');
  // 总额是跨分区合计：达到上限后其它分区的新条目同样拒绝（设计 2.2：合计 500 条）
  await assert.rejects(() => idx.upsert('b'.repeat(64), meta('e'.repeat(32)), binding), err => err.code === 'ARTIFACT_INDEX_LIMIT');
});

test('索引：每条 binding 上限 10 个，超出去重后仍超则拒绝', async () => {
  const { hana: storage, store } = makeStorage();
  const { locks } = makeLocks();
  const idx = createArtifactIndexStore({ hana: storage, locks, now: () => '2026-10-24T01:00:00.000Z' });
  for (let i = 0; i < 10; i++) await idx.upsert('a'.repeat(64), meta('b'.repeat(32)), { ...binding, cardId: `c${i}` });
  await assert.rejects(() => idx.upsert('a'.repeat(64), meta('b'.repeat(32)), { ...binding, cardId: 'c-extra' }), err => err.code === 'ARTIFACT_INDEX_LIMIT');
});

test('索引：markSeen 只更新 lastSeenAt，不重写 bindings', async () => {
  const { hana: storage, store } = makeStorage();
  const { locks } = makeLocks();
  const idx = createArtifactIndexStore({ hana: storage, locks, now: () => '2026-10-24T02:00:00.000Z' });
  await idx.upsert('a'.repeat(64), meta('b'.repeat(32)), binding);
  await idx.markSeen('a'.repeat(64), 'b'.repeat(32));
  const root = store[KEY];
  assert.equal(root.partitions['a'.repeat(64)].entries['b'.repeat(32)].lastSeenAt, '2026-10-24T02:00:00.000Z');
  assert.equal(root.partitions['a'.repeat(64)].entries['b'.repeat(32)].bindings.length, 1);
});

test('索引：缺 Web Locks 或 storage 端口时工厂显式报缺，不以 no-op 掩盖', () => {
  const { hana: storage, store } = makeStorage();
  assert.throws(() => createArtifactIndexStore({ hana: storage, locks: null, now: () => 't' }), /Web Locks|locks/i);
  assert.throws(() => createArtifactIndexStore({ hana: null, locks: makeLocks().locks, now: () => 't' }), /storage/i);
});

test('索引：伪造 scopeKey 或 authorized 字段不产生任何后端能力（索引内容不含授权语义字段）', async () => {
  const { hana: storage, store } = makeStorage();
  const { locks } = makeLocks();
  const idx = createArtifactIndexStore({ hana: storage, locks, now: () => '2026-10-24T01:00:00.000Z' });
  await idx.upsert('a'.repeat(64), meta('b'.repeat(32)), binding);
  const raw = JSON.stringify(store[KEY]);
  assert.ok(!/authorized|grant|owner[^S]|credential/i.test(raw), '索引内容不得出现授权/身份语义字段');
});
