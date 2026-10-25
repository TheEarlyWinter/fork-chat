# 选定分支在 Hana 中继续：实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将选定节点所依赖的已保存业务上下文交给新的 Hana 主页会话，不主动启动模型。

**Architecture:** 共用纯协议与上下文编译模块；后端分别承担宿主适配、持久化动作和流程编排；前端控制器仅预览、确认、恢复和跳转。旧回传与模型预算器保持原有行为。

**Tech Stack:** 原生 JavaScript ESM、Node.js 内置模块、现有 Hana App SDK、现有原生 UI 与 Node test runner。不引入依赖。

**Spec:** `docs/superpowers/specs/2026-10-25-branch-handoff-design.md`

## Global Constraints

- 工作区仅为当前 `feat/branch-handoff` 开发副本。原源码目录不改。
- 不安装、更新、启用或扩权已安装 App，不改宿主授权账本，不推送、不发布、不删除会话。
- 默认 `namespace: home`、`memoryEnabled: false`、一条 `sendCustom`、`display: true`、`triggerTurn: false`。不得调用 session:send、模型流或旧回传确认。
- 新增声明只考虑 `app/sessions.home`；沿用目标 Agent 的模型和思考默认值，不改变其权限模式、工具或目录授权。
- 共享协议和上下文编译不得依赖 DOM、SDK 或文件系统；主入口只挂载。
- 目标节点纳入；exclude 祖先不贡献正文但不中断祖先遍历；来源被排除的引用不泄漏正文。显式跨分支引用只带快照。
- 不摘要、不静默裁切、不用附件登记或 appendEntry 冒充模型上下文。
- App 上限：300 节点；最终正文 2 MiB；prepare JSON 4 MiB；单产物 16 MiB；最多 16 个产物且合计 64 MiB。预留 64 KiB 正文用于宿主文件索引，超限在创建前拒绝。
- 动作、正文和 artifact 共用稳定 principalId 的 canonical owner；未知结果不重发，半成品不自动删除。
- 先写测试并观察预期失败，再实现；每任务结束跑一次全套，不掩盖原有失败。新测试位于被忽略的 tests/，提交时显式 git add -f 相关测试。

## Review Focus

- 旧快照可能已裁切附件却没标记；达到阈值或 charCount 不符时不能称完整。归 Task 1。
- 多窗口改动与预览版本不一致；按成功 flush 的不可变版本交接，确认不读实时画布。归 Task 3。
- 创建成功但回执未落盘；unknown 可能没有 sessionId，不得自动重建或删除。归 Task 2。
- 正式 SDK 与旧 SDK 不同；缺命名方法时拒绝，不偷偷改调用语义。归 Task 2。
- 宿主已接收但前端销毁/跳转失败；重开查询同一 action，不再次确认或创建。归 Task 3。

---

## 共用数据接口

DTO 与函数的完整 JSDoc 随 Task 1 落地，以下名称固定，字段可增加白名单元数据但不得改变含义。

`HandoffContext` 至少包含：schemaVersion:1；source:{canvasId,revision,targetCardId}；agentId；nextStep；nodes（拓扑排序，包含角色、状态、资料和已发送文本附件）；references（明确来源及快照状态）；artifactIds（去重）；exclusions；notices；stats。

UI 只提交该 DTO，不提交任意磁盘路径、owner、权限模式、工具选择或 Provider 信息。服务端重新白名单校验和格式化，不信任客户端正文或指纹。DTO 的完整性只对该冻结快照负责，不虚构服务端对实时画布的认证。

协议文件放在 `ui/assets/`，便于浏览器正常静态导入；Node 后端使用同一纯模块，不维护第二份 schema、限额或格式化器。这是对规格建议路径的技术定案。

### Task 1: 完整上下文编译与共享协议

**Files:**
- Create: `ui/assets/fork-handoff-contract.js`
- Create: `ui/assets/fork-handoff-context.js`
- Modify: `ui/assets/fork-snapshot.js`（仅已发送附件裁切标记的保存与恢复）
- Create: `tests/handoff-context.test.mjs`
- Modify: `tests/fork-session-store.test.mjs`（裁切标记回归）

**Interfaces:**
- Consumes: 既有 snapshot、parentId/parentIds、contextMode/contextRefs、附件和 artifact 元数据。
- Produces: `HANDOFF_LIMITS`、`handoffError(code,message)`、`validateHandoffContext(value)`、`formatHandoffTranscript(context,{files=[],archiveFile=null}={})`，均位于 contract。
- Produces: `buildHandoffContext({snapshot,source,targetCardId,agentId,nextStep=''})`，返回经过校验的 HandoffContext；统计由实际内容重算。
- 对无内容、环、缺父、重复 ID、截断、引用冲突、生成中和超限，抛带稳定 code 的错误；可披露但允许的情况写入 notices。
- 附件产物索引使用宿主回执中的 fileId/name/mime，不在 prepare 时伪造 ID；格式化器保留 nextStep 为“尚未执行的下一步要求”。

