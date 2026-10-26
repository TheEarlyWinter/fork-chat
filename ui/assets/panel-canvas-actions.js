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
import { assertFunction, assertFunctions, assertOptionalFunctions, assertObject, assertMethod, assertCardsArray } from './panel-contracts.js';
import { findDeletionReferenceConflicts } from './fork-context-policy.js';

/** 会话尾号辅助函数：同名会话靠这个区分 */
function shortId(id) {
  const text = String(id || '');
  return text.length > 8 ? text.slice(-6) : text;
}

export function createCanvasActions(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createCanvasActions: deps must be an object');
  }

  assertFunctions(deps, [
    'getCards', 'setCards', 'getSelectedCardId', 'setSelectedCardId',
    'canMutateCanvas', 'chainIsBusy', 'abortActiveRequest', 'abortDocumentTasksFor',
    'calculateBranchYPositions', 'renderCards', 'scheduleSave', 'recordSnapshot',
    'extractDocumentFile', 'initialSnapshot'
  ], 'createCanvasActions');

  const hasGetSessionController = typeof deps.getSessionController === 'function';
  const hasLegacySessionController = deps.sessionController && (typeof deps.sessionController === 'object' || typeof deps.sessionController === 'function');
  if (!hasGetSessionController && !hasLegacySessionController) {
    throw new TypeError('createCanvasActions: requires either getSessionController function or sessionController object');
  }

  assertOptionalFunctions(deps, [
    'uniqueId', 'getSessionController', 'isBusy', 'isModalOpen', 'selectCard', 'ensureCardInView',
    'focusCardInViewport', 'flashMessage', 'isDisposed'
  ], 'createCanvasActions');

  if (deps.multiSelectedCardIds != null) {
    assertObject(deps.multiSelectedCardIds, 'multiSelectedCardIds', 'createCanvasActions');
    assertMethod(deps.multiSelectedCardIds, 'delete', 'createCanvasActions');
  }

  const {
    getCards,
    setCards,
    getSelectedCardId,
    setSelectedCardId,
    multiSelectedCardIds,
    canMutateCanvas,
    chainIsBusy,
    isBusy,
    isModalOpen,
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
    extractDocumentFile,
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
    const currentCards = assertCardsArray(getCards(), 'canvas-actions:createRootCard');
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
    // 网格是固定跨度，第四张起就排到视口外了；新建后把视图带过去，
    // 否则用户点了按钮却看不见卡片，以为没生效。
    focusCardInViewport?.(newRoot);
    scheduleSave?.();
    recordSnapshot?.(currentCards, newRoot.id);
    return newRoot;
  }

  // 从指定卡片拉出子分支卡片
  function createBranchCard(card, { autoFocus = true, initialDraft = '' } = {}) {
    if (checkDisposed()) return null;
    const currentCards = assertCardsArray(getCards(), 'canvas-actions:createBranchCard');
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
    // 带过来的草稿跟着卡片一起落盘；赋值在重绘之前，首绘就能显示
    if (initialDraft) newCard.draft = String(initialDraft);

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

    let currentCards = assertCardsArray(getCards(), 'canvas-actions:closeCardHierarchy');
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

    // 删掉一张被排除的来源，会让别处指向它的引用重新入模。
    // 这种连锁必须挡在改动之前：先让用户移除引用，或显式把来源放回。
    const conflicts = findDeletionReferenceConflicts({ cards: currentCards, deletingIds: idsToDelete });
    if (conflicts.length > 0) {
      const owners = Array.from(new Set(conflicts.map(item => item.ownerCardId)));
      flashMessage?.(`这 ${conflicts.length} 条引用指向被排除的来源，删掉后它们会重新参与上下文。请先移除引用或把来源改回提供上下文（涉及卡片：${owners.join('、')}）`);
      return;
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
    // 宿主导入没有可归属的画布会话时立刻拒绝：不自动建会话、不切目标，
    // 也不在内存里留一张没人保存的孤卡（否则 flush 失败就会静默丢失）。
    const sessionCtrl = typeof getSessionController === 'function' ? getSessionController() : sessionController;
    if (!sessionCtrl?.state?.activeId) {
      flashMessage?.('请先新建画布会话，再导入本体内容。');
      return null;
    }
    const currentCards = assertCardsArray(getCards(), 'canvas-actions:createBridgeDocCard');

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

  // 创建文档资料基座卡片
  async function createDocumentCard(file, targetCoord = null) {
    if (checkDisposed()) return null;
    if (canMutateCanvas && !canMutateCanvas()) return null;
    if (!file) return null;
    const sessionCtrl = typeof getSessionController === 'function' ? getSessionController() : sessionController;
    if (sessionCtrl && !sessionCtrl.state?.activeId) {
      const snapshot = typeof initialSnapshot === 'function' ? initialSnapshot() : null;
      await sessionCtrl.newSession(snapshot);
    }
    if ((canMutateCanvas && !canMutateCanvas()) || !sessionCtrl?.state?.activeId) return null;
    const generation = sessionCtrl.generation;
    if (typeof extractDocumentFile !== 'function') return null;
    const result = await extractDocumentFile(file);
    if (checkDisposed()) return null;
    if ((canMutateCanvas && !canMutateCanvas(generation)) || result?.cancelled) return null;
    if (!result?.ok) {
      flashMessage?.(`《${result?.filename}》没读出来（${result?.stage || '未知'}阶段）：${result?.error}`);
      return null;
    }
    const currentCards = assertCardsArray(getCards(), 'canvas-actions:createDocumentCard');
    const rootCount = currentCards.filter(c => cardParentIds(c).length === 0).length + 1;
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

    currentCards.push(newCard);
    setCards(currentCards);
    renderCards();
    scheduleSave();
    selectCard?.(newCard.id, false);
    recordSnapshot(currentCards, newCard.id);
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
    createDocumentCard,
  };
}
