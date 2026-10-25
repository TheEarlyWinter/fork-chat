import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HANDOFF_LIMITS,
  HANDOFF_ERROR_CODES,
  handoffError,
  validateHandoffContext,
  formatHandoffTranscript,
} from '../ui/assets/fork-handoff-contract.js';
import {
  buildHandoffContext,
} from '../ui/assets/fork-handoff-context.js';
import { ATTACHMENT_MAX_CHARS } from '../ui/assets/fork-snapshot.js';

// ---------------------------------------------------------------------------
// 夹具：直接构造"已保存快照"形态的卡片，build 自己负责严格校验
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

function source(target) {
  return { canvasId: 'canvas-1', revision: 'rev-7', targetCardId: target };
}

function build(cards, target, extra = {}) {
  return buildHandoffContext({
    snapshot: snapshot(cards),
    source: source(target),
    targetCardId: target,
    agentId: 'agent-a',
    ...extra,
  });
}

function fails(fn, code) {
  assert.throws(fn, error => {
    assert.equal(error.code, code, `期望 ${code}，实际 ${error.code}：${error.message}`);
    return true;
  });
}

function attachment(name, content, extra = {}) {
  return { name, extension: 'md', charCount: content.length, lineCount: 1, content, ...extra };
}

function artifact(id, bytes = 1024) {
  return {
    artifactId: id, status: 'ready', name: '报告.md', mime: 'text/markdown', format: 'md',
    bytes, sha256: 'a'.repeat(64), createdAt: '2026-10-25T00:00:00.000Z', cardId: 'c1',
  };
}

// 32 位十六进制 id，避免每次手写
const aid = (seed) => String(seed).padStart(2, '0').repeat(16);

// ---------------------------------------------------------------------------
// Step 1/2：拓扑、顺序、排除、引用、附件、限额
// ---------------------------------------------------------------------------

test('handoff follows only dependencies and keeps every sent message', () => {
  const cards = [
    card('A', { messages: [msg('user', 'ROOT-Q1'), msg('user', 'ROOT-Q2'), msg('assistant', 'ROOT-A1')] }),
    card('B', { parents: ['A'], messages: [msg('user', 'B-Q'), msg('assistant', 'B-A')] }),
    card('C', { parents: ['A'], messages: [msg('user', 'C-Q'), msg('assistant', 'C-A')] }),
    card('S', { parents: ['A'], messages: [msg('user', 'SIBLING-BODY')] }),
    card('D', { parents: ['B', 'C'], messages: [msg('user', 'TARGET-BODY')] }),
  ];
  const context = build(cards, 'D');

  // 菱形共同祖先 A 只出现一次；兄弟 S 不在依赖里
  assert.deepEqual(context.nodes.map(node => node.cardId), ['A', 'B', 'C', 'D']);
  const transcript = formatHandoffTranscript(context);
  const countOf = (needle) => transcript.split(needle).length - 1;
  assert.equal(countOf('ROOT-Q1'), 1);
  assert.equal(countOf('ROOT-A1'), 1);
  assert.equal(countOf('SIBLING-BODY'), 0);
  assert.equal(context.stats.nodeCount, 4);
  assert.equal(context.stats.messageCount, 8);

  // 角色顺序与相邻同角色消息都保留
  const nodeA = context.nodes[0];
  assert.deepEqual(nodeA.messages.map(m => m.role), ['user', 'user', 'assistant']);
  assert.deepEqual(nodeA.messages.map(m => m.text), ['ROOT-Q1', 'ROOT-Q2', 'ROOT-A1']);
  assert.ok(transcript.indexOf('ROOT-Q1') < transcript.indexOf('ROOT-Q2'));
  assert.ok(transcript.indexOf('ROOT-Q2') < transcript.indexOf('ROOT-A1'));
  assert.equal(countOf('### 用户'), 5);
  assert.equal(countOf('### 助手'), 3);

  // 每个节点都按拓扑序出现：父节点正文先于子节点
  assert.ok(transcript.indexOf('ROOT-A1') < transcript.indexOf('B-Q'));
  assert.ok(transcript.indexOf('B-A') < transcript.indexOf('TARGET-BODY'));
});

