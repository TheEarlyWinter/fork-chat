# Handoff Chat Display Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkboxes track execution.

**Goal:** 让已交接的 Chat 会话可见完整正文与真实文件入口，交付2.3.0-beta.4。

**Architecture:** 正式 messageRenderers + 专用只读页；宿主绑定 sessionId；后端只读投影已保存 App custom entry，不以动作临时payload为长期数据源。新消息携带安全视图元数据，旧消息凭 owner 动作回执恢复显示。

**Tech Stack:** 现有ESM、Hana SDK、Node test runner；不引依赖。

**Spec:** docs/superpowers/specs/2026-10-26-handoff-chat-display-design.md

## Global Constraints

- 基线8fa083d、分支fix/handoff-chat-display；开发副本单源码写手，原项目/平台/安装目录不动。
- 不改PM IO、claim状态机或失败不重发。不重新create/stage/补发已有消息，不启动真实模型/GUI。
- 版本2.3.0-beta.4，minAppVersion=1.2.1-beta，12项权限和网络不变。
- 只使用正式SDK与已有已鉴权requestHost；卡片只认embeddedSessionId，无绑定不请求，不借getActive/origin/URL猜。
- 原生附件气泡不是当前接口能力；本次提供卡片中的真实SessionFile预览入口，不伪造消息。
- 必要RED/GREEN、Node26全量一次、一次独立审查；不复跑Node24全套或掉电测试。

## Review Focus

- 旧beta.3消息无view元数据：用owner动作的sessionId/entryId/actionId三者校验，显示宿主原文；不重新发送。
- 新动作记录回收后历史卡空白：新view owner stamp+宿主entry足够，测试用空fakeStore，不真实删除数据。
- 全局焦点/源会话误当目标：embedded绑定、无绑定不请求、绑定变化清空、旧响应不可覆盖。
- 外来custom、私有会话或其他owner泄漏：严格type/namespace/public/sessionId/stamp，响应无其他消息与路径。
- 首次拉全entries开销：每绑定1GET，不轮询；只缓存授权投影，32项/16MiB有界与inflight去重。

### Task 1: 只读交接卡与发布包

**Files:**
- Create: lib/handoff-receipt-view.js, ui/handoff-receipt.html, ui/assets/handoff-receipt.js（必要时另拆极小bootstrap/CSS）
- Modify: lib/handoff-service.js, manifest.json, README.md
- Tests: tests/handoff-receipt.test.mjs, tests/handoff-receipt-card.test.mjs；必要最小调整既有service/integration用例。
- Read/reuse: lib/handoff-http.js、artifact-owner.js、handoff-store.js、handoff-host.js；ui/assets/host-api.js、sdk.js；sdk/app-contract/sessions.d.ts、bus-requests.d.ts与_ui-protocol.d.ts。

**Interfaces:**
- `createHandoffReceiptReader({sdk, store, maxCacheEntries=32, maxCacheBytes=16777216})` 返回 `read({owner,sessionId})`。公开只读SDK get/entries，无私有总线或文件。
- `createHandoffViewDetails({owner,agentId,files})` 生成v1 view元数据（server SHA256 owner key，严格安全文件回执）；加入writeContext.details.handoffView，不改正文和triggerTurn。
- 新GET沿现有wrap取得owner，调用reader，返回 `{ok:true, receipt:{sessionId,actionId,agentId,source,transcript,files}}`。DTO不含ownerScopeKey、路径或无关消息。文件为可信fileId/name/mime/kind，sessionId由该receipt统一限定。
- 前端工厂 `createHandoffReceiptCard({hana,documentRef,requestHost})`（具体导出名保持一致即可），返回dispose；bootstrap按现有SDK ready模式挂载。无业务写操作。

- [ ] 新增RED：实际manifest必须有branch-handoff→带route的专用卡；当前缺映射应失败。新reader/card行为先RED，不能只有静态字符串断言。
- [ ] 核对真实get返回`{session:...}`，entries返回`{sessionId,entries,leafId}`；custom entry为`type:custom_message`/namespaced customType/content/display/details/id/parentId。不使用假SDK里不存在的focus服务端方法。
- [ ] 实现reader：校验public home metadata与精确sessionId；稳定owner；活动父链筛选本App display=true消息。新元数据严格校验owner stamp，旧消息凭同owner Store.list动作回执；0条404、多条409、非法/归属冲突拒绝。只投影完整原文和安全文件回执。
- [ ] 加owner+session有界缓存与inflight去重，不缓存失败。正文按既有HANDOFF_LIMITS加合理格式开销硬上限，拒绝过量不截断。缓存仅投影数据，不缓存整会话历史。
- [ ] service仅新增GET和新writeContext.details.handoffView；旧流程行为不变。元数据包括原产物及archive回执，不增加create/stage/custom次数。
- [ ] 轻量HTML/CSS与前端：ready后读宿主surface，embeddedSessionId必需；绑定变化清空/丢弃迟到响应；全文textContent安全显示；文件按钮调用正式resources.open精确session-file。错误明示，不自动重试写或调用模型。不要加载整套panel/画布。
- [ ] manifest新增cards/messageRenderers，版本/min宿主按全局值；README简述旧会话重开即可投影（有旧回执时）和卡片文件入口，不宣称原生附件气泡。
- [ ] 定向GREEN：新2文件+service/host/integration/panel相关+PM新3例；JS --check。必要失败只定向修，不扩大无关重构。
- [ ] 点名git add并本地提交。冻结HEAD后Node26全量一次：`node --experimental-vm-modules --test --test-concurrency=4 "tests/*.test.mjs"`，无fail/skip/cancel。
- [ ] 正式打包至新目录fork-chat-2.3.0-beta.4-handoff-chat-display-fix，原TOOLS，tag v2.3.0-beta.4。核静态0错误、ZIP CRC/SHA、build-info最终commit、源码相同、权限网络不变。不删除旧包；动态依赖warning如实。
- [ ] 报告写本轮task1-report.md，含RED/GREEN命令与统计、commit、包路径/hash、未验。停止源码写入，不安装/push/merge/真实GUI或模型。

### Task 2: 审查、正式更新与实机收口

- [ ] 主线程亲读关键生产diff，独立Luna审查一次；仅修真阻断并定向验证，不重跑全量。
- [ ] 核最终包并交付，extension_manager正式提交更新。需本人确认则明示待确认，不代点。
- [ ] 安装确认后，由怜在用户提供的原Chat会话核卡片、全文、文件预览和一次最小上下文问答；先核精确对象，不重建交接。无法合法访问就报告具体阻塞，不盲点/越界。
