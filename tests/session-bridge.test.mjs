import test from "node:test";
import assert from "node:assert/strict";
import { createSessionBridge } from "../lib/session-bridge.js";
import { BridgeError } from "../lib/bridge-contract.js";

/** 假总线：记录每一次请求，按脚本回包。绝不连宿主。 */
function makeBus({ capabilities = ["app/sessions.read"], handlers = {} } = {}) {
  const calls = [];
  const granted = new Set(capabilities);
  const bus = {
    calls,
    async request(type, payload) {
      calls.push({ type, payload });
      if (type === "app:capabilities") {
        return {
          capabilities: Object.keys({
            "app/sessions.read": 1,
            "app/sessions.manage": 1,
            "app/session.start-turn": 1,
            "app/session.stage-file": 1,
          }).map((capability) => ({
            capability,
            status: granted.has(capability) ? "always" : "not_asked",
            enforcement: "hard",
          })),
        };
      }
      const handler = handlers[type];
      if (!handler) throw new Error(`未预期的请求 ${type}`);
      return handler(payload);
    },
  };
  return bus;
}

const SESSION = {
  sessionId: "sess-1",
  title: "关于木质素的讨论",
  agentName: "小鲸鱼",
  messageCount: 4,
  lifecycle: "active",
  ownerPluginId: null,
};

function baseHandlers(extra = {}) {
  return {
    "session:get": () => ({ session: SESSION }),
    "session:history": () => ({
      messages: [
        { role: "user", content: "问一", entryId: "e1", thinking: "不该出现" },
        { role: "assistant", content: "答一", entryId: "e2", toolCalls: [{ n: 1 }] },
      ],
    }),
    "session:context": () => ({ isStreaming: false, isCompacting: false, systemPrompt: "绝密提示词" }),
    ...extra,
  };
}

test("bridge: 会话列表只保留宿主正常会话，不返回路径与提示词", async () => {
  const bus = makeBus({
    handlers: {
      "session:list": () => ({
        sessions: [
          { ...SESSION, path: "/secret/path.jsonl" },
          { sessionId: "sess-app", ownerPluginId: "fork-chat", title: "本 App 私有" },
          { sessionId: null, path: "/x" },
        ],
      }),
    },
  });
  const bridge = createSessionBridge({ bus });
  const result = await bridge.listSessions();
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].sessionId, "sess-1");
  assert.equal(JSON.stringify(result).includes("/secret/path.jsonl"), false);
  assert.equal(JSON.stringify(result).includes("sess-app"), false);
});

test("bridge: 缺 read 权限时明确拒绝并说清缺哪条", async () => {
  const bus = makeBus({ capabilities: [] });
  const bridge = createSessionBridge({ bus });
  await assert.rejects(
    () => bridge.listSessions(),
    (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, "permission_missing");
      assert.match(err.message, /app\/sessions\.read/);
      return true;
    },
  );
  assert.equal(bus.calls.some((c) => c.type === "session:list"), false, "没权限不应继续查询");
});

test("bridge: history 预览丢弃 thinking 与 toolCalls，不透出 systemPrompt", async () => {
  const bus = makeBus({ handlers: baseHandlers() });
  const bridge = createSessionBridge({ bus });
  const preview = await bridge.previewHistory({ sessionId: "sess-1" });
  assert.equal(preview.messages.length, 2);
  assert.equal(preview.messages[0].text, "问一");
  assert.deepEqual(preview.messages[0].dropped, { thinking: 1 });
  assert.deepEqual(preview.messages[1].dropped, { toolCalls: 1 });
  const wire = JSON.stringify(preview);
  assert.equal(wire.includes("不该出现"), false);
  assert.equal(wire.includes("绝密提示词"), false);
  assert.equal(preview.session.title, "关于木质素的讨论");
});

test("bridge: 会话 id 对不上时拒绝，不认前端自报身份", async () => {
  const bus = makeBus({
    handlers: baseHandlers({ "session:get": () => ({ session: { ...SESSION, sessionId: "other" } }) }),
  });
  const bridge = createSessionBridge({ bus });
  await assert.rejects(() => bridge.resolveSession("sess-1"), /缺少可用的会话标识/);
});

test("bridge: 其他 App 的私有会话不可作为来源", async () => {
  const bus = makeBus({
    handlers: baseHandlers({ "session:get": () => ({ session: { ...SESSION, ownerPluginId: "someone-else" } }) }),
  });
  const bridge = createSessionBridge({ bus });
  await assert.rejects(() => bridge.resolveSession("sess-1"), /缺少可用的会话标识/);
});

test("bridge: 读取运行状态失败时降级为 unknown，不伪装成已结束", async () => {
  const bus = makeBus({
    handlers: baseHandlers({
      "session:context": () => {
        throw new Error("boom");
      },
      "session:history": () => ({ messages: [{ role: "user", content: "问", entryId: "e1" }] }),
    }),
  });
  const bridge = createSessionBridge({ bus });
  const preview = await bridge.previewHistory({ sessionId: "sess-1" });
  assert.equal(preview.status.unknown, true);
  assert.equal(preview.status.isStreaming, false);
});

