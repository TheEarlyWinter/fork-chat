/**
 * 分支交接视图：负责 DOM 渲染、对话框生命周期、可访问性与焦点恢复。
 *
 * 保证：
 * 1. 业务正文严格使用 textContent，绝不使用 innerHTML 注入。
 * 2. 纯 DOM API 构建结构，兼顾测试环境与生产安全。
 * 3. 窄布局自适应，不撑破对话框。
 * 4. 拦截 Escape 键，关闭后焦点恢复至原触发元素。
 */

export function createHandoffView({ documentRef = (typeof document !== 'undefined' ? document : null) } = {}) {
  let dialog = null;
  let previousActiveElement = null;
  let listeners = [];

  // 内部缓存元素引用，避免重复查找
  let els = {};

  function doc() {
    return documentRef || (typeof document !== 'undefined' ? document : null);
  }

  function addListener(target, type, handler) {
    if (!target) return;
    target.addEventListener(type, handler);
    listeners.push({ target, type, handler });
  }

  function clearListeners() {
    for (const { target, type, handler } of listeners) {
      try { target.removeEventListener(type, handler); } catch {}
    }
    listeners = [];
  }

  function createEl(tag, className, textContent = '') {
    const d = doc();
    const el = d.createElement(tag);
    if (className) el.className = className;
    if (textContent) el.textContent = textContent;
    return el;
  }

  function renderDialog() {
    const d = doc();
    if (!d) return null;

    const dlg = createEl('dialog', 'handoff-dialog');
    dlg.setAttribute('aria-labelledby', 'handoff-title');
    dlg.setAttribute('role', 'dialog');

    // 头部
    const header = createEl('div', 'handoff-dialog-header');
    const title = createEl('h2', 'handoff-title', '在 Hana 中继续');
    title.id = 'handoff-title';
    const closeBtn = createEl('button', 'handoff-close-btn btn-handoff-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '关闭');
    header.appendChild(title);
    header.appendChild(closeBtn);

    // 主体
    const body = createEl('div', 'handoff-dialog-body');

    // 提示通知栏
    const noticesEl = createEl('div', 'handoff-notices');
    noticesEl.setAttribute('role', 'note');

    // 表单区
    const formSection = createEl('div', 'handoff-form-section');

    // Agent 选择
    const agentRow = createEl('div', 'handoff-field-row');
    const agentLabel = createEl('label', 'handoff-label', '目标智能体');
    agentLabel.setAttribute('for', 'handoff-agent-select');
    const agentSelect = createEl('select', 'handoff-select handoff-agent-select');
    agentSelect.id = 'handoff-agent-select';
    agentRow.appendChild(agentLabel);
    agentRow.appendChild(agentSelect);

    // NextStep 输入
    const nextStepRow = createEl('div', 'handoff-field-row');
    const nextStepHeader = createEl('div', 'handoff-next-step-header');
    const nextStepLabel = createEl('label', 'handoff-label', '下一步要求（可选）');
    nextStepLabel.setAttribute('for', 'handoff-next-step');
    const copyDraftBtn = createEl('button', 'handoff-link-btn btn-copy-draft', '复制目标草稿');
    copyDraftBtn.type = 'button';
    nextStepHeader.appendChild(nextStepLabel);
    nextStepHeader.appendChild(copyDraftBtn);

    const nextStepTextarea = createEl('textarea', 'handoff-textarea handoff-next-step');
    nextStepTextarea.id = 'handoff-next-step';
    nextStepTextarea.setAttribute('rows', '3');
    nextStepTextarea.setAttribute('placeholder', '交代下一步要处理的事项，将写入交接正文末尾');
    nextStepRow.appendChild(nextStepHeader);
    nextStepRow.appendChild(nextStepTextarea);

    formSection.appendChild(agentRow);
    formSection.appendChild(nextStepRow);

    // 元数据摘要
    const metaSummary = createEl('div', 'handoff-meta-summary');

    // 节点预览区
    const previewSection = createEl('div', 'handoff-preview-section');
    const previewTitle = createEl('div', 'handoff-section-title', '上下文预览');
    const nodesContainer = createEl('div', 'handoff-nodes-container');
    previewSection.appendChild(previewTitle);
    previewSection.appendChild(nodesContainer);

    // 错误信息栏
    const errorEl = createEl('div', 'handoff-error');
    errorEl.setAttribute('role', 'alert');
    errorEl.style.display = 'none';

    body.appendChild(noticesEl);
    body.appendChild(formSection);
    body.appendChild(metaSummary);
    body.appendChild(previewSection);
    body.appendChild(errorEl);

    // 底部操作栏
    const footer = createEl('div', 'handoff-dialog-footer');
    const cancelBtn = createEl('button', 'btn btn-outline btn-handoff-cancel', '取消');
    cancelBtn.type = 'button';
    const recoverBtn = createEl('button', 'btn btn-outline btn-handoff-recover', '查询恢复状态');
    recoverBtn.type = 'button';
    recoverBtn.style.display = 'none';
    const prepareBtn = createEl('button', 'btn btn-primary btn-handoff-prepare', '准备交接');
    prepareBtn.type = 'button';
    const confirmBtn = createEl('button', 'btn btn-primary btn-handoff-confirm', '确认交接');
    confirmBtn.type = 'button';
    confirmBtn.style.display = 'none';
    const focusBtn = createEl('button', 'btn btn-primary btn-handoff-focus', '在 Hana 中打开');
    focusBtn.type = 'button';
    focusBtn.style.display = 'none';

    footer.appendChild(cancelBtn);
    footer.appendChild(recoverBtn);
    footer.appendChild(prepareBtn);
    footer.appendChild(confirmBtn);
    footer.appendChild(focusBtn);

    dlg.appendChild(header);
    dlg.appendChild(body);
    dlg.appendChild(footer);

    els = {
      dialog: dlg,
      closeBtn,
      cancelBtn,
      agentSelect,
      nextStepTextarea,
      copyDraftBtn,
      prepareBtn,
      confirmBtn,
      recoverBtn,
      focusBtn,
      noticesEl,
      metaSummary,
      nodesContainer,
      errorEl,
    };

    return dlg;
  }

  function open({
    context,
    agents = [],
    selectedAgentId = '',
    onAgentChange = () => {},
    onNextStepChange = () => {},
    onCopyDraft = () => {},
    onPrepare = () => {},
    onConfirm = () => {},
    onRecover = () => {},
    onFocus = () => {},
    onClose = () => {},
  }) {
    close();
    const d = doc();
    if (!d) return;

    previousActiveElement = d.activeElement;
    dialog = renderDialog();
    if (!dialog) return;
    d.body.appendChild(dialog);

    // 绑定 Agent 下拉
    if (els.agentSelect) {
      els.agentSelect.innerHTML = '';
      for (const agent of agents) {
        const opt = d.createElement('option');
        opt.value = agent.id;
        opt.textContent = agent.name || agent.id;
        if (agent.id === selectedAgentId) opt.selected = true;
        els.agentSelect.appendChild(opt);
      }
      addListener(els.agentSelect, 'change', (e) => onAgentChange(e.target.value));
    }

    // 绑定下一步草稿输入
    if (els.nextStepTextarea) {
      els.nextStepTextarea.value = context.nextStep || '';
      addListener(els.nextStepTextarea, 'input', (e) => onNextStepChange(e.target.value));
    }

    // 绑定复制目标草稿按钮
    if (els.copyDraftBtn) {
      addListener(els.copyDraftBtn, 'click', () => onCopyDraft());
    }

    const handleClose = () => {
      close();
      onClose();
    };

    if (els.closeBtn) addListener(els.closeBtn, 'click', handleClose);
    if (els.cancelBtn) addListener(els.cancelBtn, 'click', handleClose);
    if (els.prepareBtn) addListener(els.prepareBtn, 'click', () => onPrepare());
    if (els.confirmBtn) addListener(els.confirmBtn, 'click', () => onConfirm());
    if (els.recoverBtn) addListener(els.recoverBtn, 'click', () => onRecover());
    if (els.focusBtn) addListener(els.focusBtn, 'click', () => onFocus());

    // 键盘 Escape 支持
    addListener(dialog, 'keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    });

    renderSummary(context);
    renderNotices(context.notices);
    renderNodes(context.nodes);

    if (typeof dialog.showModal === 'function') {
      try { dialog.showModal(); } catch { dialog.open = true; }
    } else {
      dialog.open = true;
    }
  }

  function renderSummary(context) {
    if (!els.metaSummary) return;
    const nodeCount = context.nodes?.length || 0;
    const artCount = context.artifactIds?.length || 0;
    const charCount = context.stats?.characterCount || 0;
    els.metaSummary.textContent = `包含节点: ${nodeCount} 个 | 附件产物: ${artCount} 个 | 正文预估: ${charCount} 字 (来源版本 r${context.source?.revision ?? '0'})`;
  }

  function renderNotices(notices = []) {
    if (!els.noticesEl) return;
    els.noticesEl.innerHTML = '';
    const d = doc();
    const defaultNotices = [
      '新主页会话默认关闭记忆，不主动调用模型。',
      '本次交接使用当前已保存的不可变快照，后续画布修改不会自动同步。',
      ...(Array.isArray(notices) ? notices : []),
    ];
    for (const note of defaultNotices) {
      const p = d.createElement('p');
      p.className = 'handoff-notice-item';
      p.textContent = note;
      els.noticesEl.appendChild(p);
    }
  }

  function renderNodes(nodes = []) {
    if (!els.nodesContainer) return;
    els.nodesContainer.innerHTML = '';
    const d = doc();

    for (const node of nodes) {
      const cardEl = d.createElement('details');
      cardEl.className = 'handoff-node-card';
      const summary = d.createElement('summary');
      summary.className = 'handoff-node-summary';
      summary.textContent = `[${node.role === 'assistant' ? '助手' : '用户'}] ${node.title || node.cardId}`;
      cardEl.appendChild(summary);

      const contentBox = d.createElement('div');
      contentBox.className = 'handoff-node-content';
      // 业务正文严格使用 textContent
      contentBox.textContent = node.text || '(无正文)';
      cardEl.appendChild(contentBox);

      if (Array.isArray(node.attachments) && node.attachments.length > 0) {
        const attBox = d.createElement('div');
        attBox.className = 'handoff-node-attachments';
        attBox.textContent = `附件 (${node.attachments.length}): ` + node.attachments.map(a => a.name || a.filename || '未命名').join(', ');
        cardEl.appendChild(attBox);
      }

      els.nodesContainer.appendChild(cardEl);
    }
  }

  function setNextStepValue(val) {
    if (els.nextStepTextarea) els.nextStepTextarea.value = val;
  }

  function setError(errorText) {
    if (!els.errorEl) return;
    if (errorText) {
      els.errorEl.textContent = errorText;
      els.errorEl.style.display = 'block';
    } else {
      els.errorEl.textContent = '';
      els.errorEl.style.display = 'none';
    }
  }

  function setStage(stage, details = {}) {
    const { prepareBtn, confirmBtn, recoverBtn, focusBtn } = els;

    // 默认隐藏
    if (prepareBtn) prepareBtn.style.display = 'none';
    if (confirmBtn) confirmBtn.style.display = 'none';
    if (recoverBtn) recoverBtn.style.display = 'none';
    if (focusBtn) focusBtn.style.display = 'none';

    if (stage === 'init') {
      if (prepareBtn) {
        prepareBtn.style.display = 'inline-block';
        prepareBtn.disabled = false;
        prepareBtn.textContent = '准备交接';
      }
    } else if (stage === 'preparing') {
      if (prepareBtn) {
        prepareBtn.style.display = 'inline-block';
        prepareBtn.disabled = true;
        prepareBtn.textContent = '正在准备…';
      }
    } else if (stage === 'prepared') {
      if (confirmBtn) {
        confirmBtn.style.display = 'inline-block';
        confirmBtn.disabled = false;
        confirmBtn.textContent = '确认交接';
      }
    } else if (stage === 'confirming') {
      if (confirmBtn) {
        confirmBtn.style.display = 'inline-block';
        confirmBtn.disabled = true;
        confirmBtn.textContent = '正在交接…';
      }
    } else if (stage === 'ready') {
      if (focusBtn) {
        focusBtn.style.display = 'inline-block';
        focusBtn.disabled = false;
        focusBtn.textContent = '在 Hana 中打开';
      }
    } else if (stage === 'recoverable') {
      if (recoverBtn) {
        recoverBtn.style.display = 'inline-block';
        recoverBtn.disabled = false;
        recoverBtn.textContent = '查询恢复状态';
      }
    }
  }

  function close() {
    clearListeners();
    if (dialog) {
      try { dialog.close?.(); } catch {}
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
      dialog = null;
    }
    els = {};
    if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
      try { previousActiveElement.focus(); } catch {}
      previousActiveElement = null;
    }
  }

  function isMounted() {
    return Boolean(dialog && dialog.parentNode);
  }

  return {
    open,
    close,
    setError,
    setStage,
    setNextStepValue,
    isMounted,
    getDialog: () => dialog,
  };
}
