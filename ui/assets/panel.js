import { hana } from './sdk.js';
import { safeDetail, requestHost } from './host-api.js';
import { runChat, ChatError } from './chat-client.js';
import { parseAssistantOutput } from './assistant-output.js';
import { createForkSessionStore } from './fork-session-store.js';
import { createForkSessionController } from './fork-session-controller.js';
import { readRenameIntent, clearRenameIntent } from './fork-session-commands.js';
import { collectSubtreeCardIds, computeVisibleCards } from './panel-layout.js';
import { bindKeyboardShortcuts } from './panel-shortcuts.js';
import { formatFileSize, rootSlotPosition, escapeHtml } from './panel-format.js';
import { createAgentController } from './panel-agents.js';
import { createCanvasViewController } from './panel-canvas-view.js';
import { statusText, outputFor, asidesText, messageMarkup, createMessagePainter } from './panel-messages.js';
import { cardParentIds, cardHasParent, buildChainContext as buildContext } from './panel-context.js';
import { createDocumentPipeline } from './panel-documents.js';
import { createChatEngine } from './panel-chat-engine.js';
import { createBattleFlow } from './panel-battle-flow.js';
import { createMergeController } from './panel-merge.js';
import { clampCardWidth, clampCardHeight, buildCardHtml, cycleCardStatusStamp, findCardAncestorChain, formatCardChainMarkdown } from './panel-cards.js';
import { createHistoryController } from './panel-history-controller.js';
import { createCanvasActions } from './panel-canvas-actions.js';
import { findCardsByKeyword, getNextMatchIndex, bindSearchBarController } from './panel-search.js';

const activeRequests = new Map();

// 流式引擎：请求、回调、迟到丢弃都在这个模块里，画布只管画。
// 依赖里凡是"晚于这里才知道是什么"的一律包成箭头，避免模块求值时就把它算死。
const chatEngine = createChatEngine({
  hana, runChat, ChatError, safeDetail,
  activeRequests,
  uniqueId,
  getIsDisposed: () => isDisposed,
  canMutateCanvas: (generation) => canMutateCanvas(generation),
  cardParentIds: (card) => cardParentIds(card),
  buildChainContext: (card) => buildChainContext(card),
  paintMessage: (message) => paintMessage(message),
  renderCards: () => renderCards(),
  getAgentReasoningEffort: (id) => getAgentReasoningEffort(id),
  getCards: () => cards,
  getSession: () => sessionController,
  getAgent: () => currentAgent,
  getReasoningEffort: () => currentReasoningEffort,
  scheduleSave: () => sessionController?.scheduleSave(),
  documentRef: document,
});
function chainIsBusy(card) { return chatEngine.chainIsBusy(card); }
function sendCardPrompt(card, text, options) { return chatEngine.sendCardPrompt(card, text, options); }
let sessionController = null;
let deleteIntent = null, deleteInProgress = false;
const activeRenameCommands = new Set();
const canvasId = uniqueId('canvas');
function uniqueId(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}
let isDisposed = false;
let disposalPromise = null;
const panelCleanups = new Set();
const cardCleanups = new Set();
const battleCleanups = new Set();
const panelTimers = new Set();
const panelAbort = new AbortController();

function canMutateCanvas(generation) {
  return !isDisposed && Boolean(sessionController?.state.ready) && !sessionController.state.busy
    && (generation === undefined || generation === sessionController.generation);
}
function drain(cleanups) {
  for (const cleanup of [...cleanups]) {
    try { cleanup(); } catch { /* One failed disposer must not retain other resources. */ }
  }
  cleanups.clear();
}
function listen(target, type, handler, options, scope = panelCleanups) {
  if (isDisposed || !target?.addEventListener) return () => {};
  const guarded = event => { if (!isDisposed) return handler(event); };
  const off = () => {
    target.removeEventListener?.(type, guarded, options);
    scope.delete(off);
  };
  target.addEventListener(type, guarded, options);
  scope.add(off);
  return off;
}
function later(callback, delay) {
  if (isDisposed) return null;
  const id = setTimeout(() => {
    panelTimers.delete(id);
    if (!isDisposed) callback();
  }, delay);
  panelTimers.add(id);
  return id;
}
function cancelLater(id) { clearTimeout(id); panelTimers.delete(id); }
function inactiveError() { return new ChatError('PANEL_INACTIVE', '画布已关闭或任务已失效。'); }
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || inactiveError());
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function waitForParser(delay, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const abort = () => { clearTimeout(timer); reject(signal.reason || inactiveError()); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
  });
}

const paintMessage = createMessagePainter({
  documentRef: () => document,
  isDisposed: () => isDisposed,
});

// 画布视图状态
const view = {
  x: 60,
  y: 40,
  scale: 1,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
};

// Each App session starts with its own independent canvas.
function initialCards() { return [
  {
    id: 'card-1',
    parentId: null,
    title: '主线对话 #01',
    x: 80,
    y: 80,
    width: 340,
    messages: [
      {
        role: 'assistant',
        localOnly: true,
        text: '你好！这里是你的第一张对话卡片。\n\n在下方输入框打入你想聊的内容开启主线；随时点击卡片右侧的 [+] 按钮，即可开辟一条独立的追问分支。'
      }
    ]
  }
]; }
let cards = initialCards();
let selectedCardId = null;
let isSpacePressed = false;

// DOM 元素引用
const viewport = document.getElementById('viewport');
const surface = document.getElementById('surface');
const connectorsSvg = document.getElementById('connectors-svg');
const cardsLayer = document.getElementById('cards-layer');
const badgeStats = document.getElementById('badge-stats');
const activeAgentDisplay = document.getElementById('active-agent-display');
const zoomText = document.getElementById('zoom-text');
const btnZoomIn = document.getElementById('btn-zoom-in');
const btnZoomOut = document.getElementById('btn-zoom-out');
const btnResetView = document.getElementById('btn-reset-view');
const btnAutoTidy = document.getElementById('btn-auto-tidy');
const btnNewRoot = document.getElementById('btn-new-root');
const btnImportDoc = document.getElementById('btn-import-doc');
const globalDocInput = document.getElementById('global-doc-input');
const canvasDropIndicator = document.getElementById('canvas-drop-indicator');
const canvasSearchBar = document.getElementById('canvas-search-bar');
const canvasSearchInput = document.getElementById('canvas-search-input');
const canvasSearchCounter = document.getElementById('canvas-search-counter');
const btnSearchPrev = document.getElementById('btn-search-prev');
const btnSearchNext = document.getElementById('btn-search-next');
const btnSearchClose = document.getElementById('btn-search-close');
const sessionStatusEl = document.getElementById('session-status');
const btnRetrySave = document.getElementById('btn-retry-save');
const btnSaveCopy = document.getElementById('btn-save-copy');
const canvasEmptyState = document.getElementById('canvas-empty-state');
const btnEmptyNewSession = document.getElementById('btn-empty-new-session');
const deleteDialog = document.getElementById('delete-session-dialog');
const deleteTargetTitle = document.getElementById('delete-target-title');
const deleteDialogError = document.getElementById('delete-dialog-error');
const deleteDialogProgress = document.getElementById('delete-dialog-progress');
const btnDeleteConfirm = document.getElementById('btn-delete-confirm');
const btnDeleteCancel = document.getElementById('btn-delete-cancel');

// 多模型横向推导 (Battle) 对话框元素
const battleDialog = document.getElementById('battle-dialog');
const battlePromptInput = document.getElementById('battle-prompt-input');
const battleAgentsList = document.getElementById('battle-agents-list');
const battleSelectedCount = document.getElementById('battle-selected-count');
const battleDialogError = document.getElementById('battle-dialog-error');
const btnBattleClose = document.getElementById('btn-battle-close');
const btnBattleCancel = document.getElementById('btn-battle-cancel');
const btnBattleSubmit = document.getElementById('btn-battle-submit');
const btnUseLastPrompt = document.getElementById('btn-use-last-prompt');

// 多选与合并收敛 (Merge) 元素
const mergeToolbar = document.getElementById('merge-toolbar');
const mergeCountText = document.getElementById('merge-count-text');
const btnMergeSubmit = document.getElementById('btn-merge-submit');
const btnMergeCancel = document.getElementById('btn-merge-cancel');
const multiSelectedCardIds = new Set();

let battleTargetCard = null;
const battleSelectedAgentIds = new Set();

// 跨窗口同步助手与模型状态
const bus = new BroadcastChannel('fork-chat-bus');
let currentAgent = {
  id: localStorage.getItem('fork_chat_active_agent_id') || 'hakimi',
  name: localStorage.getItem('fork_chat_active_agent_name') || 'Hakimi',
  model: localStorage.getItem('fork_chat_active_agent_model') || 'gemini-3.8-flash-high',
  provider: localStorage.getItem('fork_chat_active_agent_provider') || 'gemini'
};
let currentReasoningEffort = (() => {
  try {
    const val = localStorage.getItem('fork_chat_reasoning_effort');
    return val && val !== 'default' ? val : null;
  } catch {
    return null;
  }
})();

const agentController = createAgentController({
  getAgent: () => currentAgent,
  setAgent: next => { currentAgent = next; },
  getReasoningEffort: () => currentReasoningEffort,
  setReasoningEffort: next => { currentReasoningEffort = next; },
  activeAgentDisplay,
  isBusy: () => Boolean(sessionController?.state.busy || deleteIntent),
  renderCards: () => renderCards(),
  scheduleSave: () => sessionController?.scheduleSave(),
  isDisposed: () => isDisposed,
  hana,
  requestHost,
  abortable,
  getSignal: () => panelAbort.signal,
  storage: typeof localStorage !== 'undefined' ? localStorage : null,
});

const updateHeaderStatus = () => agentController.updateHeaderStatus();
const getAgentReasoningEffort = id => agentController.getAgentReasoningEffort(id);
const loadAvailableAgents = () => agentController.loadAvailableAgents();

updateHeaderStatus();

bus.onmessage = (e) => {
  if (isDisposed) return;
  const message = e.data;
  if (message?.targetCanvasId && message.targetCanvasId !== canvasId) return;
  if (message?.type === 'FORK_SESSION_HELLO') {
    publishSessionState(message.panelId);
    return;
  }
  if (agentController.handleBroadcast(message)) {
    return;
  }
  if (message?.type === 'FORK_SESSION_COMMAND') {
    if (message.targetCanvasId !== canvasId || !sessionController) return;
    if (deleteIntent) { replySessionCommand(message, { ok: false, error: '请先处理当前删除确认。' }); return; }
    if (message.command === 'rename') { void renameSessionFromIntent(message); return; }
    if (message.command === 'delete') { void openDeleteConfirmation(message); return; }
    const operation = message.command === 'new' ? sessionController.newSession(initialSnapshot())
      : message.command === 'switch' ? sessionController.switchTo(message.sessionId)
      : sessionController.state.ready ? sessionController.refresh() : sessionController.init();
    void operation.catch(() => {});
    return;
  }
};

