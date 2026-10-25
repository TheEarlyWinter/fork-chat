/**
 * 分支交接 Store 的持久化小工具：durable IO、slot 预约、decision token。
 *
 * 只使用注入的 node:fs/promises 同形对象，因此测试可以把 fsync/open 换成故障注入版；
 * 这里不 import 固定真实 fs，也不做递归删除。
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import path from 'node:path';
import { handoffError } from '../ui/assets/fork-handoff-contract.js';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;
export const SLOT_COUNT = 32;
export const MAX_SLOT_FILE_BYTES = 4096;
export const ACTION_ID_PATTERN = /^ha_[a-f0-9]{32}$/;

export const HANDOFF_STORE_ERROR_CODES = Object.freeze({
  INVALID_OWNER: 'HANDOFF_INVALID_OWNER',
  INVALID_ACTION_ID: 'HANDOFF_INVALID_ACTION_ID',
  INVALID_CONTEXT: 'HANDOFF_INVALID_CONTEXT',
  INVALID_ARTIFACT: 'HANDOFF_INVALID_ARTIFACT',
  QUOTA_EXCEEDED: 'HANDOFF_QUOTA_EXCEEDED',
  STORE_CORRUPT: 'HANDOFF_STORE_CORRUPT',
  STORE_IO: 'HANDOFF_STORE_IO',
  DECISION_LOST: 'HANDOFF_DECISION_LOST',
  CHECKPOINT_DENIED: 'HANDOFF_CHECKPOINT_DENIED',
  INVALID_STATE: 'HANDOFF_INVALID_STATE',
  PAYLOAD_CORRUPT: 'HANDOFF_PAYLOAD_CORRUPT',
  ACTION_EXPIRED: 'HANDOFF_ACTION_EXPIRED',
});

export function storeError(code, message, details) {
  return handoffError(code, message, details);
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function ownerKey(owner) {
  return sha256Hex(owner);
}

export function newNonce() {
  return randomBytes(16).toString('hex');
}

export function isMissing(error) {
  return error?.code === 'ENOENT';
}

function ioError(cause) {
  const error = storeError(HANDOFF_STORE_ERROR_CODES.STORE_IO, '本地存储写入或同步失败');
  if (cause) error.cause = cause;
  return error;
}

function corrupt(message) {
  return storeError(HANDOFF_STORE_ERROR_CODES.STORE_CORRUPT, message);
}

/** 路径只能由本模块拼出来：拒绝 owner/actionId 里的分隔符与点段 */
export function safeJoin(base, ...pieces) {
  for (const piece of pieces) {
    if (typeof piece !== 'string' || piece === '' || piece === '.' || piece === '..') throw corrupt('存储路径片段无效');
    if (piece.includes('/') || piece.includes('\\') || piece.includes('\0')) throw corrupt('存储路径片段无效');
  }
  return path.join(base, ...pieces);
}

export async function ensureDir(fs, dir, { recursive = false } = {}) {
  try {
    await fs.mkdir(dir, { recursive, mode: DIR_MODE });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw ioError();
  }
  return statDir(fs, dir);
}

