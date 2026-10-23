import {
  selectionByteLength,
  validateSelection,
  buildBranchDraft,
  findCardIdFromNode,
  isAssistantBubble,
  resolveSelectionBubble,
  selectionContainsMath,
  readMessageIndex,
  resolveSourceMessage,
  verifyMessageCandidate,
} from './panel-selection.js';
import { getContextMode } from './fork-context-policy.js';

const POPOVER_OFFSET = 8;
const POPOVER_WIDTH = 220;

/**
 * 划词浮层控制器：只负责把「选中的一段正文」变成一次动作。
 *
 * 判定规则在 panel-selection.js（纯函数，不碰 DOM），这里只做接线与浮层。
 *
 * 候选是暂态，不是可存盘的东西：记下代际、源卡活对象、消息活对象、正文节点、
 * 正文版本和引文。真正执行前把这几样全部重验一遍——只比 cardId 是不够的，
 * 切会话可能复用 ID，消息也可能被删掉或者改过正文。
 */

const STALE_MESSAGES = Object.freeze({
  DISPOSED: '面板已经关闭，这次没有执行',
  BUSY: '当前路径还在生成，等它结束再操作',
  SOURCE_EXCLUDED: '这张卡已设为不向后续分支提供上下文，不能从它摘取原文',
  STALE: '这段选区已经失效了（消息或卡片变过），请重新划词',
});

/**
 * 创建控制器。所有 DOM 访问都从 deps.getDocument() 拿，
 * 便于在没有浏览器的环境里跑测试。
 *
 * required 端口一个都不许省：缺了就是漏接，不能靠默认空实现把问题藏起来。
 * 引用入口是唯一可选的（onReference / addContextRef 都没有时就不显示）。
 */
