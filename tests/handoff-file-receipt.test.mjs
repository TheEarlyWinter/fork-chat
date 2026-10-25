import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatHandoffTranscript,
  normalizeHandoffFileReceipt,
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