export async function statDir(fs, dir) {
  let stat;
  try {
    stat = await fs.lstat(dir);
  } catch (error) {
    if (isMissing(error)) throw corrupt('存储目录缺失');
    throw ioError();
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw corrupt('存储目录不是普通目录');
  return stat;
}

async function statFile(fs, filePath) {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw ioError();
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw corrupt('存储文件不是普通文件');
  return stat;
}

export async function fileExists(fs, filePath) {
  return Boolean(await statFile(fs, filePath));
}

/** 读取私有文件：先打开拿 fd，再核对大小与类型，避免路径替换 */
export async function readFileChecked(fs, filePath, maxBytes = 32 * 1024 * 1024) {
  let handle;
  try {
    // 注入 fs 也必须走 O_NOFOLLOW：最终组件是符号链接就拒绝，不跟过去
    handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (isMissing(error)) throw error;
    if (error?.code === 'ELOOP') throw corrupt('拒绝符号链接');
    throw ioError();
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw corrupt('不是普通文件');
    if (stat.size > maxBytes) throw corrupt('文件超过读取上限');
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw corrupt('文件超过读取上限');
    return bytes;
  } catch (error) {
    if (error?.name === 'HandoffError') throw error;
    throw ioError();
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function readJsonFile(fs, filePath, maxBytes) {
  const bytes = await readFileChecked(fs, filePath, maxBytes);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw corrupt('存储记录不是有效 JSON');
  }
}

/** wx 写入 + fsync；EEXIST 原样抛出，由调用方决定竞争结果 */
export async function writeExclusive(fs, filePath, data, mode = FILE_MODE) {
  let handle;
  try {
    handle = await fs.open(filePath, 'wx', mode);
  } catch (error) {
    if (error?.code === 'EEXIST') throw error;
    throw ioError();
  }
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch {
    throw ioError();
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function syncDir(fs, dir) {
  let handle;
  try {
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw corrupt('待同步目录不是普通目录');
    handle = await fs.open(dir, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    await handle.sync();
  } catch (error) {
    if (error?.name === 'HandoffError') throw error;
    throw ioError(error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** 原子替换：临时文件 sync → rename → 目录 sync；任何一步失败都不算提交 */
export async function writeFileAtomic(fs, dir, name, data) {
  const tmp = safeJoin(dir, `${name}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeExclusive(fs, tmp, data);
    try {
      await fs.rename(tmp, safeJoin(dir, name));
    } catch {
      throw ioError();
    }
    await syncDir(fs, dir);
  } catch (error) {
    await removeFile(fs, tmp);
    throw error;
  }
}

/** 删除文件：只有真正删掉了才返回 true；已不存在返回 false；其它错误仍抛 STORE_IO */
export async function removeFile(fs, filePath) {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (!isMissing(error)) throw ioError(error);
    return false;
  }
}

export async function removeEmptyDir(fs, dir) {
  try {
    await fs.rmdir(dir);
    return true;
  } catch (error) {
    if (isMissing(error) || error?.code === 'ENOTEMPTY') return false;
    throw ioError();
  }
}

export async function listDir(fs, dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw ioError();
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw corrupt('存储目录里有符号链接');
  }
  return entries;
}

/** 不可覆盖 decision：先创建者胜 */
export async function competeDecision(fs, filePath, decision) {
  try {
    await writeExclusive(fs, filePath, decision);
    return { won: true, existing: decision };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    // 已 EEXIST 却读不到 token，不能当成“别人赢了”继续冒充竞争结果
    const existing = (await readFileChecked(fs, filePath, 512)).toString('utf8');
    return { won: false, existing };
  }
}

export async function readDecision(fs, filePath) {
  try {
    return (await readFileChecked(fs, filePath, 512)).toString('utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Slot 预约：每 slot 一个独占目录，里面只有一个以 actionId 命名的预约文件
// ---------------------------------------------------------------------------

/**
 * 尝试占用一个空 slot。返回 null 表示 32 个都被占用。
 *
 * 已存在的 slot 目录一律跳过：它可能属于刚 mkdir 但还没写预约的活调用，
 * 观察为空就 rmdir/重建会抢走别人的槽。崩在 mkdir 后留下的空目录保守占位，不自动回收。
 * 半写/多文件 slot 由 readSlotUsage 判为损坏，这里不猜。
 */
export async function acquireSlot(fs, slotsDir, { actionId, payloadBytes, createdAt }) {
  await ensureDir(fs, slotsDir, { recursive: true });
  for (let index = 0; index < SLOT_COUNT; index += 1) {
    const dir = safeJoin(slotsDir, String(index));
    try {
      await fs.mkdir(dir, { mode: DIR_MODE });
    } catch (error) {
      // EEXIST 不能靠“观察为空”回收：另一个调用可能刚 mkdir 还没写 marker
      if (error?.code === 'EEXIST') continue;
      throw ioError(error);
    }
    const reservationPath = safeJoin(dir, `${actionId}.json`);
    try {
      await statDir(fs, dir);
      await writeExclusive(fs, reservationPath, JSON.stringify({ actionId, payloadBytes, createdAt }));
      await syncDir(fs, dir);
      await syncDir(fs, slotsDir);
      return { index, dir };
    } catch (error) {
      let cleanupFailure = null;
      try {
        // 只有真的删掉了自己的 marker 才有权移除目录；否则可能删掉新一代刚建的空 slot
        if (await removeFile(fs, reservationPath)) {
          if (await removeEmptyDir(fs, dir)) await syncDir(fs, slotsDir);
        }
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
      }
      if (cleanupFailure) {
        const safeError = storeError(
          HANDOFF_STORE_ERROR_CODES.STORE_IO,
          'slot 预约清理失败，已保留恢复线索',
        );
        safeError.cause = cleanupFailure.cause ?? cleanupFailure;
        throw safeError;
      }
      throw error;
    }
  }
  return null;
}

export async function readSlotUsage(fs, slotsDir) {
  const entries = await listDir(fs, slotsDir);
  let totalBytes = 0;
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) throw corrupt('slot 不是目录');
    if (!/^(?:[0-9]|[12][0-9]|3[01])$/.test(entry.name)) throw corrupt('slot 索引超出 0..31');
    const dir = safeJoin(slotsDir, entry.name);
    await statDir(fs, dir);
    // 空目录没有预约（0 字节也不占额）；acquireSlot 不会回收它们（可能是刚 mkdir 的活调用）
    // 里面出现子目录/多文件则失败关闭
    const files = await listDir(fs, dir);
    if (files.length === 0) continue;
    if (files.length !== 1 || !files[0].isFile()) throw corrupt('slot 预约缺失或重复');
    const reservationPath = safeJoin(dir, files[0].name);
    const reservation = await readJsonFile(fs, reservationPath, MAX_SLOT_FILE_BYTES);
    if (!reservation
      || typeof reservation.actionId !== 'string'
      || !ACTION_ID_PATTERN.test(reservation.actionId)
      || !Number.isSafeInteger(reservation.payloadBytes)
      || reservation.payloadBytes < 0
      || typeof reservation.createdAt !== 'string'
      || !Number.isFinite(Date.parse(reservation.createdAt))
      || files[0].name !== `${reservation.actionId}.json`) {
      throw corrupt('slot 预约内容无效');
    }
    totalBytes += reservation.payloadBytes;
    items.push({ ...reservation, index: entry.name });
  }
  return { totalBytes, items };
}

export async function verifySlotOwned(fs, slotsDir, actionId) {
  const { items } = await readSlotUsage(fs, slotsDir);
  return items.filter(item => item.actionId === actionId).length === 1;
}

/**
 * 只删除精确匹配 actionId 的预约文件；slot 已被新动作复用时不能碰它。
 * 只有真的 unlink 掉了自己的 marker 才算持有回收权：并发/迟到的释放里只有一个能成功，
 * 其余不得 sync/rmdir，否则会删掉新一代刚 mkdir 的空 slot。
 */
export async function releaseSlot(fs, slotsDir, actionId) {
  for (const entry of await listDir(fs, slotsDir)) {
    if (!entry.isDirectory()) throw corrupt('slot 不是目录');
    const dir = safeJoin(slotsDir, entry.name);
    const reservationPath = safeJoin(dir, `${actionId}.json`);
    if (!(await removeFile(fs, reservationPath))) continue;
    // 删除预约后先同步 slot 目录，再移除空目录并同步父目录；任何同步失败都不能静默宣称已回收
    await syncDir(fs, dir);
    if (await removeEmptyDir(fs, dir)) await syncDir(fs, slotsDir);
  }
}
