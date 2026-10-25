import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handoffUsesSynchronousWrites, handoffWriteFlags } from '../lib/handoff-io-policy.js';

// 真实 Node Permission Model 回归：子进程以 --permission 跑真实 handoff Store/Delivery/Service，
// 只给项目源码读权限和本次自建短数据目录的读写权限，不授予任何通配写权限。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const childPath = path.join(repoRoot, 'tests', 'helpers', 'handoff-permission-child.mjs');
const OWNER = JSON.stringify(['timeline-reverser', 'authenticated', 'user-1']);

async function shortTempDir(t) {
  // 短独立目录：不复用历史目录，也避免长路径问题
  const dir = await fs.mkdtemp('/var/tmp/fc-hpm-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function parseReport(result) {
  const lines = String(result.stdout || '').trim().split('\n').filter(Boolean);
  const last = lines.at(-1);
  if (!last) return { ok: false, parseError: true, stderr: String(result.stderr || ''), status: result.status };
  return JSON.parse(last);
}

function runChild({ dataDir }) {
  const result = spawnSync(process.execPath, [
    '--permission',
    `--allow-fs-read=${repoRoot}`,
    `--allow-fs-read=${dataDir}`,
    `--allow-fs-write=${dataDir}`,
    childPath,
    JSON.stringify({ dataDir, owner: OWNER }),
  ], { encoding: 'utf8', timeout: 120_000, cwd: repoRoot });
  if (result.error) throw new Error(`child launcher failed: ${result.error.message}`);
  return { ...result, report: parseReport(result) };
}

function assertChildRan(test, result) {
  assert.equal(result.status, 0, `the PM child must exit normally: ${result.stderr}`);
  assert.equal(result.report.permissionModel, true, 'the child must actually run with the Node Permission Model enabled');
  assert.equal(result.report.parseError, undefined, `the child must emit a JSON report: ${result.stderr}`);
}

test('handoff io policy: ordinary Node keeps the caller flags untouched', () => {
  // 父进程没有 --permission：策略必须原样返回，普通模式的持久化语义不变
  assert.equal(handoffUsesSynchronousWrites(), false);
  assert.equal(handoffWriteFlags('wx'), 'wx', 'ordinary mode must keep the wx string flags');
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  assert.equal(handoffWriteFlags(flags), flags, 'ordinary mode must keep numeric exclusive-write flags');
});

test('handoff confirm under a real Node --permission child: prepare without host calls, one real artifact plus handoff markdown, ready', async t => {
  const base = await shortTempDir(t);
  const dataDir = path.join(base, 'data');
  await fs.mkdir(dataDir, { mode: 0o700 });
  const result = runChild({ dataDir });
  assertChildRan(t, result);
  const report = result.report;
  assert.equal(report.ok, true, `handoff prepare/confirm must succeed under Node --permission: ${JSON.stringify(report.error)}`);
  const steps = report.steps;

  // PM 下的策略：真实数值独占写 flags，带 O_SYNC 与 O_NOFOLLOW
  assert.equal(steps.usesSyncWrites, true);
  assert.equal(steps.pmFlagsIsNumber, true, 'PM must use numeric flags, not the wx string');
  assert.deepEqual(
    [...steps.pmFlagsBits].sort(),
    ['O_CREAT', 'O_EXCL', 'O_NOFOLLOW', 'O_SYNC', 'O_WRONLY'],
    'PM writes must be exclusive, no-follow and synchronous',
  );

  assert.equal(steps.prepareState, 'prepared');
  assert.equal(steps.prepareHostCalls, 0, 'prepare must not touch the host at all');
  assert.equal(steps.confirmState, 'ready');
  assert.equal(steps.confirmCreateCalls, 1, 'exactly one host session creation per confirmed action');
  assert.equal(steps.stageCount, 2, 'one real artifact plus the handoff markdown are staged');
  assert.equal(steps.artifactStageName, '报告.md');
  assert.equal(steps.artifactStageMatches, true, 'the staged artifact bytes must be the real artifact body');
  assert.deepEqual({ name: steps.archiveStage?.name, mime: steps.archiveStage?.mime }, { name: 'handoff.md', mime: 'text/markdown' });
  assert.ok(steps.archiveBytes > 0, 'the handoff markdown must not be empty');
  assert.equal(steps.archiveHasTranscript, true, 'the markdown must carry the conversation body');
  assert.equal(steps.archiveHasReceipt, true, 'the markdown must carry the artifact receipt');
  assert.equal(steps.contextHasTranscript, true, 'the written context must carry the body');
  assert.equal(steps.contextHasArchiveReceipt, true, 'the written context must index the handoff markdown');
  assert.equal(steps.actionDirRemoved, true, 'the private delivery directory is cleared before ready');
});

test('handoff under a real Node --permission child: same-action confirm is exclusive and a recreated service never resends', async t => {
  const base = await shortTempDir(t);
  const dataDir = path.join(base, 'data');
  await fs.mkdir(dataDir, { mode: 0o700 });
  const result = runChild({ dataDir });
  assertChildRan(t, result);
  const report = result.report;
  assert.equal(report.ok, true, `handoff flow must succeed under Node --permission: ${JSON.stringify(report.error)}`);
  const steps = report.steps;

  for (const state of steps.concurrentStates) {
    assert.ok(['prepared', 'ready'].includes(state), `concurrent confirm must stay on the same action: ${state}`);
  }
  assert.ok(steps.concurrentStates.includes('ready'), 'one concurrent confirm must reach ready');
  assert.equal(steps.concurrentCreateDelta, 1, 'two concurrent confirms of one action create exactly one host session');
  assert.equal(steps.secondStagedFiles, 2, 'the concurrently confirmed action stages its artifact and markdown once');

  assert.equal(steps.replayState, 'ready');
  assert.equal(steps.replayHostCalls, 0, 'a recreated service must not call the host again for a ready action');
  assert.equal(steps.replayPersisted, 'ready', 'the ready state must persist across service recreation');
});
