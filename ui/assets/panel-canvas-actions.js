/**
 * 画布卡片结构修改与增删动作控制器模块
 *
 * 负责根卡片创建、分支卡片创建、来源资料卡导入去重、层级级联删除、
 * 以及删除卡片的有界（30张）快速引用留档；历史内容池负责可撤销内容的完整生命周期。
 * 严禁在顶层访问裸 window 或 document，不反向依赖 panel.js。
 */

import { rootSlotPosition, formatFileSize } from './panel-format.js';
import { cardParentIds, cardHasParent } from './panel-context.js';
import { outputFor } from './panel-messages.js';

/** 会话尾号辅助函数：同名会话靠这个区分 */
function shortId(id) {
  const text = String(id || '');
  return text.length > 8 ? text.slice(-6) : text;
}

export function createCanvasActions(deps) {
  const {
    getCards,
    setCards,
    getSelectedCardId,
    setSelectedCardId,
    multiSelectedCardIds,
    canMutateCanvas = () => true,
    chainIsBusy = () => false,
    isBusy = () => false,
    isModalOpen = () => false,
    abortActiveRequest,
    abortDocumentTasksFor,
    calculateBranchYPositions,
    renderCards,
    scheduleSave,
    recordSnapshot,
    selectCard,
    ensureCardInView,
    focusCardInViewport,
    flashMessage,
    getSessionController,
    sessionController,
    initialSnapshot,
    uniqueId = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    isDisposed,
  } = deps;

  const checkDisposed = () => (typeof isDisposed === 'function' ? isDisposed() : Boolean(isDisposed));

  /**
   * 最近被删除卡片的快速引用索引，不再复制正文。
   * 超过 30 张的同批删除仍由历史内容池完整保留；淘汰与释放由历史控制器协调。
   */
  const removedCardArchive = new Map();

  function rememberRemovedCard(card) {
    if (!card) return;
    removedCardArchive.set(card.id, card);
    while (removedCardArchive.size > 30) {
      removedCardArchive.delete(removedCardArchive.keys().next().value);
    }
  }

  function clearRemovedCardArchive() {
    removedCardArchive.clear();
  }

  // 新建主线根卡片
  async function createRootCard() {
    if (checkDisposed()) return null;
    if (canMutateCanvas && !canMutateCanvas()) return null;
    const sessionCtrl = typeof getSessionController === 'function' ? getSessionController() : sessionController;
    if (sessionCtrl && !sessionCtrl.state?.activeId) {
      const snapshot = typeof initialSnapshot === 'function' ? initialSnapshot() : null;
      await sessionCtrl.newSession(snapshot);
      return null;
    }
    const currentCards = getCards ? getCards() : [];
    const rootCount = currentCards.filter(c => cardParentIds(c).length === 0).length + 1;
    const newRoot = {
      id: uniqueId('card'),
      parentId: null,
      title: `主线对话 #${rootCount.toString().padStart(2, '0')}`,
      ...rootSlotPosition(rootCount),
      width: 340,
      messages: [
        { role: 'assistant', localOnly: true, text: '全新主线节点已创建。在下方输入问题开启推导。' }
      ]
    };
    currentCards.push(newRoot);
    if (setCards) setCards(currentCards);
    renderCards?.();
    scheduleSave?.();
    recordSnapshot?.(currentCards, newRoot.id);
    return newRoot;
  }

  // 从指定卡片拉出子分支卡片
  function createBranchCard(card, { autoFocus = true } = {}) {
    if (checkDisposed()) return null;
    const currentCards = getCards ? getCards() : [];
    const parentCard = typeof card === 'string' ? currentCards.find(c => c.id === card) : (currentCards.find(c => c.id === card?.id) || card);
    if (!parentCard || (chainIsBusy && chainIsBusy(parentCard)) || !currentCards.includes(parentCard)) return null;

    const existingChildren = currentCards.filter(c => cardHasParent(c, parentCard.id));
    const branchIndex = existingChildren.length + 1;
    const newId = uniqueId('branch');

    const lastMessage = parentCard.messages?.filter(message => !message.failed && !message.localOnly && (!message.status || message.status === 'completed')).at(-1);
    const lastMsg = lastMessage ? outputFor(lastMessage).body.trim() || '父级卡片' : '父级卡片';
    const snippet = lastMsg.length > 20 ? lastMsg.slice(0, 20) + '...' : lastMsg;

    const targetX = parentCard.x + (parentCard.width || 340) + 120;
    const yPositions = calculateBranchYPositions ? calculateBranchYPositions(parentCard, 1, targetX) : [parentCard.y];

    const isDocParent = Boolean(parentCard.isDoc);
    const branchTitle = isDocParent
      ? `分析 #${branchIndex} (${parentCard.title.slice(0, 10)})`
      : `追问 #${branchIndex} (${parentCard.title.split(' ')[0]})`;

    const initText = isDocParent
      ? `【承袭前置资料】\n已承袭《${parentCard.title}》（${formatFileSize(parentCard.docMeta?.size || 0)}）作为推导背景。\n你可以在此提出专项分析问题，绝不污染源文档。`
      : `【承袭前置上下文】\n已从「${parentCard.title}」成功拉出新分支。\n前置结论锚点：“${snippet}”\n你可以在此提出分支问题，绝不污染父卡片。`;

    const newCard = {
      id: newId,
      parentId: parentCard.id,
      title: branchTitle,
      x: targetX,
      y: yPositions[0],
      width: 340,
      messages: [
        {
          role: 'assistant',
          localOnly: true,
          text: initText,
        }
      ]
    };

    currentCards.push(newCard);
    if (setCards) setCards(currentCards);
    renderCards?.();
    scheduleSave?.();
    recordSnapshot?.(currentCards, newCard.id);

    selectCard?.(newCard.id, autoFocus);
    ensureCardInView?.(newCard);

    return newCard;
  }

  // 级联关闭卡片及其所有派生子树
  function closeCardHierarchy(card) {
    if (checkDisposed()) return;
    if (typeof isBusy === 'function' && isBusy()) return;
    if (typeof isModalOpen === 'function' && isModalOpen()) return;

    let currentCards = getCards ? getCards() : [];
    const targetId = typeof card === 'string' ? card : card?.id;
    if (!targetId) return;
    const targetCard = currentCards.find(c => c.id === targetId);
    if (!targetCard) return;

    const idsToDelete = new Set([targetId]);
    let changed = true;
    while (changed) {
      changed = false;
      currentCards.forEach(c => {
        if (cardParentIds(c).some(parentId => idsToDelete.has(parentId)) && !idsToDelete.has(c.id)) {
          idsToDelete.add(c.id);
          changed = true;
        }
      });
    }

    for (const id of idsToDelete) {
      abortActiveRequest?.(id);
      abortDocumentTasksFor?.(id);
      // 被关掉的卡也要从多选集合里退出来，否则合并工具条会一直悬着点不动
      multiSelectedCardIds?.delete?.(id);
    }

    // 保留删除时的最新对象引用；历史池还持有同一份业务内容，布局快照不复制正文。
    for (const c of currentCards) {
      if (idsToDelete.has(c.id)) rememberRemovedCard(c);
    }

    currentCards = currentCards.filter(c => !idsToDelete.has(c.id));
    if (setCards) setCards(currentCards);

    const currentSelectedId = getSelectedCardId ? getSelectedCardId() : null;
    let nextSelectedId = currentSelectedId;
    if (currentSelectedId && idsToDelete.has(currentSelectedId)) {
      nextSelectedId = null;
      if (setSelectedCardId) setSelectedCardId(null);
    }

    renderCards?.();
    scheduleSave?.();
    recordSnapshot?.(currentCards, nextSelectedId);
  }

  // 导入成一张只读来源资料卡，并写下来源引用便于跳回与去重
  function createBridgeDocCard({ title, text, sourceRef, messageCount }) {
    if (checkDisposed()) return null;
    if (canMutateCanvas && !canMutateCanvas()) return null;
    const currentCards = getCards ? getCards() : [];

    // 去重只看内容与导入类型：同内容的快照生成两张一模一样的卡没有意义，
    // 即使两个来源会话标题相同也定位回已有卡片。
    const existing = currentCards.find((c) => c.sourceRef
      && c.sourceRef.contentHash
      && c.sourceRef.contentHash === sourceRef.contentHash
      && c.sourceRef.importKind === sourceRef.importKind);
    if (existing) {
      selectCard?.(existing.id, false);
      focusCardInViewport?.(existing);
      const sameSession = existing.sourceRef.sessionId === sourceRef.sessionId;
      flashMessage?.(sameSession
        ? '这段内容已经导入过了，已定位到原卡片。'
        : `这段内容已作为《${existing.title}》导入过（来源是另一个会话 ${shortId(existing.sourceRef.sessionId)}），没重复建卡。`);
      return existing;
    }

    let posX = 80;
    let posY = 100;
    if (currentCards.length > 0) {
      const maxY = Math.max(...currentCards.map((c) => c.y));
      posY = maxY + 420;
    }

    const newCard = {
      id: uniqueId('doc'),
      parentId: null,
      title,
      isDoc: true,
      docContent: text,
      sourceRef,
      docMeta: { name: title, size: text.length, extension: '.md', charCount: text.length, lineCount: text.split('\n').length },
      x: posX,
      y: posY,
      width: 360,
      messages: [{
        role: 'assistant',
        localOnly: true,
        text: `【本体导入快照】已从本体会话《${title}》导入 ${messageCount} 条正文（${text.length} 字）。\n\n这是只读摘录，不会随原会话变化。点上方徽标可跳回原会话。`,
        docPreview: text.length > 50000 ? text.slice(0, 50000) : text,
        docMeta: { name: title, size: text.length, lineCount: text.split('\n').length, charCount: text.length },
      }],
    };
    currentCards.push(newCard);
    if (setCards) setCards(currentCards);
    renderCards?.();
    scheduleSave?.();
    selectCard?.(newCard.id, false);
    focusCardInViewport?.(newCard);
    recordSnapshot?.(currentCards, newCard.id);
    return newCard;
  }

  return {
    rememberRemovedCard,
    removedCardArchive,
    clearRemovedCardArchive,
    createRootCard,
    createBranchCard,
    closeCardHierarchy,
    createBridgeDocCard,
  };
}