// 画布视图、连线、选择与导航控制器 (Canvas View Controller)
const canvasViewController = createCanvasViewController({
  getCards: () => cards,
  getSelectedCardId: () => selectedCardId,
  setSelectedCardId: id => { selectedCardId = id; },
  view,
  multiSelectedCardIds,
  surface,
  viewport,
  zoomText,
  connectorsSvg,
  btnZoomIn,
  btnZoomOut,
  getIsSpacePressed: () => isSpacePressed,
  canMutateCanvas: () => canMutateCanvas(),
  renderCards: () => renderCards(),
  scheduleSave: () => sessionController?.scheduleSave(),
  recordSnapshot: (c, sId) => historyManager.recordSnapshot(c, sId),
  clearMultiSelect: () => clearMultiSelect(),
  isDisposed: () => isDisposed,
  listen,
  later,
  documentRef: document,
  windowRef: typeof window !== 'undefined' ? window : null,
});
canvasViewController.bind();

const updateTransform = () => canvasViewController.updateTransform();
const renderConnectors = () => canvasViewController.renderConnectors();
const fitViewportToCluster = clusterCards => canvasViewController.fitViewportToCluster(clusterCards);
const calculateBranchYPositions = (parent, count, targetX) => canvasViewController.calculateBranchYPositions(parent, count, targetX);
const selectCard = (cardId, focusInput) => canvasViewController.selectCard(cardId, focusInput);
const ensureCardInView = card => canvasViewController.ensureCardInView(card);
const focusCardInViewport = card => canvasViewController.focusCardInViewport(card);
const navigateCardFocus = direction => canvasViewController.navigateCardFocus(direction);
const autoTidyLayout = () => canvasViewController.autoTidyLayout();
const visibleCardsForFraming = () => canvasViewController.visibleCardsForFraming();

// 画布卡片结构修改动作控制器 (Canvas Actions)
const canvasActions = createCanvasActions({
  getCards: () => cards,
  setCards: next => { cards = next; },
  getSelectedCardId: () => selectedCardId,
  setSelectedCardId: id => { selectedCardId = id; },
  multiSelectedCardIds,
  canMutateCanvas: () => canMutateCanvas(),
  chainIsBusy: card => chainIsBusy(card),
  isBusy: () => Boolean(!sessionController?.state.ready || sessionController?.state.busy),
  isModalOpen: () => Boolean(battleDialog?.open || deleteDialog?.open || bridgeDialogEl?.open || bridgeSendDialogEl?.open),
  abortActiveRequest: id => {
    activeRequests.get(id)?.controller.abort(new ChatError('REQUEST_CANCELLED', '卡片已关闭。'));
  },
  abortDocumentTasksFor: id => abortDocumentTasksFor(id),
  calculateBranchYPositions: (parent, count, targetX) => calculateBranchYPositions(parent, count, targetX),
  renderCards: () => renderCards(),
  scheduleSave: () => sessionController?.scheduleSave(),
  recordSnapshot: (c, sId) => historyManager?.recordSnapshot(c, sId),
  selectCard: (id, focus) => selectCard(id, focus),
  ensureCardInView: card => ensureCardInView(card),
  focusCardInViewport: card => focusCardInViewport(card),
  flashMessage: msg => flashMessage(msg),
  getSessionController: () => sessionController,
  initialSnapshot: () => initialSnapshot(),
  uniqueId,
  isDisposed: () => isDisposed,
});

const rememberRemovedCard = card => canvasActions.rememberRemovedCard(card);
const removedCardArchive = canvasActions.removedCardArchive;
const createRootCard = () => canvasActions.createRootCard();
const createBranchCard = (card, opts) => canvasActions.createBranchCard(card, opts);
const closeCardHierarchy = card => canvasActions.closeCardHierarchy(card);
const createBridgeDocCard = opts => canvasActions.createBridgeDocCard(opts);

// 画布历史撤销与重做控制器 (History Controller)
const historyManager = createHistoryController({
  getCards: () => cards,
  setCards: next => { cards = next; },
  getSelectedCardId: () => selectedCardId,
  setSelectedCardId: id => { selectedCardId = id; },
  getRemovedCardArchive: () => canvasActions.removedCardArchive,
  renderCards: () => renderCards(),
  renderConnectors: () => renderConnectors(),
  scheduleSave: () => sessionController?.scheduleSave(),
  isDisposed: () => isDisposed,
  maxDepth: 30,
});
historyManager.recordSnapshot(cards, null);

// 向上递归回溯祖先节点，拼装从根节点到当前节点的完整上下文链路
const buildChainContext = targetCard => buildContext({ cards, targetCard });


// 对比推导：弹窗、选择、并发开分支
const battleFlow = createBattleFlow({
  battleDialog, battlePromptInput, battleAgentsList, battleSelectedCount,
  battleDialogError, btnBattleClose, btnBattleCancel, btnBattleSubmit, btnUseLastPrompt,
  listen, documentRef: document,
  getAgentReasoningEffort: (id) => getAgentReasoningEffort(id),
  getAvailableAgents: () => agentController.getAvailableAgents(),
  loadAvailableAgents: () => agentController.loadAvailableAgents(),
  chainIsBusy: (card) => chainIsBusy(card),
  getCards: () => cards,
  getSession: () => sessionController,
  getIsDisposed: () => isDisposed,
  canMutateCanvas: (generation) => canMutateCanvas(generation),
  cardHasParent: (card, id) => cardHasParent(card, id),
  calculateBranchYPositions: (...args) => calculateBranchYPositions(...args),
  fitViewportToCluster: (...args) => fitViewportToCluster(...args),
  renderCards: () => renderCards(),
  scheduleSave: () => sessionController?.scheduleSave(),
  recordSnapshot: (list, id) => historyManager.recordSnapshot(list, id),
  getSelectedCardId: () => selectedCardId,
  sendCardPrompt: (card, text, options) => sendCardPrompt(card, text, options),
  uniqueId: (...args) => uniqueId(...args),
  cleanups: battleCleanups,
});
const { closeBattleDialog, openBattleDialog, runBattleBranches } = battleFlow;

// 多选与合流收敛控制器 (Merge Controller)
const mergeController = createMergeController({
  multiSelectedCardIds,
  getCards: () => cards,
  getSelectedCardId: () => selectedCardId,
  canMutateCanvas: () => canMutateCanvas(),
  isDisposed: () => isDisposed,
  chainIsBusy: card => chainIsBusy(card),
  calculateBranchYPositions: (parent, count, targetX) => calculateBranchYPositions(parent, count, targetX),
  fitViewportToCluster: clusterCards => fitViewportToCluster(clusterCards),
  renderCards: () => renderCards(),
  scheduleSave: () => sessionController?.scheduleSave(),
  recordSnapshot: (c, sId) => historyManager?.recordSnapshot(c, sId),
  sendCardPrompt: (card, prompt) => sendCardPrompt(card, prompt),
  uniqueId: (...args) => uniqueId(...args),
  outputFor: msg => outputFor(msg),
  documentRef: document,
  mergeToolbar,
  mergeCountText,
  btnMergeCancel,
  btnMergeSubmit,
  listen,
});
mergeController.bindToolbar();

function toggleMultiSelectCard(cardId) {
  return mergeController.toggleMultiSelectCard(cardId);
}

function clearMultiSelect() {
  return mergeController.clearMultiSelect();
}

function updateMultiSelectionUI() {
  return mergeController.updateMultiSelectionUI();
}

function synthesizeMergePrompt(selectedCards) {
  return mergeController.synthesizeMergePrompt(selectedCards);
}

function createMergeCardFromSelected() {
  return mergeController.createMergeCardFromSelected();
}

// 渲染所有卡片
// 输入法合成（拼音选词）期间的重建会把合成会话打断，打的字直接没。
// 这段时间先记下来，等 compositionend 再补一次。
let composingInputId = null;
let pendingRenderCards = false;

function renderCards(preserve = true) {
  if (isDisposed) return;
  if (composingInputId) { pendingRenderCards = true; return; }
  // Never copy the previous session's DOM state into a newly loaded canvas.
  if (preserve) {
  for (const input of cardsLayer.querySelectorAll?.('.card-input') || []) {
    const card = cards.find(item => `input-${item.id}` === input.id);
    if (card) card.draft = input.value;
  }
  for (const card of cards) {
    const body = document.getElementById(`body-${card.id}`);
    if (typeof body?.scrollTop === 'number') card.savedScrollTop = body.scrollTop;
    for (const message of card.messages) {
      if (!message.requestId) continue;
      const asides = document.getElementById(`asides-${message.requestId}`);
      if (typeof asides?.open === 'boolean') message.asidesOpen = asides.open;
    }
  }
  }
  const focused = preserve ? document.activeElement : null;
  const focusId = /^(input-|asides-toggle-)/.test(focused?.id || '') ? focused.id : null;
  const selection = focusId?.startsWith('input-') ? [focused.selectionStart, focused.selectionEnd] : null;
  drain(cardCleanups);
  cardsLayer.innerHTML = '';

  const { visibleCards } = computeVisibleCards({ cards, cardParentIds });

  visibleCards.forEach(card => {
    const cardEl = document.createElement('div');
    cardEl.className = 'chat-card';
    cardEl.id = `dom-${card.id}`;
    cardEl.style.left = `${card.x}px`;
    cardEl.style.top = `${card.y}px`;
    cardEl.style.width = `${card.width}px`;
    if (typeof card.height === 'number') {
      cardEl.style.height = `${card.height}px`;
      cardEl.classList.add('has-custom-height');
    }

    const isBranch = Boolean(card.parentId || (Array.isArray(card.parentIds) && card.parentIds.length > 0));
    const isBattle = Boolean(card.isBattle || card.title?.startsWith('对比 #'));
    const isMerge = Boolean(card.isMerge || card.title?.startsWith('合并总结'));
    const isDoc = Boolean(card.isDoc);
    const busy = activeRequests.has(card.id);
    const chainBusy = chainIsBusy(card);
    if (multiSelectedCardIds.has(card.id)) {
      cardEl.classList.add('is-multi-selected');
    } else if (card.id === selectedCardId) {
      cardEl.classList.add('is-selected-card');
    }
    if (card.statusStamp) {
      cardEl.classList.add(`is-stamp-${card.statusStamp}`);
    }
    const descendantsCount = collectSubtreeCardIds({ cards, rootCardId: card.id, cardParentIds }).size;
    cardEl.innerHTML = buildCardHtml({
      card,
      childCount: descendantsCount,
      currentAgent,
      isSelected: card.id === selectedCardId,
      isMultiSelected: multiSelectedCardIds.has(card.id),
      isBusy: busy,
      chainBusy,
      escapeHtml,
      messageMarkup,
      statusText,
      formatFileSize,
      isReady: Boolean(sessionController?.state.ready) && !sessionController.state.busy,
    });

    bindCardEvents(cardEl, card);
    cardsLayer.appendChild(cardEl);

    const bodyEl = cardEl.querySelector(`#body-${card.id}`);
    if (bodyEl) {
      if (typeof card.height === 'number') {
        bodyEl.style.maxHeight = 'none';
        bodyEl.style.flex = '1 1 0';
      }
      bodyEl.scrollTop = card.scrollToEnd || card.savedScrollTop === undefined ? bodyEl.scrollHeight : card.savedScrollTop;
    }
    card.scrollToEnd = false;
  });

  if (focusId) {
    const restored = document.getElementById(focusId);
    restored?.focus?.({ preventScroll: true });
    if (selection?.every(Number.isInteger)) restored?.setSelectionRange?.(...selection);
  }
  const branchCount = cards.reduce((count, card) => count + cardParentIds(card).length, 0);
  badgeStats.textContent = `${cards.length} 卡片 · ${branchCount} 追问分支`;
  renderConnectors();
  if (canvasEmptyState) canvasEmptyState.hidden = cards.length > 0;
}

