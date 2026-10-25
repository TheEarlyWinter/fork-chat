import test from "node:test";
import assert from "node:assert/strict";
import { parseAssistantOutput } from "../ui/assets/assistant-output.js";

// 1. 普通正文无标签原样保留
test("parseAssistantOutput: 普通正文原样返回（包含初始BOM与空白），blocks 为空", () => {
  const text = "\uFEFF  你好！这是一段普通的 Markdown 回答。\n- 列表项 1\n- 列表项 2";
  const res = parseAssistantOutput(text);
  assert.equal(res.body, text);
  assert.deepEqual(res.blocks, []);
});

// 2. body 保留原始未移除部分的空白，不做 trim
test("parseAssistantOutput: body 保留原始未移除部分的空白，不做 trim（例 <mood>x</mood>\\nPublic answer -> '\\nPublic answer'）", () => {
  const raw = "<mood>x</mood>\nPublic answer";
  const res = parseAssistantOutput(raw);

  assert.equal(res.blocks.length, 1);
  assert.deepEqual(res.blocks[0], {
    type: "mood",
    text: "x",
    closed: true,
  });
  // 核心断言：未移除部分换行与空白严格原样保留，不做 trim
  assert.equal(res.body, "\nPublic answer");
});

// 3. 支持 mood, pulse, reflect 三种类型及连续前缀多块
test("parseAssistantOutput: 支持 mood, pulse, reflect 以及开头 BOM 与连续前缀多块", () => {
  const raw = "\uFEFF<mood>😊 开心</mood>\n<pulse>{\"rate\": 72}</pulse>\n<reflect>深度思考</reflect>\n\n正文结论。";
  const res = parseAssistantOutput(raw);

  assert.equal(res.blocks.length, 3);
  assert.deepEqual(res.blocks[0], {
    type: "mood",
    text: "😊 开心",
    closed: true,
  });
  assert.deepEqual(res.blocks[1], {
    type: "pulse",
    text: "{\"rate\": 72}",
    closed: true,
  });
  assert.deepEqual(res.blocks[2], {
    type: "reflect",
    text: "深度思考",
    closed: true,
  });

  // 连续块结束后的正文保留原始未剥离空白
  assert.equal(res.body, "\n\n正文结论。");
});

// 4. 若首块后已出现非空正文，后续标签都必须字面保留在 body 中
test("parseAssistantOutput: 首块后一旦出现非空正文，后续所有标签必须字面保留在 body 中", () => {
  const raw = "<mood>x</mood>\nPublic answer\n<pulse>y</pulse>\n<reflect>z</reflect>";
  const res = parseAssistantOutput(raw);

  assert.equal(res.blocks.length, 1);
  assert.deepEqual(res.blocks[0], {
    type: "mood",
    text: "x",
    closed: true,
  });

  // 后续的 pulse 与 reflect 均必须字面保留在 body 中
  assert.equal(res.body, "\nPublic answer\n<pulse>y</pulse>\n<reflect>z</reflect>");
});

// 5. 大小写、标签内空白及 attributes 变体均作为字面正文（不分流）
test("parseAssistantOutput: 大小写、标签内空白及 attributes 变体均作为字面正文（不分流）", () => {
  const rawUppercase = "<MOOD>开心</MOOD>后续内容";
  const resUpper = parseAssistantOutput(rawUppercase);
  assert.equal(resUpper.blocks.length, 0);
  assert.equal(resUpper.body, rawUppercase);

  const rawSpace = "< mood >内容</ mood >后续";
  const resSpace = parseAssistantOutput(rawSpace);
  assert.equal(resSpace.blocks.length, 0);
  assert.equal(resSpace.body, rawSpace);

  const rawAttr = "<mood id=\"m1\" class=\"tag\">内容</mood>后续";
  const resAttr = parseAssistantOutput(rawAttr);
  assert.equal(resAttr.blocks.length, 0);
  assert.equal(resAttr.body, rawAttr);
});

// 6. 开头为代码块或行内代码时作为字面正文
test("parseAssistantOutput: 开头为代码块或行内代码时作为字面正文，不误分流", () => {
  const rawCode = "```html\n<mood>代码内部</mood>\n<reflect>代码内部思考</reflect>\n```\n正文结尾";
  const res = parseAssistantOutput(rawCode);
  assert.equal(res.blocks.length, 0);
  assert.equal(res.body, rawCode);

  const rawInline = "`<pulse>inline</pulse>` 是一个示例标签";
  const resInline = parseAssistantOutput(rawInline);
  assert.equal(resInline.blocks.length, 0);
  assert.equal(resInline.body, rawInline);
});

