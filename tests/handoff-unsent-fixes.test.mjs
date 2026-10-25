import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateHandoffContext,
  formatHandoffTranscript,
} from '../ui/assets/fork-handoff-contract.js';
import { buildHandoffContext } from '../ui/assets/fork-handoff-context.js';
import { normalizeForkSnapshot } from '../ui/assets/fork-snapshot.js';

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

function staged(name, content, extra = {}) {
  return { name, extension: 'md', charCount: content.length, lineCount: 1, content, ...extra };
}

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
