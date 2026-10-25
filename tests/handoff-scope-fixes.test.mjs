import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HANDOFF_LIMITS,
  validateHandoffContext,
} from '../ui/assets/fork-handoff-contract.js';
import { buildHandoffContext } from '../ui/assets/fork-handoff-context.js';

// ---------------------------------------------------------------------------
// 夹具：规范快照形态；messages 必填数组，contextRefs 只在需要时出现。
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

// 引用夹具：来源卡片不在 target 的依赖路径上
function ref(id, sourceCardId, text = 'REF-TEXT') {
  return { id, sourceCardId, sourceTitle: '来源', text };
}

// ---------------------------------------------------------------------------
// C1-a：DAG 可达性——伪造的兄弟节点/排除项不能通过校验
// ---------------------------------------------------------------------------

test('forged unreachable sibling node is rejected even with valid-looking content', () => {
  const context = build([
    card('A', { messages: [msg('user', 'A-BODY')] }),
    card('T', { parents: ['A'], messages: [msg('user', 'T-BODY')] }),
  ], 'T');

  const tampered = clone(context);
  tampered.nodes.push({
    cardId: 'S',
    title: '无关兄弟',
    parentIds: ['A'],
    contextMode: 'include',
    doc: null,
    messages: [{ role: 'user', text: 'SIBLING-LEAK', agentName: '', status: 'ok', attachments: [], artifactIds: [] }],
    artifactIds: [],
  });
  fails(() => validateHandoffContext(tampered), 'HANDOFF_UNREACHABLE_NODE');
});

test('forged unreachable exclusion is rejected', () => {
  const context = build([
    card('A', { messages: [msg('user', 'A-BODY')] }),
    card('T', { parents: ['A'], messages: [msg('user', 'T-BODY')] }),
  ], 'T');
  const tampered = clone(context);
  tampered.exclusions.push({ cardId: 'E2', title: '无关排除', parentIds: [] });
  fails(() => validateHandoffContext(tampered), 'HANDOFF_UNREACHABLE_NODE');
});

// ---------------------------------------------------------------------------
// C1-b：A(include) → E(exclude) → T 的合法路径，exclusions 带 parentIds
// ---------------------------------------------------------------------------

test('ancestors connected through an excluded node stay legal and verifiable', () => {
  const context = build([
    card('A', { messages: [msg('user', 'ROOT-BODY')] }),
    card('E', { parents: ['A'], contextMode: 'exclude', messages: [msg('assistant', 'EXCLUDED-BODY')] }),
    card('T', { parents: ['E'], messages: [msg('user', 'TARGET-BODY')] }),
  ], 'T');

  assert.deepEqual(context.nodes.map(node => node.cardId), ['A', 'T'], 'include 祖先不能因中间 exclude 被误拒');
  assert.deepEqual(context.exclusions, [{ cardId: 'E', title: '', parentIds: ['A'] }]);
  assert.deepEqual(validateHandoffContext(context), context, '合法路径必须原样通过校验');

  // 去掉 A 但 E 仍声明它：必须报缺父，而不是悄悄断开
  const missing = clone(context);
  missing.nodes = missing.nodes.filter(node => node.cardId !== 'A');
  fails(() => validateHandoffContext(missing), 'HANDOFF_MISSING_PARENT');

  // 排除项不在目标依赖路径上（伪造）也要拒绝
  const unreachable = clone(context);
  unreachable.exclusions.push({ cardId: 'E3', title: '', parentIds: ['A'] });
  fails(() => validateHandoffContext(unreachable), 'HANDOFF_UNREACHABLE_NODE');
});

test('node count limit covers excluded ancestors too', () => {
  const cards = [card('n0', { messages: [msg('user', 'N0')] })];
  for (let index = 1; index <= HANDOFF_LIMITS.maxNodes; index++) {
    cards.push(card(`n${index}`, { parents: [`n${index - 1}`], messages: [msg('user', `N${index}`)] }));
  }
  fails(() => build(cards, `n${HANDOFF_LIMITS.maxNodes}`), 'HANDOFF_TOO_MANY_NODES');

  // 校验器同样把 nodes + exclusions 一起计入上限
  const context = build([
    card('A', { messages: [msg('user', 'A-BODY')] }),
    card('T', { parents: ['A'], messages: [msg('user', 'T-BODY')] }),
  ], 'T');
  const exclusions = Array.from({ length: HANDOFF_LIMITS.maxNodes }, (_, index) => ({
    cardId: `e${index}`,
    title: '',
    parentIds: index === 0 ? ['A'] : [`e${index - 1}`],
  }));
  const tampered = clone(context);
  tampered.nodes[0].parentIds = ['e0'];
  tampered.exclusions = exclusions;
  fails(() => validateHandoffContext(tampered), 'HANDOFF_TOO_MANY_NODES');
});