- [ ] **Step 1: 写失败测试**：`handoff follows only dependencies and keeps every sent message` 断言菱形共同祖先一次、角色顺序和相邻同角色消息均保留、兄弟节点正文不出现。
- [ ] **Step 2: 扩展失败用例并跑 RED**：exclude 目标/祖先、跨分支/已删除/已排除引用、重复引用冲突、缺父/环/重复ID、资料正文和附件、草稿不入历史、失败标记、产物去重、截断/charCount 不符、精确体积阈值、深链无栈溢出。
- [ ] **Step 3: 实现纯协议与编译器**：用 ID 索引及迭代拓扑排序；严格验证输入并重算派生字段。不要调用现有会裁切历史的模型上下文计划器。
- [ ] **Step 4: 补消息附件的 dropped/truncated 标记及恢复回归**：不更改旧正文，不改解析/上传逻辑；旧数据不确定时拒绝“完整”。
- [ ] **Step 5: 跑 focused GREEN 与全套**：`node --experimental-vm-modules --test tests/handoff-context.test.mjs tests/fork-session-store.test.mjs`，再 `node --experimental-vm-modules --test "tests/*.test.mjs"`。
- [ ] **Step 6: 自审并提交本任务源码与相关测试**：不提交其他人的改动。报告 RED/GREEN、全套计数、文件及剩余问题。

### Task 2: 宿主适配、持久动作与独立服务

