import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/**
 * 分块上传账本。
 *
 * 存在的理由：前端说多大不算数。所有上限都在服务端再算一遍，
 * 并且只有「走完 begin → writeChunk × N → 完成」这条路的文件，
 * 解析侧才认。不再接受一个任意 path —— 那等于谁都能让 App 把
 * 自己的配置文件当 PDF 发出去。
 *
 * 归属（owner）绑定到调用方：拿不到身份时退化成 "local"，
 * 至少不同 UI 会话之间不会互相读取对方的上传。
 */

export const UPLOAD_LIMITS = Object.freeze({
  /** 单块解码后的字节上限。前端按 6 MiB 切，这里留一倍余量 */
  maxChunkBytes: 12 * 1024 * 1024,
  /** 整个文件的上限。26 MB 的扫描件要能过 */
  maxTotalBytes: 200 * 1024 * 1024,
  maxChunks: 96,
  /** 同时进行中的上传数 */
  maxActiveUploads: 8,
  /** 未完成上传的存活时间 */
  ttlMs: 30 * 60 * 1000,
  /** 合并时的最终校验容差：不做模糊，必须一致 */
});

const UPLOAD_ID_RE = /^[a-f0-9]{16,64}$/;
const SAFE_EXT_RE = /^\.[a-z0-9]{1,8}$/;

