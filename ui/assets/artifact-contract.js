/** JSON-only public artifact receipt; binary bytes, paths and credentials never enter snapshots. */
export const ARTIFACT_MIMES = Object.freeze({ md: 'text/markdown', html: 'text/html', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf' });
export function normalizeArtifactMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !/^[a-f0-9]{32}$/.test(value.artifactId || '') || value.status !== 'ready'
    || !Object.hasOwn(ARTIFACT_MIMES, value.format) || value.mime !== ARTIFACT_MIMES[value.format]
    || typeof value.name !== 'string' || !value.name || value.name.length > 120 || /[\u0000-\u001f\u007f/\\]/.test(value.name)
    || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > 16 * 1024 * 1024
    || !/^[a-f0-9]{64}$/.test(value.sha256 || '') || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return null;
  return { artifactId: value.artifactId, status: 'ready', name: value.name, mime: value.mime, format: value.format,
    bytes: value.bytes, sha256: value.sha256, createdAt: value.createdAt.slice(0, 40),
    cardId: typeof value.cardId === 'string' ? value.cardId.slice(0, 100) : '', requestId: typeof value.requestId === 'string' ? value.requestId.slice(0, 100) : '',
    preview: typeof value.preview === 'string' ? value.preview.slice(0, 800) : '',
    origin: value.origin === 'imported' ? 'imported' : 'generated' };
}
export function normalizeArtifactList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, 20).map(normalizeArtifactMetadata).filter(item => item && !seen.has(item.artifactId) && seen.add(item.artifactId));
}
