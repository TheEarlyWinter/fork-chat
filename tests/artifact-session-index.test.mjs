import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSessionArtifacts } from '../ui/assets/artifact-session-index.js';
import { normalizeArtifactList } from '../ui/assets/artifact-contract.js';

/*
 * 会话级文档面板·数据层（2.2 专项②）：
 * 从画布消息聚合版本组；refs 只算引用不计版本；倒序；非法项过滤。
 */

const meta = (id, name, extra = {}) => ({
  artifactId: id, status: 'ready', name, mime: 'text/markdown', format: 'md',
  bytes: 100, sha256: 'a'.repeat(64), createdAt: '2026-10-24T0' + (extra.hour ?? 0) + ':00:00.000Z', ...extra,
});

test('多卡多版本聚合成版本组，最新版为 current', () => {
  const v1 = meta('a'.repeat(32), '文档.md', { hour: 1 });
  const v2 = meta('c'.repeat(32), '文档-v2.md', { hour: 2, version: 2, revisedFrom: 'a'.repeat(32), revisionRootId: 'a'.repeat(32) });
  const v3 = meta('e'.repeat(32), '文档-v3.md', { hour: 3, version: 3, revisedFrom: 'c'.repeat(32), revisionRootId: 'a'.repeat(32) });
  // v3 挂在另一张卡的消息上（跨节点归并后的真实形态）
  const cards = [
    { id: 'c1', title: '父卡', messages: [{ role: 'assistant', requestId: 'r1', artifacts: [v1, v2] }] },
    { id: 'c2', title: '子卡', messages: [{ role: 'assistant', requestId: 'r2', artifacts: [v3] }] },
  ];
  const entries = collectSessionArtifacts({ cards });
  assert.equal(entries.length, 1, '同一 root 归一组');
  assert.equal(entries[0].current.artifactId, v3.artifactId, '最新版是 current');
  assert.equal(entries[0].versions.length, 3);
  assert.equal(entries[0].sourceCardId, 'c1');
});

test('refs 不参与版本聚合，但计入 referencedBy', () => {
  const v1 = meta('a'.repeat(32), '文档.md', { hour: 1 });
  const v2 = meta('c'.repeat(32), '文档-v2.md', { hour: 2, version: 2, revisedFrom: 'a'.repeat(32), revisionRootId: 'a'.repeat(32) });
  const cards = [
    { id: 'c1', title: '父', messages: [{ role: 'assistant', requestId: 'r1', artifacts: [v1] }] },
    { id: 'c2', title: '子', messages: [{ role: 'assistant', requestId: 'r2', artifacts: [v2] }] },
    { id: 'c3', title: '孙', messages: [{ role: 'assistant', requestId: 'r3', artifactRefs: [v2] }] },
  ];
  const entries = collectSessionArtifacts({ cards });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].versions.length, 2, 'refs 不复制成版本');
  assert.deepEqual(entries[0].referencedBy, [{ cardId: 'c3', cardTitle: '孙' }]);
});

test('独立文档（无修订）各自成组，按最新版时间倒序', () => {
  const old = meta('a'.repeat(32), '旧.md', { hour: 1 });
  const fresh = meta('b'.repeat(32), '新.md', { hour: 5 });
  const entries = collectSessionArtifacts({ cards: [{ id: 'c1', title: 't', messages: [
    { role: 'assistant', requestId: 'r1', artifacts: [old] },
    { role: 'assistant', requestId: 'r2', artifacts: [fresh] },
  ] }] });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].current.artifactId, fresh.artifactId, '新的在前');
});

test('非法元数据经 normalize 哨兵过滤，不进面板数据', () => {
  const dirty = [meta('bad', 'x.md'), { garbage: true }, null];
  const valid = meta('a'.repeat(32), 'ok.md');
  const entries = collectSessionArtifacts({ cards: [{ id: 'c1', title: 't', messages: [
    { role: 'assistant', requestId: 'r1', artifacts: [...dirty, valid] }] }] });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].versions.length, 1);
  assert.equal(entries[0].current.name, 'ok.md');
});

test('空画布与无文档消息返回空数组', () => {
  assert.deepEqual(collectSessionArtifacts({ cards: [] }), []);
  assert.deepEqual(collectSessionArtifacts({ cards: [{ id: 'c1', title: 't', messages: [{ role: 'user', text: 'hi' }] }] }), []);
  assert.deepEqual(collectSessionArtifacts(), []);
});

test('normalize 后的 refs 列表同样可用于引用聚合（形状兼容）', () => {
  const v2 = meta('c'.repeat(32), '文档-v2.md', { version: 2, revisedFrom: 'a'.repeat(32), revisionRootId: 'a'.repeat(32) });
  const refs = normalizeArtifactList([v2]);
  const v1 = meta('a'.repeat(32), '文档.md');
  const entries = collectSessionArtifacts({ cards: [
    { id: 'c1', title: '父', messages: [{ role: 'assistant', requestId: 'r1', artifacts: [v1] }] },
    { id: 'c2', title: '子', messages: [{ role: 'assistant', requestId: 'r2', artifactRefs: refs }] },
  ] });
  assert.equal(entries[0].referencedBy.length, 1);
});
