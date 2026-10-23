import { buildContextPlan, createPendingUserMessage } from './panel-context-plan.js';
import { contextByteLength } from './fork-context-policy.js';

/**
 * 「预览应用上下文」的展示层。
 *
 * 只读：不改卡片、不发请求、不写历史。展示的是**这次请求会带什么**，
 * 不是模型最终看到的完整提示词（宿主的系统提示词不在这里）。
 *
 * 待发送的问题与引擎共用 createPendingUserMessage：草稿、暂存附件、
 * 空输入判断只有一处定义，预览和真实请求才不会各说各话。
 *
 * DOM 全部从 deps 注入，模块顶层不碰 document。
 */
export function createContextPreview(deps = {}) {
  for (const key of ['getDocument', 'getCards']) {
    if (typeof deps[key] !== 'function') throw new TypeError(`createContextPreview 缺少依赖：${key}`);
  }
  const { getDocument, getCards, getGeneration = () => null, reportIssue = null } = deps;

  let overlay = null;
  let bodyHost = null;
  let titleNode = null;
  let current = null;
  let cleanups = [];
  let disposed = false;

  function doc() {
    return getDocument();
  }

  function notify(message) {
    if (!message || typeof reportIssue !== 'function') return;
    try {
      reportIssue(message);
    } catch {
      // 提示失败不影响预览本身
    }
  }

  function el(tag, className, text) {
    const node = doc().createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function section(title, rows) {
    const wrap = el('section', 'ctx-preview-section');
    wrap.appendChild(el('h3', 'ctx-preview-heading', title));
    if (!rows.length) {
      wrap.appendChild(el('p', 'ctx-preview-empty', '（无）'));
      return wrap;
    }
    const list = el('ul', 'ctx-preview-list');
    for (const row of rows) list.appendChild(el('li', null, row));
    wrap.appendChild(list);
    return wrap;
  }

  function releaseListeners() {
    while (cleanups.length) {
      try { cleanups.pop()(); } catch { /* 单个清理失败不阻断其余 */ }
    }
  }

  /** 清空子节点：合成 DOM 只有 children 数组，真实 DOM 只有 firstChild，两种都要能清 */
  function clearChildren(node) {
    if (!node) return;
    if (Array.isArray(node.children)) {
      while (node.children.length > 0) {
        node.removeChild(node.children[node.children.length - 1]);
      }
      return;
    }
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function close() {
    releaseListeners();
    if (overlay?.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    bodyHost = null;
    titleNode = null;
    current = null;
  }

  /** 预览要复现「这次真的会发什么」：草稿和暂存附件都算进去 */
  function readPending(card) {
    const input = doc()?.getElementById?.(`input-${card.id}`);
    const rawText = input && typeof input.value === 'string' ? input.value : card.draft;
    const staged = Array.isArray(card.stagedAttachments) ? card.stagedAttachments : [];
    return createPendingUserMessage(typeof rawText === 'string' ? rawText : '', staged);
  }

  function bodyFor(card) {
    const cards = Array.isArray(getCards()) ? getCards() : [];
    const pendingMessage = readPending(card);
    const plan = buildContextPlan({ cards, targetCard: card, pendingUserMessage: pendingMessage ?? undefined });

    const body = el('div', 'ctx-preview-body');
    body.appendChild(el('p', 'ctx-preview-summary',
      `主链 ${plan.stats.mainlineCardCount} 个节点 · 引用 ${plan.stats.effectiveReferenceCount} 条`
      + ` · 引用前缀 ${plan.stats.referencePrefixBytes} 字节 · 消息体 ${plan.stats.wireBytes} 字节`));
    body.appendChild(el('p', 'ctx-preview-pending', pendingMessage
      ? `待发送：${pendingMessage.text.length > 80 ? `${pendingMessage.text.slice(0, 80)}…` : pendingMessage.text}`
      : '输入问题后可查看完整请求'));

    const mainlineRows = plan.sources
      .filter(source => source.kind === 'mainline')
      .map(source => `${source.title || source.cardId}${source.isTarget ? '（当前卡）' : ''} · ${source.cardId}`);
    body.appendChild(section('主链贡献', mainlineRows));

    const byId = new Map(cards.map(item => [item?.id, item]));
    body.appendChild(section('不向后续分支提供上下文', plan.excludedCardIds
      .map(id => `${byId.get(id)?.title || id} · ${id}`)));

    // 引用要连原文一起给看：只报字节数无法判断这段内容该不该带
    const referenceRows = plan.sources
      .filter(source => source.kind === 'reference')
      .map(source => {
        const owners = source.ownerCardIds
          .map(id => byId.get(id)?.title || id)
          .join('、');
        const state = source.sourceState === 'missing' ? ' · 来源已删除' : '';
        const excerpt = source.text.length > 120 ? `${source.text.slice(0, 120)}…` : source.text;
        return `${owners} →「${source.sourceTitle || source.sourceCardId}」 · `
          + `${source.ownerCardIds.length} 位持有者 · ${source.refIds.length} 条快照`
          + `${state} · ${contextByteLength(source.text)} 字节\n${excerpt}`;
      });
    body.appendChild(section('引用原文（本次采纳）', referenceRows));

    if (plan.warnings.length) {
      body.appendChild(section('提醒', plan.warnings.map(warning => warning.message)));
    }
    if (plan.errors.length) {
      body.appendChild(section('这次发不出去', plan.errors.map(error => error.message)));
    }
    body.appendChild(el('p', 'ctx-preview-note',
      '预览只描述本 App 构造的消息，不含宿主额外注入的系统提示词或供应商处理。'));
    return { body, plan };
  }

  function paint() {
    if (!overlay || !current || !bodyHost) return null;
    const { body, plan } = bodyFor(current.card);
    clearChildren(bodyHost);
    bodyHost.appendChild(body);
    return plan;
  }

  function bindLive(ownerDoc) {
    if (typeof ownerDoc.addEventListener !== 'function') return;
    const onInput = () => { refresh(); };
    ownerDoc.addEventListener('input', onInput, true);
    cleanups.push(() => ownerDoc.removeEventListener('input', onInput, true));
    ownerDoc.addEventListener('change', onInput, true);
    cleanups.push(() => ownerDoc.removeEventListener('change', onInput, true));
    const onKey = event => { if (event.key === 'Escape') close(); };
    ownerDoc.addEventListener('keydown', onKey);
    cleanups.push(() => ownerDoc.removeEventListener('keydown', onKey));
  }

  /**
   * 身份失效就关：卡片对象换了（重绘/切会话/恢复快照）或代际变了，
   * 继续展示旧卡的计划就是在骗人。
   */
  function identityValid() {
    if (!current) return false;
    if (disposed) return false;
    if (current.generation !== getGeneration()) return false;
    const cards = Array.isArray(getCards()) ? getCards() : [];
    return cards.find(card => card?.id === current.card.id) === current.card;
  }

  function refresh() {
    if (disposed || !overlay) return null;
    if (!identityValid()) {
      close();
      return null;
    }
    if (titleNode) titleNode.textContent = `上下文预览 · ${current.card.title || current.card.id}`;
    return paint();
  }

  return {
    /**
     * 打开某张卡的预览。返回这次算出的计划，方便调用方/测试核对。
     */
    show(card) {
      if (disposed || !card) return null;
      const ownerDoc = doc();
      if (!ownerDoc) return null;
      const cards = Array.isArray(getCards()) ? getCards() : [];
      if (cards.find(item => item?.id === card.id) !== card) {
        notify('这张卡片已经不在画布上了，没法预览它的上下文');
        return null;
      }
      close();
      current = { card, generation: getGeneration() };
      overlay = el('div', 'ctx-preview-overlay');
      const panel = el('div', 'ctx-preview-panel');
      const header = el('div', 'ctx-preview-header');
      titleNode = el('h2', 'ctx-preview-title', `上下文预览 · ${card.title || card.id}`);
      header.appendChild(titleNode);
      const actions = el('div', 'ctx-preview-actions');
      const refreshBtn = el('button', 'ctx-preview-refresh', '重算');
      refreshBtn.type = 'button';
      refreshBtn.addEventListener('click', event => {
        event.preventDefault();
        refresh();
      });
      actions.appendChild(refreshBtn);
      const closeBtn = el('button', 'ctx-preview-close', '×');
      closeBtn.type = 'button';
      closeBtn.addEventListener('click', event => {
        event.preventDefault();
        close();
      });
      actions.appendChild(closeBtn);
      header.appendChild(actions);
      panel.appendChild(header);
      bodyHost = el('div', 'ctx-preview-body-host');
      panel.appendChild(bodyHost);
      overlay.appendChild(panel);
      overlay.addEventListener('mousedown', event => {
        if (event.target === overlay) close();
      });
      bindLive(ownerDoc);
      ownerDoc.body.appendChild(overlay);
      return paint();
    },
    refresh,
    close,
    dispose() {
      if (disposed) return;
      disposed = true;
      close();
    },
    isOpen: () => Boolean(overlay),
  };
}
