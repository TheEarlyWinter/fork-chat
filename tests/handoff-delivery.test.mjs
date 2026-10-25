import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import realFs from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { createHandoffDelivery } from '../lib/handoff-delivery.js';

// ---------------------------------------------------------------------------
// 夹具：真实临时目录 + 真实 fs，不碰用户工作区
// ---------------------------------------------------------------------------

const OWNER = JSON.stringify(['timeline-reverser', 'authenticated', 'user-1']);
const ACTION_ID = `ha_${'a'.repeat(32)}`;
const ARTIFACT_ID = 'b'.repeat(32);

function ownerHash() {
  return createHash('sha256').update(OWNER).digest('hex');
}

async function makeRoot() {
  const base = await realFs.mkdtemp(path.join(os.tmpdir(), 'handoff-delivery-'));
  const dataDir = path.join(base, 'data');
  await realFs.mkdir(dataDir, { mode: 0o700 });
  return { base, dataDir };
}

function actionDirOf(dataDir) {
  return path.join(dataDir, 'handoff-delivery', ownerHash(), ACTION_ID);
}

async function assertNothingOutside(outside) {
  assert.deepEqual(await realFs.readdir(outside), [], '链接目标目录不能被创建或写入');
}

/** 记录调用并让文件 fsync 失败；目录 sync 保持真实 */
function fsWithFileSyncFailure() {
  return {
    ...realFs,
    async open(target, flags, mode) {
      const handle = await realFs.open(target, flags, mode);
      const stat = await handle.stat();
      if (!stat.isFile()) return handle;
      return {
        writeFile: bytes => handle.writeFile(bytes),
        async sync() {
          throw new Error('SECRET_FSYNC');
        },
        close: () => handle.close(),
      };
    },
  };
}

/** 让目录 fsync 失败（路径以 O_RDONLY 打开且是目录） */
function fsWithDirSyncFailure() {
  return {
    ...realFs,
    async open(target, flags, mode) {
      const handle = await realFs.open(target, flags, mode);
      const stat = await handle.stat();
      if (stat.isFile()) return handle;
      return {
        writeFile: bytes => handle.writeFile(bytes),
        async sync() {
          throw new Error('SECRET_DIR_FSYNC');
        },
        close: () => handle.close(),
      };
    },
  };
}

async function modeOf(target) {
  return (await realFs.lstat(target)).mode & 0o777;
}

// ---------------------------------------------------------------------------
// 正常路径：三级 helper 目录 0700、文件 0600，路径只在本机
// ---------------------------------------------------------------------------

test('writeArtifact keeps the helper tree at 0700 and the file at 0600', async () => {
  const { dataDir } = await makeRoot();
  const delivery = createHandoffDelivery({ dataDir });

  const filePath = await delivery.writeArtifact({
    owner: OWNER,
    actionId: ACTION_ID,
    artifactId: ARTIFACT_ID,
    bytes: Buffer.from('artifact-body', 'utf8'),
  });

  const root = path.join(dataDir, 'handoff-delivery');
  const ownerDir = path.join(root, ownerHash());
  const actionDir = actionDirOf(dataDir);
  assert.equal(filePath, path.join(actionDir, `${ARTIFACT_ID}.bin`));
  assert.equal(await modeOf(root), 0o700);
  assert.equal(await modeOf(ownerDir), 0o700);
  assert.equal(await modeOf(actionDir), 0o700);
  assert.equal(await modeOf(filePath), 0o600);
  assert.equal((await realFs.readFile(filePath, 'utf8')), 'artifact-body');
});

test('a platform dataDir that is not 0700 is accepted and never chmod-ed', async () => {
  const { dataDir } = await makeRoot();
  await realFs.chmod(dataDir, 0o755);
  const delivery = createHandoffDelivery({ dataDir });

  const filePath = await delivery.writeArtifact({
    owner: OWNER,
    actionId: ACTION_ID,
    artifactId: ARTIFACT_ID,
    bytes: Buffer.from('x'),
  });
  assert.equal((await realFs.lstat(filePath)).isFile(), true);
  assert.equal(await modeOf(dataDir), 0o755, '不能 chmod 平台 dataDir');
});

// ---------------------------------------------------------------------------
// C-I5：祖先符号链接一律拒绝，且 outside 不能被创建或写入
// ---------------------------------------------------------------------------

