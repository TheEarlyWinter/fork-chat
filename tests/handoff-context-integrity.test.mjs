// 保护交接上下文的内容完整性：DTO 字段不许缺省或自引用、附件与产物
// receipt 必须走公共契约、快照保存重开不得丢标记、消息状态不许猜。
// 这些约束都落在同一批 build/validate 与 normalizeForkSnapshot 的输入上，
// 漏掉任何一条都会让不完整的数据被当成完整内容交接出去。
// 用例来自 handoff-artifact-fixes、handoff-integrity-fixes 和
// handoff-round2-fixes 中与完整性相关的部分。

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHandoffContext } from '../ui/assets/fork-handoff-context.js';
import { HANDOFF_LIMITS, validateHandoffContext } from '../ui/assets/fork-handoff-contract.js';
import { normalizeForkSnapshot } from '../ui/assets/fork-snapshot.js';

// ---------------------------------------------------------------------------
// 夹具：规范快照形态，只放本用例需要的字段，不制造无关错误。
// messages 必填数组，contextRefs 省略（真实 normalizeSnapshot 里它是可选字段）。
// 另：真实完整的 public artifact receipt，不复用极简伪字段。
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function ref(id, sourceCardId, text = 'REF-TEXT') {
  return { id, sourceCardId, sourceTitle: '来源', text };
}

// ---------------------------------------------------------------------------
// 1) 服务端拒绝 DTO 自引用
// ---------------------------------------------------------------------------

test('DTO rejects a reference whose source is one of its own positions', () => {
  const context = build([
    card('A', { messages: [msg('user', 'A-BODY')] }),
    card('T', {
      parents: ['A'],
      messages: [msg('user', 'T-BODY')],
      contextRefs: [ref('ref-1', 'A', 'ANCESTOR-TEXT')],
    }),
  ], 'T');
  assert.deepEqual(context.references[0].positions, ['T']);

  const selfRef = clone(context);
  selfRef.references[0].positions = ['T', 'A'];
  fails(() => validateHandoffContext(selfRef), 'HANDOFF_INVALID_CONTEXT');
});

// ---------------------------------------------------------------------------
// 2) null 不能被当成“缺省”
// ---------------------------------------------------------------------------

test('null collection fields are rejected instead of treated as absent', () => {
  const base = () => [card('T', { messages: [msg('user', 'Q')] })];
  fails(() => build([
    card('T', { messages: [msg('user', 'Q')], contextRefs: null }),
  ], 'T'), 'HANDOFF_INVALID_SNAPSHOT');
  fails(() => build([
    card('T', { messages: [msg('user', 'Q', { attachments: null })] }),
  ], 'T'), 'HANDOFF_INVALID_SNAPSHOT');
  fails(() => build([
    card('T', { messages: [msg('user', 'Q', { artifacts: null })] }),
  ], 'T'), 'HANDOFF_INVALID_SNAPSHOT');
  fails(() => build([
    card('T', { messages: [msg('user', 'Q', { artifactRefs: null })] }),
  ], 'T'), 'HANDOFF_INVALID_SNAPSHOT');
  fails(() => build([
    card('T', { messages: [msg('user', 'Q')], stagedAttachments: null }),
  ], 'T'), 'HANDOFF_INVALID_SNAPSHOT');

  // undefined 仍然表示没有这个集合
  const context = build(base(), 'T');
  assert.deepEqual(context.references, []);
  assert.deepEqual(context.unsent, []);

  // DTO 侧同样不接受 null
  const nullUnsent = clone(context);
  nullUnsent.unsent = null;
  fails(() => validateHandoffContext(nullUnsent), 'HANDOFF_INVALID_CONTEXT');
  const nullOmissions = clone(context);
  nullOmissions.omissions = null;
  fails(() => validateHandoffContext(nullOmissions), 'HANDOFF_INVALID_CONTEXT');
});

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

// ---------------------------------------------------------------------------
// 4) 产物重复 notice 只按原始位置统计
// ---------------------------------------------------------------------------

test('node artifactIds no longer duplicate message artifact positions', () => {
  const single = build([
    card('T', {
      messages: [msg('user', 'Q', { artifacts: [receipt(aid(1))] })],
    }),
  ], 'T');
  assert.deepEqual(single.nodes[0].artifactIds, [], '节点字段只表示节点自身位置');
  assert.deepEqual(single.artifactIds, [aid(1)]);
  assert.equal(single.notices.some(notice => notice.code === 'DUPLICATE_ARTIFACTS_DEDUPED'), false);

  const twice = build([
    card('T', {
      messages: [
        msg('user', 'Q1', { artifacts: [receipt(aid(1))] }),
        msg('assistant', 'A1', { artifactRefs: [receipt(aid(1))] }),
      ],
    }),
  ], 'T');
  assert.deepEqual(twice.nodes[0].artifactIds, []);
  assert.deepEqual(twice.artifactIds, [aid(1)]);
  assert.ok(twice.notices.some(notice => notice.code === 'DUPLICATE_ARTIFACTS_DEDUPED'), '两个真实位置应报重复');
});

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
