import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHandoffContext } from '../ui/assets/fork-handoff-context.js';
import { HANDOFF_LIMITS } from '../ui/assets/fork-handoff-contract.js';

// ---------------------------------------------------------------------------
// 夹具：真实完整的 public artifact receipt，不复用极简伪字段。
// ---------------------------------------------------------------------------

function msg(role, text, extra = {}) {
  return { role, text, ...extra };
}

function card(id, { parents = [], messages = [], ...extra } = {}) {
  const built = { id, x: 0, y: 0, width: 320, draft: '', messages, ...extra };
  if (parents.length === 1) built.parentId = parents[0];
  else if (parents.length > 1) built.parentIds = [...parents];
  return built;
}

function snapshot(cards) {
  return { cards, view: { x: 0, y: 0, scale: 1 }, agent: { id: 'agent-a', name: '助手' } };
}

function build(cards, target) {
  return buildHandoffContext({
    snapshot: snapshot(cards),
    source: { canvasId: 'canvas-1', revision: 'rev-7', targetCardId: target },
    targetCardId: target,
    agentId: 'agent-a',
  });
}

function fails(fn, code) {
  assert.throws(fn, error => {
    assert.equal(error.code, code, `期望 ${code}，实际 ${error.code}：${error.message}`);
    return true;
  });
}

const aid = (seed) => String(seed).padStart(2, '0').repeat(16);

function receipt(id, overrides = {}) {
  return {
    artifactId: id,
    status: 'ready',
    name: '报告.md',
    mime: 'text/markdown',
    format: 'md',
    bytes: 1024,
    sha256: 'a'.repeat(64),
    createdAt: '2026-10-25T00:00:00.000Z',
    cardId: 'c1',
    origin: 'generated',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// I1 剩余：有值但不是数组的集合字段必须拒绝，undefined 合法
// ---------------------------------------------------------------------------

test('non-array attachments / artifacts / artifactRefs are rejected instead of coerced', () => {
  fails(() => build([
    card('T', { messages: [msg('user', 'Q', { attachments: 'bad' })] }),
  ], 'T'), 'HANDOFF_INVALID_SNAPSHOT');

  fails(() => build([
    card('T', { messages: [msg('user', 'Q', { artifacts: 'bad' })] }),
  ], 'T'), 'HANDOFF_INVALID_SNAPSHOT');

  fails(() => build([
    card('T', { messages: [msg('user', 'Q', { artifactRefs: { artifactId: aid(1) } })] }),
  ], 'T'), 'HANDOFF_INVALID_SNAPSHOT');

  // 字段 undefined 表示没有附件/产物，仍然合法
  const context = build([
    card('T', { messages: [msg('user', 'Q')] }),
  ], 'T');
  assert.deepEqual(context.artifactIds, []);
  assert.deepEqual(context.nodes[0].messages[0].attachments, []);
  assert.deepEqual(context.nodes[0].messages[0].artifactIds, []);
});

// ---------------------------------------------------------------------------
// I4：产物必须通过 artifact-contract 的公共 receipt 规则
// ---------------------------------------------------------------------------

test('non-ready or malformed artifact receipts are rejected, never filtered away', () => {
  fails(() => build([
    card('T', { messages: [msg('user', 'Q', { artifacts: [receipt(aid(1), { status: 'pending' })] })] }),
  ], 'T'), 'HANDOFF_INVALID_ARTIFACT');

  fails(() => build([
    card('T', { messages: [msg('user', 'Q', { artifacts: [receipt(aid(1), { sha256: 'not-a-digest' })] })] }),
  ], 'T'), 'HANDOFF_INVALID_ARTIFACT');

  fails(() => build([
    card('T', { messages: [msg('user', 'Q', { artifacts: [receipt(aid(1), { mime: 'text/plain' })] })] }),
  ], 'T'), 'HANDOFF_INVALID_ARTIFACT');

  fails(() => build([
    card('T', { messages: [msg('user', 'Q', { artifacts: [receipt(aid(1), { format: 'exe' })] })] }),
  ], 'T'), 'HANDOFF_INVALID_ARTIFACT');

  fails(() => build([
    card('T', { messages: [msg('user', 'Q', { artifacts: [receipt(aid(1), { name: '' })] })] }),
  ], 'T'), 'HANDOFF_INVALID_ARTIFACT');

  fails(() => build([
    card('T', { messages: [msg('user', 'Q', { artifacts: [receipt(aid(1), { bytes: 0 })] })] }),
  ], 'T'), 'HANDOFF_INVALID_ARTIFACT');
});

test('same artifact id with conflicting immutable fields is a stable error', () => {
  fails(() => build([
    card('T', {
      messages: [
        msg('user', 'Q1', { artifacts: [receipt(aid(1), { bytes: 2048 })] }),
        msg('assistant', 'A1', { artifactRefs: [receipt(aid(1), { bytes: 4096 })] }),
      ],
    }),
  ], 'T'), 'HANDOFF_ARTIFACT_CONFLICT');

  fails(() => build([
    card('T', {
      messages: [
        msg('user', 'Q1', { artifacts: [receipt(aid(1))] }),
        msg('assistant', 'A1', { artifactRefs: [receipt(aid(1), { sha256: 'b'.repeat(64) })] }),
      ],
    }),
  ], 'T'), 'HANDOFF_ARTIFACT_CONFLICT');

  fails(() => build([
    card('T', {
      messages: [
        msg('user', 'Q1', { artifacts: [receipt(aid(1))] }),
        msg('assistant', 'A1', { artifactRefs: [receipt(aid(1), { name: '另一份.md' })] }),
      ],
    }),
  ], 'T'), 'HANDOFF_ARTIFACT_CONFLICT');
});

test('identical complete receipts dedupe and limits count unique artifacts', () => {
  const context = build([
    card('T', {
      messages: [
        msg('user', 'Q1', { artifacts: [receipt(aid(1)), receipt(aid(2), { bytes: 2048 })] }),
        msg('assistant', 'A1', { artifactRefs: [receipt(aid(1)), receipt(aid(2), { bytes: 2048 })] }),
      ],
    }),
  ], 'T');
  assert.deepEqual(context.artifactIds, [aid(1), aid(2)]);
  assert.equal(context.stats.artifactCount, 2);
  assert.ok(context.notices.some(notice => notice.code === 'DUPLICATE_ARTIFACTS_DEDUPED'));
});

test('artifact size limits still use the validated metadata', () => {
  fails(() => build([
    card('T', {
      messages: [msg('user', 'Q', { artifacts: [receipt(aid(1), { bytes: HANDOFF_LIMITS.maxArtifactBytes + 1 })] })],
    }),
  ], 'T'), 'HANDOFF_ARTIFACT_TOO_LARGE');

  const heavy = Array.from({ length: 5 }, (_, index) => receipt(aid(index), { bytes: 14 * 1024 * 1024 }));
  fails(() => build([
    card('T', { messages: [msg('user', 'Q', { artifacts: heavy })] }),
  ], 'T'), 'HANDOFF_ARTIFACTS_TOTAL_TOO_LARGE');

  const many = Array.from({ length: HANDOFF_LIMITS.maxArtifacts + 1 }, (_, index) => receipt(aid(index), { bytes: 10 }));
  fails(() => build([
    card('T', { messages: [msg('user', 'Q', { artifacts: many })] }),
  ], 'T'), 'HANDOFF_TOO_MANY_ARTIFACTS');
});
