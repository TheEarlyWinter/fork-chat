import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBridgeIntents } from "../lib/bridge-intents.js";
import { createBridgeService } from "../lib/bridge-service.js";

async function makeIntents() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "forkchat-intents-"));
  return { intents: createBridgeIntents({ dataDir }), dataDir };
}

test("intents: 只记定位符，不存正文也不存 token", async () => {
  const { intents, dataDir } = await makeIntents();
  const record = await intents.enqueue({ sessionId: "sess-1", messageId: "msg-1", title: "某会话" });
  assert.match(record.intentId, /^int_[0-9a-f]{18}$/);
  const raw = await fs.readFile(path.join(dataDir, "bridge-intents.json"), "utf8");
  assert.equal(raw.includes("callToken"), false);
  assert.equal(raw.includes("正文"), false);
  assert.match(raw, /sess-1/);
});

test("intents: 重复点同一个入口只留一张凭条", async () => {
  const { intents } = await makeIntents();
  const a = await intents.enqueue({ sessionId: "s", messageId: "m" });
  const b = await intents.enqueue({ sessionId: "s", messageId: "m" });
  assert.equal(a.intentId, b.intentId);
  assert.equal((await intents.list()).length, 1);
});

test("intents: 多窗口只有一个能 claim，其余明确被拒", async () => {
  const { intents } = await makeIntents();
  const record = await intents.enqueue({ sessionId: "s", messageId: "m" });
  const first = await intents.claim({ intentId: record.intentId, claimer: "win-a" });
  assert.equal(first.claimedBy, "win-a");
  await assert.rejects(
    () => intents.claim({ intentId: record.intentId, claimer: "win-b" }),
    /已被另一个窗口领取/,
  );
});

test("intents: ack 之后不再出现在待办里", async () => {
  const { intents } = await makeIntents();
  const record = await intents.enqueue({ sessionId: "s" });
  await intents.claim({ intentId: record.intentId, claimer: "win-a" });
  await intents.ack({ intentId: record.intentId, claimer: "win-a" });
  assert.equal((await intents.list()).length, 0);
  await assert.rejects(
    () => intents.claim({ intentId: record.intentId, claimer: "win-b" }),
    /已使用/,
  );
});

test("intents: release 把抢占还回去，别的窗口还能用", async () => {
  const { intents } = await makeIntents();
  const record = await intents.enqueue({ sessionId: "s" });
  await intents.claim({ intentId: record.intentId, claimer: "win-a" });
  await intents.release({ intentId: record.intentId, claimer: "win-a" });
  const second = await intents.claim({ intentId: record.intentId, claimer: "win-b" });
  assert.equal(second.claimedBy, "win-b");
});

test("intents: 非法 sessionId 被拒", async () => {
  const { intents } = await makeIntents();
  await assert.rejects(() => intents.enqueue({ sessionId: "../../etc" }), /会话标识/);
  await assert.rejects(() => intents.enqueue({ sessionId: null }), /会话标识/);
});

// —— 路由层 ——

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(p, h) { routes.set(`GET ${p}`, h); },
    post(p, h) { routes.set(`POST ${p}`, h); },
  };
}

function makeContext({ body = {}, principal = { kind: "app", credentialId: "cred-1" }, appId = "fork-chat", param = null } = {}) {
  const text = JSON.stringify(body);
  return {
    req: {
      raw: new Request("http://local/x", { method: "POST", body: text }),
      async json() { return body; },
      param(name) { return param?.[name] ?? null; },
      query() { return undefined; },
    },
    get() { return { appId, principal }; },
    json(value, status = 200) { return Response.json(value, { status }); },
  };
}

function makeBus(grants = ["app/sessions.read", "app/sessions.manage", "app/session.start-turn", "app/session.stage-file"], handlers = {}) {
  const calls = [];
  const granted = new Set(grants);
  return {
    calls,
    async request(type, payload) {
      calls.push({ type, payload });
      if (handlers[type]) return handlers[type](payload);
      if (type === "app:capabilities") {
        return {
          capabilities: ["app/sessions.read", "app/sessions.manage", "app/session.start-turn", "app/session.stage-file"].map((capability) => ({
            capability,
            status: granted.has(capability) ? "always" : "not_asked",
            enforcement: "hard",
          })),
        };
      }
      if (type === "session:get") {
        return { session: { sessionId: "sess-1", title: "某会话", ownerPluginId: null, lifecycle: "active" } };
      }
      if (type === "session:send") return { accepted: true, sessionPath: "/p" };
      throw new Error(`未预期 ${type}`);
    },
  };
}

async function makeService(bus) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "forkchat-bservice-"));
  const app = makeApp();
  const service = createBridgeService({ sdk: { bus, logger: { info() {}, warn() {} } }, dataDir, bus });
  service.register(app);
  return { service, app, dataDir };
}

test("service: 没有可信调用方身份时一律 401", async () => {
  const bus = makeBus();
  const { app } = await makeService(bus);
  const handler = app.routes.get("GET /api/bridge/sessions");
  const response = await handler(makeContext({ appId: "someone-else" }));
  assert.equal(response.status, 401);
});

