/** JSON-only public artifact receipt; binary bytes, paths and credentials never enter snapshots. */
export const ARTIFACT_MIMES = Object.freeze({ md: 'text/markdown', html: 'text/html', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf' });
const REVISION_NOTICES = Object.freeze({
  text: '基于旧文本生成修订版。',
  'preview-text': '基于旧预览正文进行内容级重写，不保留原 Word/PDF 版式、分页或样式。',
  'preview-excerpt': '仅基于旧预览摘要进行内容级重写，可能不含全文，不保留原 Word/PDF 版式、分页或样式。',
});
/** Optional public fields only: defaults are interpreted by the view, not added to old receipts. */
export function normalizeArtifactRevisionFields(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.revisedFrom === undefined) {
    if (value.version !== undefined && value.version !== 1 || value.revisionRootId !== undefined && value.revisionRootId !== value.artifactId) return null;
    return {};
  }
  if (typeof value.revisedFrom !== 'string' || !/^[a-f0-9]{32}$/.test(value.revisedFrom) || value.revisedFrom === value.artifactId
    || typeof value.revisionRootId !== 'string' || !/^[a-f0-9]{32}$/.test(value.revisionRootId) || value.revisionRootId === value.artifactId
    || !Number.isSafeInteger(value.version) || value.version < 2 || value.version > 8
    || (value.version === 2) !== (value.revisedFrom === value.revisionRootId)
    || value.revisionSource !== undefined && !Object.hasOwn(REVISION_NOTICES, value.revisionSource)) return null;
  return { revisedFrom: value.revisedFrom, version: value.version, revisionRootId: value.revisionRootId,
    ...(value.revisionSource === undefined ? {} : { revisionSource: value.revisionSource, revisionNotice: REVISION_NOTICES[value.revisionSource] }) };
}
export function normalizeArtifactMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !/^[a-f0-9]{32}$/.test(value.artifactId || '') || value.status !== 'ready'
    || !Object.hasOwn(ARTIFACT_MIMES, value.format) || value.mime !== ARTIFACT_MIMES[value.format]
    || typeof value.name !== 'string' || !value.name || value.name.length > 120 || /[\u0000-\u001f\u007f/\\]/.test(value.name)
    || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > 16 * 1024 * 1024
    || !/^[a-f0-9]{64}$/.test(value.sha256 || '') || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return null;
  const revision = normalizeArtifactRevisionFields(value);
  if (!revision) return null;
  return { artifactId: value.artifactId, status: 'ready', name: value.name, mime: value.mime, format: value.format,
    bytes: value.bytes, sha256: value.sha256, createdAt: value.createdAt.slice(0, 40),
    cardId: typeof value.cardId === 'string' ? value.cardId.slice(0, 100) : '', requestId: typeof value.requestId === 'string' ? value.requestId.slice(0, 100) : '',
    preview: typeof value.preview === 'string' ? value.preview.slice(0, 800) : '',
    origin: value.origin === 'imported' ? 'imported' : 'generated', ...revision };
}
export function normalizeArtifactList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, 20).map(normalizeArtifactMetadata).filter(item => item && !seen.has(item.artifactId) && seen.add(item.artifactId));
}
