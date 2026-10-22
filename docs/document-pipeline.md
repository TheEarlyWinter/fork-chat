# fork-chat 文档解析流水线方案

> 目标：让拖进卡片的文档，在**不乱码、不炸上下文、不折腾用户**的前提下变成可推理的上下文。
>
> **最终结论（2026-10-21 定稿）：PDF 交给 pdf.js（unpdf 打包版），纯 JS 单引擎，不起子进程、不调宿主助手。**
> 本文档前面几节记录了探索过程中核实的宿主链路能力与失败点，留作复盘；当前实现在第 6 节。
>
> **2026-10-22 补记两处已经过时的说法：**
> 1. 第 3 节起的 L2「宿主 Agent 后台解析」方案**已从代码删除**，留作决策记录，不要当现状读。
>    当前链路是 `lib/parse-router.js`：本地解析优先，云端只接受 PDF，非 PDF 一律本地返回。
> 2. 本文下方写的「已移除 `app/sessions.manage`、`app/session.start-turn`、`app/session.stage-file`」**已不成立**。
>    1.8.x 的本体会话桥接重新声明并在使用这三项，见 `manifest.json` 与 `lib/bridge-service.js`。

---

## 0. 已核实的事实（写代码前先认下这几条）

| 断言 | 核实结果 | 证据位置 |
| --- | --- | --- |
| 总线动词 `session:create / send / history / stage-file / delete` 存在 | 真 | `sdk/app-bus-contract.d.ts` 的 `APP_BUS_REQUEST_ALLOWLIST` |
| 权限词 `app/session.start-turn`、`app/session.stage-file`、`app/sessions.read`、`app/sessions.manage` 存在 | 真 | `sdk/app-session-control-capabilities.d.ts`、`app-session-file-capabilities.d.ts`、`app-entity-capabilities.d.ts` |
| `ctx.resources.stage()` 可直接吃沙盒内文件路径并换出 `fileId` | 真 | `sdk/app-contract/context.d.ts` 的 `V2AppStageFileInput` |
| 宿主文档读取能力支持中文 PDF，输出带分页的 Markdown | 真 | 实测《25农机答案版.pdf》→ 干净中文 Markdown |
| 宿主文档读取能力支持扫描件 OCR | **假** | 工具说明：`OCR for scanned/image-only PDFs is not supported` |
| 手写正则解析器读中文 PDF | **假** | 实测输出 `4u&16;7±` 类乱码 |
| 手写正则解析器对图片型 PDF 安全 | **假** | 实测 25MB 文件吐出 629 万字符垃圾 |
| pdf.js（unpdf 1.8.1，纯 JS）读中文 PDF | **真** | 实测 9 页 / 3239 字 / 2591 汉字 / 236ms，零乱码 |
| 宿主 Agent 在私有会话里解析文档（L2） | 链路能跑，但 150 秒内收不了尾 | 见第 5 节失败复盘 |


---

## 1. 三级流水线

```
拖入文件
  │
  ├─ L1 本地算法（<200ms，0 成本）
  │     extractPdfText / extractDocxText
  │     质量评分 → 通过？ ──是──▶ 直接入上下文（source: local）
  │
  ├─ L2 宿主 Agent 后台解析（5~20s，花配额）
  │     私有会话 + stage-file + 固定提示词
  │     产出 Markdown → 落卡片（source: host-agent）
  │
  └─ L3 明确拒绝
        L2 返回"无文字层/无法提取" → 卡片标注需 OCR，给出路
```

**铁律：L1 永远先跑。** 不是因为便宜，是因为它在断网、未授权、后台会话排队时是唯一的活路。

---

## 2. L1：本地算法 + 质量评分

保留现有 `lib/document-parser.js`，只补三件事。

### 2.1 修掉评分漏洞

现有 `isReadableText` 只统计 C0 控制字符，导致 `0xA0–0xFF` 的 mojibake 全数放行。改成整篇评分，而不是逐块过滤。

```js
export function scoreExtractedText(text) {
  const total = text.length;
  if (total < 200) return { ok: false, reason: "too-short", score: 0 };

  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latinExt = (text.match(/[\u00a0-\u00ff]/g) || []).length;   // mojibake 高发区
  const control = (text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g) || []).length;
  const mojiRun = (text.match(/[^\s\u4e00-\u9fa5]{0,3}[ÃÂåäæçèéêëÐÑÞß][^\s]{1,10}/g) || []).length;

  const latinExtRatio = latinExt / total;
  const controlRatio = control / total;
  const mojiRatio = mojiRun / Math.max(1, total / 100);

  const reasons = [];
  if (controlRatio > 0.01) reasons.push("control-noise");
  if (latinExtRatio > 0.02) reasons.push("mojibake");
  if (mojiRatio > 0.05) reasons.push("mojibake-run");
  // 含中文时，汉字占比过低说明编码没对上
  if (cjk > 0 && cjk / total < 0.10) reasons.push("cjk-mismatch");

  return { ok: reasons.length === 0, reason: reasons[0] || null, score: 1 - latinExtRatio - controlRatio };
}
```