test('reference source metadata follows the real mode of an excluded target node', () => {
  const context = build([
    card('A', {
      messages: [msg('user', 'A-BODY')],
      contextRefs: [ref('ref-1', 'T', 'TARGET-SNAPSHOT')],
    }),
    card('T', { parents: ['A'], contextMode: 'exclude', messages: [msg('user', 'T-BODY')] }),
  ], 'T');
  assert.deepEqual(context.referenceSources, [{ cardId: 'T', exists: true, contextMode: 'exclude' }]);
  assert.equal(context.references[0].status, 'source-excluded');
  assert.equal(context.references[0].text, '');
  assert.deepEqual(validateHandoffContext(context), context);
});

// ---------------------------------------------------------------------------
// C1-c：referenceSources 元数据决定引用状态
// ---------------------------------------------------------------------------

test('existing source outside the dependency path stays a valid cross-branch reference', () => {
  const context = build([
    card('A', { messages: [msg('user', 'A-BODY')] }),
    card('S', { parents: ['A'], messages: [msg('user', 'SIBLING-BODY')] }),
    card('T', {
      parents: ['A'],
      messages: [msg('user', 'T-BODY')],
      contextRefs: [ref('ref-1', 'S', 'CROSS-BRANCH-TEXT')],
    }),
  ], 'T');

  assert.deepEqual(context.referenceSources, [{ cardId: 'S', exists: true, contextMode: 'include' }]);
  assert.equal(context.references[0].status, 'snapshot');
  assert.equal(context.references[0].included, true);
  assert.equal(context.references[0].text, 'CROSS-BRANCH-TEXT');
  assert.deepEqual(context.nodes.map(node => node.cardId), ['A', 'T'], '跨分支来源不带入兄弟正文');
  assert.deepEqual(validateHandoffContext(context), context);
});

test('deleted source keeps its snapshot and is not mislabelled as live', () => {
  const context = build([
    card('T', {
      messages: [msg('user', 'T-BODY')],
      contextRefs: [ref('ref-1', 'gone', 'DELETED-TEXT')],
    }),
  ], 'T');
  assert.deepEqual(context.referenceSources, [{ cardId: 'gone', exists: false, contextMode: null }]);
  assert.equal(context.references[0].status, 'source-deleted');
  assert.equal(context.references[0].text, 'DELETED-TEXT');
  assert.deepEqual(validateHandoffContext(context), context);

  const bad = clone(context);
  bad.referenceSources[0].contextMode = 'include';
  fails(() => validateHandoffContext(bad), 'HANDOFF_INVALID_CONTEXT');
});

test('excluded source references cannot be relabelled snapshot and carry text', () => {
  const context = build([
    card('A', { messages: [msg('user', 'A-BODY')] }),
    card('S', { parents: ['A'], contextMode: 'exclude', messages: [msg('assistant', 'EXCLUDED-BODY')] }),
    card('T', {
      parents: ['A'],
      messages: [msg('user', 'T-BODY')],
      contextRefs: [ref('ref-1', 'S', 'LEAK-TEXT')],
    }),
  ], 'T');
  assert.deepEqual(context.referenceSources, [{ cardId: 'S', exists: true, contextMode: 'exclude' }]);
  assert.equal(context.references[0].status, 'source-excluded');
  assert.equal(context.references[0].included, false);
  assert.equal(context.references[0].text, '');

  const relabelled = clone(context);
  relabelled.references[0].status = 'snapshot';
  relabelled.references[0].included = true;
  relabelled.references[0].text = 'LEAK-TEXT';
  fails(() => validateHandoffContext(relabelled), 'HANDOFF_INVALID_CONTEXT');
});

test('reference source metadata must be unique, complete and match the dependency graph', () => {
  const context = build([
    card('A', { messages: [msg('user', 'A-BODY')] }),
    card('S', { parents: ['A'], messages: [msg('user', 'SIBLING-BODY')] }),
    card('T', {
      parents: ['A'],
      messages: [msg('user', 'T-BODY')],
      contextRefs: [ref('ref-1', 'S', 'CROSS-BRANCH-TEXT')],
    }),
  ], 'T');

  const duplicate = clone(context);
  duplicate.referenceSources.push({ cardId: 'S', exists: true, contextMode: 'include' });
  fails(() => validateHandoffContext(duplicate), 'HANDOFF_INVALID_CONTEXT');

  const unrelated = clone(context);
  unrelated.referenceSources.push({ cardId: 'Z', exists: true, contextMode: 'include' });
  fails(() => validateHandoffContext(unrelated), 'HANDOFF_INVALID_CONTEXT');

  const missing = clone(context);
  missing.referenceSources = [];
  fails(() => validateHandoffContext(missing), 'HANDOFF_INVALID_CONTEXT');

  // 图内节点的真实 contextMode 是 include，元数据不能声称 exclude
  const toAncestor = build([
    card('A', { messages: [msg('user', 'A-BODY')] }),
    card('T', {
      parents: ['A'],
      messages: [msg('user', 'T-BODY')],
      contextRefs: [ref('ref-2', 'A', 'ANCESTOR-TEXT')],
    }),
  ], 'T');
  const mismatched = clone(toAncestor);
  mismatched.referenceSources[0].contextMode = 'exclude';
  fails(() => validateHandoffContext(mismatched), 'HANDOFF_INVALID_CONTEXT');
});
