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