// 7. streaming 仅缓冲开头与块间的前缀碎片，不缓冲普通正文尾部的 <mo
test("parseAssistantOutput: streaming 只缓冲开头/块间前缀，不缓冲普通正文尾部 <mo", () => {
  const openPrefixes = ["<", "<m", "<mo", "<moo", "<mood", "<p", "<pu", "<pul", "<puls", "<r", "<re", "<ref", "<refl", "<refle", "<reflec"];

  // 1. 开头前缀在 streaming 时暂存，不露出到 body
  for (const p of openPrefixes) {
    const streamRes = parseAssistantOutput(p, { streaming: true });
    assert.equal(streamRes.body, "");
    assert.deepEqual(streamRes.blocks, []);

    // 非 streaming EOF 时必须回退到 body（防吞字）
    const eofRes = parseAssistantOutput(p, { streaming: false });
    assert.equal(eofRes.body, p);
    assert.deepEqual(eofRes.blocks, []);
  }

  // 2. 块间前缀在 streaming 时暂存
  for (const p of openPrefixes) {
    const raw = "<mood>calm</mood>\n" + p;
    const streamRes = parseAssistantOutput(raw, { streaming: true });
    assert.equal(streamRes.blocks.length, 1);
    assert.equal(streamRes.blocks[0].text, "calm");
    assert.equal(streamRes.body, ""); // 块间前缀暂存，body 为空

    const eofRes = parseAssistantOutput(raw, { streaming: false });
    assert.equal(eofRes.blocks.length, 1);
    assert.equal(eofRes.body, "\n" + p); // EOF 回退到 body，并保留 \n
  }

  // 3. 正文一旦开始，尾部的 <mo 不缓冲，立即保留在正文中
  const bodyWithPrefix = "<mood>calm</mood>\n正文已经开始。<mo";
  const bodyStreamRes = parseAssistantOutput(bodyWithPrefix, { streaming: true });
  assert.equal(bodyStreamRes.blocks.length, 1);
  assert.equal(bodyStreamRes.body, "\n正文已经开始。<mo"); // 绝不扣留正文尾部
});

// 8. 块内未闭合闭标签前缀防闪烁
test("parseAssistantOutput: 块内未完成闭标签前缀在 streaming 时暂存，不闪现在 block.text 中", () => {
  const pendingCloses = ["<", "</", "</r", "</re", "</ref", "</refl", "</refle", "</reflec"];

  for (const closePrefix of pendingCloses) {
    const raw = "<reflect>思考进行中" + closePrefix;
    const res = parseAssistantOutput(raw, { streaming: true });
    assert.equal(res.blocks.length, 1);
    assert.equal(res.blocks[0].type, "reflect");
    assert.equal(res.blocks[0].text, "思考进行中"); // 闭标签碎片被剥离，不闪现
    assert.equal(res.blocks[0].closed, false);
    assert.equal(res.body, "");
  }
});

// 9. 原生未闭合在 EOF 时保留独立块（closed: false）且不抛弃内容
test("parseAssistantOutput: 原生未闭合在 EOF 时保留独立块（closed: false）并不丢弃文本", () => {
  const raw = "<pulse>{\"bpm\": 90, \"status\": \"running\"";
  const res = parseAssistantOutput(raw, { streaming: false });

  assert.equal(res.body, "");
  assert.equal(res.blocks.length, 1);
  assert.deepEqual(res.blocks[0], {
    type: "pulse",
    text: "{\"bpm\": 90, \"status\": \"running\"",
    closed: false,
  });
});

// 10. 嵌套同名标签正确深度计数，不导致正文内容丢失
test("parseAssistantOutput: 嵌套同名标签正确深度计数，不丢失内部内容或提前断块", () => {
  const raw = "<reflect>外层思考开始\n<reflect>内层思考片段</reflect>\n外层思考结束</reflect>\n正文内容";
  const res = parseAssistantOutput(raw);

  assert.equal(res.blocks.length, 1);
  assert.equal(res.blocks[0].type, "reflect");
  assert.equal(res.blocks[0].closed, true);
  assert.equal(
    res.blocks[0].text,
    "外层思考开始\n<reflect>内层思考片段</reflect>\n外层思考结束"
  );
  assert.equal(res.body, "\n正文内容");
});

// 11. 畸形未知标签不分流，作为正文保留
test("parseAssistantOutput: 畸形或未知 HTML 标签不分流，作为正文保留", () => {
  const raw = "<unknown>未知标签内容</unknown>后续正文";
  const res = parseAssistantOutput(raw);

  assert.equal(res.blocks.length, 0);
  assert.equal(res.body, raw);
});

// 12. 逐字符渐进切分快照测试（Streaming 状态全覆盖与最终一致性）
test("parseAssistantOutput: 每个字符切分形成的渐进快照均可安全解析且最终一致", () => {
  const completeText = "\uFEFF<mood>😊 开心</mood>\n<pulse>80bpm</pulse>\n<reflect>\n步骤 1\n步骤 2\n</reflect>\n正文结论：<mood>not a block</mood>";

  for (let len = 0; len <= completeText.length; len++) {
    const chunk = completeText.slice(0, len);
    const parsedStreaming = parseAssistantOutput(chunk, { streaming: true });

    assert.ok(typeof parsedStreaming.body === "string");
    assert.ok(Array.isArray(parsedStreaming.blocks));

    // 未闭合块的 text 中不应包含闭标签的前缀碎片
    for (const b of parsedStreaming.blocks) {
      if (!b.closed) {
        assert.doesNotMatch(b.text, /<\/(?:m|p|re)[a-z]*$/i);
      }
    }
  }

  // EOF 最终解析对比
  const finalResult = parseAssistantOutput(completeText, { streaming: false });
  assert.equal(finalResult.blocks.length, 3);
  assert.equal(finalResult.blocks[0].type, "mood");
  assert.equal(finalResult.blocks[0].text, "😊 开心");
  assert.equal(finalResult.blocks[0].closed, true);

  assert.equal(finalResult.blocks[1].type, "pulse");
  assert.equal(finalResult.blocks[1].text, "80bpm");
  assert.equal(finalResult.blocks[1].closed, true);

  assert.equal(finalResult.blocks[2].type, "reflect");
  assert.equal(finalResult.blocks[2].text, "\n步骤 1\n步骤 2\n");
  assert.equal(finalResult.blocks[2].closed, true);

  assert.equal(finalResult.body, "\n正文结论：<mood>not a block</mood>");
});
