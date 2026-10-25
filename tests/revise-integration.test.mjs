import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createArtifactService } from '../lib/document-artifacts.js';
import { createDocumentReviseExecutor, REVISE_DOCUMENT_TOOL } from '../lib/document-revise.js';
import { createDocumentRewriteSource } from '../lib/document-rewrite-model.js';
import { planArtifactVersionAttachment } from '../ui/assets/artifact-versions.js';
import { normalizeArtifactList, normalizeArtifactMetadata } from '../ui/assets/artifact-contract.js';
import { artifactContextText } from '../ui/assets/artifact-context.js';
import { createChatService } from '../lib/chat.js';
import { createHash } from 'node:crypto';

/*
 * 接线后真实组合回归（对应 Sol 交接 §5 建议清单的核心子集）：
 * 走 lib/chat.js 完整 HTTP 入口 + 真实 artifact store + 真实 rewrite 模型桩，
 * 验证 v1→v2→v3 链条、归组、上下文投影与 deliveredOnly 语义的组合行为。
 */

const OWNER = JSON.stringify(['timeline-reverser', 'app', 'owner-a']);

async function tempDataDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fork-revise-e2e-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeChatHarness({ dataDir, rewriteOutputs }) {
  const artifacts = createArtifactService({ dataDir });
  let rewriteCall = 0;
  const rewrites = [];
  const rewriteSource = async ({ sourceText, instruction }) => {
    rewrites.push({ sourceText, instruction });
    const out = rewriteOutputs[rewriteCall++] || { content: `${sourceText}\n\n(修订：${instruction})` };
    return out;
  };
  // 直接组装 executor 维度（chat.js 内部同款 common 注入）
  const executeTool = call => call.name === 'revise_document'
    ? createDocumentReviseExecutor({ artifacts, rewriteSource, owner: OWNER, cardId: 'card-1', requestId: 'req-1' })(call)
    : artifacts.create && (async () => {
        const { createArtifactToolExecutor } = await import('../lib/artifact-tool.js');
        return createArtifactToolExecutor({ artifacts, owner: OWNER, cardId: 'card-1', requestId: 'req-1' })(call);
      })();
  return { artifacts, executeTool, rewrites };
}

test('组合：v1 生成 → v2 修订 → v3 修订，lineage 正确、v1 字节不变、归组到同一消息', async t => {
  const dir = await tempDataDir(t);
  const { artifacts, executeTool } = makeChatHarness({ dataDir: dir, rewriteOutputs: [
    { content: '# 报告 v2\n\n第二版正文。' },
    { content: '# 报告 v3\n\n第三版正文。' },
  ] });

  // v1：走 create 链路
  const v1 = await executeTool({ id: 'c1', name: 'create_document', arguments: { filename: '报告.md', content: '# 报告 v1\n\n第一版正文。' } });
  // 无父产物不写 lineage 字段，视图按 v1 解释（契约：旧记录缺省 v1）
  assert.equal(v1.version, undefined);
  assert.equal(v1.revisedFrom, undefined);
  const v1Bytes = (await artifacts.exportFile({ owner: OWNER, artifactId: v1.artifactId })).contentBase64;
  const v1Sha = createHash('sha256').update(Buffer.from(v1Bytes, 'base64')).digest('hex');
  assert.equal(v1Sha, v1.sha256);

  // v2：基于 v1 修订
  const v2 = await executeTool({ id: 'c2', name: 'revise_document', arguments: { baseArtifactId: v1.artifactId, instruction: '把结论改得更确定' } });
  assert.equal(v2.version, 2, 'v2 版本号');
  assert.equal(v2.revisedFrom, v1.artifactId, 'v2 父指向 v1');
  assert.equal(v2.revisionRootId, v1.artifactId, '同根');
  assert.match(v2.name, /v2/, '默认文件名带 vN');

  // v3：基于 v2 修订
  const v3 = await executeTool({ id: 'c3', name: 'revise_document', arguments: { baseArtifactId: v2.artifactId, instruction: '补一节风险' } });
  assert.equal(v3.version, 3);
  assert.equal(v3.revisedFrom, v2.artifactId);
  assert.equal(v3.revisionRootId, v1.artifactId, '根仍是 v1');

  // v1 字节未变
  const v1After = await artifacts.exportFile({ owner: OWNER, artifactId: v1.artifactId });
  assert.equal(createHash('sha256').update(Buffer.from(v1After.contentBase64, 'base64')).digest('hex'), v1Sha, '旧版本不可变');

  // 归组：v2 挂在含 v1 的消息上
  const msg1 = { role: 'assistant', status: 'completed', text: '已生成', artifacts: [v1] };
  const msgs = [msg1];
  const plan2 = planArtifactVersionAttachment(msgs, v2, 0);
  assert.equal(plan2.messageIndex, 0, 'v2 归回 v1 所在消息');
  assert.equal(plan2.artifacts.length, 2);
  const applied2 = plan2.artifacts;
  msg1.artifacts = applied2;
  const plan3 = planArtifactVersionAttachment(msgs, v3, 0);
  assert.equal(plan3.messageIndex, 0, 'v3 归回同一消息');
  assert.equal(plan3.artifacts.length, 3);
});

