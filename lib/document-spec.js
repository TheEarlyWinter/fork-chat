/** Bounded format-neutral document input. No filesystem, SDK, or model dependency. */
export const DOCUMENT_FORMATS = Object.freeze({
  md: 'text/markdown', html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf',
});
export const MAX_DOCUMENT_INPUT_BYTES = 2 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export function documentError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
export function normalizeDocumentInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw documentError('INVALID_DOCUMENT', '文档参数必须是对象');
  const { filename, content } = input;
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 120
    || /[\u0000-\u001f\u007f/\\]/.test(filename) || filename.startsWith('.') || filename !== filename.trim()) {
    throw documentError('INVALID_FILENAME', '文件名需为120字以内、不含路径的普通名称');
  }
  const extension = filename.split('.').at(-1).toLowerCase();
  const format = input.format === undefined ? extension : input.format;
  if (typeof format !== 'string' || !Object.hasOwn(DOCUMENT_FORMATS, format)) throw documentError('UNSUPPORTED_FORMAT', '仅支持 MD、HTML、DOCX、PDF');
  if (extension !== format) throw documentError('FORMAT_MISMATCH', '文件扩展名与目标格式不一致');
  if (typeof content !== 'string' || !content.trim()) throw documentError('INVALID_CONTENT', '文档内容不能为空');
  if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_INPUT_BYTES) throw documentError('DOCUMENT_TOO_LARGE', '文档源文超过2 MiB', 413);
  // Lone surrogates cannot round-trip through UTF-8. Reject instead of silently replacing text.
  if (!content.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)) throw documentError('INVALID_CONTENT', '文档包含不完整的 Unicode 或不支持的控制字符');
  const title = typeof input.title === 'string' ? input.title.slice(0, 200) : filename.replace(/\.[^.]+$/, '');
  if (!filename.isWellFormed() || !title.isWellFormed() || /[\u0000-\u001f\u007f]/.test(title)) throw documentError('INVALID_DOCUMENT', '文件名或标题包含无效字符');
  return { name: filename, filename, format, mime: DOCUMENT_FORMATS[format], content, title };
}

/** Small, explicit Markdown subset: headings, paragraphs, lists, fences and tables. */
export function parseDocumentBlocks(content) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  const push = block => {
    if (blocks.length >= 3000) throw documentError('DOCUMENT_COMPLEXITY', '文档结构超过3000块，请拆分生成', 413);
    blocks.push(block);
  };
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^\s*```/.test(line)) {
      const text = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) text.push(lines[i++]);
      if (i < lines.length) i++;
      push({ type: 'code', text: text.join('\n') }); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { push({ type: 'heading', level: heading[1].length, text: heading[2] }); i++; continue; }
    const list = /^\s*(?:([-*+])|\d+[.)])\s+(.+)$/.exec(line);
    if (list) { const number = Number.parseInt(line.trim(), 10); push({ type: 'list', ordered: !list[1], number: Number.isSafeInteger(number) ? number : 1, text: list[2] }); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const row = value => value.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
      const rows = [row(line)]; i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(row(lines[i++]));
      const columns = rows[0].length;
      if (columns > 20 || rows.length > 500) throw documentError('DOCUMENT_COMPLEXITY', '单张表格最多20列、500行', 413);
      push({ type: 'table', rows: rows.map(cells => Array.from({ length: columns }, (_, col) => cells[col] || '')) }); continue;
    }
    push({ type: 'paragraph', text: line }); i++;
  }
  return blocks;
}

export function documentRuns(text) {
  return String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map(part => (
    part.startsWith('**') && part.endsWith('**') ? { text: part.slice(2, -2), bold: true }
      : part.startsWith('`') && part.endsWith('`') ? { text: part.slice(1, -1), code: true }
        : { text: part }
  ));
}
export const escapeDocumentHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