export function createSelectionController(deps = {}) {
  for (const key of ['getDocument', 'createBranchCard', 'getCards', 'getGeneration', 'getIsDisposed', 'canMutateCanvas', 'chainIsBusy', 'listen', 'reportIssue']) {
    if (typeof deps[key] !== 'function') throw new TypeError(`createSelectionBranchController 缺少依赖：${key}`);
  }
  const {
    getDocument,
    createBranchCard,
    getCards,
    getGeneration,
    getIsDisposed,
    canMutateCanvas,
    chainIsBusy,
    listen,
    reportIssue,
    getSelectedCardId = null,
    addContextRef = null,
    onReference = null,
  } = deps;

  let popover = null;
  let branchButton = null;
  let refTargetSelect = null;
  let pending = null;
  let disposed = false;
  let attached = false;
  let lastTargetSignature = '';
  const cleanups = [];

  function doc() {
    return getDocument();
  }

  function hasReferenceEntry() {
    return typeof onReference === 'function' || typeof addContextRef === 'function';
  }

  /** 提示端口本身抛错也不能改变已决定的状态，更不能把异常冒到交互里 */
  function notify(message) {
    if (!message) return;
    try {
      reportIssue(message);
    } catch {
      // 通知失败只丢这条提示，不动候选与画布
    }
  }

  function detachPopover() {
    if (!popover) return;
    if (typeof popover.remove === 'function') popover.remove();
    else popover.parentNode?.removeChild?.(popover);
    popover = null;
    branchButton = null;
    refTargetSelect = null;
    lastTargetSignature = '';
  }

  function hide() {
    const hadSomething = Boolean(pending) || Boolean(popover);
    pending = null;
    detachPopover();
    return hadSomething;
  }

  /** 事件目标是不是落在浮层里（含原生 select 自己的子节点） */
  function insidePopover(node) {
    let current = node;
    let depth = 0;
    while (current && depth < 8) {
      if (current === popover) return true;
      current = current.parentNode;
      depth += 1;
    }
    return false;
  }

  /** 原生 select 正在交互时，不让选区变化把浮层拆掉 */
  function popoverHasFocus() {
    if (!popover) return false;
    const active = doc()?.activeElement;
    return Boolean(active) && insidePopover(active);
  }

  function ensurePopover() {
    if (popover) return popover;
    const ownerDoc = doc();
    if (!ownerDoc) return null;
    popover = ownerDoc.createElement('div');
    popover.className = 'selection-popover';
    popover.addEventListener('mousedown', event => {
      // 按下就阻止默认，否则选区先被清掉，点击时拿到的是空文本。
      // 唯独原生 select 不能拦：拦了它就不弹下拉了。
      if (event.target === refTargetSelect) {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    });
    popover.addEventListener('mouseup', event => {
      // 浮层内部的事件不该再触发一次外部 inspect
      event.stopPropagation();
    });

    branchButton = ownerDoc.createElement('button');
    branchButton.type = 'button';
    branchButton.className = 'selection-branch-btn';
    branchButton.dataset.act = 'branch';
    branchButton.textContent = '开分支';
    branchButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      commit();
    });
    popover.appendChild(branchButton);

    // 目标用下拉显式选：卡片被点选时会改选中态，靠它推断目标不可靠
    if (hasReferenceEntry()) {
      refTargetSelect = ownerDoc.createElement('select');
      refTargetSelect.className = 'selection-ref-target';
      refTargetSelect.addEventListener('mousedown', event => {
        // 原生下拉自己要吃这个事件，只挡住外部监听，不 preventDefault
        event.stopPropagation();
      });
      refTargetSelect.addEventListener('mouseup', event => event.stopPropagation());
      refTargetSelect.addEventListener('click', event => event.stopPropagation());
      refTargetSelect.addEventListener('change', event => {
        event.preventDefault();
        event.stopPropagation();
        const ownerId = refTargetSelect.value;
        refTargetSelect.value = '';
        if (ownerId) commitReference(ownerId);
      });
      popover.appendChild(refTargetSelect);
    }

    ownerDoc.body.appendChild(popover);
    return popover;
  }

  /**
   * 只在候选或目标列表变了的时候重建 options。
   * 每次 mouseup 都清空重填，会让原生下拉在交互中被换掉。
   */
  function refreshTargetOptions(cardId) {
    if (!refTargetSelect) return;
    const ownerDoc = doc();
    if (!ownerDoc) return;
    const cards = Array.isArray(getCards()) ? getCards() : [];
    const candidates = cards.filter(card => card && card.id !== cardId);
    const signature = `${cardId}\u0000${candidates.map(card => `${card.id}\u0000${card.title || ''}`).join('\u0001')}`;
    if (signature === lastTargetSignature && refTargetSelect.children.length > 0) {
      refTargetSelect.hidden = candidates.length === 0;
      return;
    }
    lastTargetSignature = signature;
    while (refTargetSelect.children?.length > 0) {
      refTargetSelect.removeChild(refTargetSelect.children[refTargetSelect.children.length - 1]);
    }
    while (!Array.isArray(refTargetSelect.children) && refTargetSelect.firstChild) {
      refTargetSelect.removeChild(refTargetSelect.firstChild);
    }
    const placeholder = ownerDoc.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '引用到…';
    refTargetSelect.appendChild(placeholder);
    for (const candidate of candidates) {
      const option = ownerDoc.createElement('option');
      option.value = candidate.id;
      option.textContent = candidate.title || candidate.id;
      refTargetSelect.appendChild(option);
    }
    refTargetSelect.hidden = candidates.length === 0;
  }

  // 浮层贴在选区上沿，横向别跑出窗口
  function position(targetRect) {
    if (!popover || !targetRect) return;
    const ownerDoc = doc();
    const view = ownerDoc?.defaultView || null;
    const viewportWidth = Number(view?.innerWidth) || 0;
    const viewportHeight = Number(view?.innerHeight) || 0;
    let left = targetRect.left + (targetRect.width || 0) / 2 - POPOVER_WIDTH / 2;
    let top = targetRect.top - POPOVER_OFFSET - 28;
    left = Math.max(4, left);
    if (viewportWidth > 0) left = Math.min(left, Math.max(4, viewportWidth - POPOVER_WIDTH - 4));
    top = Math.max(4, top);
    if (viewportHeight > 0) top = Math.min(top, Math.max(4, viewportHeight - 36));
    popover.style.top = `${Math.round(top)}px`;
    popover.style.left = `${Math.round(left)}px`;
  }

  function inspect(event) {
    if (disposed || getIsDisposed()) return;
    // 浮层内部（尤其原生 select）自己的 mouseup 不算外部选区变化
    if (event && insidePopover(event.target)) return;
    if (popoverHasFocus()) return;
    if (!canMutateCanvas()) {
      hide();
      return;
    }
    const ownerDoc = doc();
    const selection = ownerDoc?.getSelection?.();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      hide();
      return;
    }
    const range = selection.getRangeAt(0);
    const { bubble, sameBubble } = resolveSelectionBubble(range);
    const verdict = validateSelection({
      text: selection.toString(),
      insideAssistant: isAssistantBubble(bubble),
      sameBubble,
      hasKatex: selectionContainsMath(range),
    });
    if (!verdict.ok) {
      hide();
      // 这些理由只在用户明显尝试过选取时值得说，空白选区不打扰
      if (verdict.reason !== 'EMPTY' && verdict.reason !== 'MULTI_BUBBLE') notify(verdict.message);
      return;
    }
    const cardId = findCardIdFromNode(bubble);
    if (!cardId) {
      hide();
      return;
    }
    const cards = Array.isArray(getCards()) ? getCards() : [];
    const sourceCard = cards.find(item => item.id === cardId) || null;
    if (!sourceCard) {
      hide();
      return;
    }
    // 排除来源不开放自动摘取：否则从它划词就把被排除的内容又带回了上下文
    if (getContextMode(sourceCard) === 'exclude') {
      hide();
      notify(STALE_MESSAGES.SOURCE_EXCLUDED);
      return;
    }
    if (chainIsBusy(sourceCard)) {
      hide();
      notify(STALE_MESSAGES.BUSY);
      return;
    }
    const row = bubble?.closest?.('.msg-row') || null;
    const requestId = bubble?.id?.startsWith('reply-') ? bubble.id.slice('reply-'.length) : null;
    const resolved = resolveSourceMessage({
      card: sourceCard,
      messageIndex: readMessageIndex(row),
      requestId,
      quote: verdict.text,
    });
    if (!resolved.ok) {
      hide();
      notify('只能引用已经完成的那段回答');
      return;
    }
    // 记下代际与活对象：会话被换掉、卡片被重建、消息被删掉时，这个候选必须失效
    pending = {
      generation: getGeneration(),
      cardId,
      cardRef: sourceCard,
      messageRef: resolved.message,
      messageIndex: resolved.index,
      requestId: resolved.requestId,
      bodyNode: bubble || null,
      bodyVersion: resolved.body,
      // quoteText 是执行前重验用的唯一字段；text 只是对外读数的兼容别名
      quoteText: verdict.text,
      text: verdict.text,
    };
    const panel = ensurePopover();
    if (!panel) return;
    refreshTargetOptions(cardId);
    position(range.getBoundingClientRect?.());
    panel.hidden = false;
  }

  /**
   * 执行前重验：代际、卡片成员身份、消息身份、正文版本、DOM、策略都要一致。
   * 不一致就整条丢弃，不试图修补。
   */
  function revalidate(entry) {
    if (!entry) return { ok: false, reason: 'STALE' };
    if (disposed || getIsDisposed()) return { ok: false, reason: 'DISPOSED' };
    if (entry.generation !== getGeneration()) return { ok: false, reason: 'STALE' };
    if (!canMutateCanvas()) return { ok: false, reason: 'BUSY' };
    const cards = getCards();
    const card = Array.isArray(cards) ? cards.find(item => item.id === entry.cardId) : null;
    if (!card || card !== entry.cardRef) return { ok: false, reason: 'STALE' };
    if (getContextMode(card) === 'exclude') return { ok: false, reason: 'SOURCE_EXCLUDED' };
    if (chainIsBusy(card)) return { ok: false, reason: 'BUSY' };
    const checked = verifyMessageCandidate({ card, candidate: entry });
    if (!checked.ok) return { ok: false, reason: 'STALE' };
    return { ok: true, card, message: checked.message };
  }

  function clearSelection() {
    try {
      doc()?.getSelection?.()?.removeAllRanges?.();
    } catch {
      // 选区清不掉不影响已经做出的动作
    }
  }

  // 引用落到「当前选中的那张卡」上，来源就是划词所在的卡
  function commitReference(explicitOwnerId) {
    if (disposed || !pending) return;
    const entry = pending;
    const verdict = revalidate(entry);
    const ownerId = explicitOwnerId || (typeof getSelectedCardId === 'function' ? getSelectedCardId() : null);
    hide();
    clearSelection();
    if (!verdict.ok) {
      notify(STALE_MESSAGES[verdict.reason] || STALE_MESSAGES.STALE);
      return;
    }
    if (!hasReferenceEntry()) {
      notify('引用功能没有接上');
      return;
    }
    if (!ownerId) {
      notify('先在画布上点选一张卡片，引用会加到那张卡上');
      return;
    }
    if (ownerId === entry.cardId) {
      notify('不能把一张卡的内容引用到它自己身上');
      return;
    }
    const cards = Array.isArray(getCards()) ? getCards() : [];
    const targetCard = cards.find(card => card.id === ownerId) || null;
    if (!targetCard) {
      notify('目标卡片已经不在了');
      return;
    }
    let result;
    try {
      result = typeof onReference === 'function'
        ? onReference({
          sourceCard: verdict.card,
          targetCard,
          quoteText: entry.quoteText,
          generation: entry.generation,
        })
        : addContextRef(ownerId, { sourceCard: verdict.card, text: entry.quoteText });
    } catch (error) {
      notify(`引用没能加上：${error?.message || error}`);
      return;
    }
    if (result?.ok) {
      notify(`已引用 ${selectionByteLength(entry.quoteText)} 字节原文`);
      return;
    }
    if (result?.reason === 'TOO_MANY') notify('这张卡的引用已达上限，先删掉几条再加');
    else if (result?.reason === 'SELF_REFERENCE') notify('不能把一张卡的内容引用到它自己身上');
    else if (result?.reason === 'ID_EXHAUSTED') notify('引用编号用满了，先清理一些旧引用');
    else notify(result?.message || '这条引用没能加上');
  }

  function commit() {
    if (disposed || !pending) return;
    const entry = pending;
    const verdict = revalidate(entry);
    hide();
    clearSelection();
    if (!verdict.ok) {
      notify(STALE_MESSAGES[verdict.reason] || STALE_MESSAGES.STALE);
      return;
    }
    const created = createBranchCard(verdict.card, {
      initialDraft: buildBranchDraft({ cardTitle: verdict.card.title, text: entry.quoteText }),
    });
    if (!created) notify('这条分支没能创建，父卡片可能正在生成或已被删除');
  }

  /** 所有监听都走注入的 listen，签名 (target, type, handler, options) => cleanup */
  function bind(target, type, handler, options) {
    if (!target) return;
    let cleanup = null;
    try {
      cleanup = listen(target, type, handler, options);
    } catch {
      cleanup = null;
    }
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    else cleanups.push(() => target.removeEventListener?.(type, handler, options));
  }

  return {
    attach() {
      // 只接一次：重绘十次也不该有十份 document 监听
      if (attached || disposed) return;
      const ownerDoc = doc();
      if (!ownerDoc) return;
      attached = true;
      bind(ownerDoc, 'mouseup', inspect);
      bind(ownerDoc, 'selectionchange', () => {
        if (popoverHasFocus()) return;
        const selection = ownerDoc.getSelection?.();
        if (!selection || selection.isCollapsed) hide();
      });
      bind(ownerDoc, 'keydown', event => {
        if (event.key === 'Escape') hide();
      });
      bind(ownerDoc, 'mousedown', event => {
        if (insidePopover(event.target)) return;
        hide();
      });
      const win = ownerDoc.defaultView || null;
      bind(win, 'scroll', () => hide(), { passive: true, capture: true });
      bind(win, 'resize', () => hide());
    },
    inspect,
    hide,
    /** reset 是 hide 的明确别名：重绘 / 切会话前显式调用，不靠下一次点击才发现 DOM 过期 */
    reset: hide,
    commit,
    commitReference,
    getPending: () => (pending ? { ...pending } : null),
    isAttached: () => attached,
    dispose() {
      if (disposed) return;
      disposed = true;
      hide();
      while (cleanups.length) {
        try { cleanups.pop()(); } catch { /* 清理失败不影响其余监听 */ }
      }
      attached = false;
    },
  };
}

/** 旧名字保留：外面按这个 import 的地方不用改 */
export const createSelectionBranchController = createSelectionController;
