import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createChatService } from '../lib/chat.js';
import { buildContextPlan } from '../ui/assets/panel-context-plan.js';

/*
 * 接线后【真实链路】组合回归（对应 Sol 复核要求）：
 * 1. 真实 chat 注册 + child rewrite：走 createChatService 的 HTTP 流入口，
 *    模型端口吐 create → revise 工具调用，验证双工具注册与真实 store 落盘的 lineage。
 * 2. 真实 engine onEvent：同节点归组 / 跨节点（子卡修父卡文件）归并 /
 *    ref-only 消息 / invalid receipt 可见报错。
 * 3. 真实 context planner：exclude 父节点后文档清单不泄漏；分支准入内正常投影。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = name => import(pathToFileURL(path.join(repoRoot, 'ui/assets', name)).href);
const [engineModule, cardsModule] = await Promise.all([load('panel-chat-engine.js'), load('panel-cards.js')]);

const OWNER_CTX = { get: key => key === 'appRequestContext' ? { appId: 'fork-chat', principal: { kind: 'app', principalId: 'owner-a' } } : undefined };

async function tempDataDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fork-real-e2e-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function ndjsonResponse(events, requestId) {
  return new Response(events.map(e => JSON.stringify(e)).join('\n') + '\n',
    { headers: { 'Content-Type': 'application/x-ndjson' } });
}

test('真实链路：chat 流入口 create→revise 双工具，真实 store 落盘 lineage 正确', async t => {
  const dir = await tempDataDir(t);
  const service = await import('../lib/document-artifacts.js');
  const artifacts = service.createArtifactService({ dataDir: dir });

  // 模型端口脚本：第一轮 create，第二轮 revise，第三轮收尾
  const script = [
    { tool: 'create_document', args: { filename: 'plan.md', content: '# 计划\n\n初版。' } },
    { tool: 'revise_document', args: null }, // baseArtifactId 动态填
    { text: '两份文件都好了。' },
  ];
  let round = 0;
  let createdId = null;
  // 从真实 store 里找最近生成的 md 作为修订基座（模型侧不可见回执，测试侧可见）
  const latestMd = async () => {
    const entries = [];
    const root = await fs.readdir(path.join(dir, 'artifacts')).catch(() => []);
    return root;
  };
  const models = {
    streamEvents(input) {
      const isChild = input.requestId?.startsWith('rev-');
      const stage = isChild ? null : script[Math.min(round, script.length - 1)];
      if (!isChild) round += 1;
      const current = isChild ? { child: true, text: '# 计划 v2\n\n修订版：把范围收窄。' } : stage;
      return (async function* () {
        if (current.tool) {
          let args = current.args;
          if (current.tool === 'revise_document') {
            // 从 artifact manifest 目录真实检索 create 产物
            const ownerDirs = await fs.readdir(path.join(dir, 'artifacts')).catch(() => []);
            let found = null;
            for (const od of ownerDirs) {
              const base = path.join(dir, 'artifacts', od);
              const subs = await fs.readdir(base).catch(() => []);
              for (const sub of subs) {
                try {
                  const rec = JSON.parse(await fs.readFile(path.join(base, sub, 'manifest.json'), 'utf8'));
                  if (rec.metadata?.format === 'md' && rec.metadata?.origin !== 'imported') found = rec.metadata.artifactId;
                } catch {}
              }
            }
            args = { baseArtifactId: found, instruction: '收窄范围' };
          }
          yield { type: 'tool-call', id: `call-${round - 1}`, name: current.tool, arguments: args };
        } else if (current.child) {
          yield { type: 'text-delta', delta: current.text };
          yield { type: 'done', assistant: { content: [{ type: 'text', text: current.text }] } };
          return;
        } else {
          yield { type: 'text-delta', delta: current.text };
        }
        yield { type: 'done', stopReason: current.tool ? 'toolUse' : 'endTurn', assistant: { content: [] } };
      })();
    },
  };

  const chat = createChatService(
    { models, logger: { info() {}, warn() {} } },
    { getAgentFullProfile: async () => ({ provider: 'p', model: 'm' }), dataDir: dir, artifactService: artifacts, timeoutMs: 5000 },
  );

  const response = await chat.handleStream({
    get: OWNER_CTX.get,
    req: { json: async () => ({ requestId: 'req-real-1', cardId: 'card-root', messages: [{ role: 'user', content: '先生成计划文档，然后把它修订为收窄范围的版本' }], modelRef: 'p/m' }) },
    json: (value, status = 200) => Response.json(value, { status }),
  });
  const text = await response.text();
  const events = text.trim().split('\n').map(line => JSON.parse(line));
  const toolResults = events.filter(e => e.type === 'tool-result');
  assert.equal(toolResults.length, 2, 'create + revise 两次工具结果');
  assert.ok(toolResults.every(e => e.ok === true));
  const created = toolResults[0].result;
  const revised = toolResults[1].result;
  assert.equal(revised.version, 2, '修订版 lineage 由真实 store 派生');
  assert.equal(revised.revisedFrom, created.artifactId);
  // 真实磁盘验证
  const exported = await artifacts.exportFile({ owner: JSON.stringify(['fork-chat', 'app', 'owner-a']), artifactId: revised.artifactId });
  const bytes = Buffer.from(exported.contentBase64, 'base64');
  assert.ok(bytes.toString('utf8').includes('收窄'), '修订正文真实落盘');
  assert.equal(events.at(-1).type, 'done');
});

function makeEngineHarness({ cards, events = [], resultText = '修订完成。' }) {
  const activeRequests = new Map();
  const issues = [];
  let saved = 0;
  const deps = {
    hana: {},
    // 真实驱动引擎事件回调：把注入的事件序列逐个交给 onEvent，与生产流一致
    runChat: async (_hana, _request, callbacks) => {
      for (const event of events) callbacks.onEvent(event);
      return { text: resultText };
    },
    ChatError: class extends Error {},
    safeDetail: v => String(v),
    activeRequests,
    getCards: () => cards,
    getSession: () => ({ generation: 1 }),
    getAgent: () => ({ id: 'a', name: 'A' }),
    getReasoningEffort: () => null,
    getAgentReasoningEffort: () => null,
    buildContextPlan: () => ({ isRequestReady: true, messages: [{ role: 'user', content: 'q' }] }),
    reportContextIssue: i => issues.push(i),
    getIsDisposed: () => false,
    canMutateCanvas: () => true,
    uniqueId: p => `${p}-1`,
    paintMessage: () => {},
    renderCards: () => {},
    scheduleSave: () => { saved += 1; },
    cardParentIds: card => (card.parentId ? [card.parentId] : []),
  };
  const engine = engineModule.createChatEngine(deps);
  return { engine, issues, saved };
}

const validMeta = (id, extra = {}) => ({
  artifactId: id, name: '文档.md', format: 'md', mime: 'text/markdown',
  bytes: 10, sha256: 'b'.repeat(64), createdAt: '2026-10-24T00:00:00.000Z',
  status: 'ready', ...extra,
});

test('真实引擎事件驱动：子卡修订父卡文件，跨节点归并回父卡原消息并留 refs', async () => {
  const v1 = validMeta('a'.repeat(32));
  const parentMsg = { role: 'assistant', status: 'completed', text: '这是初版', artifacts: [v1] };
  const parentCard = { id: 'card-parent', title: '父', x: 0, y: 0, width: 300, parentId: null, messages: [{ role: 'user', text: '做一份' }, parentMsg] };
  const childCard = { id: 'card-child', title: '子', x: 400, y: 0, width: 300, parentId: 'card-parent', messages: [] };
  const v2 = validMeta('c'.repeat(32), { name: '文档-v2.md', version: 2, revisedFrom: v1.artifactId, revisionRootId: v1.artifactId });
  const h = makeEngineHarness({
    cards: [parentCard, childCard],
    events: [
      { type: 'start', provider: 'p', model: 'm' },
      { type: 'tool-call', id: 'call-1', name: 'revise_document' },
      { type: 'tool-result', id: 'call-1', name: 'revise_document', ok: true, result: v2 },
    ],
    resultText: '已生成修订版。',
  });
  const accepted = await h.engine.sendCardPrompt(childCard, '把它收窄一点', { agent: { id: 'a', name: 'A' } });
  assert.equal(accepted, true, 'sendCardPrompt 正常接受');
  const childAsst = childCard.messages.find(m => m.role === 'assistant');
  assert.ok(childAsst, '本轮 assistant 消息存在');
  // 断言落在真实消息对象上（生产 onEvent 的效果），而非手动调用 helper
  assert.equal(childAsst.status, 'completed', '修订成功后完成');
  assert.equal(parentMsg.artifacts.length, 2, '父卡原消息版本组扩展为 2');
  assert.equal(parentMsg.artifacts[1].artifactId, v2.artifactId, 'v2 真实挂回父消息');
  assert.ok(!Array.isArray(childAsst.artifacts) || childAsst.artifacts.length === 0, '子卡本轮不重复出文件卡');
  const refs = childAsst.artifactRefs || [];
  assert.ok(refs.some(r => r.artifactId === v2.artifactId), '本轮消息保留 refs 供上下文定位');
});

test('真实 planner：exclude 父卡后其文档清单不进入子卡上下文，默认准入内正常投影', () => {
  const v1 = validMeta('a'.repeat(32));
  const parentCard = { id: 'cp', title: 'p', x: 0, y: 0, width: 300, parentId: null,
    messages: [{ role: 'user', text: '做一份' }, { role: 'assistant', status: 'completed', text: '见文档', artifacts: [v1] }] };
  const childCard = { id: 'cc', title: 'c', x: 400, y: 0, width: 300, parentId: 'cp',
    messages: [{ role: 'user', text: '继续' }, { role: 'assistant', status: 'completed', text: '好的' }] };
  // 默认（无 exclude）：父卡文档清单进入子卡上下文
  const plan = buildContextPlan({ cards: [parentCard, childCard], targetCard: childCard, pendingUserMessage: { role: 'user', text: '下一步' } });
  assert.ok(plan.isRequestReady !== false || plan.messages.length, 'plan 可编译');
  assert.ok(plan.messages.some(m => m.content.includes('a'.repeat(32))), '未排除时父卡文档引用进入上下文');
  // 父卡 exclude：贡献被跳过，文档清单不得泄漏
  const excludedParent = { ...parentCard, contextMode: 'exclude' };
  const plan2 = buildContextPlan({ cards: [excludedParent, childCard], targetCard: childCard, pendingUserMessage: { role: 'user', text: '下一步' } });
  assert.ok(!plan2.messages.some(m => m.content.includes('a'.repeat(32))), '被排除父卡的文档清单不得泄漏');
});

test('真实引擎事件驱动：invalid receipt（有 artifactId 但 sha 非法）必须可见报错', async () => {
  const card = { id: 'card-x', title: 't', x: 0, y: 0, width: 300, parentId: null, messages: [] };
  const badReceipt = { artifactId: 'd'.repeat(32), name: 'x.md', format: 'md', mime: 'text/markdown', bytes: 10, sha256: 'not-hex!', createdAt: '2026-10-24T00:00:00.000Z', status: 'ready' };
  const h = makeEngineHarness({
    cards: [card],
    events: [
      { type: 'start', provider: 'p', model: 'm' },
      { type: 'tool-call', id: 'call-1', name: 'create_document' },
      { type: 'tool-result', id: 'call-1', name: 'create_document', ok: true, result: badReceipt },
    ],
    resultText: '文件已生成，请查收。',
  });
  const accepted = await h.engine.sendCardPrompt(card, '生成文档', { agent: { id: 'a', name: 'A' } });
  assert.equal(accepted, true);
  const asst = card.messages.find(m => m.role === 'assistant');
  assert.ok(asst);
  // 断言真实生产路径的落点：引擎自己在 onEvent 里写的 deliverError
  assert.equal(asst.deliverError, '生成文件的回执无效', '字段级非法 receipt 引擎必须可见报错');
  assert.ok(!Array.isArray(asst.artifacts) || asst.artifacts.length === 0, '非法回执不得挂出文件卡');
  assert.ok(!Array.isArray(asst.deliveredFiles) || asst.deliveredFiles.length === 0, '非法回执不得漏入 legacy 交付');
});
