/**
 * panel-shortcuts.js
 * 画布键盘快捷键、方向键拓扑导航与手势模式分发器
 */

/**
 * 根据键盘方向键计算下一个需要聚焦的卡片
 * - ArrowRight: 导航至第一个子节点
 * - ArrowLeft: 导航至第一个父节点
 * - ArrowDown / ArrowUp: 导航至同级兄弟节点或同级根节点
 */
export function findCardByDirection({ cards, selectedCardId, direction, cardParentIds, cardHasParent }) {
  const current = cards.find(c => c.id === selectedCardId) || cards[0];
  if (!current) return null;

  const currentParents = cardParentIds(current);
  if (direction === 'ArrowRight') {
    const children = cards.filter(c => cardHasParent(c, current.id));
    if (children.length > 0) return children[0];
  } else if (direction === 'ArrowLeft') {
    if (currentParents.length > 0) {
      return cards.find(c => c.id === currentParents[0]) || null;
    }
  } else if (direction === 'ArrowDown' || direction === 'ArrowUp') {
    if (currentParents.length > 0) {
      const siblings = cards.filter(c => currentParents.some(parentId => cardHasParent(c, parentId)));
      const idx = siblings.findIndex(c => c.id === current.id);
      if (direction === 'ArrowDown' && idx !== -1 && idx < siblings.length - 1) return siblings[idx + 1];
      if (direction === 'ArrowUp' && idx > 0) return siblings[idx - 1];
    } else {
      const roots = cards.filter(c => cardParentIds(c).length === 0);
      const idx = roots.findIndex(c => c.id === current.id);
      if (direction === 'ArrowDown' && idx !== -1 && idx < roots.length - 1) return roots[idx + 1];
      if (direction === 'ArrowUp' && idx > 0) return roots[idx - 1];
    }
  }
  return null;
}

/**
 * 绑定全局键盘快捷键监听
 */
export function bindKeyboardShortcuts({ windowRef, documentRef, viewport, getState, actions }) {
  if (!windowRef) return () => {};

  const onKeyDown = (e) => {
    const isEditing = Boolean(
      documentRef?.activeElement && (
        documentRef.activeElement.tagName === 'INPUT' ||
        documentRef.activeElement.tagName === 'TEXTAREA' ||
        documentRef.activeElement.isContentEditable
      )
    );

    // 1. Space 抓手漫游模式
    if (e.code === 'Space' && !isEditing) {
      e.preventDefault();
      if (!getState().isSpacePressed) {
        actions.setSpacePressed(true);
        viewport?.classList.add('is-hand-tool');
      }
      return;
    }

    // 2. Tab 键快速开辟追问分支
    if (e.key === 'Tab' && !isEditing) {
      const { cards, selectedCardId } = getState();
      const currentCard = cards.find(c => c.id === selectedCardId);
      if (currentCard && !actions.chainIsBusy(currentCard)) {
        e.preventDefault();
        actions.createBranchCard(currentCard, { autoFocus: true });
        return;
      }
    }

    // 3. 方向键导航（非编辑状态）
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !isEditing) {
      e.preventDefault();
      actions.navigateCardFocus(e.key);
      return;
    }

    // 4. Escape 取消选中或关闭弹窗
    if (e.key === 'Escape') {
      const { battleDialogOpen, multiSelectedCount, selectedCardId } = getState();
      if (battleDialogOpen) {
        actions.closeBattleDialog();
        return;
      }
      if (multiSelectedCount > 0) {
        actions.clearMultiSelect();
        return;
      }
      if (isEditing) {
        documentRef.activeElement.blur();
        return;
      }
      if (selectedCardId) {
        actions.selectCard(null);
        return;
      }
    }

    // 5. Delete 关闭卡片（非编辑状态，移除危险的 Backspace 级联误删保护）
    if (e.key === 'Delete' && !isEditing) {
      const { cards, selectedCardId } = getState();
      if (selectedCardId) {
        const currentCard = cards.find(c => c.id === selectedCardId);
        if (currentCard) {
          e.preventDefault();
          actions.closeCardHierarchy(currentCard);
          return;
        }
      }
    }

    // 6. Shift + A 树状一键自动整理 (Auto-Tidy)
    if ((e.key === 'a' || e.key === 'A') && e.shiftKey && !isEditing) {
      e.preventDefault();
      actions.autoTidyLayout();
      return;
    }

    // 7. Shift + M 多分支合并总结 (Merge)
    if ((e.key === 'm' || e.key === 'M') && e.shiftKey && !isEditing) {
      const { multiSelectedCount } = getState();
      if (multiSelectedCount >= 2) {
        e.preventDefault();
        actions.createMergeCardFromSelected();
        return;
      }
    }
  };

  const onKeyUp = (e) => {
    if (e.code === 'Space') {
      actions.setSpacePressed(false);
      viewport?.classList.remove('is-hand-tool');
    }
  };

  windowRef.addEventListener('keydown', onKeyDown);
  windowRef.addEventListener('keyup', onKeyUp);

  return () => {
    windowRef.removeEventListener('keydown', onKeyDown);
    windowRef.removeEventListener('keyup', onKeyUp);
  };
}
