/**
 * 会话列表管理与右键/行内重命名菜单模块
 *
 * 负责会话列表渲染、行内重命名（带 IME composition 输入法保护）、
 * 更多操作/右键定位菜单（带防溢出计算与键盘无障碍导航）、删除确认派发与状态联动。
 * 纯函数优先外提，涉及 DOM 操作与状态变更通过工厂函数 createSessionListController(deps) 依赖注入。
 * 严禁直接访问 window/document 全局变量，全部从 deps 注入。
 */

export function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 校验并清洗重命名标题
 */
export function validateSessionTitle(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: '标题格式非法' };
  }
  const compressed = raw.trim().replace(/\s+/g, ' ');
  if (compressed.length === 0) {
    return { ok: false, error: '标题不能为空' };
  }
  if (compressed.length > 80) {
    return { ok: false, error: '标题长度不能超过80个字符' };
  }
  if (/[\u0000-\u001F\u007F-\u009F]/.test(compressed)) {
    return { ok: false, error: '标题不能包含控制字符' };
  }
  return { ok: true, title: compressed };
}

/**
 * 计算浮层菜单视口防溢出坐标
 */
export function computeMenuPosition(x, y, rect, vw, vh) {
  const width = rect?.width || 0;
  const height = rect?.height || 0;
  const posX = Math.max(4, Math.min(x, (vw || 800) - width - 4));
  const posY = Math.max(4, Math.min(y, (vh || 600) - height - 4));
  return { posX, posY };
}

