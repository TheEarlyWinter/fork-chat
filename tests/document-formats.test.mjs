import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDocxText, parseDocument } from '../lib/document-parser.js';
import { DOCUMENT_FORMATS, normalizeDocumentInput, renderDocument } from '../lib/document-formats.js';

const TWO_MIB = 2 * 1024 * 1024;
const SIXTEEN_MIB = 16 * 1024 * 1024;

const MIME_TYPES = {
  md: 'text/markdown',
  html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

function hostileMarkdown() {
  return [
    '# 安全边界验收',
    '',
    '普通正文，包含中文与 **粗体**。',
    '',
    '<script>alert("owned")</script>',
    '<img src="x" onerror="alert(1)">',
    '<a href="javascript:alert(1)">恶意链接</a>',
    '[另一个恶意链接](javascript:alert(2))',
    '',
    '```html',
    '<script>console.log("code")</script>',
    '```',
  ].join('\n');
}

function longPdfMarkdown() {
  return Array.from({ length: 18 }, (_, index) => (
    `第 ${index + 1} 段：PDF 中文字体与真实文字层验收。Fork Chat 不能把生成结果伪装成文本，` +
    '这一段用于推动解析器跨过最小文字层阈值，并验证多段内容仍可被 pdf.js 按顺序读取。'
  )).join('\n\n');
}

function assertSafeHtml(html) {
  assert.equal(typeof html, 'string');
  assert.doesNotMatch(html, /<script\b/i, '预览不应产生可执行 script 元素');
  assert.doesNotMatch(html, /<img\b/i, '原始 img 标签必须被当作文本处理');
  assert.doesNotMatch(html, /<a\b[^>]*(?:href|src)\s*=\s*["'][^"']*(?:javascript|data):/i, '预览不得输出可执行 URL 属性');
  assert.doesNotMatch(html, /<[a-z][^>]*\son[a-z]+\s*=\s*["']/i, '预览不得输出事件处理器属性');
}

test('document-formats: exports the four frozen formats with the expected MIME mappings', () => {
  for (const [format, mime] of Object.entries(MIME_TYPES)) {
    assert.equal(DOCUMENT_FORMATS[format], mime, `${format} MIME mapping must be stable`);
  }
  assert.equal(Object.keys(DOCUMENT_FORMATS).length, 4, 'unknown formats must not silently enter the public map');
});

test('document-formats: normalizes extension, explicit format, title, and UTF-8 input size', () => {
  const normalized = normalizeDocumentInput({
    filename: '报告.MD'.replace('.MD', '.md'),
    content: '# 标题\n\n正文',
    title: '  自定义标题  ',
  });

  assert.equal(normalized.name, '报告.md');
  assert.equal(normalized.filename, '报告.md');
  assert.equal(normalized.format, 'md');
  assert.equal(normalized.mime, MIME_TYPES.md);
  assert.equal(normalized.content, '# 标题\n\n正文');
  assert.equal(normalized.title, '  自定义标题  ');

  const explicit = normalizeDocumentInput({ filename: 'page.html', format: 'html', content: '正文' });
  assert.equal(explicit.format, 'html');
  assert.equal(explicit.mime, MIME_TYPES.html);

  const exactlyAtLimit = 'a'.repeat(TWO_MIB);
  assert.doesNotThrow(() => normalizeDocumentInput({ filename: 'limit.md', content: exactlyAtLimit }));

  const oneByteOver = `${exactlyAtLimit}a`;
  assert.throws(
    () => normalizeDocumentInput({ filename: 'too-large.md', content: oneByteOver }),
    error => error.code === 'DOCUMENT_TOO_LARGE',
  );

  const multibyteOver = '汉'.repeat(Math.floor(TWO_MIB / Buffer.byteLength('汉', 'utf8')) + 1);
  assert.ok(Buffer.byteLength(multibyteOver, 'utf8') > TWO_MIB);
  assert.throws(
    () => normalizeDocumentInput({ filename: 'unicode-over.md', content: multibyteOver }),
    error => error.code === 'DOCUMENT_TOO_LARGE',
  );
});

test('document-formats: rejects unknown, mismatched, path-like, empty, and malformed inputs', () => {
  for (const input of [
    { filename: 'readme.md', format: 'pdf', content: '正文' },
    { filename: 'readme.unknown', content: '正文' },
    { filename: 'readme', format: 'md', content: '正文' },
    { filename: '../escape.md', content: '正文' },
    { filename: 'nested\\escape.md', content: '正文' },
    { filename: 'empty.md', content: '   ' },
    { filename: 'empty-content.md', content: '' },
    { filename: 'not-string.md', content: 42 },
    { filename: 'bad\u0000name.md', content: '正文' },
  ]) {
    assert.throws(() => normalizeDocumentInput(input), input.filename);
  }
});

test('document-formats: Markdown output is UTF-8 binary with bounded preview and safe HTML preview', async () => {
  const content = hostileMarkdown();
  const result = await renderDocument({ filename: 'security.md', content, title: '安全文档' });

  assert.ok(Buffer.isBuffer(result.bytes));
  assert.equal(result.name, 'security.md');
  assert.equal(result.format, 'md');
  assert.equal(result.mime, MIME_TYPES.md);
  assert.equal(result.bytes.toString('utf8'), content, 'Markdown bytes must be the normalized source in UTF-8');
  assert.equal(result.preview, content.slice(0, 800));
  assert.ok(result.preview.length <= 800);
  assertSafeHtml(result.previewHtml);
  assert.match(result.previewHtml, /&lt;script&gt;/i, 'raw HTML must be escaped in the preview');
  assert.ok(result.bytes.length <= SIXTEEN_MIB);
});

test('document-formats: HTML output is a complete generated document and escapes hostile source', async () => {
  const content = hostileMarkdown();
  const result = await renderDocument({ filename: 'security.html', content, title: '标题 <script>bad</script>' });
  const html = result.bytes.toString('utf8');

  assert.equal(result.name, 'security.html');
  assert.equal(result.format, 'html');
  assert.equal(result.mime, MIME_TYPES.html);
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html\b/i);
  assert.match(html, /<body\b/i);
  assert.match(html, /<\/html>\s*$/i);
  assertSafeHtml(html);
  assert.match(html, /&lt;script&gt;alert\(&quot;owned&quot;\)&lt;\/script&gt;/i);
  assert.doesNotMatch(html, /href\s*=\s*["'][^"']*javascript:/i);
  assert.doesNotMatch(html, /<[a-z][^>]*\sonerror\s*=\s*["']/i);
  assert.ok(result.preview.length <= 800);
  assert.ok(result.bytes.length <= SIXTEEN_MIB);
});

test('document-formats: DOCX output has a ZIP signature and is parseable as OOXML text', async () => {
  const content = [
    '# 报告标题',
    '',
    '这是 DOCX 真二进制输出验收。',
    '',
    '- 第一项',
    '- 第二项 **加粗**',
  ].join('\n');
  const result = await renderDocument({ filename: '报告.docx', content, title: 'DOCX 报告' });

  assert.ok(Buffer.isBuffer(result.bytes));
  assert.equal(result.bytes.readUInt32LE(0), 0x04034b50, 'DOCX 必须以 ZIP local-file signature 开头');
  assert.equal(result.format, 'docx');
  assert.equal(result.mime, MIME_TYPES.docx);
  assert.ok(result.bytes.length > content.length, 'DOCX 不得只是改名后的 Markdown 文本');

  const extracted = extractDocxText(result.bytes);
  assert.match(extracted, /报告标题/);
  assert.match(extracted, /DOCX 真二进制输出验收/);
  assert.match(extracted, /第一项/);
  assert.match(extracted, /第二项/);
  assert.doesNotMatch(extracted, /<script\b/i);
  assert.ok(result.bytes.length <= SIXTEEN_MIB);
});

test('document-formats: PDF output has a signature, EOF marker, and a readable Chinese text layer', async () => {
  const content = `${longPdfMarkdown()}\n\n末页结束标记 END-OF-PDF-TAIL-42`;
  const result = await renderDocument({ filename: '报告.pdf', content, title: 'PDF 报告' });

  assert.ok(Buffer.isBuffer(result.bytes));
  assert.match(result.bytes.subarray(0, 8).toString('latin1'), /^%PDF-/);
  assert.match(result.bytes.toString('latin1'), /%%EOF\s*$/);
  assert.equal(result.format, 'pdf');
  assert.equal(result.mime, MIME_TYPES.pdf);
  assert.ok(result.bytes.length <= SIXTEEN_MIB);

  const parsed = await parseDocument({
    filename: 'roundtrip.pdf',
    contentBase64: result.bytes.toString('base64'),
  });
  assert.equal(parsed.ok, true);
  assert.match(parsed.text, /中文字体与真实文字层验收/);
  assert.match(parsed.text, /按顺序读取/);
  assert.match(parsed.text, /Fork Chat/, 'PDF text layer must preserve ASCII source text as well as CJK');
  assert.match(parsed.text, /第 1 段/, 'PDF text layer must preserve numeric source text');
  assert.match(parsed.text, /末页结束标记 END-OF-PDF-TAIL-42/, 'PDF text layer must preserve the final-page tail marker');
});

test('document-formats: every generated format returns bounded preview metadata', async () => {
  const content = '# 标题\n\n' + '内容 '.repeat(400);
  for (const [format, extension] of [['md', 'md'], ['html', 'html'], ['docx', 'docx'], ['pdf', 'pdf']]) {
    const result = await renderDocument({ filename: `bounded.${extension}`, format, content });
    assert.equal(result.format, format);
    assert.equal(result.name, `bounded.${extension}`);
    assert.equal(result.mime, MIME_TYPES[format]);
    assert.ok(result.preview.length <= 800, `${format} preview must be <= 800 characters`);
    assert.ok(result.bytes.length > 0);
    assert.ok(result.bytes.length <= SIXTEEN_MIB, `${format} output must stay under 16 MiB`);
    assertSafeHtml(result.previewHtml);
  }
});
