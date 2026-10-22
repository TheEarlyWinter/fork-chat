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
import { createBridgeSend } from './panel-bridge-send.js';
import { createBridgeIntents } from './panel-bridge-intents.js';
import { createDocumentUi } from './panel-document-ui.js';
import { createCardGestures } from './panel-card-gestures.js';
import { createCardEvents } from './panel-card-events.js';
import { createRenderer } from './panel-renderer.js';
import { createBridge } from './panel-bridge.js';
import { findCardsByKeyword, getNextMatchIndex, bindSearchBarController } from './panel-search.js';

const activeRequests = new Map();

// 卡片上的拖拽移动与缩放
const cardGestures = createCardGestures({
  listen: (target, type, handler) => listen(target, type, handler),
  getSession: () => sessionController,
  getCards: () => cards,
  getView: () => view,
  getIsSpacePressed: () => isSpacePressed,
  getSelectedCardId: () => selectedCardId,
  getDocumentRef: () => document,
  renderConnectors: () => renderConnectors(),
  scheduleSave: () => sessionController?.scheduleSave(),
  recordSnapshot: (list, id) => historyManager?.recordSnapshot(list, id),
  getIsDisposed: () => isDisposed,
  getWindowRef: () => (typeof window !== 'undefined' ? window : globalThis),
});

// 文档上传的界面动作：选文件、拖进卡片、拖到画布
const documentUi = createDocumentUi({
  extractDocumentFile: (file, cardId) => extractDocumentFile(file, cardId),
  flashMessage: (msg) => flashMessage(msg),
  canMutateCanvas: (generation) => canMutateCanvas(generation),
  getCards: () => cards,
  getSession: () => sessionController,
  renderCards: () => renderCards(),
  scheduleSave: () => sessionController?.scheduleSave(),
  createDocumentCard: (file, coord) => createDocumentCard(file, coord),
  getView: () => view,
  getViewport: () => viewport,
  getDropIndicator: () => canvasDropIndicator,
  getIsDisposed: () => isDisposed,
  later: (fn, ms) => later(fn, ms),
  cancelLater: (id) => cancelLater(id),
});

// 卡片上的全部事件
const cardEvents = createCardEvents({
  listen: (...args) => listen(...args),
  getCardCleanups: () => cardCleanups,
  hana,
  flashMessage: (msg) => flashMessage(msg),
  safeDetail: (v) => safeDetail(v),
  getSession: () => sessionController,
  getCards: () => cards,
  getIsDisposed: () => isDisposed,
  getIsSpacePressed: () => isSpacePressed,
  getSelectedCardId: () => selectedCardId,
  getDocumentRef: () => document,
  getNavigator: () => (typeof navigator !== 'undefined' ? navigator : null),
  activeRequests,
  paintMessage: (m) => paintMessage(m),
  ChatError,
  chainIsBusy: (card) => chainIsBusy(card),
  openBattleDialog: (card, text) => openBattleDialog(card, text),
  documentUi,
  cardGestures,
  createBranchCard: (card, opts) => createBranchCard(card, opts),
  closeCardHierarchy: (card) => closeCardHierarchy(card),
  cycleCardStatusStamp: (v) => cycleCardStatusStamp(v),
  selectCard: (id, focus) => selectCard(id, focus),
  toggleMultiSelectCard: (id) => toggleMultiSelectCard(id),
  clearMultiSelect: () => clearMultiSelect(),
  renderCards: () => renderCards(),
  renderConnectors: () => renderConnectors(),
  scheduleSave: () => sessionController?.scheduleSave(),
  recordSnapshot: (list, id) => historyManager?.recordSnapshot(list, id),
  canMutateCanvas: (generation) => canMutateCanvas(generation),
  sendCardPrompt: (card, text, opts) => sendCardPrompt(card, text, opts),
  findCardAncestorChain: (...args) => findCardAncestorChain(...args),
  cardParentIds: (card) => cardParentIds(card),
  formatCardChainMarkdown: (...args) => formatCardChainMarkdown(...args),
});


// 卡片层的重建与输入法守卫
const renderer = createRenderer({
  documentRef: document,
  getCardsLayer: () => cardsLayer,
  getBadgeStats: () => badgeStats,
  getEmptyState: () => canvasEmptyState,
  getIsDisposed: () => isDisposed,
  getCards: () => cards,
  getSelectedCardId: () => selectedCardId,
  getCurrentAgent: () => currentAgent,
  getSession: () => sessionController,
  getMultiSelectedCardIds: () => multiSelectedCardIds,
  activeRequests,
  chainIsBusy: (card) => chainIsBusy(card),
  drain: (set) => drain(set),
  getCardCleanups: () => cardCleanups,
  computeVisibleCards: (args) => computeVisibleCards(args),
  collectSubtreeCardIds: (args) => collectSubtreeCardIds(args),
  cardParentIds: (card) => cardParentIds(card),
  buildCardHtml: (args) => buildCardHtml(args),
  escapeHtml: (v) => escapeHtml(v),
  messageMarkup: (...args) => messageMarkup(...args),
  statusText: (...args) => statusText(...args),
  formatFileSize: (v) => formatFileSize(v),
  bindCardEvents: (el, card) => bindCardEvents(el, card),
  renderConnectors: () => renderConnectors(),
});

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