test('excluded ancestors contribute no body, traversal continues, target stays included', () => {
  const cards = [
    card('R', { messages: [msg('user', 'ROOT-BODY')] }),
    card('E', { parents: ['R'], contextMode: 'exclude', messages: [msg('assistant', 'EXCLUDED-BODY')] }),
    card('T', { parents: ['E'], messages: [msg('user', 'TARGET-BODY')] }),
  ];
  const context = build(cards, 'T');
  assert.deepEqual(context.nodes.map(node => node.cardId), ['R', 'T']);
  assert.deepEqual(context.exclusions.map(item => item.cardId), ['E']);
  const transcript = formatHandoffTranscript(context);
  assert.ok(transcript.includes('ROOT-BODY'));
  assert.ok(transcript.includes('TARGET-BODY'));
  assert.ok(!transcript.includes('EXCLUDED-BODY'));
  assert.ok(context.notices.some(n => n.code === 'EXCLUDED_ANCESTORS'));

  // 目标自身被排除也纳入，并明确提示
  const selfExcluded = build([
    card('R', { messages: [msg('user', 'ROOT-BODY')] }),
    card('T', { parents: ['R'], contextMode: 'exclude', messages: [msg('user', 'TARGET-BODY')] }),
  ], 'T');
  assert.ok(selfExcluded.nodes.some(node => node.cardId === 'T'));
  assert.ok(selfExcluded.notices.some(n => n.code === 'TARGET_EXCLUDED'));
});

test('explicit references keep their snapshot and never pull in a sibling branch', () => {
  const cards = [
    card('A', { messages: [msg('user', 'ROOT-BODY')] }),
    card('S', { parents: ['A'], messages: [msg('user', 'SIBLING-BODY')] }),
    card('T', {
      parents: ['A'],
      messages: [msg('user', 'TARGET-BODY')],
      contextRefs: [{ id: 'ref-1', sourceCardId: 'S', sourceTitle: '兄弟分支', text: 'REF-TEXT' }],
    }),
  ];
  const context = build(cards, 'T');
  assert.equal(context.references.length, 1);
  assert.equal(context.references[0].status, 'snapshot');
  assert.equal(context.references[0].included, true);
  assert.equal(context.references[0].text, 'REF-TEXT');
  assert.deepEqual(context.references[0].positions, ['T']);
  const transcript = formatHandoffTranscript(context);
  assert.ok(transcript.includes('REF-TEXT'));
  assert.ok(!transcript.includes('SIBLING-BODY'));
  assert.deepEqual(context.nodes.map(node => node.cardId), ['A', 'T']);
});

test('reference sources that are deleted or excluded are disclosed, not leaked', () => {
  const deleted = build([
    card('T', {
      messages: [msg('user', 'TARGET-BODY')],
      contextRefs: [{ id: 'ref-1', sourceCardId: 'gone', sourceTitle: '已删来源', text: 'DELETED-TEXT' }],
    }),
  ], 'T');
  assert.equal(deleted.references[0].status, 'source-deleted');
  assert.equal(deleted.references[0].text, 'DELETED-TEXT');
  assert.ok(deleted.notices.some(n => n.code === 'REFERENCE_SOURCE_DELETED'));
  assert.ok(formatHandoffTranscript(deleted).includes('DELETED-TEXT'));

  const excludedSource = build([
    card('A', { messages: [msg('user', 'ROOT-BODY')] }),
    card('S', { parents: ['A'], contextMode: 'exclude', messages: [msg('assistant', 'EXCLUDED-BODY')] }),
    card('T', {
      parents: ['A'],
      messages: [msg('user', 'TARGET-BODY')],
      contextRefs: [{ id: 'ref-1', sourceCardId: 'S', sourceTitle: '被排除来源', text: 'LEAKED-TEXT' }],
    }),
  ], 'T');
  assert.equal(excludedSource.references[0].status, 'source-excluded');
  assert.equal(excludedSource.references[0].included, false);
  assert.equal(excludedSource.references[0].text, '');
  assert.ok(excludedSource.notices.some(n => n.code === 'REFERENCE_SOURCE_EXCLUDED'));
  const transcript = formatHandoffTranscript(excludedSource);
  assert.ok(!transcript.includes('LEAKED-TEXT'));
  assert.ok(!transcript.includes('EXCLUDED-BODY'));
});

