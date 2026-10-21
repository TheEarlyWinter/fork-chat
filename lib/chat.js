import { randomUUID } from "node:crypto";

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const ERROR_CODE_RE = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/;

// 通用敏感凭据模式（覆盖 Bearer、Authorization、password、api_key、token、secret、appSurfaceSession 等及 JSON 键值）
const SENSITIVE_PATTERN = /(Authorization\s*[:=]\s*(?:Bearer\s+)?[^\s,;"'&]+|Bearer\s+[A-Za-z0-9._~+/-]+=*|(?:password|api[_-]?key|token|secret|access[_-]?key|private[_-]?key|credential|appSurfaceSession|appIframeTicket)\s*[:=]\s*["']?[^\s,;"'&]+["']?|"*(?:password|api[_-]?key|token|secret|appSurfaceSession|appIframeTicket)"*\s*:\s*"[^"]+"|secret-[A-Za-z0-9_-]+|X-Hana-[A-Za-z0-9-]+:\s*[^;\r\n]+)/gi;

export function redactCredentials(text) {
  if (typeof text !== "string") return "";
  return text.replace(SENSITIVE_PATTERN, (match) => {
    if (match.toLowerCase().startsWith("bearer ")) {
      return "Bearer [REDACTED]";
    }
    const colonIdx = match.indexOf(":");
    const eqIdx = match.indexOf("=");
    const splitIdx = (colonIdx !== -1 && eqIdx !== -1) ? Math.min(colonIdx, eqIdx) : Math.max(colonIdx, eqIdx);
    if (splitIdx !== -1) {
      const prefix = match.slice(0, splitIdx + 1);
      return `${prefix}[REDACTED]`;
    }
    return "[REDACTED]";
  });
}

export function sanitizeErrorCode(code) {
  if (typeof code !== "string") return "INTERNAL_ERROR";
  const trimmed = code.trim();
  if (ERROR_CODE_RE.test(trimmed)) {
    return trimmed;
  }
  return "INTERNAL_ERROR";
}

export function sanitizeErrorMessage(msg, maxLen = 400) {
  if (typeof msg !== "string" && typeof msg !== "number") return "未知错误";
  const cleaned = redactCredentials(String(msg)).trim().replace(/[\r\n\t\0\x08\x1b]/g, " ");
  return cleaned.slice(0, maxLen);
}

function safeLogToken(val, maxLen = 64) {
  if (typeof val !== "string" && typeof val !== "number") return "";
  return redactCredentials(String(val).trim())
    .replace(/[\r\n\t\0\x08\x1b]/g, "")
    .slice(0, maxLen);
}

function formatEventCounts(counts) {
  if (!counts || typeof counts !== "object") return "";
  return Object.entries(counts)
    .filter(([type, count]) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(type) && Number.isSafeInteger(count) && count >= 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${type}:${count}`)
    .join(",");
}

export function extractAssistantText(assistant) {
  const content = assistant && typeof assistant === "object" ? assistant.content : null;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function countAssistantReasoningChars(assistant) {
  const content = assistant && typeof assistant === "object" ? assistant.content : null;
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, part) => (
    total + (part && part.type === "reasoning" && typeof part.reasoning === "string" ? part.reasoning.length : 0)
  ), 0);
}

export function getPrincipalInfo(c) {
  const ctx = typeof c?.get === "function" ? c.get("appRequestContext") : null;
  const principal = ctx?.principal;
  if (!principal || typeof principal !== "object") return null;

  const principalId = typeof (principal.principalId || principal.id) === "string" && (principal.principalId || principal.id).trim()
    ? (principal.principalId || principal.id).trim()
    : null;
  const credentialId = typeof principal.credentialId === "string" && principal.credentialId.trim()
    ? principal.credentialId.trim()
    : null;
  const kind = typeof principal.kind === "string" ? principal.kind.trim() : null;
  const appId = typeof (ctx.appId || principal.appId) === "string" && (ctx.appId || principal.appId).trim()
    ? (ctx.appId || principal.appId).trim()
    : null;

  if (!principalId && !credentialId) return null;

  return { principalId, credentialId, kind, appId };
}

export function canCancel(streamPrincipal, cancelPrincipal) {
  if (!cancelPrincipal || !streamPrincipal) return false;

  // appId 双方若均有值，必须完全相同，严禁跨 App 取消
  if (streamPrincipal.appId && cancelPrincipal.appId && streamPrincipal.appId !== cancelPrincipal.appId) {
    return false;
  }

  // 优先按 credentialId 校验（surface 隔离，同应用不同 surface 不能互相取消）
  if (streamPrincipal.credentialId) {
    return cancelPrincipal.credentialId === streamPrincipal.credentialId;
  }

  // 发起方无 credentialId 时，比对 principalId（必须非空且一致）
  if (streamPrincipal.principalId && cancelPrincipal.principalId) {
    return streamPrincipal.principalId === cancelPrincipal.principalId;
  }

  return false;
}

export function formatMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    if (!m || typeof m !== "object") return { role: "user", content: "" };
    if (m.role === "assistant") {
      if (Array.isArray(m.content)) {
        return {
          role: "assistant",
          content: m.content,
        };
      }
      return {
        role: "assistant",
        content: [{ type: "text", text: String(m.content || m.text || "") }],
      };
    }
    if (m.role === "toolResult") {
      return m;
    }
    if (typeof m.content === "string") {
      return { role: "user", content: m.content };
    }
    if (Array.isArray(m.content)) {
      return { role: "user", content: m.content };
    }
    return {
      role: "user",
      content: String(m.content || m.text || ""),
    };
  });
}

function logReceipt(sdk, info) {
  const safeReqId = safeLogToken(info.requestId, 100);
  const safeCardId = safeLogToken(info.cardId, 64);
  const parts = [
    `receipt`,
    safeReqId ? `requestId=${safeReqId}` : null,
    safeCardId ? `cardId=${safeCardId}` : null,
  ].filter(Boolean);

  const logMessage = `[chat-stream] ${parts.join(" ")}`;
  if (sdk?.logger?.info && typeof sdk.logger.info === "function") {
    try {
      void Promise.resolve(sdk.logger.info(logMessage)).catch(() => {});
    } catch {}
  }
}

function logStreamEnd(sdk, info) {
  const safeReqId = safeLogToken(info.requestId, 100);
  const safeCardId = safeLogToken(info.cardId, 64);
  const safeProvider = safeLogToken(info.provider, 64);
  const safeModel = safeLogToken(info.model, 64);
  const safeCode = info.errorCode ? sanitizeErrorCode(info.errorCode) : "";
  const eventTypes = formatEventCounts(info.eventCounts);
  const eventCount = Number.isSafeInteger(info.eventCount) && info.eventCount >= 0 ? info.eventCount : 0;
  const textChars = Number.isSafeInteger(info.textChars) && info.textChars >= 0 ? info.textChars : 0;
  const reasoningChars = Number.isSafeInteger(info.reasoningChars) && info.reasoningChars >= 0 ? info.reasoningChars : 0;

  const parts = [
    safeReqId ? `requestId=${safeReqId}` : null,
    safeCardId ? `cardId=${safeCardId}` : null,
    `provider=${safeProvider || "unknown"}`,
    `model=${safeModel || "unknown"}`,
    `durationMs=${info.durationMs}`,
    `terminal=${info.terminalStatus}`,
    `eventCount=${eventCount}`,
    `eventTypes=${eventTypes || "none"}`,
    `textChars=${textChars}`,
    `reasoningChars=${reasoningChars}`,
    `sawDone=${info.sawDone === true}`,
    safeCode ? `errorCode=${safeCode}` : null,
  ].filter(Boolean);

  const logMessage = `[chat-stream] ${parts.join(" ")}`;
  if (sdk?.logger?.info && typeof sdk.logger.info === "function") {
    try {
      void Promise.resolve(sdk.logger.info(logMessage)).catch(() => {});
    } catch {}
  }
}

export function createChatService(sdk, options = {}) {
  const {
    getAgentFullProfile,
    timeoutMs = 120000,
    clock = Date,
    tombstoneTtlMs = 130000,
    tombstoneCapacity = 1024,
  } = options;

  // 运行中的会话：requestId -> ActiveSession
  const inFlightRequests = new Map();

  // 有界预取消墓碑：tombstoneKey -> { expireAt, principal, requestId }
  const tombstones = new Map();

  function safeDeleteSession(requestId, session) {
    if (inFlightRequests.get(requestId) === session) {
      inFlightRequests.delete(requestId);
    }
  }

  function makeTombstoneKey(principal, requestId) {
    const appId = principal?.appId || "";
    const scope = principal?.credentialId ? `cred:${principal.credentialId}` : `princ:${principal?.principalId || ""}`;
    return `${appId}|${scope}|${requestId}`;
  }

  function pruneExpiredTombstones(now) {
    for (const [key, tombstone] of tombstones.entries()) {
      if (tombstone.expireAt <= now) {
        tombstones.delete(key);
      }
    }
  }

  function recordTombstone(principal, requestId) {
    const now = clock.now();
    pruneExpiredTombstones(now);

    const key = makeTombstoneKey(principal, requestId);
    if (tombstones.has(key)) {
      tombstones.delete(key);
    } else if (tombstones.size >= tombstoneCapacity) {
      const oldestKey = tombstones.keys().next().value;
      if (oldestKey !== undefined) {
        tombstones.delete(oldestKey);
      }
    }

    tombstones.set(key, {
      expireAt: now + tombstoneTtlMs,
      principal,
      requestId,
    });
  }

  function hasTombstone(principal, requestId) {
    const now = clock.now();
    pruneExpiredTombstones(now);
    const key = makeTombstoneKey(principal, requestId);
    const tombstone = tombstones.get(key);
    if (!tombstone) return false;
    if (tombstone.expireAt <= now) {
      tombstones.delete(key);
      return false;
    }
    return true;
  }

  async function handleCancel(c) {
    const cancelPrincipal = getPrincipalInfo(c);
    if (!cancelPrincipal) {
      return c.json({
        ok: false,
        error: "需要经过有效身份授权的请求",
        code: "APP_REQUEST_CONTEXT_REQUIRED",
        requestId: null,
      }, 403);
    }

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({
        ok: false,
        error: "请求体不是有效 JSON",
        code: "INVALID_JSON_BODY",
        requestId: null,
      }, 400);
    }

    const requestId = body?.requestId;
    if (typeof requestId !== "string" || !requestId.trim()) {
      return c.json({
        ok: false,
        error: "缺少有效 requestId",
        code: "INVALID_REQUEST_ID",
        requestId: typeof requestId === "string" ? requestId : null,
      }, 400);
    }

    const session = inFlightRequests.get(requestId);
    if (!session || session.hasCompleted) {
      // cancel 不存在或已终态：登记墓碑，返回 pending: true
      recordTombstone(cancelPrincipal, requestId);
      return c.json({ ok: true, cancelled: false, pending: true });
    }

    // 鉴权检查：发起方与取消方匹配验证
    if (!canCancel(session.principal, cancelPrincipal)) {
      return c.json({
        ok: false,
        error: "跨 Surface 或未授权的取消请求",
        code: "FORBIDDEN",
        requestId,
      }, 403);
    }

    // cancel 已有合法请求：同样登记墓碑防延迟重复 POST，立即取消
    recordTombstone(cancelPrincipal, requestId);
    session.triggerCancel("CLIENT_CANCEL");
    return c.json({ ok: true, cancelled: true });
  }

  async function handleStream(c) {
    const principal = getPrincipalInfo(c);
    if (!principal) {
      return c.json({
        ok: false,
        error: "需要经过有效身份授权的请求",
        code: "APP_REQUEST_CONTEXT_REQUIRED",
        requestId: null,
      }, 403);
    }

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({
        ok: false,
        error: "请求体不是有效 JSON",
        code: "INVALID_JSON_BODY",
        requestId: null,
      }, 400);
    }

    let requestId = body?.requestId;
    if (requestId !== undefined && requestId !== null && requestId !== "") {
      if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) {
        return c.json({
          ok: false,
          error: "requestId 格式无效（必须符合 [A-Za-z0-9_-]{1,100}）",
          code: "INVALID_REQUEST_ID",
          requestId: typeof requestId === "string" ? requestId.slice(0, 100) : null,
        }, 400);
      }
    } else {
      requestId = randomUUID();
    }

    const cardId = typeof body?.cardId === "string" ? body.cardId : (c.req?.query ? c.req.query("cardId") : undefined);
    const startTime = clock.now();

    // 检查预取消墓碑：在注册和 profile/model 调用前拦截
    if (hasTombstone(principal, requestId)) {
      logStreamEnd(sdk, {
        requestId,
        cardId,
        provider: "",
        model: "",
        durationMs: clock.now() - startTime,
        terminalStatus: "cancelled",
        errorCode: "REQUEST_CANCELLED",
      });
      return c.json({
        ok: false,
        error: "请求已被取消",
        code: "REQUEST_CANCELLED",
        requestId,
      }, 499);
    }

    // 运行中并发去重校验
    if (inFlightRequests.has(requestId)) {
      return c.json({
        ok: false,
        error: "该请求已在处理中",
        code: "REQUEST_CONFLICT",
        requestId,
      }, 409);
    }

    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return c.json({
        ok: false,
        error: "messages 必须是非空数组",
        code: "INVALID_MESSAGES",
        requestId,
      }, 400);
    }

    const abortController = new AbortController();

    let hasCancelled = false;
    let hasCompleted = false;
    let isTimedOut = false;
    let cancelModelPromise = null;

    async function invokeModelCancel() {
      if (!cancelModelPromise) {
        cancelModelPromise = (async () => {
          try {
            if (sdk?.models?.cancel && typeof sdk.models.cancel === "function") {
              await sdk.models.cancel(requestId);
            }
          } catch {
            // best-effort 捕获
          }
        })();
      }
      return cancelModelPromise;
    }

    let timeoutTimer = null;
    let onReqAbort = null;

    const cleanup = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      const reqSignal = c.req?.raw?.signal || c.req?.signal;
      if (reqSignal && onReqAbort) {
        reqSignal.removeEventListener("abort", onReqAbort);
        onReqAbort = null;
      }
    };

    const session = {
      requestId,
      principal,
      cardId,
      provider: "",
      model: "",
      startTime,
      get hasCompleted() {
        return hasCompleted;
      },
      get hasCancelled() {
        return hasCancelled;
      },
      get isTimedOut() {
        return isTimedOut;
      },
      triggerCancel(reason) {
        if (hasCompleted || hasCancelled) return;
        hasCancelled = true;
        abortController.abort(new Error(reason || "REQUEST_CANCELLED"));
        void invokeModelCancel().catch(() => {});
      },
      cleanup,
    };

    inFlightRequests.set(requestId, session);

    // 请求到达并预留 requestId：记录 receipt 日志
    logReceipt(sdk, { requestId, cardId });

    // 服务端总超时监控：即时中断并产生终态，再后台 best-effort 取消
    timeoutTimer = setTimeout(() => {
      if (hasCompleted) return;
      isTimedOut = true;
      hasCancelled = true;
      abortController.abort(new Error("REQUEST_TIMEOUT"));
      void invokeModelCancel().catch(() => {});
    }, timeoutMs);

    // 客户端连接中断监控
    const reqSignal = c.req?.raw?.signal || c.req?.signal;
    if (reqSignal) {
      if (reqSignal.aborted) {
        session.cleanup();
        safeDeleteSession(requestId, session);
        void invokeModelCancel().catch(() => {});
        logStreamEnd(sdk, {
          requestId,
          cardId,
          provider: "",
          model: "",
          durationMs: clock.now() - startTime,
          terminalStatus: "cancelled",
          errorCode: "REQUEST_ABORTED",
        });
        return c.json({
          ok: false,
          error: "客户端已中断连接",
          code: "REQUEST_ABORTED",
          requestId,
        }, 499);
      }
      onReqAbort = () => {
        if (hasCompleted) return;
        hasCancelled = true;
        abortController.abort(new Error("CLIENT_ABORT"));
        void invokeModelCancel().catch(() => {});
      };
      reqSignal.addEventListener("abort", onReqAbort, { once: true });
    }

    // Profile 读取 / 准备阶段（具有超时与取消边界）
    let provider = "";
    let model = "";
    let finalSystemPrompt = body?.systemPrompt || "你是专业、敏锐、逻辑严密的智能分析助手。回答要条理清晰、直击核心、不讲套话废话。";

    if (body?.agentId) {
      try {
        if (typeof getAgentFullProfile !== "function") {
          throw { code: "AGENT_PROFILE_UNAVAILABLE", message: "宿主未提供助手资料查询服务" };
        }

        const profilePromise = getAgentFullProfile(body.agentId);
        const abortPromise = new Promise((_, reject) => {
          if (abortController.signal.aborted) {
            reject(abortController.signal.reason);
            return;
          }
          abortController.signal.addEventListener("abort", () => reject(abortController.signal.reason), { once: true });
        });

        const agentProfile = await Promise.race([profilePromise, abortPromise]);
        if (!agentProfile) {
          throw { code: "AGENT_PROFILE_UNAVAILABLE", message: `宿主未返回助手 ${body.agentId} 资料` };
        }
        const trimmedProvider = typeof agentProfile.provider === "string" ? agentProfile.provider.trim() : "";
        const trimmedModel = typeof agentProfile.model === "string" ? agentProfile.model.trim() : "";
        if (!trimmedProvider || !trimmedModel) {
          throw { code: "AGENT_MODEL_UNCONFIGURED", message: `助手 ${body.agentId} 未配置有效对话模型` };
        }

        provider = trimmedProvider;
        model = trimmedModel;
        session.provider = provider;
        session.model = model;

        if (agentProfile.systemPrompt) {
          finalSystemPrompt = `${agentProfile.systemPrompt}\n\n[回答指引]：请完全沉浸并严格保持你的身份设定、语言习惯、语气和性格特征，针对用户的对话内容给出真实、自然的回应。`;
        }
      } catch (err) {
        session.cleanup();
        safeDeleteSession(requestId, session);
        if (abortController.signal.aborted) {
          const timeout = isTimedOut;
          const code = timeout ? "REQUEST_TIMEOUT" : "REQUEST_CANCELLED";
          logStreamEnd(sdk, {
            requestId,
            cardId,
            provider,
            model,
            durationMs: clock.now() - startTime,
            terminalStatus: timeout ? "error" : "cancelled",
            errorCode: code,
          });
          return c.json({
            ok: false,
            error: timeout ? "请求超时" : "请求已被取消",
            code,
            requestId,
          }, timeout ? 504 : 499);
        }
        const errCode = sanitizeErrorCode(err?.code || "AGENT_PROFILE_UNAVAILABLE");
        const safeErrMsg = sanitizeErrorMessage(err?.message || err || "助手资料不可用", 400);
        logStreamEnd(sdk, {
          requestId,
          cardId,
          provider,
          model,
          durationMs: clock.now() - startTime,
          terminalStatus: "error",
          errorCode: errCode,
        });
        return c.json({
          ok: false,
          error: safeErrMsg,
          code: errCode,
          requestId,
        }, 422);
      }
    } else if (typeof body?.modelRef === "string" && body.modelRef.includes("/")) {
      const slash = body.modelRef.indexOf("/");
      provider = body.modelRef.slice(0, slash).trim();
      model = body.modelRef.slice(slash + 1).trim();
      if (!provider || !model) {
        session.cleanup();
        safeDeleteSession(requestId, session);
        logStreamEnd(sdk, {
          requestId,
          cardId,
          provider,
          model,
          durationMs: clock.now() - startTime,
          terminalStatus: "error",
          errorCode: "INVALID_MODEL_REF",
        });
        return c.json({
          ok: false,
          error: "modelRef 格式必须为 provider/model",
          code: "INVALID_MODEL_REF",
          requestId,
        }, 400);
      }
      session.provider = provider;
      session.model = model;
    } else {
      session.cleanup();
      safeDeleteSession(requestId, session);
      logStreamEnd(sdk, {
        requestId,
        cardId,
        provider,
        model,
        durationMs: clock.now() - startTime,
        terminalStatus: "error",
        errorCode: "INVALID_MODEL_REF",
      });
      return c.json({
        ok: false,
        error: "必须指定有效 agentId 或 modelRef (格式 provider/model)",
        code: "INVALID_MODEL_REF",
        requestId,
      }, 400);
    }

    const formattedMessages = formatMessages(messages);

    // 不在 App 层覆盖用户/宿主的 reasoning 选择。真实 Provider 终态仍以
    // SDK 的 done/error 为准；正文存在不能把 error 伪装成成功。

    // 构造 NDJSON 响应流
    const encoder = new TextEncoder();
    let terminalEmitted = false;
    let controllerClosed = false;
    let eventCount = 0;
    let textChars = 0;
    let reasoningChars = 0;
    let sawDone = false;
    const eventCounts = Object.create(null);

    const recordEvent = (event) => {
      eventCount += 1;
      const type = typeof event?.type === "string" ? event.type : "unknown";
      eventCounts[type] = (eventCounts[type] || 0) + 1;
    };

    const streamDiagnostics = () => ({
      eventCount,
      eventCounts,
      textChars,
      reasoningChars,
      sawDone,
    });

    const stream = new ReadableStream({
      start(controller) {
        let iterator = null;
        let iteratorReleased = false;
        let handleAbort = null;

        const cleanupAbortListener = () => {
          if (handleAbort) {
            abortController.signal.removeEventListener("abort", handleAbort);
            handleAbort = null;
          }
        };

        const releaseIterator = () => {
          if (iteratorReleased) return;
          iteratorReleased = true;
          if (iterator && typeof iterator.return === "function") {
            try {
              void Promise.resolve(iterator.return()).catch(() => {});
            } catch {}
          }
        };

        const sendFrame = (frame) => {
          if (controllerClosed) return;
          try {
            controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
          } catch {
            controllerClosed = true;
          }
        };

        const emitTerminal = (terminalFrame, terminalStatus, errorCode) => {
          if (terminalEmitted) return;
          terminalEmitted = true;
          hasCompleted = true;

          cleanupAbortListener();
          releaseIterator();

          sendFrame(terminalFrame);

          if (!controllerClosed) {
            try {
              controller.close();
            } catch {}
            controllerClosed = true;
          }

          logStreamEnd(sdk, {
            requestId,
            cardId,
            provider,
            model,
            durationMs: clock.now() - startTime,
            terminalStatus,
            errorCode,
            ...streamDiagnostics(),
          });
        };

        // 首帧固定发送 start 事件展示实际绑定
        sendFrame({
          type: "start",
          requestId,
          provider,
          model,
        });

        // 独立 Abort 监听：不依赖 pump 迭代器的回到，即时发射终态并释放 map
        handleAbort = () => {
          if (terminalEmitted) return;
          if (isTimedOut) {
            emitTerminal(
              { type: "error", requestId, code: "REQUEST_TIMEOUT", message: "请求处理超时" },
              "error",
              "REQUEST_TIMEOUT"
            );
          } else {
            emitTerminal(
              { type: "cancelled", requestId, code: "REQUEST_CANCELLED", message: "请求已被取消" },
              "cancelled",
              "REQUEST_CANCELLED"
            );
          }
          session.cleanup();
          safeDeleteSession(requestId, session);
        };

        if (abortController.signal.aborted) {
          handleAbort();
          return;
        }
        abortController.signal.addEventListener("abort", handleAbort, { once: true });

        // 解耦的异步泵，不返回 Promise，不阻塞 start
        async function runPump() {
          let hasTextDelta = false;
          let sawModelDoneEvent = false;
          let sawReasoningDelta = false;

          try {
            if (!sdk?.models || typeof sdk.models.streamEvents !== "function") {
              throw { code: "MODELS_NOT_AVAILABLE", message: "SDK 模型流推理接口不可用" };
            }

            const input = {
              requestId,
              provider,
              model,
              messages: formattedMessages,
              systemPrompt: finalSystemPrompt,
            };

            const asyncIterable = sdk.models.streamEvents(input, { signal: abortController.signal });
            iterator = asyncIterable?.[Symbol.asyncIterator]?.() || null;
            if (!iterator) {
              throw { code: "MODEL_STREAM_INVALID", message: "模型流未返回有效迭代器" };
            }

            const abortPromise = new Promise((resolve) => {
              if (abortController.signal.aborted) {
                resolve({ done: true, value: undefined, aborted: true });
                return;
              }
              abortController.signal.addEventListener("abort", () => {
                resolve({ done: true, value: undefined, aborted: true });
              }, { once: true });
            });

            while (!terminalEmitted && !abortController.signal.aborted) {
              const step = await Promise.race([
                iterator.next(),
                abortPromise,
              ]);

              if (step.aborted || terminalEmitted || abortController.signal.aborted) {
                break;
              }

              if (step.done) {
                break;
              }

              const event = step.value;
              if (!event || typeof event !== "object") continue;
              recordEvent(event);

              if (event.requestId !== undefined && event.requestId !== requestId) {
                throw {
                  code: "APP_MODEL_STREAM_IDENTITY",
                  message: "The model stream changed request identity.",
                };
              }

              if (event.type === "text-delta" && typeof event.delta === "string") {
                hasTextDelta = true;
                textChars += event.delta.length;
                sendFrame({
                  type: "text-delta",
                  requestId,
                  delta: event.delta,
                });
              } else if (event.type === "reasoning-delta" && typeof event.delta === "string") {
                sawReasoningDelta = true;
                reasoningChars += event.delta.length;
              } else if (event.type === "done") {
                sawModelDoneEvent = true;
                sawDone = true;
                if (!sawReasoningDelta) reasoningChars += countAssistantReasoningChars(event.assistant);
                if (!hasTextDelta) {
                  const doneText = extractAssistantText(event.assistant);
                  if (doneText) {
                    hasTextDelta = true;
                    textChars += doneText.length;
                    sendFrame({
                      type: "text-delta",
                      requestId,
                      delta: doneText,
                    });
                  }
                }
                break;
              } else if (event.type === "error") {
                throw event;
              }
            }

            if (terminalEmitted || abortController.signal.aborted) {
              return;
            }

            if (!sawModelDoneEvent) {
              emitTerminal(
                { type: "error", requestId, code: "STREAM_INCOMPLETE", message: "模型流异常中断（EOF 未完成）" },
                "error",
                "STREAM_INCOMPLETE"
              );
            } else if (!hasTextDelta) {
              emitTerminal(
                { type: "error", requestId, code: "EMPTY_RESPONSE", message: "模型未返回正文内容" },
                "error",
                "EMPTY_RESPONSE"
              );
            } else {
              emitTerminal(
                { type: "done", requestId },
                "done"
              );
            }
          } catch (err) {
            if (terminalEmitted || abortController.signal.aborted) {
              return;
            }
            const rawCode = err?.code || "MODEL_STREAM_ERROR";
            const sanitizedCode = sanitizeErrorCode(rawCode);
            const safeMessage = sanitizeErrorMessage(err?.message || err || "推理过程异常", 400);
            emitTerminal(
              { type: "error", requestId, code: sanitizedCode, message: safeMessage },
              "error",
              sanitizedCode
            );
          } finally {
            cleanupAbortListener();
            releaseIterator();
            session.cleanup();
            safeDeleteSession(requestId, session);
            hasCompleted = true;
          }
        }

        void runPump();
      },
      cancel(reason) {
        controllerClosed = true;
        if (!hasCompleted && !hasCancelled) {
          hasCancelled = true;
          abortController.abort(new Error(String(reason || "STREAM_CANCEL")));
          void invokeModelCancel().catch(() => {});
        }
        session.cleanup();
        safeDeleteSession(requestId, session);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  return {
    handleStream,
    handleCancel,
    inFlightRequests,
    tombstones,
  };
}
