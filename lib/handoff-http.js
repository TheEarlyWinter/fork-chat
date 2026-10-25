/**
 * 交接 HTTP 边界：流式字节上限、JSON/UTF-8 校验、稳定错误响应。
 * 不把 SDK/FS 原文、details 或路径写回客户端。
 */
import { HANDOFF_LIMITS } from '../ui/assets/fork-handoff-contract.js';

export const PREPARE_MAX_BODY_BYTES = HANDOFF_LIMITS.maxPrepareJsonBytes;
export const CONFIRM_MAX_BODY_BYTES = 4096;

/** 已知错误码的固定状态与固定安全文案；表外一律 HANDOFF_INTERNAL/500 */
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

const MESSAGE_BY_CODE = Object.freeze({
  HANDOFF_INVALID_REQUEST: '请求格式不合法',
  HANDOFF_INVALID_CONTEXT: '交接内容未通过校验',
  HANDOFF_INVALID_ARTIFACT: '产物校验未通过',
  HANDOFF_INVALID_SNAPSHOT: '交接快照未通过校验',
  HANDOFF_INVALID_AGENT: '目标助手不存在或已停用',
  HANDOFF_INVALID_NEXT_STEP: '下一步内容未通过校验',
  HANDOFF_TARGET_MISSING: '目标卡片不存在',
  HANDOFF_UNSUPPORTED: '当前宿主不支持分支交接',
  HANDOFF_PERMISSION_MISSING: '缺少分支交接所需授权',
  HANDOFF_BUSY: '当前有其它交接正在确认，请稍后重试',
  HANDOFF_ACTION_NOT_FOUND: '交接动作不存在或不属于当前调用方',
  HANDOFF_ACTION_UNKNOWN: '动作状态暂时无法读取，请按原 actionId 查询',
  HANDOFF_ACTION_EXPIRED: '动作已过期，需要重新准备',
  HANDOFF_QUOTA_EXCEEDED: '交接额度已满，请稍后重试',
  HANDOFF_STORE_IO: '动作状态未能可靠保存',
  HANDOFF_STORE_CORRUPT: '动作记录损坏，已停止操作',
  HANDOFF_PAYLOAD_CORRUPT: '动作载荷损坏，已停止操作',
  HANDOFF_HOST_ERROR: '宿主调用失败',
  HANDOFF_ARTIFACT_UNAVAILABLE: '产物不可读取',
  HANDOFF_INTERNAL: '请求未执行',
  ARTIFACT_FORBIDDEN: '无权访问该产物',
  ARTIFACT_STABLE_ID_REQUIRED: '产物标识不稳定',
});

const FALLBACK_MESSAGE = '请求未执行';
/** 只信任本模块创建的 httpError；上游随便带 HANDOFF_ code 不能借此透传原文 */
const LOCAL_HTTP_ERROR = Symbol('handoffHttpError');

export function httpError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status ?? STATUS_BY_CODE[code] ?? 400;
  error[LOCAL_HTTP_ERROR] = true;
  return error;
}

function knownCode(error) {
  const code = typeof error?.code === 'string' ? error.code : null;
  if (!code || STATUS_BY_CODE[code] === undefined) return null;
  return code;
}

function shorten(message) {
  return typeof message === 'string' && message.length > 0 && message.length <= 200 ? message : null;
}

/**
 * 本地错误保留自己的短文案（以及显式状态，如 413）；
 * 其它来源只按已知 code 枚举映射固定文案与状态，未知 code/status 不任意回传。
 */
function resolveError(error) {
  const local = error?.[LOCAL_HTTP_ERROR] === true;
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.code) ? error.code : null;
  // 本地错误码与状态由本模块控制：保留自己的短文案与显式状态（如 413）
  if (local) {
    const explicit = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599;
    return {
      code: code ?? 'HANDOFF_INTERNAL',
      status: explicit ? error.status : (code ? STATUS_BY_CODE[code] : undefined) ?? 500,
      message: shorten(error.message)
        ?? (code ? MESSAGE_BY_CODE[code] : undefined)
        ?? FALLBACK_MESSAGE,
    };
  }
  // 其它来源只按已知 code 枚举映射；未知 code/status 一律不任意回传
  const known = knownCode(error);
  if (known) return { code: known, status: STATUS_BY_CODE[known], message: MESSAGE_BY_CODE[known] };
  return { code: 'HANDOFF_INTERNAL', status: 500, message: FALLBACK_MESSAGE };
}

export function fail(c, error) {
  const resolved = resolveError(error);
  return c.json({ ok: false, code: resolved.code, error: resolved.message }, resolved.status);
}

/** 流式读 JSON：以实际字节为准，不信 Content-Length；非法 UTF-8/JSON 明确失败 */
export async function readJsonBody(c, maxBytes) {
  // 只接受有界 raw stream；没有流就按非法请求拒绝，绝不先无界缓冲再测尺寸
  const reader = c.req?.raw?.body?.getReader?.();
  if (!reader) throw httpError('HANDOFF_INVALID_REQUEST', '请求体缺少可读的流', 400);

  const chunks = [];
  let total = 0;
  let bytes;
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