test('reference conflicts are rejected; identical references dedupe but keep every position', () => {
  const conflict = [
    card('A', {
      messages: [msg('user', 'A-BODY')],
      contextRefs: [{ id: 'ref-1', sourceCardId: 'gone', sourceTitle: '来源', text: 'FIRST' }],
    }),
    card('T', {
      parents: ['A'],
      messages: [msg('user', 'T-BODY')],
      contextRefs: [{ id: 'ref-1', sourceCardId: 'gone', sourceTitle: '来源', text: 'SECOND' }],
    }),
  ];
  fails(() => build(conflict, 'T'), 'HANDOFF_REFERENCE_CONFLICT');

  const deduped = [
    card('A', {
      messages: [msg('user', 'A-BODY')],
      contextRefs: [{ id: 'ref-1', sourceCardId: 'gone', sourceTitle: '来源', text: 'SAME' }],
    }),
    card('T', {
      parents: ['A'],
      messages: [msg('user', 'T-BODY')],
      contextRefs: [{ id: 'ref-1', sourceCardId: 'gone', sourceTitle: '来源', text: 'SAME' }],
    }),
  ];
  const context = build(deduped, 'T');
  assert.equal(context.references.length, 1);
  assert.deepEqual(context.references[0].positions, ['A', 'T']);
  assert.ok(context.notices.some(n => n.code === 'DUPLICATE_REFERENCES_DEDUPED'));

  // 自引用非法，不给目标节点豁免
  fails(() => build([
    card('T', {
      messages: [msg('user', 'T-BODY')],
      contextRefs: [{ id: 'ref-1', sourceCardId: 'T', sourceTitle: '自己', text: 'SELF' }],
    }),
  ], 'T'), 'HANDOFF_INVALID_REFERENCE');
});

test('broken topology is rejected: missing parent, cycle, duplicate id, missing target', () => {
  fails(() => build([
    card('T', { parents: ['nope'], messages: [msg('user', 'T-BODY')] }),
  ], 'T'), 'HANDOFF_MISSING_PARENT');

  fails(() => build([
    card('A', { parents: ['B'], messages: [msg('user', 'A-BODY')] }),
    card('B', { parents: ['A'], messages: [msg('user', 'B-BODY')] }),
  ], 'A'), 'HANDOFF_CYCLE');

  fails(() => build([
    card('X', { messages: [msg('user', 'X1')] }),
    card('X', { messages: [msg('user', 'X2')] }),
  ], 'X'), 'HANDOFF_DUPLICATE_ID');

  fails(() => build([card('A', { messages: [msg('user', 'A-BODY')] })], 'missing'), 'HANDOFF_TARGET_MISSING');
  fails(() => build([], 'A'), 'HANDOFF_TARGET_MISSING');
});

