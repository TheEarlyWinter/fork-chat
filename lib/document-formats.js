/** Format facade. Storage, HTTP, UI and model orchestration do not live here. */
import { DOCUMENT_FORMATS, normalizeDocumentInput, parseDocumentBlocks, MAX_ARTIFACT_BYTES, documentError } from './document-spec.js';
import { renderDocumentHtml, renderDocumentHtmlFragment } from './document-html.js';
export { DOCUMENT_FORMATS, normalizeDocumentInput } from './document-spec.js';
export async function renderDocument(input, { signal } = {}) {
  signal?.throwIfAborted();
  const document = normalizeDocumentInput(input);
  const blocks = parseDocumentBlocks(document.content);
  const previewHtml = renderDocumentHtmlFragment(blocks);
  let bytes;
  if (document.format === 'md') bytes = Buffer.from(document.content, 'utf8');
  else if (document.format === 'html') bytes = Buffer.from(renderDocumentHtml(document.title, blocks), 'utf8');
  else if (document.format === 'docx') bytes = await (await import('./document-docx.js')).renderDocxDocument(document.title, blocks);
  else bytes = await (await import('./document-pdf.js')).renderPdfDocument(document.title, blocks, MAX_ARTIFACT_BYTES);
  signal?.throwIfAborted();
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (!bytes.length || bytes.length > MAX_ARTIFACT_BYTES) throw documentError('DOCUMENT_TOO_LARGE', '生成文件为空或超过16 MiB', 413);
  return { name: document.name, format: document.format, mime: DOCUMENT_FORMATS[document.format], bytes, preview: document.content.slice(0, 800), previewHtml };
}