export function createSessionListController(deps) {
  const {
    hana,
    sessionStore,
    writeRenameIntent,
    panelId,
    channel,
    getBoundCanvasId,
    setBoundCanvasId,
    getCanvasState,
    sendHello,
    onAgentRestored,
    sessionListEl,
    sessionCountEl,
    sessionStatusEl,
    btnNewSession,
    btnRefreshSessions,
    sessionContextMenu,
    btnMenuRename,
    btnMenuDelete,
    document: doc,
    window: win = typeof window !== 'undefined' ? window : null,
  } = deps;

  let sessions = [];
  let sessionListLoading = false;
  let sessionListError = null;
  let lastRenderKey = '';
  let sessionLoadSequence = 0;

  let menuState = {
    open: false,
    sessionId: null,
    triggerEl: null,
  };

  let renameState = {
    sessionId: null,
    inputValue: '',
    expectedTitle: '',
    requestId: null,
    submitting: false,
    isComposing: false,
  };

  let pendingRenderAfterComposition = false;
  let pendingDeleteRequestId = null;

  function updateStatusAndControls() {
    const boundCanvasId = getBoundCanvasId ? getBoundCanvasId() : null;
    const canvasState = getCanvasState ? getCanvasState() : {};
    const isBound = Boolean(boundCanvasId);
    const isReady = Boolean(canvasState.ready);
    const isBusy = Boolean(canvasState.busy);
    const isSubmittingRename = Boolean(renameState.submitting);
    const canOperate = isBound && isReady && !isBusy && !isSubmittingRename;

    if (btnNewSession) btnNewSession.disabled = !canOperate;
    if (btnRefreshSessions) btnRefreshSessions.disabled = isSubmittingRename;

    if (sessionStatusEl) {
      if (sessionListError) {
        sessionStatusEl.textContent = sessionListError;
        sessionStatusEl.className = 'session-status error';
      } else if (canvasState.error) {
        sessionStatusEl.textContent = `画布错误：${canvasState.error}`;
        sessionStatusEl.className = 'session-status error';
      } else if (!isBound || !isReady) {
        sessionStatusEl.textContent = '等待画布就绪...';
        sessionStatusEl.className = 'session-status warn';
      } else if (isBusy) {
        sessionStatusEl.textContent = '画布处理中...';
        sessionStatusEl.className = 'session-status warn';
      } else {
        const cur = sessionStatusEl.textContent;
        if (
          !cur.startsWith('重命名失败') &&
          !cur.startsWith('删除失败') &&
          !cur.startsWith('写入重命名意图失败') &&
          cur !== '等待主画布确认删除...'
        ) {
          sessionStatusEl.textContent = '';
          sessionStatusEl.className = 'session-status';
        }
      }
    }

    if (!canOperate && menuState.open) {
      closeSessionMenu(false);
    }

    if (btnMenuRename) btnMenuRename.disabled = !canOperate;
    if (btnMenuDelete) btnMenuDelete.disabled = !canOperate;

    if (sessionListEl?.querySelectorAll) {
      const buttons = sessionListEl.querySelectorAll('button.session-item, button.session-more');
      buttons.forEach((btn) => {
        btn.disabled = !canOperate;
      });
    }
  }

  function openSessionMenu(sessionId, x, y, triggerEl) {
    if (renameState.submitting) return;
    const boundCanvasId = getBoundCanvasId ? getBoundCanvasId() : null;
    const canvasState = getCanvasState ? getCanvasState() : {};
    const isBound = Boolean(boundCanvasId);
    const isReady = Boolean(canvasState.ready);
    const isBusy = Boolean(canvasState.busy);
    const canOperate = isBound && isReady && !isBusy;
    if (!canOperate || !sessionId || !sessionContextMenu) return;

    if (menuState.triggerEl && menuState.triggerEl !== triggerEl) {
      menuState.triggerEl.setAttribute('aria-expanded', 'false');
    }

    menuState.open = true;
    menuState.sessionId = sessionId;
    menuState.triggerEl = triggerEl || null;

    if (triggerEl) {
      triggerEl.setAttribute('aria-expanded', 'true');
    }

    sessionContextMenu.removeAttribute('hidden');

    const rect = sessionContextMenu.getBoundingClientRect ? sessionContextMenu.getBoundingClientRect() : { width: 120, height: 80 };
    const vw = win?.innerWidth || 800;
    const vh = win?.innerHeight || 600;
    const { posX, posY } = computeMenuPosition(x, y, rect, vw, vh);

    sessionContextMenu.style.left = `${posX}px`;
    sessionContextMenu.style.top = `${posY}px`;

    btnMenuRename?.focus?.();
  }

  function closeSessionMenu(restoreFocus = true) {
    if (!menuState.open) return;
    sessionContextMenu?.setAttribute('hidden', '');
    if (menuState.triggerEl) {
      menuState.triggerEl.setAttribute('aria-expanded', 'false');
      if (restoreFocus) {
        try {
          menuState.triggerEl.focus?.();
        } catch {}
      }
    }
    menuState.open = false;
    menuState.sessionId = null;
    menuState.triggerEl = null;
  }

  function startRename(sessionId) {
    if (renameState.submitting) return;
    const s = sessions.find((item) => item.id === sessionId);
    if (!s) return;
    closeSessionMenu(false);

    renameState.sessionId = sessionId;
    renameState.inputValue = s.title || '';
    renameState.expectedTitle = s.title || '';
    renameState.requestId = null;
    renameState.submitting = false;
    renameState.isComposing = false;

    lastRenderKey = '';
    renderSessionList();

    const input = doc.getElementById('session-rename-input');
    if (input) {
      input.focus?.();
      input.select?.();
    }
  }

  function cancelRename() {
    if (renameState.submitting) return;
    const prevId = renameState.sessionId;
    renameState.sessionId = null;
    renameState.inputValue = '';
    renameState.expectedTitle = '';
    renameState.requestId = null;
    renameState.submitting = false;
    renameState.isComposing = false;

    if (sessionStatusEl) {
      sessionStatusEl.textContent = '';
      sessionStatusEl.className = 'session-status';
    }

    lastRenderKey = '';
    renderSessionList();

    if (prevId) {
      const toFocus =
        doc.getElementById(`session-more-${prevId}`) ||
        doc.getElementById(`session-select-${prevId}`);
      if (toFocus) toFocus.focus?.();
    }
  }

  async function handleRenameSubmit() {
    if (renameState.submitting || !renameState.sessionId) return;
    const boundCanvasId = getBoundCanvasId ? getBoundCanvasId() : null;
    const canvasState = getCanvasState ? getCanvasState() : {};
    const isBound = Boolean(boundCanvasId);
    const isReady = Boolean(canvasState.ready);
    const isBusy = Boolean(canvasState.busy);
    const canOperate = isBound && isReady && !isBusy;

    if (!canOperate) {
      if (sessionStatusEl) {
        sessionStatusEl.textContent = '当前画布忙或未就绪，无法保存重命名';
        sessionStatusEl.className = 'session-status warn';
      }
      return;
    }

    const validation = validateSessionTitle(renameState.inputValue);
    if (!validation.ok) {
      if (sessionStatusEl) {
        sessionStatusEl.textContent = validation.error;
        sessionStatusEl.className = 'session-status error';
      }
      return;
    }
    const compressed = validation.title;

    const requestId = 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const submission = {
      requestId,
      sessionId: renameState.sessionId,
      expectedTitle: renameState.expectedTitle,
      canvasId: boundCanvasId,
      title: compressed,
    };

    renameState.requestId = requestId;
    renameState.submitting = true;

    lastRenderKey = '';
    renderSessionList();

    try {
      await writeRenameIntent(hana, {
        requestId: submission.requestId,
        sessionId: submission.sessionId,
        title: submission.title,
        expectedTitle: submission.expectedTitle,
      });
    } catch (err) {
      if (renameState.requestId === submission.requestId) {
        renameState.submitting = false;
        renameState.requestId = null;
      }
      if (sessionStatusEl) {
        sessionStatusEl.textContent = `写入重命名意图失败：${err.message || '未知错误'}`;
        sessionStatusEl.className = 'session-status error';
      }
      lastRenderKey = '';
      renderSessionList();
      return;
    }

    channel?.postMessage({
      type: 'FORK_SESSION_COMMAND',
      command: 'rename',
      targetCanvasId: submission.canvasId,
      panelId,
      requestId: submission.requestId,
      sessionId: submission.sessionId,
    });
  }

  function handleDeleteFromMenu(sessionId) {
    if (pendingDeleteRequestId) return;
    closeSessionMenu(false);
    if (renameState.submitting) return;
    const boundCanvasId = getBoundCanvasId ? getBoundCanvasId() : null;
    const canvasState = getCanvasState ? getCanvasState() : {};
    const isBound = Boolean(boundCanvasId);
    const isReady = Boolean(canvasState.ready);
    const isBusy = Boolean(canvasState.busy);
    const canOperate = isBound && isReady && !isBusy;

    if (!canOperate || !sessionId) return;

    const requestId = 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    pendingDeleteRequestId = requestId;
    if (sessionStatusEl) {
      sessionStatusEl.textContent = '等待主画布确认删除...';
      sessionStatusEl.className = 'session-status warn';
    }

    channel?.postMessage({
      type: 'FORK_SESSION_COMMAND',
      command: 'delete',
      requestId,
      panelId,
      sessionId,
      targetCanvasId: boundCanvasId,
    });
  }

  function renderSessionList() {
    updateStatusAndControls();
    if (!sessionListEl) return;

    if (sessionListLoading && sessions.length === 0) {
      sessionListEl.innerHTML = '<div class="empty-state">正在读取会话...</div>';
      lastRenderKey = '';
      return;
    }

    if (sessionListError && sessions.length === 0) {
      sessionListEl.innerHTML = `<div class="empty-state" role="alert">${escapeHtml(sessionListError)}</div>`;
      lastRenderKey = '';
      return;
    }

    if (sessions.length === 0) {
      sessionListEl.innerHTML = '<div class="empty-state">暂无会话记录</div>';
      lastRenderKey = '';
      return;
    }

    const boundCanvasId = getBoundCanvasId ? getBoundCanvasId() : null;
    const canvasState = getCanvasState ? getCanvasState() : {};
    const isBound = Boolean(boundCanvasId);
    const isReady = Boolean(canvasState.ready);
    const isBusy = Boolean(canvasState.busy);
    const canOperate = isBound && isReady && !isBusy;
    const currentActiveId = canvasState.activeId;

    const renderKey = [
      sessions.map((s) => `${s.id}:${s.title}:${s.cardCount}:${s.id === currentActiveId}`).join('|'),
      canOperate,
      renameState.sessionId,
      renameState.submitting,
    ].join('##');

    if (renderKey === lastRenderKey) {
      return;
    }

    const existingInput = doc.getElementById('session-rename-input');
    let hadEditorFocus = false;
    let caretStart = null;
    let caretEnd = null;

    if (existingInput && existingInput.getAttribute('data-session-id') === renameState.sessionId) {
      hadEditorFocus = doc.activeElement === existingInput;
      if (renameState.isComposing) {
        pendingRenderAfterComposition = true;
        return;
      }
      caretStart = existingInput.selectionStart;
      caretEnd = existingInput.selectionEnd;
      renameState.inputValue = existingInput.value;
    }

    const focusedEl = doc.activeElement;
    const focusedControlId = menuState.open ? menuState.triggerEl?.id
      : focusedEl && sessionListEl.contains?.(focusedEl) ? focusedEl.id : null;
    closeSessionMenu(false);

    lastRenderKey = renderKey;
    sessionListEl.innerHTML = '';

    sessions.forEach((s) => {
      const row = doc.createElement('div');
      row.className = 'session-row';
      row.setAttribute('role', 'listitem');
      row.setAttribute('data-session-id', s.id);

      if (renameState.sessionId === s.id) {
        const form = doc.createElement('form');
        form.className = 'session-rename-form';
        form.onsubmit = (e) => e.preventDefault?.();

        const input = doc.createElement('input');
        input.type = 'text';
        input.id = 'session-rename-input';
        input.className = 'session-rename-input';
        input.maxLength = 80;
        input.value = renameState.inputValue;
        input.disabled = renameState.submitting;
        input.setAttribute('aria-label', '修改会话标题');
        input.setAttribute('data-session-id', s.id);

        input.addEventListener('compositionstart', () => {
          if (renameState.sessionId !== s.id) return;
          renameState.isComposing = true;
        });
        input.addEventListener('compositionend', (e) => {
          if (renameState.sessionId !== s.id) return;
          renameState.isComposing = false;
          renameState.inputValue = e.target.value;
          if (pendingRenderAfterComposition) {
            pendingRenderAfterComposition = false;
            renderSessionList();
          }
        });
        input.addEventListener('input', (e) => {
          if (renameState.sessionId !== s.id) return;
          renameState.inputValue = e.target.value;
        });

        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            if (e.isComposing || renameState.submitting) return;
            e.preventDefault?.();
            handleRenameSubmit();
          } else if (e.key === 'Escape') {
            if (renameState.submitting) {
              e.preventDefault?.();
              return;
            }
            e.preventDefault?.();
            cancelRename();
          }
        });

        const btnSave = doc.createElement('button');
        btnSave.type = 'button';
        btnSave.id = 'session-rename-save';
        btnSave.className = 'session-rename-btn session-rename-btn-save';
        btnSave.textContent = renameState.submitting ? '保存中' : '保存';
        btnSave.disabled = renameState.submitting;
        btnSave.addEventListener('click', () => {
          if (renameState.submitting) return;
          handleRenameSubmit();
        });

        const btnCancel = doc.createElement('button');
        btnCancel.type = 'button';
        btnCancel.id = 'session-rename-cancel';
        btnCancel.className = 'session-rename-btn';
        btnCancel.textContent = '取消';
        btnCancel.disabled = renameState.submitting;
        btnCancel.addEventListener('click', () => {
          if (renameState.submitting) return;
          cancelRename();
        });

        form.appendChild(input);
        form.appendChild(btnSave);
        form.appendChild(btnCancel);
        row.appendChild(form);
      } else {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.id = `session-select-${s.id}`;
        const isActive = s.id === currentActiveId;
        btn.className = `session-item ${isActive ? 'active' : ''}`;
        btn.setAttribute('data-session-id', s.id);
        btn.disabled = !canOperate;

        const titleSpan = doc.createElement('span');
        titleSpan.className = 'session-item-title';
        titleSpan.textContent = s.title || '新会话';

        const badgeSpan = doc.createElement('span');
        badgeSpan.className = 'session-item-badge mono';
        badgeSpan.textContent = `${s.cardCount ?? 0} 卡`;

        btn.appendChild(titleSpan);
        btn.appendChild(badgeSpan);

        btn.addEventListener('click', () => {
          if (renameState.submitting) return;
          if (!canOperate || s.id === canvasState.activeId) return;
          channel?.postMessage({
            type: 'FORK_SESSION_COMMAND',
            targetCanvasId: boundCanvasId,
            command: 'switch',
            sessionId: s.id,
          });
        });

        const btnMore = doc.createElement('button');
        btnMore.type = 'button';
        btnMore.id = `session-more-${s.id}`;
        btnMore.className = 'session-more';
        btnMore.textContent = '⋯';
        btnMore.disabled = !canOperate;
        btnMore.setAttribute('aria-label', `会话操作：${s.title || '新会话'}`);
        btnMore.setAttribute('aria-haspopup', 'menu');
        btnMore.setAttribute('aria-controls', 'session-context-menu');
        btnMore.setAttribute('aria-expanded', 'false');

        btnMore.addEventListener('click', (e) => {
          e.stopPropagation?.();
          if (renameState.submitting || !canOperate) return;
          const rect = btnMore.getBoundingClientRect ? btnMore.getBoundingClientRect() : { right: 100, bottom: 100 };
          openSessionMenu(s.id, rect.right, rect.bottom + 2, btnMore);
        });

        row.addEventListener('contextmenu', (e) => {
          e.preventDefault?.();
          e.stopPropagation?.();
          if (renameState.submitting || !canOperate) return;
          openSessionMenu(s.id, e.clientX || 0, e.clientY || 0, btnMore);
        });

        row.appendChild(btn);
        row.appendChild(btnMore);
      }

      sessionListEl.appendChild(row);
    });

    if (renameState.sessionId) {
      const input = doc.getElementById('session-rename-input');
      if (input && !input.disabled && hadEditorFocus) {
        input.focus?.();
        if (caretStart !== null && caretEnd !== null) {
          try {
            input.setSelectionRange?.(caretStart, caretEnd);
          } catch {}
        }
      }
    } else if (focusedControlId) {
      const toFocus = doc.getElementById(focusedControlId);
      if (toFocus) toFocus.focus?.();
    }
  }

  async function loadSessions() {
    const sequence = ++sessionLoadSequence;
    sessionListLoading = true;
    sessionListError = null;
    renderSessionList();

    try {
      const res = await sessionStore.list();
      if (sequence !== sessionLoadSequence) return;
      sessions = res.sessions || [];
      const canvasState = getCanvasState ? getCanvasState() : {};
      if (res.activeId && !canvasState.activeId) {
        canvasState.activeId = res.activeId;
      }
      if (sessionCountEl) sessionCountEl.textContent = String(sessions.length);
    } catch (err) {
      if (sequence !== sessionLoadSequence) return;
      sessions = [];
      sessionListError = `会话读取失败：${err.message || '未知错误'}`;
      if (sessionCountEl) sessionCountEl.textContent = '0';
    } finally {
      if (sequence === sessionLoadSequence) {
        sessionListLoading = false;
        renderSessionList();
      }
    }
  }

  function bindSessionControls() {
    btnMenuRename?.addEventListener('click', () => {
      if (menuState.sessionId) {
        startRename(menuState.sessionId);
      }
    });

    btnMenuDelete?.addEventListener('click', () => {
      if (menuState.sessionId) {
        handleDeleteFromMenu(menuState.sessionId);
      }
    });

    btnNewSession?.addEventListener('click', () => {
      if (renameState.submitting) return;
      const boundCanvasId = getBoundCanvasId ? getBoundCanvasId() : null;
      const canvasState = getCanvasState ? getCanvasState() : {};
      if (!boundCanvasId || !canvasState.ready || canvasState.busy) return;
      channel?.postMessage({
        type: 'FORK_SESSION_COMMAND',
        targetCanvasId: boundCanvasId,
        command: 'new',
      });
    });

    btnRefreshSessions?.addEventListener('click', () => {
      if (renameState.submitting) return;
      closeSessionMenu(false);
      cancelRename();
      const boundCanvasId = getBoundCanvasId ? getBoundCanvasId() : null;
      if (boundCanvasId) {
        channel?.postMessage({
          type: 'FORK_SESSION_COMMAND',
          targetCanvasId: boundCanvasId,
          command: 'refresh',
        });
      }
      if (setBoundCanvasId) setBoundCanvasId(null);
      if (sendHello) sendHello();
      loadSessions();
    });

    win?.addEventListener?.('resize', () => closeSessionMenu(false));
    doc?.addEventListener?.('scroll', () => closeSessionMenu(false), true);
    doc?.addEventListener?.('pointerdown', (e) => {
      if (
        menuState.open &&
        !sessionContextMenu?.contains?.(e.target) &&
        (!menuState.triggerEl || !menuState.triggerEl?.contains?.(e.target))
      ) {
        closeSessionMenu(false);
      }
    });

    doc?.addEventListener?.('keydown', (e) => {
      if (e.key === 'Escape') {
        if (renameState.submitting) {
          e.preventDefault?.();
          e.stopPropagation?.();
          return;
        }
        if (menuState.open) {
          e.preventDefault?.();
          e.stopPropagation?.();
          closeSessionMenu(true);
          return;
        }
      }
      if (menuState.open) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault?.();
          e.stopPropagation?.();
          if (doc.activeElement === btnMenuRename) {
            btnMenuDelete?.focus?.();
          } else {
            btnMenuRename?.focus?.();
          }
        } else if (e.key === 'Tab') {
          closeSessionMenu(false);
        }
      }
    });
  }

  function handleSessionState(data) {
    if (!data || typeof data !== 'object') return;
    if (data.targetPanelId && data.targetPanelId !== panelId) return;

    let boundCanvasId = getBoundCanvasId ? getBoundCanvasId() : null;
    if (!boundCanvasId) {
      boundCanvasId = data.canvasId;
      if (setBoundCanvasId) setBoundCanvasId(data.canvasId);
    } else if (boundCanvasId !== data.canvasId) {
      return;
    }

    const canvasState = getCanvasState ? getCanvasState() : {};
    canvasState.ready = Boolean(data.ready);
    canvasState.busy = Boolean(data.busy);
    canvasState.error = data.error || null;
    if (data.activeId !== undefined) {
      canvasState.activeId = data.activeId;
    }

    if (data.agent && data.agent.id && onAgentRestored) {
      onAgentRestored(data.agent);
    }

    renderSessionList();
  }

  function handleSessionResult(data) {
    if (!data || typeof data !== 'object') return;
    const boundCanvasId = getBoundCanvasId ? getBoundCanvasId() : null;
    if (data.targetPanelId !== panelId || data.canvasId !== boundCanvasId) return;

    if (data.command === 'rename') {
      if (renameState.requestId && data.requestId === renameState.requestId) {
        renameState.submitting = false;
        if (data.ok) {
          renameState.sessionId = null;
          renameState.inputValue = '';
          renameState.expectedTitle = '';
          renameState.requestId = null;
          if (sessionStatusEl) {
            sessionStatusEl.textContent = '';
            sessionStatusEl.className = 'session-status';
          }
          loadSessions();
        } else {
          const errorMsg = data.error || '重命名失败';
          if (sessionStatusEl) {
            sessionStatusEl.textContent = `重命名失败：${errorMsg}`;
            sessionStatusEl.className = 'session-status error';
          }
          lastRenderKey = '';
          renderSessionList();
        }
      }
    } else if (data.command === 'delete') {
      if (!pendingDeleteRequestId || data.requestId !== pendingDeleteRequestId) {
        return;
      }
      pendingDeleteRequestId = null;

      if (data.cancelled) {
        if (sessionStatusEl) {
          sessionStatusEl.textContent = '';
          sessionStatusEl.className = 'session-status';
        }
      } else if (data.ok) {
        if (sessionStatusEl) {
          sessionStatusEl.textContent = '';
          sessionStatusEl.className = 'session-status';
        }
        loadSessions();
      } else {
        const errorMsg = data.error || '删除失败';
        if (sessionStatusEl) {
          sessionStatusEl.textContent = `删除失败：${errorMsg}`;
          sessionStatusEl.className = 'session-status error';
        }
      }
    }
  }

  // 初始化绑定控件事件
  bindSessionControls();

  return {
    renderSessionList,
    loadSessions,
    updateStatusAndControls,
    openSessionMenu,
    closeSessionMenu,
    startRename,
    cancelRename,
    handleRenameSubmit,
    handleDeleteFromMenu,
    handleSessionState,
    handleSessionResult,
    getSessions: () => sessions.slice(),
  };
}
