/**
 * 交接文件按需预览的只读读取器。
 *
 * 归属与范围只由交接回执决定：调用方给的 fileId 必须属于 receiptReader 为同一
 * owner/session 核出来的回执，绝不接受任意路径或回执之外的文件。真正的字节只从
 * 正式 ResourceIO（sdk.resources.stat/read 的 session-file）读取，引用固定用
 * {kind:'session-file', sessionId, fileId}；sessionId 是稳定的会话标识，不是
 * 会话空间标签，也不碰宿主私有目录。
 *
 * 只承诺文本：Markdown 渲染成固定标签的安全 HTML（失败就回退原文），text/plain
 * 只给原文。文件内容不缓存，只合并同一文件的并发请求，最多同时读 4 个不同文件。
 */
import { createHash } from 'node:crypto';

import {
  MAX_DOCUMENT_INPUT_BYTES,
  parseDocumentBlocks,
} from './document-spec.js';
import { renderDocumentHtmlFragment } from './document-html.js';

export const HANDOFF_FILE_PREVIEW_CODES = Object.freeze({
  NOT_FOUND: 'HANDOFF_FILE_NOT_FOUND',
  UNSUPPORTED: 'HANDOFF_FILE_UNSUPPORTED',
  TOO_LARGE: 'HANDOFF_FILE_TOO_LARGE',
  BUSY: 'HANDOFF_FILE_BUSY',
  UNAVAILABLE: 'HANDOFF_FILE_UNAVAILABLE',
});

export const HANDOFF_FILE_PREVIEW_LIMITS = Object.freeze({
  maxFileBytes: MAX_DOCUMENT_INPUT_BYTES,
  maxHtmlBytes: 4 * 1024 * 1024,
  maxConcurrent: 4,
  maxFileIdChars: 200,
});

// 固定文案：不回宿主错误、不回路径、不回文件内容
const MESSAGES = Object.freeze({
  [HANDOFF_FILE_PREVIEW_CODES.NOT_FOUND]: '该文件不在本次交接回执中',
  [HANDOFF_FILE_PREVIEW_CODES.UNSUPPORTED]: '该文件类型暂不支持预览',
  [HANDOFF_FILE_PREVIEW_CODES.TOO_LARGE]: '文件超过可预览的大小上限',
  [HANDOFF_FILE_PREVIEW_CODES.BUSY]: '正在预览其它文件，请稍后再试',
  [HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE]: '文件暂时无法预览',
});

const STATUS = Object.freeze({
  [HANDOFF_FILE_PREVIEW_CODES.NOT_FOUND]: 404,
  [HANDOFF_FILE_PREVIEW_CODES.UNSUPPORTED]: 415,
  [HANDOFF_FILE_PREVIEW_CODES.TOO_LARGE]: 413,
  [HANDOFF_FILE_PREVIEW_CODES.BUSY]: 429,
  [HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE]: 409,
});

const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@~+-]{0,199}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_OWNER_CHARS = 2048;
const MARKDOWN = 'text/markdown';
const PLAIN_TEXT = 'text/plain';

const decoder = new TextDecoder('utf-8', { fatal: true });

function previewError(code) {
  return Object.assign(new Error(MESSAGES[code] || MESSAGES[HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE]), {
    code,
    status: STATUS[code] || 409,
  });
}

/** MIME 只取类型本身，忽略参数与大小写；未知类型归为不可预览 */
function normalizeMime(value) {
  if (typeof value !== 'string') return '';
  return value.split(';')[0].trim().toLowerCase();
}

function formatOf(mime) {
  if (mime === MARKDOWN) return 'markdown';
  if (mime === PLAIN_TEXT) return 'text';
  return null;
}

function resourceMatches(resource, { sessionId, fileId }) {
  return !!resource
    && resource.kind === 'session-file'
    && resource.fileId === fileId
    && resource.sessionId === sessionId;
}

function isBytes(value) {
  return value instanceof Uint8Array;
}

function decodeUtf8(bytes) {
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    // 非法 UTF-8 直接失败，不用替换字符冒充原文
    throw previewError(HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE);
  }
  // NUL 说明不是可显示的文本
  if (text.includes('\u0000')) throw previewError(HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE);
  return text;
}