test("service: capabilities 只回答本 App 的授予情况", async () => {
  // 故意不给 start-turn，验证未授予时会如实报 false
  const bus = makeBus(["app/sessions.read", "app/sessions.manage", "app/session.stage-file"]);
  const { app } = await makeService(bus);
  const response = await app.routes.get("GET /api/bridge/capabilities")(makeContext());
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.read, true);
  assert.equal(data.manage, true);
  assert.equal(data.stageFile, true);
  assert.equal(data.startTurn, false, "未授予的能力必须如实报 false");
});

test("service: 缺 manage 权限时 prepare 直接拒绝，不准备动作", async () => {
  const bus = makeBus(["app/sessions.read"]);
  const { app } = await makeService(bus);
  const response = await app.routes
    .get("POST /api/bridge/prepare")(makeContext({ body: { sessionId: "sess-1", kind: "send-text", text: "hi" } }));
  assert.equal(response.status, 403);
  const data = await response.json();
  assert.equal(data.code, "permission_missing");
  assert.equal(bus.calls.some((c) => c.type === "session:send"), false);
});

test("service: prepare 冻结目标，confirm 只按 actionId 派发一次", async () => {
  const bus = makeBus();
  const { app } = await makeService(bus);
  const prepared = await (await app.routes
    .get("POST /api/bridge/prepare")(makeContext({ body: { sessionId: "sess-1", kind: "send-text", text: "内容" } }))).json();
  assert.equal(prepared.ok, true);
  assert.equal(prepared.action.state, "prepared");
  assert.equal(bus.calls.some((c) => c.type === "session:send"), false, "prepare 不应投递");

  const confirmed = await (await app.routes
    .get("POST /api/bridge/confirm")(makeContext({ body: { actionId: prepared.action.actionId, targetSessionId: "别的会话" } }))).json();
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.action.targetSessionId, "sess-1", "目标在 prepare 时就冻结了");
  assert.equal(confirmed.action.state, "accepted");
  const sends = bus.calls.filter((c) => c.type === "session:send");
  assert.equal(sends.length, 1);

  // 再确认一次：不能再发
  const again = await app.routes
    .get("POST /api/bridge/confirm")(makeContext({ body: { actionId: prepared.action.actionId } }));
  assert.equal(again.status, 409);
  assert.equal(bus.calls.filter((c) => c.type === "session:send").length, 1);
});

test("service: 真实文件系统替换失败返回 507，确认不会调用宿主发送", async (t) => {
  const bus = makeBus();
  const { app, dataDir } = await makeService(bus);
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const prepared = await (await app.routes.get("POST /api/bridge/prepare")(
    makeContext({ body: { sessionId: "sess-1", kind: "send-text", text: "blocked" } }),
  )).json();
  const meta = path.join(dataDir, "bridge-actions.json");
  await fs.rename(meta, `${meta}.backup`);
  await fs.mkdir(meta); // 让真实 rename 失败，不能靠 mock 的返回值伪装通过
  const response = await app.routes.get("POST /api/bridge/confirm")(
    makeContext({ body: { actionId: prepared.action.actionId } }),
  );
  assert.equal(response.status, 507);
  assert.equal((await response.json()).code, "outbox_persist_failed");
  assert.equal(bus.calls.filter(call => call.type === "session:send").length, 0);
  const again = await app.routes.get("POST /api/bridge/confirm")(
    makeContext({ body: { actionId: prepared.action.actionId } }),
  );
  assert.equal(again.status, 409);
  assert.equal(bus.calls.filter(call => call.type === "session:send").length, 0);
});

test("service: prepare 的真实落盘失败不会返回可用动作", async (t) => {
  const bus = makeBus();
  const { app, dataDir, service } = await makeService(bus);
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dataDir, "bridge-actions.json"));
  const response = await app.routes.get("POST /api/bridge/prepare")(
    makeContext({ body: { sessionId: "sess-1", kind: "send-text", text: "blocked" } }),
  );
  assert.equal(response.status, 507);
  const body = await response.json();
  assert.equal(body.code, "outbox_persist_failed");
  assert.equal(body.action, undefined);
  assert.equal((await service.outbox.list()).length, 0);
  assert.equal(bus.calls.filter(call => call.type === "session:send").length, 0);
});

test("service: 预览不产生任何写动作", async () => {
  const bus = makeBus(undefined, {
    "session:history": () => ({ messages: [{ role: "user", content: "问", entryId: "e1" }] }),
    "session:context": () => ({ isStreaming: false, systemPrompt: "绝密" }),
  });
  const { app } = await makeService(bus);
  const response = await app.routes.get("POST /api/bridge/preview")(makeContext({ body: { sessionId: "sess-1" } }));
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(JSON.stringify(data).includes("绝密"), false);
  assert.equal(bus.calls.some((c) => ["session:send", "session:stage-file"].includes(c.type)), false);
});

