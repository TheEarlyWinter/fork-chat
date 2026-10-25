/**
 * 分支交接模态视图：
 * 1. 负责对话框 DOM 渲染、预览呈现、Agent 选择与操作状态绑定。
 * 2. 纯 DOM API 构建结构，兼顾测试环境与生产安全。
 * 3. 窄布局自适应，不撑破对话框。
 * 4. 拦截 Escape 键，关闭后焦点恢复至原触发元素。
 * 5. 模态 API (showModal) 不可用或抛错时 fail closed，绝不降级为 open=true 伪模态。
 * 6. 支持早期 loading 态挂载、历史记录查看与多历史选择、新建预览切换以及错误重试绑定。
 * 7. 提供基于 formatHandoffTranscript 的完整权威正文保底预览。
 */

import { formatHandoffTranscript } from './fork-handoff-contract.js';

const STATUS_LABELS = Object.freeze({
  ok: '',
  failed: '（未完成：失败，不能当作已完成结论）',
  cancelled: '（未完成：已中断，不能当作已完成结论）',
  partial: '（未完成：部分回答，不能当作已完成结论）',
});

export function createHandoffView({ documentRef = (typeof document !== 'undefined' ? document : null) } = {}) {
  let dialog = null;
  let previousActiveElement = null;
  let listeners = [];
  let els = {};

  function doc() {
    return documentRef || (typeof document !== 'undefined' ? document : null);
  }

  function addListener(el, type, handler) {
    if (!el || typeof el.addEventListener !== 'function') return;
    el.addEventListener(type, handler);
    listeners.push({ el, type, handler });
  }

  function clearListeners() {
    for (const { el, type, handler } of listeners) {
      try { el.removeEventListener(type, handler); } catch {}
    }
    listeners = [];
  }

  function createEl(tag, className, text = null) {
    const el = doc().createElement(tag);
    if (className) el.className = className;
    if (text !== null) el.textContent = text;
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

    // 历史动作选择行
    const historyRow = createEl('div', 'handoff-field-row handoff-history-row');
    historyRow.style.display = 'none';
    const historyLabel = createEl('label', 'handoff-label', '历史交接记录');
    historyLabel.setAttribute('for', 'handoff-history-select');
    const historySelect = createEl('select', 'handoff-select handoff-history-select');
    historySelect.id = 'handoff-history-select';
    historyRow.appendChild(historyLabel);
    historyRow.appendChild(historySelect);

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

    // 完整权威转录正文保底预览
    const transcriptDetails = createEl('details', 'handoff-transcript-details');
    const transcriptSummary = createEl('summary', 'handoff-transcript-summary', '完整权威转录正文');
    const transcriptPre = createEl('pre', 'handoff-transcript-preview handoff-transcript-pre');
    transcriptDetails.appendChild(transcriptSummary);
    transcriptDetails.appendChild(transcriptPre);
    previewSection.appendChild(transcriptDetails);

    // 错误信息栏
    const errorEl = createEl('div', 'handoff-error');
    errorEl.setAttribute('role', 'alert');
    errorEl.style.display = 'none';

    body.appendChild(noticesEl);
    body.appendChild(historyRow);
    body.appendChild(formSection);
    body.appendChild(metaSummary);
    body.appendChild(previewSection);
    body.appendChild(errorEl);

    // 底部操作栏
    const footer = createEl('div', 'handoff-dialog-footer');
    const cancelBtn = createEl('button', 'btn btn-outline btn-handoff-cancel', '取消');
    cancelBtn.type = 'button';
    const newPreviewBtn = createEl('button', 'btn btn-outline btn-handoff-new-preview', '新建预览');
    newPreviewBtn.type = 'button';
    newPreviewBtn.style.display = 'none';
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
    footer.appendChild(newPreviewBtn);
    footer.appendChild(recoverBtn);
    footer.appendChild(prepareBtn);
    footer.appendChild(confirmBtn);
    footer.appendChild(focusBtn);

    dlg.appendChild(header);
    dlg.appendChild(body);
    dlg.appendChild(footer);

    els = {
      dialog: dlg,
      body,
      closeBtn,
      cancelBtn,
      newPreviewBtn,
      agentSelect,
      nextStepTextarea,
      copyDraftBtn,
      prepareBtn,
      confirmBtn,
      recoverBtn,
      focusBtn,
      historyRow,
      historySelect,
      formSection,
      noticesEl,
      metaSummary,
      nodesContainer,
      transcriptDetails,
      transcriptPre,
      errorEl,
    };

    return dlg;
  }

  function renderSummary(context) {
    if (!els.metaSummary) return;
    if (!context) {
      els.metaSummary.textContent = '暂无上下文信息';
      return;
    }
    const stats = context.stats || {};
    const nodeCount = stats.nodeCount ?? (context.nodes?.length || 0);
    const messageCount = stats.messageCount ?? 0;
    const artifactCount = stats.artifactCount ?? (context.artifactIds?.length || 0);
    const transcriptBytes = stats.transcriptBytes ?? 0;
    const revision = context.source?.revision ?? '0';

    els.metaSummary.textContent = `包含节点: ${nodeCount} 个 | 消息: ${messageCount} 条 | 附件产物: ${artifactCount} 个 | 转录体积: ${transcriptBytes} 字节 (来源版本 r${revision})`;
  }

  function renderNotices(notices = []) {
    if (!els.noticesEl) return;
    els.noticesEl.innerHTML = '';
    const d = doc();
    const defaultNotices = [
      '新主页会话默认关闭记忆，不主动调用模型。',
      '本次交接使用当前已保存的不可变快照，后续画布修改不会自动同步。',
    ];

    const allNotes = [...defaultNotices];
    if (Array.isArray(notices)) {
      for (const n of notices) {
        if (!n) continue;
        const msg = typeof n === 'string' ? n : (n.message || n.code || String(n));
        allNotes.push(msg);
      }
    }

    for (const note of allNotes) {
      const p = d.createElement('p');
      p.className = 'handoff-notice-item';
      p.textContent = note;
      els.noticesEl.appendChild(p);
    }
  }

  function renderTranscript(context) {
    if (!els.transcriptPre) return;
    if (!context || !context.agentId || context.agentId.trim() === '') {
      els.transcriptPre.textContent = '请选择智能体后生成权威正文预览';
      return;
    }
    try {
      const text = formatHandoffTranscript(context);
      els.transcriptPre.textContent = text;
    } catch (err) {
      els.transcriptPre.textContent = '权威转录正文生成失败：' + (err?.message || err);
    }
  }

  function renderNodes(context) {
    if (!els.nodesContainer) return;
    els.nodesContainer.innerHTML = '';
    const d = doc();
    if (!context) return;

    const nodes = Array.isArray(context.nodes) ? context.nodes : [];
    for (const node of nodes) {
      const cardEl = d.createElement('details');
      cardEl.className = 'handoff-node-card';
      cardEl.open = true;

      const summary = d.createElement('summary');
      summary.className = 'handoff-node-summary';
      const hasAssistant = Array.isArray(node.messages) && node.messages.some(m => m.role === 'assistant');
      const hasUser = Array.isArray(node.messages) && node.messages.some(m => m.role === 'user');
      const roleTag = hasAssistant ? '[助手/对话]' : (hasUser ? '[用户]' : '[节点]');
      summary.textContent = `${roleTag} ${node.title || node.cardId}`;
      cardEl.appendChild(summary);

      const contentBox = d.createElement('div');
      contentBox.className = 'handoff-node-content';

      // 资料正文
      if (node.doc) {
        const docEl = d.createElement('div');
        docEl.className = 'handoff-node-doc';
        docEl.textContent = `资料：${node.doc.name || '未命名'} (${node.doc.extension || '未知'}，${node.doc.charCount || 0} 字)\n${node.doc.content || ''}`;
        contentBox.appendChild(docEl);
      }

      // 消息列表
      if (Array.isArray(node.messages) && node.messages.length > 0) {
        for (const msg of node.messages) {
          const msgEl = d.createElement('div');
          msgEl.className = 'handoff-node-message';
          const roleText = msg.role === 'user' ? '用户' : '助手';
          const statusText = STATUS_LABELS[msg.status] || (msg.status && msg.status !== 'ok' ? `（未完成：${msg.status}）` : '');
          const headerText = `${roleText}${msg.agentName ? ` · ${msg.agentName}` : ''}${statusText}`;
          msgEl.textContent = `${headerText}\n${msg.text || ''}`;
          contentBox.appendChild(msgEl);

          // 文本附件
          if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
            for (const att of msg.attachments) {
              const attEl = d.createElement('div');
              attEl.className = 'handoff-node-attachment';
              attEl.textContent = `附件：${att.name || '未命名'}${att.extension ? ` (${att.extension})` : ''} (${att.charCount || 0} 字)\n${att.content || ''}`;
              contentBox.appendChild(attEl);
            }
          }

          // 产物
          if (Array.isArray(msg.artifacts) && msg.artifacts.length > 0) {
            for (const art of msg.artifacts) {
              const artEl = d.createElement('div');
              artEl.className = 'handoff-node-artifact';
              artEl.textContent = `产物：${art.name || art.artifactId} (${art.artifactId}) [${art.mime || art.format || ''}, ${art.bytes || 0} 字节]`;
              contentBox.appendChild(artEl);
            }
          }
        }
      } else if (!node.doc) {
        const emptyEl = d.createElement('div');
        emptyEl.className = 'handoff-node-empty';
        emptyEl.textContent = '（该节点没有可导入的已发送正文。）';
        contentBox.appendChild(emptyEl);
      }

      cardEl.appendChild(contentBox);
      els.nodesContainer.appendChild(cardEl);
    }

    // 显式引用
    if (Array.isArray(context.references) && context.references.length > 0) {
      const refSection = d.createElement('div');
      refSection.className = 'handoff-references-section';
      for (const ref of context.references) {
        const refEl = d.createElement('div');
        refEl.className = 'handoff-reference-item';
        refEl.textContent = `引用 ${ref.refId} (来源: ${ref.sourceCardId}${ref.sourceTitle ? ` · ${ref.sourceTitle}` : ''})：${ref.text || ''}`;
        refSection.appendChild(refEl);
      }
      els.nodesContainer.appendChild(refSection);
    }

    // 排除的祖先节点
    if (Array.isArray(context.exclusions) && context.exclusions.length > 0) {
      const excSection = d.createElement('div');
      excSection.className = 'handoff-exclusions-section';
      for (const exc of context.exclusions) {
        const excEl = d.createElement('div');
        excEl.className = 'handoff-exclusion-item';
        excEl.textContent = `排除的祖先节点：${exc.title || '未命名'} (${exc.cardId})`;
        excSection.appendChild(excEl);
      }
      els.nodesContainer.appendChild(excSection);
    }

    // 未发送内容（草稿与暂存附件）
    if (Array.isArray(context.unsent) && context.unsent.length > 0) {
      const unsentSection = d.createElement('div');
      unsentSection.className = 'handoff-unsent-section';
      for (const u of context.unsent) {
        const unsentEl = d.createElement('div');
        unsentEl.className = 'handoff-unsent-item';
        const attList = u.attachments || u.stagedAttachments || [];
        const stagedNames = attList.map(a => a.name || a.filename).filter(Boolean).join(', ');
        unsentEl.textContent = `未发送内容 (卡片 ${u.cardId}): 草稿 ${u.draftChars} 字符${stagedNames ? ` | 暂存附件: ${stagedNames}` : ''}`;
        unsentSection.appendChild(unsentEl);
      }
      els.nodesContainer.appendChild(unsentSection);
    }

    // 产物标识
    if (Array.isArray(context.artifactIds) && context.artifactIds.length > 0) {
      const artSection = d.createElement('div');
      artSection.className = 'handoff-artifacts-section';
      artSection.textContent = `纳入产物标识: ${context.artifactIds.join(', ')}`;
      els.nodesContainer.appendChild(artSection);
    }

    // 下一步要求预览
    if (context.nextStep) {
      const nextSection = d.createElement('div');
      nextSection.className = 'handoff-next-step-preview';
      nextSection.textContent = `下一步要求：${context.nextStep}`;
      els.nodesContainer.appendChild(nextSection);
    }
  }

  function updatePreview(context) {
    renderSummary(context);
    renderNotices(context?.notices || []);
    renderNodes(context);
    renderTranscript(context);
  }

  function markPreviewStale(newText) {
    if (!els.nodesContainer) return;
    let nextEl = els.nodesContainer.querySelector('.handoff-next-step-preview');
    if (!nextEl) {
      nextEl = doc().createElement('div');
      nextEl.className = 'handoff-next-step-preview';
      els.nodesContainer.appendChild(nextEl);
    }
    if (newText) {
      nextEl.textContent = `下一步要求：${newText} (待重新准备)`;
    } else {
      nextEl.textContent = '';
    }
  }

  function ensureMounted(onClose) {
    if (dialog && dialog.parentNode) return true;
    const d = doc();
    if (!d) return false;

    previousActiveElement = d.activeElement;
    dialog = renderDialog();
    if (!dialog) return false;
    d.body.appendChild(dialog);

    const handleClose = () => {
      close();
      if (typeof onClose === 'function') onClose();
    };

    if (els.closeBtn) addListener(els.closeBtn, 'click', (e) => { e?.stopPropagation?.(); handleClose(); });
    if (els.cancelBtn) addListener(els.cancelBtn, 'click', (e) => { e?.stopPropagation?.(); handleClose(); });

    addListener(dialog, 'keydown', (e) => {
      if (e.key === 'Escape') {
        e?.preventDefault?.();
        handleClose();
      }
    });

    if (typeof dialog.showModal !== 'function') {
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
      dialog = null;
      return false;
    }
    try {
      dialog.showModal();
      dialog.open = true;
    } catch {
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
      dialog = null;
      return false;
    }
    return true;
  }

  function openLoading({ onClose = () => {} } = {}) {
    close();
    if (!ensureMounted(onClose)) return false;

    if (els.prepareBtn) {
      els.prepareBtn.style.display = 'none';
      els.prepareBtn.disabled = true;
    }
    if (els.confirmBtn) els.confirmBtn.style.display = 'none';
    if (els.recoverBtn) els.recoverBtn.style.display = 'none';
    if (els.focusBtn) els.focusBtn.style.display = 'none';
    if (els.newPreviewBtn) els.newPreviewBtn.style.display = 'none';
    if (els.historyRow) els.historyRow.style.display = 'none';

    if (els.metaSummary) {
      els.metaSummary.textContent = '正在获取会话快照与环境配置…';
    }
    if (els.transcriptPre) {
      els.transcriptPre.textContent = '';
    }
    setError('');
    return true;
  }

  function renderHistory({
    actions = [],
    selectedActionId = '',
    action,
    onActionSelect = () => {},
    onRecover = () => {},
    onFocus = () => {},
    onNewPreview = () => {},
    onClose = () => {},
  }) {
    if (!ensureMounted(onClose)) return false;
    clearListeners();

    const handleClose = () => {
      close();
      onClose();
    };

    if (els.closeBtn) addListener(els.closeBtn, 'click', (e) => { e?.stopPropagation?.(); handleClose(); });
    if (els.cancelBtn) addListener(els.cancelBtn, 'click', (e) => { e?.stopPropagation?.(); handleClose(); });
    if (els.recoverBtn) addListener(els.recoverBtn, 'click', () => onRecover());
    if (els.focusBtn) addListener(els.focusBtn, 'click', () => onFocus());
    if (els.newPreviewBtn) addListener(els.newPreviewBtn, 'click', () => onNewPreview());

    addListener(dialog, 'keydown', (e) => {
      if (e.key === 'Escape') {
        e?.preventDefault?.();
        handleClose();
      }
    });

    if (els.formSection) els.formSection.style.display = 'none';
    if (els.nodesContainer) els.nodesContainer.innerHTML = '';
    if (els.noticesEl) renderNotices([
      '当前显示该卡片已有的历史交接动作。',
      '如需为同卡片新版本或不同智能体交接，请点击【新建预览】。',
    ]);

    // 多个历史记录时展示历史动作切换下拉
    if (Array.isArray(actions) && actions.length > 1 && els.historyRow && els.historySelect) {
      els.historyRow.style.display = 'flex';
      els.historySelect.innerHTML = '';
      const currentSelectedId = selectedActionId || action?.actionId || '';
      for (const act of actions) {
        const opt = doc().createElement('option');
        opt.value = act.actionId;
        opt.textContent = `[r${act.source?.revision ?? '0'}] ${act.actionId} (${act.state}${act.agentId ? ` · ${act.agentId}` : ''})`;
        if (act.actionId === currentSelectedId) opt.selected = true;
        els.historySelect.appendChild(opt);
      }
      addListener(els.historySelect, 'change', (e) => onActionSelect(e.target.value));
    } else if (els.historyRow) {
      els.historyRow.style.display = 'none';
    }

    if (els.metaSummary && action) {
      els.metaSummary.textContent = `历史动作: ${action.actionId} (状态: ${action.state}) | 来源版本 r${action.source?.revision ?? '0'} | 智能体: ${action.agentId || '未指定'}`;
    }
    if (els.transcriptPre) {
      els.transcriptPre.textContent = '历史动作不包含正文快照，点击【新建预览】可基于当前最新保存版本交接。';
    }
    return true;
  }

  function renderEmptyHistory({
    onNewPreview = () => {},
    onClose = () => {},
  } = {}) {
    if (!ensureMounted(onClose)) return false;
    clearListeners();

    const handleClose = () => {
      close();
      onClose();
    };

    if (els.closeBtn) addListener(els.closeBtn, 'click', (e) => { e?.stopPropagation?.(); handleClose(); });
    if (els.cancelBtn) addListener(els.cancelBtn, 'click', (e) => { e?.stopPropagation?.(); handleClose(); });
    if (els.newPreviewBtn) addListener(els.newPreviewBtn, 'click', () => onNewPreview());

    addListener(dialog, 'keydown', (e) => {
      if (e.key === 'Escape') {
        e?.preventDefault?.();
        handleClose();
      }
    });

    if (els.formSection) els.formSection.style.display = 'none';
    if (els.historyRow) els.historyRow.style.display = 'none';
    if (els.nodesContainer) els.nodesContainer.innerHTML = '';
    if (els.metaSummary) els.metaSummary.textContent = '暂无历史交接记录';
    if (els.noticesEl) renderNotices([
      '当前画布与目标卡片没有可恢复的历史交接动作。',
      '点击【新建预览】后，才会读取最新保存版本并准备新的交接。',
    ]);
    if (els.transcriptPre) els.transcriptPre.textContent = '暂无历史正文；点击【新建预览】生成当前版本预览。';
    setError('');

    if (els.prepareBtn) els.prepareBtn.style.display = 'none';
    if (els.confirmBtn) els.confirmBtn.style.display = 'none';
    if (els.recoverBtn) els.recoverBtn.style.display = 'none';
    if (els.focusBtn) els.focusBtn.style.display = 'none';
    if (els.newPreviewBtn) {
      els.newPreviewBtn.style.display = 'inline-block';
      els.newPreviewBtn.disabled = false;
      els.newPreviewBtn.textContent = '新建预览';
    }
    return true;
  }

  function renderError({
    message = '',
    onRetry = () => {},
    onClose = () => {},
  } = {}) {
    if (!ensureMounted(onClose)) return false;
    clearListeners();

    const handleClose = () => {
      close();
      onClose();
    };

    if (els.closeBtn) addListener(els.closeBtn, 'click', (e) => { e?.stopPropagation?.(); handleClose(); });
    if (els.cancelBtn) addListener(els.cancelBtn, 'click', (e) => { e?.stopPropagation?.(); handleClose(); });
    if (els.recoverBtn) addListener(els.recoverBtn, 'click', () => onRetry());

    addListener(dialog, 'keydown', (e) => {
      if (e.key === 'Escape') {
        e?.preventDefault?.();
        handleClose();
      }
    });

    if (els.formSection) els.formSection.style.display = 'none';
    if (els.historyRow) els.historyRow.style.display = 'none';
    if (els.nodesContainer) els.nodesContainer.innerHTML = '';
    if (els.metaSummary) els.metaSummary.textContent = '历史交接记录查询异常';
    if (els.transcriptPre) els.transcriptPre.textContent = '';

    setError(message);

    if (els.prepareBtn) els.prepareBtn.style.display = 'none';
    if (els.confirmBtn) els.confirmBtn.style.display = 'none';
    if (els.focusBtn) els.focusBtn.style.display = 'none';
    if (els.newPreviewBtn) els.newPreviewBtn.style.display = 'none';

    if (els.recoverBtn) {
      els.recoverBtn.style.display = 'inline-block';
      els.recoverBtn.disabled = false;
      els.recoverBtn.textContent = '重试查询';
    }
    return true;
  }

  function renderNewPreview({
    context,
    agents = [],
    selectedAgentId = '',
    nextStepText = '',
    onAgentChange = () => {},
    onNextStepChange = () => {},
    onCopyDraft = () => {},
    onPrepare = () => {},
    onConfirm = () => {},
    onRecover = () => {},
    onFocus = () => {},
    onNewPreview = () => {},
    onClose = () => {},
  }) {
    if (!ensureMounted(onClose)) return false;
    clearListeners();

    const handleClose = () => {
      close();
      onClose();
    };

    if (els.closeBtn) addListener(els.closeBtn, 'click', (e) => { e?.stopPropagation?.(); handleClose(); });
    if (els.cancelBtn) addListener(els.cancelBtn, 'click', (e) => { e?.stopPropagation?.(); handleClose(); });
    if (els.prepareBtn) addListener(els.prepareBtn, 'click', () => onPrepare());
    if (els.confirmBtn) addListener(els.confirmBtn, 'click', () => onConfirm());
    if (els.recoverBtn) addListener(els.recoverBtn, 'click', () => onRecover());
    if (els.focusBtn) addListener(els.focusBtn, 'click', () => onFocus());
    if (els.newPreviewBtn) addListener(els.newPreviewBtn, 'click', () => onNewPreview());

    addListener(dialog, 'keydown', (e) => {
      if (e.key === 'Escape') {
        e?.preventDefault?.();
        handleClose();
      }
    });

    if (els.historyRow) els.historyRow.style.display = 'none';
    if (els.formSection) els.formSection.style.display = 'flex';

    // 绑定 Agent 下拉
    if (els.agentSelect) {
      els.agentSelect.innerHTML = '';
      const match = agents.some(a => a.id === selectedAgentId);
      if (!match) {
        const emptyOpt = doc().createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = '请选择智能体...';
        emptyOpt.selected = true;
        els.agentSelect.appendChild(emptyOpt);
      }
      for (const agent of agents) {
        const opt = doc().createElement('option');
        opt.value = agent.id;
        opt.textContent = agent.name || agent.id;
        if (match && agent.id === selectedAgentId) opt.selected = true;
        els.agentSelect.appendChild(opt);
      }
      addListener(els.agentSelect, 'change', (e) => onAgentChange(e.target.value));
    }

    // 绑定下一步草稿输入
    if (els.nextStepTextarea) {
      els.nextStepTextarea.value = nextStepText || context?.nextStep || '';
      addListener(els.nextStepTextarea, 'input', (e) => onNextStepChange(e.target.value));
    }

    // 绑定复制目标草稿按钮
    if (els.copyDraftBtn) {
      addListener(els.copyDraftBtn, 'click', () => onCopyDraft());
    }

    updatePreview(context);
    return true;
  }

  function open(params = {}) {
    close();
    return renderNewPreview(params);
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
    const { prepareBtn, confirmBtn, recoverBtn, focusBtn, newPreviewBtn } = els;

    if (prepareBtn) prepareBtn.style.display = 'none';
    if (confirmBtn) confirmBtn.style.display = 'none';
    if (recoverBtn) recoverBtn.style.display = 'none';
    if (focusBtn) focusBtn.style.display = 'none';
    if (newPreviewBtn) newPreviewBtn.style.display = 'none';

    const hasSessionId = Boolean(details.hasSessionId || details.sessionId);
    const showNewPreview = Boolean(details.showNewPreview);

    if (showNewPreview && newPreviewBtn) {
      newPreviewBtn.style.display = 'inline-block';
      newPreviewBtn.disabled = false;
      newPreviewBtn.textContent = '新建预览';
    }

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
        confirmBtn.textContent = '正在确认…';
      }
    } else if (stage === 'ready') {
      if (focusBtn) {
        focusBtn.style.display = 'inline-block';
        focusBtn.disabled = false;
        focusBtn.textContent = '在 Hana 中打开';
      }
    } else if (stage === 'partial' || stage === 'unknown' || stage === 'importing') {
      if (recoverBtn) {
        recoverBtn.style.display = 'inline-block';
        recoverBtn.disabled = false;
      }
      if (focusBtn && hasSessionId) {
        focusBtn.style.display = 'inline-block';
        focusBtn.disabled = false;
        focusBtn.textContent = '核查会话';
      }
    } else if (stage === 'creating' || stage === 'running' || stage === 'error-recoverable') {
      if (recoverBtn) {
        recoverBtn.style.display = 'inline-block';
        recoverBtn.disabled = false;
      }
    } else if (stage === 'failed' || stage === 'history-prepared') {
      // 仅展示说明与新建预览按钮
    }
  }

  function close() {
    clearListeners();
    if (dialog) {
      try {
        if (typeof dialog.close === 'function') dialog.close();
        dialog.open = false;
      } catch {}
      if (dialog.parentNode) {
        dialog.parentNode.removeChild(dialog);
      }
      dialog = null;
    }
    if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
      try { previousActiveElement.focus(); } catch {}
    }
    previousActiveElement = null;
  }

  function dispose() {
    close();
  }

  return {
    open,
    openLoading,
    renderHistory,
    renderEmptyHistory,
    renderError,
    renderNewPreview,
    updatePreview,
    markPreviewStale,
    setNextStepValue,
    setError,
    setStage,
    close,
    dispose,
    getDialog: () => dialog,
    isMounted: () => Boolean(dialog && dialog.parentNode),
  };
}