test('documents carry their saved body and metadata; truncation is rejected', () => {
  const withDoc = build([
    card('T', {
      messages: [msg('user', 'T-BODY')],
      docContent: 'DOC-BODY',
      docMeta: { name: '论文.pdf', type: 'pdf', charCount: 8, lineCount: 1 },
    }),
  ], 'T');
  assert.equal(withDoc.nodes[0].doc.name, '论文.pdf');
  assert.equal(withDoc.nodes[0].doc.content, 'DOC-BODY');
  assert.equal(withDoc.nodes[0].doc.charCount, 8);
  const transcript = formatHandoffTranscript(withDoc);
  assert.ok(transcript.includes('论文.pdf'));
  assert.ok(transcript.includes('DOC-BODY'));

  fails(() => build([
    card('T', {
      messages: [msg('user', 'T-BODY')],
      docContent: 'SHORT',
      docContentTruncated: { kept: 5, original: 500 },
    }),
  ], 'T'), 'HANDOFF_DOC_TRUNCATED');

  fails(() => build([
    card('T', {
      messages: [msg('user', 'T-BODY')],
      docContent: 'SHORT',
      docMeta: { name: '论文.pdf', charCount: 999 },
    }),
  ], 'T'), 'HANDOFF_DOC_TRUNCATED');
});

test('sent attachments enter the transcript; drafts and staged files never do', () => {
  const context = build([
    card('T', {
      draft: 'DRAFT-ONLY',
      stagedAttachments: [attachment('暂存.md', 'STAGED-ONLY')],
      messages: [
        msg('user', 'T-BODY', { attachments: [attachment('已发送.md', 'SENT-ATT')] }),
      ],
    }),
  ], 'T', { nextStep: '请基于这段讨论给出下一步方案。' });
  const transcript = formatHandoffTranscript(context);
  assert.ok(transcript.includes('SENT-ATT'));
  assert.ok(transcript.includes('已发送.md'));
  assert.ok(!transcript.includes('DRAFT-ONLY'));
  assert.ok(!transcript.includes('STAGED-ONLY'));
  assert.equal(context.stats.attachmentCount, 1);
  assert.equal(context.nextStep, '请基于这段讨论给出下一步方案。');
  assert.ok(transcript.includes('尚未执行的下一步要求'));
  assert.ok(transcript.includes('请基于这段讨论给出下一步方案。'));
  assert.ok(context.notices.some(n => n.code === 'NEXT_STEP_PENDING'));
  assert.ok(context.notices.some(n => n.code === 'ORIGINALS_NOT_RETAINED'));
});

test('failed, interrupted, partial messages are marked; local notices are omitted', () => {
  const context = build([
    card('T', {
      messages: [
        msg('assistant', 'CANCELLED-BODY', { status: 'cancelled', failed: true }),
        msg('assistant', 'FAILED-BODY', { status: 'failed', failed: true }),
        msg('assistant', 'PARTIAL-BODY', { partial: true }),
        msg('assistant', 'LOCAL-NOTICE', { localOnly: true }),
        msg('assistant', 'OK-BODY', { status: 'completed' }),
      ],
    }),
  ], 'T');
  assert.deepEqual(context.nodes[0].messages.map(m => m.status), ['cancelled', 'failed', 'partial', 'ok']);
  const transcript = formatHandoffTranscript(context);
  assert.ok(!transcript.includes('LOCAL-NOTICE'));
  assert.ok(transcript.includes('已中断'));
  assert.ok(transcript.includes('失败'));
  assert.ok(transcript.includes('部分'));
  const notice = context.notices.find(n => n.code === 'FAILED_MESSAGES');
  assert.ok(notice);
  assert.match(notice.message, /3/);

  fails(() => build([
    card('T', { messages: [msg('assistant', '半截', { status: 'generating' })] }),
  ], 'T'), 'HANDOFF_GENERATING');
  fails(() => build([
    card('T', { messages: [msg('assistant', '半截', { streaming: true })] }),
  ], 'T'), 'HANDOFF_GENERATING');
});

