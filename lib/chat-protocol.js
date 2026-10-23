/** Chat wire projection and diagnostics. No SDK, HTTP context, or request ownership. */
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const ERROR_CODE_RE = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/;
const SENSITIVE_PATTERN = /(Authorization\s*[:=]\s*(?:Bearer\s+)?[^\s,;"'&]+|Bearer\s+[A-Za-z0-9._~+/-]+=*|(?:password|api[_-]?key|token|secret|access[_-]?key|private[_-]?key|credential|appSurfaceSession|appIframeTicket)\s*[:=]\s*["']?[^\s,;"'&]+["']?|"*(?:password|api[_-]?key|token|secret|appSurfaceSession|appIframeTicket)"*\s*:\s*"[^"]+"|secret-[A-Za-z0-9_-]+|X-Hana-[A-Za-z0-9-]+:\s*[^;\r\n]+)/gi;

export function redactCredentials(text) {
  if (typeof text !== 'string') return '';
  return text.replace(SENSITIVE_PATTERN, match => {
    if (match.toLowerCase().startsWith('bearer ')) return 'Bearer [REDACTED]';
    const colon = match.indexOf(':'), equals = match.indexOf('=');
    const split = colon !== -1 && equals !== -1 ? Math.min(colon, equals) : Math.max(colon, equals);
    return split !== -1 ? `${match.slice(0, split + 1)}[REDACTED]` : '[REDACTED]';
  });
}

export function sanitizeErrorCode(code) {
  if (typeof code !== 'string') return 'INTERNAL_ERROR';
  const trimmed = code.trim();
  return ERROR_CODE_RE.test(trimmed) ? trimmed : 'INTERNAL_ERROR';
}

export function sanitizeErrorMessage(message, maxLen = 400) {
  if (typeof message !== 'string' && typeof message !== 'number') return '未知错误';
  return redactCredentials(String(message)).trim().replace(/[\r\n\t\0\x08\x1b]/g, ' ').slice(0, maxLen);
}

function safeLogToken(value, maxLen = 64) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return redactCredentials(String(value).trim()).replace(/[\r\n\t\0\x08\x1b]/g, '').slice(0, maxLen);
}

function formatEventCounts(counts) {
  if (!counts || typeof counts !== 'object') return '';
  return Object.entries(counts)
    .filter(([type, count]) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(type) && Number.isSafeInteger(count) && count >= 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${type}:${count}`).join(',');
}

export function extractAssistantText(assistant) {
  const content = assistant && typeof assistant === 'object' ? assistant.content : null;
  return Array.isArray(content)
    ? content.filter(part => part && part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('')
    : '';
}

export function countAssistantReasoningChars(assistant) {
  const content = assistant && typeof assistant === 'object' ? assistant.content : null;
  return Array.isArray(content)
    ? content.reduce((sum, part) => sum + (part && part.type === 'reasoning' && typeof part.reasoning === 'string' ? part.reasoning.length : 0), 0)
    : 0;
}

export function formatMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(message => {
    if (!message || typeof message !== 'object') return { role: 'user', content: '' };
    if (message.role === 'assistant') return {
      role: 'assistant',
      content: Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content || message.text || '') }],
    };
    if (message.role === 'toolResult') return message;
    if (typeof message.content === 'string' || Array.isArray(message.content)) return { role: 'user', content: message.content };
    return { role: 'user', content: String(message.content || message.text || '') };
  });
}

function writeInfo(logger, message) {
  if (typeof logger?.info !== 'function') return;
  try { void Promise.resolve(logger.info(message)).catch(() => {}); } catch { /* logging never owns a request */ }
}

export function logReceipt(logger, info) {
  const requestId = safeLogToken(info.requestId, 100), cardId = safeLogToken(info.cardId, 64);
  writeInfo(logger, `[chat-stream] ${['receipt', requestId ? `requestId=${requestId}` : null, cardId ? `cardId=${cardId}` : null].filter(Boolean).join(' ')}`);
}

export function logStreamEnd(logger, info) {
  const requestId = safeLogToken(info.requestId, 100), cardId = safeLogToken(info.cardId, 64);
  const provider = safeLogToken(info.provider), model = safeLogToken(info.model);
  const eventTypes = formatEventCounts(info.eventCounts);
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const parts = [
    requestId ? `requestId=${requestId}` : null,
    cardId ? `cardId=${cardId}` : null,
    `provider=${provider || 'unknown'}`, `model=${model || 'unknown'}`,
    `durationMs=${info.durationMs}`, `terminal=${info.terminalStatus}`,
    `eventCount=${count(info.eventCount)}`, `eventTypes=${eventTypes || 'none'}`,
    `textChars=${count(info.textChars)}`, `reasoningChars=${count(info.reasoningChars)}`,
    `sawDone=${info.sawDone === true}`,
    info.errorCode ? `errorCode=${sanitizeErrorCode(info.errorCode)}` : null,
  ].filter(Boolean);
  writeInfo(logger, `[chat-stream] ${parts.join(' ')}`);
}