function bindCardEvents(cardEl, card) {
  const on = (target, type, handler, options) => listen(target, type, handler, options, cardCleanups);
  const header = cardEl.querySelector('[data-drag-handle="true"]');
  const inputEl = cardEl.querySelector(`#input-${card.id}`);
  const btnSend = cardEl.querySelector('[data-action="send"]');
  const btnBattle = cardEl.querySelector('[data-action="battle"]');
  const btnClose = cardEl.querySelector('[data-action="close"]');
  // 跳回本体：只定位会话，不声称定位到具体某条消息
  on(cardEl.querySelector('[data-action="jump-source"]'), 'click', async (e) => {
    e.stopPropagation();
    if (!card.sourceRef?.sessionId) return;
    try {
      await hana.sessions.focus({ sessionId: card.sourceRef.sessionId });
    } catch (err) {
      flashMessage(`跳回失败：${safeDetail(err?.message || String(err))}`);
    }
  });
  const btnBranch = cardEl.querySelector('[data-action="branch"]');
  const btnBranchBattle = cardEl.querySelector('[data-action="branch-battle"]');
  const btnCancel = cardEl.querySelector('[data-action="cancel"]');
  for (const message of card.messages) {
    if (!message.requestId) continue;
    const asides = cardEl.querySelector(`#asides-${message.requestId}`);
    if (!asides) continue;
    asides.open = Boolean(message.asidesOpen);
    on(asides, 'toggle', () => {
      if (message.asidesOpen !== asides.open) { message.asidesOpen = asides.open; sessionController?.scheduleSave(); }
    });
  }
  on(cardEl, 'mousedown', (e) => {
    if (isSpacePressed) return;
    if (!e.target?.closest?.('input, textarea, button, [contenteditable="true"]')) {
      const active = document.activeElement;
      if (active && active !== document.body && typeof active.blur === 'function') {
        active.blur();
      }
    }
    if (e.shiftKey) {
      e.stopPropagation();
      toggleMultiSelectCard(card.id);
      return;
    }
    clearMultiSelect();
    selectCard(card.id, false);
  });
  on(inputEl, 'focus', () => {
    selectCard(card.id, true);
  });

  inputEl.value = card.draft || '';
  on(inputEl, 'input', () => { card.draft = inputEl.value; sessionController?.scheduleSave(); });
  on(btnCancel, 'click', () => {
    const active = activeRequests.get(card.id);
    if (!active || active.terminalSeen) return;
    if (document.activeElement === btnCancel) inputEl.focus({ preventScroll: true });
    active.controller.abort(new ChatError('REQUEST_CANCELLED', '用户取消了本次等待。'));
    active.message.status = 'cancelled';
    active.message.failed = true;
    paintMessage(active.message);
  });

  on(btnBattle, 'click', (e) => {
    e.stopPropagation();
    if (chainIsBusy(card) || !cards.includes(card)) return;
    void openBattleDialog(card, inputEl.value.trim());
  });
  on(btnBranchBattle, 'click', (e) => {
    e.stopPropagation();
    if (chainIsBusy(card) || !cards.includes(card)) return;
    void openBattleDialog(card, inputEl.value.trim());
  });

  const btnAttach = cardEl.querySelector('[data-action="attach"]');
  const fileInput = cardEl.querySelector(`#file-${card.id}`);
  const stagedBar = cardEl.querySelector('.staged-attachments-bar');

  on(btnAttach, 'click', (e) => {
    e.stopPropagation();
    if (chainIsBusy(card) || !cards.includes(card)) return;
    fileInput?.click();
  });

  on(fileInput, 'change', async (e) => {
    if (!canMutateCanvas() || !cards.includes(card)) return;
    const generation = sessionController.generation;
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    for (const file of files) {
      const parsed = await extractDocumentFile(file, card.id);
      if (!canMutateCanvas(generation) || !cards.includes(card) || parsed.cancelled) return;
      if (!parsed.ok) {
        flashMessage(`《${parsed.filename}》没读出来（${parsed.stage || '未知'}阶段）：${parsed.error}`);
        continue;
      }
      card.stagedAttachments = (card.stagedAttachments || []).concat({
        name: parsed.filename,
        size: parsed.size,
        extension: parsed.extension,
        charCount: parsed.charCount,
        lineCount: parsed.lineCount,
        content: parsed.text,
        preview: parsed.preview,
      });
    }
    fileInput.value = '';
    renderCards();
    sessionController?.scheduleSave();
  });

  on(stagedBar, 'click', (e) => {
    const removeBtn = e.target.closest('[data-action="remove-attachment"]');
    if (!removeBtn) return;
    e.stopPropagation();
    const index = parseInt(removeBtn.getAttribute('data-index'), 10);
    if (!isNaN(index) && Array.isArray(card.stagedAttachments)) {
      card.stagedAttachments.splice(index, 1);
      renderCards();
      sessionController?.scheduleSave();
    }
  });

  // 卡片级文件拖拽支持
  on(cardEl, 'dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
      cardEl.classList.add('card-drop-active');
    }
  });

  on(cardEl, 'dragleave', (e) => {
    if (e.target === cardEl || !cardEl.contains(e.relatedTarget)) {
      cardEl.classList.remove('card-drop-active');
    }
  });

  on(cardEl, 'drop', async (e) => {
    if (!canMutateCanvas() || !cards.includes(card)) return;
    const generation = sessionController.generation;
    if (e.dataTransfer?.files?.length) {
      e.preventDefault();
      e.stopPropagation();
      cardEl.classList.remove('card-drop-active');
      if (canvasDropIndicator) canvasDropIndicator.hidden = true;
      cancelLater(dragOverTimer);

      for (const file of Array.from(e.dataTransfer.files)) {
        const parsed = await extractDocumentFile(file, card.id);
        if (!canMutateCanvas(generation) || !cards.includes(card) || parsed.cancelled) return;
        if (!parsed.ok) {
          flashMessage(`《${parsed.filename}》没读出来（${parsed.stage || '未知'}阶段）：${parsed.error}`);
          continue;
        }
        card.stagedAttachments = (card.stagedAttachments || []).concat({
          name: parsed.filename,
          size: parsed.size,
          extension: parsed.extension,
          charCount: parsed.charCount,
          lineCount: parsed.lineCount,
          content: parsed.text,
          preview: parsed.preview,
        });
      }
      renderCards();
      sessionController?.scheduleSave();
    }
  });

  // 1. 卡片拖拽移动
  on(header, 'mousedown', (e) => {
    if (isSpacePressed) return;
    const active = document.activeElement;
    if (active && active !== document.body && typeof active.blur === 'function') {
      active.blur();
    }
    e.stopPropagation();
    if (!sessionController?.state.ready || sessionController.state.busy) return;
    const dragGeneration = sessionController.generation;
    let startMouseX = e.clientX;
    let startMouseY = e.clientY;
    let startCardX = card.x;
    let startCardY = card.y;

    const onMouseMove = (moveEvent) => {
      if (sessionController.generation !== dragGeneration || !cards.includes(card)) return;
      const dx = (moveEvent.clientX - startMouseX) / view.scale;
      const dy = (moveEvent.clientY - startMouseY) / view.scale;
      card.x = Math.round(startCardX + dx);
      card.y = Math.round(startCardY + dy);
      cardEl.style.left = `${card.x}px`;
      cardEl.style.top = `${card.y}px`;
      renderConnectors();
    };

    const onMouseUp = () => {
      stopMove();
      stopUp();
      stopBlur();
      if (sessionController.generation === dragGeneration) {
        sessionController.scheduleSave();
        if (card.x !== startCardX || card.y !== startCardY) {
          historyManager.recordSnapshot(cards, selectedCardId);
        }
      }
    };

    const stopMove = listen(window, 'mousemove', onMouseMove);
    const stopUp = listen(window, 'mouseup', onMouseUp);
    // 鼠标拖出窗口再松手，window 收不到 mouseup，光标就永久卡在移动态。
    // 窗口失焦同样意味着这次拖拽已经结束。
    const stopBlur = listen(window, 'blur', onMouseUp);
  });

  // 1.1 卡片 2D 自由拖拽缩放（右侧宽、底部高、右下角宽高对角）
  const setupResize = (selector, direction) => {
    const handle = cardEl.querySelector(selector);
    if (!handle || handle.__resizeBound) return;
    handle.__resizeBound = true;

    on(handle, 'mousedown', (e) => {
      if (isSpacePressed) return;
      e.stopPropagation();
      e.preventDefault();
      if (!sessionController?.state.ready || sessionController.state.busy) return;
      const resizeGeneration = sessionController.generation;
      const startMouseX = e.clientX;
      const startMouseY = e.clientY;
      const startWidth = card.width || 340;
      const startHeight = card.height || cardEl.offsetHeight || 360;

      cardEl.classList.add('is-resizing');
      document.body?.classList.add('is-card-resizing');
      if (direction === 'bottom') document.body?.classList.add('resizing-s');
      else if (direction === 'corner') document.body?.classList.add('resizing-se');
      else document.body?.classList.add('resizing-ew');

      const onMouseMove = (moveEvent) => {
        if (sessionController.generation !== resizeGeneration || !cards.includes(card)) return;
        const dx = (moveEvent.clientX - startMouseX) / view.scale;
        const dy = (moveEvent.clientY - startMouseY) / view.scale;

        if (direction === 'right' || direction === 'corner') {
          const newWidth = Math.min(Math.max(Math.round(startWidth + dx), 260), 1200);
          card.width = newWidth;
          cardEl.style.width = `${newWidth}px`;
        }
        if (direction === 'bottom' || direction === 'corner') {
          const newHeight = Math.min(Math.max(Math.round(startHeight + dy), 200), 1600);
          card.height = newHeight;
          cardEl.style.height = `${newHeight}px`;
          cardEl.classList.add('has-custom-height');
          const bodyEl = cardEl.querySelector(`#body-${card.id}`);
          if (bodyEl) {
            bodyEl.style.maxHeight = 'none';
            bodyEl.style.flex = '1 1 0';
          }
        }
        renderConnectors();
      };

      const onMouseUp = () => {
        cardEl.classList.remove('is-resizing');
        document.body?.classList.remove('is-card-resizing', 'resizing-s', 'resizing-se', 'resizing-ew');
        stopMove();
        stopUp();
        stopBlur();
        if (sessionController.generation === resizeGeneration) {
          sessionController.scheduleSave();
          if (card.width !== startWidth || card.height !== startHeight) {
            historyManager.recordSnapshot(cards, selectedCardId);
          }
        }
      };

      const stopMove = listen(window, 'mousemove', onMouseMove);
      const stopUp = listen(window, 'mouseup', onMouseUp);
      // 同上：拖出窗口松手时也要收尾，否则 is-resizing 粘住、光标一直是双箭头
      const stopBlur = listen(window, 'blur', onMouseUp);
    });
  };

  setupResize('[data-direction="right"]', 'right');
  setupResize('[data-direction="bottom"]', 'bottom');
  setupResize('[data-direction="corner"]', 'corner');
  setupResize('[data-action="resize-card"]', 'right');

  // 2. 发送消息并执行打字机流式推理
  const doSend = async () => {
    if (chainIsBusy(card) || !cards.includes(card)) return;
    const text = inputEl.value.trim();
    const hasStaged = Array.isArray(card.stagedAttachments) && card.stagedAttachments.length > 0;
    if (!text && !hasStaged) return;
    const staged = hasStaged ? [...card.stagedAttachments] : [];
    card.stagedAttachments = [];
    if (document.activeElement === btnSend) inputEl.focus({ preventScroll: true });
    inputEl.value = '';
    card.draft = '';
    await sendCardPrompt(card, text, { attachments: staged });
  };

  on(btnSend, 'click', doSend);
  on(inputEl, 'keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      doSend();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      createBranchCard(card, { autoFocus: true });
      return;
    }
    if (e.key === 'Escape') {
      inputEl.blur();
      return;
    }
  });

  // 3. 点击从右侧开辟追问分支卡片
  on(btnBranch, 'click', (e) => {
    e.stopPropagation();
    if (isDisposed) return;
    createBranchCard(card, { autoFocus: true });
  });

  // 4. 关闭卡片
  on(btnClose, 'click', (e) => {
    e.stopPropagation();
    closeCardHierarchy(card);
  });

  // 5. 循环切换卡片标记盖戳 (星标 / 采纳 / 否决)
  const btnStamp = cardEl.querySelector('[data-action="cycle-stamp"]');
  if (btnStamp) {
    on(btnStamp, 'click', (e) => {
      e.stopPropagation();
      if (isDisposed) return;
      card.statusStamp = cycleCardStatusStamp(card.statusStamp);
      renderCards();
      sessionController?.scheduleSave();
      historyManager.recordSnapshot(cards, card.id);
    });
  }

  // 6. 顺藤摸瓜：整链导出为 Markdown 并一键复制
  const btnExportChain = cardEl.querySelector('[data-action="export-chain"]');
  if (btnExportChain) {
    on(btnExportChain, 'click', async (e) => {
      e.stopPropagation();
      if (isDisposed) return;
      const chain = findCardAncestorChain({ cards, targetCardId: card.id, cardParentIds });
      if (!chain || chain.length === 0) {
        flashMessage('未找到该卡片的推导链路');
        return;
      }
      const markdown = formatCardChainMarkdown(chain, { title: `链路推导：${card.title || '长文'}` });
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(markdown);
        } else {
          const ta = document.createElement('textarea');
          ta.value = markdown;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        flashMessage(`已顺藤摸瓜将 ${chain.length} 个节点的完整推导长文复制到剪贴板！`);
      } catch (err) {
        flashMessage(`导出复制失败：${safeDetail(err?.message || String(err))}`);
      }
    });
  }

  // 7. 折叠/展开子分支
  const btnCollapseList = cardEl.querySelectorAll('[data-action="toggle-collapse"]');
  btnCollapseList.forEach(btn => {
    on(btn, 'click', (e) => {
      e.stopPropagation();
      if (isDisposed) return;
      card.isCollapsed = !card.isCollapsed;
      renderCards();
      renderConnectors();
      sessionController?.scheduleSave();
      historyManager.recordSnapshot(cards, card.id);
    });
  });
}