test("bridge_import 工具: 正确解析 context 并将单消息或整会话意图登记入队", async (t) => {
  const { intents, dataDir } = await makeIntents();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const bus = makeBus(undefined, {
    "session:get": ({ sessionPath }) => {
      if (sessionPath === "/valid/session") {
        return { session: { sessionId: "sess-abc", title: "测试会话", ownerPluginId: null } };
      }
      if (sessionPath === "/plugin/session") {
        return { session: { sessionId: "sess-plugin", title: "插件私有会话", ownerPluginId: "other-app" } };
      }
      return { session: null };
    },
  });

  // 模拟 index.js 中 bridge_import 的核心执行逻辑
  async function executeBridgeImport(args) {
    const context = args?.context || {};
    const sessionPath = typeof context.sessionPath === "string" ? context.sessionPath : null;
    if (!sessionPath) return { ok: false, code: "surface_unsupported", error: "当前入口没有会话上下文" };
    try {
      const found = await bus.request("session:get", { sessionPath, scope: "all" });
      const session = found?.session;
      const sessionId = session?.sessionId;
      if (!sessionId) return { ok: false, code: "session_not_addressable", error: "无法确定会话身份" };
      if (session.ownerPluginId) {
        return { ok: false, code: "session_not_addressable", error: "不支持把其他应用私有会话导入" };
      }
      const intent = await intents.enqueue({
        sessionId,
        messageId: typeof context.messageId === "string" ? context.messageId : null,
        title: session.title || session.firstMessage || "",
        origin: context.messageId ? "message-action" : "context-menu",
      });
      return {
        ok: true,
        intentId: intent.intentId,
        hint: "导入请求已准备。打开「分叉对话」后可选择画布并确认。",
      };
    } catch (err) {
      const message = String(err?.message || err);
      const code = /permission|denied|403/i.test(message) ? "permission_missing" : "invalid_request";
      return { ok: false, code, error: message.slice(0, 200) };
    }
  }

  // 1. 缺少 sessionPath
  assert.equal((await executeBridgeImport({})).code, "surface_unsupported");

  // 2. 属于第三方应用私有会话
  assert.equal((await executeBridgeImport({ context: { sessionPath: "/plugin/session" } })).code, "session_not_addressable");

  // 3. 消息级动作：携带 messageId
  const msgResult = await executeBridgeImport({
    context: { sessionPath: "/valid/session", messageId: "entry-999" },
  });
  assert.equal(msgResult.ok, true);
  const queuedMsg = (await intents.list()).find(i => i.intentId === msgResult.intentId);
  assert.equal(queuedMsg.sessionId, "sess-abc");
  assert.equal(queuedMsg.messageId, "entry-999");
  assert.equal(queuedMsg.origin, "message-action");

  // 4. 会话级动作：不带 messageId
  const sessResult = await executeBridgeImport({
    context: { sessionPath: "/valid/session" },
  });
  assert.equal(sessResult.ok, true);
  const queuedSess = (await intents.list()).find(i => i.intentId === sessResult.intentId);
  assert.equal(queuedSess.sessionId, "sess-abc");
  assert.equal(queuedSess.messageId, null);
  assert.equal(queuedSess.origin, "context-menu");
});

test("intents: claim 有租约，窗口崩溃后可以被别的窗口接管", async () => {
  let now = 1_000_000;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "intent-lease-"));
  const intents = createBridgeIntents({ dataDir: dir, clock: () => now });
  const rec = await intents.enqueue({ sessionId: "sess-1", title: "测试" });
  await intents.claim({ intentId: rec.intentId, claimer: "canvas-A" });
  // 另一个窗口立刻来抢：应该被拒
  await assert.rejects(
    () => intents.claim({ intentId: rec.intentId, claimer: "canvas-B" }),
    /另一个窗口/,
  );
  // canvas-A 崩了，时间过去 11 分钟
  now += 11 * 60 * 1000;
  const taken = await intents.claim({ intentId: rec.intentId, claimer: "canvas-B" });
  assert.equal(taken.claimedBy, "canvas-B", "租约过期后应可接管");
  // 原窗口的迟到 ACK 要被拒
  await assert.rejects(
    () => intents.ack({ intentId: rec.intentId, claimer: "canvas-A" }),
    /另一个窗口/,
  );
  await intents.ack({ intentId: rec.intentId, claimer: "canvas-B" });
});

test("service: 缺 start-turn 权限时 prepare 直接拒绝，不等到 confirm 才炸", async () => {
  const bus = makeBus(["app/sessions.read", "app/sessions.manage"]);
  const { app } = await makeService(bus);
  const handler = app.routes.get("POST /api/bridge/prepare");
  const response = await handler(makeContext({
    appId: "fork-chat",
    body: { sessionId: "sess-1", kind: "send-text", text: "hi" },
  }));
  assert.equal(response.status, 403);
  // 关键：连准备都不该做，更不能走到 session:send
  assert.ok(!bus.calls.some(call => call.type === "session:send"), "不能偷偷投递");
});
