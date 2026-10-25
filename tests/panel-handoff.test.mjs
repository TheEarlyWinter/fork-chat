import test from 'node:test';
import assert from 'node:assert/strict';

import { createForkSessionController } from '../ui/assets/fork-session-controller.js';
import { createDocumentPipeline } from '../ui/assets/panel-documents.js';
import { createPanelHandoff } from '../ui/assets/panel-handoff.js';
import { createHandoffView } from '../ui/assets/panel-handoff-view.js';
import { buildHandoffContext } from '../ui/assets/fork-handoff-context.js';
import { HANDOFF_LIMITS } from '../ui/assets/fork-handoff-contract.js';
import { parentIdsOf } from '../ui/assets/fork-snapshot.js';
import { loadPanel } from './helpers/panel-harness.mjs';
import {
  artifactReceipt,
  createFakeDocument,
  deferred,
  makeAction,
  makeCards,
  makeControllerDeps,
  response,
  waitFor,
} from './fixtures/handoff-fixtures.mjs';

const ACTION_A = `ha_${'1'.repeat(32)}`;
const ACTION_B = `ha_${'2'.repeat(32)}`;

async function openController(deps, targetCardId = 'target') {
  const handoff = createPanelHandoff(deps);
  await handoff.open(targetCardId);
  const dialog = deps.documentRef.body.querySelector('.handoff-dialog');
  assert.ok(dialog, '交接预览必须挂载');
  return { handoff, dialog };
}

async function waitForPrepare(dialog) {
  await waitFor(
    () => dialog.querySelector('.btn-handoff-confirm')?.style.display === 'inline-block',
    { message: 'prepare 没有进入 prepared 阶段' },
  );
}

async function waitForRecover(dialog) {
  await waitFor(
    () => dialog.querySelector('.btn-handoff-recover')?.style.display === 'inline-block',
    { message: 'confirm 失败后没有进入查询阶段' },
  );
}

function validContextForView() {
  const artifact = artifactReceipt();
  const content = '资料正文第一行\n资料正文第二行';
  const snapshot = {
    cards: [
      {
        id: 'root',
        parentId: null,
        contextMode: 'exclude',
        title: '被排除的旧根',
        messages: [{ role: 'assistant', text: '旧根正文' }],
      },
      {
        id: 'target',
        parentId: 'root',
        title: '真实目标节点',
        isDoc: true,
        docContent: content,
        docMeta: { name: 'notes.md', type: 'md', charCount: content.length },
        draft: '尚未发送的草稿内容',
        stagedAttachments: [{ name: 'queued.txt', content: '暂存附件' }],
        contextRefs: [{
          id: 'ref-1',
          sourceCardId: 'deleted-source',
          sourceTitle: '已经删除的来源',
          text: '保存时引用的正文',
        }],
        messages: [
          { role: 'user', text: '用户真实正文' },
          {
            role: 'assistant',
            agentName: 'Agent 1',
            status: 'failed',
            text: '助手失败正文',
            attachments: [{ name: 'trace.txt', extension: 'txt', content: '文本附件正文' }],
            artifacts: [artifact],
          },
          { role: 'assistant', localOnly: true, text: '只在本地显示的提示' },
        ],
      },
    ],
    agent: { id: 'a1', name: 'Agent 1', provider: 'test', model: 'test-model' },
  };
  return buildHandoffContext({
    snapshot,
    source: { canvasId: 'canvas-rich', revision: 7, targetCardId: 'target' },
    targetCardId: 'target',
    agentId: 'a1',
    nextStep: '请先核对资料，再继续推导。',
  });
}

// 保留原有的正确绿对照：快照 getter 只读已保存版本，并返回深拷贝。
test('GREEN fork-session-controller: getSavedSnapshot guards unready/dirty and returns a deep copy', async () => {
  let savedRecord = {
    id: 'canvas-durable-123',
    revision: 2,
    snapshot: {
      cards: [{ id: 'card-1', title: 'Card 1', messages: [{ role: 'user', text: 'hello' }] }],
      view: { x: 0, y: 0, scale: 1 },
    },
  };
  let captured = JSON.parse(JSON.stringify(savedRecord.snapshot));
  captured.cards[0].x = 80;
  captured.cards[0].y = 80;
  captured.cards[0].width = 340;
  captured.cards[0].height = 240;
  const store = {
    ensure: async () => savedRecord,
    list: async () => ({ activeId: savedRecord.id, sessions: [savedRecord] }),
    get: async () => savedRecord,
    save: async (id, revision, snapshot) => {
      savedRecord = { id, revision: revision + 1, snapshot };
      return savedRecord;
    },
  };
  const controller = createForkSessionController({
    store,
    capture: () => captured,
    apply: async () => {},
    cancelPending: () => {},
  });

  assert.throws(() => controller.getSavedSnapshot(), error => error.code === 'SESSION_NOT_SAVED');
  await controller.init();
  const first = controller.getSavedSnapshot();
  first.snapshot.cards[0].title = '外部篡改';
  assert.equal(controller.getSavedSnapshot().snapshot.cards[0].title, 'Card 1');

  captured = {
    ...captured,
    cards: [{ id: 'card-1', title: '未保存变化', x: 80, y: 80, width: 340, height: 240, messages: [{ role: 'user', text: 'hello' }] }],
  };
  controller.scheduleSave();
  assert.throws(() => controller.getSavedSnapshot(), error => error.code === 'SESSION_NOT_SAVED');
  await controller.flush(true);
  assert.equal(controller.getSavedSnapshot().snapshot.cards[0].title, '未保存变化');
});

