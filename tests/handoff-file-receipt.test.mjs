import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HANDOFF_LIMITS,
  formatHandoffTranscript,
  normalizeHandoffFileReceipt,
  validateHandoffContext,
} from '../ui/assets/fork-handoff-contract.js';
import { buildHandoffContext } from '../ui/assets/fork-handoff-context.js';

// ---------------------------------------------------------------------------
// 公共文件回执规则：服务端 checkpoint 与 formatter 必须用同一份
// ---------------------------------------------------------------------------

const VALID = { fileId: 'file-1', name: '报告.md', mime: 'text/markdown' };

test('normalizeHandoffFileReceipt returns exactly fileId/name/mime and drops every other field', () => {
  const normalized = normalizeHandoffFileReceipt({
    ...VALID,
    path: '/private/path/secret.md',
    sessionId: 'sess-1',
    bytes: 12,
    kind: 'artifact',
  });
  assert.deepEqual(normalized, VALID);
  assert.equal(Object.hasOwn(normalized, 'path'), false);
  assert.equal(Object.hasOwn(normalized, 'sessionId'), false);
});

test('normalizeHandoffFileReceipt rejects a path-shaped fileId instead of trusting it', () => {
  const cases = [
    '/private/path/secret.md',
    '../../private/context',
    'file 1',
    '',
    'x'.repeat(201),
    42,
    undefined,
  ];
  for (const fileId of cases) {
    assert.throws(
      () => normalizeHandoffFileReceipt({ ...VALID, fileId }),
      error => error?.code === 'HANDOFF_INVALID_FILE' && /缺少宿主 fileId/.test(error.message),
      String(fileId),
    );
  }
});

test('normalizeHandoffFileReceipt rejects a non-object receipt and reports the 1-based index', () => {
  for (const raw of [null, undefined, 'file-1', ['file-1'], 7]) {
    assert.throws(
      () => normalizeHandoffFileReceipt(raw, 2),
      error => error?.code === 'HANDOFF_INVALID_FILE' && /第 3 个文件回执不是对象/.test(error.message),
    );
  }
});

test('normalizeHandoffFileReceipt keeps the existing name/mime wording and sanitizes the label', () => {
  assert.throws(
    () => normalizeHandoffFileReceipt({ ...VALID, name: '   ' }),
    error => error?.code === 'HANDOFF_INVALID_FILE' && /第 1 个文件回执缺少文件名/.test(error.message),
  );
  assert.throws(
    () => normalizeHandoffFileReceipt({ ...VALID, mime: 'not-a-mime' }, 4),
    error => error?.code === 'HANDOFF_INVALID_FILE' && /第 5 个文件回执的 mime 不合法/.test(error.message),
  );
  // 控制字符会被替换成空格，不算缺名
  const sanitized = normalizeHandoffFileReceipt({ ...VALID, name: 'bad\nname.md' });
  assert.equal(sanitized.name, 'bad name.md');
});

// ---------------------------------------------------------------------------
// formatter 复用同一份规则：输出与错误语义都由 helper 决定
// ---------------------------------------------------------------------------

function context() {
  return buildHandoffContext({
    snapshot: {
      cards: [{ id: 'card-1', x: 0, y: 0, width: 320, draft: '', messages: [{ role: 'user', text: '交接内容' }] }],
      view: { x: 0, y: 0, scale: 1 },
      agent: { id: 'agent-a', name: '助手' },
    },
    source: { canvasId: 'canvas-1', revision: 'rev-1', targetCardId: 'card-1' },
    targetCardId: 'card-1',
    agentId: 'agent-a',
    nextStep: '继续处理',
  });
}

test('formatter reuses normalizeHandoffFileReceipt for the artifact index line', () => {
  const receipt = { ...VALID, path: '/private/path/secret.md', kind: 'artifact', artifactId: 'a'.repeat(32) };
  const text = formatHandoffTranscript(context(), { files: [receipt] });
  const normalized = normalizeHandoffFileReceipt(receipt, 0);
  assert.ok(text.includes(`- ${normalized.fileId} · ${normalized.name} · ${normalized.mime}`));
  assert.equal(text.includes('/private/path/secret.md'), false);

  const archive = { fileId: 'file-2', name: 'handoff.md', mime: 'text/markdown' };
  const withArchive = formatHandoffTranscript(context(), { files: [VALID], archiveFile: archive });
  assert.ok(withArchive.includes(`- ${archive.fileId} · ${archive.name} · ${archive.mime} · 本次交接 Markdown`));
});

