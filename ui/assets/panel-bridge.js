/**
 * 桥接导入与装配模块 (Bridge Controller)
 *
 * 负责本体会话列表加载、分支树与历史快照预览、导入卡片生成、发件箱展示以及桥接全局生命周期协调。
 * 严禁在顶层访问 window / document / localStorage，所有 DOM 与跨模块依赖均由 deps 注入。
 * 严禁反向 import panel.js。
 */

import { escapeHtml as defaultEscapeHtml } from './panel-format.js';
import { safeDetail as defaultSafeDetail } from './host-api.js';
import { assertFunction, assertFunctions, assertOptionalFunctions } from './panel-contracts.js';

/** 会话尾号辅助函数：同名会话靠这个区分 */
export function shortId(id) {
  const text = String(id || '');
  return text.length > 8 ? text.slice(-6) : text;
}

/** 选择的桥接导入种类：纯函数，也可作为模块导出供单测或跨模块使用 */
export function selectedBridgeKind(kindSelect) {
  return kindSelect?.value === 'tree-path' ? 'tree-path' : 'history';
}

export function createBridge(deps = {}) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createBridge: deps must be an object');
  }

  assertFunctions(deps, [
    'bridgeRequest', 'canMutateCanvas', 'getGeneration',
    'createBridgeDocCard', 'flushSession', 'getCanvasId'
  ], 'createBridge');

  assertOptionalFunctions(deps, [
    'isDisposed', 'safeDetail', 'escapeHtml', 'flashMessage',
    'getOwnedClaims', 'bindBridgeSend', 'pollBridgeIntents',
    'addCleanup', 'setIntervalRef', 'clearIntervalRef', 'listen'
  ], 'createBridge');

  const {
    documentRef,
    windowRef,
    hana,
    isDisposed = () => false,
    bridgeRequest,
    safeDetail = defaultSafeDetail,
    escapeHtml = defaultEscapeHtml,
    flashMessage = () => {},
    canMutateCanvas,
    getGeneration,
    createBridgeDocCard,
    flushSession,
    getCanvasId,
    getOwnedClaims = () => null,
    bindBridgeSend = () => {},
    pollBridgeIntents = () => {},
    addCleanup = () => {},
    setIntervalRef = typeof setInterval === 'function' ? setInterval : null,
    clearIntervalRef = typeof clearInterval === 'function' ? clearInterval : null,
    listen = (target, type, listener, options) => {
      if (!target?.addEventListener) return () => {};
      target.addEventListener(type, listener, options);
      return () => target.removeEventListener(type, listener, options);
    },
    bridgeDialogEl,
    bridgeSessionSelect,
    bridgeKindSelect,
    bridgeLeafSelect,
    bridgeLeafField,
    bridgePreviewEl,
    bridgeErrorEl,
    bridgeImportBtn,
    bridgeActiveHint,
  } = deps;

  let bridgePreviewCache = null;
  let bridgeTargetSessionId = null;
  let bridgeInitialized = false;

  const checkDisposed = () => (typeof isDisposed === 'function' ? isDisposed() : Boolean(isDisposed));
  const getDoc = () => (typeof documentRef === 'function' ? documentRef() : (typeof document !== 'undefined' ? document : null));
  const getWin = () => (typeof windowRef === 'function' ? windowRef() : (typeof window !== 'undefined' ? window : null));
  const getEl = (id) => getDoc()?.getElementById(id);
  const getHana = () => (typeof hana === 'function' ? hana() : (typeof hana !== 'undefined' ? hana : null));

  const getDialog = () => (typeof bridgeDialogEl === 'function' ? bridgeDialogEl() : (bridgeDialogEl || getEl('bridge-dialog')));
  const getSessionSelect = () => (typeof bridgeSessionSelect === 'function' ? bridgeSessionSelect() : (bridgeSessionSelect || getEl('bridge-session-select')));
  const getKindSelect = () => (typeof bridgeKindSelect === 'function' ? bridgeKindSelect() : (bridgeKindSelect || getEl('bridge-kind-select')));
  const getLeafSelect = () => (typeof bridgeLeafSelect === 'function' ? bridgeLeafSelect() : (bridgeLeafSelect || getEl('bridge-leaf-select')));
  const getLeafField = () => (typeof bridgeLeafField === 'function' ? bridgeLeafField() : (bridgeLeafField || getEl('bridge-leaf-field')));
  const getPreviewEl = () => (typeof bridgePreviewEl === 'function' ? bridgePreviewEl() : (bridgePreviewEl || getEl('bridge-preview')));
  const getErrorEl = () => (typeof bridgeErrorEl === 'function' ? bridgeErrorEl() : (bridgeErrorEl || getEl('bridge-dialog-error')));
  const getImportBtn = () => (typeof bridgeImportBtn === 'function' ? bridgeImportBtn() : (bridgeImportBtn || getEl('btn-bridge-import')));
  const getActiveHint = () => (typeof bridgeActiveHint === 'function' ? bridgeActiveHint() : (bridgeActiveHint || getEl('bridge-active-hint')));

  function bridgeFail(el, err) {
    if (checkDisposed()) return;
    if (el) el.textContent = safeDetail(err?.message || String(err));
  }

  function bridgeClearError() {
    const errorEl = getErrorEl();
    if (errorEl) errorEl.textContent = '';
  }

  function resolveSelectedBridgeKind() {
    return selectedBridgeKind(getKindSelect());
  }

  function resetBridgeLeafChoices() {
    const leafField = getLeafField();
    const leafSelect = getLeafSelect();
    if (leafField) leafField.hidden = true;
    if (leafSelect) {
      leafSelect.disabled = true;
      leafSelect.innerHTML = '<option value="">选择树状导入后读取</option>';
      leafSelect.value = '';
    }
  }

  function renderBridgeLeafChoices(preview) {
    const branches = Array.isArray(preview?.branches) ? preview.branches : [];
    const leafField = getLeafField();
    const leafSelect = getLeafSelect();
    if (leafField) leafField.hidden = false;
    if (!leafSelect) return;
    leafSelect.innerHTML = branches.length
      ? '<option value="">请选择一个叶节点</option>' + branches.map((branch, index) => {
        const id = String(branch.leafId || '');
        const count = Number.isFinite(branch.messageCount) ? ` · ${branch.messageCount} 条` : '';
        const summary = branch.lastText ? ` · ${String(branch.lastText).slice(0, 80)}` : '';
        return `<option value="${escapeHtml(id)}">分支 ${index + 1}${count}${escapeHtml(summary)}</option>`;
      }).join('')
      : '<option value="">该会话没有可选叶节点</option>';
    const selected = preview?.leafId || '';
    leafSelect.value = selected;
    leafSelect.disabled = branches.length === 0;
  }

  async function loadBridgeSessions(preferSessionId = null) {
    if (checkDisposed()) return;
    bridgeClearError();
    const sessionSelect = getSessionSelect();
    const importBtn = getImportBtn();
    const activeHint = getActiveHint();
    const errorEl = getErrorEl();
    if (sessionSelect) sessionSelect.innerHTML = '<option value="">正在读取…</option>';
    try {
      const h = getHana();
      const [data, active] = await Promise.all([
        bridgeRequest('/api/bridge/sessions'),
        (h && h.sessions && typeof h.sessions.getActive === 'function')
          ? h.sessions.getActive().catch(() => null)
          : null,
      ]);
      if (checkDisposed()) return;
      // 保持宽松：字段缺失保持空数组，不抛错（防盖掉已冻结提示）
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      if (!sessionSelect) return;
      if (!sessions.length) {
        sessionSelect.innerHTML = '<option value="">没有可读的本体会话</option>';
        if (importBtn) importBtn.disabled = true;
        return;
      }
      const activeSessionId = active?.sessionId || null;
      const targetId = preferSessionId || activeSessionId || sessions[0]?.sessionId || '';

      sessionSelect.innerHTML = sessions.map((s) => {
        const count = s.messageCount == null ? '' : `（${s.messageCount} 条）`;
        const isTarget = s.sessionId === targetId;
        const isCur = s.sessionId === activeSessionId ? ' [当前活跃]' : '';
        return `<option value="${escapeHtml(s.sessionId)}"${isTarget ? ' selected' : ''}>${escapeHtml(s.title || s.sessionId)}${isCur}${count} · ${escapeHtml(shortId(s.sessionId))}</option>`;
      }).join('');

      if (targetId) {
        sessionSelect.value = targetId;
        bridgeTargetSessionId = targetId;
        if (activeHint) {
          activeHint.textContent = `已自动绑定：${active?.title || targetId}`;
        }
        if (importBtn) importBtn.disabled = false;
        void runBridgePreview();
      }
    } catch (err) {
      if (checkDisposed()) return;
      if (sessionSelect) sessionSelect.innerHTML = '<option value="">读取失败</option>';
      bridgeFail(errorEl, err);
    }
  }

  async function bindActiveSession() {
    if (checkDisposed()) return;
    bridgeClearError();
    const activeHint = getActiveHint();
    const sessionSelect = getSessionSelect();
    const importBtn = getImportBtn();
    try {
      const h = getHana();
      const active = await h.sessions.getActive();
      if (checkDisposed()) return;
      if (!active?.sessionId) {
        if (activeHint) activeHint.textContent = '当前窗口没有选中会话';
        return;
      }
      bridgeTargetSessionId = active.sessionId;
      if (activeHint) activeHint.textContent = `已绑定：${active.title || active.sessionId}`;
      if (sessionSelect) {
        sessionSelect.value = active.sessionId;
        if (importBtn) importBtn.disabled = false;
        void runBridgePreview();
      }
    } catch {
      if (checkDisposed()) return;
      if (activeHint) activeHint.textContent = '当前窗口不支持读取本体会话';
    }
  }

  async function runBridgePreview() {
    if (checkDisposed()) return;
    bridgeClearError();
    bridgePreviewCache = null;
    const sessionSelect = getSessionSelect();
    const importBtn = getImportBtn();
    const previewEl = getPreviewEl();
    const leafField = getLeafField();
    const leafSelect = getLeafSelect();
    const errorEl = getErrorEl();

    const sessionId = sessionSelect?.value;
    const kind = resolveSelectedBridgeKind();
    const leafId = kind === 'tree-path' ? (leafSelect?.value || null) : null;
    if (kind === 'history') resetBridgeLeafChoices();
    else if (leafField) leafField.hidden = false;
    if (!sessionId) {
      if (importBtn) importBtn.disabled = true;
      return;
    }
    if (importBtn) importBtn.disabled = true;
    if (previewEl) {
      previewEl.innerHTML = kind === 'tree-path'
        ? '<p class="bridge-placeholder">正在读取分支树…</p>'
        : '<p class="bridge-placeholder">正在读取最新对话快照…</p>';
    }
    try {
      const payload = { sessionId, kind, limit: 100 };
      if (leafId) payload.leafId = leafId;
      const data = await bridgeRequest('/api/bridge/preview', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const preview = data?.preview;
      bridgePreviewCache = preview;
      if (kind === 'tree-path') renderBridgeLeafChoices(preview);

      const messages = Array.isArray(preview?.messages) ? preview.messages : [];
      if (kind === 'tree-path' && preview?.needsLeafChoice) {
        if (previewEl) previewEl.innerHTML = '<p class="bridge-placeholder">该会话有多个分支，请选择一个叶节点后再导入。</p>';
        return;
      }
      if (!messages.length) {
        if (previewEl) previewEl.innerHTML = '<p class="bridge-placeholder">该会话暂无可见消息。</p>';
        return;
      }
      const rows = messages.map((m) => `
        <div class="bridge-msg">
          <span class="bridge-msg-role ${m.role === 'user' ? 'is-user' : ''}">${m.role === 'user' ? '用户' : '助手'}</span>
          ${escapeHtml(String(m.text || '').slice(0, 600))}${String(m.text || '').length > 600 ? '…' : ''}
        </div>
      `).join('');
      const warn = [];
      if (preview.truncated) warn.push(`已截取最近 ${messages.length} 条记录`);
      if (preview.droppedCount) warn.push(`${preview.droppedCount} 条不可见条目已过滤`);
      if (preview.status?.isStreaming) warn.push('该会话正在生成中');
      if (previewEl) previewEl.innerHTML = rows + (warn.length ? `<div class="bridge-warn">${escapeHtml(warn.join('；'))}</div>` : '');
      if (importBtn) importBtn.disabled = false;
    } catch (err) {
      if (checkDisposed()) return;
      if (previewEl) previewEl.innerHTML = '<p class="bridge-placeholder">读取快照失败。</p>';
      bridgeFail(errorEl, err);
    }
  }

  async function importBridgePreview() {
    if (!canMutateCanvas()) return;
    const generation = typeof getGeneration === 'function' ? getGeneration() : null;
    const sessionSelect = getSessionSelect();
    const leafSelect = getLeafSelect();
    const importBtn = getImportBtn();
    const errorEl = getErrorEl();
    const dialog = getDialog();

    const sessionId = sessionSelect?.value;
    const kind = resolveSelectedBridgeKind();
    const leafId = kind === 'tree-path' ? (leafSelect?.value || null) : null;
    if (!sessionId) {
      bridgeFail(errorEl, new Error('请先选择一个会话'));
      return;
    }
    bridgeClearError();
    if (importBtn) {
      importBtn.disabled = true;
      importBtn.textContent = '正在导入…';
    }
    try {
      let preview = bridgePreviewCache;
      const previewMatches = preview
        && preview.session?.sessionId === sessionId
        && (kind === 'history'
          ? preview.kind === 'history'
          : preview.kind === 'tree' && Boolean(leafId) && preview.leafId === leafId);
      if (!previewMatches) {
        const payload = { sessionId, kind, limit: 100 };
        if (leafId) payload.leafId = leafId;
        const data = await bridgeRequest('/api/bridge/preview', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        if (!canMutateCanvas(generation)) return;
        preview = data?.preview;
        bridgePreviewCache = preview;
      }
      if (!canMutateCanvas(generation)) return;
      if (preview?.needsLeafChoice) {
        flashMessage('请先选择一个分支叶节点。');
        return;
      }
      const messages = Array.isArray(preview?.messages) ? preview.messages : [];
      if (!messages.length) {
        flashMessage('该会话没有可导入的对话记录。');
        return;
      }
      const body = messages.map((m) => `【${m.role === 'user' ? '用户' : '助手'}】${m.text}`).join('\n\n');
      const text = `# ${preview.session?.title || '本体会话'}\n\n> 本体导入快照。只读摘录，不代表原会话仍在同步。\n\n${body}`;
      const sourceRef = {
        version: 1,
        kind: 'hana-session',
        sessionId: preview.session?.sessionId,
        entryIds: messages.map((m) => m.entryId).filter(Boolean),
        leafId: preview.leafId || leafId || null,
        titleAtImport: preview.session?.title || '',
        importedAt: new Date().toISOString(),
        contentHash: '',
        importKind: kind,
      };
      // 内容哈希用与服务端同一套规则，保证去重键一致
      let h1 = 0x811c9dc5;
      let h2 = 0x01000193;
      const payload = messages.map((m) => `${m.role}:${m.text}`).join('\u0000');
      for (let i = 0; i < payload.length; i += 1) {
        const code = payload.charCodeAt(i);
        h1 = (h1 ^ code) >>> 0;
        h1 = Math.imul(h1, 0x01000193) >>> 0;
        h2 = (h2 + code * (i + 1)) >>> 0;
      }
      sourceRef.contentHash = `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;

      const imported = createBridgeDocCard({
        title: preview.session?.title || '本体会话',
        text,
        sourceRef,
        messageCount: messages.length,
      });
      if (!imported) {
        // 没有活动会话（或画布刚失效）时保留对话框：让用户看到原因、先去新建会话再试。
        bridgeFail(errorEl, new Error('请先新建画布会话，再导入本体内容。'));
        return;
      }
      dialog?.close();
    } catch (err) {
      bridgeFail(errorEl, err);
    } finally {
      if (!checkDisposed() && importBtn) {
        importBtn.disabled = false;
        importBtn.textContent = '导入到画布';
      }
    }
  }

  async function loadOutboxList() {
    if (checkDisposed()) return;
    const box = getEl('bridge-outbox-list');
    if (!box) return;
    try {
      const data = await bridgeRequest('/api/bridge/actions');
      const actions = Array.isArray(data?.actions) ? data.actions : [];
      if (!actions.length) {
        box.innerHTML = '<p class="bridge-placeholder">还没有回传记录。</p>';
        return;
      }
      box.innerHTML = actions.map((a) => {
        const tone = a.state === 'failed' ? 'is-bad' : (a.state === 'unknown' ? 'is-unknown' : 'is-ok');
        return `<div class="bridge-outbox-item">
          <span class="bridge-state ${tone}">${escapeHtml(a.state)}</span>
          ${escapeHtml(a.kind === 'send-text' ? '文本' : 'Markdown 文件')}
          · ${escapeHtml(a.targetSessionId)}
          ${a.errorCode ? ` · ${escapeHtml(a.errorCode)}` : ''}
        </div>`;
      }).join('');
    } catch (err) {
      if (checkDisposed()) return;
      box.innerHTML = `<p class="bridge-placeholder">${escapeHtml(safeDetail(err?.message || String(err)))}</p>`;
    }
  }

  async function deliverIntent(intent, { preview, messages, generation, release }) {
    // 精准区分：消息级导入（精确匹配 intent.messageId）还是全会话历史导入
    const targetMsg = intent.messageId ? messages.find((m) => m.entryId === intent.messageId) : null;
    // 带 messageId 却找不到：说明那条消息在预览范围外（更早、或另一条分支）。
    // 这时不能悄悄退化成"导入整段历史" —— 用户点的是那条消息，
    // 范围被悄悄放大后，后面的分支会把没打算要的内容一起喂给模型。
    if (intent.messageId && !targetMsg) {
      await release();
      flashMessage('那条消息不在这次能读到的范围里（可能更早或属于别的分支），没有导入。');
      return;
    }
    let cardTitle = '';
    let text = '';
    let importKind = 'history';
    let importEntryIds = [];
    let importedCount = 0;

    if (targetMsg) {
      importKind = 'message';
      importEntryIds = [targetMsg.entryId].filter(Boolean);
      cardTitle = intent.title ? `消息切片 · ${intent.title}` : `消息切片 · ${shortId(intent.sessionId)}`;
      text = `# ${cardTitle}\n\n> 本体导入快照（单条消息）。只读摘录，不代表原会话仍在同步。\n\n【${targetMsg.role === 'user' ? '用户' : '助手'}】${targetMsg.text}`;
      importedCount = 1;
    } else {
      importKind = 'history';
      importEntryIds = messages.map((m) => m.entryId).filter(Boolean);
      cardTitle = intent.title || preview.session?.title || '本体会话';
      const body = messages.map((m) => `【${m.role === 'user' ? '用户' : '助手'}】${m.text}`).join('\n\n');
      text = `# ${cardTitle}\n\n> 本体导入快照。只读摘录，不代表原会话仍在同步。\n\n${body}`;
      importedCount = messages.length;
    }

    const sourceRef = {
      version: 1,
      kind: 'hana-session',
      sessionId: intent.sessionId,
      entryIds: importEntryIds,
      leafId: preview.leafId || null,
      titleAtImport: intent.title || preview.session?.title || '',
      importedAt: new Date().toISOString(),
      contentHash: '',
      importKind,
    };

    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    const hashTarget = targetMsg ? `${targetMsg.role}:${targetMsg.text}` : messages.map((m) => `${m.role}:${m.text}`).join('\u0000');
    for (let i = 0; i < hashTarget.length; i += 1) {
      const code = hashTarget.charCodeAt(i);
      h1 = (h1 ^ code) >>> 0;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = (h2 + code * (i + 1)) >>> 0;
    }
    sourceRef.contentHash = `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;

    const imported = createBridgeDocCard({
      title: cardTitle,
      text,
      sourceRef,
      messageCount: importedCount,
    });

    if (!imported) {
      // 没有活动会话就不能落盘：释放凭条，不 ACK，不留下内存孤卡。
      if (canMutateCanvas(generation)) flashMessage('请先新建画布会话，再导入本体内容。');
      await release();
      return;
    }
    if (!canMutateCanvas(generation)) { await release(); return; }
    // 先落盘再 ACK：ACK 一旦发出，这条凭条就没了。
    // 如果卡片只在内存里、随后的自动保存又因配额或磁盘错误失败，
    // 就会变成「凭条已消费、内容没存下」的静默丢失。
    try {
      await flushSession();
    } catch (saveErr) {
      await release();
      flashMessage(`导入没能落盘（${safeDetail(saveErr?.message || String(saveErr))}），凭条已释放，可以重试。`);
      return;
    }

    // Sol 架构师审查补漏：flush 返回之后、发 ACK 之前，必须复查 generation！
    // 防止等待落盘期间用户切了会话，generation 发生变化导致凭条被确认到错误的会话中
    if (!canMutateCanvas(generation)) { await release(); return; }

    const canvasId = typeof getCanvasId === 'function' ? getCanvasId() : '';
    await bridgeRequest(`/api/bridge/intents/${encodeURIComponent(intent.intentId)}/ack`, {
      method: 'POST',
      body: JSON.stringify({ claimer: canvasId }),
    });

    const ownedClaims = typeof getOwnedClaims === 'function' ? getOwnedClaims() : null;
    ownedClaims?.delete(intent.intentId);
    const flashDesc = targetMsg ? `单条消息快照` : `《${cardTitle}》（${messages.length} 条记录）`;
    flashMessage(`已自动从本体导入${flashDesc}到画布。`);
  }

  function bind(bindDeps = {}) {
    if (checkDisposed() || bridgeInitialized) return;
    const dialog = getDialog();
    if (!dialog) return;

    const doc = getDoc();
    // 裁剪过的宿主（或测试里的假 document）没有这些方法，就让桥接安静退场
    if (typeof doc?.querySelectorAll !== 'function') return;

    bridgeInitialized = true;
    const listenFn = bindDeps.listen || listen;
    const openBtn = getEl('btn-bridge-open');
    if (openBtn && typeof listenFn === 'function') {
      listenFn(openBtn, 'click', async () => {
        dialog.showModal();
        await loadBridgeSessions();
        await loadOutboxList();
      });
    }
    const closeBtn = getEl('btn-bridge-close');
    if (closeBtn && typeof listenFn === 'function') listenFn(closeBtn, 'click', () => dialog.close());
    const cancelBtn = getEl('btn-bridge-cancel');
    if (cancelBtn && typeof listenFn === 'function') listenFn(cancelBtn, 'click', () => dialog.close());
    const bindActiveBtn = getEl('btn-bridge-bind-active');
    if (bindActiveBtn && typeof listenFn === 'function') listenFn(bindActiveBtn, 'click', bindActiveSession);
    const previewBtn = getEl('btn-bridge-preview');
    if (previewBtn && typeof listenFn === 'function') listenFn(previewBtn, 'click', runBridgePreview);
    const importBtn = getImportBtn();
    if (importBtn && typeof listenFn === 'function') listenFn(importBtn, 'click', importBridgePreview);
    const refreshOutboxBtn = getEl('btn-bridge-refresh-outbox');
    if (refreshOutboxBtn && typeof listenFn === 'function') listenFn(refreshOutboxBtn, 'click', loadOutboxList);

    const sessionSelect = getSessionSelect();
    const previewEl = getPreviewEl();
    if (sessionSelect && typeof listenFn === 'function') {
      listenFn(sessionSelect, 'change', () => {
        const val = sessionSelect.value;
        if (val) {
          void runBridgePreview();
        } else {
          if (importBtn) importBtn.disabled = true;
          if (previewEl) previewEl.innerHTML = '<p class="bridge-placeholder">请选择要导入的会话。</p>';
        }
      });
    }

    const kindSelect = getKindSelect();
    if (kindSelect && typeof listenFn === 'function') {
      listenFn(kindSelect, 'change', () => {
        bridgePreviewCache = null;
        void runBridgePreview();
      });
    }

    const leafSelect = getLeafSelect();
    if (leafSelect && typeof listenFn === 'function') {
      listenFn(leafSelect, 'change', () => {
        if (resolveSelectedBridgeKind() === 'tree-path') void runBridgePreview();
      });
    }

    const tabImport = getEl('bridge-tab-import');
    const paneImport = getEl('bridge-pane-import');
    const tabOutbox = getEl('bridge-tab-outbox');
    const paneOutbox = getEl('bridge-pane-outbox');

    if (tabImport && typeof listenFn === 'function') {
      listenFn(tabImport, 'click', () => {
        if (paneImport) paneImport.hidden = false;
        if (paneOutbox) paneOutbox.hidden = true;
        tabImport.classList.add('is-active');
        if (tabOutbox) tabOutbox.classList.remove('is-active');
      });
    }

    if (tabOutbox && typeof listenFn === 'function') {
      listenFn(tabOutbox, 'click', () => {
        if (paneImport) paneImport.hidden = true;
        if (paneOutbox) paneOutbox.hidden = false;
        tabOutbox.classList.add('is-active');
        if (tabImport) tabImport.classList.remove('is-active');
        void loadOutboxList();
      });
    }

    if (typeof bindBridgeSend === 'function') {
      bindBridgeSend();
    }

    if (typeof pollBridgeIntents === 'function') {
      void pollBridgeIntents();
    }

    if (typeof setIntervalRef === 'function') {
      const timer = setIntervalRef(() => {
        if (typeof pollBridgeIntents === 'function') void pollBridgeIntents();
      }, 5000);
      if (typeof addCleanup === 'function') {
        addCleanup(() => {
          if (typeof clearIntervalRef === 'function') clearIntervalRef(timer);
        });
      }
    }

    const win = getWin();
    if (win && typeof win.addEventListener === 'function' && typeof listenFn === 'function') {
      listenFn(win, 'focus', () => {
        if (typeof pollBridgeIntents === 'function') void pollBridgeIntents();
      });
    }

    if (doc && typeof doc.addEventListener === 'function' && typeof listenFn === 'function') {
      listenFn(doc, 'visibilitychange', () => {
        if (!doc.hidden && typeof pollBridgeIntents === 'function') void pollBridgeIntents();
      });
    }

    // 前台会话切换只更新提示，不改已绑定目标
    try {
      const h = getHana();
      const activeHint = getActiveHint();
      const stopActive = h?.sessions?.onActiveChanged?.((change) => {
        if (checkDisposed() || !activeHint) return;
        activeHint.textContent = change?.sessionId
          ? `当前会话：${change.title || change.sessionId}`
          : '当前窗口没有选中会话';
      });
      if (typeof stopActive === 'function' && typeof addCleanup === 'function') {
        addCleanup(stopActive);
      }
    } catch {
      // 窗口不支持就静默
    }
  }

  return {
    selectedBridgeKind: resolveSelectedBridgeKind,
    resetBridgeLeafChoices,
    renderBridgeLeafChoices,
    loadBridgeSessions,
    bindActiveSession,
    runBridgePreview,
    importBridgePreview,
    loadOutboxList,
    deliverIntent,
    bind,
    initSessionBridge: bind,
    getBridgeTargetSessionId: () => bridgeTargetSessionId,
    setBridgeTargetSessionId: (id) => { bridgeTargetSessionId = id; },
    getBridgePreviewCache: () => bridgePreviewCache,
    clearBridgePreviewCache: () => { bridgePreviewCache = null; },
    isInitialized: () => bridgeInitialized,
  };
}
