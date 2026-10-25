import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exclusiveFile } from '../lib/file-safety.js';

// 真实 Node Permission Model 回归：子进程以 --permission 运行真实 createArtifactService，
// 只授予项目源码读权限与本次自建的短数据目录读写权限，不授予任何通配写权限。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const childPath = path.join(repoRoot, 'tests', 'helpers', 'artifact-permission-child.mjs');

async function shortTempDir(t) {
  // 短独立目录：避免 /var/tmp 下复用历史目录，也避免长路径触发 unix socket 限制。
  const dir = await fs.mkdtemp('/var/tmp/fc-pm-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function parseReport(result) {
  const lines = String(result.stdout || '').trim().split('\n').filter(Boolean);
  const last = lines.at(-1);
  if (!last) return { ok: false, parseError: true, stderr: String(result.stderr || ''), status: result.status, signal: result.signal };
  return JSON.parse(last);
}

function runChild({ dataDir, config = {}, permission = true, straceInject = false, traceFile, fileSizeLimit = 0 }) {
  const nodeArgs = [
    ...(permission ? ['--permission', `--allow-fs-read=${repoRoot}`, `--allow-fs-read=${dataDir}`, `--allow-fs-write=${dataDir}`] : []),
    childPath,
    JSON.stringify({ dataDir, ...config }),
  ];
  const spawnOptions = { encoding: 'utf8', timeout: 120_000, cwd: repoRoot };
  let result;
  if (fileSizeLimit) {
    result = spawnSync('/bin/bash', ['-c', `ulimit -f ${fileSizeLimit}; exec "$@"`, 'bash', process.execPath, ...nodeArgs], spawnOptions);
  } else if (straceInject) {
    result = spawnSync('strace', [
      '-f', '-qq', '-y', '-e', 'trace=fsync,fdatasync',
      '-e', 'inject=fsync:error=EIO:when=1',
      '-o', traceFile, process.execPath, ...nodeArgs,
    ], spawnOptions);
  } else {
    result = spawnSync(process.execPath, nodeArgs, spawnOptions);
  }
  return { ...result, report: parseReport(result) };
}

async function traceLines(traceFile) {
  try {
    return (await fs.readFile(traceFile, 'utf8')).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function hasExecutable(name) {
  return spawnSync(name, ['--version'], { encoding: 'utf8' }).status === 0;
}

async function fdFlags(handle) {
  const info = await fs.readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
  const match = info.match(/^flags:\s+([0-7]+)$/m);
  assert.ok(match, `fdinfo must expose octal flags: ${info}`);
  return Number.parseInt(match[1], 8);
}

test('exclusiveFile: default open is not synchronous, explicit synchronous really sets O_SYNC, both keep exclusive/no-follow/0600', {
  skip: process.platform !== 'linux' && 'fd flags are asserted through Linux fdinfo',
}, async t => {
  const base = await shortTempDir(t);
  const dir = path.join(base, 'files');
  await fs.mkdir(dir, { mode: 0o700 });

  // fdinfo 只暴露 file status flags（O_WRONLY/O_SYNC 等）；O_CREAT/O_EXCL/O_NOFOLLOW
  // 是 open 时的参数，只能通过 EEXIST / 符号链接用例的行为验证。
  async function openAndInspect(name, options) {
    const handle = await exclusiveFile(dir, name, options);
    try {
      const flags = await fdFlags(handle);
      const mode = (await handle.stat()).mode & 0o777;
      await handle.writeFile(Buffer.from(`${name}-bytes`));
      return { flags, mode };
    } finally {
      await handle.close();
    }
  }

  const plain = await openAndInspect('plain.bin');
  assert.equal((plain.flags & constants.O_SYNC) === constants.O_SYNC, false, 'default exclusiveFile must not add O_SYNC');
  assert.equal((plain.flags & constants.O_DSYNC) === constants.O_DSYNC, false, 'default exclusiveFile must not add O_DSYNC');
  assert.equal((plain.flags & constants.O_WRONLY) === constants.O_WRONLY, true, 'default exclusiveFile must stay write-only');
  assert.equal(plain.mode, 0o600);
  assert.equal(await fs.readFile(path.join(dir, 'plain.bin'), 'utf8'), 'plain.bin-bytes');

  const synced = await openAndInspect('synced.bin', { synchronous: true });
  assert.equal((synced.flags & constants.O_SYNC) === constants.O_SYNC, true, 'synchronous:true must pass a real non-zero O_SYNC');
  assert.equal((synced.flags & constants.O_WRONLY) === constants.O_WRONLY, true, 'synchronous open must stay write-only');
  assert.equal(synced.mode, 0o600);
  assert.equal(await fs.readFile(path.join(dir, 'synced.bin'), 'utf8'), 'synced.bin-bytes');

  // 不传 options / 传空对象时行为与默认一致，仍拒绝重复创建。
  for (const options of [undefined, {}]) {
    await assert.rejects(
      () => exclusiveFile(dir, 'plain.bin', options),
      error => error.code === 'EEXIST',
      'exclusive create must not silently reuse an existing name',
    );
    await assert.rejects(
      () => exclusiveFile(dir, 'synced.bin', { ...(options || {}), synchronous: true }),
      error => error.code === 'EEXIST',
      'synchronous exclusive create must not silently reuse an existing name',
    );
  }
});

test('exclusiveFile: symlink name is rejected in both modes and the link target is untouched', async t => {
  const base = await shortTempDir(t);
  const dir = path.join(base, 'files');
  await fs.mkdir(dir, { mode: 0o700 });
  const outside = path.join(base, 'outside.txt');
  await fs.writeFile(outside, 'do-not-touch');
  await fs.symlink(outside, path.join(dir, 'link.bin'));

  for (const options of [undefined, { synchronous: true }]) {
    await assert.rejects(
      () => exclusiveFile(dir, 'link.bin', options),
      error => ['EEXIST', 'ELOOP'].includes(error.code),
      'an existing symlink must never be opened as an exclusive artifact file',
    );
  }
  assert.equal(await fs.readFile(outside, 'utf8'), 'do-not-touch');
  assert.equal((await fs.lstat(path.join(dir, 'link.bin'))).isSymbolicLink(), true);
});

test('artifact publish: ordinary mode still fsyncs, and a real fsync error fails the publish instead of reporting ready', {
  skip: !hasExecutable('strace') && 'strace is required to inject a real fsync failure',
}, async t => {
  const base = await shortTempDir(t);
  const dataDir = path.join(base, 'data');
  await fs.mkdir(dataDir, { mode: 0o700 });
  const traceFile = path.join(base, 'trace.log');
  const result = runChild({
    dataDir,
    permission: false,
    straceInject: true,
    traceFile,
    config: { owner: 'plain-owner', content: '# 普通模式\n\n真实 fsync 失败\n' },
  });

  const fsyncs = (await traceLines(traceFile)).filter(line => /fsync|fdatasync/.test(line));
  assert.ok(fsyncs.length > 0, 'ordinary mode must still call a real fd sync, not skip durability');
  assert.equal(result.report.ok, false, `a failed sync must not be reported as a published artifact: ${JSON.stringify(result)}`);
  assert.equal(result.report.error?.code, 'EIO', `the real sync error must propagate unchanged: ${JSON.stringify(result.report.error)}`);
  assert.equal(result.report.steps.manifestCountAfterFailure, 0, 'a failed publish must not leave a ready manifest');
});

test('artifact publish under a real Node --permission child: create, read, restart, owner isolation and out-of-scope write denial', async t => {
  const base = await shortTempDir(t);
  const dataDir = path.join(base, 'data');
  await fs.mkdir(dataDir, { mode: 0o700 });
  const content = '# 权限模型文档\n\n这是真实 Node --permission 子进程写入的正文。\n';
  const result = runChild({ dataDir, config: { owner: 'pm-owner', content } });
  const report = result.report;

  assert.equal(report.permissionModel, true, 'the child must actually run with the Node Permission Model enabled');
  assert.equal(report.ok, true, `artifact publish must succeed under Node --permission: ${JSON.stringify(report.error || report.stderr || result.stderr)}`);
  assert.equal(report.steps.published, true);
  assert.equal(report.steps.readBytes, content);
  assert.equal(report.steps.readMatches, true);
  assert.equal(report.steps.readHashMatches, true, 'metadata bytes/sha256 must describe the persisted content');
  assert.equal(report.steps.metadataStable, true);
  assert.equal(report.steps.exportBase64Matches, true);
  assert.equal(report.steps.previewMatches, true);
  assert.equal(report.steps.manifestCount, 1, 'exactly one published manifest must exist');
  assert.equal(report.steps.manifestSchema, 1);
  assert.equal(report.steps.manifestStatus, 'ready');
  assert.equal(report.steps.manifestShaMatches, true);
  assert.equal(report.steps.manifestRecordHashMatches, true);
  assert.equal(report.steps.restartReadMatches, true, 'a recreated service must read the artifact after the publishing scope ended');
  assert.equal(report.steps.foreignOwner, 'ARTIFACT_NOT_FOUND');
  assert.equal(report.steps.escapeWrite, 'ERR_ACCESS_DENIED', 'the child must not be able to write outside its own data directory');
  assert.equal(result.status, 0);
});

test('artifact publish under a real Node --permission child does not rely on the disabled fd sync', {
  skip: (!hasExecutable('strace') && 'strace is required to observe fd sync calls') || (process.platform !== 'linux' && 'Linux fd tracing only'),
}, async t => {
  const base = await shortTempDir(t);
  const dataDir = path.join(base, 'data');
  await fs.mkdir(dataDir, { mode: 0o700 });
  const traceFile = path.join(base, 'trace.log');
  const result = runChild({
    dataDir,
    permission: true,
    traceFile,
    config: { owner: 'pm-owner', content: '# 权限模型\n\n无 fd sync\n' },
  });
  assert.equal(result.report.ok, true, `permission-model publish must succeed: ${JSON.stringify(result.report.error)}`);
  // 只关注本数据目录的文件：Node 运行时自身的 fsync 不在断言范围。
  const touched = (await traceLines(traceFile)).filter(line => line.includes(`${dataDir}`) && /fsync|fdatasync/.test(line));
  assert.deepEqual(touched, [], 'permission-model publish must not call the disabled FileHandle.sync on artifact files');
});

test('artifact publish under Node --permission: a real write failure publishes no manifest and no pending record', async t => {
  const base = await shortTempDir(t);
  const dataDir = path.join(base, 'data');
  await fs.mkdir(dataDir, { mode: 0o700 });
  const result = runChild({
    dataDir,
    permission: true,
    fileSizeLimit: 8,
    config: { owner: 'pm-owner', content: `# 超限\n\n${'x'.repeat(64 * 1024)}\n` },
  });
  const report = result.report;
  assert.equal(report.ok, false, `an oversized write must fail instead of reporting ready: ${JSON.stringify(report.steps)}`);
  assert.equal(report.error?.code, 'EFBIG', `the real write error must propagate: ${JSON.stringify(report.error)}`);
  assert.equal(report.steps.manifestCountAfterFailure, 0, 'a failed publish must not leave a ready manifest');
  assert.equal(report.steps.publishedFilesAfterFailure, 0, 'a failed publish must not leave a pending manifest');
});
