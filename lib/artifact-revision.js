import { documentError } from './document-spec.js';

/** Maximum number of versions in one ancestry path, including the new version. */
export const MAX_REVISION_DEPTH = 8;
export const REVISION_SOURCE_NOTICES = Object.freeze({
  text: '基于旧文本生成修订版。',
  'preview-text': '基于旧预览正文进行内容级重写，不保留原 Word/PDF 版式、分页或样式。',
  'preview-excerpt': '仅基于旧预览摘要进行内容级重写，可能不含全文，不保留原 Word/PDF 版式、分页或样式。',
});
const ID = /^[a-f0-9]{32}$/;
const corrupt = () => documentError('DOCUMENT_REVISION_CORRUPT', '文档版本链无效、循环或不一致，未生成修订版', 409);

/** Owner-scoped, bounded traversal. All public lineage is derived, never accepted from a tool. */
export async function resolveArtifactRevision({ read, owner, baseArtifactId, signal }) {
  if (typeof read !== 'function') throw new TypeError('revision resolution requires read');
  if (typeof owner !== 'string' || !owner.trim() || owner.length > 2000) throw documentError('ARTIFACT_FORBIDDEN', '缺少可信文件所有者身份', 403);
  if (typeof baseArtifactId !== 'string' || !ID.test(baseArtifactId)) throw documentError('INVALID_ARTIFACT_ID', '文件标识无效');
  const seen = new Set(), chain = [];
  let id = baseArtifactId, base;
  for (;;) {
    signal?.throwIfAborted();
    if (seen.has(id)) throw corrupt();
    if (chain.length >= MAX_REVISION_DEPTH - 1) throw documentError('DOCUMENT_REVISION_LIMIT', '修订链最多8个版本，请另建文档', 409);
    seen.add(id);
    const record = await read({ owner, artifactId: id, signal });
    signal?.throwIfAborted();
    const metadata = record?.metadata;
    if (!metadata || metadata.artifactId !== id) throw corrupt();
    if (!base) base = record;
    chain.push(metadata);
    if (metadata.revisedFrom === undefined) break;
    if (typeof metadata.revisedFrom !== 'string' || !ID.test(metadata.revisedFrom)
      || !Number.isSafeInteger(metadata.version) || metadata.version < 2 || metadata.version > MAX_REVISION_DEPTH
      || typeof metadata.revisionRootId !== 'string' || !ID.test(metadata.revisionRootId)) throw corrupt();
    id = metadata.revisedFrom;
  }
  const root = chain.at(-1);
  if ((root.version !== undefined && root.version !== 1)
    || (root.revisionRootId !== undefined && root.revisionRootId !== root.artifactId)) throw corrupt();
  for (let i = 0; i < chain.length - 1; i++) {
    if (chain[i].version !== chain.length - i || chain[i].revisionRootId !== root.artifactId
      || chain[i].revisedFrom !== chain[i + 1].artifactId) throw corrupt();
  }
  return { base, lineage: { revisedFrom: baseArtifactId, revisionRootId: root.artifactId, version: chain.length + 1 } };
}