// 保留原有的正确绿对照：测试公开 isPending，不触碰 documentTasks 私有 Map。
test('GREEN panel-documents: isPending tracks a real in-flight parse task by card id', async () => {
  const textResult = deferred();
  const pipeline = createDocumentPipeline({
    hana: {},
    canMutateCanvas: () => true,
    isDisposed: () => false,
    inactiveError: () => new Error('inactive'),
    abortable: promise => promise,
    requestHost: async () => ({ ok: true, json: async () => ({}) }),
    safeDetail: String,
    waitForParser: async () => {},
  });
  assert.equal(pipeline.isPending('card-1'), false);

  const task = pipeline.extractDocumentFile({
    name: 'pending.txt',
    size: 10,
    text: () => textResult.promise,
  }, 'card-1');
  await waitFor(() => pipeline.isPending('card-1'));
  assert.equal(pipeline.isPending('other-card'), false);
  textResult.resolve('已解析文本');
  await task;
  assert.equal(pipeline.isPending('card-1'), false);
});

// C1：捕获真实 panel.js 组合根注入对象；不替换 handoff 实现。
test('[C1] real panel composition root reads the late session controller through a getter', async () => {
  const { panel, handoffCompositions } = await loadPanel();
  try {
    const composition = handoffCompositions.at(-1);
    assert.ok(composition, 'panel.js 必须实际创建 handoff controller');
    assert.equal(typeof composition.getSessionController, 'function', '组合根必须注入惰性 sessionController getter');
    assert.ok(composition.getSessionController(), 'getter 返回的控制器不得是 null');
    assert.equal(composition.getSessionController().state.ready, true, '真实控制器应已完成初始化');
  } finally {
    await panel.dispose();
  }
});

// C2：从真实组合根捕获的 callback 必须接收 ID，并读取 activeRequests。
test('[C2] real composition busy callback blocks the active request id and not an unrelated id', async () => {
  const streamStarted = deferred();
  const { panel, handoffCompositions } = await loadPanel({
    onRequest: async route => {
      if (route === 'api/chat/stream') {
        streamStarted.resolve();
        return new Response(new ReadableStream({ start() {} }), {
          headers: { 'Content-Type': 'application/x-ndjson' },
        });
      }
      return Response.json({});
    },
  });
  const pending = panel.sendCardPrompt(panel.getCards()[0], '保持请求挂起');
  try {
    await streamStarted.promise;
    const composition = handoffCompositions.at(-1);
    assert.ok(composition, '必须捕获真实组合根依赖');
    const targetId = panel.getCards()[0].id;
    assert.equal(composition.isCardBusy(targetId), true, 'activeRequests 必须按卡片 ID 响应');
    assert.equal(composition.isCardBusy('unrelated-card'), false, '无关卡片不能被 activeRequests 阻断');
  } finally {
    await panel.dispose();
    await pending;
  }
});

// C2：从真实组合根捕获的 callback 还必须接入真实 documentPipeline.isPending。
test('[C2] real composition busy callback blocks documentPipeline.isPending by id', async () => {
  const parser = deferred();
  const { panel, handoffCompositions, documentPipelines } = await loadPanel({
    onRequest: async route => {
      if (route === '/api/document/parse') {
        return { ok: true, json: () => parser.promise };
      }
      return Response.json({});
    },
  });
  const targetId = panel.getCards()[0].id;
  const task = panel.extractDocumentFile({
    name: 'pending.pdf',
    size: 10,
    arrayBuffer: async () => new ArrayBuffer(10),
  }, targetId);
  try {
    const pipeline = documentPipelines.at(-1)?.pipeline;
    assert.ok(pipeline, 'panel.js 必须实际创建 documentPipeline');
    await waitFor(() => pipeline.isPending(targetId));
    const composition = handoffCompositions.at(-1);
    assert.equal(composition.isCardBusy(targetId), true, 'documentPipeline 必须按卡片 ID 响应');
    assert.equal(composition.isCardBusy('unrelated-card'), false, '无关卡片的文档任务不能阻断交接');
  } finally {
    parser.resolve({ ok: true, jobId: 'job-1' });
    await new Promise(resolve => setImmediate(resolve));
    await panel.dispose();
    await task;
  }
});

// C2/I1：混合单父、多父以及 exclude 节点必须走同一套真实 parentIdsOf 规则。
test('[C2/I1] busy traversal merges parentId and parentIds, including excluded ancestors', async () => {
  const cards = [
    { id: 'root', parentId: null, title: '根', messages: [{ role: 'user', text: '根' }] },
    { id: 'single-parent', parentId: 'root', title: '单父', messages: [{ role: 'user', text: '单父' }] },
    { id: 'excluded-parent', parentId: 'root', contextMode: 'exclude', title: '排除父', messages: [{ role: 'user', text: '排除父' }] },
    { id: 'multi-parent', parentId: 'root', title: '多父', messages: [{ role: 'user', text: '多父' }] },
    {
      id: 'target',
      parentId: 'single-parent',
      parentIds: ['excluded-parent', 'multi-parent'],
      title: '目标',
      messages: [{ role: 'assistant', text: '目标' }],
    },
  ];
  const checks = [];
  const deps = makeControllerDeps({
    cards,
    isCardBusy: id => {
      checks.push(id);
      return id === 'single-parent';
    },
  });
  const handoff = createPanelHandoff(deps);
  await handoff.open('target');
  try {
    const expected = new Set(['target', ...parentIdsOf(cards.at(-1)), 'root']);
    assert.deepEqual(new Set(checks), expected, '必须检查目标、单父、多父及其祖先，不能丢 parentId');
    assert.ok(deps.flashMessages.some(message => message.includes('正在处理')), '忙碌祖先必须阻断交接');
    assert.equal(deps.documentRef.body.querySelector('.handoff-dialog'), null, '忙碌祖先不能打开新预览');
  } finally {
    handoff.dispose();
  }
});

