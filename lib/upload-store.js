import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { privateDirectory, openCheckedFile, exclusiveFile, checkedPath } from './file-safety.js';

export const UPLOAD_LIMITS = Object.freeze({ maxChunkBytes: 12 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024, maxChunks: 96, maxActiveUploads: 8, ttlMs: 30 * 60 * 1000 });
const ID = /^[a-f0-9]{32}$/;
function ownerKey(owner) {
  if (typeof owner !== 'string' || !owner.trim()) throw new Error('缺少可信调用方身份');
  return createHash('sha256').update(owner).digest('hex');
}

export function createUploadStore({ dataDir, logger }) {
  const uploads = new Map(), locks = new Map();
  /**
   * 排队中的写块数。
   *
   * 每个排队闭包都握着一个已经解码好的 Buffer（单块可达 12 MiB），
   * 而 uploadId 是客户端随便给的 —— 同一个上传并发打几百个请求，
   * 检查全都在队列内部，内存早就先被占满了。
   * 所以要在入队之前（同步地）就把队列长度挡住。
   */
  const MAX_PENDING_WRITES = 24;
  let pendingWrites = 0;

  const serial = (id, action) => {
    if (pendingWrites >= MAX_PENDING_WRITES) {
      return Promise.reject(Object.assign(new Error('上传写入排队过多，请稍后重试'), { status: 429 }));
    }
    pendingWrites += 1;
    const work = (locks.get(id) || Promise.resolve()).catch(() => {}).then(action);
    locks.set(id, work);
    void work
      .finally(() => {
        pendingWrites -= 1;
        if (locks.get(id) === work) locks.delete(id);
      })
      .catch(() => {});
    return work;
  };
  async function cleanup(record) {
    // Never walk a replaced/symlinked upload directory during cleanup.
    const root = await privateDirectory(dataDir, 'uploads');
    for (const name of [...Array.from({ length: record.total }, (_, i) => `${record.uploadId}.part${i}`), `${record.uploadId}.tmp`, `${record.uploadId}${record.ext}`]) {
      await fs.rm(path.join(root, name), { force: true });
    }
  }
  function sweep() {
    for (const [id, record] of uploads) if (Date.now() - record.createdAt > UPLOAD_LIMITS.ttlMs && !record.claimed) {
      uploads.delete(id);
      void serial(id, () => cleanup(record)).catch(() => {});
    }
  }
  function begin({ owner, filename, size, total }) {
    const key = ownerKey(owner);
    sweep();
    if (uploads.size >= UPLOAD_LIMITS.maxActiveUploads) throw new Error('同时进行的上传过多');
    if (!Number.isInteger(Number(total)) || Number(total) < 1) throw new Error('分块总数无效');
    if (Number(total) > UPLOAD_LIMITS.maxChunks) throw new Error('分块数超过上限');
    const declared = size == null ? null : Number(size);
    if (declared !== null && (!Number.isSafeInteger(declared) || declared < 1 || declared > UPLOAD_LIMITS.maxTotalBytes)) throw new Error('声明的文件大小超过上限或无效');
    const ext = path.extname(String(filename || '')).toLowerCase();
    const uploadId = randomUUID().replaceAll('-', '');
    uploads.set(uploadId, { uploadId, owner: key, filename: path.basename(String(filename || 'document')).slice(0, 200), ext: /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.bin', total: Number(total), declaredSize: declared, createdAt: Date.now(), seen: new Set(), receivedBytes: 0, done: false, claimed: false, filePath: null });
    return { uploadId };
  }
  async function writeChunk(input) {
    return serial(input.uploadId, async () => {
      const { uploadId, owner, buffer } = input;
      const record = uploads.get(uploadId);
      if (!record) throw new Error('上传会话不存在或已过期');
      if (record.owner !== ownerKey(owner)) throw new Error('无权写入上传');
      if (record.done) throw new Error('该上传已完成');
      const index = Number(input.index);
      if (!Number.isInteger(index) || index < 0 || index >= record.total) throw new Error('分块序号越界');
      if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('分块内容为空');
      if (buffer.length > UPLOAD_LIMITS.maxChunkBytes) throw new Error('单块超过上限');
      if (record.seen.has(index)) throw new Error('重复上传分块');
      if (record.receivedBytes + buffer.length > UPLOAD_LIMITS.maxTotalBytes) throw new Error('累计体积超过上限');
      const root = await privateDirectory(dataDir, 'uploads');
      const part = await exclusiveFile(root, `${uploadId}.part${index}`);
      try { await part.writeFile(buffer); } finally { await part.close(); }
      record.seen.add(index);
      record.receivedBytes += buffer.length;
      if (record.seen.size < record.total) return { uploadId, received: record.seen.size, total: record.total, done: false };
      const tmp = await exclusiveFile(root, `${uploadId}.tmp`);
      const hash = createHash('sha256');
      let size = 0;
      try {
        for (let i = 0; i < record.total; i++) {
          if (!record.seen.has(i)) throw new Error('缺少分块');
          const file = await openCheckedFile(root, path.join(root, `${uploadId}.part${i}`), UPLOAD_LIMITS.maxChunkBytes);
          try {
            for await (const chunk of file.handle.createReadStream({ autoClose: false })) {
              size += chunk.length;
              if (size > UPLOAD_LIMITS.maxTotalBytes) throw new Error('合并体积超过上限');
              hash.update(chunk);
              await tmp.writeFile(chunk);
            }
          } finally { await file.handle.close(); }
        }
        if (size !== record.receivedBytes || (record.declaredSize !== null && size !== record.declaredSize)) throw new Error('文件长度不符');
        await tmp.sync();
      } catch (error) {
        uploads.delete(uploadId);
        await tmp.close();
        await cleanup(record).catch(() => {});
        throw error;
      }
      await tmp.close();
      await checkedPath(path.dirname(root), root);
      const final = path.join(root, `${uploadId}${record.ext}`);
      await fs.rename(path.join(root, `${uploadId}.tmp`), final);
      record.done = true; record.filePath = final; record.size = size; record.sha256 = hash.digest('hex');
      for (let i = 0; i < record.total; i++) await fs.rm(path.join(root, `${uploadId}.part${i}`), { force: true });
      logger?.info?.(`[upload] 完成 ${uploadId.slice(0, 8)} bytes=${size}`);
      return { uploadId, received: record.total, total: record.total, done: true, size };
    });
  }
  async function resolve({ uploadId, owner, claim = false }) {
    if (!ID.test(String(uploadId || ''))) return null;
    return serial(uploadId, async () => {
      const record = uploads.get(uploadId);
      if (!record || record.owner !== ownerKey(owner) || !record.done || record.claimed) return null;
      try {
        const root = await privateDirectory(dataDir, 'uploads');
        const file = await openCheckedFile(root, record.filePath, UPLOAD_LIMITS.maxTotalBytes);
        const size = file.size;
        await file.handle.close();
        if (size !== record.size) return null;
        if (claim) record.claimed = true;
        return { filePath: record.filePath, fileId: path.basename(record.filePath), filename: record.filename, size, sha256: record.sha256 };
      } catch { return null; }
    });
  }
  async function release({ uploadId }) {
    return serial(uploadId, async () => {
      const record = uploads.get(uploadId);
      if (!record) return;
      uploads.delete(uploadId);
      await cleanup(record);
    });
  }
  /**
   * 启动清扫：删掉上一次进程留下的、已经过期的上传碎片。
   *
   * 内存里的 uploads 随进程消失，磁盘上的 .partN 却留了下来。
   * 以前没有任何地方回收它们，重启一次就多一堆，跑久了上传目录会一直涨。
   */
  async function sweepOrphans({ now = Date.now() } = {}) {
    let root;
    try {
      root = await privateDirectory(dataDir, 'uploads');
    } catch {
      return { removed: 0 };
    }
    let names = [];
    try {
      names = await fs.readdir(root);
    } catch {
      return { removed: 0 };
    }
    const live = new Set();
    for (const record of uploads.values()) {
      live.add(`${record.uploadId}.tmp`);
      live.add(`${record.uploadId}${record.ext}`);
      for (let i = 0; i < record.total; i += 1) live.add(`${record.uploadId}.part${i}`);
    }
    let removed = 0;
    for (const name of names) {
      if (live.has(name)) continue;
      const target = path.join(root, name);
      try {
        const stat = await fs.stat(target);
        if (now - stat.mtimeMs <= UPLOAD_LIMITS.ttlMs) continue;
        await fs.rm(target, { force: true });
        removed += 1;
      } catch {}
    }
    if (removed) logger?.info?.(`[upload] 清理了 ${removed} 个过期上传碎片`);
    return { removed };
  }

  return { begin, writeChunk, resolve, release, sweep, sweepOrphans, _uploads: uploads };
}
