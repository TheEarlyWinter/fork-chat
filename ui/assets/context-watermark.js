/** Pure request-projection budget. No DOM, SDK, storage, model summarization or history mutation. */
export const CONTEXT_WATERMARK_DEFAULTS = Object.freeze({ maxMessages: 256, maxBytes: 512 * 1024, targetMessages: 192, targetBytes: 384 * 1024 });
const clamp = (value, fallback, ceiling) => typeof value === 'number' && Number.isFinite(value) && value >= 1
  ? Math.min(Math.floor(value), ceiling) : Math.min(fallback, ceiling);
export function resolveContextLimits(value = {}) {
  const options = value && typeof value === 'object' ? value : {};
  const d = CONTEXT_WATERMARK_DEFAULTS;
  const maxMessages = clamp(options.maxMessages, d.maxMessages, d.maxMessages);
  const maxBytes = Math.max(2, clamp(options.maxBytes, d.maxBytes, d.maxBytes));
  return { maxMessages, maxBytes, targetMessages: clamp(options.targetMessages, d.targetMessages, maxMessages), targetBytes: clamp(options.targetBytes, d.targetBytes, maxBytes) };
}

/** Exact JSON string payload bytes, without allocating escaped text; limit+1 means saturated. */
export function jsonEscapedBytes(parts, limit = Infinity) {
  let bytes = 0, high = false;
  for (const part of parts) {
    if (typeof part !== 'string') throw new TypeError('context parts must be strings');
    for (let i = 0; i < part.length; i++) {
      const ch = part.charCodeAt(i);
      if (high) {
        high = false;
        if (ch >= 0xdc00 && ch <= 0xdfff) {
          bytes += 4;
          if (bytes > limit) return limit + 1;
          continue;
        }
        bytes += 6;
        if (bytes > limit) return limit + 1;
      }
      if (ch >= 0xd800 && ch <= 0xdbff) { high = true; continue; }
      if (ch === 34 || ch === 92 || ch === 8 || ch === 9 || ch === 10 || ch === 12 || ch === 13) bytes += 2;
      else if (ch < 32 || ch >= 0xdc00 && ch <= 0xdfff) bytes += 6;
      else bytes += ch < 128 ? 1 : ch < 2048 ? 2 : 3;
      if (bytes > limit) return limit + 1;
    }
  }
  if (high) bytes += 6;
  return bytes > limit ? limit + 1 : bytes;
}

function project(entry, limit) {
  if (!entry || !['user', 'assistant'].includes(entry.role) || typeof entry.parts !== 'function') throw new TypeError('invalid context entry');
  const overhead = JSON.stringify({ role: entry.role, content: '' }).length;
  if (overhead > limit) return null;
  const parts = entry.parts();
  if (!Array.isArray(parts)) throw new TypeError('context parts must be an array');
  const payload = jsonEscapedBytes(parts, limit - overhead);
  if (payload + overhead > limit) return null;
  return { message: { role: entry.role, content: parts.join('') }, bytes: overhead + payload };
}

/** Groups are chronological whole turns, entries hold lazy parts(). Newest contiguous suffix only. */
export function applyContextWatermark({ groups = [], pending = null, limits: requested } = {}) {
  const limits = resolveContextLimits(requested);
  const total = groups.reduce((sum, group) => sum + group.length, pending ? 1 : 0);
  let wireBytes = 2, count = 0, visitedMessages = 0;
  const protectedMessage = pending ? project(pending, limits.maxBytes - 2) : null;
  if (pending && !protectedMessage) return {
    messages: [], errors: [{ code: 'CONTEXT_PENDING_TOO_LARGE', message: '本次问题及显式引用超过上下文硬上限；请缩短问题、附件或引用，未发送部分内容', limit: limits.maxBytes }],
    stats: { wireBytes: 2, projectedMessageCount: total, retainedMessageCount: 0, omittedMessageCount: 0, watermarked: false, visitedMessages: 0, limits },
  };
  if (protectedMessage) { wireBytes += protectedMessage.bytes; count = 1; }
  const selected = [];
  let overflow = false;
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (!group.length) continue;
    if (count + group.length > limits.maxMessages) { overflow = true; break; }
    const commas = group.length - (count ? 0 : 1);
    let available = limits.maxBytes - wireBytes - commas, size = 0;
    const projected = [];
    for (const entry of group) {
      visitedMessages++;
      const value = project(entry, available - size);
      if (!value) { overflow = true; break; }
      projected.push(value.message); size += value.bytes;
    }
    if (overflow) break;
    selected.push({ messages: projected, bytes: size });
    count += group.length; wireBytes += size + commas;
  }
  if (overflow) {
    const targetCount = Math.max(limits.targetMessages, protectedMessage ? 1 : 0);
    const targetBytes = Math.max(limits.targetBytes, protectedMessage ? protectedMessage.bytes + 2 : 2);
    while (selected.length && (count > targetCount || wireBytes > targetBytes)) {
      const oldest = selected.pop(), remaining = count - oldest.messages.length;
      wireBytes -= oldest.bytes + oldest.messages.length - (remaining ? 0 : 1);
      count = remaining;
    }
  }
  const messages = selected.reverse().flatMap(group => group.messages);
  if (protectedMessage) messages.push(protectedMessage.message);
  return { messages, errors: [], stats: {
    wireBytes, projectedMessageCount: total, retainedMessageCount: count, omittedMessageCount: total - count,
    watermarked: count < total, visitedMessages, limits,
  } };
}

/** Server-side fail-closed gate; never silently trims caller-supplied initial messages. */
export function contextRequestLimitError(messages) {
  const limits = CONTEXT_WATERMARK_DEFAULTS;
  if (messages.length > limits.maxMessages) return { code: 'CONTEXT_REQUEST_TOO_LARGE', message: `请求消息数超过${limits.maxMessages}条上下文上限`, limit: limits.maxMessages };
  const serialized = JSON.stringify(messages);
  // JSON text itself has no unescaped control characters; UTF-8 bytes, not UTF-16 length.
  if (new TextEncoder().encode(serialized).byteLength > limits.maxBytes) return { code: 'CONTEXT_REQUEST_TOO_LARGE', message: `请求上下文超过${limits.maxBytes}字节上限`, limit: limits.maxBytes };
  return null;
}