test('C-I5: a symlinked handoff-delivery root is refused and nothing is written outside', async () => {
  const { base, dataDir } = await makeRoot();
  const outside = path.join(base, 'outside');
  await realFs.mkdir(outside, { mode: 0o700 });
  await realFs.symlink(outside, path.join(dataDir, 'handoff-delivery'), 'dir');
  const delivery = createHandoffDelivery({ dataDir });

  await assert.rejects(
    delivery.writeArtifact({ owner: OWNER, actionId: ACTION_ID, artifactId: ARTIFACT_ID, bytes: Buffer.from('x') }),
    error => error?.code === 'HANDOFF_DELIVERY_FAILED',
  );
  await assertNothingOutside(outside);
});

test('C-I5: a symlinked owner directory is refused and nothing is written outside', async () => {
  const { base, dataDir } = await makeRoot();
  const outside = path.join(base, 'outside');
  await realFs.mkdir(outside, { mode: 0o700 });
  const root = path.join(dataDir, 'handoff-delivery');
  await realFs.mkdir(root, { mode: 0o700 });
  await realFs.symlink(outside, path.join(root, ownerHash()), 'dir');
  const delivery = createHandoffDelivery({ dataDir });

  await assert.rejects(
    delivery.writeArtifact({ owner: OWNER, actionId: ACTION_ID, artifactId: ARTIFACT_ID, bytes: Buffer.from('x') }),
    error => error?.code === 'HANDOFF_DELIVERY_FAILED',
  );
  await assertNothingOutside(outside);
});

test('C-I5: a symlinked action directory is refused and nothing is written outside', async () => {
  const { base, dataDir } = await makeRoot();
  const outside = path.join(base, 'outside');
  await realFs.mkdir(outside, { mode: 0o700 });
  const root = path.join(dataDir, 'handoff-delivery');
  const ownerDir = path.join(root, ownerHash());
  await realFs.mkdir(ownerDir, { recursive: true, mode: 0o700 });
  await realFs.symlink(outside, actionDirOf(dataDir), 'dir');
  const delivery = createHandoffDelivery({ dataDir });

  await assert.rejects(
    delivery.writeArchive({ owner: OWNER, actionId: ACTION_ID, text: '正文' }),
    error => error?.code === 'HANDOFF_DELIVERY_FAILED',
  );
  await assertNothingOutside(outside);
});

test('C-I5: an existing helper directory that is not 0700 is refused instead of fixed up', async () => {
  const { dataDir } = await makeRoot();
  const root = path.join(dataDir, 'handoff-delivery');
  const ownerDir = path.join(root, ownerHash());
  const actionDir = actionDirOf(dataDir);
  await realFs.mkdir(ownerDir, { recursive: true, mode: 0o700 });
  await realFs.chmod(root, 0o755);
  await realFs.mkdir(actionDir, { mode: 0o700 });
  const delivery = createHandoffDelivery({ dataDir });

  await assert.rejects(
    delivery.writeArtifact({ owner: OWNER, actionId: ACTION_ID, artifactId: ARTIFACT_ID, bytes: Buffer.from('x') }),
    error => error?.code === 'HANDOFF_DELIVERY_FAILED',
  );
  assert.deepEqual(await realFs.readdir(actionDir), [], '不安全目录里不能落文件');
  assert.equal(await modeOf(root), 0o755, '不能 chmod 既有目录来“修正”');
});

test('C-I5: an existing non-0700 owner or action directory is refused as well', async () => {
  for (const level of ['owner', 'action']) {
    const { dataDir } = await makeRoot();
    const root = path.join(dataDir, 'handoff-delivery');
    const ownerDir = path.join(root, ownerHash());
    const actionDir = actionDirOf(dataDir);
    await realFs.mkdir(ownerDir, { recursive: true, mode: 0o700 });
    await realFs.mkdir(actionDir, { mode: 0o700 });
    await realFs.chmod(level === 'owner' ? ownerDir : actionDir, 0o750);
    const delivery = createHandoffDelivery({ dataDir });

    await assert.rejects(
      delivery.writeArtifact({ owner: OWNER, actionId: ACTION_ID, artifactId: ARTIFACT_ID, bytes: Buffer.from('x') }),
      error => error?.code === 'HANDOFF_DELIVERY_FAILED',
      level,
    );
    assert.deepEqual(await realFs.readdir(actionDir), [], level);
  }
});

