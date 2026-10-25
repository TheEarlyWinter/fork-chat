// 真实 Node Permission Model 子进程执行器：在 --permission 下跑真实 handoff Store/Delivery/Service，
// 只把 fake host/SDK/artifacts 作为上下游，不做任何权限旁路（不关 PM、不开 worker/child、不写授权外目录）。
// 父测试用 process.execPath 启动它，因此同一份代码在 Node 24 / Node 26 下都按各自运行时行为验证。
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';

import { buildHandoffContext } from '../../ui/assets/fork-handoff-context.js';
import { createHandoffStore } from '../../lib/handoff-store.js';
import { createHandoffDelivery } from '../../lib/handoff-delivery.js';
import { createHandoffService } from '../../lib/handoff-service.js';
import { handoffUsesSynchronousWrites, handoffWriteFlags } from '../../lib/handoff-io-policy.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const report = {
  ok: false,
  permissionModel: Boolean(process.permission),
  steps: {},
  error: null,
};

function card(id, { messages = [] } = {}) {
  return { id, x: 0, y: 0, width: 320, draft: '', messages };
}

function handoffContext({ artifactIds = [], text = '交接正文：用户要求继续处理权限模型修复。' } = {}) {
  const context = buildHandoffContext({
    snapshot: {
      cards: [card('card-1', { messages: [{ role: 'user', text }] })],
      view: { x: 0, y: 0, scale: 1 },
      agent: { id: 'agent-a', name: '助手' },
    },
    source: { canvasId: 'canvas-1', revision: 'rev-1', targetCardId: 'card-1' },
    targetCardId: 'card-1',
    agentId: 'agent-a',
    nextStep: '继续处理',
  });
  if (artifactIds.length) {
    context.nodes[0].messages[0].artifactIds = [...artifactIds];
    context.artifactIds = [...artifactIds];
    context.stats.artifactCount = artifactIds.length;
  }
  return context;
}

function artifactEntry(artifactId, content) {
  const bytes = Buffer.from(content, 'utf8');
  return {
    bytes,
    metadata: {
      artifactId,
      name: '报告.md',
      format: 'md',
      mime: 'text/markdown',
      bytes: bytes.length,
      sha256: sha256(bytes),
      status: 'ready',
      createdAt: '2026-10-25T00:00:00.000Z',
    },
  };
}

function fakeArtifacts(entries) {
  return {
    async read({ artifactId }) {
      const entry = entries[artifactId];
      if (!entry) {
        const error = new Error('文件不存在');
        error.code = 'ARTIFACT_NOT_FOUND';
        throw error;
      }
      return entry;
    },
  };
}

/** fake host：stage 时真实读取交付路径的字节，确保断言的是落盘内容而不是伪造回执 */
function fakeHost() {
  const calls = [];
  let files = 0;
  return {
    calls,
    async capabilities() {
      return {
        supported: true, available: true, home: true, read: true,
        manage: true, stageFile: true, agentsRead: true, missing: [], reason: null,
      };
    },
    async create(input) {
      calls.push(['create', input]);
      return { sessionId: 'sess-1' };
    },
    async isIdle() {
      calls.push(['isIdle']);
      return true;
    },
    async stage(input) {
      const bytes = await fs.readFile(input.path);
      files += 1;
      calls.push(['stage', { name: input.name, mime: input.mime, sha256: sha256(bytes), text: bytes.toString('utf8') }]);
      return { fileId: `file-${files}`, name: input.name, mime: input.mime };
    },
    async writeContext(input) {
      calls.push(['writeContext', { content: input.content, details: input.details }]);
      return { entryId: 'entry-1' };
    },
  };
}

function fakeSdk() {
  return {
    agents: {
      async list() {
        return { agents: [{ id: 'agent-a', state: 'active', lifecycle: 'active' }] };
      },
    },
  };
}

function countCalls(host, name) {
  return host.calls.filter(call => call[0] === name).length;
}

function stagedCalls(host) {
  return host.calls.filter(call => call[0] === 'stage').map(call => call[1]);
}