test('artifact ids dedupe by immutable id and enforce every artifact limit', () => {
  const deduped = build([
    card('T', {
      messages: [
        msg('user', 'Q1', { artifacts: [artifact(aid(1))] }),
        msg('assistant', 'A1', { artifactRefs: [artifact(aid(1))] }),
        msg('user', 'Q2', { artifacts: [artifact(aid(2), 2048)] }),
      ],
    }),
  ], 'T');
  assert.deepEqual(deduped.artifactIds, [aid(1), aid(2)]);
  assert.equal(deduped.stats.artifactCount, 2);
  assert.ok(deduped.notices.some(n => n.code === 'DUPLICATE_ARTIFACTS_DEDUPED'));

  const many = Array.from({ length: HANDOFF_LIMITS.maxArtifacts + 1 }, (_, i) => artifact(aid(i), 10));
  fails(() => build([
    card('T', { messages: [msg('user', 'Q', { artifacts: many })] }),
  ], 'T'), 'HANDOFF_TOO_MANY_ARTIFACTS');

  fails(() => build([
    card('T', { messages: [msg('user', 'Q', { artifacts: [artifact(aid(3), HANDOFF_LIMITS.maxArtifactBytes + 1)] })] }),
  ], 'T'), 'HANDOFF_ARTIFACT_TOO_LARGE');

  const heavy = Array.from({ length: 5 }, (_, i) => artifact(aid(i), 14 * 1024 * 1024));
  fails(() => build([
    card('T', { messages: [msg('user', 'Q', { artifacts: heavy })] }),
  ], 'T'), 'HANDOFF_ARTIFACTS_TOTAL_TOO_LARGE');
});

test('attachment truncation, dropped attachments and unknown integrity are rejected', () => {
  const base = (messages) => [card('T', { messages })];

  fails(() => build(base([
    msg('user', 'Q', { attachments: [attachment('a.md', 'x', { charCount: 100 })] }),
  ]), 'T'), 'HANDOFF_ATTACHMENT_TRUNCATED');

  fails(() => build(base([
    msg('user', 'Q', { attachments: [attachment('a.md', 'x')], attachmentsTruncated: [0] }),
  ]), 'T'), 'HANDOFF_ATTACHMENT_TRUNCATED');

  fails(() => build(base([
    msg('user', 'Q', { attachments: [attachment('a.md', 'x')], attachmentsDropped: 2 }),
  ]), 'T'), 'HANDOFF_ATTACHMENT_DROPPED');

  // 正文正好达到历史截断阈值：没有可靠原始长度，完整性无法确认
  const atThreshold = 'a'.repeat(ATTACHMENT_MAX_CHARS);
  fails(() => build(base([
    msg('user', 'Q', { attachments: [attachment('a.md', atThreshold)] }),
  ]), 'T'), 'HANDOFF_ATTACHMENT_INTEGRITY_UNKNOWN');
});

test('exact transcript budget and prepare JSON budget are enforced with measurable details', () => {
  const bodyLimit = HANDOFF_LIMITS.maxTranscriptBytes - HANDOFF_LIMITS.fileIndexReserveBytes;
  let text = 'a'.repeat(2_100_000);
  let context = null;
  for (let attempt = 0; attempt < 8 && !context; attempt++) {
    try {
      context = build([card('T', { messages: [msg('user', text)] })], 'T');
    } catch (error) {
      assert.equal(error.code, 'HANDOFF_TRANSCRIPT_TOO_LARGE');
      assert.equal(error.details.limit, bodyLimit);
      const overflow = error.details.bytes - error.details.limit;
      text = text.slice(0, text.length - overflow);
    }
  }
  assert.ok(context, '调整到边界后应当通过');
  assert.equal(context.stats.transcriptBytes, bodyLimit, '统计必须按实际内容重算到恰好等于上限');

  let jsonText = '\u0001'.repeat(800_000);
  let jsonContext = null;
  for (let attempt = 0; attempt < 8 && !jsonContext; attempt++) {
    try {
      jsonContext = build([card('T', { messages: [msg('user', jsonText)] })], 'T');
    } catch (error) {
      assert.equal(error.code, 'HANDOFF_PREPARE_TOO_LARGE');
      const overflow = error.details.bytes - error.details.limit;
      jsonText = jsonText.slice(0, jsonText.length - Math.ceil(overflow / 6));
    }
  }
  assert.ok(jsonContext, '调整到边界后应当通过');
  fails(() => build([card('T', { messages: [msg('user', `${jsonText}\u0001`)] })], 'T'), 'HANDOFF_PREPARE_TOO_LARGE');
});