阈值都在一个常量块里，别散落各处，方便后续按真实样本调。**这些阈值要拿至少 10 份不同来源的文件校准，一份英文论文不够。**

### 2.2 补符号层

- 连字：`ff → ff`（当前只补了 `fi`/`fl`），`ffi`、`ffl` 同理
- en/em dash：`0x96/0x97` 与 `Ð/Ñ` 一类误映射
- 度数：`¡C → °C`、`±` 系列的八进制还原
- 这些映射必须**表驱动**，别写成散落的 `.replace()`，也别为一个样本硬编码到会误伤正常文本

### 2.3 输出带上来源与评分

```js
{
  ok: true,
  filename, extension, charCount, lineCount, text, preview,
  quality: { source: "local", score: 0.98, reasons: [] }
}
```

下游 UI 和缓存都靠这个 `quality.source` 决定要不要升级。

---

## 3. L2：宿主 Agent 后台解析

### 3.1 权限（manifest.json）

```json
"permissions": [
  "app/session.start-turn",
  "app/session.stage-file",
  "app/sessions.read",
  "app/sessions.manage"
]
```

`app/session.switch-model` 只有在需要显式指定便宜模型时才加。**能不加就不加**，每多一个能力词，安装页的用户信任成本就涨一分。

### 3.2 调用链

```js
// 1. 用户拖进来的 base64 先落到 App 自己的 dataDir（沙盒内可写）
const tmpPath = path.join(ctx.dataDir, "uploads", `${hash}.pdf`);

// 2. 换出宿主认可的 fileId
const staged = await ctx.resources.stage({
  path: tmpPath,
  name: filename,
  mime: "application/pdf",
});

// 3. 开私有会话（plugin_private，不污染用户左侧列表）
const { sessionId } = await ctx.bus.request("session:create", {
  agentId: ctx.config.parseAgentId,        // 配置项，默认选一个便宜模型绑定的 Agent
  visibility: "plugin_private",
});

// 4. 登记附件
await ctx.bus.request("session:stage-file", {
  sessionId,
  resource: staged.resource,               // { kind: "session-file", fileId, sessionId }
});

// 5. 发一条固定指令
await ctx.bus.request("session:send", {
  sessionId,
  text: buildParsePrompt({ filename, maxChars: 40000 }),
});

// 6. 收结果：优先订阅事件流，超时降级为轮询 history
const text = await collectResult(sessionId, { timeoutMs: 45000 });

// 7. 收尾：销毁会话（默认），或按配置保留
await ctx.bus.request("session:delete", { sessionId });
```

### 3.3 提示词必须固定

不许模型自由发挥。模板里的硬约束：

```
你是文档解析器，不是问答助手。
1. 只输出 Markdown，不要任何开场白、总结或评论。
2. 保留原文标题层级（# / ## / ###）。
3. 表格必须还原成 Markdown 表格，保留表头与单位；跨行跨列时拆成多行并重复关键列。
4. 公式输出为 $$ ... $$，行内公式用 $...$。
5. 图注单独成行，以 <!-- 图注 --> 开头，不并入正文。
6. 全文不超过 {maxChars} 字符，超出部分在末尾标注 [已截断至 N 页]。
7. 如果文档没有可提取的文字层，只输出一行：NO_TEXT_LAYER
```

最后那条是 L3 的触发信号。没有它，模型会硬编内容，比读不出来更糟。

### 3.4 并发与排队

同一时刻最多 1 个后台解析会话。多份文件拖入时排队，胶囊上显示"排队中（第 2 位）"。宿主和用户的钱包都受不了并发开五个会话。

---

## 4. 缓存与成本闸

### 4.1 缓存键

文件内容 sha256 前 16 位。落 `dataDir/doc-cache/<hash>.json`：

```json
{ "hash": "...", "source": "host-agent", "text": "...", "charCount": 42000, "createdAt": 1792580000000 }
```

命中即 0 成本、0 延迟。**这是这个功能能不能天天用的关键**，不是优化项。

### 4.2 硬上限

| 项 | 默认值 | 说明 |
| --- | --- | --- |
| 单次送入页数 | 30 | 超长文档取前 30 页 + 目录页，其余标注截断 |
| 单次产出字符 | 40000 | 约 1.5 万 token 量级 |
| 后台会话超时 | 45s | 超时即 `session:abort`，降级 L1 |
| 失败重试 | 1 次 | 第二次仍失败直接降级，不无限重试 |

### 4.3 模型选择

固定一个便宜模型，写在 App 设置里，默认不跟随用户当前聊天模型。理由很简单：解析是苦力活，用主力模型纯亏。

---

## 5. 降级路径（必须全覆盖）

| 情形 | 表现 | 结果 |
| --- | --- | --- |
| 用户没授权 `start-turn` | 胶囊显示"未授权深度解析" | 只用 L1，不弹错误 |
| 无网络 | 同上 | 只用 L1 |
| 后台会话超时 / 报错 | 胶囊标"深度解析未完成" | 回落到 L1 结果，可点重试 |
| L2 返回 `NO_TEXT_LAYER` | 胶囊标"扫描件，需 OCR" | 不给垃圾文本，提示可用 hana-paper-reader |
| L1 和 L2 都失败 | 胶囊标"无法读取" | 明确说明，静默失败不可接受 |

