import { hana } from './sdk.js';
import { safeDetail, requestHost } from './host-api.js';
import { runChat, ChatError } from './chat-client.js';
import { parseAssistantOutput } from './assistant-output.js';
import { createForkSessionStore } from './fork-session-store.js';
import { createForkSessionController } from './fork-session-controller.js';
import { createPanelSessionUi } from './panel-session-ui.js';
import { createFeedbackService } from './panel-feedback.js';
import { collectSubtreeCardIds, computeVisibleCards } from './panel-layout.js';
import { bindKeyboardShortcuts } from './panel-shortcuts.js';
import { formatFileSize, rootSlotPosition, escapeHtml } from './panel-format.js';
import { createAgentController } from './panel-agents.js';
import { createCanvasViewController, shouldPreserveCardInputFocus } from './panel-canvas-view.js';
import { statusText, outputFor, asidesText, messageMarkup, createMessagePainter } from './panel-messages.js';
import { cardParentIds, cardHasParent } from './panel-context.js';
import { createDocumentPipeline } from './panel-documents.js';
import { createChatEngine } from './panel-chat-engine.js';
import { createBattleFlow } from './panel-battle-flow.js';
import { createMergeController } from './panel-merge.js';
import { clampCardWidth, clampCardHeight, buildCardHtml, cycleCardStatusStamp, findCardAncestorChain, formatCardChainMarkdown, createInitialCards } from './panel-cards.js';
import { buildTopologyOutline } from './panel-topology-export.js';
import { buildContextPlan } from './panel-context-plan.js';
import { createHistoryController } from './panel-history-controller.js';
import { createCanvasActions } from './panel-canvas-actions.js';
import { createSelectionBranchController } from './panel-selection-popover.js';
import { createContextPreview } from './panel-context-preview.js';
import { createRefController } from './panel-refs.js';
import { createBridgeSend } from './panel-bridge-send.js';
import { createBridgeIntents } from './panel-bridge-intents.js';
import { createDocumentUi } from './panel-document-ui.js';
import { createCardGestures } from './panel-card-gestures.js';
import { createCardEvents, createInputRecoveryBuffer } from './panel-card-events.js';
import { createRenderer } from './panel-renderer.js';
import { cardContentSignature, canReuseCardElement } from './panel-render-diff.js';
import { createSearchController } from './panel-search-controller.js';
import { createArtifactView } from './panel-artifact-view.js';
import { createSessionState } from './panel-session-state.js';
import { createBridge } from './panel-bridge.js';
import { findCardsByKeyword, getNextMatchIndex, bindSearchBarController } from './panel-search.js';

const activeRequests = new Map();

let sessionUi = null;
let feedbackService = null;
const flashMessage = (msg) => feedbackService?.flashMessage(msg);

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

const artifactView = createArtifactView({
  hana, requestHost, flashMessage: message => flashMessage(message),
  getCards: () => cards, getGeneration: () => sessionController?.generation,
  isDisposed: () => isDisposed,
});

// 卡片上的全部事件
const cardEvents = createCardEvents({
  recoveryBuffer: createInputRecoveryBuffer({
    getSession: () => sessionController,
    getCards: () => cards,
  }),
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
  cancelCardRequest: (cardId, reason) => chatEngine.cancelCardRequest(cardId, reason),
  findCardAncestorChain: (...args) => findCardAncestorChain(...args),
  cardParentIds: (card) => cardParentIds(card),
  formatCardChainMarkdown: (...args) => formatCardChainMarkdown(...args),
  buildTopologyOutline: (...args) => buildTopologyOutline(...args),
  openContextPreview: card => contextPreview.show(card),
  openRefManager: card => refController.showManager(card),
});


