/**
 * 分支交接的私有临时交付目录。
 *
 * 每次 stage 前把一份产物或归档正文写到 App 私有盘，只把服务端生成的路径交给 host.stage；
 * 路径不出现在 HTTP/action/日志里。名字只接受 32 位 artifactId 或固定 context.md，
 * 不接收任意路径或保留名称；读写与同步都走注入 fs，最终组件拒绝符号链接。
 */
import { constants } from 'node:fs';
import realFs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const ACTION_ID = /^ha_[a-f0-9]{32}$/;
const ARTIFACT_ID = /^[a-f0-9]{32}$/;
const ARCHIVE_NAME = 'context.md';

export const HANDOFF_DELIVERY_ARCHIVE_NAME = ARCHIVE_NAME;

function deliveryError(message) {
  const error = new Error(message);
  error.code = 'HANDOFF_DELIVERY_FAILED';
  return error;
}

export function createHandoffDelivery({ dataDir, fs = realFs } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('createHandoffDelivery 需要 dataDir');
  if (!fs || typeof fs.open !== 'function') throw new TypeError('createHandoffDelivery 需要注入 fs');

  function ownerKey(owner) {
    if (typeof owner !== 'string' || !owner || owner.length > 2000) throw deliveryError('临时交付所有者无效');
    return createHash('sha256').update(owner).digest('hex');
  }

  function fileName(name, artifactId) {
    if (artifactId !== undefined) {
      if (typeof artifactId !== 'string' || !ARTIFACT_ID.test(artifactId)) throw deliveryError('产物标识无效');
      return `${artifactId}.bin`;
    }
    if (name !== ARCHIVE_NAME) throw deliveryError('交付文件名无效');
    return ARCHIVE_NAME;
  }

  function dirFor(owner, actionId) {
    if (typeof actionId !== 'string' || !ACTION_ID.test(actionId)) throw deliveryError('动作标识无效');
    return path.join(dataDir, 'handoff-delivery', ownerKey(owner), actionId);
  }

  async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw deliveryError('临时目录不安全');
  }

  async function syncDir(dir) {
    let handle;
    try {
      handle = await fs.open(dir, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      await handle.sync();
    } catch {
      throw deliveryError('临时目录同步失败');
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function writeAtomic(dir, name, bytes) {
    await ensureDir(dir);
    const target = path.join(dir, name);
    const tmp = path.join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
    let handle;
    try {
      handle = await fs.open(tmp, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } catch {
      throw deliveryError('临时文件写入失败');
    } finally {
      await handle?.close().catch(() => {});
    }
    try {
      await fs.rename(tmp, target);
      await syncDir(dir);
    } catch {
      await fs.unlink(tmp).catch(() => {});
      throw deliveryError('临时文件提交失败');
    }
    return target;
  }

  async function writeArtifact({ owner, actionId, artifactId, bytes }) {
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw deliveryError('产物内容无效');
    const dir = dirFor(owner, actionId);
    return writeAtomic(dir, fileName(undefined, artifactId), bytes);
  }

  async function writeArchive({ owner, actionId, text }) {
    if (typeof text !== 'string' || text.length === 0) throw deliveryError('归档正文无效');
    const dir = dirFor(owner, actionId);
    return writeAtomic(dir, fileName(ARCHIVE_NAME), Buffer.from(text, 'utf8'));
  }

  async function remove({ owner, actionId, name, artifactId }) {
    const dir = dirFor(owner, actionId);
    const file = path.join(dir, fileName(name, artifactId));
    try {
      await fs.unlink(file);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw deliveryError('临时文件删除失败');
    }
    await syncDir(dir);
  }

  /** 只对自己 action 的交付目录 rmdir；非空/丢失都不当场重建 */
  async function removeDir({ owner, actionId }) {
    const dir = dirFor(owner, actionId);
    const parent = path.dirname(dir);
    try {
      await fs.rmdir(dir);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      if (error?.code === 'ENOTEMPTY') throw deliveryError('临时目录尚未清空');
      throw deliveryError('临时目录删除失败');
    }
    try {
      const stat = await fs.lstat(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw deliveryError('临时目录不安全');
      await syncDir(parent);
    } catch (error) {
      if (error?.name === 'HandoffError' || error?.code === 'HANDOFF_DELIVERY_FAILED') throw error;
      throw deliveryError('临时目录父同步失败');
    }
  }

  return { writeArtifact, writeArchive, remove, removeDir };
}