function renderCards(preserve = true) {
  renderer.renderCards(preserve);
}

function bindCardEvents(cardEl, card) {
  cardEvents.bindCardEvents(cardEl, card);
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

const bridgeSend = createBridgeSend({
  documentRef: () => document,
  isDisposed: () => isDisposed,
  bridgeRequest: (path, init) => bridgeRequest(path, init),
  safeDetail,
  escapeHtml,
  flashMessage: (text) => flashMessage(text),
  getCards: () => cards,
  getSelectedCardId: () => selectedCardId,
  getBridgeTargetSessionId: () => bridge.getBridgeTargetSessionId(),
  bridgeSendDialogEl,
  listen,
});

function updateBridgeSendControls() {
  return bridgeSend.updateBridgeSendControls();
}

function closeBridgeSendDialog() {
  return bridgeSend.closeBridgeSendDialog();
}

function openBridgeSendDialog() {
  return bridgeSend.openBridgeSendDialog();
}

function confirmBridgeSend() {
  return bridgeSend.confirmBridgeSend();
}

const bridge = createBridge({
  documentRef: () => document,
  windowRef: () => window,
  hana,
  isDisposed: () => isDisposed,
  bridgeRequest: (path, init) => bridgeRequest(path, init),
  safeDetail,
  escapeHtml,
  flashMessage: (text) => flashMessage(text),
  canMutateCanvas: (generation) => canMutateCanvas(generation),
  getGeneration: () => sessionController?.generation,
  createBridgeDocCard: (payload) => createBridgeDocCard(payload),
  flushSession: () => sessionController.flush(true),
  getCanvasId: () => canvasId,
  getOwnedClaims: () => getOwnedClaims(),
  bindBridgeSend: () => bridgeSend.bind(),
  pollBridgeIntents: () => pollBridgeIntents(),
  addCleanup: (fn) => panelCleanups.add(fn),
  // 测试环境（VM）里没有 setInterval，拿不到就不装轮询。
  // 原来这条守卫就在调用处，搬的时候得跟着走，不然整块桥接初始化全炸。
  setIntervalRef: (fn, ms) => (typeof setInterval === 'function' ? setInterval(fn, ms) : null),
  clearIntervalRef: (id) => {
    if (id != null && typeof clearInterval === 'function') clearInterval(id);
  },
  listen,
  bridgeDialogEl,
  bridgeSessionSelect,
  bridgeKindSelect,
  bridgeLeafSelect,
  bridgeLeafField,
  bridgePreviewEl,
  bridgeErrorEl,
  bridgeImportBtn,
  bridgeActiveHint,
});

function selectedBridgeKind() {
  return bridge.selectedBridgeKind();
}

function resetBridgeLeafChoices() {
  return bridge.resetBridgeLeafChoices();
}

function renderBridgeLeafChoices(preview) {
  return bridge.renderBridgeLeafChoices(preview);
}

function loadBridgeSessions(preferSessionId = null) {
  return bridge.loadBridgeSessions(preferSessionId);
}

function bindActiveSession() {
  return bridge.bindActiveSession();
}

function runBridgePreview() {
  return bridge.runBridgePreview();
}

function importBridgePreview() {
  return bridge.importBridgePreview();
}

function loadOutboxList() {
  return bridge.loadOutboxList();
}

function deliverIntent(intent, ctx) {
  return bridge.deliverIntent(intent, ctx);
}

const bridgeIntents = createBridgeIntents({
  hana,
  requestHost,
  bridgeRequest: (path, init) => bridgeRequest(path, init),
  canMutateCanvas: (generation) => canMutateCanvas(generation),
  getGeneration: () => sessionController?.generation,
  getCanvasId: () => canvasId,
  deliverIntent: (intent, context) => deliverIntent(intent, context),
});

function getOwnedClaims() {
  return bridgeIntents.getOwnedClaims();
}

function releaseBridgeClaim(intentId) {
  return bridgeIntents.releaseBridgeClaim(intentId);
}

function pollBridgeIntents() {
  return bridgeIntents.pollBridgeIntents();
}

function initSessionBridge() {
  return bridge.initSessionBridge();
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
    documentUi.showDropIndicator();
  }
});

listen(viewport, 'dragleave', (e) => {
  if (e.target === viewport || e.target === canvasDropIndicator) {
    documentUi.hideDropIndicator();
  }
});

listen(viewport, 'drop', async (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  await documentUi.dropFilesOnViewport(Array.from(e.dataTransfer.files), e.clientX, e.clientY);
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
listen(document, 'compositionstart', event => renderer.onCompositionStart(event), true);
listen(document, 'compositionend', () => renderer.onCompositionEnd(), true);

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
  for (const intentId of getOwnedClaims()) void releaseBridgeClaim(intentId);
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
if (bridge.isInitialized() && !isDisposed) void pollBridgeIntents();

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
