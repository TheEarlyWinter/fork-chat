// 保护交接上下文的范围边界：哪些卡片能被带进来、被排除的祖先如何记账、
// 引用来源的元数据是否可伪造、节点上限，以及未发送草稿只暴露预览元数据。
// 这些都是同一张依赖图上的可达性判断，任何一处放宽都会把不该交接的内容带出去，
// 因此合在一起回归。用例来自 handoff-scope-fixes 与 handoff-unsent-fixes。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HANDOFF_LIMITS,
  validateHandoffContext,
  formatHandoffTranscript,
} from '../ui/assets/fork-handoff-contract.js';
import { buildHandoffContext } from '../ui/assets/fork-handoff-context.js';
import { normalizeForkSnapshot } from '../ui/assets/fork-snapshot.js';

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

function staged(name, content, extra = {}) {
  return { name, extension: 'md', charCount: content.length, lineCount: 1, content, ...extra };
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

// ---------------------------------------------------------------------------
// 合法未发送项：只出预览元数据
// ---------------------------------------------------------------------------

test('unsent drafts and staged attachments become preview metadata only', () => {
  const big = 'a'.repeat(300000);
  const context = build([
    card('T', {
      draft: 'DRAFT-SENTINEL',
      stagedAttachments: [
        staged('STAGED-NAME-SENTINEL.md', 'STAGED-CONTENT-SENTINEL'),
        staged('big.md', big),
      ],
      messages: [msg('user', 'Q')],
    }),
  ], 'T');

  assert.deepEqual(context.unsent, [{
    cardId: 'T',
    hasDraft: true,
    draftChars: 'DRAFT-SENTINEL'.length,
    attachments: [
      { name: 'STAGED-NAME-SENTINEL.md', contentTruncated: false },
      { name: 'big.md', contentTruncated: true },
    ],
    attachmentsDropped: 0,
  }]);
  assert.deepEqual(validateHandoffContext(context), context);

  const transcript = formatHandoffTranscript(context);
  assert.ok(!transcript.includes('DRAFT-SENTINEL'));
  assert.ok(!transcript.includes('STAGED-NAME-SENTINEL'));
  assert.ok(!transcript.includes('STAGED-CONTENT-SENTINEL'));
  assert.ok(transcript.includes('未发送'));
  // 未发送项不会自动变成下一步要求
  assert.equal(context.nextStep, '');
});

test('excluded nodes can report their own unsent items', () => {
  const context = build([
    card('A', { messages: [msg('user', 'ROOT-BODY')] }),
    card('E', {
      parents: ['A'],
      contextMode: 'exclude',
      messages: [msg('assistant', 'EXCLUDED-BODY')],
      draft: 'EXCLUDED-DRAFT',
      stagedAttachments: [staged('excluded.md', 'EXCLUDED-STAGED')],
    }),
    card('T', { parents: ['E'], messages: [msg('user', 'TARGET-BODY')] }),
  ], 'T');

  assert.deepEqual(context.nodes.map(node => node.cardId), ['A', 'T']);
  assert.deepEqual(context.unsent, [{
    cardId: 'E',
    hasDraft: true,
    draftChars: 'EXCLUDED-DRAFT'.length,
    attachments: [{ name: 'excluded.md', contentTruncated: false }],
    attachmentsDropped: 0,
  }]);
  assert.deepEqual(validateHandoffContext(context), context);
  const transcript = formatHandoffTranscript(context);
  assert.ok(!transcript.includes('EXCLUDED-DRAFT'));
  assert.ok(!transcript.includes('excluded.md'));
});

// ---------------------------------------------------------------------------
// 非法/伪造未发送元数据
// ---------------------------------------------------------------------------

test('unsent metadata is whitelisted, bounded and checked against the dependency graph', () => {
  const context = build([
    card('T', {
      draft: 'DRAFT-SENTINEL',
      stagedAttachments: [staged('a.md', 'x')],
      messages: [msg('user', 'Q')],
    }),
  ], 'T');

  const unknownCard = clone(context);
  unknownCard.unsent[0].cardId = 'not-in-graph';
  fails(() => validateHandoffContext(unknownCard), 'HANDOFF_INVALID_CONTEXT');

  const duplicateCard = clone(context);
  duplicateCard.unsent.push(clone(duplicateCard.unsent[0]));
  fails(() => validateHandoffContext(duplicateCard), 'HANDOFF_INVALID_CONTEXT');

  const fractional = clone(context);
  fractional.unsent[0].draftChars = 1.5;
  fails(() => validateHandoffContext(fractional), 'HANDOFF_INVALID_CONTEXT');

  const negative = clone(context);
  negative.unsent[0].attachmentsDropped = -1;
  fails(() => validateHandoffContext(negative), 'HANDOFF_INVALID_CONTEXT');

  const inconsistent = clone(context);
  inconsistent.unsent[0].hasDraft = false;
  fails(() => validateHandoffContext(inconsistent), 'HANDOFF_INVALID_CONTEXT');

  const notArray = clone(context);
  notArray.unsent[0].attachments = 'bad';
  fails(() => validateHandoffContext(notArray), 'HANDOFF_INVALID_CONTEXT');

  const tooMany = clone(context);
  tooMany.unsent[0].attachments = Array.from({ length: 21 }, (_, index) => ({ name: `f${index}.md`, contentTruncated: false }));
  fails(() => validateHandoffContext(tooMany), 'HANDOFF_INVALID_CONTEXT');

  const badFlag = clone(context);
  badFlag.unsent[0].attachments[0].contentTruncated = 'yes';
  fails(() => validateHandoffContext(badFlag), 'HANDOFF_INVALID_CONTEXT');

  const emptyEntry = clone(context);
  emptyEntry.unsent.push({ cardId: 'T', hasDraft: false, draftChars: 0, attachments: [], attachmentsDropped: 0 });
  fails(() => validateHandoffContext(emptyEntry), 'HANDOFF_INVALID_CONTEXT');

  // 白名单：客户端夹带的正文与任意字段不会留下
  const extra = clone(context);
  extra.unsent[0].draft = 'SENTINEL-DRAFT-BODY';
  extra.unsent[0].attachments[0].content = 'SENTINEL-STAGED-BODY';
  extra.unsent[0].cookie = 'x';
  const cleaned = validateHandoffContext(extra);
  assert.equal(Object.hasOwn(cleaned.unsent[0], 'draft'), false);
  assert.equal(Object.hasOwn(cleaned.unsent[0], 'cookie'), false);
  assert.equal(Object.hasOwn(cleaned.unsent[0].attachments[0], 'content'), false);
  const transcript = formatHandoffTranscript(extra);
  assert.ok(!transcript.includes('SENTINEL-DRAFT-BODY'));
  assert.ok(!transcript.includes('SENTINEL-STAGED-BODY'));

  // 超长名称按预览元数据截到 200 字，不引入正文
  const longName = clone(context);
  longName.unsent[0].attachments[0].name = 'n'.repeat(260);
  assert.equal(Array.from(validateHandoffContext(longName).unsent[0].attachments[0].name).length, 200);
});

test('unsent items alone are not business content', () => {
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
  empty.unsent = [{ cardId: 'T', hasDraft: true, draftChars: 5, attachments: [], attachmentsDropped: 0 }];
  fails(() => validateHandoffContext(empty), 'HANDOFF_NO_CONTENT');
});

// ---------------------------------------------------------------------------
// 快照：暂存附件标记保存/重开不丢
// ---------------------------------------------------------------------------

test('staged attachment markers survive save and reopen without touching the body', () => {
  const big = 'b'.repeat(300000);
  const input = snapshot([
    card('T', {
      messages: [msg('user', 'Q')],
      stagedAttachments: [
        staged('big.md', big),
        ...Array.from({ length: 21 }, (_, index) => staged(`s${index}.md`, 'x')),
      ],
    }),
  ]);
  const normalized = normalizeForkSnapshot(input);
  const saved = normalized.cards[0];
  assert.equal(saved.stagedAttachments.length, 20);
  assert.equal(saved.stagedAttachmentsDropped, 2);
  assert.deepEqual(saved.stagedAttachmentsTruncated, [0]);
  assert.equal(saved.stagedAttachments[0].content.length, big.length, '旧正文一字不改');

  const reopened = normalizeForkSnapshot(normalized);
  assert.equal(reopened.cards[0].stagedAttachmentsDropped, 2);
  assert.deepEqual(reopened.cards[0].stagedAttachmentsTruncated, [0]);

  // 无裁切的普通卡不新增标记
  const plain = normalizeForkSnapshot(snapshot([card('P', { messages: [] })]));
  assert.equal(Object.hasOwn(plain.cards[0], 'stagedAttachmentsDropped'), false);
});