test('300-node deep chain passes; longer chains hit the node cap without stack overflow', () => {
  const makeChain = (length) => {
    const cards = [card('n0', { messages: [msg('user', 'NODE-0')] })];
    for (let i = 1; i < length; i++) {
      cards.push(card(`n${i}`, { parents: [`n${i - 1}`], messages: [msg('user', `NODE-${i}`)] }));
    }
    return cards;
  };
  const context = build(makeChain(HANDOFF_LIMITS.maxNodes), `n${HANDOFF_LIMITS.maxNodes - 1}`);
  assert.equal(context.nodes.length, HANDOFF_LIMITS.maxNodes);
  assert.equal(context.nodes[0].cardId, 'n0');
  assert.equal(context.nodes.at(-1).cardId, `n${HANDOFF_LIMITS.maxNodes - 1}`);

  fails(() => build(makeChain(5000), 'n4999'), 'HANDOFF_TOO_MANY_NODES');
});

test('empty content and invalid source or agent are rejected', () => {
  fails(() => build([card('T')], 'T'), 'HANDOFF_NO_CONTENT');
  fails(() => build([card('T', { messages: [] })], 'T', { agentId: '' }), 'HANDOFF_INVALID_AGENT');
  fails(() => buildHandoffContext({
    snapshot: snapshot([card('T', { messages: [msg('user', 'Q')] })]),
    source: { canvasId: 'canvas-1', revision: 'rev-7', targetCardId: 'other' },
    targetCardId: 'T',
    agentId: 'agent-a',
  }), 'HANDOFF_INVALID_SOURCE');

  // 存储里的 revision 是整数修订，协议层统一窄成字符串
  const numericRevision = buildHandoffContext({
    snapshot: snapshot([card('T', { messages: [msg('user', 'Q')] })]),
    source: { canvasId: 'canvas-1', revision: 3, targetCardId: 'T' },
    targetCardId: 'T',
    agentId: 'agent-a',
  });
  assert.equal(numericRevision.source.revision, '3');
  assert.equal(formatHandoffTranscript(numericRevision).includes('保存版本：3'), true);
});

// ---------------------------------------------------------------------------
// 协议：服务端白名单校验与格式化
// ---------------------------------------------------------------------------

