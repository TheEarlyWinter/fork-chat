import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHandoffContext } from '../ui/assets/fork-handoff-context.js';
import { normalizeForkSnapshot } from '../ui/assets/fork-snapshot.js';

// ---------------------------------------------------------------------------
// 夹具：规范快照形态，只放本用例需要的字段，不制造无关错误。
// messages 必填数组，contextRefs 省略（真实 normalizeSnapshot 里它是可选字段）。
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

function buildFromSnapshot(snap, target, extra = {}) {
  return buildHandoffContext({
    snapshot: snap,
    source: { canvasId: 'canvas-1', revision: 'rev-7', targetCardId: target },
    targetCardId: target,
    agentId: 'agent-a',
    ...extra,
  });
}

function build(cards, target, extra = {}) {
  return buildFromSnapshot(snapshot(cards), target, extra);
}

function fails(fn, code) {
  assert.throws(fn, error => {
    assert.equal(error.code, code, `期望 ${code}，实际 ${error.code}：${error.message}`);
    return true;
  });
}

// ---------------------------------------------------------------------------
// 探针 1：已发送附件缺正文 / 空白正文不得被当成完整
// ---------------------------------------------------------------------------

test('sent attachment without content is rejected instead of saved as empty', () => {
  fails(() => build([
    card('T', {
      messages: [msg('user', 'Q', {
        attachments: [{ name: 'paper.pdf', size: 100, charCount: 0 }],
      })],
    }),
  ], 'T'), 'HANDOFF_ATTACHMENT_MISSING_CONTENT');
});

test('sent attachment with whitespace-only content is rejected', () => {
  fails(() => build([
    card('T', {
      messages: [msg('user', 'Q', {
        attachments: [{ name: 'paper.pdf', size: 100, charCount: 0, content: '   \n\t ' }],
      })],
    }),
  ], 'T'), 'HANDOFF_ATTACHMENT_MISSING_CONTENT');
});

// ---------------------------------------------------------------------------
// 探针 2：资料卡依赖缺正文 / 空正文必须报错，不能静默变成 doc:null
// ---------------------------------------------------------------------------

test('isDoc parent without docContent fails instead of silently dropping the document', () => {
  fails(() => build([
    card('doc', {
      isDoc: true,
      docMeta: { name: 'paper.pdf', charCount: 100, lineCount: 3 },
    }),
    card('T', { parents: ['doc'], messages: [msg('user', 'Q')] }),
  ], 'T'), 'HANDOFF_DOC_MISSING_CONTENT');
});

test('isDoc parent with empty docContent fails instead of silently dropping the document', () => {
  fails(() => build([
    card('doc', {
      isDoc: true,
      docMeta: { name: 'paper.pdf', charCount: 100, lineCount: 3 },
      docContent: '',
    }),
    card('T', { parents: ['doc'], messages: [msg('user', 'Q')] }),
  ], 'T'), 'HANDOFF_DOC_MISSING_CONTENT');
});

test('plain chat card without docContent stays legal', () => {
  const context = build([
    card('T', { messages: [msg('user', 'Q')] }),
  ], 'T');
  assert.equal(context.nodes.length, 1);
  assert.equal(context.nodes[0].doc, null);
});

test('malformed saved shapes are rejected instead of coerced to empty', () => {
  fails(() => build([
    card('doc', { isDoc: true, docMeta: { name: 'paper.pdf', charCount: 10 }, docContent: 42 }),
    card('T', { parents: ['doc'], messages: [msg('user', 'Q')] }),
  ], 'T'), 'HANDOFF_INVALID_SNAPSHOT');

  fails(() => build([
    { id: 'T', x: 0, y: 0, width: 320, draft: '' },
  ], 'T'), 'HANDOFF_INVALID_SNAPSHOT');

  fails(() => build([
    card('T', { messages: [msg('user', 'Q')], contextRefs: {} }),
  ], 'T'), 'HANDOFF_INVALID_SNAPSHOT');

  fails(() => build([
    card('T', {
      messages: [msg('user', 'Q', {
        attachments: [{ name: 'paper.pdf', charCount: 0, content: 42 }],
      })],
    }),
  ], 'T'), 'HANDOFF_ATTACHMENT_MISSING_CONTENT');
});

// ---------------------------------------------------------------------------
// 探针 3：明确的失败/部分状态不能变成 ok
// ---------------------------------------------------------------------------

test('explicit failed and partial statuses stay unfinished even without booleans', () => {
  const context = build([
    card('T', {
      messages: [
        msg('assistant', 'FAILED-BODY', { status: 'failed', failed: false }),
        msg('assistant', 'PARTIAL-BODY', { status: 'partial' }),
        msg('assistant', 'CANCELLED-BODY', { status: 'cancelled' }),
        msg('assistant', 'OK-BODY', { status: 'completed' }),
        msg('assistant', 'LEGACY-BODY'),
      ],
    }),
  ], 'T');
  assert.deepEqual(
    context.nodes[0].messages.map(message => message.status),
    ['failed', 'partial', 'cancelled', 'ok', 'ok'],
  );
});

// ---------------------------------------------------------------------------
// 探针 4：未知非空终态拒绝，不默认 ok
// ---------------------------------------------------------------------------

test('unknown non-empty message status is rejected', () => {
  fails(() => build([
    card('T', { messages: [msg('assistant', 'mystery', { status: 'half-done' })] }),
  ], 'T'), 'HANDOFF_UNKNOWN_MESSAGE_STATUS');
});

// ---------------------------------------------------------------------------
// 探针 5：历史 30 万裁切阈值——保存重开与直接编译都不得称完整
// ---------------------------------------------------------------------------

const LEGACY_ATTACHMENT_LIMIT = 300000;

test('legacy 300000-char attachment is marked unknown/truncated on save and reopen', () => {
  const legacy = 'a'.repeat(LEGACY_ATTACHMENT_LIMIT);
  const raw = snapshot([
    card('T', {
      messages: [msg('user', 'Q', {
        attachments: [{
          name: 'old.md', extension: 'md', charCount: LEGACY_ATTACHMENT_LIMIT, lineCount: 1, content: legacy,
        }],
      })],
    }),
  ]);

  // 直接编译：没有可靠原始长度，恰好阈值不能称完整
  fails(() => buildFromSnapshot(raw, 'T'), 'HANDOFF_ATTACHMENT_INTEGRITY_UNKNOWN');

  // 保存：必须留下可恢复的裁切/未知标记
  const normalized = normalizeForkSnapshot(raw);
  const saved = normalized.cards[0].messages[0];
  assert.deepEqual(saved.attachmentsTruncated, [0]);

  // 重开：标记仍在
  const reopened = normalizeForkSnapshot(normalized);
  assert.deepEqual(reopened.cards[0].messages[0].attachmentsTruncated, [0]);

  // 用重开后的快照编译也不得称完整
  fails(() => buildFromSnapshot(reopened, 'T'), 'HANDOFF_ATTACHMENT_TRUNCATED');
});
