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
 * 判定目标元素是否处于正在编辑状态（输入框、文本域或富文本区）
 */
export function isEditingElement(element) {
  if (!element) return false;
  const tagName = element.tagName ? element.tagName.toUpperCase() : '';
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    Boolean(element.isContentEditable)
  );
}

/**
 * 判定目标元素是否属于交互表单或按钮控件（禁止按 Delete 误删卡片）
 */
export function isFormControlElement(element) {
  if (!element) return false;
  const tagName = element.tagName ? element.tagName.toUpperCase() : '';
  return (
    isEditingElement(element) ||
    tagName === 'SELECT' ||
    tagName === 'BUTTON'
  );
}

/**
 * 判定当前环境是否处于模态弹窗或其内部控件处于聚焦状态
 */
export function isModalOrDialogActive({ documentRef, getState }) {
  if (getState?.()?.battleDialogOpen) return true;

  // 1. 检查已知的几个模态 dialog 实例
  const knownDialogIds = ['battle-dialog', 'delete-session-dialog', 'bridge-dialog', 'bridge-send-dialog'];
  for (const id of knownDialogIds) {
    const el = documentRef?.getElementById?.(id);
    if (el && (el.open === true || Boolean(el.attributes?.open) || (typeof el.hasAttribute === 'function' && el.hasAttribute('open')))) {
      return true;
    }
  }

  // 2. 通用 DOM 查询
  if (typeof documentRef?.querySelector === 'function') {
    try {
      const openDialog = documentRef.querySelector('dialog[open], [role="dialog"][aria-modal="true"]');
      if (openDialog) return true;
    } catch {}
  }

  // 3. 检查当前焦点是否在模态弹窗内
  const active = documentRef?.activeElement;
  if (active) {
    const activeTag = active.tagName ? active.tagName.toUpperCase() : '';
    if (activeTag === 'DIALOG' || active.getAttribute?.('role') === 'dialog') return true;

    if (typeof active.closest === 'function') {
      try {
        if (active.closest('dialog, [role="dialog"], .modal, .dialog, #battle-dialog, #delete-session-dialog')) {
          return true;
        }
      } catch {}
    }

    // 针对测试桩 Element.prototype.contains 进行父级检查
    for (const id of knownDialogIds) {
      const el = documentRef?.getElementById?.(id);
      if (el?.contains?.(active)) return true;
    }
  }

  return false;
}

/**
 * 绑定全局键盘快捷键监听
 */
export function bindKeyboardShortcuts({ windowRef, documentRef, viewport, getState, actions }) {
  if (!windowRef) return () => {};

  const onKeyDown = (e) => {
    if (getState?.()?.isDisposed) return;
    // 0. 输入法合成态保护 (IME Composition Guard)
    if (e.isComposing || e.keyCode === 229) return;

    const activeEl = documentRef?.activeElement;
    const isEditing = isEditingElement(activeEl);
    const isFormControl = isFormControlElement(activeEl);
    const inModal = isModalOrDialogActive({ documentRef, getState });

    // 模态弹窗打开或焦点在弹窗内时，拦截所有画布层快捷键（除 Escape 允许关闭外）
    if (inModal) {
      if (e.key === 'Escape') {
        const { battleDialogOpen } = getState?.() || {};
        if (battleDialogOpen) {
          e.preventDefault?.();
          actions.closeBattleDialog?.();
        }
      }
      return;
    }

    // 1. Space 抓手漫游模式
    if (e.code === 'Space' && !isEditing && !isFormControl) {
      e.preventDefault?.();
      if (!getState().isSpacePressed) {
        actions.setSpacePressed(true);
        viewport?.classList.add('is-hand-tool');
      }
      return;
    }

    // 2. Tab 键快速开辟追问分支
    if (e.key === 'Tab' && !isEditing && !isFormControl) {
      const { cards, selectedCardId } = getState();
      const currentCard = cards.find(c => c.id === selectedCardId);
      if (currentCard && !actions.chainIsBusy(currentCard)) {
        e.preventDefault?.();
        actions.createBranchCard(currentCard, { autoFocus: true });
        return;
      }
    }

    // 3. 方向键导航（非编辑状态且非表单控件）
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !isEditing && !isFormControl) {
      e.preventDefault?.();
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

    // 5. Delete 关闭卡片（非编辑状态，且非表单/按钮控件聚焦，非模态）
    if (e.key === 'Delete' && !isEditing && !isFormControl) {
      const { cards, selectedCardId } = getState();
      if (selectedCardId) {
        const currentCard = cards.find(c => c.id === selectedCardId);
        if (currentCard) {
          e.preventDefault?.();
          actions.closeCardHierarchy(currentCard);
          return;
        }
      }
    }

    // 6. Shift + A 树状一键自动整理 (Auto-Tidy)
    if ((e.key === 'a' || e.key === 'A') && e.shiftKey && !isEditing && !isFormControl) {
      e.preventDefault?.();
      actions.autoTidyLayout();
      return;
    }

    // 7. Shift + M 多分支合并总结 (Merge)
    if ((e.key === 'm' || e.key === 'M') && e.shiftKey && !isEditing && !isFormControl) {
      const { multiSelectedCount } = getState();
      if (multiSelectedCount >= 2) {
        e.preventDefault?.();
        actions.createMergeCardFromSelected();
        return;
      }
    }

    // 8. Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 画布拓扑与布局撤销重做 (智能穿透空输入框且非流式生成)
    const isCmdOrCtrl = Boolean(e.ctrlKey || e.metaKey);
    if (isCmdOrCtrl) {
      // 9. Ctrl+F / Cmd+F 全画布卡片内容搜索
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault?.();
        actions.openSearchBar?.();
        return;
      }

      // 智能判定：当焦点在输入框/文本域时，若含有草稿文字，保留原生撤销；若无文字，智能穿透触发画布级撤回
      const hasTextContent = Boolean(activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') && activeEl.value && activeEl.value.length > 0);
      const isContentEditableActive = Boolean(activeEl?.isContentEditable);
      const isActuallyTyping = hasTextContent || isContentEditableActive;

      if (!isActuallyTyping) {
        const isZ = e.key === 'z' || e.key === 'Z';
        const isY = e.key === 'y' || e.key === 'Y';

        if (isZ || isY) {
          if (actions.isBusy?.()) return;

          if ((isZ && e.shiftKey) || (isY && !e.shiftKey)) {
            e.preventDefault?.();
            actions.redo?.();
            return;
          }

          if (isZ && !e.shiftKey) {
            e.preventDefault?.();
            actions.undo?.();
            return;
          }
        }
      }
    }
  };

  const onKeyUp = (e) => {
    if (getState?.()?.isDisposed) return;
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
