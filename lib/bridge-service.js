/**
 * 桥接服务：把 session-bridge / bridge-outbox 挂到已鉴权路由上。
 *
 * 三条自我约束：
 * - 身份只取宿主盖章的 request context，不读 header、不退回共享字符串。
 * - 预览与确认分开：预览永远不产生副作用。
 * - 回传正文只留在 App 私有准备区，路由只回状态与引用。
 */
import { getDocumentOwner } from "./document-service.js";
import { createSessionBridge } from "./session-bridge.js";
import { createBridgeOutbox } from "./bridge-outbox.js";
import { BRIDGE_LIMITS, bridgeError } from "./bridge-contract.js";

const MAX_BODY_BYTES = 320 * 1024;

async function readJson(c) {
  const raw = c.req.raw;
  if (raw?.body?.getReader) {
    const reader = raw.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > MAX_BODY_BYTES) throw Object.assign(new Error("请求体过大"), { status: 413 });
        chunks.push(Buffer.from(item.value));
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const value = await c.req.json();
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BODY_BYTES) {
    throw Object.assign(new Error("请求体过大"), { status: 413 });
  }
  return value;
}

const STATUS_BY_CODE = {
  permission_missing: 403,
  surface_unsupported: 409,
  session_not_found: 404,
  session_not_addressable: 400,
  entry_not_mappable: 400,
  source_too_large: 413,
  action_expired: 410,
  action_already_used: 409,
  action_unknown: 409,
  outbox_persist_failed: 507,
  invalid_request: 400,
  invalid_source_ref: 400,
  canvas_quota: 507,
};

