/**
 * 交接 HTTP 边界：流式字节上限、JSON/UTF-8 校验、稳定错误响应。
 * 不把 SDK/FS 原文、details 或路径写回客户端。
 */
import { HANDOFF_LIMITS } from '../ui/assets/fork-handoff-contract.js';

export const PREPARE_MAX_BODY_BYTES = HANDOFF_LIMITS.maxPrepareJsonBytes;
export const CONFIRM_MAX_BODY_BYTES = 4096;

const STATUS_BY_CODE = Object.freeze({
  HANDOFF_INVALID_REQUEST: 400,
  HANDOFF_INVALID_CONTEXT: 400,
  HANDOFF_INVALID_ARTIFACT: 400,
  HANDOFF_INVALID_SNAPSHOT: 400,
  HANDOFF_INVALID_AGENT: 400,
  HANDOFF_INVALID_NEXT_STEP: 400,
  HANDOFF_TARGET_MISSING: 400,
  HANDOFF_UNSUPPORTED: 409,
  HANDOFF_PERMISSION_MISSING: 403,
  HANDOFF_BUSY: 409,
  HANDOFF_ACTION_NOT_FOUND: 404,
  HANDOFF_ACTION_UNKNOWN: 409,
  HANDOFF_ACTION_EXPIRED: 410,
  HANDOFF_QUOTA_EXCEEDED: 409,
  HANDOFF_STORE_IO: 500,
  HANDOFF_STORE_CORRUPT: 500,
  HANDOFF_PAYLOAD_CORRUPT: 500,
  HANDOFF_HOST_ERROR: 502,
  HANDOFF_ARTIFACT_UNAVAILABLE: 409,
  HANDOFF_INTERNAL: 500,
  ARTIFACT_FORBIDDEN: 403,
  ARTIFACT_STABLE_ID_REQUIRED: 403,
});

export function httpError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status ?? STATUS_BY_CODE[code] ?? 400;
  return error;
}

function safeMessage(error) {
  if (error?.name === 'HandoffError' || error?.code?.startsWith?.('HANDOFF_') || error?.status) {
    return typeof error.message === 'string' && error.message.length <= 200 ? error.message : '请求未执行';
  }
  return '请求未执行';
}

export function fail(c, error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.code)
    ? error.code
    : 'HANDOFF_INTERNAL';
  const status = error?.status ?? STATUS_BY_CODE[code] ?? 500;
  return c.json({ ok: false, code, error: safeMessage(error) }, status);
}

/** 流式读 JSON：以实际字节为准，不信 Content-Length；非法 UTF-8/JSON 明确失败 */
export async function readJsonBody(c, maxBytes) {
  let bytes;
  const raw = c.req?.raw;
  if (raw?.body?.getReader) {
    const reader = raw.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        total += item.value.byteLength;
        if (total > maxBytes) throw httpError('HANDOFF_INVALID_REQUEST', '请求体超过上限', 413);
        chunks.push(Buffer.from(item.value));
      }
      bytes = Buffer.concat(chunks);
    } finally {
      void reader.cancel?.().catch?.(() => {});
      reader.releaseLock?.();
    }
  } else if (typeof c.req?.arrayBuffer === 'function') {
    const buffer = await c.req.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw httpError('HANDOFF_INVALID_REQUEST', '请求体超过上限', 413);
    bytes = Buffer.from(buffer);
  } else {
    const value = await c.req.json();
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw httpError('HANDOFF_INVALID_REQUEST', '请求体超过上限', 413);
    return value;
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw httpError('HANDOFF_INVALID_REQUEST', '请求体不是有效 UTF-8', 400);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw httpError('HANDOFF_INVALID_REQUEST', '请求体不是有效 JSON', 400);
  }
}


