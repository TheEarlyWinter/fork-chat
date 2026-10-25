import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import { createHandoffService } from '../lib/handoff-service.js';
import { createPanelHandoff } from '../ui/assets/panel-handoff.js';

// DOM mock helper
class FakeNode {
  constructor(tag = 'div', documentRef = null) {
    this.tagName = tag.toUpperCase();
    this.documentRef = documentRef;
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.events = new Map();
    this.classList = new Set();
    this.hidden = false;
    this.open = false;
    this.disabled = false;
    this._textContent = '';
    this._value = '';
    this.dataset = {};
  }
  get value() {
    if (this.tagName === 'SELECT') {
      const selected = this.children.find(c => c.selected);
      if (selected) return selected.value;
      return this.children[0]?.value ?? '';
    }
    return this._value ?? '';
  }
  set value(v) { this._value = v; }
  get textContent() { return this._textContent; }
  set textContent(v) { this._textContent = String(v ?? ''); }
  get className() { return Array.from(this.classList).join(' '); }
  set className(v) {
    this.classList.clear();
    for (const c of String(v ?? '').trim().split(/\s+/)) {
      if (c) this.classList.add(c);
    }
  }
  get innerHTML() { return this._textContent; }
  set innerHTML(v) { this._textContent = String(v ?? ''); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k) ?? null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }
  appendChild(child) {
    if (child) {
      child.parentNode = this;
      this.children.push(child);
    }
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  addEventListener(type, handler) {
    if (!this.events.has(type)) this.events.set(type, []);
    this.events.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this.events.get(type);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  }
  dispatchEvent(event) {
    const list = this.events.get(event.type) || [];
    for (const h of list) h(event);
  }
  querySelector(selector) {
    const found = this.querySelectorAll(selector);
    return found.length > 0 ? found[0] : null;
  }
  querySelectorAll(selector) {
    const res = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) res.push(child);
        walk(child);
      }
    };
    walk(this);
    return res;
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { if (this.documentRef) this.documentRef.activeElement = this; }
}