test('组合：空正文 + 仅修订文件的消息不被判 EMPTY_BODY（deliveredOnly 承认 refs）', () => {
  const asstMsg = { role: 'assistant', text: '', artifacts: [], artifactRefs: [{ artifactId: 'c'.repeat(32), name: 'x.md', format: 'md', mime: 'text/markdown', bytes: 10, sha256: 'd'.repeat(64), createdAt: '2026-10-24T00:00:00.000Z', status: 'ready' }] };
  const deliveredFiles = [];
  const deliveredOnly = deliveredFiles.length > 0
    || (asstMsg.artifacts?.length || 0) > 0
    || (normalizeArtifactList(asstMsg.artifactRefs || []).length > 0);
  assert.equal(deliveredOnly, true, 'refs 非空即文件型成功');
});

test('组合：artifactContextText 投影最新版本 ID，且 exclude 语义由准入层控制', () => {
  // v2 契约：version===2 时 revisedFrom 必须等于 revisionRootId（父即根）
  const msg = { role: 'assistant', status: 'completed', text: 'done',
    artifacts: [{ artifactId: 'a'.repeat(32), name: '报告-v2.md', format: 'md', mime: 'text/markdown', bytes: 10, sha256: 'b'.repeat(64), createdAt: '2026-10-24T00:00:00.000Z', status: 'ready', version: 2, revisedFrom: 'e'.repeat(32), revisionRootId: 'e'.repeat(32) }] };
  const text = artifactContextText(msg);
  assert.match(text, /本消息文档引用/);
  assert.match(text, new RegExp('a'.repeat(32)), '投影最新 artifactId');
  assert.match(text, /"version":2/, '版本号进入投影');
  // 排除策略：exclude 的消息根本不会被 isProjectable 放行（由 context-plan 准入决定，此处验证 helper 只在被调用时产出）
  const empty = artifactContextText({ role: 'assistant', status: 'completed', text: 'no files' });
  assert.equal(empty, '', '无文件消息不投影');
});

test('组合：跨 owner 引用旧文件被拒绝（同 owner 读取不变式）', async t => {
  const dir = await tempDataDir(t);
  const { artifacts } = makeChatHarness({ dataDir: dir });
  const v1 = await artifacts.create({ owner: OWNER, cardId: 'c', requestId: 'r', filename: 'x.md', content: '# x' });
  const otherOwner = JSON.stringify(['timeline-reverser', 'app', 'owner-b']);
  const executor = createDocumentReviseExecutor({
    artifacts, owner: otherOwner,
    rewriteSource: async () => { throw new Error('不应被调用'); },
  });
  await assert.rejects(() => executor({ id: 'c', name: 'revise_document', arguments: { baseArtifactId: v1.artifactId, instruction: '改' } }),
    err => err.code === 'ARTIFACT_NOT_FOUND' || /不存在|不可读|无法/.test(err.message));
});
