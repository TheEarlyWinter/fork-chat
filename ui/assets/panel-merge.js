import { assertFunction, assertFunctions, assertOptionalFunctions, assertObject, assertCardsArray } from './panel-contracts.js';

/**
 * 多选与合流控制器 (Merge Controller)
 *
 * 负责画布卡片的多选状态管理、合流工具栏交互、合流提示词合成与合流总结卡片生成。
 * 严禁在顶层访问 window / document / localStorage，所有 DOM 与跨模块依赖均由 deps 注入。
 */

export function createMergeController(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createMergeController: deps must be an object');
  }

  assertFunctions(deps, [
    'getCards', 'getSelectedCardId', 'canMutateCanvas', 'chainIsBusy',
    'calculateBranchYPositions', 'fitViewportToCluster', 'renderCards',
    'scheduleSave', 'recordSnapshot', 'sendCardPrompt'
  ], 'createMergeController');

  assertObject(deps.multiSelectedCardIds, 'multiSelectedCardIds', 'createMergeController');
  if (
    typeof deps.multiSelectedCardIds.has !== 'function' ||
    typeof deps.multiSelectedCardIds.add !== 'function' ||
    typeof deps.multiSelectedCardIds.delete !== 'function' ||
    typeof deps.multiSelectedCardIds.clear !== 'function'
  ) {
    throw new TypeError('createMergeController: multiSelectedCardIds must be a Set-like object with has, add, delete, clear');
  }

  assertOptionalFunctions(deps, ['isDisposed', 'listen', 'uniqueId', 'outputFor'], 'createMergeController');

  const {
    multiSelectedCardIds,
    getCards,
    getSelectedCardId,
    canMutateCanvas,
    isDisposed = () => false,
    chainIsBusy,
    calculateBranchYPositions,
    fitViewportToCluster,
    renderCards,
    scheduleSave,
    recordSnapshot,
    sendCardPrompt,
    uniqueId = prefix => `${prefix}_${Date.now()}`,
    outputFor = msg => ({ body: msg?.text || '' }),
    documentRef,
    mergeToolbar,
    mergeCountText,
    btnMergeCancel,
    btnMergeSubmit,
    listen,
    cleanups,
  } = deps;

  function toggleMultiSelectCard(cardId) {
    if (!canMutateCanvas()) return;
    if (multiSelectedCardIds.has(cardId)) {
      multiSelectedCardIds.delete(cardId);
    } else {
      const selectedId = getSelectedCardId();
      if (multiSelectedCardIds.size === 0 && selectedId && selectedId !== cardId) {
        multiSelectedCardIds.add(selectedId);
      }
      multiSelectedCardIds.add(cardId);
    }
    updateMultiSelectionUI();
  }

  function clearMultiSelect() {
    const disposed = typeof isDisposed === 'function' ? isDisposed() : Boolean(isDisposed);
    if (disposed) return;
    if (multiSelectedCardIds.size === 0) return;
    multiSelectedCardIds.clear();
    updateMultiSelectionUI();
  }

  function updateMultiSelectionUI() {
    const cards = assertCardsArray(getCards(), 'merge:updateMultiSelectionUI');
    cards.forEach(c => {
      const el = documentRef?.getElementById ? documentRef.getElementById(`dom-${c.id}`) : null;
      if (el) {
        if (multiSelectedCardIds.has(c.id)) {
          el.classList.add('is-multi-selected');
        } else {
          el.classList.remove('is-multi-selected');
        }
      }
    });

    const toolbar = typeof mergeToolbar === 'function' ? mergeToolbar() : mergeToolbar;
    const countText = typeof mergeCountText === 'function' ? mergeCountText() : mergeCountText;

    if (multiSelectedCardIds.size >= 2) {
      if (toolbar) toolbar.hidden = false;
      if (countText) countText.textContent = `已选 ${multiSelectedCardIds.size} 个分支`;
    } else {
      if (toolbar) toolbar.hidden = true;
    }
  }

  function synthesizeMergePrompt(selectedCards) {
    const branchSummaries = selectedCards.map((card, idx) => {
      const userMsg = card.messages.filter(m => m.role === 'user' && !m.failed).at(-1);
      const asstMsg = card.messages.filter(m => m.role === 'assistant' && !m.localOnly && !m.failed && (!m.status || m.status === 'completed')).at(-1);

      const questionText = userMsg?.content || userMsg?.text || '（沿用前置主题）';
      const answerText = asstMsg ? (outputFor(asstMsg).body.trim() || asstMsg.text) : '（尚无推导结论）';
      const truncatedAnswer = answerText.length > 600 ? answerText.slice(0, 600) + '… [已截断核心]' : answerText;

      return `### 分支 #${idx + 1}：${card.title}\n- **探讨问题**：${questionText}\n- **推导结论要点**：\n${truncatedAnswer}`;
    }).join('\n\n');

    return `你现在作为首席架构裁判与决策顾问，请对以下 ${selectedCards.length} 个独立探索分支的推导结论进行深度交叉对比与合流收敛：\n\n${branchSummaries}\n\n---\n【合流裁决任务】：\n1. **核心共识与关键分歧**：提炼各个分支方案的交集共识与核心分歧点；\n2. **适用边界与权衡代价 (Trade-offs)**：客观剖析各方案在性能、复杂度、可靠性及维护成本上的利弊得失；\n3. **终局综合决策方案**：给出最终的落地裁决意见与明确的执行路线。`;
  }

  async function createMergeCardFromSelected() {
    if (!canMutateCanvas()) return null;
    const cards = assertCardsArray(getCards(), 'merge:createMergeCardFromSelected');
    const selectedCards = cards.filter(c => multiSelectedCardIds.has(c.id));
    if (selectedCards.length < 2 || selectedCards.some(chainIsBusy)) return null;

    const maxX = Math.max(...selectedCards.map(c => c.x + (c.width || 340)));
    const targetX = maxX + 140;
    const avgY = Math.round(selectedCards.reduce((acc, c) => acc + c.y, 0) / selectedCards.length);
    const targetY = calculateBranchYPositions({ x: maxX, y: avgY, width: 0 }, 1, targetX)[0];

    const newId = uniqueId('merge_node');
    const sourceTitles = selectedCards.map(c => c.title.split(' ')[0]).join(' + ');

    const mergeCard = {
      id: newId,
      parentId: selectedCards[0].id,
      parentIds: selectedCards.map(c => c.id),
      isMerge: true,
      title: `合并总结 (${sourceTitles})`,
      x: targetX,
      y: targetY,
      width: 360,
      messages: [],
    };

    cards.push(mergeCard);
    clearMultiSelect();
    renderCards();
    scheduleSave();
    recordSnapshot(cards, mergeCard.id);

    fitViewportToCluster([...selectedCards, mergeCard]);

    const prompt = synthesizeMergePrompt(selectedCards);
    void sendCardPrompt(mergeCard, prompt);
    return mergeCard;
  }

  function bindToolbar(toolbarDeps = {}) {
    const cancelBtn = toolbarDeps.btnMergeCancel || (typeof btnMergeCancel === 'function' ? btnMergeCancel() : btnMergeCancel);
    const submitBtn = toolbarDeps.btnMergeSubmit || (typeof btnMergeSubmit === 'function' ? btnMergeSubmit() : btnMergeSubmit);
    const listenFn = toolbarDeps.listen || listen;
    const cleanupsList = toolbarDeps.cleanups || cleanups;

    if (cancelBtn && listenFn) {
      listenFn(cancelBtn, 'click', () => {
        clearMultiSelect();
      }, undefined, cleanupsList);
    }
    if (submitBtn && listenFn) {
      listenFn(submitBtn, 'click', () => {
        void createMergeCardFromSelected();
      }, undefined, cleanupsList);
    }
  }

  function getMultiSelectedIds() {
    return multiSelectedCardIds;
  }

  return {
    toggleMultiSelectCard,
    clearMultiSelect,
    updateMultiSelectionUI,
    synthesizeMergePrompt,
    createMergeCardFromSelected,
    bindToolbar,
    getMultiSelectedIds,
  };
}
