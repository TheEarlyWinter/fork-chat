/**
 * 交接文件 IO 的运行环境策略。
 *
 * Node 的 Permission Model（`node --permission`）会禁用 FileHandle.sync/fdatasync。
 * 普通 Node 保持原有的 write + fsync + 目录 fsync 语义；PM 下改用 O_SYNC 独占写入，
 * 让文件数据与元数据在 write 内落盘，并不再对目录 fd 调 sync（PM 下不可用）。
 *
 * 明确边界：O_SYNC 只保证“这次写入在返回前已交给设备”，不承诺突然断电、
 * 内核崩溃或目录项丢失后的恢复；PM 下也不做目录同步。
 */
import { constants } from 'node:fs';

/** 真实 process.permission 决定模式；没有用户可请求的开关 */
export function handoffUsesSynchronousWrites() {
  return Boolean(process.permission);
}

const EXCLUSIVE_WRITE_REQUIRED = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;

/**
 * 非 PM：原样返回调用方的 flags（现有 wx 字符串或既有数值独占写 flags）。
 * PM：返回等价的数值 flags 并加上 O_SYNC/O_NOFOLLOW；平台不支持 O_SYNC 时明确失败。
 */
export function handoffWriteFlags(ordinaryFlags) {
  if (!handoffUsesSynchronousWrites()) return ordinaryFlags;
  let flags;
  if (ordinaryFlags === 'wx') {
    flags = EXCLUSIVE_WRITE_REQUIRED;
  } else if (typeof ordinaryFlags === 'number' && Number.isInteger(ordinaryFlags) && ordinaryFlags > 0) {
    // 只接受已有的独占写 flags：不能把非独占写悄悄升级成独占，也不放宽调用方语义
    if ((ordinaryFlags & EXCLUSIVE_WRITE_REQUIRED) !== EXCLUSIVE_WRITE_REQUIRED) {
      throw new TypeError('交接存储只支持独占写 flags');
    }
    flags = ordinaryFlags;
  } else {
    throw new TypeError('交接存储只支持 wx 或数值独占写 flags');
  }
  if (!constants.O_SYNC) throw new Error('当前平台不支持 O_SYNC 同步写');
  return flags | (constants.O_NOFOLLOW || 0) | constants.O_SYNC;
}
