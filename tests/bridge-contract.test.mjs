import test from "node:test";
import assert from "node:assert/strict";
import {
  BRIDGE_LIMITS,
  BridgeError,
  bridgeError,
  buildEntryTree,
  buildSourceRef,
  composeImportText,
  computeContentHash,
  estimateBytes,
  isSameImport,
  isSameOriginDifferentContent,
  projectHistory,
  projectHistoryMessage,
  projectTreePath,
  resolveTreePath,
  sanitizeId,
  sanitizeTitle,
  sourceRefKey,
  truncateText,
  validateSourceRef,
} from "../lib/bridge-contract.js";

test("bridge: 宿主 ID 只做类型长度字符集检查，不假设是 UUID", () => {
  assert.equal(sanitizeId("abc-123"), "abc-123");
  assert.equal(sanitizeId("a.b:c@d~e+f"), "a.b:c@d~e+f");
  assert.equal(sanitizeId("../../etc/passwd"), null);
  assert.equal(sanitizeId("a".repeat(BRIDGE_LIMITS.idMaxLength + 1)), null);
  assert.equal(sanitizeId(12345), null);
  assert.equal(sanitizeId(""), null);
  assert.equal(sanitizeId(null), null);
  assert.equal(sanitizeId("has space"), null);
});

test("bridge: 标题去掉控制字符并限长", () => {
  assert.equal(sanitizeTitle("  你好\u0000世界  "), "你好 世界");
  assert.equal(sanitizeTitle("x".repeat(500)).length, BRIDGE_LIMITS.titleMaxLength);
  assert.equal(sanitizeTitle(null), "");
});

test("bridge: 消息投影只留可见正文，隐藏字段一律不进 App", () => {
  const projected = projectHistoryMessage({
    role: "assistant",
    content: "正文内容",
    entryId: "e1",
    thinking: "秘密推理",
    toolCalls: [{ name: "x" }],
    images: [{ data: "..." }],
  });
  assert.equal(projected.text, "正文内容");
  assert.equal(projected.role, "assistant");
  assert.equal(projected.addressable, true);
  assert.deepEqual(projected.dropped, { images: 1, thinking: 1, toolCalls: 1 });
  assert.equal(JSON.stringify(projected).includes("秘密推理"), false);
  assert.equal(JSON.stringify(projected).includes("data"), false);
});

test("bridge: 没有 entryId 的消息可展示但不可定位", () => {
  const projected = projectHistoryMessage({ role: "user", content: "hi", entryId: null });
  assert.equal(projected.addressable, false);
  assert.equal(projected.entryId, null);
});

test("bridge: 非法角色与空正文被丢弃，不伪装成消息", () => {
  assert.equal(projectHistoryMessage({ role: "system", content: "x" }), null);
  assert.equal(projectHistoryMessage({ role: "user", content: "" }), null);
  assert.equal(projectHistoryMessage(null), null);
});

test("bridge: history 投影按上限截断，并如实报出截了多少", () => {
  const raw = Array.from({ length: 120 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `第 ${i} 条`,
    entryId: `e${i}`,
  }));
  const result = projectHistory(raw, { limit: 50 });
  assert.equal(result.messages.length, 50);
  assert.equal(result.truncated, true);
  assert.equal(result.available, 120);
  assert.equal(result.messages.at(-1).text, "第 119 条");

  const capped = projectHistory(raw, { limit: 9999 });
  assert.equal(capped.requested, BRIDGE_LIMITS.historyMax, "请求数被夹到上限");
  assert.equal(capped.messages.length, 120, "实际有多少给多少，不凑数");
});

test("bridge: 超长正文被截断且标记", () => {
  const long = "字".repeat(BRIDGE_LIMITS.messageMaxChars + 10);
  const result = truncateText(long);
  assert.equal(result.truncated, true);
  assert.equal(result.originalLength, long.length);
  assert.equal(result.text.length, BRIDGE_LIMITS.messageMaxChars);
});

test("bridge: 条目树按宿主父子关系还原，不靠文本相似度", () => {
  const tree = buildEntryTree([
    { id: "a", parentId: null, role: "user", content: "问一" },
    { id: "b", parentId: "a", role: "assistant", content: "答一" },
    { id: "c", parentId: "a", role: "user", content: "问二" },
    { id: "d", parentId: "c", role: "assistant", content: "答二" },
  ]);
  assert.equal(tree.nodeCount, 4);
  assert.deepEqual(tree.roots, ["a"]);
  assert.deepEqual(tree.nodes.get("a").children, ["b", "c"]);
  assert.deepEqual(tree.cyclicIds, []);
  const path = resolveTreePath(tree, "d");
  assert.deepEqual(path, ["a", "c", "d"]);
});

test("bridge: 未知节点被跳过并计数，重复 ID 被拒", () => {
  const tree = buildEntryTree([
    { role: "user", content: "没有 id" },
    { id: "a", parentId: null, role: "user", content: "正常" },
    { id: "a", parentId: null, role: "user", content: "重复" },
    { id: "z", parentId: null, type: "tool_result" },
  ]);
  assert.equal(tree.skippedCount, 1);
  assert.deepEqual(tree.duplicateIds, ["a"]);
  assert.equal(tree.nodeCount, 2);
  assert.equal(tree.nodes.get("z").kind, "other");
});

test("bridge: 悬空父节点降级成根，并记录下来", () => {
  const tree = buildEntryTree([
    { id: "a", parentId: "missing", role: "user", content: "孤儿" },
  ]);
  assert.deepEqual(tree.danglingParents, ["a"]);
  assert.deepEqual(tree.roots, ["a"]);
});