// I1：节点数不超过 300，但重复边超过旧迭代预算时，迟到的忙碌祖先仍必须被检出。
test('[I1] dense duplicate parent edges do not silently hide a late busy ancestor', async () => {
  const duplicateCount = HANDOFF_LIMITS.maxNodes * 40;
  const parentIds = ['late-busy', ...Array.from({ length: duplicateCount }, () => 'repeat-parent')];
  const cards = [
    { id: 'root', parentId: null, messages: [{ role: 'user', text: 'root' }] },
    { id: 'repeat-parent', parentId: 'root', messages: [{ role: 'user', text: 'repeat' }] },
    { id: 'late-busy', parentId: 'root', messages: [{ role: 'user', text: 'busy' }] },
    { id: 'target', parentIds, title: '重复边目标', messages: [{ role: 'assistant', text: 'target' }] },
  ];
  assert.ok(cards.length <= HANDOFF_LIMITS.maxNodes, '这个用例只应使用 300 个以内的节点');
  const deps = makeControllerDeps({ cards, isCardBusy: id => id === 'late-busy' });
  const handoff = createPanelHandoff(deps);
  await handoff.open('target');
  try {
    assert.ok(deps.flashMessages.some(message => message.includes('正在处理')), '迟到的忙碌祖先不能被重复边吞掉');
    assert.equal(deps.documentRef.body.querySelector('.handoff-dialog'), null);
  } finally {
    handoff.dispose();
  }
});

// I1：真实共享上限是 maxNodes=300；超限必须拒绝，不得截断后继续。
test('[I1] dependency overflow uses HANDOFF_LIMITS.maxNodes and rejects explicitly', async () => {
  const cards = Array.from({ length: HANDOFF_LIMITS.maxNodes + 1 }, (_, index) => ({
    id: `node-${index}`,
    parentId: index === 0 ? null : `node-${index - 1}`,
    title: `节点 ${index}`,
    messages: [{ role: 'user', text: `正文 ${index}` }],
  }));
  const deps = makeControllerDeps({ cards });
  const handoff = createPanelHandoff(deps);
  await handoff.open(cards.at(-1).id);
  try {
    assert.ok(
      deps.flashMessages.some(message => message.includes(String(HANDOFF_LIMITS.maxNodes)) && /超过|上限|超限/.test(message)),
      '超过 300 个节点必须给出真实上限错误，不得依赖不存在的 maxAncestors',
    );
    assert.equal(deps.documentRef.body.querySelector('.handoff-dialog'), null);
  } finally {
    handoff.dispose();
  }
});

// I3：view.open 的真实签名是 { context, agents, ... }，上下文来自真实 builder。
test('[I3] real DTO preview renders messages, roles, failed status, text attachments, and artifacts', () => {
  const documentRef = createFakeDocument();
  const view = createHandoffView({ documentRef });
  const context = validContextForView();
  view.open({ context, agents: [{ id: 'a1', name: 'Agent 1' }], selectedAgentId: 'a1' });
  try {
    const dialog = documentRef.body.querySelector('.handoff-dialog');
    assert.ok(dialog);
    const contents = dialog.querySelectorAll('.handoff-node-content');
    assert.ok(contents.length > 0);
    const text = dialog.textContent;
    assert.ok(text.includes('用户真实正文'), '用户正文必须可见');
    assert.ok(text.includes('助手失败正文'), '助手正文必须可见');
    assert.ok(text.includes('未完成'), '失败状态必须可见，不能伪装成已完成');
    assert.ok(text.includes('trace.txt') && text.includes('文本附件正文'), '文本附件必须可见');
    assert.ok(text.includes(context.artifactIds[0]), '真实 artifactIds 必须可见');
    assert.equal(text.includes('(无正文)'), false, '真实 messages 不得退化成无正文');
  } finally {
    view.close();
  }
});

test('[I3] real DTO preview renders doc, refs, exclusions, unsent gaps, and next-step text', () => {
  const documentRef = createFakeDocument();
  const view = createHandoffView({ documentRef });
  const context = validContextForView();
  view.open({ context, agents: [{ id: 'a1', name: 'Agent 1' }], selectedAgentId: 'a1' });
  try {
    const text = documentRef.body.querySelector('.handoff-dialog').textContent;
    assert.ok(text.includes('资料正文第一行'), '资料正文必须可见');
    assert.ok(text.includes('notes.md'), '资料名称必须可见');
    assert.ok(text.includes('保存时引用的正文'), 'refs 必须可见');
    assert.ok(text.includes('被排除的旧根'), 'exclusions 必须可见');
    assert.ok(text.includes('queued.txt'), '暂存附件缺口必须可见');
    assert.ok(text.includes(String(context.unsent[0].draftChars)), '草稿缺口统计必须可见');
    assert.ok(text.includes(context.nextStep), '下一步要求必须可见');
  } finally {
    view.close();
  }
});

test('[I3] real DTO preview renders notice.message and every real stats field without object coercion', () => {
  const documentRef = createFakeDocument();
  const view = createHandoffView({ documentRef });
  const context = validContextForView();
  view.open({ context, agents: [{ id: 'a1', name: 'Agent 1' }], selectedAgentId: 'a1' });
  try {
    const dialog = documentRef.body.querySelector('.handoff-dialog');
    const noticesText = dialog.querySelector('.handoff-notices')?.textContent || '';
    for (const notice of context.notices) assert.ok(noticesText.includes(notice.message), `缺少 notice.message: ${notice.code}`);
    assert.equal(dialog.textContent.includes('[object Object]'), false, 'notice 对象不得被强制转成 [object Object]');
    const summary = dialog.querySelector('.handoff-meta-summary')?.textContent || '';
    assert.ok(summary.includes(String(context.stats.nodeCount)), 'nodeCount 必须进入摘要');
    assert.ok(summary.includes(String(context.stats.messageCount)), 'messageCount 必须进入摘要');
    assert.ok(summary.includes(String(context.stats.transcriptBytes)), 'transcriptBytes 必须进入摘要');
  } finally {
    view.close();
  }
});