export function createBridgeService({ sdk, dataDir, bus = sdk.bus, intents = null }) {
  const bridge = createSessionBridge({ bus, logger: sdk.logger });
  const outbox = createBridgeOutbox({
    dataDir,
    logger: sdk.logger,
    dispatch: async ({ record, text }) => {
      if (record.kind === "send-text") {
        const result = await bus.request("session:send", {
          sessionId: record.targetSessionId,
          scope: "all",
          text,
          // 明确用 followUp：不往进行中的回合里插 steer
          deliverAs: "followUp",
        });
        return { accepted: result?.accepted === true };
      }
      if (record.kind === "stage-markdown") {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const exportRoot = path.join(dataDir, "bridge-export");
        await fs.mkdir(exportRoot, { recursive: true, mode: 0o700 });
        const fileName = `分叉对话-${record.actionId.slice(4, 12)}.md`;
        const filePath = path.join(exportRoot, `${record.actionId}.md`);
        await fs.writeFile(filePath, text, { mode: 0o600 });
        const result = await bus.request("session:stage-file", {
          path: filePath,
          sessionId: record.targetSessionId,
          scope: "all",
          name: fileName,
          mime: "text/markdown",
          deliverAs: "attachment",
        });
        return { accepted: Boolean(result?.file) };
      }
      throw bridgeError("invalid_request", "未知的投递类型");
    },
  });

  const fail = (c, err) => {
    const code = err?.code && STATUS_BY_CODE[err.code] ? err.code : null;
    const status = code ? STATUS_BY_CODE[code] : err?.status || 400;
    // 只回稳定错误码与短说明，不透宿主内部文案
    return c.json(
      { ok: false, code: code || "bridge_failed", error: String(err?.message || "").slice(0, 240) },
      status,
    );
  };
  const wrap = (handler) => async (c) => {
    try {
      getDocumentOwner(c); // 只要不是可信调用方就当场拒绝
      return await handler(c);
    } catch (err) {
      return fail(c, err);
    }
  };

  function register(app) {
    app.get(
      "/api/bridge/capabilities",
      wrap(async (c) => {
        const caps = await bridge.readCapabilities();
        return c.json({
          ok: true,
          read: bridge.has(caps, "app/sessions.read"),
          manage: bridge.has(caps, "app/sessions.manage"),
          startTurn: bridge.has(caps, "app/session.start-turn"),
          stageFile: bridge.has(caps, "app/session.stage-file"),
          limits: {
            historyMax: BRIDGE_LIMITS.historyMax,
            textMaxBytes: BRIDGE_LIMITS.textMaxBytes,
            exportMaxBytes: BRIDGE_LIMITS.exportMaxBytes,
          },
        });
      }),
    );

    app.get(
      "/api/bridge/sessions",
      wrap(async (c) => {
        const lifecycle = c.req.query("lifecycle") === "archived" ? "archived" : "active";
        const result = await bridge.listSessions({ lifecycle });
        return c.json({ ok: true, ...result });
      }),
    );

    app.post(
      "/api/bridge/preview",
      wrap(async (c) => {
        const body = await readJson(c);
        const kind = body.kind === "tree-path" ? "tree-path" : "history";
        const result = await bridge.preview({
          sessionId: body.sessionId,
          kind,
          leafId: body.leafId,
          limit: body.limit,
        });
        return c.json({ ok: true, preview: result });
      }),
    );

    app.post(
      "/api/bridge/prepare",
      wrap(async (c) => {
        const body = await readJson(c);
        const caps = await bridge.readCapabilities();
        // 没拿到投递权限之前，连动作都不准备。
        // session:send 是由 app/session.start-turn 把关的，这条必须在这里就查，
        // 否则缺权限时也要等到用户点了"确认投递"才炸，前面的准备全白做。
        bridge.requireCapability(caps, "app/sessions.manage");
        bridge.requireCapability(caps, "app/session.start-turn");
        if (body.kind === "stage-markdown") bridge.requireCapability(caps, "app/session.stage-file");
        // 目标必须经宿主复核，不能拿前端自报的 sessionId 直接投
        const session = await bridge.resolveSession(body.sessionId);
        const prepared = await outbox.prepare({
          targetSessionId: session.sessionId,
          sessionTitle: session.title,
          kind: body.kind,
          text: body.text,
        });
        return c.json({ ok: true, action: prepared, target: session });
      }),
    );

    app.post(
      "/api/bridge/confirm",
      wrap(async (c) => {
        const body = await readJson(c);
        // confirm 只认 actionId，任何替换目标或正文的字段都被忽略
        const state = await outbox.confirm({ actionId: body.actionId });
        return c.json({ ok: true, action: state });
      }),
    );

    app.get(
      "/api/bridge/actions/:actionId",
      wrap(async (c) => {
        const state = await outbox.get({ actionId: c.req.param("actionId") });
        return c.json({ ok: true, action: state });
      }),
    );

    app.get(
      "/api/bridge/actions",
      wrap(async (c) => {
        const actions = await outbox.list({ limit: 20 });
        return c.json({ ok: true, actions });
      }),
    );

    // —— 本体发起的导入意图 ——
    if (intents) {
      app.get(
        "/api/bridge/intents",
        wrap(async (c) => {
          const list = await intents.list();
          return c.json({ ok: true, intents: list });
        }),
      );

      app.post(
        "/api/bridge/intents/:intentId/claim",
        wrap(async (c) => {
          const body = await readJson(c).catch(() => ({}));
          const intent = await intents.claim({
            intentId: c.req.param("intentId"),
            claimer: String(body.claimer || "primary"),
          });
          return c.json({ ok: true, intent });
        }),
      );

      app.post(
        "/api/bridge/intents/:intentId/ack",
        wrap(async (c) => {
          const body = await readJson(c).catch(() => ({}));
          const intent = await intents.ack({
            intentId: c.req.param("intentId"),
            claimer: String(body.claimer || "primary"),
          });
          return c.json({ ok: true, intent });
        }),
      );

      app.post(
        "/api/bridge/intents/:intentId/release",
        wrap(async (c) => {
          const body = await readJson(c).catch(() => ({}));
          const intent = await intents.release({
            intentId: c.req.param("intentId"),
            claimer: String(body.claimer || "primary"),
          });
          return c.json({ ok: true, intent });
        }),
      );
    }
  }

  return { register, bridge, outbox, intents };
}
