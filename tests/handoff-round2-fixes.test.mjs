import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateHandoffContext,
} from '../ui/assets/fork-handoff-contract.js';
import { buildHandoffContext } from '../ui/assets/fork-handoff-context.js';

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

function build(cards, target, extra = {}) {
  return buildHandoffContext({
    snapshot: snapshot(cards),
    source: { canvasId: 'canvas-1', revision: 'rev-7', targetCardId: target },
    targetCardId: target,
    agentId: 'agent-a',
    ...extra,
  });
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

function receipt(id) {
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
// 3) 业务内容按实际正文判断
// ---------------------------------------------------------------------------

test('blank messages without attachments are not business content', () => {
  fails(() => build([
    card('T', { messages: [msg('user', '   ')] }),
  ], 'T'), 'HANDOFF_NO_CONTENT');

  const context = build([
    card('T', { messages: [msg('user', 'Q')] }),
  ], 'T');
  const blanked = clone(context);
  blanked.nodes[0].messages[0].text = '   ';
  fails(() => validateHandoffContext(blanked), 'HANDOFF_NO_CONTENT');
});

test('only excluded references are not business content', () => {
  const context = build([
    card('A', { messages: [msg('user', 'ROOT-BODY')] }),
    card('S', { parents: ['A'], contextMode: 'exclude', messages: [msg('assistant', 'EXCLUDED-BODY')] }),
    card('T', {
      parents: ['A'],
      messages: [msg('user', '')],
      contextRefs: [ref('ref-1', 'S', 'SAVED-REF-TEXT')],
    }),
  ], 'T');
  // 引用正文因来源被排除而不导入，目标消息又为空 → 没有业务内容
  assert.equal(context.references[0].included, false);
  assert.equal(context.references[0].text, '');
  const stripped = clone(context);
  stripped.nodes = stripped.nodes.filter(node => node.cardId === 'T');
  stripped.nodes[0].parentIds = [];
  stripped.exclusions = [];
  stripped.referenceSources = [{ cardId: 'S', exists: true, contextMode: 'exclude' }];
  fails(() => validateHandoffContext(stripped), 'HANDOFF_NO_CONTENT');
});

test('artifact-only contexts count as business content', () => {
  const context = build([
    card('T', { messages: [msg('user', 'Q')] }),
  ], 'T');
  const artifactOnly = clone(context);
  artifactOnly.nodes[0].messages = [];
  artifactOnly.nodes[0].artifactIds = [aid(7)];
  artifactOnly.artifactIds = [aid(7)];
  artifactOnly.references = [];
  artifactOnly.referenceSources = [];
  const validated = validateHandoffContext(artifactOnly);
  assert.deepEqual(validated.artifactIds, [aid(7)]);
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
