# 交接文件预览实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 subagent-driven-development 执行。用户已授权独立修复；沿用唯一源码写手和一次独立审查，不重复询问执行方式。

**Goal:** 让已交付的 MD 和纯文本从宿主真实文件按需读取并在卡内打开。

**Architecture:** 新只读文件 reader 复用现有 owner 与 receipt 鉴权。后端走正式 ResourceIO，前端复用安全 Markdown 渲染方式并可看完整原文。非文本保留原入口。

**Tech Stack:** 现有 JavaScript ESM、Hono、Node26、原生 DOM、现有 document-spec/document-html。

**Spec:** `docs/superpowers/specs/2026-10-26-handoff-file-preview-design.md`

## Global Constraints

- 仅开发副本；基线 fff28a239aa9d1df0432170a9e85d50056d71d62。
- 不改宿主、安装目录、PM IO、stage、claim、unknown；不迁 KV、不重发消息、不启动模型。
- 2 MiB 文件上限；4 MiB 渲染 HTML 上限；4 个不同文件并发；同键合并；无内容缓存。
- 版本 2.3.0-beta.5；13 项权限不变；不加依赖或轮询。
- 单源码写手；必要 RED/GREEN、相关回归、一次全量、一次独立审查。
- 不批量删除；不回退他人改动；只点名 git add；不 push/merge。

## Review Focus

- 缓存 receipt 不得放宽跨 owner/session/file 授权；未归属时不得调用 ResourceIO。
- SDK stat/read 真实字段与 Buffer 恢复必须正确，不混淆 Core Preview 协议或空间标签。
- stat 超限不得 read；read 后超限仍拒绝；非法 UTF-8 不能替换后冒充原文。
- Markdown 子集不能造成信息丢失；原文始终完整；HTML 不执行、不联网。
- 关闭、切换绑定、卸载及并发迟到必须隔离；文件错误不泄漏宿主路径。

## Task 1：交接文件按需预览

**Files:**
- Create: `lib/handoff-file-preview.js`。
- Modify: `lib/handoff-service.js` 的只读路由；`ui/assets/handoff-receipt.js`；`ui/handoff-receipt.html`。
- 可创建轻量 `ui/assets/handoff-file-preview.js` 管理预览 DOM；不要导入整个 panel-artifact-view。
- Test: 新 `tests/handoff-file-preview.test.mjs`；扩展 `tests/handoff-receipt-card.test.mjs`，必要时补 handoff-service 路由测试。
- Modify: `manifest.json` 版本、必要发布说明；其它文件只改直接关联处。

**Interfaces:**
- Consumes: `receiptReader.read({owner,sessionId})`；`sdk.resources.stat/read(ref)`；现有安全文档渲染器。
- Produces: `createHandoffFilePreviewReader({sdk,receiptReader}).read({owner,sessionId,fileId})`；GET preview 路由；规格定义的 preview DTO。

- [x] Step 1: 写行为 RED。覆盖已登记但前端表未加载时仍能显示真实 MD 字节；完整原文；无 ResourceOpen 调用；拒绝不属于回执的文件且资源读取次数为零。
- [x] Step 2: 补齐规格边界 RED。包括完整资源回执、空文件、stat/read 各自超限、错误身份、解码失败、恶意 HTML、复杂度/HTML 大小回退、并发合并/上限、绑定/关闭/卸载迟到。
- [x] Step 3: Node26 定向运行，保存 RED 输出；确认因功能缺失而失败，不是导入错误。再按上述接口最小实现并 GREEN。
- [x] Step 4: 跑相关 handoff、文档渲染、安全与 UI 回归。只跑一次 Node26 全量：`node --experimental-vm-modules --test --test-concurrency=4 "tests/*.test.mjs"`。日志放本计划 outputs；不存在根 npm lint/typecheck，不虚构。
- [x] Step 5: 自审 owner/Buffer/错误与生命周期，提交允许文件，记录精确 SHA 与验证。源码写手停止写，交父线程独立审查。
- [ ] Step 6: 审查通过后再打 beta.5 包，核版本、权限、ZIP CRC/SHA 与 HEAD 内容。用正式管理器提交更新。按原文件做实机核验，不重做交接。

Node26：`/home/theearlywinter/.hanako/artifacts/server/1.2.1-beta-linux-x64-c4109a2859588978-g70ab71a32719fa1b/node`。
