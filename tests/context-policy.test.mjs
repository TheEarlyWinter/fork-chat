import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_REFS_PER_CARD,
  MAX_REF_TEXT_BYTES,
  MAX_REF_SOURCE_TITLE,
  MAX_REFERENCE_PREFIX_BYTES,
  getContextMode,
  normalizeContextMode,
  normalizeContextRefs,
  estimateReferenceBytes,
  findDeletionReferenceConflicts,
  contextByteLength,
} from '../ui/assets/fork-context-policy.js';

// 上下文策略的底线：默认行为不变，越限就明确拒绝，
// 绝不静默截断或把写错的策略当成 include 放过去。

const makeRef = (id, overrides = {}) => ({
  id,
  sourceCardId: 'src-1',
  sourceTitle: '来源卡',
  text: '原文片段',
  ...overrides,
});

test('getContextMode: 缺字段等于 include，只有显式 exclude 才算排除', () => {
  assert.equal(getContextMode({}), 'include');
  assert.equal(getContextMode({ contextMode: 'include' }), 'include');
  assert.equal(getContextMode({ contextMode: 'exclude' }), 'exclude');
  assert.equal(getContextMode(null), 'include');
});

test('normalizeContextMode: include 可省略，未知值拒绝而不是放行', () => {
  assert.equal(normalizeContextMode(undefined), undefined);
  assert.equal(normalizeContextMode('include'), undefined);
  assert.equal(normalizeContextMode('exclude'), 'exclude');
  assert.throws(() => normalizeContextMode('hidden'), /只能是 include 或 exclude/);
  assert.throws(() => normalizeContextMode(null), RangeError);
});

test('normalizeContextRefs: 合法引用被冻结并保留原文', () => {
  const refs = normalizeContextRefs([makeRef('r1'), makeRef('r2', { text: '另一段' })]);
  assert.equal(refs.length, 2);
  assert.ok(Object.isFrozen(refs));
  assert.ok(Object.isFrozen(refs[0]));
  assert.equal(refs[0].text, '原文片段');
  assert.equal(refs[1].text, '另一段');
});

test('normalizeContextRefs: 空数组与未定义都归一成「没有引用」', () => {
  assert.equal(normalizeContextRefs([]), undefined);
  assert.equal(normalizeContextRefs(undefined), undefined);
  assert.equal(normalizeContextRefs(null), undefined);
});

test('normalizeContextRefs: 超过每卡上限直接拒绝，不截断', () => {
  const many = Array.from({ length: MAX_REFS_PER_CARD + 1 }, (_, i) => makeRef(`r${i}`));
  assert.throws(() => normalizeContextRefs(many), /最多 16 条/);
});

test('normalizeContextRefs: 单条正文按 UTF-8 字节算，超限拒绝', () => {
  const justAtLimit = '中'.repeat(Math.floor(MAX_REF_TEXT_BYTES / 3));
  assert.doesNotThrow(() => normalizeContextRefs([makeRef('ok', { text: justAtLimit })]));
  const tooLong = `${justAtLimit}中`;
  assert.throws(() => normalizeContextRefs([makeRef('bad', { text: tooLong })]), /超过 8192 字节/);
});

test('normalizeContextRefs: 来源标题超过上限拒绝，控制字符被清掉', () => {
  const longTitle = '标'.repeat(MAX_REF_SOURCE_TITLE + 1);
  assert.throws(() => normalizeContextRefs([makeRef('r1', { sourceTitle: longTitle })]), /来源标题超过/);
  const dirty = normalizeContextRefs([makeRef('r2', { sourceTitle: '来源\u0000卡\n' })]);
  assert.equal(dirty[0].sourceTitle, '来源 卡');
});

test('normalizeContextRefs: 自引用、非法 ID、空正文都拒绝', () => {
  assert.throws(
    () => normalizeContextRefs([makeRef('r1', { sourceCardId: 'owner-1' })], { ownerCardId: 'owner-1' }),
    /自引用/,
  );
  assert.throws(() => normalizeContextRefs([makeRef('r 1')]), /id 不合法/);
  assert.throws(() => normalizeContextRefs([makeRef('r1', { text: '   ' })]), /正文为空/);
});

test('normalizeContextRefs: 重复 id 拒绝，同 id 不同内容也不许静默择一', () => {
  assert.throws(() => normalizeContextRefs([makeRef('dup'), makeRef('dup')]), /重复/);
  assert.throws(
    () => normalizeContextRefs([makeRef('dup', { text: '甲' }), makeRef('dup', { text: '乙' })]),
    /重复且内容不同/,
  );
});

test('estimateReferenceBytes: 正文越长估计越大，空引用为零', () => {
  assert.equal(estimateReferenceBytes(null), 0);
  const small = estimateReferenceBytes(makeRef('a', { text: '短' }));
  const big = estimateReferenceBytes(makeRef('b', { text: '长'.repeat(100) }));
  assert.ok(big > small);
  assert.equal(contextByteLength('中'), 3);
});

test('findDeletionReferenceConflicts: 删掉被排除的来源、还有外部 owner 引用它 → 冲突', () => {
  const source = { id: 'src-1', contextMode: 'exclude' };
  const owner = { id: 'owner-1', contextRefs: [makeRef('r1', { sourceCardId: 'src-1' })] };
  const conflicts = findDeletionReferenceConflicts({ cards: [source, owner], deletingIds: ['src-1'] });
  assert.deepEqual(conflicts, [{ sourceCardId: 'src-1', ownerCardId: 'owner-1', refId: 'r1' }]);
});

test('findDeletionReferenceConflicts: include 来源被删不算冲突', () => {
  const source = { id: 'src-1' };
  const owner = { id: 'owner-1', contextRefs: [makeRef('r1', { sourceCardId: 'src-1' })] };
  assert.deepEqual(findDeletionReferenceConflicts({ cards: [source, owner], deletingIds: ['src-1'] }), []);
});

test('findDeletionReferenceConflicts: owner 一起删就不构成冲突', () => {
  const source = { id: 'src-1', contextMode: 'exclude' };
  const owner = { id: 'owner-1', contextRefs: [makeRef('r1', { sourceCardId: 'src-1' })] };
  assert.deepEqual(
    findDeletionReferenceConflicts({ cards: [source, owner], deletingIds: ['src-1', 'owner-1'] }),
    [],
  );
});

test('findDeletionReferenceConflicts: 没有引用时毫无冲突', () => {
  assert.deepEqual(findDeletionReferenceConflicts({ cards: [{ id: 'a' }], deletingIds: ['a'] }), []);
  assert.deepEqual(findDeletionReferenceConflicts({}), []);
});

test('限额常量只有一份，且前缀上限大于单条上限', () => {
  assert.equal(MAX_REFS_PER_CARD, 16);
  assert.equal(MAX_REF_TEXT_BYTES, 8 * 1024);
  assert.ok(MAX_REFERENCE_PREFIX_BYTES > MAX_REF_TEXT_BYTES);
});