// 卡片层的重建与输入法守卫
const renderer = createRenderer({
  cardContentSignature,
  canReuseCardElement,
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
  onBeforeRender: () => resetTransientUI(),
  onAfterRender: () => {
    try { contextPreview?.refresh?.(); } catch {}
  },
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
  buildContextPlan: (targetCard, { pendingUserMessage }) => buildContextPlan({ cards, targetCard, pendingUserMessage }),
  reportContextIssue: (issue) => {
    try {
      const msg = typeof issue === 'string' ? issue : (issue?.message || '上下文检查异常');
      flashMessage(msg);
    } catch {}
  },
  flashMessage: (message) => flashMessage(message),
  paintMessage: (message) => paintMessage(message),
  renderCards: () => renderCards(),
  getAgentReasoningEffort: (id) => getAgentReasoningEffort(id),
  getCards: () => cards,
  getSession: () => sessionController,
  getAgent: () => currentAgent,
  getReasoningEffort: () => currentReasoningEffort,
  scheduleSave: () => sessionController.scheduleSave(),
  documentRef: document,
});
function chainIsBusy(card) { return chatEngine.chainIsBusy(card); }
function sendCardPrompt(card, text, options) { return chatEngine.sendCardPrompt(card, text, options); }
let sessionController = null;
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
const initialCards = () => createInitialCards();
let cards = initialCards();
let selectedCardId = null;
let isSpacePressed = false;

// DOM 元素引用
const viewport = document.getElementById('viewport');
const surface = document.getElementById('surface');
const connectorsSvg = document.getElementById('connectors-svg');
const refConnectorsSvg = document.getElementById('ref-connectors-svg');
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
  isBusy: () => Boolean(sessionController?.state.busy || sessionUi?.hasDeleteIntent()),
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
  if (sessionUi?.handleSessionMessage(message)) {
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
  refConnectorsSvg,
  btnZoomIn,
  btnZoomOut,
  getIsSpacePressed: () => isSpacePressed,
  canMutateCanvas: () => canMutateCanvas(),
  renderCards: (preserve, options) => renderCards(preserve, options),
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
    chatEngine.cancelCardRequest(id, '卡片已关闭。');
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
  extractDocumentFile: (file, cardId) => extractDocumentFile(file, cardId),
});

const rememberRemovedCard = card => canvasActions.rememberRemovedCard(card);
const removedCardArchive = canvasActions.removedCardArchive;
// 预览只读：展示这次请求会带上什么，不改卡片也不发请求
const contextPreview = createContextPreview({
  getDocument: () => document,
  getCards: () => cards,
  getGeneration: () => sessionController?.generation ?? null,
  reportIssue: message => flashMessage(message),
});
panelCleanups.add(() => contextPreview.dispose());

// 引用：原文快照，只增删，不成为父边
const refController = createRefController({
  getCards: () => cards,
  getRetainedReferenceIds: () => historyManager.getRetainedReferenceIds(),
  renderCards: () => renderCards(),
  renderConnectors: () => renderConnectors(),
  scheduleSave: () => sessionController.scheduleSave(),
  recordSnapshot: (list, id) => historyManager.recordSnapshot(list, id),
  flashMessage: message => flashMessage(message),
  getDocument: () => document,
  getGeneration: () => sessionController?.generation ?? null,
  canMutateCanvas: () => canMutateCanvas(),
  getIsDisposed: () => isDisposed,
});
panelCleanups.add(() => refController.dispose());

const createRootCard = () => canvasActions.createRootCard();
const createBranchCard = (card, opts) => canvasActions.createBranchCard(card, opts);

// 正文划词开分支：只预填草稿，不发送，父卡片一个字段都不动
const selectionController = createSelectionBranchController({
  getDocument: () => document,
  getCards: () => cards,
  createBranchCard: (card, opts) => canvasActions.createBranchCard(card, opts),
  getSelectedCardId: () => selectedCardId,
  addContextRef: (ownerId, payload) => refController.addRef(ownerId, payload),
  reportIssue: message => flashMessage(message),
  getGeneration: () => sessionController?.generation ?? null,
  getIsDisposed: () => isDisposed,
  canMutateCanvas: () => canMutateCanvas(),
  chainIsBusy: card => chainIsBusy(card),
  listen: (target, type, handler, options) => listen(target, type, handler, options),
});
selectionController.attach();
panelCleanups.add(() => selectionController.dispose());

function resetTransientUI() {
  artifactView.dismiss();
  try { selectionController?.reset?.() || selectionController?.hide?.(); } catch {}
  try { refController?.closeManager?.(); } catch {}
}

function closeAllTransientUI() {
  resetTransientUI();
  try { contextPreview?.close?.(); } catch {}
  try { cardEvents.dispose(); } catch {}
}
const closeCardHierarchy = card => canvasActions.closeCardHierarchy(card);
const createDocumentCard = (file, coord) => canvasActions.createDocumentCard(file, coord);
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
  scheduleSave: () => sessionController.scheduleSave(),
  isDisposed: () => isDisposed,
  onBudgetTrim: () => flashMessage('撤销历史达到内容保留上限，部分历史操作已不可撤销；当前画布内容未受影响。'),
  maxDepth: 30,
});
historyManager.recordSnapshot(cards, null);