// I6：默认 Agent 只能匹配保存快照里的 snapshot.agent.id，不能猜首项。
test('[I6] agent selection leaves an empty option when snapshot agent is unavailable', async () => {
  const prepareCalls = [];
  const deps = makeControllerDeps({
    snapshotAgentId: 'agent-not-installed',
    agents: [{ id: 'agent-sol', name: 'Sol' }],
    onRequest: (path, init) => {
      if (path === '/api/handoff/prepare') prepareCalls.push(init);
      return undefined;
    },
  });
  const { handoff, dialog } = await openController(deps);
  try {
    const select = dialog.querySelector('.handoff-agent-select');
    assert.equal(select.value, '', '不存在匹配 Agent 时必须留空，不能默认首项');
    dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prepareCalls.length, 0, '空选 Agent 不得发起 prepare');
  } finally {
    handoff.dispose();
  }
});

// I2：nextStep 在 prepare await 期间变化，迟到 action 必须作废。
test('[I2] next-step input invalidates an in-flight prepare response', async () => {
  const prepareGate = deferred();
  let prepareStarted;
  const prepareStartedSignal = new Promise(resolve => { prepareStarted = resolve; });
  const confirmCalls = [];
  const deps = makeControllerDeps({
    onRequest: (path, init) => {
      if (path === '/api/handoff/prepare') {
        prepareStarted();
        return prepareGate.promise;
      }
      if (path === '/api/handoff/confirm') confirmCalls.push(init);
      return undefined;
    },
  });
  const { handoff, dialog } = await openController(deps);
  try {
    dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
    await prepareStartedSignal;
    const input = dialog.querySelector('.handoff-next-step');
    input.value = '草稿 B';
    input.dispatchEvent({ type: 'input' });
    prepareGate.resolve(response({ ok: true, action: makeAction({ actionId: ACTION_A }) }));
    await new Promise(resolve => setImmediate(resolve));
    const confirm = dialog.querySelector('.btn-handoff-confirm');
    if (confirm.style.display === 'inline-block') confirm.dispatchEvent({ type: 'click' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(confirmCalls.length, 0, '输入变化后不得确认旧 action');
    assert.equal(confirm.style.display, 'none', '迟到旧 action 不得重新显示确认按钮');
  } finally {
    handoff.dispose();
  }
});

// I2：Agent 在 prepare await 期间变化，迟到 action 必须作废。
test('[I2] agent change invalidates an in-flight prepare response', async () => {
  const prepareGate = deferred();
  const prepareStartedSignal = deferred();
  const confirmCalls = [];
  const deps = makeControllerDeps({
    agents: [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }],
    onRequest: (path, init) => {
      if (path === '/api/handoff/prepare') {
        prepareStartedSignal.resolve();
        return prepareGate.promise;
      }
      if (path === '/api/handoff/confirm') confirmCalls.push(init);
      return undefined;
    },
  });
  const { handoff, dialog } = await openController(deps);
  try {
    dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
    await prepareStartedSignal.promise;
    const select = dialog.querySelector('.handoff-agent-select');
    select.value = 'a2';
    select.dispatchEvent({ type: 'change' });
    prepareGate.resolve(response({ ok: true, action: makeAction({ actionId: ACTION_A, agentId: 'a1' }) }));
    await new Promise(resolve => setImmediate(resolve));
    const confirm = dialog.querySelector('.btn-handoff-confirm');
    if (confirm.style.display === 'inline-block') confirm.dispatchEvent({ type: 'click' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(confirmCalls.length, 0, 'Agent 变化后不得确认旧 action');
    assert.equal(confirm.style.display, 'none');
  } finally {
    handoff.dispose();
  }
});

// 已完成 prepare 后的编辑是正确的清除路径，保留为 GREEN 对照。
test('GREEN prepared preview: next-step and Agent edits clear the prepared action', async t => {
  await t.test('next-step edit', async () => {
    let confirmCalls = 0;
    const deps = makeControllerDeps({
      onRequest: path => {
        if (path === '/api/handoff/confirm') confirmCalls++;
        return undefined;
      },
    });
    const { handoff, dialog } = await openController(deps);
    try {
      dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
      await waitForPrepare(dialog);
      const input = dialog.querySelector('.handoff-next-step');
      input.value = '新草稿';
      input.dispatchEvent({ type: 'input' });
      dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(confirmCalls, 0);
    } finally {
      handoff.dispose();
    }
  });

  await t.test('Agent edit', async () => {
    let confirmCalls = 0;
    const deps = makeControllerDeps({
      agents: [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }],
      onRequest: path => {
        if (path === '/api/handoff/confirm') confirmCalls++;
        return undefined;
      },
    });
    const { handoff, dialog } = await openController(deps);
    try {
      dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
      await waitForPrepare(dialog);
      const select = dialog.querySelector('.handoff-agent-select');
      select.value = 'a2';
      select.dispatchEvent({ type: 'change' });
      dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(confirmCalls, 0);
    } finally {
      handoff.dispose();
    }
  });
});

// C3：flush await 期间 dispose，旧 open 只能安静退出。
test('GREEN [C3] dispose during flush does not reject or open a dialog', async () => {
  const flushGate = deferred();
  const flushStarted = deferred();
  const deps = makeControllerDeps();
  deps.sessionController.flush = async () => {
    flushStarted.resolve();
    return flushGate.promise;
  };
  const handoff = createPanelHandoff(deps);
  const opening = handoff.open('target');
  await flushStarted.promise;
  handoff.dispose();
  flushGate.resolve();
  await assert.doesNotReject(opening);
  assert.equal(deps.documentRef.body.querySelector('.handoff-dialog'), null);
});

// C3：agents await 期间 dispose，不能把 view 置空后再调用它。
test('[C3] dispose during agents await drops the old response without TypeError', async () => {
  const agentsGate = deferred();
  const agentsStarted = deferred();
  const deps = makeControllerDeps({
    onRequest: path => {
      if (path === '/api/agents') {
        agentsStarted.resolve();
        return agentsGate.promise;
      }
      return undefined;
    },
  });
  const handoff = createPanelHandoff(deps);
  const opening = handoff.open('target');
  await agentsStarted.promise;
  handoff.dispose();
  agentsGate.resolve(response({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }));
  await assert.doesNotReject(opening);
  assert.equal(deps.documentRef.body.querySelector('.handoff-dialog'), null);
});

// C3：关闭 A 后重开 B，A 的 prepare 迟到响应不得污染 B。
test('[C3] close and reopen A/B drops a pending prepare response', async () => {
  const prepareGate = deferred();
  const prepareStarted = deferred();
  let prepareCalls = 0;
  const deps = makeControllerDeps({
    onRequest: path => {
      if (path === '/api/handoff/prepare') {
        prepareCalls++;
        if (prepareCalls === 1) {
          prepareStarted.resolve();
          return prepareGate.promise;
        }
      }
      return undefined;
    },
  });
  const handoff = createPanelHandoff(deps);
  await handoff.open('target');
  const dialogA = deps.documentRef.body.querySelector('.handoff-dialog');
  dialogA.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
  await prepareStarted.promise;
  dialogA.querySelector('.btn-handoff-close').dispatchEvent({ type: 'click' });
  await handoff.open('target');
  const dialogB = deps.documentRef.body.querySelector('.handoff-dialog');
  prepareGate.resolve(response({ ok: true, action: makeAction({ actionId: ACTION_A }) }));
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(dialogB.querySelector('.btn-handoff-confirm').style.display, 'none', 'A 的迟到 prepare 不得点亮 B 的确认');
  } finally {
    handoff.dispose();
  }
});

// C3：confirm await 期间关闭 A 重开 B，A 的 ready 不得污染 B。
test('[C3] close and reopen A/B drops a pending confirm response', async () => {
  const confirmGate = deferred();
  const confirmStarted = deferred();
  const deps = makeControllerDeps({
    onRequest: path => {
      if (path === '/api/handoff/confirm') {
        confirmStarted.resolve();
        return confirmGate.promise;
      }
      return undefined;
    },
  });
  const handoff = createPanelHandoff(deps);
  await handoff.open('target');
  let dialog = deps.documentRef.body.querySelector('.handoff-dialog');
  dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
  await waitForPrepare(dialog);
  dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
  await confirmStarted.promise;
  dialog.querySelector('.btn-handoff-close').dispatchEvent({ type: 'click' });
  await handoff.open('target');
  dialog = deps.documentRef.body.querySelector('.handoff-dialog');
  confirmGate.resolve(response({ ok: true, action: makeAction({ actionId: ACTION_A, state: 'ready', sessionId: 'sess-a', entryId: 'entry-a' }) }));
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(dialog.querySelector('.btn-handoff-focus').style.display, 'none', 'A 的迟到 confirm 不得点亮 B 的 focus');
  } finally {
    handoff.dispose();
  }
});