---

## 6. UI 状态机

胶囊只有五态，别再加：

```
抽取中（<1s，几乎看不见）
  ├─ 就绪（本地）          → 灰字，无徽标
  ├─ 深度解析中 → 可取消    → 转圈 + 取消按钮
  ├─ 就绪（深度）          → 一个小圆点 + 字符数
  └─ 读取失败              → 红字 + 原因 + 重试
```

点胶囊展开可看结构化正文预览，不跳页、不新开窗。

---

## 7. 分期

| 期 | 内容 | 验收 |
| --- | --- | --- |
| P1 | 评分函数 + 符号表 + 本地闸门 | 10 份不同来源样本，中文/英文/扫描件分类判定正确 |
| P2 | L2 链路打通（create → stage → send → 收） | 一份中文真题能出干净 Markdown |
| P3 | 缓存 + 硬上限 + 降级 | 同一文件第二次拖入 0 延迟；断网不崩 |
| P4 | 胶囊状态机 + 并发排队 | 三份文件连拖，队列不串、不卡 |

---

## 8. 还没把握的点（动手前先测）

1. `visibility: "plugin_private"` 的会话到底会不会出现在用户左侧列表，实测确认，别按文档猜。
2. `app/sessions.manage` 里 `session:delete` 对私有会话是否同样受管，会不会误删用户会话。
3. 后台会话的 token 计费是否计入 App 的 `usage:list`，能否给用户一个"本月解析花费"的读数。
4. 宿主文档读取能力对**中文横排 + 竖排混排**、**双栏排版**的实际顺序还原质量，需要拿真实中文教材测一遍。

---

## 9. 定稿实现（2026-10-21）

上面 L2 宿主链路最终没有留用。原因是它在私有会话里跑不完：助手能被唤起、也真的 `pdftotext` 出了正确中文，但会继续试 OCR / PyMuPDF 等兜底，150 秒内给不出最终答复，轮询拿不到 assistant 文本。这条路线的收益被它的不确定性吃掉了。

现在的实现是单引擎：

```
拖入文件
  │
  ├─ .pdf  → extractPdfText()   pdf.js（unpdf 1.8.1，纯 JS，随包携带）
  ├─ .docx → extractDocxText()  内存解 ZIP + 抽 <w:t>
  └─ 文本类 → 直接 UTF-8
  │
  └─ scoreExtractedText()  打分只做事后标记，不再触发任何升级
```

要点：

- **引擎选型**：`lib/vendor/unpdf/` 随包携带（2.6 MB，MIT + pdf.js Apache-2.0），不走 node_modules，不 spawn 子进程，不需要 `app/process.spawn`。中文 CID / CMap / ToUnicode 由 pdf.js 内部处理，这是它能读中文的唯一原因。
- **失败分类**：低于 200 字符时回头翻前几页的绘制指令。有画字却读不出字 → `font_mapping`（编码问题）；连画字都没有 → `no_text_layer`（扫描件，需 OCR）。两种说法分开给用户，不再混成一句"读不出来"。
- **权限回收**：`manifest.json` 已移除 `app/resources.read`、`app/sessions.manage`、`app/session.start-turn`、`app/session.stage-file`、`app/session.switch-model`。`lib/host-parse.js` 与其测试已删除（需要时可按本节前面的链路说明重建，权限得重新声明）。
- **体积**：`lib/vendor/unpdf` 只留运行必需的 5 个文件（`dist/index.mjs`、`dist/pdfjs.mjs`、`package.json`、两份 LICENSE），共 1.7 MB。`package.json` **不能删**：pdf.js 模块靠 Node 的包自引用机制（`import "unpdf/pdfjs"`）解析到 `dist/pdfjs.mjs`，删了它整条链就断。类型声明（`.d.ts` 等 155 个文件）与 `index.cjs` 已清掉。
- **Buffer 陷阱**：pdf.js 按构造器严格校验，`Buffer` 会被拒（`Please provide binary data as Uint8Array, rather than Buffer`）。必须 `new Uint8Array(buffer)` 转成裸类型。

### 实测（同一批样本，引擎替换前后对比）

| 样本 | 旧（手写正则） | 新（pdf.js） |
| --- | --- | --- |
| 25农机答案版.pdf | 464 字，全乱码 | 3239 字，2591 汉字，236ms |
| Angew 英文正文 | 44,049 字 | 45,196 字，146ms |
| Nature 综述 | 659,740 字（大量重复） | 159,946 字，1081ms |
| 合格证.pdf（扫描件） | 6,296,118 字垃圾 | 正确报 `no_text_layer` |
| 2.pdf（DSC 曲线图） | 624 字乱码 | 273 字，图内标注文字正确 |

代价：包体积 +2.6 MB，PDF 解析从约 40ms 变到 150–1000ms（页数相关）。换来的是中文可读、扫描件不乱吐垃圾。