// 向上递归回溯祖先节点，委托统一上下文计划拼装从根节点到当前节点的完整上下文链路
const buildChainContext = targetCard => {
  const plan = buildContextPlan({ cards, targetCard });
  if (plan.errors?.length) {
    const err = new Error(plan.errors[0]?.message || '上下文编译错误');
    err.code = plan.errors[0]?.code || 'CONTEXT_PLAN_ERROR';
    throw err;
  }
  return plan.messages;
};


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
  reportContextIssue: issue => {
    try {
      const msg = typeof issue === 'string' ? issue : (issue?.message || '合流检查未通过');
      flashMessage(msg);
    } catch {}
  },
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

function renderCards(preserve = true, options = {}) {
  renderer.renderCards(preserve, options);
}

function bindCardEvents(cardEl, card) {
  cardEvents.bindCardEvents(cardEl, card);
  artifactView.bind(cardEl, card, (target, type, handler) => listen(target, type, handler, undefined, cardCleanups));
}

// 全局卡片搜索控制器 (Ctrl+F)
const search = createSearchController({
  getCards: () => cards,
  getDocumentRef: () => document,
  getIsDisposed: () => isDisposed,
  selectCard: (id, focus) => selectCard(id, focus),
  ensureCardInView: (card) => ensureCardInView(card),
  findCardsByKeyword: (args) => findCardsByKeyword(args),
  getNextMatchIndex: (args) => getNextMatchIndex(args),
  bindSearchBarController: (opts) => bindSearchBarController(opts),
  searchBarEl: canvasSearchBar,
  searchInputEl: canvasSearchInput,
  counterEl: canvasSearchCounter,
  btnPrev: btnSearchPrev,
  btnNext: btnSearchNext,
  btnClose: btnSearchClose,
  listen,
  setTimeoutRef: (fn, ms) => setTimeout(fn, ms),
  clearTimeoutRef: (id) => clearTimeout(id),
  trackTimer: (id) => panelTimers.add(id),
  untrackTimer: (id) => panelTimers.delete(id),
});
const searchController = search.controller;
const clearSearchHighlights = () => search.clearSearchHighlights();
const focusSearchMatch = (index) => search.focusSearchMatch(index);
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

// 整理按钮按下时会把焦点从输入框抢走，正在输入法组合的那截字当场就没了。
// 这里只拦这一次焦点迁移：点击照样触发，整理照做，输入框和组合输入都留着。
listen(btnAutoTidy, 'mousedown', (event) => {
  if (!shouldPreserveCardInputFocus(event, document.activeElement)) return;
  event.preventDefault();
});

listen(btnAutoTidy, 'click', () => {
  autoTidyLayout();
});