// 全局卡片搜索控制器 (Ctrl+F)
let searchMatches = [];
let currentSearchIndex = -1;
let searchDebounceTimer = null;

function clearSearchHighlights() {
  cards.forEach(c => {
    const el = document.getElementById(`dom-${c.id}`);
    el?.classList.remove('is-search-match', 'is-search-active');
  });
}

function focusSearchMatch(index) {
  // 搜索结果是一份快照，卡片可能在这之后被删掉。
  // 先剔掉已经不在画布上的，否则会飞到一个不存在的位置，屏幕上啥也看不见。
  const liveIds = new Set(cards.map(c => c.id));
  if (searchMatches.some(c => !liveIds.has(c.id))) {
    const kept = searchMatches.filter(c => liveIds.has(c.id));
    const anchored = searchMatches[index];
    searchMatches = kept;
    if (!kept.length) { currentSearchIndex = -1; searchController?.updateCounter?.(-1, 0); return; }
    const nextIndex = anchored ? kept.findIndex(c => c.id === anchored.id) : -1;
    index = nextIndex >= 0 ? nextIndex : Math.min(index, kept.length - 1);
    currentSearchIndex = index;
  }
  if (index < 0 || index >= searchMatches.length) return;
  cards.forEach(c => {
    const el = document.getElementById(`dom-${c.id}`);
    el?.classList.remove('is-search-active');
  });
  const target = searchMatches[index];
  if (target) {
    const el = document.getElementById(`dom-${target.id}`);
    el?.classList.add('is-search-active');
    selectCard(target.id, false);
    ensureCardInView(target);
  }
}

const searchController = bindSearchBarController({
  searchBarEl: canvasSearchBar,
  inputEl: canvasSearchInput,
  counterEl: canvasSearchCounter,
  btnPrev: btnSearchPrev,
  btnNext: btnSearchNext,
  btnClose: btnSearchClose,
  onSearch: (query) => {
    // 每敲一个字就全画布扫一遍，卡片一多就明显卡顿。
    // 空查询例外：清空要立刻见效，不能等那一下。
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    const run = () => {
      searchDebounceTimer = null;
      clearSearchHighlights();
      searchMatches = findCardsByKeyword({ cards, query });
      if (searchMatches.length > 0) {
        currentSearchIndex = 0;
        searchMatches.forEach(c => {
          const el = document.getElementById(`dom-${c.id}`);
          el?.classList.add('is-search-match');
        });
        focusSearchMatch(0);
      } else {
        currentSearchIndex = -1;
      }
      searchController.updateCounter(currentSearchIndex, searchMatches.length);
    };
    if (!query) { run(); return; }
    // 记进 panelTimers：面板销毁时要能一起清掉，
    // 否则关掉画布后这个延时回调还会去摸已经没了的 DOM
    searchDebounceTimer = setTimeout(run, 120);
    panelTimers.add(searchDebounceTimer);
  },
  onNavigate: (direction) => {
    if (searchMatches.length === 0) return;
    currentSearchIndex = getNextMatchIndex({
      currentIndex: currentSearchIndex,
      totalCount: searchMatches.length,
      direction,
    });
    focusSearchMatch(currentSearchIndex);
    searchController.updateCounter(currentSearchIndex, searchMatches.length);
  },
  onClose: () => {
    if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); panelTimers.delete(searchDebounceTimer); searchDebounceTimer = null; }
    clearSearchHighlights();
    searchMatches = [];
    currentSearchIndex = -1;
  },
  listen,
});

// 全局键盘快捷键
const unbindKeyboardShortcuts = bindKeyboardShortcuts({
  windowRef: window,
  documentRef: document,
  viewport,
  getState: () => ({
    isDisposed,
    isSpacePressed,
    cards,
    selectedCardId,
    battleDialogOpen: battleDialog?.open,
    multiSelectedCount: multiSelectedCardIds.size,
    canUndo: historyManager.canUndo(),
    canRedo: historyManager.canRedo(),
  }),
  actions: {
    setSpacePressed: (pressed) => { isSpacePressed = pressed; },
    chainIsBusy,
    createBranchCard,
    navigateCardFocus,
    closeBattleDialog,
    clearMultiSelect,
    selectCard,
    closeCardHierarchy,
    autoTidyLayout,
    createMergeCardFromSelected,
    undo: () => {
      if (!canMutateCanvas() || activeRequests.size > 0) return;
      historyManager.undo();
    },
    redo: () => {
      if (!canMutateCanvas() || activeRequests.size > 0) return;
      historyManager.redo();
    },
    isBusy: () => activeRequests.size > 0 || !sessionController?.state.ready || sessionController.state.busy,
    openSearchBar: () => searchController?.open(),
  },
});

listen(btnAutoTidy, 'click', () => {
  autoTidyLayout();
});

listen(btnResetView, 'click', () => {
  // 按钮叫「居中视野」，那就真的居中到现有卡片；
  // 以前是把视图重置成 (60, 40) 的固定原点，卡片一多就跑到视口外面去了。
  if (cards.length > 0) {
    fitViewportToCluster(visibleCardsForFraming());
    return;
  }
  view.x = 60;
  view.y = 40;
  view.scale = 1;
  updateTransform();
});

// 新建主线根卡片
listen(btnNewRoot, 'click', async () => {
  await createRootCard();
});

// 文档解析管线的宿主依赖：文件读取、上传、进度提示都在那个模块里
const documentPipeline = createDocumentPipeline({
  hana, requestHost, abortable, inactiveError, safeDetail, waitForParser,
  isDisposed: () => isDisposed,
  canMutateCanvas: (generation) => canMutateCanvas(generation),
  get badgeStats() { return badgeStats; },
});
const extractDocumentFile = (file, cardId = null) => documentPipeline.extractDocumentFile(file, cardId);
const abortDocumentTasksFor = (cardId) => documentPipeline.abortDocumentTasksFor(cardId);

