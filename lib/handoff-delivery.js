/**
 * 分支交接的私有临时交付目录。
 *
 * 每次 stage 前把一份产物或归档正文写到 App 私有盘，只把服务端生成的路径交给 host.stage；
 * 路径不出现在 HTTP/action/日志里。名字只接受 32 位 artifactId 或固定 context.md，
 * 不接收任意路径或保留名称；读写与同步都走注入 fs。
 *
 * 目录安全：dataDir 是平台给定的可信锚点，只核对它是真实目录（不改它的权限）；
 * handoff-delivery/owner/action 三级由本模块自己创建，逐级 mkdir+lstat，拒绝符号链接，
 * 已有目录必须是 0700，否则拒绝而不是 chmod。写入与清理都要先过自有的私有树校验：
 * 清理只用非创建型 validateHelperTree，绝不为了删除而重建目录。
 */
import { constants } from 'node:fs';
import realFs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const ACTION_ID = /^ha_[a-f0-9]{32}$/;
const ARTIFACT_ID = /^[a-f0-9]{32}$/;
const ARCHIVE_NAME = 'context.md';
const HELPER_ROOT = 'handoff-delivery';
const HELPER_MODE = 0o700;
const FILE_MODE = 0o600;
const NO_FOLLOW = constants.O_NOFOLLOW || 0;

export const HANDOFF_DELIVERY_ARCHIVE_NAME = ARCHIVE_NAME;

function deliveryError(message) {
  const error = new Error(message);
  error.code = 'HANDOFF_DELIVERY_FAILED';
  return error;
}

function isDeliveryError(error) {
  return error?.code === 'HANDOFF_DELIVERY_FAILED';
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

  function validateActionId(actionId) {
    if (typeof actionId !== 'string' || !ACTION_ID.test(actionId)) throw deliveryError('动作标识无效');
    return actionId;
  }

  function dirFor(owner, actionId) {
    validateActionId(actionId);
    return path.join(dataDir, HELPER_ROOT, ownerKey(owner), actionId);
  }

  /** 只核对真实目录；不跟随链接，也不改它自己的权限 */
  async function requireRealDir(dir, label) {
    let stat;
    try {
      stat = await fs.lstat(dir);
    } catch {
      throw deliveryError(`${label}不可用`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw deliveryError(`${label}不安全`);
    return stat;
  }

  /** 本模块自己拥有的三级目录：逐级创建，必须是 0700 真实目录 */
  async function ensureHelperDir(dir, label) {
    let stat = null;
    try {
      await fs.mkdir(dir, { mode: HELPER_MODE });
      stat = await fs.lstat(dir);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw deliveryError(`${label}创建失败`);
    }
    if (!stat) {
      stat = await requireRealDir(dir, label);
      // 已存在的目录不做“修正”，权限不是 0700 就拒绝
      if ((stat.mode & 0o777) !== HELPER_MODE) throw deliveryError(`${label}权限不安全`);
      return dir;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw deliveryError(`${label}不安全`);
    if ((stat.mode & 0o777) !== HELPER_MODE) throw deliveryError(`${label}权限不安全`);
    return dir;
  }

  async function prepareTree(owner, actionId) {
    // 祖先逐级检查：任何一级是链接都直接拒绝，不用递归 mkdir 跟随
    await requireRealDir(dataDir, '数据目录');
    await ensureHelperDir(path.join(dataDir, HELPER_ROOT), '交付根目录');
    await ensureHelperDir(path.join(dataDir, HELPER_ROOT, ownerKey(owner)), '交付所有者目录');
    return ensureHelperDir(dirFor(owner, actionId), '交付动作目录');
  }

  /** 只核对已存在的 helper 目录：真实目录且 0700；缺失/链接/权限不符一律拒绝，不 mkdir、不 chmod */
  async function statHelperDir(dir, label, { allowMissing = false } = {}) {
    let stat;
    try {
      stat = await fs.lstat(dir);
    } catch {
      if (allowMissing) return null;
      throw deliveryError(`${label}不可用`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw deliveryError(`${label}不安全`);
    if ((stat.mode & 0o777) !== HELPER_MODE) throw deliveryError(`${label}权限不安全`);
    return stat;
  }

  /**
   * 非创建型校验：清理（unlink/rmdir）之前逐级核对 dataDir→root→owner→action。
   * dataDir 只要求真实非链接目录（平台给定，不改它的权限）；三级 helper 必须真实、非链接、0700。
   * 返回 null 只在 allowMissingAction 且安全 root/owner 下的 action 已不在时（不重建）。
   */
  async function validateHelperTree(owner, actionId, { allowMissingAction = false } = {}) {
    await requireRealDir(dataDir, '数据目录');
    const root = path.join(dataDir, HELPER_ROOT);
    await statHelperDir(root, '交付根目录');
    const ownerDir = path.join(root, ownerKey(owner));
    await statHelperDir(ownerDir, '交付所有者目录');
    const actionDir = path.join(ownerDir, validateActionId(actionId));
    return statHelperDir(actionDir, '交付动作目录', { allowMissing: allowMissingAction });
  }

  async function syncDir(dir) {
    let handle;
    try {
      handle = await fs.open(dir, constants.O_RDONLY | NO_FOLLOW);
      await handle.sync();
    } catch {
      throw deliveryError('临时目录同步失败');
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /** 调用方已通过 prepareTree 校验过目录；这里只做文件级写盘 */
  async function writeAtomic(dir, name, bytes) {
    const target = path.join(dir, name);
    const tmp = path.join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
    let handle;
    try {
      handle = await fs.open(
        tmp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        FILE_MODE,
      );
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.unlink(tmp).catch(() => {});
      if (isDeliveryError(error)) throw error;
      throw deliveryError('临时文件写入失败');
    }
    try {
      await handle.close();
    } catch {
      await fs.unlink(tmp).catch(() => {});
      throw deliveryError('临时文件写入失败');
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
    const dir = await prepareTree(owner, actionId);
    return writeAtomic(dir, fileName(undefined, artifactId), bytes);
  }

  async function writeArchive({ owner, actionId, text }) {
    if (typeof text !== 'string' || text.length === 0) throw deliveryError('归档正文无效');
    const dir = await prepareTree(owner, actionId);
    return writeAtomic(dir, fileName(ARCHIVE_NAME), Buffer.from(text, 'utf8'));
  }

  async function remove({ owner, actionId, name, artifactId }) {
    const dir = dirFor(owner, actionId);
    const file = path.join(dir, fileName(name, artifactId));
    // 只删自己校验过的私有树：所有检查都在 unlink 之前
    await validateHelperTree(owner, actionId);
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
    // 安全 root/owner 下 action 已不在：无副作用返回，不重建
    const safe = await validateHelperTree(owner, actionId, { allowMissingAction: true });
    if (!safe) return;
    try {
      await fs.rmdir(dir);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      if (error?.code === 'ENOTEMPTY') throw deliveryError('临时目录尚未清空');
      throw deliveryError('临时目录删除失败');
    }
    try {
      await requireRealDir(parent, '交付所有者目录');
      await syncDir(parent);
    } catch (error) {
      if (isDeliveryError(error)) throw error;
      throw deliveryError('临时目录父同步失败');
    }
  }

  return { writeArtifact, writeArchive, remove, removeDir };
}
