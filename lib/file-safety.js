import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Reject links in every component, not just the last filename.
export async function checkedPath(root, target) {
  const base = await fs.realpath(root);
  const resolved = path.resolve(target);
  if (!inside(base, resolved)) throw new Error('文件不在允许的数据目录内');
  let current = base;
  for (const piece of path.relative(base, resolved).split(path.sep)) {
    current = path.join(current, piece);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('拒绝符号链接');
  }
  if (await fs.realpath(resolved) !== resolved) throw new Error('文件真实路径不匹配');
  return resolved;
}

export async function privateDirectory(dataDir, name) {
  if (!/^[a-zA-Z0-9._-]+$/.test(name) || ['.', '..'].includes(name)) throw new Error('目录名无效');
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const base = await fs.realpath(dataDir);
  const target = path.join(base, name);
  await fs.mkdir(target, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await checkedPath(base, target);
  if (!(await fs.lstat(target)).isDirectory()) throw new Error('数据目录无效');
  return target;
}

// Keep the checked descriptor open; callers must not re-open its pathname.
export async function openCheckedFile(root, target, maxBytes = Number.MAX_SAFE_INTEGER) {
  const resolved = await checkedPath(root, target);
  const handle = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('目标不是普通文件');
    if (stat.size > maxBytes) throw new Error('文件超过大小上限');
    const after = await checkedPath(root, resolved);
    const pathStat = await fs.stat(after);
    if (pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) throw new Error('文件在校验过程中被替换');
    // Linux resolves the actual opened object, including directory-swap races.
    // 在 Node --permission 生产沙盒中，未向主进程开放 /proc 读取权限时，
    // fs.realpath('/proc/self/fd/...') 会抛出 ERR_ACCESS_DENIED。
    // 沙盒本身及前面的 dev/ino 比对已提供充分的安全边界保护。
    if (process.platform === 'linux' && (!process.permission || process.permission.has('fs.read', `/proc/self/fd/${handle.fd}`))) {
      try {
        const actual = await fs.realpath(`/proc/self/fd/${handle.fd}`);
        if (actual !== resolved || !inside(await fs.realpath(root), actual)) throw new Error('打开的文件越界');
      } catch (procErr) {
        if (procErr?.code !== 'ERR_ACCESS_DENIED') throw procErr;
      }
    }
    return { handle, size: stat.size, filePath: resolved };
  } catch (error) { await handle.close(); throw error; }
}

export async function readCheckedFile(root, target, maxBytes) {
  const file = await openCheckedFile(root, target, maxBytes);
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of file.handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error('读取内容超过上限');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { await file.handle.close(); }
}

export async function exclusiveFile(root, name) {
  if (path.basename(name) !== name || ['.', '..'].includes(name)) throw new Error('文件名无效');
  // Checking the directory itself through its parent rejects a replaced root link.
  await checkedPath(path.dirname(root), root);
  return fs.open(path.join(root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
}
