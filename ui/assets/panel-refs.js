import { normalizeContextRefs, MAX_REFS_PER_CARD, contextByteLength } from './fork-context-policy.js';

/**
 * 引用的增删与管理面板。
 *
 * 引用是**捕获时的原文快照**：加进去之后就不随来源标题或正文变化而自动刷新。
 * 它不成为父边，也不递归来源自己的引用——这两件事交给编译器保证，这里只管维护数据。
 *
 * 所有写操作都先过 normalizeContextRefs：越限、自引用、重复 id 当场拒绝，
 * 不修改活对象，也不留半成品。
 */
export function createRefController(deps = {}) {
  for (const key of [
    'getCards', 'renderCards', 'scheduleSave', 'recordSnapshot', 'getRetainedReferenceIds',
    'getGeneration', 'canMutateCanvas', 'getIsDisposed'
  ]) {
    if (typeof deps[key] !== 'function') throw new TypeError(`createRefController 缺少依赖或非函数：${key}`);
  }
  const {
    getCards,
    getRetainedReferenceIds,
    renderCards,
    renderConnectors,
    scheduleSave,
    recordSnapshot,
    flashMessage = () => {},
    getDocument,
    getGeneration,
    canMutateCanvas,
    getIsDisposed,
  } = deps;

  let overlay = null;
  let cleanups = [];

  function newRefId() {
    // 避开仍然可达的 id：历史、内容池、删除留档里出现过的都不能复用
    const taken = getRetainedReferenceIds();
    if (!(taken instanceof Set)) {
      throw new TypeError('createRefController: getRetainedReferenceIds 必须返回 Set 实例');
    }
    for (let i = 0; i < 8; i += 1) {
      const candidate = `ref_${Math.random().toString(36).slice(2, 10)}`;
      if (!taken.has(candidate)) return candidate;
    }
    return null;
  }

  function commit(owner, refs) {
    if (refs && refs.length) owner.contextRefs = refs;
    else delete owner.contextRefs;
    renderCards();
    renderConnectors?.();
    scheduleSave();
    recordSnapshot(getCards(), owner.id);
  }

  return {
    /**
     * 把一段原文加进某张卡的引用列表。
     * @returns {{ok: boolean, reason?: string, ref?: object}}
     */
    addRef(ownerId, { sourceCard, text } = {}) {
      if (getIsDisposed()) return { ok: false, reason: 'DISPOSED' };
      if (!canMutateCanvas()) {
        return { ok: false, reason: 'CANNOT_MUTATE', message: '画布当前不可修改' };
      }
      const cards = getCards();
      if (!Array.isArray(cards)) return { ok: false, reason: 'CARDS_INVALID' };
      const owner = cards.find(card => card.id === ownerId);
      if (!owner) return { ok: false, reason: 'OWNER_MISSING' };
      if (!sourceCard || !sourceCard.id) return { ok: false, reason: 'SOURCE_MISSING' };

      // 核实 sourceCard 必须是当前 cards 中同 ID 的活对象实例，防止使用快照或旧 session 对象绕过 live source 的 exclude 设置
      const liveSourceCard = cards.find(card => card.id === sourceCard.id);
      if (!liveSourceCard || liveSourceCard !== sourceCard) {
        return { ok: false, reason: 'SOURCE_STALE', message: '来源卡片不是当前活跃卡片活对象' };
      }

      if (liveSourceCard.id === owner.id) return { ok: false, reason: 'SELF_REFERENCE' };
      // 来源门禁：来源被设为 exclude 时不可引用
      if (liveSourceCard.contextMode === 'exclude') {
        return { ok: false, reason: 'SOURCE_EXCLUDED', message: '来源已被设为不提供上下文，不可引用' };
      }
      const existing = Array.isArray(owner.contextRefs) ? owner.contextRefs : [];
      if (existing.length >= MAX_REFS_PER_CARD) return { ok: false, reason: 'TOO_MANY' };
      const id = newRefId();
      if (!id) return { ok: false, reason: 'ID_EXHAUSTED' };
      const candidate = {
        id,
        sourceCardId: liveSourceCard.id,
        sourceTitle: liveSourceCard.title || '',
        text: String(text || ''),
      };
      let refs;
      try {
        const rawNormalized = normalizeContextRefs([...existing, candidate], { ownerCardId: owner.id });
        // 保持 refs 数组+条目不可变 (freeze 新数组与条目，不改旧 live)
        refs = Object.freeze(rawNormalized.map(r => Object.freeze({ ...r })));
      } catch (err) {
        return { ok: false, reason: 'INVALID', message: err.message };
      }
      commit(owner, refs);
      return { ok: true, ref: refs[refs.length - 1] };
    },

    removeRef(ownerId, refId) {
      if (getIsDisposed()) return false;
      if (!canMutateCanvas()) return false;
      const cards = getCards();
      const owner = Array.isArray(cards) ? cards.find(card => card.id === ownerId) : null;
      if (!owner) return false;
      const existing = Array.isArray(owner.contextRefs) ? owner.contextRefs : [];
      const nextRaw = existing.filter(ref => ref.id !== refId);
      if (nextRaw.length === existing.length) return false;
      // 保持 refs 数组+条目不可变 (freeze 新数组与条目，不改旧 live)
      const next = Object.freeze(nextRaw.map(r => Object.freeze({ ...r })));
      commit(owner, next);
      return true;
    },

    /** 管理面板：列出本卡引用，可逐条删除 */
    showManager(ownerCard) {
      const ownerDoc = typeof getDocument === 'function' ? getDocument() : null;
      if (!ownerDoc || !ownerCard) return;
      // 面板开着的时候会话可能被换掉：记下当时那张卡和代际，过期就不许再写
      const capturedCard = ownerCard;
      const capturedGeneration = getGeneration();
      const stillValid = () => {
        if (getIsDisposed()) return false;
        if (typeof canMutateCanvas === 'function' && !canMutateCanvas()) return false;
        if (capturedGeneration !== getGeneration()) return false;
        const list = getCards();
        return Array.isArray(list) && list.find(card => card.id === capturedCard.id) === capturedCard;
      };
      this.closeManager();
      const el = (tag, className, text) => {
        const node = ownerDoc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      };
      overlay = el('div', 'ctx-preview-overlay');
      const panel = el('div', 'ctx-preview-panel');
      const header = el('div', 'ctx-preview-header');
      header.appendChild(el('h2', 'ctx-preview-title', `引用管理 · ${ownerCard.title || ownerCard.id}`));
      const closeBtn = el('button', 'ctx-preview-close', '×');
      closeBtn.type = 'button';
      closeBtn.addEventListener('click', () => this.closeManager());
      header.appendChild(closeBtn);
      panel.appendChild(header);

      const body = el('div', 'ctx-preview-body');
      const refs = Array.isArray(ownerCard.contextRefs) ? ownerCard.contextRefs : [];
      if (!refs.length) {
        body.appendChild(el('p', 'ctx-preview-empty', '这张卡还没有引用任何原文。在别的卡正文里划词，选「引用到当前卡片」即可添加。'));
      } else {
        for (const ref of refs) {
          const row = el('div', 'ctx-ref-row');
          const info = el('div', 'ctx-ref-info');
          info.appendChild(el('div', 'ctx-ref-source', `来源：${ref.sourceTitle || ref.sourceCardId}`));
          info.appendChild(el('div', 'ctx-ref-text', ref.text.slice(0, 120) + (ref.text.length > 120 ? '…' : '')));
          info.appendChild(el('div', 'ctx-ref-meta', `${contextByteLength(ref.text)} 字节`));
          row.appendChild(info);
          const del = el('button', 'ctx-ref-remove', '删除');
          del.type = 'button';
          del.addEventListener('click', () => {
            if (!stillValid()) {
              flashMessage('这张卡已经换过了，旧面板不能再改它');
              this.closeManager();
              return;
            }
            const done = this.removeRef(ownerCard.id, ref.id);
            if (done) this.showManager(ownerCard);
            else flashMessage('这条引用没能删除');
          });
          row.appendChild(del);
          body.appendChild(row);
        }
      }
      panel.appendChild(body);
      overlay.appendChild(panel);
      overlay.addEventListener('mousedown', event => {
        if (event.target === overlay) this.closeManager();
      });
      const onKey = event => { if (event.key === 'Escape') this.closeManager(); };
      ownerDoc.addEventListener('keydown', onKey);
      cleanups.push(() => ownerDoc.removeEventListener('keydown', onKey));
      ownerDoc.body.appendChild(overlay);
    },

    closeManager() {
      while (cleanups.length) {
        try { cleanups.pop()(); } catch {}
      }
      if (overlay?.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null;
    },

    dispose() {
      this.closeManager();
    },
  };
}
