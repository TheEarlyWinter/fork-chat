import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { privateDirectory, exclusiveFile, readCheckedFile, checkedPath } from './file-safety.js';
import { MAX_ARTIFACT_BYTES, documentError } from './document-spec.js';
const ID = /^[a-f0-9]{32}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireOwner = owner => {
  if (typeof owner !== 'string' || !owner || owner.length > 2000) throw documentError('ARTIFACT_FORBIDDEN', '缺少文件所有者身份', 403);
  return hash(owner);
};
/** Immutable per-owner artifacts. Atomic manifest publication is the commit point. */
export function createArtifactStore({ dataDir }) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('artifact store requires dataDir');
  async function bucket(owner) {
    const ownerKey = requireOwner(owner);
    const root = await privateDirectory(dataDir, 'artifacts');
    return privateDirectory(root, ownerKey);
  }
  async function publish({ owner, cardId, requestId, rendered, signal, origin = 'generated' }) {
    signal?.throwIfAborted();
    if (!Buffer.isBuffer(rendered.bytes) || !rendered.bytes.length || rendered.bytes.length > MAX_ARTIFACT_BYTES) throw documentError('DOCUMENT_TOO_LARGE', '文件超过16 MiB或为空', 413);
    const root = await bucket(owner);
    const artifactId = randomUUID().replaceAll('-', '');
    const dir = path.join(root, artifactId);
    await fs.mkdir(dir, { mode: 0o700 });
    const metadata = { artifactId, name: rendered.name, format: rendered.format, mime: rendered.mime,
      bytes: rendered.bytes.length, sha256: hash(rendered.bytes), createdAt: new Date().toISOString(),
      cardId: typeof cardId === 'string' ? cardId.slice(0, 100) : '', requestId: typeof requestId === 'string' ? requestId.slice(0, 100) : '',
      preview: String(rendered.preview || '').slice(0, 800), status: 'ready', origin: origin === 'imported' ? 'imported' : 'generated' };
    let committed = false;
    try {
      for (const [name, bytes] of [['document.bin', rendered.bytes], ['preview.html', Buffer.from(rendered.previewHtml || '', 'utf8')]]) {
        signal?.throwIfAborted();
        const file = await exclusiveFile(dir, name);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      }
      signal?.throwIfAborted();
      const record = { schemaVersion: 1, metadata, previewSha256: hash(Buffer.from(rendered.previewHtml || '', 'utf8')) };
      const file = await exclusiveFile(dir, 'manifest.pending');
      try { await file.writeFile(JSON.stringify({ ...record, recordSha256: hash(JSON.stringify(record)) }), 'utf8'); await file.sync(); } finally { await file.close(); }
      signal?.throwIfAborted();
      await checkedPath(root, dir);
      await fs.rename(path.join(dir, 'manifest.pending'), path.join(dir, 'manifest.json'));
      committed = true;
      return metadata;
    } finally {
      // Only this unpublished UUID may be removed; never roll back another successful export.
      if (!committed) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  async function read({ owner, artifactId }) {
    if (typeof artifactId !== 'string' || !ID.test(artifactId)) throw documentError('INVALID_ARTIFACT_ID', '文件标识无效');
    const root = await bucket(owner);
    const dir = path.join(root, artifactId);
    try {
      const record = JSON.parse((await readCheckedFile(root, path.join(dir, 'manifest.json'), 16384)).toString('utf8'));
      const { recordSha256, ...payload } = record;
      if (recordSha256 !== hash(JSON.stringify(payload))) throw new Error('文件记录校验失败');
      const metadata = record.metadata;
      if (record.schemaVersion !== 1 || metadata?.artifactId !== artifactId || metadata?.status !== 'ready') throw new Error('文件记录无效');
      const bytes = await readCheckedFile(root, path.join(dir, 'document.bin'), MAX_ARTIFACT_BYTES);
      const preview = await readCheckedFile(root, path.join(dir, 'preview.html'), 24 * 1024 * 1024);
      if (metadata.bytes !== bytes.length || metadata.sha256 !== hash(bytes) || record.previewSha256 !== hash(preview)) throw new Error('文件内容校验失败');
      return { metadata, bytes, previewHtml: preview.toString('utf8') };
    } catch (error) {
      // Missing and foreign-owner ids deliberately have the same public result.
      if (error?.code === 'ENOENT') throw documentError('ARTIFACT_NOT_FOUND', '文件不存在或不属于当前调用方', 404);
      throw documentError('ARTIFACT_CORRUPT', '文件损坏、被修改或资源路径不安全', 409);
    }
  }
  return { publish, read };
}
