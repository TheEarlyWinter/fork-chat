import { bufferToBase64 } from './panel-format.js';

/**
 * 文档解析管线：把拖进来的文件变成可推理的文本。
 *
 * 从 panel.js 里搬出来的。这段逻辑只跟"文件"打交道，
 * 不碰卡片渲染，也不需要知道画布怎么画，
 * 放在面板里只会让那个文件越来越长。
 *
 * 宿主接口全部由外部注入，测试里可以整段替换。
 */
// 这些阶段标记是给宿主日志和排障看的。测试环境里没有 window，
// 以前直接写 window.xxx 会让整段解析在桩环境里静默失败。
function markStage(stage) {
  try { if (typeof window !== 'undefined') window.__forkChatLastStage = stage; } catch {}
}
function currentStage() {
  try { return (typeof window !== 'undefined' && window.__forkChatLastStage) || '未知'; } catch { return '未知'; }
}

export function createDocumentPipeline(deps) {
  // cardId -> Set<AbortController>；null 键表示还不属于任何卡片的解析
  const documentTasks = new Map();

/** 取消全部未完成的解析任务（切换会话、面板销毁时用） */
function abortAll() {
  for (const bucket of documentTasks.values()) for (const task of bucket) task.abort(deps.inactiveError());
  documentTasks.clear();
}

async function extractDocumentFile(file, cardId = null) {
  const cancelled = () => ({ ok: false, cancelled: true, filename: file?.name || '未知文件', stage: 'cancelled', error: '画布任务已失效。' });
  if (!deps.canMutateCanvas?.() || !file) return cancelled();
  const task = new AbortController();
  // 按卡片登记。以前只登记控制器本身，关掉卡片时根本找不到属于它的那个，
  // 于是卡没了，后台还在分块上传、云端轮询。
  const key = cardId || null;
  if (!documentTasks.has(key)) documentTasks.set(key, new Set());
  documentTasks.get(key).add(task);
  try {
    return await deps.abortable(extractDocumentFileActive(file, task.signal), task.signal);
  } catch (error) {
    if (task.signal.aborted || deps.isDisposed()) return cancelled();
    return { ok: false, filename: file.name, stage: 'read', error: deps.safeDetail?.(error?.message || String(error)) || String(error?.message || error) };
  } finally {
    const bucket = documentTasks.get(key);
    if (bucket) {
      bucket.delete(task);
      if (!bucket.size) documentTasks.delete(key);
    }
  }
}

/** 取消某张卡片名下所有未完成的解析任务 */
function abortDocumentTasksFor(cardId) {
  const bucket = documentTasks.get(cardId);
  if (!bucket) return;
  for (const controller of bucket) controller.abort(deps.inactiveError());
  documentTasks.delete(cardId);
}

async function extractDocumentFileActive(file, signal) {
  const checkActive = () => { if (signal.aborted || deps.isDisposed()) throw deps.inactiveError(); };
  checkActive();
  const name = file.name || '未知文件';
  const ext = (name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '');
  const textExtensions = new Set([
    '.md', '.markdown', '.txt', '.json', '.csv', '.tsv',
    '.js', '.ts', '.jsx', '.tsx', '.py', '.c', '.cpp',
    '.h', '.hpp', '.java', '.go', '.rs', '.html', '.css',
    '.sh', '.bash', '.sql', '.yaml', '.yml', '.xml', '.ini',
  ]);

  // 1. 文本类文件：浏览器原生秒级读取，零网络开销
  if (textExtensions.has(ext)) {
    const text = typeof file.text === 'function' ? await file.text() : '';
    const charCount = text.length;
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    const lineCount = lines.length;
    const preview = text.slice(0, 1500) + (charCount > 1500 ? '\n\n... (文档较长，完整内容已完全载入上下文)' : '');
    return {
      ok: true,
      filename: name,
      extension: ext,
      size: file.size || text.length,
      charCount,
      lineCount,
      text,
      preview,
    };
  }

  // 2. Word (.docx) 与 PDF 等复杂格式：调用后端解析服务
  // 扫描件可能被升级到云端，等十几二十秒是正常的，先把话说在前面，别让人以为卡死了
  const idleBadge = deps.badgeStats ? deps.badgeStats.textContent : '';
  if (deps.badgeStats) {
    deps.badgeStats.textContent = ext === '.pdf'
      ? `正在解析 ${name}…（扫描件会走云端，可能要十几秒）`
      : `正在解析 ${name}…`;
  }
  let parseJobId = null, parseCompleted = false, parseCancelled = false;
  const cancelParser = () => {
    if (!parseJobId || parseCompleted || parseCancelled) return;
    parseCancelled = true;
    void deps.requestHost(deps.hana, `/api/document/parse/${encodeURIComponent(parseJobId)}`, { method: 'DELETE', keepalive: true }).catch(() => {});
  };
  signal.addEventListener('abort', cancelParser, { once: true });
  try {
    // UI uploads are bounded chunks; outbound cloud transfers use the authorised runtime.
    const CHUNK_RAW_BYTES = 6 * 1024 * 1024;
    const CHUNK_THRESHOLD = 16 * 1024 * 1024;
    let requestBody = { filename: name };
    markStage('开始');

    if (!Number.isFinite(file.size) || file.size > CHUNK_THRESHOLD) {
      const total = Math.ceil(file.size / CHUNK_RAW_BYTES);
      let uploadId = null;
      let uploaded = null;
      for (let i = 0; i < total; i += 1) {
        const slice = file.slice(i * CHUNK_RAW_BYTES, (i + 1) * CHUNK_RAW_BYTES);
        const chunkBase64 = bufferToBase64(await deps.abortable(slice.arrayBuffer(), signal));
        checkActive();
        if (deps.badgeStats) {
          deps.badgeStats.textContent = `正在上传 ${name}… ${i + 1}/${total}`;
        }
        const chunkRes = await deps.requestHost(deps.hana, '/api/document/upload', {
          method: 'POST',
          body: JSON.stringify({ uploadId, filename: name, index: i, total, size: file.size, chunk: chunkBase64 }), signal,
        });
        const chunkData = await deps.abortable(chunkRes.json(), signal);
        checkActive();
        if (!chunkData.ok) throw new Error(chunkData.error || '分块上传失败');
        uploadId = chunkData.uploadId;
        if (chunkData.done) uploaded = chunkData;
      }
      if (!uploaded?.uploadId) throw new Error('分块上传未完成');
      requestBody = { filename: name, uploadId: uploaded.uploadId };
      if (deps.badgeStats) deps.badgeStats.textContent = `正在解析 ${name}…`;
    } else {
      let contentBase64 = '';
      if (typeof file.arrayBuffer === 'function') {
        contentBase64 = bufferToBase64(await deps.abortable(file.arrayBuffer(), signal));
      }
      requestBody = { filename: name, contentBase64 };
    }

    // A late start receipt must still reveal its jobId so disposal can cancel it.
    checkActive();
    // 长解析拆成「发起 + 轮询」：单次请求都在秒级完成，不再赌链路耐心
    markStage('发起解析');
    const startRes = await deps.requestHost(deps.hana, '/api/document/parse', {
      method: 'POST',
      body: JSON.stringify(requestBody), signal,
    });
    const startData = await startRes.json();
    if (!startData.ok || !startData.jobId) throw new Error(startData.error || '无法启动解析任务');
    parseJobId = startData.jobId;
    if (signal.aborted || deps.isDisposed()) { cancelParser(); throw deps.inactiveError(); }

    let data = null;
    const deadline = Date.now() + Math.min(20 * 60 * 1000, Math.max(30000, Number(startData.timeoutMs) || 5 * 60 * 1000));
    while (Date.now() < deadline) {
      await deps.waitForParser(1200, signal);
      checkActive();
      markStage('轮询解析进度');
      const statusRes = await deps.abortable(deps.requestHost(deps.hana, `/api/document/parse/${encodeURIComponent(startData.jobId)}`, { signal }), signal);
      const status = await deps.abortable(statusRes.json(), signal);
      checkActive();
      if (!status.ok) throw new Error(status.error || '解析状态查询失败');
      if (status.status === 'done') {
        data = status.result;
        break;
      }
      if (['error', 'cancelled'].includes(status.status)) throw new Error(status.error || '解析失败或已取消');
      if (deps.badgeStats && status.stage) {
        deps.badgeStats.textContent = `正在解析 ${name}…（${status.stage} · ${Math.round((status.elapsedMs || 0) / 1000)}s）`;
      }
    }
    if (!data) throw new Error('解析超过等待时限，已请求取消');

    if (data && data.ok) {
      parseCompleted = true;
      return {
        ...data,
        size: file.size || data.charCount,
      };
    }
    // 解析失败时把原因说清楚（扫描件、字体映射、文件损坏各有各的说法）
    throw new Error(data?.error || '文档解析服务返回异常');
  } catch (err) {
    if (signal.aborted || deps.isDisposed()) return { ok: false, cancelled: true, filename: name, stage: 'cancelled' };
    const stage = currentStage();
    // 界面里的报错在宿主日志里看不到，先上报一份，排查时才有凭据
    try {
      void deps.requestHost(deps.hana, '/api/document/client-error', {
        method: 'POST',
        body: JSON.stringify({ stage, message: `${err.message || String(err)} | size=${file.size}` }),
      }).catch(() => {});
    } catch {}
    // 解析失败就是失败：不再伪装成一份空资料存进会话。
    // ok:false 让调用方原地报错，而不是把失败持久化成看似可用的卡片。
    return {
      ok: false,
      filename: name,
      extension: ext,
      size: file.size || 0,
      charCount: 0,
      lineCount: 0,
      stage,
      error: err.message || String(err),
    };
  } finally {
    signal.removeEventListener('abort', cancelParser);
    cancelParser();
    if (!deps.isDisposed() && deps.badgeStats && idleBadge) deps.badgeStats.textContent = idleBadge;
  }
}

  return { extractDocumentFile, abortDocumentTasksFor, abortAll, get pendingCount() { return documentTasks.size; } };
}
