import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import { createHandoffService } from '../lib/handoff-service.js';
import { formatHandoffTranscript } from '../ui/assets/fork-handoff-contract.js';
import { createPanelHandoff } from '../ui/assets/panel-handoff.js';
import {
  createFakeDocument,
  response,
  waitFor,
} from './fixtures/handoff-fixtures.mjs';

function routeMatcher(routes, method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  return routes.find(candidate => {
    if (candidate.method !== method) return false;
    const expected = candidate.pattern.split('/').filter(Boolean);
    return expected.length === parts.length
      && expected.every((piece, index) => piece.startsWith(':') || piece === parts[index]);
  });
}

function makeRequestHost({ routes, owner = { appId: 'timeline-reverser', principal: { principalId: 'test-user-p1', kind: 'authenticated' } }, onBody = () => {}, onResponse = () => {} }) {
  return async (_hana, reqPath, init = {}) => {
    if (reqPath === '/api/agents') {
      return response({ ok: true, agents: [{ id: 'agent-sol', name: 'Sol Architect' }] });
    }
    const method = init.method || 'GET';
    const parsed = new URL(`http://local${reqPath}`);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const route = routeMatcher(routes, method, parsed.pathname);
    if (!route) throw new Error(`Route not found: ${method} ${reqPath}`);

    const params = {};
    route.pattern.split('/').filter(Boolean).forEach((piece, index) => {
      if (piece.startsWith(':')) params[piece.slice(1)] = decodeURIComponent(parts[index]);
    });
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    onBody({ method, path: parsed.pathname, body, init });

    const raw = new Request(parsed, {
      method,
      ...(init.body === undefined ? {} : {
        body: init.body,
        headers: { 'content-type': 'application/json' },
      }),
    });
    let status = 200;
    let responseBody = null;
    const context = {
      req: {
        raw,
        json: async () => body,
        param: name => params[name],
        query: name => parsed.searchParams.get(name),
      },
      get: key => (key === 'appRequestContext' ? owner : undefined),
      json: (value, nextStatus = 200) => {
        status = nextStatus;
        responseBody = value;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => value,
        };
      },
    };
    const result = await route.handler(context);
    onResponse({ method, path: parsed.pathname, body: responseBody, status, result });
    if (!result.ok) {
      const error = new Error(`HTTP ${result.status}: ${JSON.stringify(responseBody)}`);
      error.status = result.status;
      error.body = responseBody;
      throw error;
    }
    return result;
  };
}