test('formatter rejects exactly the receipts the helper rejects', () => {
  const invalid = [
    { ...VALID, fileId: '/private/path/secret.md' },
    { ...VALID, name: '' },
    { ...VALID, mime: 'nope' },
    { fileId: 'file-1' },
    'not-an-object',
  ];
  for (const receipt of invalid) {
    assert.throws(
      () => normalizeHandoffFileReceipt(receipt),
      error => error?.code === 'HANDOFF_INVALID_FILE',
      `helper: ${JSON.stringify(receipt)}`,
    );
    assert.throws(
      () => formatHandoffTranscript(context(), { files: [receipt] }),
      error => error?.code === 'HANDOFF_INVALID_FILE',
      `formatter: ${JSON.stringify(receipt)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 正文预算与文件索引预算的分界：索引插入新带的 join 分隔 LF 算索引，不算正文
// ---------------------------------------------------------------------------

const BODY_BUDGET = HANDOFF_LIMITS.maxTranscriptBytes - HANDOFF_LIMITS.fileIndexReserveBytes;
const ARCHIVE_RECEIPT = { fileId: 'file-archive', name: 'handoff.md', mime: 'text/markdown' };

/** 手工构造合法 DTO（编译器会提前拒超限，这里直接造协议层输入） */
function dtoWithText(chars) {
  return {
    schemaVersion: 1,
    source: { canvasId: 'canvas-1', revision: 'rev-1', targetCardId: 'card-1' },
    agentId: 'agent-a',
    nextStep: '继续处理',
    nodes: [{
      cardId: 'card-1',
      title: '目标',
      parentIds: [],
      contextMode: 'include',
      doc: null,
      messages: [{
        role: 'user',
        text: 'x'.repeat(chars),
        agentName: '',
        status: 'ok',
        attachments: [],
        artifactIds: [],
      }],
      artifactIds: [],
    }],
    references: [],
    referenceSources: [],
    artifactIds: [],
    exclusions: [],
    omissions: { localNoticeCount: 0 },
    unsent: [],
    notices: [],
    stats: { nodeCount: 0, transcriptBytes: 0 },
  };
}

function contextAtExactBodyBudget() {
  const probeBytes = validateHandoffContext(dtoWithText(1000)).stats.transcriptBytes;
  const chars = 1000 + (BODY_BUDGET - probeBytes);
  const context = validateHandoffContext(dtoWithText(chars));
  assert.equal(context.stats.transcriptBytes, BODY_BUDGET, '夹具必须恰好落在正文预算上');
  return context;
}

function fileSectionOf(text) {
  const start = text.indexOf('## 交付文件索引');
  const end = text.indexOf('## 尚未执行的下一步要求');
  assert.ok(start >= 0 && end > start, '渲染结果必须包含文件索引与下一步要求');
  return text.slice(start, end);
}

test('a context exactly at the body budget still formats once an archive receipt is added', () => {
  const context = contextAtExactBodyBudget();
  const bodyOnly = formatHandoffTranscript(context);
  assert.equal(Buffer.byteLength(bodyOnly, 'utf8'), BODY_BUDGET, '无索引时正文计量与 stats 对齐');

  // 索引插入发生在正文中间，join 会多一个分隔 LF；它属于索引预算，不属于正文
  const withArchive = formatHandoffTranscript(context, { archiveFile: ARCHIVE_RECEIPT });
  const fileSection = fileSectionOf(withArchive);
  // fileSection 切片含索引块后的分隔 LF（不含插入点前多出的那个）
  assert.equal(
    Buffer.byteLength(withArchive, 'utf8'),
    BODY_BUDGET + Buffer.byteLength(fileSection, 'utf8'),
    '总字节 = 正文预算 + 索引块（含其后的分隔 LF）',
  );
  assert.ok(withArchive.includes('## 交付文件索引'), '索引必须真的插进输出');
  assert.ok(Buffer.byteLength(withArchive, 'utf8') <= HANDOFF_LIMITS.maxTranscriptBytes);
});

test('one byte over the body budget is still refused after formatting an index', () => {
  const probeBytes = validateHandoffContext(dtoWithText(1000)).stats.transcriptBytes;
  const chars = 1000 + (BODY_BUDGET - probeBytes) + 1;
  const over = validateHandoffContext(dtoWithText(chars));
  assert.equal(over.stats.transcriptBytes, BODY_BUDGET + 1);

  assert.throws(
    () => formatHandoffTranscript(over, { archiveFile: ARCHIVE_RECEIPT }),
    error => {
      assert.equal(error?.code, 'HANDOFF_TRANSCRIPT_TOO_LARGE');
      assert.equal(error?.details?.bytes, BODY_BUDGET + 1, '超限计量只算正文');
      return true;
    },
  );
  // 无索引时同样拒绝，二者一致
  assert.throws(() => formatHandoffTranscript(over), error => error?.code === 'HANDOFF_TRANSCRIPT_TOO_LARGE');
});
