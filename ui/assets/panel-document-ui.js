/**
 * 文档上传的界面侧动作：附件按钮选中的文件、卡片上拖进来的文件、
 * 画布空白处拖进来的文件。
 *
 * 解析本身在 panel-documents.js，建卡在 panel-canvas-actions.js，
 * 这里只管「拿到文件之后按什么顺序做什么」。
 */

export function createDocumentUi(deps) {
  const {
    extractDocumentFile,
    flashMessage,
    canMutateCanvas,
    getCards,
    getSession,
    renderCards,
    scheduleSave,
    createDocumentCard,
    getView,
    getViewport,
    getDropIndicator,
    getIsDisposed,
    later,
    cancelLater,
  } = deps;

  let dragOverTimer = null;

  /** 解析一份文件并追加到卡片的暂存附件里。返回是否真的加上了。 */
  async function stageOneFile(card, file, generation) {
    const parsed = await extractDocumentFile(file, card.id);
    if (getIsDisposed() || !canMutateCanvas(generation) || !(getCards() || []).includes(card)) return false;
    if (parsed.cancelled) return false;
    if (!parsed.ok) {
      // 失败要说清卡在哪一步。悄悄跳过会让用户以为文件进去了。
      flashMessage(`《${parsed.filename}》没读出来（${parsed.stage || '未知'}阶段）：${parsed.error}`);
      return false;
    }
    card.stagedAttachments = (card.stagedAttachments || []).concat({
      name: parsed.filename,
      size: parsed.size,
      extension: parsed.extension,
      charCount: parsed.charCount,
      lineCount: parsed.lineCount,
      content: parsed.text,
      preview: parsed.preview,
    });
    return true;
  }

  /**
   * 往一张卡上加文件。全部处理完才重绘和落盘，
   * 中途画布失效就直接放弃，不再动剩下的文件。
   */
  async function attachFilesToCard(card, files) {
    if (!canMutateCanvas() || !(getCards() || []).includes(card)) return false;
    const generation = getSession().generation;
    let changed = false;

    for (const file of files) {
      const added = await stageOneFile(card, file, generation);
      if (getIsDisposed() || !canMutateCanvas(generation) || !(getCards() || []).includes(card)) return changed;
      if (added) changed = true;
    }

    if (changed) {
      renderCards();
      scheduleSave();
    }
    return changed;
  }

  function removeStagedAttachment(card, index) {
    if (!Array.isArray(card.stagedAttachments)) return false;
    if (Number.isNaN(index)) return false;
    card.stagedAttachments.splice(index, 1);
    renderCards();
    scheduleSave();
    return true;
  }

  function showDropIndicator() {
    const indicator = getDropIndicator();
    if (indicator) indicator.hidden = false;
    if (typeof cancelLater === 'function') cancelLater(dragOverTimer);
    // 拖拽事件在离开窗口后可能不再来，靠定时器兜一次，避免提示条一直挂着。
    if (typeof later === 'function') {
      dragOverTimer = later(() => {
        const el = getDropIndicator();
        if (el) el.hidden = true;
      }, 400);
    }
  }

  function hideDropIndicator() {
    const indicator = getDropIndicator();
    if (indicator) indicator.hidden = true;
    if (typeof cancelLater === 'function') cancelLater(dragOverTimer);
    dragOverTimer = null;
  }

  /** 画布空白处落文件：按落点换算成画布坐标，依次摆开建资料卡。 */
  async function dropFilesOnViewport(files, clientX, clientY) {
    if (!Array.isArray(files) || !files.length) return;
    hideDropIndicator();

    const viewport = getViewport();
    const view = getView();
    if (!viewport || !view) return;

    const rect = viewport.getBoundingClientRect();
    const canvasX = Math.round((clientX - rect.left - view.x) / view.scale);
    const canvasY = Math.round((clientY - rect.top - view.y) / view.scale);

    for (let i = 0; i < files.length; i++) {
      await createDocumentCard(files[i], {
        x: canvasX + i * 40,
        y: canvasY + i * 60,
      });
    }
  }

  return {
    attachFilesToCard,
    removeStagedAttachment,
    showDropIndicator,
    hideDropIndicator,
    dropFilesOnViewport,
  };
}