async function main() {
  const config = JSON.parse(process.argv[2] || '{}');
  const { dataDir, owner } = config;
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('child requires absolute dataDir');
  if (typeof owner !== 'string' || !owner) throw new Error('child requires owner');
  const artifactId = 'a'.repeat(32);
  const artifactBody = '# 报告\n\n这是真实产物正文。\n';
  const artifacts = fakeArtifacts({ [artifactId]: artifactEntry(artifactId, artifactBody) });
  const text = '交接正文：用户要求继续处理权限模型修复。';

  try {
    // 0) 策略在真实 PM 下的判定与 flags
    report.steps.usesSyncWrites = handoffUsesSynchronousWrites();
    const pmFlags = handoffWriteFlags('wx');
    report.steps.pmFlagsIsNumber = typeof pmFlags === 'number';
    report.steps.pmFlagsBits = [
      'O_WRONLY', 'O_CREAT', 'O_EXCL', 'O_NOFOLLOW', 'O_SYNC',
    ].filter(name => (pmFlags & constants[name]) === constants[name]);

    const host = fakeHost();
    const store = createHandoffStore({ dataDir, fs });
    const delivery = createHandoffDelivery({ dataDir });
    const service = createHandoffService({ sdk: fakeSdk(), dataDir, artifacts, host, store, delivery });

    // 1) prepare 只落私有动作，不触达宿主
    const prepared = await service.prepareAction({ owner, body: handoffContext({ artifactIds: [artifactId], text }) });
    report.steps.prepareState = prepared.action.state;
    report.steps.prepareHostCalls = host.calls.length;
    const actionId = prepared.action.actionId;

    // 2) confirm 走完整交付：产物 + 交接 Markdown，最终 ready
    const confirmed = await service.confirmAction({ owner, actionId });
    report.steps.confirmState = confirmed.action.state;
    report.steps.confirmCreateCalls = countCalls(host, 'create');
    const stages = stagedCalls(host);
    report.steps.stageCount = stages.length;
    report.steps.artifactStage = stages[0];
    report.steps.artifactStageMatches = stages[0]?.sha256 === sha256(Buffer.from(artifactBody, 'utf8'));
    report.steps.artifactStageName = stages[0]?.name || null;
    report.steps.archiveStage = stages[1] ? { name: stages[1].name, mime: stages[1].mime } : null;
    report.steps.archiveHasTranscript = Boolean(stages[1]?.text?.includes(text));
    report.steps.archiveHasReceipt = Boolean(stages[1]?.text?.includes('报告.md'));
    report.steps.archiveBytes = stages[1]?.text ? Buffer.byteLength(stages[1].text, 'utf8') : 0;
    const written = host.calls.find(call => call[0] === 'writeContext');
    report.steps.contextHasTranscript = Boolean(written?.[1]?.content?.includes(text));
    report.steps.contextHasArchiveReceipt = Boolean(written?.[1]?.content?.includes('handoff.md'));

    // 交付目录在 ready 前被清空：不应残留临时文件或私有产物
    const ownerKey = sha256(Buffer.from(owner, 'utf8'));
    const actionDir = path.join(dataDir, 'handoff-delivery', ownerKey, actionId);
    report.steps.actionDirRemoved = !(await fs.lstat(actionDir).then(() => true, error => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }));

    // 3) 同一 action 并发确认：只有一个 claim/一次 create
    const second = await service.prepareAction({ owner, body: handoffContext({ artifactIds: [artifactId], text }) });
    const before = countCalls(host, 'create');
    const results = await Promise.all([
      service.confirmAction({ owner, actionId: second.action.actionId }),
      service.confirmAction({ owner, actionId: second.action.actionId }),
    ]);
    report.steps.concurrentStates = results.map(result => result.action.state);
    report.steps.concurrentCreateDelta = countCalls(host, 'create') - before;
    report.steps.secondStagedFiles = stagedCalls(host).length - stages.length;

    // 4) 进程内重建 Store/Delivery/Service（相当于重启后重新装配）：不得再次 create/重发
    const restartedHost = fakeHost();
    const restarted = createHandoffService({
      sdk: fakeSdk(),
      dataDir,
      artifacts,
      host: restartedHost,
      store: createHandoffStore({ dataDir, fs }),
      delivery: createHandoffDelivery({ dataDir }),
    });
    const replay = await restarted.confirmAction({ owner, actionId });
    report.steps.replayState = replay.action.state;
    report.steps.replayHostCalls = restartedHost.calls.length;
    report.steps.replayPersisted = (await createHandoffStore({ dataDir, fs }).get({ owner, actionId }))?.action?.state;

    report.ok = true;
  } catch (error) {
    report.error = { code: error?.code || null, name: error?.name || null, message: error?.message || String(error) };
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

await main();