// ---------------------------------------------------------------------------
// 注入 fs：file fsync / dir fsync 失败都要上抛，不能静默成功
// ---------------------------------------------------------------------------

test('a file fsync failure rejects instead of reporting a committed artifact', async () => {
  const { dataDir } = await makeRoot();
  const delivery = createHandoffDelivery({ dataDir, fs: fsWithFileSyncFailure() });

  await assert.rejects(
    delivery.writeArtifact({ owner: OWNER, actionId: ACTION_ID, artifactId: ARTIFACT_ID, bytes: Buffer.from('x') }),
    error => error?.code === 'HANDOFF_DELIVERY_FAILED',
  );
  await assert.rejects(
    realFs.lstat(path.join(actionDirOf(dataDir), `${ARTIFACT_ID}.bin`)),
    error => error.code === 'ENOENT',
  );
});

test('a directory fsync failure rejects instead of reporting a committed archive', async () => {
  const { dataDir } = await makeRoot();
  const delivery = createHandoffDelivery({ dataDir, fs: fsWithDirSyncFailure() });

  await assert.rejects(
    delivery.writeArchive({ owner: OWNER, actionId: ACTION_ID, text: '正文' }),
    error => error?.code === 'HANDOFF_DELIVERY_FAILED',
  );
  assert.equal(JSON.stringify(await realFs.readdir(actionDirOf(dataDir))).includes('SECRET'), false);
});

// ---------------------------------------------------------------------------
// round5 C-I5：清理（remove/removeDir）必须先逐级验证私有树，链接祖先不能删到 outside
// ---------------------------------------------------------------------------

const OUTSIDE_FILES = {
  'context.md': '外部合成归档',
  [`${ARTIFACT_ID}.bin`]: '外部合成产物',
};

/** 正常写完产物与归档；后续再把某一级换成链接去清理 */
async function writeBoth(delivery) {
  await delivery.writeArtifact({
    owner: OWNER,
    actionId: ACTION_ID,
    artifactId: ARTIFACT_ID,
    bytes: Buffer.from('artifact-body', 'utf8'),
  });
  await delivery.writeArchive({ owner: OWNER, actionId: ACTION_ID, text: '归档正文' });
}

/** 在 outside 下按给定层级铺一份同名合成树，返回其动作目录 */
async function fillOutside(outside, segments) {
  const dir = path.join(outside, ...segments);
  await realFs.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [name, text] of Object.entries(OUTSIDE_FILES)) {
    await realFs.writeFile(path.join(dir, name), text, { mode: 0o600 });
  }
  return dir;
}

/** outside 的完整快照（名称+类型+内容），用来证明“没有先删后报错” */
async function snapshotTree(root) {
  const entries = [];
  async function walk(dir, prefix) {
    for (const name of (await realFs.readdir(dir)).sort()) {
      const full = path.join(dir, name);
      const stat = await realFs.lstat(full);
      if (stat.isSymbolicLink()) entries.push(`${prefix}${name}@`);
      else if (stat.isDirectory()) {
        entries.push(`${prefix}${name}/`);
        await walk(full, `${prefix}${name}/`);
      } else entries.push(`${prefix}${name}:${await realFs.readFile(full, 'utf8')}`);
    }
  }
  await walk(root, '');
  return entries;
}

/** 调用并记录是否拒绝，避免“已拒绝”掩盖“拒绝前已经删掉了东西” */
async function captureOutcome(fn) {
  try {
    await fn();
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error };
  }
}