function renderMarkdown(text, name) {
  let html;
  try {
    html = renderDocumentHtmlFragment(parseDocumentBlocks(text));
  } catch {
    // 结构超限/解析失败：只回原文，不把半成品当正常渲染
    return undefined;
  }
  if (!html) return undefined;
  if (Buffer.byteLength(html, 'utf8') > HANDOFF_FILE_PREVIEW_LIMITS.maxHtmlBytes) return undefined;
  return html;
}

export function createHandoffFilePreviewReader({ sdk, receiptReader } = {}) {
  if (!sdk || typeof sdk !== 'object') throw new TypeError('createHandoffFilePreviewReader 需要 sdk');
  if (!receiptReader || typeof receiptReader.read !== 'function') {
    throw new TypeError('createHandoffFilePreviewReader 需要 receiptReader');
  }

  const resources = sdk.resources;
  const inflight = new Map();
  let active = 0;

  async function readThroughReceipt(owner, sessionId, fileId) {
    const receipt = await receiptReader.read({ owner, sessionId });
    const files = Array.isArray(receipt?.files) ? receipt.files : [];
    const entry = files.find(file => file && file.fileId === fileId);
    // 回执里没有这个文件：不做任何资源调用
    if (!entry) throw previewError(HANDOFF_FILE_PREVIEW_CODES.NOT_FOUND);

    const mime = normalizeMime(entry.mime);
    const format = formatOf(mime);
    if (!format) throw previewError(HANDOFF_FILE_PREVIEW_CODES.UNSUPPORTED);

    if (!resources || typeof resources.stat !== 'function' || typeof resources.read !== 'function') {
      throw previewError(HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE);
    }

    const ref = { kind: 'session-file', sessionId, fileId };
    let stated;
    try {
      stated = await resources.stat(ref);
    } catch {
      throw previewError(HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE);
    }
    if (!stated || stated.exists !== true || stated.isDirectory !== false) {
      throw previewError(HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE);
    }
    if (!resourceMatches(stated.resource, { sessionId, fileId })) {
      throw previewError(HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE);
    }
    // stat 元数据必须完整：缺字段、null、负数、小数、NaN 或字符串都不当作可读
    const statedSize = stated.version?.size;
    if (!Number.isSafeInteger(statedSize) || statedSize < 0) {
      throw previewError(HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE);
    }
    if (statedSize > HANDOFF_FILE_PREVIEW_LIMITS.maxFileBytes) {
      throw previewError(HANDOFF_FILE_PREVIEW_CODES.TOO_LARGE);
    }

    let loaded;
    try {
      loaded = await resources.read(ref);
    } catch {
      throw previewError(HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE);
    }
    if (!loaded || !resourceMatches(loaded.resource, { sessionId, fileId })) {
      throw previewError(HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE);
    }
    const bytes = loaded.content;
    if (!isBytes(bytes)) throw previewError(HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE);
    if (bytes.length > HANDOFF_FILE_PREVIEW_LIMITS.maxFileBytes) {
      throw previewError(HANDOFF_FILE_PREVIEW_CODES.TOO_LARGE);
    }

    const text = decodeUtf8(bytes);
    const preview = {
      fileId,
      name: typeof entry.name === 'string' && entry.name ? entry.name : fileId,
      mime,
      format,
      text,
    };
    if (format === 'markdown') {
      const html = renderMarkdown(text, preview.name);
      if (html) preview.html = html;
    }
    return preview;
  }

  function read({ owner, sessionId, fileId } = {}) {
    if (typeof owner !== 'string' || !owner || owner.length > MAX_OWNER_CHARS) {
      return Promise.reject(previewError(HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE));
    }
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
      return Promise.reject(previewError(HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE));
    }
    if (typeof fileId !== 'string' || !FILE_ID.test(fileId)) {
      return Promise.reject(previewError(HANDOFF_FILE_PREVIEW_CODES.NOT_FOUND));
    }

    const key = `${createHash('sha256').update(owner).digest('hex')}/${sessionId}/${fileId}`;
    const running = inflight.get(key);
    if (running) return running;
    if (active >= HANDOFF_FILE_PREVIEW_LIMITS.maxConcurrent) {
      return Promise.reject(previewError(HANDOFF_FILE_PREVIEW_CODES.BUSY));
    }

    active += 1;
    const pending = readThroughReceipt(owner, sessionId, fileId).finally(() => {
      active -= 1;
      inflight.delete(key);
    });
    inflight.set(key, pending);
    return pending;
  }

  return { read };
}
