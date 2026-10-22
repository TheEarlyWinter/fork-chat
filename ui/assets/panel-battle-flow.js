import { bindBattleDialogController, buildBattleBranchCards } from './panel-battle.js';

/**
 * 对比推导（Battle）的业务编排。
 *
 * 这里只负责「开弹窗、收选择、按选择并发拉出几条分支」，
 * 弹窗本身的渲染与校验仍在 panel-battle.js，发送在 panel-chat-engine.js。
 */
export function createBattleFlow(deps) {
  const {
    battleDialog, battlePromptInput, battleAgentsList, battleSelectedCount,
    battleDialogError, btnBattleClose, btnBattleCancel, btnBattleSubmit, btnUseLastPrompt,
    listen, documentRef,
    getAgentReasoningEffort, getAvailableAgents, loadAvailableAgents,
    chainIsBusy, getCards, getSession, getIsDisposed, canMutateCanvas,
    cardHasParent, calculateBranchYPositions, fitViewportToCluster,
    renderCards, scheduleSave, recordSnapshot, getSelectedCardId,
    sendCardPrompt, uniqueId,
    cleanups,
  } = deps;

  const controller = bindBattleDialogController({
    dialog: battleDialog,
    promptInput: battlePromptInput,
    agentsList: battleAgentsList,
    selectedCountEl: battleSelectedCount,
    errorEl: battleDialogError,
    btnClose: btnBattleClose,
    btnCancel: btnBattleCancel,
    btnSubmit: btnBattleSubmit,
    btnUseLastPrompt,
    // 这里要的是「真的去拉列表」那个函数，不是「读缓存」。
    // 传错弹窗就一直空着，用户选不了人，提交被校验挡下。
    loadAgents: loadAvailableAgents,
    getReasoningEffort: getAgentReasoningEffort,
    onSubmit: ({ targetCard, prompt, selectedAgentIds }) => {
      const agents = (getAvailableAgents() || []).filter(a => selectedAgentIds.has(a.id));
      const cards = getCards() || [];
      if (targetCard && cards.includes(targetCard)) {
        void runBattleBranches(targetCard, prompt, agents);
      }
    },
    listen: (target, type, handler, options) => listen(target, type, handler, options, cleanups),
    documentRef,
  });

  function closeBattleDialog() {
    controller.close();
  }

  async function openBattleDialog(card, initialPromptText = '') {
    if (getIsDisposed() || chainIsBusy(card) || !(getCards() || []).includes(card)) return;
    const generation = getSession().generation;
    await controller.open(card, initialPromptText);
    if (!canMutateCanvas(generation) || !(getCards() || []).includes(card)) {
      controller.close();
    }
  }

  async function runBattleBranches(parentCard, prompt, selectedAgents) {
    const cards = getCards() || [];
    if (!parentCard || !cards.includes(parentCard) || chainIsBusy(parentCard)) return;
    const existingChildren = cards.filter(c => cardHasParent(c, parentCard.id));
    const startBranchIndex = existingChildren.length + 1;
    const total = selectedAgents.length;
    const targetX = parentCard.x + (parentCard.width || 340) + 120;
    const yPositions = calculateBranchYPositions(parentCard, total, targetX);

    const newCards = buildBattleBranchCards({
      parentCard,
      selectedAgents,
      startBranchIndex,
      targetX,
      yPositions,
      getReasoningEffort: getAgentReasoningEffort,
      uniqueId,
    });

    cards.push(...newCards);
    renderCards();
    scheduleSave();
    recordSnapshot(cards, getSelectedCardId());

    if (newCards.length > 0) {
      fitViewportToCluster([parentCard, ...newCards]);
    }

    // 每条分支各发各的，一条失败不影响其它几条
    const sendPromises = newCards.map((childCard, i) => {
      const agent = selectedAgents[i];
      const effort = getAgentReasoningEffort(agent.id);
      return sendCardPrompt(childCard, prompt, { agent, reasoningEffort: effort });
    });

    await Promise.allSettled(sendPromises);
  }

  return { closeBattleDialog, openBattleDialog, runBattleBranches, controller };
}
