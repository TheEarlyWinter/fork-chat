// 保护交接上下文的组装与呈现：节点排序、业务内容判定、notice 文案、
// 格式化器输入校验。这三块共享同一份 build + validate + format 链路，
// 任何一处改动都会影响另外两处，因此合在一个文件里一起回归。
// 用例来自 handoff-meta-fixes 与 handoff-round2-fixes 中与组装相关的部分。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateHandoffContext,
  formatHandoffTranscript,
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

function ref(id, sourceCardId, text = 'REF-TEXT') {
  return { id, sourceCardId, sourceTitle: '来源', text };
}

// ---------------------------------------------------------------------------
// C1 补漏：经 exclude 连接的包含祖先也必须排在前面
// ---------------------------------------------------------------------------

test('included ancestors reached through an excluded node must precede their descendants', () => {
  const context = build([
    card('A', { messages: [msg('user', 'ROOT-BODY')] }),
    card('E', { parents: ['A'], contextMode: 'exclude', messages: [msg('assistant', 'EXCLUDED-BODY')] }),
    card('T', { parents: ['E'], messages: [msg('user', 'TARGET-BODY')] }),
  ], 'T');
  assert.deepEqual(context.nodes.map(node => node.cardId), ['A', 'T']);

  const reversed = clone(context);
  reversed.nodes.reverse();
  fails(() => validateHandoffContext(reversed), 'HANDOFF_ORDER');
});

test('order between independent sibling ancestors stays free', () => {
  const context = build([
    card('R', { messages: [msg('user', 'ROOT-BODY')] }),
    card('A1', { parents: ['R'], messages: [msg('user', 'A1-BODY')] }),
    card('A2', { parents: ['R'], messages: [msg('user', 'A2-BODY')] }),
    card('B', { parents: ['A1'], messages: [msg('user', 'B-BODY')] }),
    card('C', { parents: ['A2'], messages: [msg('user', 'C-BODY')] }),
    card('T', { parents: ['B', 'C'], messages: [msg('user', 'T-BODY')] }),
  ], 'T');

  const reordered = clone(context);
  const byId = new Map(reordered.nodes.map(node => [node.cardId, node]));
  reordered.nodes = ['R', 'A2', 'C', 'A1', 'B', 'T'].map(id => byId.get(id));
  const validated = validateHandoffContext(reordered);
  assert.deepEqual(validated.nodes.map(node => node.cardId), ['R', 'A2', 'C', 'A1', 'B', 'T']);
});

// ---------------------------------------------------------------------------
// I5：业务内容与 notices 由服务端重算
// ---------------------------------------------------------------------------

test('empty shell contexts have no business content', () => {
  const context = build([
    card('A', { messages: [msg('user', 'ROOT-BODY')] }),
    card('T', { parents: ['A'], messages: [msg('user', 'TARGET-BODY')] }),
  ], 'T');

  const empty = clone(context);
  for (const node of empty.nodes) {
    node.doc = null;
    node.messages = [];
    node.artifactIds = [];
  }
  empty.references = [];
  empty.referenceSources = [];
  empty.artifactIds = [];
  empty.nextStep = '';
  fails(() => validateHandoffContext(empty), 'HANDOFF_NO_CONTENT');
});

test('notices are rebuilt from verified structure instead of client text', () => {
  const context = build([
    card('A', { messages: [msg('user', 'ROOT-BODY')] }),
    card('E', { parents: ['A'], contextMode: 'exclude', messages: [msg('assistant', 'EXCLUDED-BODY')] }),
    card('T', { parents: ['E'], messages: [msg('user', 'TARGET-BODY')] }),
  ], 'T');

  const forged = clone(context);
  forged.notices = [{ code: 'SNAPSHOT_ONLY', message: '伪造的完整性说明，不含任何真实告知' }];
  const validated = validateHandoffContext(forged);
  assert.equal(validated.notices.some(notice => notice.message === '伪造的完整性说明，不含任何真实告知'), false);
  assert.equal(validated.notices.some(notice => notice.code === 'EXCLUDED_ANCESTORS'), true, '删改 notice 不能抹掉告知');
  const transcript = formatHandoffTranscript(forged);
  assert.equal(transcript.includes('伪造的完整性说明'), false);
  assert.ok(transcript.includes('排除'));

  // 未知 code 直接拒绝
  const unknown = clone(context);
  unknown.notices.push({ code: 'INJECTED_CODE', message: 'x' });
  fails(() => validateHandoffContext(unknown), 'HANDOFF_INVALID_CONTEXT');

  // 空 notices 仍然得到必须的告知
  const stripped = clone(context);
  stripped.notices = [];
  assert.equal(validateHandoffContext(stripped).notices.some(notice => notice.code === 'EXCLUDED_ANCESTORS'), true);
});

test('local notices are expressed as bounded omission metadata with fixed wording', () => {
  const context = build([
    card('T', {
      messages: [
        msg('user', 'Q'),
        msg('assistant', '本地提示', { localOnly: true }),
        msg('assistant', '本地提示二', { localOnly: true }),
      ],
    }),
  ], 'T');
  assert.deepEqual(context.omissions, { localNoticeCount: 2 });
  const notice = context.notices.find(item => item.code === 'LOCAL_NOTICES_OMITTED');
  assert.ok(notice);
  assert.match(notice.message, /2/);
  const transcript = formatHandoffTranscript(context);
  assert.equal(transcript.includes('本地提示二'), false, 'localOnly 正文不进入历史');
  assert.ok(transcript.includes('条本地提示'));

  const fractional = clone(context);
  fractional.omissions.localNoticeCount = 1.5;
  fails(() => validateHandoffContext(fractional), 'HANDOFF_INVALID_CONTEXT');

  const negative = clone(context);
  negative.omissions.localNoticeCount = -1;
  fails(() => validateHandoffContext(negative), 'HANDOFF_INVALID_CONTEXT');

  const stringly = clone(context);
  stringly.omissions.localNoticeCount = '2';
  fails(() => validateHandoffContext(stringly), 'HANDOFF_INVALID_CONTEXT');
});

test('blank nextStep does not produce a pending notice', () => {
  const context = build([
    card('T', { messages: [msg('user', 'Q')] }),
  ], 'T', { nextStep: '   \n  ' });
  assert.equal(context.nextStep, '');
  assert.equal(context.notices.some(notice => notice.code === 'NEXT_STEP_PENDING'), false);
  assert.ok(formatHandoffTranscript(context).includes('（用户没有填写下一步要求。）'));
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
// 公开格式化器必须先校验
// ---------------------------------------------------------------------------

test('public formatter validates its input before rendering', () => {
  fails(() => formatHandoffTranscript(null), 'HANDOFF_INVALID_CONTEXT');
  fails(() => formatHandoffTranscript({ schemaVersion: 1, nodes: [], source: {} }), 'HANDOFF_INVALID_CONTEXT');

  const valid = build([card('T', { messages: [msg('user', 'Q')] })], 'T');
  assert.ok(formatHandoffTranscript(valid).includes('历史讨论资料'));

  const tampered = clone(valid);
  tampered.nodes[0].messages[0].text = '不会进入正文的篡改';
  tampered.notices = [{ code: 'NOPE', message: 'x' }];
  fails(() => formatHandoffTranscript(tampered), 'HANDOFF_INVALID_CONTEXT');
});