test("bridge: 环状父子关系被识别，不无限循环", () => {
  const tree = buildEntryTree([
    { id: "a", parentId: "b", role: "user", content: "甲" },
    { id: "b", parentId: "a", role: "assistant", content: "乙" },
  ]);
  assert.ok(tree.cyclicIds.length > 0);
  assert.equal(resolveTreePath(tree, "a"), null);
});

test("bridge: 分支投影只保留路径上的可见消息", () => {
  const tree = buildEntryTree([
    { id: "a", parentId: null, role: "user", content: "问" },
    { id: "b", parentId: "a", role: "assistant", content: "答" },
    { id: "t", parentId: "b", type: "tool_call" },
    { id: "c", parentId: "t", role: "user", content: "再问" },
  ]);
  const projected = projectTreePath(tree, "c");
  assert.deepEqual(projected.entryIds, ["a", "b", "t", "c"]);
  assert.equal(projected.messages.length, 3);
  assert.equal(projected.droppedCount, 1);
  assert.equal(projected.messages.map((m) => m.role).join(","), "user,assistant,user");
});

test("bridge: 来源引用可往返校验，坏数据当没有", () => {
  const ref = buildSourceRef({
    sessionId: "sess-1",
    entryIds: ["e1", "e2", "../bad"],
    leafId: "e2",
    titleAtImport: "某会话",
    importKind: "tree-path",
    messages: [{ role: "user", text: "问" }, { role: "assistant", text: "答" }],
  });
  assert.equal(ref.sessionId, "sess-1");
  assert.deepEqual(ref.entryIds, ["e1", "e2"]);

  const restored = validateSourceRef(JSON.parse(JSON.stringify(ref)));
  assert.deepEqual(restored, ref);

  assert.equal(validateSourceRef({ version: 2, kind: "hana-session", sessionId: "s" }), null);
  assert.equal(validateSourceRef({ version: 1, kind: "other", sessionId: "s", importKind: "message" }), null);
  assert.equal(validateSourceRef({ version: 1, kind: "hana-session", importKind: "message" }), null);
  assert.equal(validateSourceRef(null), null);
});

test("bridge: 去重键相同算同一导入，正文变了算新快照", () => {
  const a = buildSourceRef({
    sessionId: "s", entryIds: ["e1"], importKind: "history",
    messages: [{ role: "user", text: "问" }],
  });
  const b = buildSourceRef({
    sessionId: "s", entryIds: ["e1"], importKind: "history",
    messages: [{ role: "user", text: "问" }],
  });
  const c = buildSourceRef({
    sessionId: "s", entryIds: ["e1"], importKind: "history",
    messages: [{ role: "user", text: "问（改过）" }],
  });
  assert.equal(isSameImport(a, b), true);
  assert.equal(isSameImport(a, c), false);
  assert.equal(sourceRefKey(a), sourceRefKey(b));
  assert.equal(isSameOriginDifferentContent(a, c), true);
  assert.equal(isSameOriginDifferentContent(a, b), false);
  const other = buildSourceRef({ sessionId: "s2", entryIds: ["e1"], importKind: "history", messages: [] });
  assert.equal(isSameOriginDifferentContent(a, other), false);
});

test("bridge: 内容哈希稳定且对顺序敏感", () => {
  const h1 = computeContentHash(["user:问", "assistant:答"]);
  const h2 = computeContentHash(["user:问", "assistant:答"]);
  const h3 = computeContentHash(["assistant:答", "user:问"]);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

test("bridge: 导入快照正文带只读声明，不冒充原生历史", () => {
  const text = composeImportText(
    [{ role: "user", text: "问" }, { role: "assistant", text: "答" }],
    { title: "某会话" },
  );
  assert.match(text, /只读摘录/);
  assert.match(text, /【用户】问/);
  assert.match(text, /【助手】答/);
  assert.equal(text.includes("system"), false);
});

test("bridge: 错误对象带稳定 code，便于前后端对齐", () => {
  const err = bridgeError("permission_missing", "app/sessions.manage");
  assert.ok(err instanceof BridgeError);
  assert.equal(err.code, "permission_missing");
  assert.match(err.message, /缺少所需权限/);
  assert.match(err.message, /app\/sessions\.manage/);
});

test("bridge: 大小估算可用且对超大对象不抛", () => {
  assert.ok(estimateBytes({ a: 1 }) > 0);
  const circular = {};
  circular.self = circular;
  assert.equal(estimateBytes(circular), Number.MAX_SAFE_INTEGER);
});

test("bridge: 宿主原生 message 结构与复合 content（含 thinking / toolCall）正确投影", () => {
  const tree = buildEntryTree([
    {
      id: "u1",
      parentId: null,
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "清理一下工作区吧" }],
      },
    },
    {
      id: "a1",
      parentId: "u1",
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "思考过程不应进正文" },
          { type: "toolCall", id: "t1", name: "ls", arguments: {} },
        ],
      },
    },
    {
      id: "tr1",
      parentId: "a1",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "t1",
        content: [{ type: "text", text: "file1.txt\nfile2.txt" }],
      },
    },
    {
      id: "a2",
      parentId: "tr1",
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "二次思考" },
          { type: "text", text: "这是最终回答正文" },
        ],
      },
    },
  ]);

  const path = projectTreePath(tree, "a2");
  assert.ok(path);
  assert.equal(path.messages.length, 2);
  assert.equal(path.messages[0].role, "user");
  assert.equal(path.messages[0].text, "清理一下工作区吧");
  assert.equal(path.messages[1].role, "assistant");
  assert.equal(path.messages[1].text, "这是最终回答正文");
  assert.equal(path.droppedCount, 2, "纯工具调用与工具结果被过滤计入 dropped");
});