async function exists(target) {
  try {
    await realFs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

test('round5 C-I5: a symlinked helper root is refused by cleanup and nothing outside is deleted', async () => {
  const { base, dataDir } = await makeRoot();
  const delivery = createHandoffDelivery({ dataDir });
  await writeBoth(delivery);

  // 正常写完之后再把 helper 根换成指向 outside 的链接（旧树 rename 到本测试 base 下留底，不递归删除）
  await realFs.rename(path.join(dataDir, 'handoff-delivery'), path.join(base, 'backup-helper-root'));
  const outside = path.join(base, 'outside');
  await realFs.mkdir(outside, { mode: 0o700 });
  await fillOutside(outside, [ownerHash(), ACTION_ID]);
  const before = await snapshotTree(outside);
  await realFs.symlink(outside, path.join(dataDir, 'handoff-delivery'), 'dir');

  const removed = await captureOutcome(() => delivery.remove({ owner: OWNER, actionId: ACTION_ID, name: 'context.md' }));
  const removedDir = await captureOutcome(() => delivery.removeDir({ owner: OWNER, actionId: ACTION_ID }));

  assert.deepEqual(await snapshotTree(outside), before, '链接根下清理不能删到 outside（即便随后报错）');
  assert.equal(removed.ok, false, 'helper 根是链接时 remove 必须拒绝');
  assert.equal(removed.error?.code, 'HANDOFF_DELIVERY_FAILED');
  assert.equal(removedDir.ok, false, 'helper 根是链接时 removeDir 必须拒绝');
  assert.equal(removedDir.error?.code, 'HANDOFF_DELIVERY_FAILED');
  assert.equal((await realFs.lstat(path.join(dataDir, 'handoff-delivery'))).isSymbolicLink(), true, '不能替换调用方的链接');
});

test('round5 C-I5: a symlinked owner directory is refused by cleanup and nothing outside is deleted', async () => {
  const { base, dataDir } = await makeRoot();
  const delivery = createHandoffDelivery({ dataDir });
  await writeBoth(delivery);

  const ownerDir = path.join(dataDir, 'handoff-delivery', ownerHash());
  await realFs.rename(ownerDir, path.join(base, 'backup-owner-dir'));
  const outside = path.join(base, 'outside');
  await realFs.mkdir(outside, { mode: 0o700 });
  await fillOutside(outside, [ACTION_ID]);
  const before = await snapshotTree(outside);
  await realFs.symlink(outside, ownerDir, 'dir');

  const removed = await captureOutcome(() => delivery.remove({ owner: OWNER, actionId: ACTION_ID, artifactId: ARTIFACT_ID }));
  const removedDir = await captureOutcome(() => delivery.removeDir({ owner: OWNER, actionId: ACTION_ID }));

  assert.deepEqual(await snapshotTree(outside), before, 'owner 链接下清理不能删到 outside（即便随后报错）');
  assert.equal(removed.ok, false, 'owner 目录是链接时 remove 必须拒绝');
  assert.equal(removed.error?.code, 'HANDOFF_DELIVERY_FAILED');
  assert.equal(removedDir.ok, false, 'owner 目录是链接时 removeDir 必须拒绝');
  assert.equal(removedDir.error?.code, 'HANDOFF_DELIVERY_FAILED');
  assert.equal((await realFs.lstat(ownerDir)).isSymbolicLink(), true, '不能替换调用方的链接');
});

test('round5 C-I5: a symlinked action directory is refused by cleanup and the outside target survives', async () => {
  const { base, dataDir } = await makeRoot();
  const delivery = createHandoffDelivery({ dataDir });
  await writeBoth(delivery);

  const actionDir = actionDirOf(dataDir);
  await realFs.rename(actionDir, path.join(base, 'backup-action-dir'));
  const outside = path.join(base, 'outside');
  await realFs.mkdir(outside, { mode: 0o700 });
  await fillOutside(outside, []);
  const before = await snapshotTree(outside);
  await realFs.symlink(outside, actionDir, 'dir');

  const removed = await captureOutcome(() => delivery.remove({ owner: OWNER, actionId: ACTION_ID, name: 'context.md' }));
  const removedDir = await captureOutcome(() => delivery.removeDir({ owner: OWNER, actionId: ACTION_ID }));

  assert.deepEqual(await snapshotTree(outside), before, 'action 链接下清理不能删到 outside（即便随后报错）');
  assert.equal(removed.ok, false, 'action 目录是链接时 remove 必须拒绝');
  assert.equal(removed.error?.code, 'HANDOFF_DELIVERY_FAILED');
  assert.equal(removedDir.ok, false, 'action 目录是链接时 removeDir 必须拒绝');
  assert.equal(removedDir.error?.code, 'HANDOFF_DELIVERY_FAILED');
  assert.equal((await realFs.lstat(actionDir)).isSymbolicLink(), true, '不能替换调用方的链接');
});

test('round5 C-I5: cleanup refuses an existing non-0700 helper directory, deletes nothing and never chmods', async () => {
  for (const level of ['root', 'owner', 'action']) {
    const { dataDir } = await makeRoot();
    const delivery = createHandoffDelivery({ dataDir });
    await writeBoth(delivery);

    const root = path.join(dataDir, 'handoff-delivery');
    const ownerDir = path.join(root, ownerHash());
    const actionDir = actionDirOf(dataDir);
    const unsafe = level === 'root' ? root : level === 'owner' ? ownerDir : actionDir;
    await realFs.chmod(unsafe, 0o755);

    const removed = await captureOutcome(() => delivery.remove({ owner: OWNER, actionId: ACTION_ID, name: 'context.md' }));
    const removedDir = await captureOutcome(() => delivery.removeDir({ owner: OWNER, actionId: ACTION_ID }));

    assert.equal(removed.ok, false, `${level}: 权限不安全的私有树不能清理`);
    assert.equal(removed.error?.code, 'HANDOFF_DELIVERY_FAILED', level);
    assert.equal(removedDir.ok, false, `${level}: removeDir 同样必须拒绝`);
    assert.equal(removedDir.error?.code, 'HANDOFF_DELIVERY_FAILED', level);
    assert.equal(await modeOf(unsafe), 0o755, `${level}: 不能 chmod 既有目录`);
    assert.equal(await exists(path.join(actionDir, 'context.md')), true, `${level}: 验证失败不能删文件`);
    assert.equal(await exists(path.join(actionDir, `${ARTIFACT_ID}.bin`)), true, `${level}: 验证失败不能删文件`);
  }
});

test('round5 C-I5: a normal cleanup still removes the file and only the exact action directory', async () => {
  const { dataDir } = await makeRoot();
  const delivery = createHandoffDelivery({ dataDir });
  await writeBoth(delivery);

  const root = path.join(dataDir, 'handoff-delivery');
  const ownerDir = path.join(root, ownerHash());
  const actionDir = actionDirOf(dataDir);

  await delivery.remove({ owner: OWNER, actionId: ACTION_ID, name: 'context.md' });
  await delivery.remove({ owner: OWNER, actionId: ACTION_ID, artifactId: ARTIFACT_ID });
  await delivery.removeDir({ owner: OWNER, actionId: ACTION_ID });

  assert.equal(await exists(path.join(actionDir, 'context.md')), false);
  assert.equal(await exists(actionDir), false, '只删自己 action 的目录');
  assert.equal(await modeOf(root), 0o700);
  assert.equal(await modeOf(ownerDir), 0o700);
});

test('round5 C-I5: removing an already cleaned action is a no-op and recreates nothing', async () => {
  const { dataDir } = await makeRoot();
  const delivery = createHandoffDelivery({ dataDir });
  await writeBoth(delivery);

  const root = path.join(dataDir, 'handoff-delivery');
  const ownerDir = path.join(root, ownerHash());
  const actionDir = actionDirOf(dataDir);
  await delivery.remove({ owner: OWNER, actionId: ACTION_ID, name: 'context.md' });
  await delivery.remove({ owner: OWNER, actionId: ACTION_ID, artifactId: ARTIFACT_ID });
  await delivery.removeDir({ owner: OWNER, actionId: ACTION_ID });

  const again = await captureOutcome(() => delivery.removeDir({ owner: OWNER, actionId: ACTION_ID }));
  assert.equal(again.ok, true, 'action 已不在时 removeDir 可以无副作用返回');
  assert.equal(await exists(actionDir), false, '不能重建已清理的动作目录');
  assert.equal(await modeOf(root), 0o700);
  assert.equal(await modeOf(ownerDir), 0o700);
  assert.deepEqual(await realFs.readdir(ownerDir), []);
});

test('round5 C-I5: cleanup never creates the helper tree when nothing has been written', async () => {
  const { dataDir } = await makeRoot();
  const delivery = createHandoffDelivery({ dataDir });

  const removed = await captureOutcome(() => delivery.remove({ owner: OWNER, actionId: ACTION_ID, name: 'context.md' }));
  const removedDir = await captureOutcome(() => delivery.removeDir({ owner: OWNER, actionId: ACTION_ID }));

  assert.equal(await exists(path.join(dataDir, 'handoff-delivery')), false, '清理不能新建 helper 树');
  for (const outcome of [removed, removedDir]) {
    if (!outcome.ok) assert.equal(outcome.error?.code, 'HANDOFF_DELIVERY_FAILED', '缺失时只能是保守拒绝');
  }
});