function makeSdk({ capabilities, sdkCalls, pdfBytes, missingCreate = false } = {}) {
  const grants = capabilities || [
    { capability: 'app/sessions.home', status: 'always' },
    { capability: 'app/sessions.read', status: 'always' },
    { capability: 'app/sessions.manage', status: 'always' },
    { capability: 'app/session.stage-file', status: 'always' },
    { capability: 'app/agents.read', status: 'always' },
  ];
  return {
    appId: 'timeline-reverser',
    principalId: 'test-user-p1',
    logger: { info() {}, warn() {}, error() {} },
    capabilities: { async get() { return { capabilities: grants }; } },
    sessions: {
      async create({ agentId, namespace, memoryEnabled }) {
        sdkCalls.create.push({ agentId, namespace, memoryEnabled });
        if (missingCreate) throw new Error('create should not be called');
        return {
          ok: true,
          sessionId: 'sess-native-42',
          namespace: 'home',
          agentId,
          visibility: 'public',
          ownerPluginId: 'timeline-reverser',
        };
      },
      async context(input) {
        const sessionId = typeof input === 'object' ? input.sessionId : input;
        return { sessionId, isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
      },
      async stageFile({ sessionId, path: filePath, name, mime, scope, deliverAs }) {
        // 必须在 service 回调期间读取 bytes；交付成功后私有临时文件会被删除。
        const bytes = Buffer.from(await fs.readFile(filePath));
        const fileId = name === 'handoff.md' ? 'file_handoff_md' : 'file_report_pdf';
        sdkCalls.stageFile.push({ sessionId, name, mime, scope, deliverAs, fileId, bytes });
        return {
          resource: { kind: 'session-file', fileId, sessionId },
          file: { name },
        };
      },
      async sendCustom({ sessionId, customType, content, details, display, triggerTurn, scope }) {
        sdkCalls.sendCustom.push({ sessionId, customType, content, details, display, triggerTurn, scope });
        return {
          ok: true,
          mode: 'notifyOnly',
          // 宿主回执会命名空间化；输入不能要求是这个值。
          customType: 'hana:branch-handoff',
          entryId: 'entry-custom-1',
          sessionId,
        };
      },
      async send(...args) {
        sdkCalls.send.push(args);
        throw new Error('handoff 不得调用 session.send');
      },
      focus: async ({ sessionId }) => {
        sdkCalls.focus.push(sessionId);
        return { ok: true, sessionId };
      },
    },
    agents: {
      async list() {
        sdkCalls.agentList.push({ scope: 'all', lifecycle: 'active' });
        return { agents: [{ id: 'agent-sol', name: 'Sol Architect', state: 'active' }] };
      },
    },
    // 仅用于让 fixture 自检输入 bytes 被使用；service 通过 artifacts.read 取得原文。
    _pdfBytes: pdfBytes,
  };
}

function makeCards({ artifactId, pdfBytes }) {
  return [
    {
      id: 'c-root',
      parentId: null,
      title: '需求背景',
      messages: [
        { role: 'user', text: '请分析方案' },
        { role: 'assistant', text: '方案概要如下' },
      ],
    },
    {
      id: 'c-target',
      parentId: 'c-root',
      title: '详细技术设计',
      draft: '请继续深入推导系统架构',
      messages: [
        { role: 'user', text: '请给出架构设计' },
        {
          role: 'assistant',
          text: '系统架构细节...',
          artifacts: [{
            artifactId,
            name: 'report.pdf',
            format: 'pdf',
            mime: 'application/pdf',
            bytes: pdfBytes.length,
            sha256: createHash('sha256').update(pdfBytes).digest('hex'),
            status: 'ready',
            createdAt: '2026-10-25T00:00:00.000Z',
          }],
        },
      ],
    },
  ];
}

async function makeService({ tempDir, sdk, artifacts }) {
  const service = createHandoffService({ sdk, dataDir: tempDir, artifacts });
  const routes = [];
  const app = {
    get(pattern, handler) { routes.push({ method: 'GET', pattern, handler }); },
    post(pattern, handler) { routes.push({ method: 'POST', pattern, handler }); },
  };
  service.register(app);
  return { service, routes };
}

test('integration: real builder/service/store delivery verifies canonical archive, host namespace input, and ready closure', async t => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-integration-'));
  try {
    const artifactId = 'a'.repeat(32);
    const pdfBytes = Buffer.from('fake pdf content');
    const sdkCalls = {
      create: [],
      stageFile: [],
      sendCustom: [],
      send: [],
      focus: [],
      agentList: [],
      modelInvocations: 0,
    };
    const artifacts = {
      async read({ artifactId: id }) {
        if (id !== artifactId) {
          const error = new Error('文件不存在');
          error.code = 'ARTIFACT_NOT_FOUND';
          throw error;
        }
        return {
          bytes: pdfBytes,
          metadata: {
            artifactId,
            name: 'report.pdf',
            format: 'pdf',
            mime: 'application/pdf',
            bytes: pdfBytes.length,
            sha256: createHash('sha256').update(pdfBytes).digest('hex'),
            status: 'ready',
            createdAt: '2026-10-25T00:00:00.000Z',
          },
        };
      },
    };
    const sdk = makeSdk({ sdkCalls, pdfBytes });
    const { routes } = await makeService({ tempDir, sdk, artifacts });
    let preparedContext = null;
    const requestLog = [];
    let readyAction = null;
    const requestHost = makeRequestHost({
      routes,
      onBody: item => {
        requestLog.push(item);
        if (item.path === '/api/handoff/prepare') preparedContext = item.body;
        if (item.path === '/api/handoff/confirm') {
          // requestLog proves confirm body only carried actionId.
        }
      },
      onResponse: item => {
        if (item.path === '/api/handoff/confirm') readyAction = item.body?.action || null;
      },
    });

    const cards = makeCards({ artifactId, pdfBytes });
    const savedSnapshot = {
      id: 'canvas-active-record-99',
      revision: 3,
      snapshot: {
        cards,
        view: { x: 0, y: 0, scale: 1 },
        agent: { id: 'agent-sol', name: 'Sol Architect', provider: 'test', model: 'test-model' },
      },
    };
    const documentRef = createFakeDocument();
    const deps = {
      hana: { sessions: sdk.sessions, api: { fetch: async () => response({ ok: true }) } },
      requestHost,
      sessionController: {
        get state() { return { activeId: savedSnapshot.id, generation: 1, ready: true, busy: false, dirty: false, saving: false, error: '' }; },
        get generation() { return 1; },
        getSavedSnapshot: () => JSON.parse(JSON.stringify(savedSnapshot)),
        flush: async () => {},
      },
      getSessionController: () => deps.sessionController,
      getCards: () => cards,
      isCardBusy: () => false,
      flashMessage: () => {},
      safeDetail: String,
      getIsDisposed: () => false,
      documentRef,
    };
    const handoff = createPanelHandoff(deps);
    await handoff.open('c-target');
    const dialog = documentRef.body.querySelector('.handoff-dialog');
    assert.ok(dialog, '真实 controller 必须挂载预览');
    const previewText = dialog.textContent;
    const noticesText = dialog.querySelector('.handoff-notices')?.textContent || '';

    // 走真实 UI 入口完成 prepare/confirm；断言分组放在流程之后，保证每个缺陷都执行。
    dialog.querySelector('.btn-copy-draft').dispatchEvent({ type: 'click' });
    dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
    await waitFor(() => dialog.querySelector('.btn-handoff-confirm')?.style.display === 'inline-block');
    dialog.querySelector('.btn-handoff-confirm').dispatchEvent({ type: 'click' });
    await waitFor(() => dialog.querySelector('.btn-handoff-focus')?.style.display === 'inline-block', { timeoutMs: 3000 });

    const confirmLog = requestLog.find(item => item.path === '/api/handoff/confirm');
    const readyResponse = sdkCalls.sendCustom[0];
    const stageReceipts = sdkCalls.stageFile.map(file => ({ fileId: file.fileId, name: file.name, mime: file.mime }));
    const artifactStage = sdkCalls.stageFile.find(file => file.name === 'report.pdf');
    const archiveStage = sdkCalls.stageFile.find(file => file.name === 'handoff.md');
    const expectedArchive = preparedContext && artifactStage
      ? formatHandoffTranscript(preparedContext, { files: [{ fileId: artifactStage.fileId, name: artifactStage.name, mime: artifactStage.mime }] })
      : null;
    const expectedCustom = preparedContext && artifactStage && archiveStage
      ? formatHandoffTranscript(preparedContext, {
        files: [{ fileId: artifactStage.fileId, name: artifactStage.name, mime: artifactStage.mime }],
        archiveFile: { fileId: archiveStage.fileId, name: archiveStage.name, mime: archiveStage.mime },
      })
      : null;

    await t.test('真实 DTO 预览', () => {
      assert.ok(previewText.includes('系统架构细节...'), '助手正文必须在预览中可见');
      assert.equal(previewText.includes('(无正文)'), false);
      assert.equal(previewText.includes('[object Object]'), false, 'notice.message 不得被对象强转');
      assert.ok(noticesText.length > 0, '真实完整性说明必须进入预览');
    });

    await t.test('prepare/confirm 请求契约', () => {
      assert.ok(preparedContext, 'prepare 必须提交真实 builder DTO');
      assert.equal(preparedContext.source.canvasId, savedSnapshot.id);
      assert.equal(preparedContext.source.targetCardId, 'c-target');
      assert.equal(preparedContext.agentId, 'agent-sol');
      assert.equal(confirmLog?.body && Object.keys(confirmLog.body).length, 1);
      assert.equal(confirmLog?.body?.actionId?.startsWith('ha_'), true);
    });

    await t.test('stage 回调在删除临时文件前保存 MIME/name/bytes', () => {
      assert.equal(sdkCalls.stageFile.length, 2, '必须只 stage 产物和 handoff.md');
      assert.deepEqual(artifactStage?.bytes, pdfBytes, '产物 bytes 必须在 SDK 回调当时保存');
      assert.equal(artifactStage?.mime, 'application/pdf');
      assert.equal(artifactStage?.name, 'report.pdf');
      assert.equal(archiveStage?.mime, 'text/markdown');
      assert.equal(archiveStage?.name, 'handoff.md');
      assert.ok(sdkCalls.stageFile.every(file => file.scope === 'all' && file.deliverAs === 'attachment'));
      assert.ok(Buffer.isBuffer(archiveStage?.bytes) && archiveStage.bytes.length > 0);
    });

    await t.test('canonical archive/custom 正文不混淆', () => {
      assert.equal(archiveStage?.bytes.toString('utf8'), expectedArchive, 'handoff.md 必须是无 archive 索引的 canonical formatter 结果');
      assert.equal(readyResponse?.content, expectedCustom, 'custom 正文必须包含 archiveFile 索引的 canonical formatter 结果');
      assert.notEqual(expectedArchive, expectedCustom, 'archive 与 custom 正文按设计不应相等');
    });

    await t.test('sendCustom 输入与 ready action 文件闭环', () => {
      assert.equal(sdkCalls.sendCustom.length, 1);
      const custom = sdkCalls.sendCustom[0];
      assert.equal(custom.customType, 'branch-handoff', '输入 customType 是 branch-handoff，宿主命名空间只在回执上出现');
      assert.equal(custom.scope, 'all');
      assert.deepEqual(sdkCalls.agentList[0], { scope: 'all', lifecycle: 'active' });
      assert.equal(custom.display, true);
      assert.equal(custom.triggerTurn, false);
      assert.deepEqual(Object.keys(custom.details).sort(), ['actionId', 'source']);
      assert.equal(custom.details.actionId, confirmLog.body.actionId);
      assert.deepEqual(custom.details.source, preparedContext.source);
      assert.deepEqual(stageReceipts.map(file => file.name).sort(), ['handoff.md', 'report.pdf']);
      assert.equal(readyAction.entryId, 'entry-custom-1');
      assert.deepEqual(readyAction.files.map(file => file.name).sort(), ['handoff.md', 'report.pdf']);
      assert.ok(readyAction.files.every(file => file.fileId && file.name && file.mime), 'ready.action.files 必须闭环宿主回执');
    });

    await t.test('禁止推理/旧 send', () => {
      assert.equal(sdkCalls.send.length, 0);
      assert.equal(sdkCalls.modelInvocations, 0);
    });

    assert.equal(readyAction?.actionId, confirmLog?.body?.actionId, 'ready actionId 必须与 confirm actionId 一致');
    const focusButton = dialog.querySelector('.btn-handoff-focus');
    focusButton.dispatchEvent({ type: 'click' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sdkCalls.focus, ['sess-native-42']);
    handoff.dispose();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('integration: missing home permission fails closed before create', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-integration-perm-'));
  try {
    const pdfBytes = Buffer.from('unused');
    const sdkCalls = { create: [], stageFile: [], sendCustom: [], send: [], focus: [], agentList: [], modelInvocations: 0 };
    const sdk = makeSdk({
      sdkCalls,
      pdfBytes,
      missingCreate: true,
      capabilities: [
        { capability: 'app/sessions.read', status: 'always' },
        { capability: 'app/sessions.manage', status: 'always' },
        { capability: 'app/session.stage-file', status: 'always' },
        { capability: 'app/agents.read', status: 'always' },
      ],
    });
    const artifacts = { read: async () => null };
    const { routes } = await makeService({ tempDir, sdk, artifacts });
    const cards = [{ id: 'c1', parentId: null, title: 'C1', messages: [{ role: 'user', text: 'hi' }] }];
    const savedSnapshot = {
      id: 'canvas-perm',
      revision: 1,
      snapshot: { cards, view: { x: 0, y: 0, scale: 1 }, agent: { id: 'agent-sol', name: 'Sol Architect' } },
    };
    const requestHost = async (_hana, reqPath, init = {}) => {
      if (reqPath === '/api/agents') return response({ ok: true, agents: [{ id: 'agent-sol', name: 'Sol Architect' }] });
      return makeRequestHost({ routes })(_hana, reqPath, init);
    };
    const documentRef = createFakeDocument();
    const handoff = createPanelHandoff({
      hana: { sessions: sdk.sessions },
      requestHost,
      sessionController: {
        get state() { return { activeId: savedSnapshot.id, generation: 1, ready: true, busy: false, dirty: false, saving: false, error: '' }; },
        getSavedSnapshot: () => JSON.parse(JSON.stringify(savedSnapshot)),
        flush: async () => {},
      },
      getCards: () => cards,
      isCardBusy: () => false,
      flashMessage: () => {},
      safeDetail: String,
      getIsDisposed: () => false,
      documentRef,
    });
    await handoff.open('c1');
    const dialog = documentRef.body.querySelector('.handoff-dialog');
    assert.ok(dialog);
    dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });
    await waitFor(() => dialog.querySelector('.handoff-error')?.style.display === 'block');
    assert.equal(sdkCalls.create.length, 0, '缺少 home 权限不得创建会话');
    assert.equal(dialog.querySelector('.btn-handoff-confirm').style.display, 'none');
    handoff.dispose();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