**Files:**
- Create: `lib/handoff-host.js`
- Create: `lib/handoff-store.js`
- Create: `lib/handoff-service.js`
- Modify: `manifest.json`（只增加 home 声明，兼容最低版本以官方校验支持格式为准）
- Sync: `sdk/`、`ui/assets/sdk.js` 中本功能确需的官方 SDK 生成产物；记录版本来源，不手改生成文件。只用已安装官方 1.1.111-beta tgz，不下载或运行新宿主。
- Create: `tests/handoff-host.test.mjs`、`tests/handoff-store.test.mjs`、`tests/handoff-service.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 HandoffContext 与 contract 导出。
- Produces: `createHandoffHost({sdk})`，提供异步 `capabilities()`、`create({agentId})`、`isIdle(sessionId)`、`stage({sessionId,path,name,mime})`、`writeContext({sessionId,content,details})`。保持 SDK 方法 receiver，优先使用命名接口。仅接受主页/public 的创建回执；writeContext 必须是 notifyOnly 且有 entryId。
- Produces: `createHandoffStore({dataDir,fs,clock})`，方法 `prepare({owner,context})`、`get({owner,actionId})`、`list({owner})`、`claim({owner,actionId})`、`checkpoint({owner,actionId,state,receipt})`。可按需求补内部辅助方法，外部不接收任意路径。
- Produces: `createHandoffService({sdk,dataDir,artifacts,host,store})`，artifacts 复用既有 `artifactService.read({owner,artifactId})`，host/store 可注入测试；返回 `register(app)`。
- Routes: GET `/api/handoff/capabilities`；POST `/api/handoff/prepare`（body 为 HandoffContext）；POST `/api/handoff/confirm`（仅 actionId）；GET `/api/handoff/actions/:actionId`；GET `/api/handoff/actions`。
- Returns: `{ok:true,action}` 或 `{ok:false,code,error}`；capabilities `{ok:true,...caps,limits}`。action 至少有 actionId/state/source/agentId/payloadHash/createdAt/bytes/sessionId/files/errorCode，只有同 owner 能读。
- State: prepared→creating→importing→ready；以及 failed/partial/unknown。持久化独占派发标记跨进程阻止相同 action 重放。不得用一个可覆盖的共享 JSON 文件当跨进程锁。
- Prepare 只落 App 私有盘，验证 Agent/权限及产物完整性，不创建宿主会话。Confirm 复核后 create→逐个 stage 产物→stage 完整 Markdown→write 一条 custom→ready；正文格式化和文件索引超过上限则 partial 而非裁切。
- Store 默认 TTL 30 分钟、每 owner 最多 32 动作、prepare 正文合计最多 16 MiB。准备超限先回收仅 prepared 且已过期动作；unknown 的派发标记不可自动回收。只删除明确路径的单个过期文件，不递归/批量删目录。
- 官方 SDK：`/home/theearlywinter/.hanako/skills/hana-app-creator/assets/sdk/hana-app-sdk.tgz`。只读宿主证据位于已安装 1.1.111-beta artifact；不要修改托管 SDK 或已安装 App，仅同步开发工作区生成依赖。

- [ ] **Step 1: 写 host RED**：命名 SDK 缺失、能力拒绝、home/memory false、错误可见性、busy、triggerTurn false、notifyOnly 回执、stage 不调用 send。
- [ ] **Step 2: 写 store RED**：owner 查询/确认隔离、缺稳定 principal 拒绝、持久化失败不派发、两个 store 实例并发 claim 仅一个成功、重启恢复 unknown、重复确认不重放、无 sessionId 的未知创建不再调用 create。
- [ ] **Step 3: 写 service RED**：preview/prepare 无宿主写、无权限不 create、产物去重与 owner/hash 校验、每阶段故障状态、只一条 custom、篡改 confirm 载荷无效、正文/JSON/文件/队列限额。
- [ ] **Step 4: 实现适配、store 和编排**：所有正文私有落盘，原子提交及同步屏障；不吞落盘失败。日志不含正文。上面三个模块不得合并成巨型入口；若单文件明显超过约 400 行，报告并在本职责内拆成小辅助文件，不挤进 index.js。
- [ ] **Step 5: 同步必要官方 SDK 并声明 home**：只替换开发源码中的官方生成产物，不改全局角色、模型配置或真实授权。验证旧 App 功能不受 SDK 变化影响。
- [ ] **Step 6: 跑 focused GREEN 与全套**：`node --experimental-vm-modules --test tests/handoff-host.test.mjs tests/handoff-store.test.mjs tests/handoff-service.test.mjs`，再全套命令。
- [ ] **Step 7: 自审并提交**：报告精确测试数、RED/GREEN 和尚未实机验证的项目。

### Task 3: 界面、入口集成与可交付验收

**Files:**
- Create: `ui/assets/panel-handoff.js`
- Modify: `ui/assets/panel-cards.js`（按钮）
- Modify: `ui/assets/panel-card-events.js`（路由事件）
- Modify: `ui/assets/panel.js`、`index.js`（只做依赖注入、初始化、清理和注册）
- Modify: `ui/assets/panel.css`、`ui/panel.html`（仅需要的原生对话框结构/样式，优先控制器动态创建）
- Create: `tests/panel-handoff.test.mjs`、`tests/handoff-integration.test.mjs`
- Modify: `README.md`、`CHANGELOG.md`，以及已有受入口按钮影响的相关测试

**Interfaces:**
- Consumes: Task 1 builder/formatter；Task 2 routes/action。
- Produces: `createPanelHandoff(deps)` → `{open(targetCardId),dispose()}`。deps 通过现有主协调器注入 requestHost/hana、snapshot 捕获、sessionController.flush/state、Agent 列表及 toast/生命周期信号，不从 window 偷取全局状态。
- 按钮文案“在 Hana 中继续”，旧“回传原会话”保留。按钮动作固定 `handoff`，通过既有 card events 委派。
- 流程：flush→冻结成功保存的 snapshot/revision→选择有效 Agent→预览→prepare→只确认 actionId→查询同动作结果→ready 后允许 focus。双击单飞，画布切换/销毁不串线、不重建。
- 对话框说明：默认关闭记忆、不主动启动模型、快照不再同步、原件未保留等 notices。下一步要求写入交接正文，不承诺宿主输入框预填。
- 用户可预览节点折叠正文和附件，明确错误/排除项、正文体积及来源版本；有完整性错误时禁止确认，不用 innerHTML 注入对话文本。
- partial/unknown 展示可理解的提示；已知 sessionId 可打开核查。重新加载只 GET 动作列表，不自动 confirm。
- 适配旧宿主/无权限时旧功能仍可用，入口提示原因，绝不私有会话降级。

- [ ] **Step 1: 写 UI RED**：flush 失败无 prepare、冻结版本不随画布变化、有效/失效 Agent 选择、草稿 nextStep 仅明确复制、禁用重复确认、确认不发送修改后正文、ready 后 focus、focus 失败不重建、销毁/切换后不更新错误画布、重开只查询。
- [ ] **Step 2: 写 integration RED**：接入真实 builder+真实 service/store 和假宿主，通过一次完整控制器流程验证 custom 全文与文件、固定参数、无 send/model 调用；非法 owner/权限与 partial/unknown 回归。
- [ ] **Step 3: 实现控制器及必要入口挂载**：沿用现有白底原生样式和可访问对话框，Escape/焦点恢复/忙碌状态可用。不重做画布，不扩大旧回传行为。
- [ ] **Step 4: 跑 focused GREEN 与全套**：`node --experimental-vm-modules --test tests/panel-handoff.test.mjs tests/handoff-integration.test.mjs`，再全套命令。
- [ ] **Step 5: 文档记录真实限制**：更新 README/CHANGELOG，明确 custom 文本导入而非原生历史，手动授权入口与宿主测试尚未完成。
- [ ] **Step 6: 自审并提交**：执行已有 release-package 的本地测试、官方 validator/smoke/pack（先读脚本帮助，使用本机官方 artifact）。不得安装、授权、发布或创建真实宿主测试会话。

## 收尾

- [ ] 每个任务独立审查规格与质量；修复重要问题后再进入下一任务。
- [ ] 全分支独立审查；主线程亲自核对关键接口、状态归属、权限与异常分支。
- [ ] 最终再跑全套、语法/类型与仓库已有静态检查、官方打包校验，记录所有未验项。
- [ ] 向用户交付改动、测试证据和本地安装包（如打包成功），明确未安装、未扩权、未实机调用模型。任何必须宿主实际操作的验收另行确认。
