import test from 'node:test';
import assert from 'node:assert/strict';

import { createForkSessionController } from '../ui/assets/fork-session-controller.js';
import { createDocumentPipeline } from '../ui/assets/panel-documents.js';
import { createPanelHandoff } from '../ui/assets/panel-handoff.js';
import { createHandoffView } from '../ui/assets/panel-handoff-view.js';
import { buildHandoffContext } from '../ui/assets/fork-handoff-context.js';
import { HANDOFF_LIMITS, formatHandoffTranscript } from '../ui/assets/fork-handoff-contract.js';
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
  const { panel, ui, handoffCompositions } = await loadPanel({
    onRequest: async route => {
      if (route === '/api/handoff/capabilities') {
        return Response.json({
          ok: true,
          supported: true,
          available: true,
          home: true,
          read: true,
          manage: true,
          stageFile: true,
          agentsRead: true,
          missing: [],
          reason: null,
        });
      }
      if (route === '/api/handoff/actions') {
        return Response.json({ ok: true, actions: [] });
      }
      return Response.json({});
    },
  });
  try {
    const composition = handoffCompositions.at(-1);
    assert.ok(composition, 'panel.js 必须实际创建 handoff controller');
    assert.equal(typeof composition.getSessionController, 'function', '组合根必须注入惰性 sessionController getter');
    const controller = composition.getSessionController();
    assert.ok(controller, 'getter 返回的控制器不得是 null');
    assert.equal(controller.state.ready, true, '真实控制器应已完成初始化');

    // 在非空业务 canvas 实际点真实 handoff 按钮，证明 getter 被 controller 消费
    const targetCard = panel.getCards()[0];
    assert.ok(targetCard, '必须存在目标卡片');
    targetCard.messages = [
      { role: 'user', text: '业务问题' },
      { role: 'assistant', text: '业务回答' },
    ];
    controller.scheduleSave();
    await controller.flush(true);

    const cardEl = ui.environment.document.querySelector(`#dom-${targetCard.id}`)
      || ui.environment.document.querySelector('.chat-card');
    assert.ok(cardEl, '必须找到渲染后的卡片 DOM');
    const handoffBtn = cardEl.querySelector('[data-action="handoff"]');
    assert.ok(handoffBtn, '必须找到真实 handoff 按钮');
    handoffBtn.dispatchEvent({ type: 'click', bubbles: true, stopPropagation() {} });

    await waitFor(() => ui.environment.document.querySelector('dialog.handoff-dialog') || ui.environment.document.querySelector('.handoff-dialog'), {
      message: '点击真实 handoff 按钮必须打开对话框，证明 sessionController getter 被 controller 消费',
    });
    const dialog = ui.environment.document.querySelector('dialog.handoff-dialog')
      || ui.environment.document.querySelector('.handoff-dialog');
    assert.ok(dialog, '点击真实 handoff 按钮必须打开对话框，证明 sessionController getter 被 controller 消费');
    assert.equal(dialog.open, true, '对话框应处于 open 状态');
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

// ============================================================================
// Task 3 Fix Round 2 RED 测试矩阵 (C2/C3/I2/I4/I5/I10/I11/I12)
// ============================================================================

// [Round2-G1] 切画布/代际/控制器替换后，confirm/prepare/query/focus 入口均不得发请求 (C3)
test('[Round2-G1] canvas switch, generation advance, or controller replacement blocks confirm POST and stale op entries (C3)', async t => {
  await t.test('confirm POST is blocked (0 POST) when activeId changes after prepare', async () => {
    let confirmPostCalls = 0;
    const deps = makeControllerDeps({
      onRequest: (path) => {
        if (path === '/api/handoff/confirm') {
          confirmPostCalls++;
          return response({ ok: true, action: makeAction({ state: 'ready' }) });
        }
        return undefined;
      },
    });
    const { handoff, dialog } = await openController(deps);
    try {
      dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
      await waitForPrepare(dialog);
      assert.equal(dialog.querySelector('.btn-handoff-confirm').style.display, 'inline-block');

      // 切换画布
      deps.state.activeId = 'canvas-switched';
      dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
      await new Promise(r => setImmediate(r));

      assert.equal(confirmPostCalls, 0, '切画布后点击 confirm 绝不能发出 POST 请求');
    } finally {
      handoff.dispose();
    }
  });

  await t.test('confirm POST is blocked (0 POST) when generation changes after prepare', async () => {
    let confirmPostCalls = 0;
    const deps = makeControllerDeps({
      onRequest: (path) => {
        if (path === '/api/handoff/confirm') {
          confirmPostCalls++;
          return response({ ok: true, action: makeAction({ state: 'ready' }) });
        }
        return undefined;
      },
    });
    const { handoff, dialog } = await openController(deps);
    try {
      dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
      await waitForPrepare(dialog);

      // 代际自增
      deps.state.generation = deps.state.generation + 1;
      dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
      await new Promise(r => setImmediate(r));

      assert.equal(confirmPostCalls, 0, '代际变更后点击 confirm 绝不能发出 POST 请求');
    } finally {
      handoff.dispose();
    }
  });

  await t.test('confirm POST is blocked when controller reference changes even with same id and gen', async () => {
    let confirmPostCalls = 0;
    let currentController;
    const deps = makeControllerDeps({
      onRequest: (path) => {
        if (path === '/api/handoff/confirm') {
          confirmPostCalls++;
          return response({ ok: true, action: makeAction({ state: 'ready' }) });
        }
        return undefined;
      },
    });
    currentController = deps.sessionController;
    deps.getSessionController = () => currentController;

    const { handoff, dialog } = await openController(deps);
    try {
      dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
      await waitForPrepare(dialog);

      // 控制器实例被新实例替换（虽然 activeId/generation 相同）
      const newController = {
        state: { ...deps.state },
        get generation() { return deps.state.generation; },
        getSavedSnapshot: deps.sessionController.getSavedSnapshot,
        flush: async () => {},
      };
      currentController = newController;

      dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
      await new Promise(r => setImmediate(r));

      assert.equal(confirmPostCalls, 0, '控制器对象被替换后点击 confirm 绝不能发出 POST 请求');
    } finally {
      handoff.dispose();
    }
  });
});

// [Round2-G2] flush/Agent/caps 等待期间或 prepare 前依赖卡片变忙时阻断 prepare (C2)
test('[Round2-G2] dependency becoming busy during awaits or before prepare blocks prepare POST (C2)', async t => {
  await t.test('ancestor becomes busy before prepare click blocks prepare POST (0 POST)', async () => {
    const busyIds = new Set();
    let prepareCalls = 0;
    const deps = makeControllerDeps({
      cards: [
        { id: 'root', parentId: null, title: '根', messages: [{ role: 'user', text: '根' }] },
        { id: 'target', parentId: 'root', title: '目标', messages: [{ role: 'assistant', text: '目标' }] },
      ],
      isCardBusy: id => busyIds.has(id),
      onRequest: (path) => {
        if (path === '/api/handoff/prepare') {
          prepareCalls++;
          return response({ ok: true, action: makeAction() });
        }
        return undefined;
      },
    });
    const { handoff, dialog } = await openController(deps, 'target');
    try {
      // 弹窗打开后、点击准备前，祖先节点由于后台请求或文档解析变忙
      busyIds.add('root');

      dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
      await new Promise(r => setImmediate(r));

      assert.equal(prepareCalls, 0, '祖先节点忙碌时点击 prepare 绝不能发出 POST 请求');
    } finally {
      handoff.dispose();
    }
  });

  await t.test('unrelated card busy does NOT block prepare', async () => {
    const busyIds = new Set(['unrelated-card-id']);
    let prepareCalls = 0;
    const deps = makeControllerDeps({
      isCardBusy: id => busyIds.has(id),
      onRequest: (path) => {
        if (path === '/api/handoff/prepare') {
          prepareCalls++;
          return response({ ok: true, action: makeAction() });
        }
        return undefined;
      },
    });
    const { handoff, dialog } = await openController(deps, 'target');
    try {
      dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
      await waitForPrepare(dialog);

      assert.equal(prepareCalls, 1, '无关卡片忙碌不得阻断当前交接 prepare');
    } finally {
      handoff.dispose();
    }
  });
});

// [Round2-G3] 挂起操作 close 后新卡片操作不受 pending 锁阻塞，且迟到 finally 不影响新单飞 (C3)
test('[Round2-G3] closing pending A allows new op B without lock contention, and late A finally does not pollute B (C3)', async () => {
  const pendingA = deferred();
  let prepareCallsA = 0;
  let prepareCallsB = 0;

  const cards = [
    { id: 'card-A', parentId: null, title: 'A', messages: [{ role: 'user', text: 'A' }] },
    { id: 'card-B', parentId: null, title: 'B', messages: [{ role: 'user', text: 'B' }] },
  ];

  const deps = makeControllerDeps({
    cards,
    onRequest: (path, init) => {
      if (path === '/api/handoff/prepare') {
        const body = JSON.parse(init.body || '{}');
        if (body.source?.targetCardId === 'card-A') {
          prepareCallsA++;
          return pendingA.promise;
        }
        if (body.source?.targetCardId === 'card-B') {
          prepareCallsB++;
          return response({ ok: true, action: makeAction({ actionId: ACTION_B, targetCardId: 'card-B' }) });
        }
      }
      return undefined;
    },
  });

  const handoff = createPanelHandoff(deps);
  try {
    // 打开卡片 A 并触发 prepare，使其挂起
    await handoff.open('card-A');
    const dialogA = deps.documentRef.body.querySelector('.handoff-dialog');
    assert.ok(dialogA, 'A 的弹窗必须挂载');
    dialogA.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
    await new Promise(r => setImmediate(r));
    assert.equal(prepareCallsA, 1, 'A 应该发出了 prepare 请求并挂起');

    // 关闭 A 弹窗
    dialogA.querySelector('.handoff-close-btn').dispatchEvent({ type: 'click' });
    await new Promise(r => setImmediate(r));

    // 打开卡片 B 并点击 prepare，验证不被 A 的 isPreparing 锁卡死
    await handoff.open('card-B');
    const dialogB = deps.documentRef.body.querySelector('.handoff-dialog');
    assert.ok(dialogB, 'B 的弹窗必须挂载');
    dialogB.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
    await new Promise(r => setImmediate(r));

    assert.equal(prepareCallsB, 1, 'B 的 prepare 不得被已关闭的 A 遗留锁阻塞');
  } finally {
    pendingA.resolve(response({ ok: true, action: makeAction({ actionId: ACTION_A }) }));
    handoff.dispose();
  }
});

// [Round2-G4] capabilities 准入失败阻断实际 prepare 点击，且 actions GET 失败 fail-closed 禁止新 prepare (I10/I4)
test('[Round2-G4] capabilities false blocks prepare POST and actions GET failure fails closed (I10/I4)', async t => {
  await t.test('capabilities supported:false or home:false blocks prepare POST (0 POST)', async () => {
    let prepareCalls = 0;
    const deps = makeControllerDeps({
      onRequest: (path) => {
        if (path === '/api/handoff/capabilities') {
          return response({
            ok: true,
            supported: false,
            available: false,
            home: false,
            reason: 'HANDOFF_UNSUPPORTED',
          });
        }
        if (path === '/api/handoff/prepare') {
          prepareCalls++;
          return response({ ok: true, action: makeAction() });
        }
        return undefined;
      },
    });

    const handoff = createPanelHandoff(deps);
    try {
      await handoff.open('target');
      const dialog = deps.documentRef.body.querySelector('.handoff-dialog');
      if (dialog) {
        const prepareBtn = dialog.querySelector('.btn-handoff-prepare');
        if (prepareBtn && prepareBtn.style.display !== 'none') {
          prepareBtn.dispatchEvent({ type: 'click' });
          await new Promise(r => setImmediate(r));
        }
      }
      assert.equal(prepareCalls, 0, 'capabilities 不满足时绝不能允许发出 prepare POST');
    } finally {
      handoff.dispose();
    }
  });

  await t.test('actions GET failure does not silently fall through to new prepare (0 POST)', async () => {
    let prepareCalls = 0;
    const deps = makeControllerDeps({
      onRequest: (path) => {
        if (path === '/api/handoff/actions') {
          return response({ ok: false, error: 'DATABASE_TIMEOUT' }, 500);
        }
        if (path === '/api/handoff/prepare') {
          prepareCalls++;
          return response({ ok: true, action: makeAction() });
        }
        return undefined;
      },
    });

    const handoff = createPanelHandoff(deps);
    try {
      await handoff.open('target');
      const dialog = deps.documentRef.body.querySelector('.handoff-dialog');
      if (dialog) {
        const prepareBtn = dialog.querySelector('.btn-handoff-prepare');
        if (prepareBtn && prepareBtn.style.display !== 'none') {
          prepareBtn.dispatchEvent({ type: 'click' });
          await new Promise(r => setImmediate(r));
        }
      }
      assert.equal(prepareCalls, 0, 'actions 查询失败时绝不能静默当作空历史并允许发起新 prepare POST');
    } finally {
      handoff.dispose();
    }
  });
});

// [Round2-G5] 首次异步等待前即挂载模态对话框并展示 loading 态，关闭后迟到返回不复活 (I11)
test('[Round2-G5] modal mounts early with loading state before async awaits finish, and close aborts resurrect (I11)', async () => {
  const capsDeferred = deferred();
  const deps = makeControllerDeps({
    onRequest: (path) => {
      if (path === '/api/handoff/capabilities') return capsDeferred.promise;
      return undefined;
    },
  });

  const handoff = createPanelHandoff(deps);
  const openPromise = handoff.open('target');

  // 在 capabilities 仍在等待中时，模态对话框必须已经挂载并且处于 open 状态
  const dialog = deps.documentRef.body.querySelector('.handoff-dialog');
  assert.ok(dialog, '在首次异步等待期间模态对话框必须已经挂载以阻断背景交互');
  assert.equal(dialog.open, true, '早期挂载的对话框必须处于 open 模态状态');

  // prepare 按钮在加载期间不得可操作
  const prepareBtn = dialog.querySelector('.btn-handoff-prepare');
  assert.ok(!prepareBtn || prepareBtn.style.display === 'none' || prepareBtn.disabled, '加载期间 prepare 不得处于可点击操作状态');

  // 在等待期间关闭弹窗
  dialog.querySelector('.handoff-close-btn').dispatchEvent({ type: 'click' });
  assert.equal(deps.documentRef.body.querySelector('.handoff-dialog'), null, '关闭后对话框必须从 DOM 移除');

  // 完成挂起的请求
  capsDeferred.resolve(response({
    ok: true,
    supported: true,
    available: true,
    home: true,
    read: true,
    manage: true,
    stageFile: true,
    agentsRead: true,
    missing: [],
    reason: null,
  }));
  await openPromise;

  assert.equal(deps.documentRef.body.querySelector('.handoff-dialog'), null, '已关闭的早期操作在迟到完成后不得复活弹窗');
  handoff.dispose();
});

// [Round2-G6] 历史动作共存需显式新建预览入口，且 query 刷新 sessionId 后点击 focus 必须调用确切新 SID (I4/I5)
test('[Round2-G6] history coexists with explicit new-preview button, and query updating sessionId focuses new SID (I4/I5)', async t => {
  await t.test('history prepared/ready shows new-preview button and requires explicit click to prepare', async () => {
    for (const historyState of ['prepared', 'ready']) {
      let prepareCalls = 0;
      const oldAction = makeAction({ actionId: ACTION_A, state: historyState });
      const deps = makeControllerDeps({
        onRequest: (path) => {
          if (path === '/api/handoff/actions') {
            return response({ ok: true, actions: [oldAction] });
          }
          if (path === '/api/handoff/prepare') {
            prepareCalls++;
            return response({ ok: true, action: makeAction({ actionId: ACTION_B }) });
          }
          return undefined;
        },
      });

      const { handoff, dialog } = await openController(deps);
      try {
        const newPreviewBtn = dialog.querySelector('.btn-handoff-new-preview');
        assert.ok(newPreviewBtn, `历史状态为 ${historyState} 时必须提供显式【新建预览】按钮`);
        assert.equal(prepareCalls, 0, '未点击新建预览前不得发出 prepare POST');

        // 点击【新建预览】后切换至新预览流程，允许发起新的 prepare POST
        newPreviewBtn.dispatchEvent({ type: 'click' });
        await new Promise(r => setImmediate(r));

        const prepareBtn = dialog.querySelector('.btn-handoff-prepare');
        assert.ok(prepareBtn, '点击新建预览后必须展示准备按钮');
        assert.notEqual(prepareBtn.style.display, 'none', '准备按钮必须可见');
        prepareBtn.dispatchEvent({ type: 'click' });
        await waitForPrepare(dialog);

        assert.equal(prepareCalls, 1, '点击新建预览后发起 prepare 必须发送 1 次新的 POST 请求');
      } finally {
        handoff.dispose();
      }
    }
  });

  await t.test('history creating without sessionId queries ready with sessionId and focuses new SID exactly once', async () => {
    const focusCalls = [];
    const creatingAction = makeAction({
      actionId: ACTION_A,
      state: 'creating',
      sessionId: null,
    });

    const deps = makeControllerDeps({
      focus: async ({ sessionId }) => {
        focusCalls.push(sessionId);
      },
      onRequest: (path) => {
        if (path === '/api/handoff/actions') {
          return response({ ok: true, actions: [creatingAction] });
        }
        if (path === `/api/handoff/actions/${ACTION_A}`) {
          return response({
            ok: true,
            action: makeAction({
              actionId: ACTION_A,
              state: 'ready',
              sessionId: 'sess-dynamic-new-777',
            }),
          });
        }
        return undefined;
      },
    });

    const { handoff, dialog } = await openController(deps);
    try {
      // 点击恢复查询
      const recoverBtn = dialog.querySelector('.btn-handoff-recover');
      assert.ok(recoverBtn, 'creating 状态必须显示查询恢复按钮');
      recoverBtn.dispatchEvent({ type: 'click' });
      await waitFor(() => dialog.querySelector('.btn-handoff-focus')?.style.display === 'inline-block');

      const focusBtn = dialog.querySelector('.btn-handoff-focus');
      assert.ok(focusBtn, '查询转为 ready 且获得 sessionId 后必须展示核查/打开按钮');
      focusBtn.dispatchEvent({ type: 'click' });
      await new Promise(r => setImmediate(r));

      assert.deepEqual(focusCalls, ['sess-dynamic-new-777'], '点击 focus 必须且仅调用 1 次真实更新后的 sessionId');
    } finally {
      handoff.dispose();
    }
  });
});

// [Round2-G7] formatHandoffTranscript 权威正文保底、下一步预览一致性与空选 Agent 安全 (I12/I2)
test('[Round2-G7] formatHandoffTranscript canonical guarantee, nextStep preview consistency, and empty agent safety (I12/I2)', async t => {
  await t.test('prepared dialog renders canonical formatHandoffTranscript matching actual POST DTO verbatim', async () => {
    let capturedDto = null;
    const deps = makeControllerDeps({
      onRequest: (path, init) => {
        if (path === '/api/handoff/prepare') {
          capturedDto = JSON.parse(init.body);
          return response({ ok: true, action: makeAction() });
        }
        return undefined;
      },
    });

    const { handoff, dialog } = await openController(deps);
    try {
      const textarea = dialog.querySelector('.handoff-textarea');
      if (textarea) {
        textarea.value = '下一步具体业务要求';
        textarea.dispatchEvent({ type: 'input' });
      }

      dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
      await waitForPrepare(dialog);

      assert.ok(capturedDto, '必须发出 prepare 请求并捕获 DTO');
      const expectedTranscript = formatHandoffTranscript(capturedDto);

      const transcriptEl = dialog.querySelector('.handoff-transcript-preview pre')
        || dialog.querySelector('.handoff-transcript-preview');
      assert.ok(transcriptEl, '必须存在完整权威转录正文保底预览元素');
      assert.equal(transcriptEl.textContent.trim(), expectedTranscript.trim(), '预览的转录正文必须与实际 prepare DTO 生成的正文逐字一致');
    } finally {
      handoff.dispose();
    }
  });

  await t.test('nextStep text edit marks preview pending or updates nextStep indicator, and prepare emits canonical transcript', async () => {
    let capturedDto = null;
    const deps = makeControllerDeps({
      onRequest: (path, init) => {
        if (path === '/api/handoff/prepare') {
          capturedDto = JSON.parse(init.body);
          return response({ ok: true, action: makeAction() });
        }
        return undefined;
      },
    });
    const { handoff, dialog } = await openController(deps);
    try {
      const textarea = dialog.querySelector('.handoff-textarea');
      assert.ok(textarea, '必须存在下一步草稿输入框');
      textarea.value = 'NEW_NEXT_STEP_SENTINEL';
      textarea.dispatchEvent({ type: 'input' });

      // 输入后：confirm 必须不可用（隐藏或禁用），且界面显示待更新提示或微型下一步预览更新
      const confirmBtn = dialog.querySelector('.btn-handoff-confirm');
      assert.ok(!confirmBtn || confirmBtn.style.display === 'none' || confirmBtn.disabled, '输入修改后旧 confirm 必须禁用或隐藏');

      const previewText = dialog.querySelector('.handoff-preview-section')?.textContent || '';
      const statusText = dialog.textContent || '';
      const hasIndicator = previewText.includes('NEW_NEXT_STEP_SENTINEL') || statusText.includes('待更新') || statusText.includes('待重新准备');
      assert.ok(hasIndicator, '输入修改后必须有待更新标记或下一步文本指示');

      // 显式 prepare 后，完整权威转录正文必须逐字匹配实际 POST DTO
      dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
      await waitForPrepare(dialog);

      assert.ok(capturedDto, '必须发出 prepare 请求');
      assert.equal(capturedDto.nextStep, 'NEW_NEXT_STEP_SENTINEL', 'POST DTO 必须携带修改后的下一步文本');

      const expectedTranscript = formatHandoffTranscript(capturedDto);
      const transcriptEl = dialog.querySelector('.handoff-transcript-preview pre')
        || dialog.querySelector('.handoff-transcript-preview');
      assert.ok(transcriptEl, '必须存在完整权威转录正文保底预览元素');
      assert.equal(transcriptEl.textContent.trim(), expectedTranscript.trim(), '显式 prepare 后的权威正文必须与实际 POST DTO 逐字一致');
    } finally {
      handoff.dispose();
    }
  });

  await t.test('empty agent selection prevents prepare and does not synthesize fake preview', async () => {
    let prepareCalls = 0;
    const deps = makeControllerDeps({
      snapshotAgentId: 'non-existent-agent',
      agents: [{ id: 'a1', name: 'Agent 1' }],
      onRequest: (path) => {
        if (path === '/api/handoff/prepare') {
          prepareCalls++;
          return response({ ok: true, action: makeAction() });
        }
        return undefined;
      },
    });

    const { handoff, dialog } = await openController(deps);
    try {
      const select = dialog.querySelector('.handoff-select');
      assert.equal(select.value, '', '快照 Agent 不存在时必须为空选');

      // 空选 Agent 时，不得假借第一个 Agent 合成权威转录预览
      const transcriptEl = dialog.querySelector('.handoff-transcript-preview');
      assert.ok(
        !transcriptEl || !transcriptEl.textContent.includes('Agent 1') || transcriptEl.textContent.includes('请选择智能体'),
        '未选 Agent 时不得假借首个 Agent 合成权威正文',
      );

      dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
      await new Promise(r => setImmediate(r));

      assert.equal(prepareCalls, 0, '未选择 Agent 时不得发出 prepare POST');
    } finally {
      handoff.dispose();
    }
  });
});