// 解析失败时原地报一声，比默默生成一张空白的资料卡诚实
function flashMessage(text) {
  if (isDisposed) return;
  let el = document.getElementById('fork-flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fork-flash';
    el.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:60px', 'transform:translateX(-50%)',
      'max-width:min(560px, 78vw)', 'padding:11px 17px', 'border-radius:6px',
      'font-size:12.5px', 'line-height:1.75', 'z-index:9999', 'pointer-events:none',
      'transition:opacity .35s', 'background:#40221f', 'color:#f6ece9',
      'border:1px solid #6b3a34', 'font-family:inherit', 'box-shadow:0 6px 20px rgba(0,0,0,.22)',
    ].join(';');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = '1';
  cancelLater(flashMessage._timer);
  flashMessage._timer = later(() => { el.style.opacity = '0'; }, 4600);
}

// ===== 本体会话桥接：导入、来源、回传 =====

const bridgeDialogEl = document.getElementById('bridge-dialog');
const bridgeSendDialogEl = document.getElementById('bridge-send-dialog');
const bridgeSessionSelect = document.getElementById('bridge-session-select');
const bridgeKindSelect = document.getElementById('bridge-kind-select');
const bridgeLeafSelect = document.getElementById('bridge-leaf-select');
const bridgeLeafField = document.getElementById('bridge-leaf-field');
const bridgePreviewEl = document.getElementById('bridge-preview');
const bridgeErrorEl = document.getElementById('bridge-dialog-error');
const bridgeImportBtn = document.getElementById('btn-bridge-import');
const bridgeActiveHint = document.getElementById('bridge-active-hint');

let bridgePreviewCache = null;
let bridgeTargetSessionId = null;
let bridgeSendBusy = false;
let bridgeSendOpening = false;
// 一次弹窗确认流程只准备一个动作。回执丢失也保留原 actionId 与冻结正文。
let bridgeSendAttempt = null;

function updateBridgeSendControls() {
  if (isDisposed) return;
  const locked = Boolean(bridgeSendBusy || bridgeSendAttempt?.actionId);
  const confirm = document.getElementById('btn-bridge-send-confirm');
  if (confirm) {
    confirm.disabled = bridgeSendBusy || Boolean(bridgeSendAttempt?.completed);
    confirm.textContent = bridgeSendBusy ? '正在处理…'
      : bridgeSendAttempt?.confirmStarted ? '核对/继续原动作' : '确认投递';
  }
  const target = document.getElementById('bridge-send-target');
  const text = document.getElementById('bridge-send-text');
  if (target) target.disabled = locked;
  if (text) text.readOnly = locked;
  for (const id of ['btn-bridge-send-close', 'btn-bridge-send-cancel']) {
    const button = document.getElementById(id);
    if (button) button.disabled = bridgeSendBusy;
  }
  const open = document.getElementById('btn-bridge-send');
  if (open) open.disabled = bridgeSendBusy || bridgeSendOpening;
}

function closeBridgeSendDialog() {
  if (!bridgeSendBusy) bridgeSendDialogEl?.close();
}

async function bridgeRequest(path, init) {
  if (isDisposed) throw inactiveError();
  const res = await abortable(requestHost(hana, path, { ...init, signal: panelAbort.signal }), panelAbort.signal);
  if (isDisposed) throw inactiveError();
  const data = await abortable(res.json(), panelAbort.signal);
  if (isDisposed) throw inactiveError();
  return data;
}

function bridgeFail(el, err) {
  if (isDisposed) return;
  if (el) el.textContent = safeDetail(err?.message || String(err));
}

function bridgeClearError() {
  if (bridgeErrorEl) bridgeErrorEl.textContent = '';
}

function selectedBridgeKind() {
  return bridgeKindSelect?.value === 'tree-path' ? 'tree-path' : 'history';
}

function resetBridgeLeafChoices() {
  if (bridgeLeafField) bridgeLeafField.hidden = true;
  if (bridgeLeafSelect) {
    bridgeLeafSelect.disabled = true;
    bridgeLeafSelect.innerHTML = '<option value="">选择树状导入后读取</option>';
    bridgeLeafSelect.value = '';
  }
}

function renderBridgeLeafChoices(preview) {
  const branches = Array.isArray(preview?.branches) ? preview.branches : [];
  if (bridgeLeafField) bridgeLeafField.hidden = false;
  if (!bridgeLeafSelect) return;
  bridgeLeafSelect.innerHTML = branches.length
    ? '<option value="">请选择一个叶节点</option>' + branches.map((branch, index) => {
      const id = String(branch.leafId || '');
      const count = Number.isFinite(branch.messageCount) ? ` · ${branch.messageCount} 条` : '';
      const summary = branch.lastText ? ` · ${String(branch.lastText).slice(0, 80)}` : '';
      return `<option value="${escapeHtml(id)}">分支 ${index + 1}${count}${escapeHtml(summary)}</option>`;
    }).join('')
    : '<option value="">该会话没有可选叶节点</option>';
  const selected = preview?.leafId || '';
  bridgeLeafSelect.value = selected;
  bridgeLeafSelect.disabled = branches.length === 0;
}

/** 会话尾号：同名会话靠这个区分 */
function shortId(id) {
  const text = String(id || '');
  return text.length > 8 ? text.slice(-6) : text;
}

async function loadBridgeSessions(preferSessionId = null) {
  if (isDisposed) return;
  bridgeClearError();
  if (bridgeSessionSelect) bridgeSessionSelect.innerHTML = '<option value="">正在读取…</option>';
  try {
    const [data, active] = await Promise.all([
      bridgeRequest('/api/bridge/sessions'),
      (typeof hana !== 'undefined' && hana?.sessions?.getActive)
        ? hana.sessions.getActive().catch(() => null)
        : null,
    ]);
    if (isDisposed) return;
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    if (!bridgeSessionSelect) return;
    if (!sessions.length) {
      bridgeSessionSelect.innerHTML = '<option value="">没有可读的本体会话</option>';
      if (bridgeImportBtn) bridgeImportBtn.disabled = true;
      return;
    }
    const activeSessionId = active?.sessionId || null;
    const targetId = preferSessionId || activeSessionId || sessions[0]?.sessionId || '';

    bridgeSessionSelect.innerHTML = sessions.map((s) => {
      const count = s.messageCount == null ? '' : `（${s.messageCount} 条）`;
      const isTarget = s.sessionId === targetId;
      const isCur = s.sessionId === activeSessionId ? ' [当前活跃]' : '';
      return `<option value="${escapeHtml(s.sessionId)}"${isTarget ? ' selected' : ''}>${escapeHtml(s.title || s.sessionId)}${isCur}${count} · ${escapeHtml(shortId(s.sessionId))}</option>`;
    }).join('');

    if (targetId) {
      bridgeSessionSelect.value = targetId;
      bridgeTargetSessionId = targetId;
      if (bridgeActiveHint) {
        bridgeActiveHint.textContent = `已自动绑定：${active?.title || targetId}`;
      }
      if (bridgeImportBtn) bridgeImportBtn.disabled = false;
      void runBridgePreview();
    }
  } catch (err) {
    if (isDisposed) return;
    if (bridgeSessionSelect) bridgeSessionSelect.innerHTML = '<option value="">读取失败</option>';
    bridgeFail(bridgeErrorEl, err);
  }
}

async function bindActiveSession() {
  if (isDisposed) return;
  bridgeClearError();
  try {
    const active = await hana.sessions.getActive();
    if (isDisposed) return;
    if (!active?.sessionId) {
      if (bridgeActiveHint) bridgeActiveHint.textContent = '当前窗口没有选中会话';
      return;
    }
    bridgeTargetSessionId = active.sessionId;
    if (bridgeActiveHint) bridgeActiveHint.textContent = `已绑定：${active.title || active.sessionId}`;
    if (bridgeSessionSelect) {
      bridgeSessionSelect.value = active.sessionId;
      if (bridgeImportBtn) bridgeImportBtn.disabled = false;
      void runBridgePreview();
    }
  } catch {
    if (isDisposed) return;
    if (bridgeActiveHint) bridgeActiveHint.textContent = '当前窗口不支持读取本体会话';
  }
}