listen(btnResetView, 'click', () => {
  canvasViewController.resetView();
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

const sessionState = createSessionState({
  reportIssue: message => flashMessage(message),
  resetTransientUI: () => closeAllTransientUI(),
  documentRef: document,
  getCards: () => cards,
  setCards: (next) => { cards = next; },
  getView: () => view,
  getSelectedCardId: () => selectedCardId,
  getCurrentAgent: () => currentAgent,
  getReasoningEffort: () => currentReasoningEffort,
  getIsDisposed: () => isDisposed,
  initialCards: () => initialCards(),
  clearRemovedCardArchive: () => canvasActions.clearRemovedCardArchive(),
  restoreAgent: (agent) => agentController.restoreAgent(agent),
  updateHeaderStatus: () => updateHeaderStatus(),
  updateTransform: () => updateTransform(),
  renderCards: (preserve) => renderCards(preserve),
  clearHistory: () => historyManager.clear(),
  recordSnapshot: (list, id) => historyManager.recordSnapshot(list, id),
  abortAllDocumentTasks: () => documentPipeline.abortAll(),
  cancelAllRequests: (reason) => chatEngine.cancelAll(reason),
  getSessionController: () => sessionController,
  getDeleteIntent: () => sessionUi?.getDeleteIntent() || null,
  bus,
  canvasId,
});
const initialSnapshot = () => sessionState.initialSnapshot();
const captureSnapshot = () => sessionState.captureSnapshot();
const applySnapshot = (snapshot) => sessionState.applySnapshot(snapshot);
const cancelSessionRequests = (reason) => sessionState.cancelSessionRequests(reason);
const publishSessionState = (targetPanelId) => sessionState.publishSessionState(targetPanelId);
// 合成起止用捕获阶段挂在 document 上，卡片重建后依然有效；
// 必须走 listen，面板销毁时要能解绑，否则关掉的画布还在收事件。
listen(document, 'compositionstart', event => renderer.onCompositionStart(event), true);
listen(document, 'compositionend', () => renderer.onCompositionEnd(), true);

feedbackService = createFeedbackService({
  documentRef: document,
  later,
  cancelLater,
  isDisposed: () => isDisposed,
});

const sessionStore = createForkSessionStore(hana);

sessionUi = createPanelSessionUi({
  hana,
  sessionStore,
  getSessionController: () => sessionController,
  bus,
  canvasId,
  safeDetail,
  initialSnapshot: () => initialSnapshot(),
  publishSessionState: (id) => publishSessionState(id),
  renderCards: (preserve) => renderCards(preserve),
  listen,
  deleteDialog,
  deleteTargetTitle,
  deleteDialogError,
  deleteDialogProgress,
  btnDeleteConfirm,
  btnDeleteCancel,
  sessionStatusEl,
  btnRetrySave,
  btnSaveCopy,
  btnNewRoot,
  btnEmptyNewSession,
  documentRef: document,
  later,
  cancelLater,
  flashMessage,
  isDisposed: () => isDisposed,
  hasActiveRequests: () => activeRequests.size > 0,
});

sessionController = createForkSessionController({
  store: sessionStore,
  capture: captureSnapshot,
  apply: applySnapshot,
  cancelPending: cancelSessionRequests,
  onChange: (state) => sessionUi.handleSessionStateChange(state),
});
const stopWatchingSessions = sessionStore.watch(() => { void sessionController.refresh().catch(() => {}); });

function disposePanel() {
  if (disposalPromise) return disposalPromise;
  if (isDisposed) return Promise.resolve();
  isDisposed = true; // Close the command gate synchronously, before any await.
  panelAbort.abort(inactiveError());
  artifactView.dispose();
  for (const stop of [unbindKeyboardShortcuts, stopWatchingSessions]) { try { stop?.(); } catch {} }
  drain(cardCleanups); drain(battleCleanups); drain(panelCleanups);
  for (const timer of panelTimers) clearTimeout(timer);
  panelTimers.clear();
  bus.onmessage = null;
  try { bus.close?.(); } catch {}
  for (const intentId of getOwnedClaims()) void releaseBridgeClaim(intentId);
  // 全局句柄会一直握着 cards、历史与 DOM 引用，销毁时要摘掉
  if (typeof window !== 'undefined' && window.__forkChat) {
    try { delete window.__forkChat; } catch { window.__forkChat = undefined; }
  }
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
  closeAllTransientUI();
  historyManager.clear();
  sessionUi?.dispose();
  feedbackService?.dispose();
  // close() cancels generation-bound work and flushes the last snapshot once.
  // 初始化没完成就 pagehide 时这里还是 null，不能让它把整个销毁流程打断。
  if (!sessionController) {
    disposalPromise = Promise.resolve();
    return disposalPromise;
  }
  disposalPromise = sessionController.close();
  void disposalPromise.catch(() => {});
  return disposalPromise;
}

listen(window, 'pagehide', () => {
  disposePanel();
});

// Ready precedes host storage requests; initialization failures remain visible.
updateTransform(); renderCards(); hana.ready();
try {
  await sessionController.init();
} catch (err) {
  // 存储或宿主没起来：画面留着，把原因说清楚，别让整页静默死掉
  flashMessage(`会话初始化失败：${safeDetail(err?.message || String(err))}`);
}
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
    getRecoveryBuffer: () => cardEvents.recoverableBuffer,
    getRecoverableInputBackup: (cardId) => cardEvents.recoverableBuffer.get(cardId),
    restoreRecoverableInputBackup: (cardId, opts) => cardEvents.recoverableBuffer.restore(cardId, opts),
    clearRecoverableInputBackups: () => cardEvents.recoverableBuffer.clear(),
  };
}