// C3：query await 期间关闭 A 重开 B，A 的 ready 查询不得污染 B。
test('[C3] close and reopen A/B drops a pending query response', async () => {
  const queryGate = deferred();
  const queryStarted = deferred();
  const deps = makeControllerDeps({
    onRequest: (path) => {
      if (path === '/api/handoff/confirm') throw Object.assign(new Error('network'), { status: 504 });
      if (path.startsWith('/api/handoff/actions/')) {
        queryStarted.resolve();
        return queryGate.promise;
      }
      return undefined;
    },
  });
  const handoff = createPanelHandoff(deps);
  await handoff.open('target');
  let dialog = deps.documentRef.body.querySelector('.handoff-dialog');
  dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
  await waitForPrepare(dialog);
  dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
  await waitForRecover(dialog);
  dialog.querySelector('.btn-handoff-recover').dispatchEvent({ type: 'click' });
  await queryStarted.promise;
  dialog.querySelector('.btn-handoff-close').dispatchEvent({ type: 'click' });
  await handoff.open('target');
  dialog = deps.documentRef.body.querySelector('.handoff-dialog');
  queryGate.resolve(response({ ok: true, action: makeAction({ actionId: ACTION_A, state: 'ready', sessionId: 'sess-a', entryId: 'entry-a' }) }));
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(dialog.querySelector('.btn-handoff-focus').style.display, 'none', 'A 的迟到 query 不得点亮 B 的 focus');
  } finally {
    handoff.dispose();
  }
});