async function runBridgePreview() {
  if (isDisposed) return;
  bridgeClearError();
  bridgePreviewCache = null;
  const sessionId = bridgeSessionSelect?.value;
  const kind = selectedBridgeKind();
  const leafId = kind === 'tree-path' ? (bridgeLeafSelect?.value || null) : null;
  if (kind === 'history') resetBridgeLeafChoices();
  else if (bridgeLeafField) bridgeLeafField.hidden = false;
  if (!sessionId) {
    if (bridgeImportBtn) bridgeImportBtn.disabled = true;
    return;
  }
  if (bridgeImportBtn) bridgeImportBtn.disabled = true;
  if (bridgePreviewEl) {
    bridgePreviewEl.innerHTML = kind === 'tree-path'
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
    const preview = data.preview;
    bridgePreviewCache = preview;
    if (kind === 'tree-path') renderBridgeLeafChoices(preview);

    const messages = Array.isArray(preview.messages) ? preview.messages : [];
    if (kind === 'tree-path' && preview.needsLeafChoice) {
      bridgePreviewEl.innerHTML = '<p class="bridge-placeholder">该会话有多个分支，请选择一个叶节点后再导入。</p>';
      return;
    }
    if (!messages.length) {
      bridgePreviewEl.innerHTML = '<p class="bridge-placeholder">该会话暂无可见消息。</p>';
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
    bridgePreviewEl.innerHTML = rows + (warn.length ? `<div class="bridge-warn">${escapeHtml(warn.join('；'))}</div>` : '');
    if (bridgeImportBtn) bridgeImportBtn.disabled = false;
  } catch (err) {
    if (isDisposed) return;
    bridgePreviewEl.innerHTML = '<p class="bridge-placeholder">读取快照失败。</p>';
    bridgeFail(bridgeErrorEl, err);
  }
}

async function importBridgePreview() {
  if (!canMutateCanvas()) return;
  const generation = sessionController.generation;
  const sessionId = bridgeSessionSelect?.value;
  const kind = selectedBridgeKind();
  const leafId = kind === 'tree-path' ? (bridgeLeafSelect?.value || null) : null;
  if (!sessionId) {
    bridgeFail(bridgeErrorEl, new Error('请先选择一个会话'));
    return;
  }
  bridgeClearError();
  if (bridgeImportBtn) {
    bridgeImportBtn.disabled = true;
    bridgeImportBtn.textContent = '正在导入…';
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
    const text = `# ${preview.session.title || '本体会话'}\n\n> 本体导入快照。只读摘录，不代表原会话仍在同步。\n\n${body}`;
    const sourceRef = {
      version: 1,
      kind: 'hana-session',
      sessionId: preview.session.sessionId,
      entryIds: messages.map((m) => m.entryId).filter(Boolean),
      leafId: preview.leafId || leafId || null,
      titleAtImport: preview.session.title || '',
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

    createBridgeDocCard({
      title: preview.session.title || '本体会话',
      text,
      sourceRef,
      messageCount: messages.length,
    });
    bridgeDialogEl?.close();
  } catch (err) {
    bridgeFail(bridgeErrorEl, err);
  } finally {
    if (!isDisposed && bridgeImportBtn) {
      bridgeImportBtn.disabled = false;
      bridgeImportBtn.textContent = '导入到画布';
    }
  }
}

async function loadOutboxList() {
  if (isDisposed) return;
  const box = document.getElementById('bridge-outbox-list');
  if (!box) return;
  try {
    const data = await bridgeRequest('/api/bridge/actions');
    const actions = Array.isArray(data.actions) ? data.actions : [];
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
    if (isDisposed) return;
    box.innerHTML = `<p class="bridge-placeholder">${escapeHtml(safeDetail(err?.message || String(err)))}</p>`;
  }
}

async function openBridgeSendDialog() {
  if (isDisposed) return;
  if (!bridgeSendDialogEl || bridgeSendDialogEl.open || bridgeSendBusy || bridgeSendOpening) return;
  bridgeSendOpening = true;
  // 已知完成/明确失败后的主动打开才是新流程；未知回执仍是旧流程。
  if (!bridgeSendAttempt?.confirmStarted || bridgeSendAttempt.completed) bridgeSendAttempt = null;
  updateBridgeSendControls();
  try {
    const sel = document.getElementById('bridge-send-target');
    const meta = document.getElementById('bridge-send-meta');
    const errEl = document.getElementById('bridge-send-error');
    if (errEl) errEl.textContent = '';
    try {
      const data = await bridgeRequest('/api/bridge/sessions');
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      if (sel) {
        sel.innerHTML = sessions
          .map((s) => `<option value="${escapeHtml(s.sessionId)}">${escapeHtml(s.title || s.sessionId)} · ${escapeHtml(shortId(s.sessionId))}</option>`)
          .join('');
        if (bridgeTargetSessionId && sessions.some((s) => s.sessionId === bridgeTargetSessionId)) {
          sel.value = bridgeTargetSessionId;
        }
      }
    } catch (err) {
      if (isDisposed) return;
      if (errEl) errEl.textContent = safeDetail(err?.message || String(err));
    }
    const updateMeta = () => {
      if (isDisposed) return;
      const box = document.getElementById('bridge-send-text');
      if (meta) meta.textContent = `${new Blob([box?.value || '']).size} 字节 / 上限 65536`;
    };
    const box = document.getElementById('bridge-send-text');
    if (box) box.oninput = updateMeta;
    // 从当前选中卡片带一段确定性模板，不调模型生成摘要
    const selected = cards.find((c) => c.id === selectedCardId);
    if (box && selected && !box.value.trim()) {
      const lastAssistant = [...(selected.messages || [])].reverse().find((m) => m.role === 'assistant' && m.text);
      const excerpt = lastAssistant?.text ? lastAssistant.text.slice(0, 4000) : (selected.docContent || '').slice(0, 4000);
      box.value = `> 来自「分叉对话」的整理，原卡片：${selected.title || '未命名'}\n\n${excerpt}`;
    }
    if (bridgeSendAttempt) {
      // 关闭后重开不能把不确定的上次投递偷偷变成一个新的动作。
      if (sel) sel.value = bridgeSendAttempt.sessionId;
      if (box) box.value = bridgeSendAttempt.text;
      if (errEl && !errEl.textContent) errEl.textContent = '上次投递回执未确认；目标与正文已冻结，只能核对/继续原动作，不会重新准备。';
    }
    updateMeta();
    bridgeSendDialogEl.showModal();
  } finally {
    bridgeSendOpening = false;
    updateBridgeSendControls();
  }
}

async function confirmBridgeSend() {
  // disabled 不是互斥锁；程序触发、排队的第二次点击也必须被这道同步闸门挡住。
  if (isDisposed || !bridgeSendDialogEl?.open || bridgeSendBusy || bridgeSendAttempt?.completed) return;
  bridgeSendBusy = true;
  const sel = document.getElementById('bridge-send-target');
  const text = document.getElementById('bridge-send-text');
  const errEl = document.getElementById('bridge-send-error');
  if (errEl) errEl.textContent = '';
  if (!bridgeSendAttempt) bridgeSendAttempt = {
    sessionId: sel?.value || '', text: text?.value || '', actionId: null,
    confirmStarted: false, completed: false,
  };
  const attempt = bridgeSendAttempt;
  updateBridgeSendControls();
  try {
    if (!attempt.actionId) {
      const prepared = await bridgeRequest('/api/bridge/prepare', {
        method: 'POST',
        body: JSON.stringify({ sessionId: attempt.sessionId, kind: 'send-text', text: attempt.text }),
      });
      const id = prepared?.action?.actionId;
      if (typeof id !== 'string' || !/^[\w.:@~+-]{1,200}$/.test(id)) throw new Error('准备动作的回执无效，未继续投递');
      attempt.actionId = id;
    }
    let result;
    if (attempt.confirmStarted) {
      // 上次确认可能已经到达宿主。先只读核对，不能重走 prepare。
      result = await bridgeRequest(`/api/bridge/actions/${encodeURIComponent(attempt.actionId)}`);
      if (result?.action?.actionId !== attempt.actionId) throw new Error('动作核对回执不匹配，未继续投递');
    }
    if (!attempt.confirmStarted || result?.action?.state === 'prepared') {
      attempt.confirmStarted = true;
      result = await bridgeRequest('/api/bridge/confirm', {
        method: 'POST',
        body: JSON.stringify({ actionId: attempt.actionId }),
      });
    }
    const state = result?.action?.state;
    if (result?.action?.actionId !== attempt.actionId || !['dispatching', 'accepted', 'delivered', 'failed', 'unknown'].includes(state)) {
      throw new Error('投递回执无效，请核对原动作，勿重新发送');
    }
    attempt.completed = ['accepted', 'delivered', 'failed'].includes(state);
    bridgeSendDialogEl.close();
    if (state === 'accepted' || state === 'delivered') {
      flashMessage('已投递给本体会话（已接纳 ≠ 助手已回完）。');
    } else if (state === 'failed') {
      flashMessage('原投递动作已明确失败，请查看回传记录。');
    } else {
      flashMessage(`投递状态：${state}。已保留原动作，不会自动重发。`);
    }
  } catch (err) {
    // prepare 失败从未确认，不存在宿主消息副作用；可以解锁编辑。
    // 一旦拿到 actionId，则保留它供只读核对，绝不能重新 prepare。
    if (!attempt.actionId) bridgeSendAttempt = null;
    if (errEl) errEl.textContent = `${safeDetail(err?.message || String(err))}${attempt.confirmStarted ? '；已保留原动作，请核对状态，勿重新发送。' : ''}`;
  } finally {
    bridgeSendBusy = false;
    updateBridgeSendControls();
  }
}

let pollBridgeIntentsBusy = false;
let bridgeInitialized = false;
const ownedBridgeClaims = new Set();
function releaseBridgeClaim(intentId) {
  if (!ownedBridgeClaims.delete(intentId)) return Promise.resolve();
  return requestHost(hana, `/api/bridge/intents/${encodeURIComponent(intentId)}/release`, {
    method: 'POST', body: JSON.stringify({ claimer: canvasId }), keepalive: true,
  }).catch(() => {});
}

/** 本体那边点的导入请求（右键 / 消息图标）：自动认领并直接铸造成卡片置入画布 */
async function pollBridgeIntents() {
  if (!canMutateCanvas() || pollBridgeIntentsBusy) return;
  const generation = sessionController.generation;
  pollBridgeIntentsBusy = true;
  try {
    const data = await bridgeRequest('/api/bridge/intents');
    const list = Array.isArray(data?.intents) ? data.intents : [];
    if (!canMutateCanvas(generation) || !list.length) return;

    for (const intent of list) {
      if (!canMutateCanvas(generation)) break;
      if (!intent?.intentId || intent.consumed) continue;
      // 抢占凭条：使用当前窗口全局唯一的 canvasId 作为 claimer，实现真正的多窗口并发抢占与隔离
      try {
        // Observe late claim receipts even after disposal, then release our ownership.
        const claimed = await requestHost(hana, `/api/bridge/intents/${encodeURIComponent(intent.intentId)}/claim`, {
          method: 'POST', body: JSON.stringify({ claimer: canvasId }),
        });
        await claimed.json();
        ownedBridgeClaims.add(intent.intentId);
        if (!canMutateCanvas(generation)) { await releaseBridgeClaim(intent.intentId); break; }
      } catch {
        continue;
      }

      try {
        const previewData = await bridgeRequest('/api/bridge/preview', {
          method: 'POST',
          body: JSON.stringify({ sessionId: intent.sessionId, kind: 'history', limit: 100 }),
        });
        if (!canMutateCanvas(generation)) { await releaseBridgeClaim(intent.intentId); break; }
        const preview = previewData?.preview;
        const messages = Array.isArray(preview?.messages) ? preview.messages : [];
        if (!messages.length) {
          await releaseBridgeClaim(intent.intentId);
          continue;
        }

        // 精准区分：消息级导入（精确匹配 intent.messageId）还是全会话历史导入
        const targetMsg = intent.messageId ? messages.find((m) => m.entryId === intent.messageId) : null;
        // 带 messageId 却找不到：说明那条消息在预览范围外（更早、或另一条分支）。
        // 这时不能悄悄退化成"导入整段历史" —— 用户点的是那条消息，
        // 范围被悄悄放大后，后面的分支会把没打算要的内容一起喂给模型。
        if (intent.messageId && !targetMsg) {
          await releaseBridgeClaim(intent.intentId);
          flashMessage('那条消息不在这次能读到的范围里（可能更早或属于别的分支），没有导入。');
          continue;
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

        if (!imported || !canMutateCanvas(generation)) { await releaseBridgeClaim(intent.intentId); continue; }
        // 先落盘再 ACK：ACK 一旦发出，这条凭条就没了。
        // 如果卡片只在内存里、随后的自动保存又因配额或磁盘错误失败，
        // 就会变成「凭条已消费、内容没存下」的静默丢失。
        try {
          await sessionController.flush(true);
        } catch (saveErr) {
          await releaseBridgeClaim(intent.intentId);
          flashMessage(`导入没能落盘（${safeDetail(saveErr?.message || String(saveErr))}），凭条已释放，可以重试。`);
          continue;
        }
        await bridgeRequest(`/api/bridge/intents/${encodeURIComponent(intent.intentId)}/ack`, {
          method: 'POST',
          body: JSON.stringify({ claimer: canvasId }),
        });

        ownedBridgeClaims.delete(intent.intentId);
        const flashDesc = targetMsg ? `单条消息快照` : `《${cardTitle}》（${messages.length} 条记录）`;
        flashMessage(`已自动从本体导入${flashDesc}到画布。`);
      } catch (err) {
        await releaseBridgeClaim(intent.intentId);
      }
    }
  } catch {
    // 没权限或宿主不支持都不影响画布
  } finally {
    pollBridgeIntentsBusy = false;
  }
}

function initSessionBridge() {
  if (isDisposed || bridgeInitialized || !bridgeDialogEl) return;
  // 裁剪过的宿主（或测试里的假 document）没有这些方法，就让桥接安静退场
  if (typeof document.querySelectorAll !== 'function') return;
  bridgeInitialized = true;
  listen(document.getElementById('btn-bridge-open'), 'click', async () => {
    bridgeDialogEl.showModal();
    await loadBridgeSessions();
    await loadOutboxList();
  });
  listen(document.getElementById('btn-bridge-close'), 'click', () => bridgeDialogEl.close());
  listen(document.getElementById('btn-bridge-cancel'), 'click', () => bridgeDialogEl.close());
  listen(document.getElementById('btn-bridge-bind-active'), 'click', bindActiveSession);
  listen(document.getElementById('btn-bridge-preview'), 'click', runBridgePreview);
  listen(bridgeImportBtn, 'click', importBridgePreview);
  listen(document.getElementById('btn-bridge-refresh-outbox'), 'click', loadOutboxList);

  listen(bridgeSessionSelect, 'change', () => {
    const val = bridgeSessionSelect.value;
    if (val) {
      void runBridgePreview();
    } else {
      if (bridgeImportBtn) bridgeImportBtn.disabled = true;
      if (bridgePreviewEl) bridgePreviewEl.innerHTML = '<p class="bridge-placeholder">请选择要导入的会话。</p>';
    }
  });
  listen(bridgeKindSelect, 'change', () => {
    bridgePreviewCache = null;
    void runBridgePreview();
  });
  listen(bridgeLeafSelect, 'change', () => {
    if (selectedBridgeKind() === 'tree-path') void runBridgePreview();
  });

  listen(document.getElementById('bridge-tab-import'), 'click', () => {
    document.getElementById('bridge-pane-import').hidden = false;
    document.getElementById('bridge-pane-outbox').hidden = true;
    document.getElementById('bridge-tab-import').classList.add('is-active');
    document.getElementById('bridge-tab-outbox').classList.remove('is-active');
  });
  listen(document.getElementById('bridge-tab-outbox'), 'click', () => {
    document.getElementById('bridge-pane-import').hidden = true;
    document.getElementById('bridge-pane-outbox').hidden = false;
    document.getElementById('bridge-tab-outbox').classList.add('is-active');
    document.getElementById('bridge-tab-import').classList.remove('is-active');
    void loadOutboxList();
  });

  listen(document.getElementById('btn-bridge-send'), 'click', openBridgeSendDialog);
  listen(document.getElementById('btn-bridge-send-close'), 'click', closeBridgeSendDialog);
  listen(document.getElementById('btn-bridge-send-cancel'), 'click', closeBridgeSendDialog);
  listen(bridgeSendDialogEl, 'cancel', (event) => {
    if (bridgeSendBusy) event.preventDefault();
  });
  listen(document.getElementById('btn-bridge-send-confirm'), 'click', confirmBridgeSend);
  updateBridgeSendControls();

  void pollBridgeIntents();
  if (typeof setInterval === 'function') {
    const timer = setInterval(() => { void pollBridgeIntents(); }, 5000);
    panelCleanups.add(() => clearInterval(timer));
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    listen(window, 'focus', () => void pollBridgeIntents());
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    listen(document, 'visibilitychange', () => {
      if (!document.hidden) void pollBridgeIntents();
    });
  }
  // 前台会话切换只更新提示，不改已绑定目标
  try {
    const stopActive = hana.sessions.onActiveChanged?.((change) => {
      if (isDisposed || !bridgeActiveHint) return;
      bridgeActiveHint.textContent = change?.sessionId
        ? `当前会话：${change.title || change.sessionId}`
        : '当前窗口没有选中会话';
    });
    if (typeof stopActive === 'function') panelCleanups.add(stopActive);
  } catch {
    // 窗口不支持就静默
  }
}

if (document.readyState === 'loading') {
  listen(document, 'DOMContentLoaded', initSessionBridge, { once: true });
} else {
  initSessionBridge();
}

async function createDocumentCard(file, targetCoord = null) {
  if (!canMutateCanvas() || !file) return null;
  if (!sessionController.state.activeId) {
    await sessionController.newSession(initialSnapshot());
  }
  if (!canMutateCanvas() || !sessionController.state.activeId) return null;
  const generation = sessionController.generation;
  const result = await extractDocumentFile(file);
  if (!canMutateCanvas(generation) || result.cancelled) return null;
  if (!result.ok) {
    flashMessage(`《${result.filename}》没读出来（${result.stage || '未知'}阶段）：${result.error}`);
    return null;
  }
  const rootCount = cards.filter(c => cardParentIds(c).length === 0).length + 1;
  const spot = rootSlotPosition(rootCount);
  const x = targetCoord ? targetCoord.x : spot.x;
  const y = targetCoord ? targetCoord.y : spot.y;

  const newCard = {
    id: uniqueId('doc'),
    parentId: null,
    title: result.filename,
    isDoc: true,
    docContent: result.text,
    docMeta: {
      name: result.filename,
      size: result.size,
      extension: result.extension,
      charCount: result.charCount,
      lineCount: result.lineCount,
    },
    x,
    y,
    width: 360,
    messages: [
      {
        role: 'assistant',
        localOnly: true,
        text: `【资料源就绪】已成功解析《${result.filename}》（${formatFileSize(result.size)} · ${result.charCount} 字）· 引擎：${result.engineLabel || '本地'}。\n\n点击卡片右侧 [+] 追问 或 [⑂ 对比]，即可以此文档为基座开辟分析分支。`,
        docPreview: result.preview,
        docMeta: {
          name: result.filename,
          size: result.size,
          lineCount: result.lineCount,
          charCount: result.charCount,
        },
      }
    ],
  };

  cards.push(newCard);
  renderCards();
  sessionController?.scheduleSave();
  selectCard(newCard.id, false);
  historyManager.recordSnapshot(cards, newCard.id);
  return newCard;
}

listen(btnImportDoc, 'click', () => {
  globalDocInput?.click();
});

listen(globalDocInput, 'change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;
  for (const file of files) {
    await createDocumentCard(file);
  }
  globalDocInput.value = '';
});

// 画布全局拖拽释放文档
let dragOverTimer = null;
listen(viewport, 'dragenter', (e) => {
  if (e.dataTransfer?.types?.includes('Files')) {
    e.preventDefault();
    if (canvasDropIndicator) canvasDropIndicator.hidden = false;
  }
});

listen(viewport, 'dragover', (e) => {
  if (e.dataTransfer?.types?.includes('Files')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (canvasDropIndicator) canvasDropIndicator.hidden = false;
    cancelLater(dragOverTimer);
    dragOverTimer = later(() => {
      if (canvasDropIndicator) canvasDropIndicator.hidden = true;
    }, 400);
  }
});

listen(viewport, 'dragleave', (e) => {
  if (e.target === viewport || e.target === canvasDropIndicator) {
    if (canvasDropIndicator) canvasDropIndicator.hidden = true;
  }
});

listen(viewport, 'drop', async (e) => {
  if (e.dataTransfer?.files?.length) {
    e.preventDefault();
    if (canvasDropIndicator) canvasDropIndicator.hidden = true;
    cancelLater(dragOverTimer);
    const files = Array.from(e.dataTransfer.files);
    const rect = viewport.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const canvasX = Math.round((mouseX - view.x) / view.scale);
    const canvasY = Math.round((mouseY - view.y) / view.scale);

    for (let i = 0; i < files.length; i++) {
      const coord = {
        x: canvasX + i * 40,
        y: canvasY + i * 60,
      };
      await createDocumentCard(files[i], coord);
    }
  }
});

function initialSnapshot() {
  return {
    cards: initialCards(),
    view: { x: 60, y: 40, scale: 1 },
    agent: {
      ...currentAgent,
      ...(currentReasoningEffort ? { reasoningEffort: currentReasoningEffort } : {}),
    },
  };
}
function captureSnapshot() {
  for (const card of cards) {
    const input = document.getElementById(`input-${card.id}`);
    if (input && typeof input.value === 'string') card.draft = input.value;
    const body = document.getElementById(`body-${card.id}`);
    if (typeof body?.scrollTop === 'number') card.savedScrollTop = body.scrollTop;
    for (const message of card.messages) {
      if (!message.requestId) continue;
      const details = document.getElementById(`asides-${message.requestId}`);
      if (typeof details?.open === 'boolean') message.asidesOpen = details.open;
    }
  }
  const { id, name, model, provider } = currentAgent;
  return JSON.parse(JSON.stringify({
    cards,
    view: { x: view.x, y: view.y, scale: view.scale },
    agent: {
      id, name, model, provider,
      ...(currentReasoningEffort ? { reasoningEffort: currentReasoningEffort } : {}),
    },
  }));
}
function applySnapshot(snapshot) {
  if (isDisposed) return;
  // 换了会话就丢掉上一份删除留档。
  // 卡片 id 在新会话里会从头复用（card-1、card-2……），
  // 留着旧留档，撤销时可能把别的会话的内容塞进本会话的同 id 卡片。
  canvasActions.clearRemovedCardArchive();
  if (!snapshot) {
    cards = [];
    view.x = 60; view.y = 40; view.scale = 1; view.isDragging = false;
    updateHeaderStatus(); updateTransform(); renderCards(false);
    return;
  }
  cards = snapshot.cards;
  Object.assign(view, snapshot.view, { isDragging: false });
  agentController.restoreAgent(snapshot.agent);
  updateHeaderStatus(); updateTransform(); renderCards(false);
  historyManager.clear();
  historyManager.recordSnapshot(cards, selectedCardId);
}
function cancelSessionRequests(reason) {
  documentPipeline.abortAll();
  chatEngine.cancelAll(reason);
}
function publishSessionState(targetPanelId) {
  if (isDisposed || !sessionController) return;
  const state = sessionController.state;
  bus.postMessage({
    type: 'FORK_SESSION_STATE',
    canvasId,
    targetPanelId,
    activeId: state.activeId,
    ready: state.ready,
    busy: state.busy || Boolean(deleteIntent),
    saving: state.saving,
    dirty: state.dirty,
    error: state.error,
    agent: {
      ...currentAgent,
      ...(currentReasoningEffort ? { reasoningEffort: currentReasoningEffort } : {}),
    },
  });
}
function replySessionCommand(message, result) {
  if (isDisposed) return;
  if (!message?.requestId || !message?.panelId) return;
  bus.postMessage({ type: 'FORK_SESSION_RESULT', canvasId, targetPanelId: message.panelId,
    requestId: message.requestId, command: message.command, ...result });
}
async function renameSessionFromIntent(message) {
  if (isDisposed) return;
  if (activeRenameCommands.has(message.requestId)) return;
  activeRenameCommands.add(message.requestId);
  try {
    const intent = await readRenameIntent(hana, message.requestId, message.sessionId);
    if (isDisposed) return;
    const result = await sessionController.rename(message.sessionId, intent.title, intent.expectedTitle);
    replySessionCommand(message, result);
  } catch (err) { replySessionCommand(message, { ok: false, error: safeDetail(err.message) }); }
  finally { activeRenameCommands.delete(message.requestId); await clearRenameIntent(hana, message.requestId); }
}
function dismissDeleteConfirmation(cancelled = true) {
  if (!deleteIntent || deleteInProgress) return;
  const message = deleteIntent.message;
  deleteIntent = null;
  deleteDialog.close();
  publishSessionState();
  if (cancelled) replySessionCommand(message, { ok: false, cancelled: true });
}
async function openDeleteConfirmation(message) {
  if (isDisposed) return;
  if (!sessionController.state.ready || sessionController.state.busy) {
    replySessionCommand(message, { ok: false, error: '会话正忙，请稍后重试。' }); return;
  }
  const intent = { message, record: null };
  deleteIntent = intent;
  deleteTargetTitle.textContent = '正在读取会话…';
  deleteDialogError.textContent = '';
  deleteDialogProgress.textContent = '确认前不会删除或取消任何请求。';
  btnDeleteConfirm.disabled = true; btnDeleteCancel.disabled = false;
  deleteDialog.showModal(); btnDeleteCancel.focus(); publishSessionState();
  try {
    const record = await sessionStore.get(message.sessionId);
    if (isDisposed) return;
    if (deleteIntent !== intent) return;
    intent.record = record;
    deleteTargetTitle.textContent = record.title;
    const isCurrent = record.id === sessionController.state.activeId;
    const changedElsewhere = isCurrent && record.revision > sessionController.state.activeRevision;
    deleteDialogProgress.textContent = changedElsewhere
      ? '已保存版本较本窗口记录更新（可能来自其他窗口）。确认后会删除最新已保存版本，以及本窗口未保存的内容。'
      : isCurrent && activeRequests.size ? '当前仍在生成，确认删除后会先停止请求。'
      : '确认后将永久删除该会话及其全部卡片记录。';
    btnDeleteConfirm.disabled = false;
  } catch (err) {
    if (!isDisposed && deleteIntent === intent) deleteDialogError.textContent = safeDetail(err.message);
  }
}
listen(btnDeleteCancel, 'click', () => dismissDeleteConfirmation());
listen(deleteDialog, 'cancel', event => { event.preventDefault(); dismissDeleteConfirmation(); });
listen(btnDeleteConfirm, 'click', async event => {
  // A forged channel message or scripted .click() is not deletion consent.
  // 伪造的通道消息或脚本点击不算删除同意。但不能静默退出，
  // 否则读屏软件和键盘模拟点一次就卡住，界面既不动也不说为什么。
  if (!event?.isTrusted) {
    deleteDialogError.textContent = '这次点击未被识别为本人操作，请直接用鼠标或键盘确认。';
    return;
  }
  const intent = deleteIntent;
  if (!intent?.record || deleteInProgress) return;
  deleteInProgress = true; btnDeleteConfirm.disabled = btnDeleteCancel.disabled = true;
  deleteDialogError.textContent = ''; deleteDialogProgress.textContent = '正在删除…';
  const result = await sessionController.remove(intent.record.id, intent.record.revision, initialSnapshot());
  if (isDisposed) return;
  deleteInProgress = false;
  if (result.ok) {
    dismissDeleteConfirmation(false);
    replySessionCommand(intent.message, result);
  } else {
    deleteDialogError.textContent = result.error || '删除失败，原会话尚未移除。';
    deleteDialogProgress.textContent = '可以取消，或检查存储状态后重试。';
    btnDeleteConfirm.disabled = btnDeleteCancel.disabled = false;
  }
});

// 合成起止用捕获阶段挂在 document 上，卡片重建后依然有效；
// 必须走 listen，面板销毁时要能解绑，否则关掉的画布还在收事件。
listen(document, 'compositionstart', event => {
  if (event?.target?.classList?.contains?.('card-input')) composingInputId = event.target.id || '';
}, true);
listen(document, 'compositionend', () => {
  composingInputId = null;
  if (pendingRenderCards && !isDisposed) { pendingRenderCards = false; renderCards(); }
}, true);

let lastPhase = '';
let lastNotice = '';
const sessionStore = createForkSessionStore(hana);
sessionController = createForkSessionController({
  store: sessionStore, capture: captureSnapshot, apply: applySnapshot, cancelPending: cancelSessionRequests,
  onChange(state) {
    if (isDisposed) return;
    // 会话控制器只知道"发生了什么"，说不出人话；在这里翻成一句提示
    if (state.notice && state.notice !== lastNotice) {
      lastNotice = state.notice;
      flashMessage(state.notice);
    }
    sessionStatusEl.textContent = state.error ? `${state.dirty ? '未保存' : '会话操作失败'} · ${safeDetail(state.error)}`
      : !state.ready ? '正在恢复会话…'
      : !state.activeId ? '暂无会话 · 可点击新建会话'
      : `${state.title} · ${state.busy ? '正在切换…' : state.saving ? '保存中…' : state.dirty ? '待保存' : '已保存'}`;
    sessionStatusEl.title = sessionStatusEl.textContent;
    btnRetrySave.hidden = !state.error;
    btnSaveCopy.hidden = !state.error || !state.ready;
    btnRetrySave.disabled = btnSaveCopy.disabled = state.busy;
    btnNewRoot.disabled = !state.ready || state.busy;
    const phase = `${state.ready}:${state.busy}`;
    if (lastPhase !== phase) { lastPhase = phase; renderCards(); }
    publishSessionState();
  },
});
listen(btnEmptyNewSession, 'click', () => {
  void sessionController?.newSession(initialSnapshot()).catch(() => {});
});
listen(btnRetrySave, 'click', () => { void (sessionController.state.ready ? sessionController.flush() : sessionController.init()).catch(() => {}); });
listen(btnSaveCopy, 'click', () => { void sessionController.saveCopy().catch(() => {}); });
const stopWatchingSessions = sessionStore.watch(() => { void sessionController.refresh().catch(() => {}); });

function disposePanel() {
  if (disposalPromise) return disposalPromise;
  if (isDisposed) return Promise.resolve();
  isDisposed = true; // Close the command gate synchronously, before any await.
  panelAbort.abort(inactiveError());
  for (const stop of [unbindKeyboardShortcuts, stopWatchingSessions]) { try { stop?.(); } catch {} }
  drain(cardCleanups); drain(battleCleanups); drain(panelCleanups);
  for (const timer of panelTimers) clearTimeout(timer);
  panelTimers.clear();
  bus.onmessage = null;
  try { bus.close?.(); } catch {}
  for (const intentId of ownedBridgeClaims) void releaseBridgeClaim(intentId);
  btnUseLastPrompt.onclick = null;
  const sendText = document.getElementById('bridge-send-text');
  if (sendText) sendText.oninput = null;
  battleFlow.controller.cleanup();
  canvasViewController.cleanup();
  view.isDragging = false;
  isSpacePressed = false;
  viewport.classList.remove('is-hand-tool', 'is-dragging-canvas');
  document.body?.classList.remove('is-card-resizing', 'resizing-s', 'resizing-se', 'resizing-ew');
  canvasDropIndicator.hidden = true;
  for (const card of cards) {
    document.getElementById(`dom-${card.id}`)?.classList.remove('is-resizing', 'card-drop-active');
    const input = document.getElementById(`input-${card.id}`);
    if (input) input.disabled = true;
  }
  for (const control of document.querySelectorAll?.('button, input, textarea, select') || []) control.disabled = true;
  for (const dialog of [battleDialog, deleteDialog, bridgeDialogEl, bridgeSendDialogEl]) dialog?.close?.();
  // close() cancels generation-bound work and flushes the last snapshot once.
  disposalPromise = sessionController.close();
  void disposalPromise.catch(() => {});
  return disposalPromise;
}

listen(window, 'pagehide', () => {
  disposePanel();
});

// Ready precedes host storage requests; initialization failures remain visible.
updateTransform(); renderCards(); hana.ready();
await sessionController.init();
if (bridgeInitialized && !isDisposed) void pollBridgeIntents();

if (typeof window !== 'undefined') {
  window.__forkChat = {
    sendCardPrompt,
    buildChainContext,
    loadAvailableAgents,
    getAvailableAgents: () => agentController.getAvailableAgents(),
    getCards: () => cards,
    getView: () => view,
    openBattleDialog,
    closeBattleDialog,
    runBattleBranches,
    calculateBranchYPositions,
    fitViewportToCluster,
    selectCard,
    createBranchCard,
    closeCardHierarchy,
    navigateCardFocus,
    getSelectedCardId: () => selectedCardId,
    getIsSpacePressed: () => isSpacePressed,
    autoTidyLayout,
    renderCards,
    renderConnectors,
    toggleMultiSelectCard,
    clearMultiSelect,
    getMultiSelectedCardIds: () => multiSelectedCardIds,
    synthesizeMergePrompt,
    createMergeCardFromSelected,
    formatFileSize,
    extractDocumentFile,
    createDocumentCard,
    undo: () => historyManager.undo(),
    redo: () => historyManager.redo(),
    canUndo: () => historyManager.canUndo(),
    canRedo: () => historyManager.canRedo(),
    getHistoryStats: () => historyManager.getStats(),
    unbindKeyboardShortcuts: () => unbindKeyboardShortcuts?.(),
    unbindViewportController: () => canvasViewController.cleanup(),
    isDisposed: () => isDisposed,
    dispose: disposePanel,
  };
}