test("bridge: 树预览按宿主关系出分支，多分支时要求选叶", async () => {
  const bus = makeBus({
    handlers: baseHandlers({
      "session:entries": () => ({
        entries: [
          { id: "a", parentId: null, role: "user", content: "根问" },
          { id: "b", parentId: "a", role: "assistant", content: "分支一答" },
          { id: "c", parentId: "a", role: "assistant", content: "分支二答" },
        ],
      }),
    }),
  });
  const bridge = createSessionBridge({ bus });
  const preview = await bridge.previewTree({ sessionId: "sess-1" });
  assert.equal(preview.needsLeafChoice, true);
  assert.equal(preview.rootCount, 1);
  assert.equal(preview.branches.length, 2, "两个叶节点就是两条可选分支");
  assert.equal(preview.nodeCount, 3);

  const chosen = await bridge.previewTree({ sessionId: "sess-1", leafId: "b" });
  assert.equal(chosen.needsLeafChoice, false);
  assert.deepEqual(chosen.entryIds, ["a", "b"]);
  assert.equal(chosen.messages.length, 2);
});

test("bridge: 条目树有环时明确失败，不返回半截路径", async () => {
  const bus = makeBus({
    handlers: baseHandlers({
      "session:entries": () => ({
        entries: [
          { id: "a", parentId: "b", role: "user", content: "甲" },
          { id: "b", parentId: "a", role: "assistant", content: "乙" },
        ],
      }),
    }),
  });
  const bridge = createSessionBridge({ bus });
  await assert.rejects(() => bridge.previewTree({ sessionId: "sess-1" }), /环状关系/);
});

test("bridge: 总线抛权限错误时映射成稳定错误码，不泄露原始长文案", async () => {
  const bus = makeBus({
    handlers: baseHandlers({
      "session:history": () => {
        throw new Error("permission denied: internal stack at /secret/path");
      },
    }),
  });
  const bridge = createSessionBridge({ bus });
  await assert.rejects(
    () => bridge.previewHistory({ sessionId: "sess-1" }),
    (err) => {
      assert.equal(err.code, "permission_missing");
      assert.equal(err.message.includes("/secret/path"), false);
      return true;
    },
  );
});

test("bridge: 只读预览不产生任何写动作", async () => {
  const bus = makeBus({
    handlers: baseHandlers({
      "session:entries": () => ({ entries: [{ id: "a", parentId: null, role: "user", content: "问" }] }),
    }),
  });
  const bridge = createSessionBridge({ bus });
  await bridge.listSessions().catch(() => {});
  await bridge.previewHistory({ sessionId: "sess-1" });
  await bridge.previewTree({ sessionId: "sess-1" });
  const writes = bus.calls.filter((call) =>
    ["session:send", "session:create", "session:fork", "session:stage-file", "session:send-custom", "session:append-entry"].includes(call.type),
  );
  assert.deepEqual(writes, [], "只读路径不应出现任何写动词");
});

test("bridge: 来源引用从预览生成，带回真实 sessionId 与标题快照", async () => {
  const bus = makeBus({ handlers: baseHandlers() });
  const bridge = createSessionBridge({ bus });
  const preview = await bridge.previewHistory({ sessionId: "sess-1" });
  const ref = bridge.sourceRefFromPreview(preview, {
    entryIds: ["e1", "e2"],
    importKind: "history",
  });
  assert.equal(ref.sessionId, "sess-1");
  assert.equal(ref.titleAtImport, "关于木质素的讨论");
  assert.deepEqual(ref.entryIds, ["e1", "e2"]);
  assert.match(ref.contentHash, /^[0-9a-f]{16}$/);
});

test("bridge: previewHistory 优先通过 session:entries 沿当前分支取最新尾部记录", async () => {
  const bus = makeBus({
    handlers: baseHandlers({
      "session:entries": () => ({
        leafId: "m3",
        entries: [
          { id: "m1", parentId: null, role: "user", content: "早期提问" },
          { id: "m2", parentId: "m1", role: "assistant", content: "早期回答" },
          { id: "m3", parentId: "m2", role: "user", content: "最新追问" },
        ],
      }),
      // 如果调用了 session:history，返回的是老数据
      "session:history": () => ({
        messages: [{ role: "user", content: "老历史", entryId: "old" }],
      }),
    }),
  });
  const bridge = createSessionBridge({ bus });
  const preview = await bridge.previewHistory({ sessionId: "sess-1", limit: 2 });
  assert.equal(preview.messages.length, 2);
  assert.equal(preview.messages[0].text, "早期回答");
  assert.equal(preview.messages[1].text, "最新追问");
  assert.equal(preview.truncated, true);
  assert.equal(preview.available, 3);
  assert.equal(preview.leafId, "m3");
});