// C3：focus await 前切换画布，不能再向旧会话发起 focus。
test('[C3] canvas switch before focus drops the old focus operation', async () => {
  let focusCalls = 0;
  const deps = makeControllerDeps({
    focus: async () => { focusCalls++; },
  });
  const { handoff, dialog } = await openController(deps);
  try {
    dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
    await waitForPrepare(dialog);
    dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
    await waitFor(() => dialog.querySelector('.btn-handoff-focus')?.style.display === 'inline-block');
    deps.state.activeId = 'canvas-2';
    deps.state.generation = 2;
    dialog.querySelector('.btn-handoff-focus').dispatchEvent({ type: 'click' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(focusCalls, 0, '切换画布后不得 focus 旧 action 的会话');
  } finally {
    handoff.dispose();
  }
});

// C3：canvas switch 在 prepare/confirm/query await 中也必须丢弃迟到结果。
test('[C3] canvas switch matrix drops prepare, confirm, and query responses', async t => {
  await t.test('prepare', async () => {
    const gate = deferred();
    const started = deferred();
    const deps = makeControllerDeps({ onRequest: path => {
      if (path === '/api/handoff/prepare') { started.resolve(); return gate.promise; }
      return undefined;
    } });
    const { handoff, dialog } = await openController(deps);
    try {
      dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
      await started.promise;
      deps.state.activeId = 'canvas-2'; deps.state.generation = 2;
      gate.resolve(response({ ok: true, action: makeAction({ actionId: ACTION_A }) }));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(dialog.querySelector('.btn-handoff-confirm').style.display, 'none');
    } finally { handoff.dispose(); }
  });

  await t.test('confirm', async () => {
    const gate = deferred();
    const started = deferred();
    const deps = makeControllerDeps({ onRequest: path => {
      if (path === '/api/handoff/confirm') { started.resolve(); return gate.promise; }
      return undefined;
    } });
    const { handoff, dialog } = await openController(deps);
    try {
      dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
      await waitForPrepare(dialog);
      dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
      await started.promise;
      deps.state.activeId = 'canvas-2'; deps.state.generation = 2;
      gate.resolve(response({ ok: true, action: makeAction({ actionId: ACTION_A, state: 'ready', sessionId: 'sess-a', entryId: 'entry-a' }) }));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(dialog.querySelector('.btn-handoff-focus').style.display, 'none');
    } finally { handoff.dispose(); }
  });

  await t.test('query', async () => {
    const gate = deferred();
    const started = deferred();
    const deps = makeControllerDeps({ onRequest: path => {
      if (path === '/api/handoff/confirm') throw Object.assign(new Error('network'), { status: 504 });
      if (path.startsWith('/api/handoff/actions/')) { started.resolve(); return gate.promise; }
      return undefined;
    } });
    const { handoff, dialog } = await openController(deps);
    try {
      dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
      await waitForPrepare(dialog);
      dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
      await waitForRecover(dialog);
      dialog.querySelector('.btn-handoff-recover').dispatchEvent({ type: 'click' });
      await started.promise;
      deps.state.activeId = 'canvas-2'; deps.state.generation = 2;
      gate.resolve(response({ ok: true, action: makeAction({ actionId: ACTION_A, state: 'ready', sessionId: 'sess-a', entryId: 'entry-a' }) }));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(dialog.querySelector('.btn-handoff-focus').style.display, 'none');
    } finally { handoff.dispose(); }
  });
});

// 各程序入口都必须单飞；这里每个入口独立执行，避免一个断言短路其它入口。
test('[C3] open, prepare, query, and focus are programmatically single-flight', async t => {
  await t.test('open single-flight', async () => {
    const gate = deferred();
    let agentCalls = 0;
    const deps = makeControllerDeps({ onRequest: path => {
      if (path === '/api/agents') { agentCalls++; return gate.promise; }
      return undefined;
    } });
    const handoff = createPanelHandoff(deps);
    const first = handoff.open('target');
    const second = handoff.open('target');
    await waitFor(() => agentCalls > 0);
    assert.equal(agentCalls, 1, '重复 open 只能读取一次 Agent 列表');
    gate.resolve(response({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }));
    await Promise.all([first, second]);
    handoff.dispose();
  });

  await t.test('prepare single-flight', async () => {
    const gate = deferred();
    const secondGate = deferred();
    const started = deferred();
    let prepareCalls = 0;
    const deps = makeControllerDeps({ onRequest: path => {
      if (path === '/api/handoff/prepare') {
        prepareCalls++;
        if (prepareCalls === 1) { started.resolve(); return gate.promise; }
        return secondGate.promise;
      }
      return undefined;
    } });
    const { handoff, dialog } = await openController(deps);
    try {
      const button = dialog.querySelector('.btn-handoff-prepare');
      button.dispatchEvent({ type: 'click' });
      button.dispatchEvent({ type: 'click' });
      await started.promise;
      assert.equal(prepareCalls, 1, '重复 prepare 只能发一个 POST');
      const prepared = response({ ok: true, action: makeAction({ actionId: ACTION_A }) });
      gate.resolve(prepared);
      secondGate.resolve(prepared);
      await waitForPrepare(dialog);
      for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
    } finally { handoff.dispose(); }
  });

  await t.test('query single-flight', async () => {
    const gate = deferred();
    const secondGate = deferred();
    const started = deferred();
    let queryCalls = 0;
    const deps = makeControllerDeps({ onRequest: path => {
      if (path === '/api/handoff/confirm') throw Object.assign(new Error('network'), { status: 504 });
      if (path.startsWith('/api/handoff/actions/')) {
        queryCalls++;
        if (queryCalls === 1) { started.resolve(); return gate.promise; }
        return secondGate.promise;
      }
      return undefined;
    } });
    const { handoff, dialog } = await openController(deps);
    try {
      dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
      await waitForPrepare(dialog);
      dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
      await waitForRecover(dialog);
      const button = dialog.querySelector('.btn-handoff-recover');
      button.dispatchEvent({ type: 'click' });
      button.dispatchEvent({ type: 'click' });
      await started.promise;
      assert.equal(queryCalls, 1, '重复 query 只能发一个 GET');
      const queried = response({ ok: true, action: makeAction({ actionId: ACTION_A, state: 'unknown' }) });
      gate.resolve(queried);
      secondGate.resolve(queried);
      for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
    } finally { handoff.dispose(); }
  });

  await t.test('focus single-flight', async () => {
    const gate = deferred();
    const started = deferred();
    let focusCalls = 0;
    const deps = makeControllerDeps({ focus: async () => {
      focusCalls++;
      started.resolve();
      return gate.promise;
    } });
    const { handoff, dialog } = await openController(deps);
    try {
      dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
      await waitForPrepare(dialog);
      dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
      await waitFor(() => dialog.querySelector('.btn-handoff-focus')?.style.display === 'inline-block');
      const button = dialog.querySelector('.btn-handoff-focus');
      button.dispatchEvent({ type: 'click' });
      button.dispatchEvent({ type: 'click' });
      await started.promise;
      assert.equal(focusCalls, 1, '重复 focus 只能调用一次 SDK');
      gate.resolve();
      await new Promise(resolve => setImmediate(resolve));
    } finally { handoff.dispose(); }
  });
});

// Confirm 双击绿对照：已有实现的 actionId-only body 和单飞行为继续锁定。
test('GREEN confirm sends only actionId and rejects a concurrent second click', async () => {
  const confirmGate = deferred();
  const payloads = [];
  const deps = makeControllerDeps({ onRequest: (path, init) => {
    if (path === '/api/handoff/prepare') {
      return response({ ok: true, action: makeAction({ actionId: ACTION_A }) });
    }
    if (path === '/api/handoff/confirm') {
      payloads.push(JSON.parse(init.body));
      return confirmGate.promise;
    }
    return undefined;
  } });
  const { handoff, dialog } = await openController(deps);
  try {
    dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
    await waitForPrepare(dialog);
    const button = dialog.querySelector('.btn-handoff-confirm');
    button.dispatchEvent({ type: 'click' });
    button.dispatchEvent({ type: 'click' });
    await waitFor(() => payloads.length > 0);
    assert.equal(payloads.length, 1);
    assert.deepEqual(Object.keys(payloads[0]), ['actionId']);
    assert.equal(payloads[0].actionId, ACTION_A);
    confirmGate.resolve(response({ ok: true, action: makeAction({ actionId: ACTION_A, state: 'ready', sessionId: 'sess-ready', entryId: 'entry-ready' }) }));
    await waitFor(() => dialog.querySelector('.btn-handoff-focus')?.style.display === 'inline-block');
  } finally {
    handoff.dispose();
  }
});

// I7：confirm 的 403/409/网络错误都必须使用中性待查文案，不能猜副作用。
test('[I7] confirm failures use neutral wording and never auto-retry POST', async t => {
  for (const [label, error] of [
    ['403', Object.assign(new Error('forbidden'), { status: 403 })],
    ['409', Object.assign(new Error('unknown action state'), { status: 409 })],
    ['network', new Error('connection lost')],
  ]) {
    await t.test(label, async () => {
      let confirmPosts = 0;
      let queryGets = 0;
      const deps = makeControllerDeps({ onRequest: path => {
        if (path === '/api/handoff/confirm') {
          confirmPosts++;
          throw error;
        }
        if (path.startsWith('/api/handoff/actions/')) queryGets++;
        return undefined;
      } });
      const { handoff, dialog } = await openController(deps);
      try {
        dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
        await waitForPrepare(dialog);
        dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
        await waitForRecover(dialog);
        const message = dialog.querySelector('.handoff-error').textContent;
        assert.ok(message.includes('确认未完成') || message.includes('原动作查询'), '必须提示按原 action 查询');
        assert.equal(/已发送|未发送/.test(message), false, '不得断言宿主副作用已发送或未发送');
        assert.equal(confirmPosts, 1, 'confirm 失败后不得自动重发 POST');
        dialog.querySelector('.btn-handoff-recover').dispatchEvent({ type: 'click' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(confirmPosts, 1);
        assert.equal(queryGets, 1, '用户显式恢复时只允许 GET');
      } finally { handoff.dispose(); }
    });
  }
});

// I7：confirm/query 回包都必须核对 actionId，不能让别人的动作替换当前动作。
test('[I7] confirm and query responses with a mismatched actionId are rejected', async t => {
  await t.test('confirm mismatch', async () => {
    const deps = makeControllerDeps({ onRequest: path => {
      if (path === '/api/handoff/confirm') {
        return response({ ok: true, action: makeAction({ actionId: ACTION_B, state: 'ready', sessionId: 'other-session', entryId: 'other-entry' }) });
      }
      return undefined;
    } });
    const { handoff, dialog } = await openController(deps);
    try {
      dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
      await waitForPrepare(dialog);
      dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(dialog.querySelector('.btn-handoff-focus').style.display, 'none');
      assert.notEqual(dialog.querySelector('.handoff-error').style.display, 'none');
    } finally { handoff.dispose(); }
  });

  await t.test('query mismatch', async () => {
    const deps = makeControllerDeps({ onRequest: path => {
      if (path === '/api/handoff/confirm') throw new Error('network');
      if (path.startsWith('/api/handoff/actions/')) {
        return response({ ok: true, action: makeAction({ actionId: ACTION_B, state: 'ready', sessionId: 'other-session', entryId: 'other-entry' }) });
      }
      return undefined;
    } });
    const { handoff, dialog } = await openController(deps);
    try {
      dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
      await waitForPrepare(dialog);
      dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
      await waitForRecover(dialog);
      dialog.querySelector('.btn-handoff-recover').dispatchEvent({ type: 'click' });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(dialog.querySelector('.btn-handoff-focus').style.display, 'none');
      assert.notEqual(dialog.querySelector('.handoff-error').style.display, 'none');
    } finally { handoff.dispose(); }
  });
});

// I4/I5：有历史动作时只 GET，不自动 prepare/confirm；每种状态独立执行。
test('[I4/I5] history states are query-only and safely mapped', async t => {
  const cases = [
    ['prepared', { expectConfirm: false, expectFocus: false }],
    ['creating', { expectConfirm: false, expectFocus: false }],
    ['importing', { sessionId: 'sess-importing', expectConfirm: false, expectFocus: true }],
    ['ready', { sessionId: 'sess-ready', expectConfirm: false, expectFocus: true }],
    ['partial', { sessionId: 'sess-partial', expectConfirm: false, expectFocus: true }],
    ['unknown', { sessionId: 'sess-unknown', expectConfirm: false, expectFocus: true }],
    ['failed', { expectConfirm: false, expectFocus: false }],
    ['running', { expectConfirm: false, expectFocus: false }],
  ];
  for (const [state, expected] of cases) {
    await t.test(state, async () => {
      const paths = [];
      const action = makeAction({ state, sessionId: expected.sessionId || null });
      const deps = makeControllerDeps({ onRequest: (path, init) => {
        paths.push({ path, method: init.method || 'GET' });
        if (path === '/api/handoff/actions') return response({ ok: true, actions: [action] });
        return undefined;
      } });
      const { handoff, dialog } = await openController(deps);
      try {
        const cap = paths.findIndex(item => item.path === '/api/handoff/capabilities');
        const list = paths.findIndex(item => item.path === '/api/handoff/actions');
        assert.ok(cap >= 0, '重开必须先 GET capabilities');
        assert.ok(list > cap, 'owner actions 必须在 capabilities 后 GET');
        assert.equal(paths.some(item => item.method === 'POST'), false, `${state} 历史状态不得自动 POST`);
        assert.equal(dialog.querySelector('.btn-handoff-prepare').style.display, 'none', `${state} 不得自动进入新 prepare`);
        assert.equal(dialog.querySelector('.btn-handoff-confirm').style.display, 'none', `${state} 不得直接确认旧动作`);
        assert.equal(dialog.querySelector('.btn-handoff-focus').style.display === 'inline-block', expected.expectFocus);
        if (expected.expectFocus) {
          assert.ok(dialog.querySelector('.btn-handoff-focus').textContent.includes(state === 'ready' ? '打开' : '核查'));
        }
      } finally { handoff.dispose(); }
    });
  }
});

// 旧 prepared DTO 没有正文，绝不能被当作可直接 confirm 的新预览。
test('[I4] old prepared history without context cannot confirm', async () => {
  let confirmCalls = 0;
  const oldAction = makeAction({ state: 'prepared' });
  const deps = makeControllerDeps({ onRequest: (path, init) => {
    if (path === '/api/handoff/actions') return response({ ok: true, actions: [oldAction] });
    if (path === '/api/handoff/confirm') confirmCalls++;
    return undefined;
  } });
  const { handoff, dialog } = await openController(deps);
  try {
    assert.ok(deps.calls.some(call => call.path === '/api/handoff/actions'), '必须查询历史动作');
    assert.equal(deps.calls.some(call => call.init.method === 'POST'), false);
    const confirm = dialog.querySelector('.btn-handoff-confirm');
    assert.equal(confirm.style.display, 'none');
    assert.equal(confirmCalls, 0);
  } finally { handoff.dispose(); }
});

// I8/准入：unsupported、权限不足、无 Agent 都 fail closed，不发 prepare/confirm。
test('[I8] unsupported, permission-missing, and no-agent prerequisites fail closed', async t => {
  const cases = [
    ['unsupported', { supported: false, available: false, reason: 'HANDOFF_UNSUPPORTED' }, [{ id: 'a1', name: 'A1' }]],
    ['permission missing', { supported: true, available: false, home: false, read: true, manage: true, stageFile: true, agentsRead: true, missing: ['app/sessions.home'], reason: 'HANDOFF_PERMISSION_MISSING' }, [{ id: 'a1', name: 'A1' }]],
    ['no agent', { supported: true, available: true, home: true, read: true, manage: true, stageFile: true, agentsRead: true, missing: [], reason: null }, []],
  ];
  for (const [label, caps, agents] of cases) {
    await t.test(label, async () => {
      const paths = [];
      const deps = makeControllerDeps({ agents, onRequest: (path, init) => {
        paths.push({ path, method: init.method || 'GET' });
        if (path === '/api/handoff/capabilities') return response({ ok: true, ...caps });
        if (path === '/api/agents') return response({ ok: true, agents });
        return undefined;
      } });
      const handoff = createPanelHandoff(deps);
      await handoff.open('target');
      try {
        assert.ok(paths.some(item => item.path === '/api/handoff/capabilities'), '必须真实查询 capabilities');
        assert.equal(paths.some(item => item.method === 'POST'), false, '准入失败不得发任何 POST');
      } finally { handoff.dispose(); }
    });
  }
});

// 模态 API 不可用时必须 fail closed；这里故意不要求 busy 场景的 dialog 为 null。
test('[I8] modal showModal missing or throwing fails closed', async t => {
  for (const mode of ['missing', 'throwing']) {
    await t.test(mode, () => {
      const documentRef = createFakeDocument();
      const originalCreate = documentRef.createElement.bind(documentRef);
      documentRef.createElement = tag => {
        const element = originalCreate(tag);
        if (String(tag).toLowerCase() === 'dialog') {
          if (mode === 'missing') element.showModal = undefined;
          else element.showModal = () => { throw new Error('showModal blocked'); };
        }
        return element;
      };
      const view = createHandoffView({ documentRef });
      view.open({ context: validContextForView(), agents: [{ id: 'a1', name: 'A1' }], selectedAgentId: 'a1' });
      assert.equal(documentRef.body.querySelector('.handoff-dialog'), null, '模态 API 不可用时不得保留伪模态 dialog');
    });
  }
});

// I5：部分完成和未知状态有 sessionId 时只能核查，不能宣称 ready；focus 失败可以重试且不重建。
test('[I5] partial/unknown focus is inspection-only and focus failure retries without confirm', async () => {
  let focusAttempts = 0;
  let confirmCalls = 0;
  const deps = makeControllerDeps({
    focus: async () => {
      focusAttempts++;
      if (focusAttempts === 1) throw new Error('focus denied');
    },
    onRequest: (path, init) => {
      if (path === '/api/handoff/prepare') {
        return response({ ok: true, action: makeAction({ actionId: ACTION_A }) });
      }
      if (path === '/api/handoff/confirm') {
        confirmCalls++;
        return response({ ok: true, action: makeAction({ actionId: ACTION_A, state: 'partial', sessionId: 'sess-partial', entryId: null }) });
      }
      return undefined;
    },
  });
  const { handoff, dialog } = await openController(deps);
  try {
    dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
    await waitForPrepare(dialog);
    dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
    await waitFor(() => dialog.querySelector('.btn-handoff-focus')?.style.display === 'inline-block');
    const focus = dialog.querySelector('.btn-handoff-focus');
    assert.ok(focus.textContent.includes('核查'), 'partial 不能标为 ready 打开');
    focus.dispatchEvent({ type: 'click' });
    await new Promise(resolve => setImmediate(resolve));
    focus.dispatchEvent({ type: 'click' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(focusAttempts, 2);
    assert.equal(confirmCalls, 1, 'focus 重试不得重新 confirm/create');
  } finally { handoff.dispose(); }
});