test('validateHandoffContext rebuilds the whitelist and recomputes derived fields', () => {
  const cards = [
    card('A', {
      messages: [msg('user', 'A-BODY', {
        attachments: [attachment('a.md', 'A-ATT')],
      })],
    }),
    card('T', {
      parents: ['A'],
      messages: [msg('assistant', 'T-BODY', { status: 'failed', failed: true })],
      contextRefs: [{ id: 'ref-1', sourceCardId: 'gone', sourceTitle: '来源', text: 'REF' }],
    }),
  ];
  const context = build(cards, 'T');
  const validated = validateHandoffContext(context);
  assert.deepEqual(validated, context, '合法 DTO 校验后应保持一致');

  const tampered = JSON.parse(JSON.stringify(context));
  tampered.owner = 'user-abc';
  tampered.permissionMode = 'bypass';
  tampered.stats = { nodeCount: 999, transcriptBytes: 1 };
  tampered.nodes[0].messages[0].path = '/etc/passwd';
  tampered.nodes[0].messages[0].attachments[0].charCount = 999;
  const cleaned = validateHandoffContext(tampered);
  assert.equal(Object.hasOwn(cleaned, 'owner'), false);
  assert.equal(Object.hasOwn(cleaned, 'permissionMode'), false);
  assert.equal(Object.hasOwn(cleaned.nodes[0].messages[0], 'path'), false);
  assert.equal(cleaned.stats.nodeCount, context.stats.nodeCount);
  assert.equal(cleaned.stats.transcriptBytes, context.stats.transcriptBytes);
  assert.equal(cleaned.nodes[0].messages[0].attachments[0].charCount, 5, 'charCount 按实际正文重算');

  // 非拓扑顺序拒绝
  const reordered = JSON.parse(JSON.stringify(context));
  reordered.nodes.reverse();
  fails(() => validateHandoffContext(reordered), 'HANDOFF_ORDER');

  // 被排除来源的引用不能夹带正文
  const leaking = JSON.parse(JSON.stringify(context));
  leaking.references[0].status = 'source-excluded';
  leaking.references[0].included = false;
  leaking.references[0].text = 'SHOULD-NOT-LEAK';
  fails(() => validateHandoffContext(leaking), 'HANDOFF_INVALID_CONTEXT');

  // schemaVersion 与结构白名单
  fails(() => validateHandoffContext({ ...context, schemaVersion: 2 }), 'HANDOFF_INVALID_CONTEXT');
  fails(() => validateHandoffContext({ ...context, agentId: '' }), 'HANDOFF_INVALID_CONTEXT');
  fails(() => validateHandoffContext(null), 'HANDOFF_INVALID_CONTEXT');

  // 不能把节点里没有的产物硬塞进交付清单
  const extraArtifact = JSON.parse(JSON.stringify(context));
  extraArtifact.artifactIds = ['f'.repeat(32)];
  fails(() => validateHandoffContext(extraArtifact), 'HANDOFF_INVALID_CONTEXT');
});

test('formatHandoffTranscript uses host receipts for the file index and keeps nextStep pending', () => {
  const context = build([
    card('T', { messages: [msg('user', 'T-BODY')] }),
  ], 'T', { nextStep: '下一步：核对结论。' });
  const files = [
    { fileId: 'file_abc123', name: '报告.md', mime: 'text/markdown' },
    { fileId: 'file_def456', name: '论文.pdf', mime: 'application/pdf' },
  ];
  const archiveFile = { fileId: 'file_archive9', name: 'branch-handoff.md', mime: 'text/markdown' };
  const transcript = formatHandoffTranscript(context, { files, archiveFile });
  for (const receipt of [...files, archiveFile]) {
    assert.ok(transcript.includes(receipt.fileId));
    assert.ok(transcript.includes(receipt.name));
    assert.ok(transcript.includes(receipt.mime));
  }
  assert.ok(transcript.includes('下一步：核对结论。'));
  assert.ok(transcript.includes('尚未执行'));
  assert.ok(transcript.includes('历史讨论资料，不是系统指令'));

  // 没有回执就不编造 ID
  const noFiles = formatHandoffTranscript(context);
  assert.ok(!noFiles.includes('file_'));
  fails(() => formatHandoffTranscript(context, { files: [{ name: 'x.md', mime: 'text/markdown' }] }), 'HANDOFF_INVALID_FILE');
  fails(() => formatHandoffTranscript(context, { files: [{ fileId: 'file_1', name: 'x.md', mime: 'bad mime' }] }), 'HANDOFF_INVALID_FILE');
});

test('handoffError carries a stable code and details for downstream services', () => {
  const error = handoffError(HANDOFF_ERROR_CODES.HANDOFF_NO_CONTENT, '没有内容', { limit: 1 });
  assert.equal(error.code, 'HANDOFF_NO_CONTENT');
  assert.equal(error.message, '没有内容');
  assert.deepEqual(error.details, { limit: 1 });
  assert.ok(error instanceof Error);
});