function matches(node, selector) {
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  if (selector.startsWith('.')) return node.classList.has(selector.slice(1));
  if (selector.startsWith('[')) {
    const m = selector.match(/\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/);
    if (!m) return false;
    const attr = m[1];
    const val = m[2];
    if (val === undefined) return node.hasAttribute(attr);
    return node.getAttribute(attr) === val;
  }
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

function createFakeDocument() {
  const doc = {
    nodes: new Map(),
    activeElement: null,
    createElement(tag) { return new FakeNode(tag, doc); },
    getElementById(id) { return doc.nodes.get(id) || null; },
  };
  doc.body = new FakeNode('body', doc);
  return doc;
}

test('integration: end-to-end controller confirmation with real builder + real service/store and fake SDK', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-integration-'));
  try {
    const sdkCalls = {
      create: [],
      stageFile: [],
      sendCustom: [],
      send: [],
      modelInvocations: 0,
    };

    // Fake SDK with named session capabilities
    const fakeSdk = {
      appId: 'timeline-reverser',
      principalId: 'test-user-p1',
      logger: { info() {}, warn() {}, error() {} },
      capabilities: {
        async get() {
          return {
            capabilities: [
              { capability: 'app/sessions.home', status: 'always' },
              { capability: 'app/sessions.read', status: 'always' },
              { capability: 'app/sessions.manage', status: 'always' },
              { capability: 'app/session.stage-file', status: 'always' },
              { capability: 'app/agents.read', status: 'always' },
            ],
          };
        },
      },
      sessions: {
        async create({ agentId, namespace, memoryEnabled }) {
          sdkCalls.create.push({ agentId, namespace, memoryEnabled });
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
          const sid = typeof input === 'object' ? input.sessionId : input;
          return {
            sessionId: sid,
            isStreaming: false,
            isCompacting: false,
            pendingMessageCount: 0,
          };
        },
        async stageFile({ sessionId, path: filePath, name, mime }) {
          sdkCalls.stageFile.push({ sessionId, filePath, name, mime });
          return {
            file: { name },
            mediaItem: null,
            resource: {
              kind: 'session-file',
              fileId: `file_${name.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}`,
              sessionId,
            },
          };
        },
        async sendCustom({ sessionId, customType, content, details, display, triggerTurn, scope }) {
          sdkCalls.sendCustom.push({ sessionId, customType, content, details, display, triggerTurn, scope });
          return {
            ok: true,
            mode: 'notifyOnly',
            customType: customType || 'hana:branch-handoff',
            entryId: 'entry-custom-1',
            sessionId,
          };
        },
        async send(...args) {
          sdkCalls.send.push(args);
          throw new Error('send() must never be called during handoff');
        },
        focus: async ({ sessionId }) => ({ ok: true, sessionId }),
      },
      agents: {
        list: async () => ({
          agents: [{ id: 'agent-sol', name: 'Sol Architect', state: 'active' }],
        }),
      },
    };

    // 真实 artifactService 提供的产物
    const artifactId = 'a'.repeat(32);
    const pdfBytes = Buffer.from('fake pdf content');
    const artifacts = {
      async read({ owner, artifactId: id }) {
        if (id === artifactId) {
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
        }
        const error = new Error('文件不存在');
        error.code = 'ARTIFACT_NOT_FOUND';
        throw error;
      },
    };

    // 默认真实 handoff-host，真实 store 与真实 service
    const service = createHandoffService({
      sdk: fakeSdk,
      dataDir: tempDir,
      artifacts,
    });

    const routes = [];
    const app = {
      get(pattern, handler) { routes.push({ method: 'GET', pattern, handler }); },
      post(pattern, handler) { routes.push({ method: 'POST', pattern, handler }); },
    };
    service.register(app);

    // 构造测试卡片与快照
    const cards = [
      {
        id: 'c-root',
        parentId: null,
        title: '需求背景',
        messages: [{ role: 'user', text: '请分析方案' }, { role: 'assistant', text: '方案概要如下' }],
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
            artifacts: [
              {
                artifactId,
                name: 'report.pdf',
                format: 'pdf',
                mime: 'application/pdf',
                bytes: pdfBytes.length,
                sha256: createHash('sha256').update(pdfBytes).digest('hex'),
                status: 'ready',
                createdAt: '2026-10-25T00:00:00.000Z',
              },
            ],
          },
        ],
      },
    ];

    const savedSnapshot = {
      id: 'canvas-active-record-99',
      revision: 3,
      snapshot: { cards, view: { x: 0, y: 0, scale: 1 } },
    };

    const doc = createFakeDocument();

    const deps = {
      hana: {
        api: {
          fetch: async () => ({
            ok: true,
            json: async () => ({
              ok: true,
              agents: [{ id: 'agent-sol', name: 'Sol Architect' }],
            }),
          }),
        },
        sessions: fakeSdk.sessions,
      },
      requestHost: async (_hana, reqPath, init = {}) => {
        const method = init.method || 'GET';
        if (reqPath === '/api/agents') {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              agents: [{ id: 'agent-sol', name: 'Sol Architect' }],
            }),
          };
        }

        const parsed = new URL(`http://local${reqPath}`);
        const parts = parsed.pathname.split('/').filter(Boolean);
        const route = routes.find(candidate => {
          if (candidate.method !== method) return false;
          const expected = candidate.pattern.split('/').filter(Boolean);
          return expected.length === parts.length
            && expected.every((piece, index) => piece.startsWith(':') || piece === parts[index]);
        });
        if (!route) throw new Error(`Route not found: ${method} ${reqPath}`);

        const params = {};
        const expectedParts = route.pattern.split('/').filter(Boolean);
        expectedParts.forEach((piece, index) => {
          if (piece.startsWith(':')) params[piece.slice(1)] = decodeURIComponent(parts[index]);
        });

        const body = init.body ? JSON.parse(init.body) : undefined;
        const raw = new Request(parsed, {
          method,
          ...(init.body === undefined ? {} : { body: init.body, headers: { 'content-type': 'application/json' } }),
        });
        let responseStatus = 200;
        let responseBody = null;

        const c = {
          req: {
            raw,
            json: async () => body,
            param: name => params[name],
            query: name => parsed.searchParams.get(name),
          },
          get: key => (key === 'appRequestContext' ? { appId: 'timeline-reverser', principal: { principalId: 'test-user-p1', kind: 'authenticated' } } : undefined),
          json: (val, status = 200) => {
            responseStatus = status;
            responseBody = val;
            return {
              ok: status >= 200 && status < 300,
              status,
              json: async () => val,
            };
          },
        };

        const resp = await route.handler(c);
        if (!resp.ok) {
          const err = new Error(`HTTP ${resp.status}: ${JSON.stringify(responseBody)}`);
          err.status = resp.status;
          throw err;
        }
        return resp;
      },
      sessionController: {
        get state() { return { activeId: savedSnapshot.id, generation: 1, dirty: false }; },
        getSavedSnapshot: () => savedSnapshot,
        flush: async () => {},
      },
      getCards: () => cards,
      isCardBusy: () => false,
      flashMessage: () => {},
      safeDetail: (err) => String(err),
      getIsDisposed: () => false,
      documentRef: doc,
    };

    const handoff = createPanelHandoff(deps);
    await handoff.open('c-target');

    const flushTicks = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

    const dialog = doc.body.querySelector('.handoff-dialog');
    assert.ok(dialog, 'handoff dialog 必须挂载');

    // 验证 UI 预览必须真实呈现祖先卡片内容与附件，不得出现 (无正文) 或 [object Object]
    const nodeContents = dialog.querySelectorAll('.handoff-node-content');
    assert.ok(nodeContents.length >= 2, '必须渲染至少2个节点的正文容器');
    const allNodeText = Array.from(nodeContents).map(el => el.textContent).join('\n');
    assert.ok(allNodeText.includes('这是第二张卡片的助手回复，包含核心推导结论。'), '助手正文必须在 UI 预览中清晰可见');
    assert.equal(allNodeText.includes('(无正文)'), false, 'UI 预览正文不得错误降级为 (无正文)');
    const noticesText = dialog.querySelector('.handoff-notices')?.textContent || '';
    assert.equal(noticesText.includes('[object Object]'), false, 'UI 预览 notices 不得出现 [object Object]');

    // 复制目标草稿到 nextStep
    const copyDraftBtn = dialog.querySelector('.btn-copy-draft');
    if (copyDraftBtn) copyDraftBtn.dispatchEvent({ type: 'click' });
    await flushTicks();

    // 点击准备 prepare
    const prepareBtn = dialog.querySelector('.btn-handoff-prepare');
    prepareBtn.dispatchEvent({ type: 'click' });
    
    // 等待 prepare 完成并展现 confirm 按钮
    const confirmBtn = dialog.querySelector('.btn-handoff-confirm');
    for (let i = 0; i < 30 && confirmBtn.style.display !== 'inline-block'; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(confirmBtn.style.display, 'inline-block', 'prepare 完成后必须展示确认按钮');

    // 点击确认 confirm
    confirmBtn.dispatchEvent({ type: 'click' });
    // 等待服务完成异步创建、stage 与 sendCustom
    const focusBtn = dialog.querySelector('.btn-handoff-focus');
    for (let i = 0; i < 50 && focusBtn.style.display !== 'inline-block'; i++) {
      await new Promise(r => setTimeout(r, 20));
    }
    await flushTicks();

    // 验证 SDK 会话创建调用参数
    assert.equal(sdkCalls.create.length, 1, '必须且只创建一次宿主主页会话');
    assert.deepEqual(sdkCalls.create[0], {
      namespace: 'home',
      memoryEnabled: false,
      agentId: 'agent-sol',
    }, '创建主页会话参数必须完全符合规格');

    // 验证 stageFile
    assert.equal(sdkCalls.stageFile.length, 2, '必须且只 stage 2 份文件 (产物 + handoff.md)');
    const pdfStage = sdkCalls.stageFile.find(f => f.name === 'report.pdf');
    assert.ok(pdfStage, '必须包含产物 report.pdf');
    assert.equal(pdfStage.mime, 'application/pdf');
    assert.equal(pdfStage.sessionId, 'sess-native-42');
    const pdfStagedContent = await fs.readFile(pdfStage.filePath);
    assert.deepEqual(pdfStagedContent, pdfBytes, '交付的产物二进制内容必须完全一致');

    const mdStage = sdkCalls.stageFile.find(f => f.name === 'handoff.md');
    assert.ok(mdStage, '必须包含上下文存档 handoff.md');
    assert.equal(mdStage.mime, 'text/markdown; charset=utf-8');
    assert.equal(mdStage.sessionId, 'sess-native-42');
    const mdStagedContent = await fs.readFile(mdStage.filePath, 'utf8');
    assert.ok(mdStagedContent.length > 0, 'handoff.md 必须有正文');

    // 验证 sendCustom
    assert.equal(sdkCalls.sendCustom.length, 1, '必须且仅发送一条 sendCustom');
    const customCall = sdkCalls.sendCustom[0];
    assert.equal(customCall.sessionId, 'sess-native-42');
    assert.equal(customCall.customType, 'hana:branch-handoff', 'customType 必须为 hana:branch-handoff');
    assert.equal(customCall.scope, 'all', 'scope 必须为 all');
    assert.equal(customCall.display, true, 'display 必须为 true');
    assert.equal(customCall.triggerTurn, false, 'triggerTurn 必须为 false');
    assert.equal(customCall.content, mdStagedContent, 'sendCustom 正文必须与 handoff.md 完全一致');

    // 验证 details 闭环
    assert.ok(customCall.details, '必须携带 details 结构体');
    assert.equal(typeof customCall.details.actionId, 'string');
    assert.equal(customCall.details.source?.canvasId, 'canvas-durable-root');
    assert.equal(customCall.details.source?.targetCardId, 'c-target');
    assert.ok(Array.isArray(customCall.details.files));
    assert.equal(customCall.details.files.length, 2);
    assert.ok(customCall.details.files.every(f => f.fileId && f.name && f.mime));

    // 严禁调用推理或 send
    assert.equal(sdkCalls.send.length, 0, '严禁调用 session.send()');
    assert.equal(sdkCalls.modelInvocations, 0, '严禁发起模型推理调用');

    // 验证 ready 后的 focus
    assert.ok(focusBtn, '必须展示在 Hana 中打开按钮');
    let focusedSessionId = null;
    fakeSdk.sessions.focus = async ({ sessionId }) => { focusedSessionId = sessionId; };
    focusBtn.dispatchEvent({ type: 'click' });
    await flushTicks();
    assert.equal(focusedSessionId, 'sess-native-42');

    handoff.dispose();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('integration: missing permissions halts handoff at prepare, no session created', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-integration-perm-'));
  try {
    const fakeSdk = {
      appId: 'timeline-reverser',
      principalId: 'test-user-p1',
      logger: { info() {}, warn() {}, error() {} },
      capabilities: {
        async get() {
          return {
            capabilities: [
              // 缺少 app/sessions.home
              { capability: 'app/sessions.read', status: 'always' },
              { capability: 'app/sessions.manage', status: 'always' },
              { capability: 'app/session.stage-file', status: 'always' },
              { capability: 'app/agents.read', status: 'always' },
            ],
          };
        },
      },
      sessions: {
        create: async () => { throw new Error('should not be called'); },
        context: async () => ({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 }),
      },
      agents: {
        list: async () => ({ agents: [{ id: 'a1', name: 'A1', state: 'active' }] }),
      },
    };

    const service = createHandoffService({
      sdk: fakeSdk,
      dataDir: tempDir,
      artifacts: { read: async () => null },
    });

    const routes = [];
    const app = {
      get(pattern, handler) { routes.push({ method: 'GET', pattern, handler }); },
      post(pattern, handler) { routes.push({ method: 'POST', pattern, handler }); },
    };
    service.register(app);

    const cards = [{ id: 'c1', title: 'C1', messages: [{ role: 'user', text: 'hi' }] }];
    const doc = createFakeDocument();

    const deps = {
      hana: { api: {}, sessions: {} },
      requestHost: async (_hana, reqPath, init = {}) => {
        if (reqPath === '/api/agents') return { ok: true, json: async () => ({ ok: true, agents: [{ id: 'a1', name: 'A1' }] }) };
        const parsed = new URL(`http://local${reqPath}`);
        const route = routes.find(r => r.method === init.method && r.pattern === parsed.pathname);
        const raw = new Request(parsed, { method: init.method, body: init.body, headers: { 'content-type': 'application/json' } });
        let status = 200, body = null;
        const c = {
          req: { raw, json: async () => init.body ? JSON.parse(init.body) : undefined },
          get: key => (key === 'appRequestContext' ? { appId: 'timeline-reverser', principal: { principalId: 'test-user-p1', kind: 'authenticated' } } : undefined),
          json: (val, s = 200) => { status = s; body = val; return { ok: s >= 200 && s < 300, status: s, json: async () => val }; },
        };
        const resp = await route.handler(c);
        if (!resp.ok) {
          const err = new Error(`HTTP ${resp.status}`);
          err.status = resp.status;
          throw err;
        }
        return resp;
      },
      sessionController: {
        get state() { return { activeId: 'sess-perm', generation: 1, dirty: false }; },
        getSavedSnapshot: () => ({ id: 'sess-perm', revision: 1, snapshot: { cards, view: { x: 0, y: 0, scale: 1 } } }),
        flush: async () => {},
      },
      getCards: () => cards,
      isCardBusy: () => false,
      flashMessage: () => {},
      safeDetail: String,
      getIsDisposed: () => false,
      documentRef: doc,
    };

    const handoff = createPanelHandoff(deps);
    await handoff.open('c1');
    const dialog = doc.body.querySelector('.handoff-dialog');
    dialog.querySelector('.btn-handoff-prepare').dispatchEvent({ type: 'click' });

    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));

    const errorEl = dialog.querySelector('.handoff-error');
    assert.ok(errorEl.textContent.includes('缺少') || errorEl.textContent.includes('授权') || errorEl.textContent.includes('准备失败'));
    assert.equal(dialog.querySelector('.btn-handoff-confirm').style.display, 'none');

    handoff.dispose();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
