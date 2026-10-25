# 文档产物权限模型兼容修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使文档产物在真实Node权限模型下生成并可读取，不关闭沙箱或降低现有文件发布保证。

**Architecture:** 为独占文件打开增加显式同步写选项。仅artifact publish在Permission Model下使用O_SYNC，并避免被禁止的FileHandle.sync；普通运行保留原路径。目录同步协议不在本次修改。

**Tech Stack:** JavaScript ESM、node:test、Node24/26、真实Node --permission子进程。

**Spec:** `docs/superpowers/specs/2026-10-25-artifact-permission-sync-fix-design.md`

## Global Constraints

- 只改开发副本；不动已安装App、平台/系统配置、权限及用户画布。
- 源基线dc614aa。保留未跟踪dist-real-device/，不改、不纳入提交或打包输入。
- 不关闭权限模型，不用子进程/native addon/SQLite绕过权限，不吞真实IO错误。
- 单一源码写代理。结构化write/edit改源。新增测试如被忽略，用点名git add -f，不用git add .。
- 不删除历史临时目录，不推送发布，不自动安装，不调用真实模型或创建宿主会话。

## Review Focus

1. Node26真实PM下首次create和重建后的read均成功，不能只验证flag存在。
2. 三个产物文件都采用正确写入方式；不能只修document.bin而漏manifest。
3. 路径、独占创建、软链接拒绝、owner隔离及不可变版本保持。
4. 普通模式sync失败和PM模式open/write/close失败不能伪装ready；取消不能发布半成品。
5. 目录同步不被跳过；此次修复不能误报完整handoff已兼容。

---

### Task 1: 文档产物兼容修复与回归

**Files:**
- Modify: `lib/file-safety.js`
- Modify: `lib/artifact-store.js`
- Create: `tests/artifact-permission-model.test.mjs`
- Create if needed: `tests/helpers/artifact-permission-child.mjs`
- Existing regression: `tests/document-artifacts.test.mjs` 与相关安全/版本测试。

**Interfaces:**
- `exclusiveFile(root, name, { synchronous = false } = {})` 返回真实FileHandle。默认flags不变；synchronous=true时额外要求并添加O_SYNC，保留其余安全标志和mode。
- `createArtifactStore({dataDir})` 和对外service/产物schema不变。
- Permission Model检测使用可信进程运行态，不使用前端参数或模型输入。PM内三个文件用synchronous=true，写完关闭后再rename；普通模式继续await file.sync。

- [ ] 写真实子进程回归：用process.execPath启动--permission，仅授予项目读权限与自有短临时dataDir读写权限。通过真实createArtifactService.create生成短MD，核对read/export/preview和重建后读取、内容字节、owner隔离及manifest发布。不使用真实模型或宿主。
- [ ] 使用实际Node26运行新测试，确认RED为fsync禁用及无ready，不是缺模块、临时目录、参数或权限授错。
- [ ] 为默认独占打开、显式O_SYNC、符号链接/重复创建拒绝和写失败不发布建立必要测试。保留现有异常测试，不为变绿放宽断言。
- [ ] 仅按上述接口修改两个生产文件；不修改其他存储协议。若必须扩大范围，先报告原因。
- [ ] Node24和Node26各运行新测试及既有文档回归；核对GREEN。
- [ ] 使用自有短临时目录测量一次大产物写入，报告大小、耗时和环境；不设脆弱的绝对计时断言。
- [ ] 点名暂存并本地提交测试/修复；报告RED命令、GREEN命令、SHA、实际变更及未验边界。测试和生产提交可分开以保留RED证据。不要提交dist-real-device/或内部材料。

### Task 2: 审查、完整验证和离线交付

- [ ] 主线程读取关键差异；由独立Luna实例审查安全、PM覆盖、异常传播与范围。
- [ ] 在最终修复上运行Node24/26全套：`node --experimental-vm-modules --test --test-concurrency=4 "tests/*.test.mjs"`。使用新短TMPDIR，保留完整输出，不删除旧目录。
- [ ] 对实质修改JS做两运行时语法检查；无根package.json，不虚构npm lint/typecheck。
- [ ] 更新manifest预览版为2.3.0-beta.2，使用正规脚本打包到资料库新的独立目录，不覆盖旧包。
- [ ] 核对ZIP manifest、结构、CRC、版本、SHA256及官方静态校验。若UI smoke仍受环境限制，按实测报告，不声称通过。
- [ ] 交付新ZIP、校验和及短修复说明。明确：只修文档产物路径；目录fsync依赖的handoff等路径仍可能受阻，未做安全保证降级。安装后由用户重测原A节点生成文档，不自动恢复旧实机任务。
