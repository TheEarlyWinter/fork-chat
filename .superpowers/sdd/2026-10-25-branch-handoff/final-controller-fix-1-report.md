# Final Controller Fix 1：I2 保存边界报告

日期：2026-10-25
分支：`feat/branch-handoff`
基线：`781d477`

## 结论

I2 保存边界已实现。未修改 backend、SDK、Store、shared contract、Host/model、依赖或打包产物。

关键行为：

- `flush(force = false)` 保持原签名。`force` 只绕过 busy/关闭前的 best-effort 门，不授权覆盖冲突。
- 新增 `retrySave()`。只有明确重试操作才允许读取最新 revision 后做 CAS 覆盖。
- sticky conflict 阻断普通自动保存、`flush(true)` 和 `close()` 覆盖远端。
- 远端删除冲突保留本地画布，只能通过 `saveCopy()` 恢复。
- clean 同 ID 远端 revision 更新会读取并采用完整快照，同时推进 generation、取消旧请求。
- dirty 远端更新、切换或删除保留本地内容并显示冲突。
- 保存、刷新、Handoff、Bridge 的异步结果均做 scope/owner/generation/activeId/closed 校验。
- watch 事件在保存或生命周期切换期间延后，操作结束后只补做一次 refresh，不等待自身 tail。
- `install()` 期间屏蔽渲染层 `updateTransform()` 触发的 `scheduleSave()`，避免外部快照刚采用就被误标记为 dirty。
- 删除确认文案明确提示已保存版本可能来自其他窗口。

## TDD 记录

RED 提交：

- `f71cf24`：I2 冲突边界测试。
- `32ed1ff`：retry、CAS race、sticky close、Handoff stale preview 测试。

GREEN 提交：

- `3c12c1c`：Controller sticky conflict、`retrySave()`、最新 revision CAS、saveCopy 删除冲突恢复、旧 Handoff loading 收尾。
- `d1c87a3`：补齐 install/refresh 生命周期串行化，修复真实 panel 中外部快照被 `updateTransform()` 误标 dirty 的回归。

## 验证结果

### 定向测试

- `tests/fork-session-controller.test.mjs` + `tests/integration.test.mjs`
  - 107 passed
  - 0 failed / skipped / cancelled / todo
- 更宽的相关回归集：223 passed，0 failed。

### 双 Node 全量

命令核心均为：

```text
node --experimental-vm-modules --test --test-concurrency=4 "tests/*.test.mjs"
```

结果：

- Node v24.21.0：1207 passed，0 failed，0 skipped，0 cancelled，0 todo。
- Node v26.12.1：1207 passed，0 failed，0 skipped，0 cancelled，0 todo。

测试期间 `/tmp` 已有约 5.8 GiB 的历史 parser 临时目录。为避免环境配额导致 `write -122`，最终两次全量测试使用独立 `TMPDIR`；测试参数和测试集合不变。

### 语法检查

逐文件 `node --check`：10/10 通过。

检查文件包括：

- `ui/assets/fork-session-controller.js`
- `ui/assets/panel-session-ui.js`
- `ui/assets/panel-handoff.js`
- `ui/assets/panel-handoff-view.js`
- `tests/fork-session-controller.test.mjs`
- `tests/panel-session-ui-phase1.test.mjs`
- `tests/panel-handoff-controller-fix.test.mjs`
- `tests/panel-handoff-lifecycle.test.mjs`
- `tests/panel-bridge-intents.test.mjs`
- `tests/integration.test.mjs`

## 性能开销

- 正常持久化写路径没有增加额外完整快照读取。
- dirty 冲突仍由 revision/CAS 边界保护。
- `refresh` busy/saving 期间只设置一个内存布尔标记；操作结束后最多补发一次 list/get 流程。
- `install` 只增加一个进程内布尔 owner，不增加 Host 或 Store 调用。
- clean 快路径和明确 retry 仍按 I2 要求检查远端 revision，避免用旧 snapshot 冒充最新保存。

## 未验证项

- 未访问真实 Host、session、model。
- 未做部署、打包、发布或浏览器真实多窗口验收。
- 仍需 main 亲审和 fresh scoped review；本报告不宣称最终交付。