function hashOwner(value) {
  const raw = String(value || "").trim();
  if (!raw) return "local";
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function createUploadStore({ dataDir, logger }) {
  const root = path.join(dataDir, "uploads");
  /** uploadId → record */
  const uploads = new Map();

  async function ensureRoot() {
    await fs.mkdir(root, { recursive: true });
  }

  /** 真实路径必须落在 root 之内，且途中不经过符号链接 */
  async function assertInsideRoot(target) {
    const resolvedRoot = await fs.realpath(root).catch(() => root);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(resolvedRoot + path.sep)) {
      throw new Error("上传路径越界");
    }
    // 文件已存在时，用 lstat 确认它不是符号链接
    const stat = await fs.lstat(resolved).catch(() => null);
    if (stat?.isSymbolicLink()) throw new Error("上传路径是符号链接，已拒绝");
    return resolved;
  }

  function sweep() {
    const now = Date.now();
    for (const [id, record] of uploads) {
      if (record.done) continue;
      if (now - record.createdAt > UPLOAD_LIMITS.ttlMs) {
        uploads.delete(id);
        void cleanupParts(id, record.total);
      }
    }
  }

  async function cleanupParts(uploadId, total) {
    for (let i = 0; i < total; i += 1) {
      await fs.rm(path.join(root, `${uploadId}.part${i}`), { force: true }).catch(() => {});
    }
  }

  /**
   * 开始一次上传。
   * @returns {{ uploadId: string }}
   */
  function begin({ owner, filename, size, total }) {
    sweep();
    if (uploads.size >= UPLOAD_LIMITS.maxActiveUploads) {
      const stale = [...uploads.entries()].find(([, r]) => r.done && Date.now() - r.createdAt > 5 * 60 * 1000);
      if (stale) uploads.delete(stale[0]);
      else throw new Error("同时进行的上传过多，请稍后重试");
    }

    const totalChunks = Number(total);
    if (!Number.isInteger(totalChunks) || totalChunks < 1) throw new Error("分块总数无效");
    if (totalChunks > UPLOAD_LIMITS.maxChunks) throw new Error(`分块数超过上限（${UPLOAD_LIMITS.maxChunks}）`);

    const declared = Number(size);
    if (Number.isFinite(declared) && declared > UPLOAD_LIMITS.maxTotalBytes) {
      throw new Error(`文件超过 ${Math.round(UPLOAD_LIMITS.maxTotalBytes / 1048576)} MB 上限`);
    }

    const ext = path.extname(String(filename || "")).toLowerCase();
    const safeExt = SAFE_EXT_RE.test(ext) ? ext : ".bin";
    const uploadId = randomUUID().replace(/-/g, "");

    uploads.set(uploadId, {
      uploadId,
      owner: hashOwner(owner),
      filename: String(filename || "document").slice(0, 200),
      ext: safeExt,
      total: totalChunks,
      declaredSize: Number.isFinite(declared) ? declared : null,
      received: 0,
      receivedBytes: 0,
      seen: new Set(),
      createdAt: Date.now(),
      done: false,
      filePath: null,
      size: 0,
    });
    void ensureRoot();
    logger?.info?.(`[upload] 开始 ${uploadId.slice(0, 8)} · ${totalChunks} 块 · ${filename}`);
    return { uploadId };
  }

  /**
   * 写入一块。重复块（同一 index）直接拒绝，乱序允许但必须补齐。
   * @returns {Promise<{ uploadId: string, received: number, total: number, done: boolean, size?: number }>}
   */
  async function writeChunk({ uploadId, owner, index, buffer }) {
    const record = uploads.get(uploadId);
    if (!record) throw new Error("上传会话不存在或已过期");
    if (record.owner !== hashOwner(owner)) throw new Error("无权写入该上传会话");
    if (record.done) throw new Error("该上传已完成");

    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= record.total) throw new Error("分块序号越界");
    if (!buffer?.length) throw new Error("分块内容为空");
    if (buffer.length > UPLOAD_LIMITS.maxChunkBytes) {
      throw new Error(`单块超过 ${Math.round(UPLOAD_LIMITS.maxChunkBytes / 1048576)} MB 上限`);
    }
    if (record.seen.has(idx)) throw new Error(`分块 ${idx} 重复上传`);

    record.receivedBytes += buffer.length;
    if (record.receivedBytes > UPLOAD_LIMITS.maxTotalBytes) {
      throw new Error(`累计体积超过 ${Math.round(UPLOAD_LIMITS.maxTotalBytes / 1048576)} MB 上限`);
    }

    await ensureRoot();
    const partPath = path.join(root, `${uploadId}.part${idx}`);
    await fs.writeFile(partPath, buffer);
    record.seen.add(idx);
    record.received += 1;

    if (record.received < record.total) {
      return { uploadId, received: record.received, total: record.total, done: false };
    }

    // 全部到齐：按序合并，校验完整性后原子改名
    const parts = [];
    for (let i = 0; i < record.total; i += 1) {
      if (!record.seen.has(i)) throw new Error(`缺少分块 ${i}`);
      parts.push(await fs.readFile(path.join(root, `${uploadId}.part${i}`)));
    }
    const merged = Buffer.concat(parts);
    if (merged.length > UPLOAD_LIMITS.maxTotalBytes) throw new Error("合并后体积超过上限");
    if (record.declaredSize !== null && merged.length !== record.declaredSize) {
      throw new Error(`文件长度不符：声明 ${record.declaredSize}，实际 ${merged.length}`);
    }

    const finalPath = path.join(root, `${uploadId}${record.ext}`);
    const tmpPath = `${finalPath}.tmp`;
    await fs.writeFile(tmpPath, merged);
    await assertInsideRoot(tmpPath);
    await fs.rename(tmpPath, finalPath);
    await cleanupParts(uploadId, record.total);

    record.done = true;
    record.filePath = finalPath;
    record.size = merged.length;
    logger?.info?.(`[upload] 完成 ${uploadId.slice(0, 8)} · ${(merged.length / 1048576).toFixed(2)} MB`);
    return { uploadId, received: record.received, total: record.total, done: true, size: merged.length };
  }

  /**
   * 解析侧取文件：只有已完成的、属于调用者的上传才放行。
   * @returns {Promise<{ filePath: string, filename: string, size: number } | null>}
   */
  async function resolve({ uploadId, owner }) {
    if (!UPLOAD_ID_RE.test(String(uploadId || ""))) return null;
    const record = uploads.get(String(uploadId));
    if (!record) return null;
    if (record.owner !== hashOwner(owner)) return null;
    if (!record.done) return null;
    const resolved = await assertInsideRoot(record.filePath).catch(() => null);
    if (!resolved) return null;
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isFile()) return null;
    return { filePath: resolved, filename: record.filename, size: stat.size };
  }

  /** 解析完就删，别让扫描件在磁盘上越堆越多 */
  async function release({ uploadId }) {
    const record = uploads.get(String(uploadId));
    if (!record) return;
    uploads.delete(String(uploadId));
    if (record.filePath) await fs.rm(record.filePath, { force: true }).catch(() => {});
  }

  return { begin, writeChunk, resolve, release, sweep, _uploads: uploads };
}
