# Handoff Permission Model Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** 恢复真实 Node Permission Model 下的完整交接，交付 2.3.0-beta.3。

**Architecture:** 保留文件 Store、claim 和回执协议；交接专用 IO 策略在 PM 下使用 O_SYNC 文件写入并免除不支持的目录同步，普通 Node 不变。用户已明确接受不承诺掉电恢复。

**Tech Stack:** JavaScript ESM，Node24/26，现有 Node test runner 与正式 Hana App 打包工具，无新依赖。

**Spec:** docs/superpowers/specs/2026-10-26-handoff-permission-model-compat-design.md

## Global Constraints

- 仅开发副本；基线74de8cb；单写手；不修改平台或已安装目录。
- 保留完整正文、文件、owner、原子独占 claim、阶段回执、unknown/partial 不重发。
- home、明确Agent、memoryEnabled=false、triggerTurn=false；prepare 无宿主创建和模型调用。
- PM 明确取消目录同步和掉电恢复承诺；不是 catch 同步异常后装成功。普通 Node 原语义不变。
- 保留新CI、测试入库/重组、.gitattributes排除；不重构无关测试；不删除历史文件。
- 用户要求加速：必要定向 RED/GREEN，一轮最终全量，一次独立审查；不重复全套。

## Review Focus

- prepare 通过后 delivery 仍调用 sync：完整带至少一个产物的 PM 服务用例覆盖。
- 取消目录 sync 时目录安全检查被跳过：保留 lstat/非链接/真实目录验证。
- close/rename 失败假成功：写关闭失败传播，既有故障回归覆盖。
- 重复确认与服务重建再次创建：同 actionId 的宿主 create 总数保持1；并发只一个 claim。
- 字符串 wx 改数值后普通注入测试失配：非PM flags原样保留，PM实际使用O_SYNC。

---

### Task 1: 最小兼容修复、关键验证和修复包

**Files:**
- Create: lib/handoff-io-policy.js
- Modify: lib/handoff-store-io.js, lib/handoff-delivery.js, ui/assets/panel-handoff-view.js, README.md, manifest.json
- Test: tests/handoff-permission-model.test.mjs, tests/helpers/handoff-permission-child.mjs
- Read/reuse: tests/fixtures/handoff-fixtures.mjs, tests/handoff-store.test.mjs, tests/handoff-service.test.mjs, tests/handoff-delivery.test.mjs

**Interfaces:**
- `handoffUsesSynchronousWrites(): boolean` 使用真实 process.permission。
- `handoffWriteFlags(ordinaryFlags: string | number): string | number` 非PM原样返回；PM使用O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_SYNC，不支持O_SYNC则抛错。只支持现有wx或既有数值独占写flags。
- store/service/delivery公开接口及HTTP DTO不变；无新能力字段/设置，无KV迁移。

- [ ] 新增真实 `--permission` 子进程用例，复用合法上下文和fake host。至少覆盖一个真实产物+交接Markdown、prepare无host调用、confirm ready、正文可核对、create一次。
- [ ] 先跑Node26新用例，确认RED是旧代码HANDOFF_STORE_IO/sync失败，而不是启动参数或fixture无效。保留简短日志。
- [ ] 最小实现策略与两条IO路径；PM免目录同步前保留目录安全核验；write/close/rename错误传播；普通模式仍真实sync。
- [ ] 新用例覆盖同一action并发/独占确认，以及重建store/service后确认不重发。允许沿用现有回归证明普通IO错误，不重复制造复杂strace故障框架。不能静默skip关键PM用例。
- [ ] 定向GREEN：Node26新用例+handoff store/service/delivery/相关panel；Node24新用例和这组相关回归。使用新短TMPDIR；必须带--experimental-vm-modules。
- [ ] 预览增加一条简短异常核查提示；README记录PM进程重启级保证，不承诺掉电；manifest仅版本升2.3.0-beta.3，其余字段不变。
- [ ] 点名暂存本地提交。最终冻结HEAD后Node26全套一次：`node --experimental-vm-modules --test --test-concurrency=4 "tests/*.test.mjs"`，0 fail/skip/cancel；相关JS语法检查。失败先诊断，不重复盲跑。
- [ ] 正式脚本打包至资料库新目录fork-chat-2.3.0-beta.3-handoff-permission-fix；不覆盖旧包。使用当前1.2.1-beta正式TOOLS。验证manifest、ZIP CRC/SHA、源码commit、权限不变，保留动态依赖未证明警告。
- [ ] 返回短报告、commit、测试统计、ZIP路径/hash。写手停止写入，不安装、不推送、不操作GUI或真实模型。

### Task 2: 一次审查、正式更新与交付

- [ ] 主线程阅读关键生产diff和日志；Luna仅审本轮生产与关键测试，无问题则不扩大范围。
- [ ] 仅修真实阻断问题，并定向复验；无关Minor记录，不开启无边界修复循环。
- [ ] 核对最终ZIP代码/哈希，stage包与简短说明。正式extension_manager提交更新，status核对；需要本人确认则明确待确认，不能代点。
- [ ] 交回用户手动实机：原测试节点准备→确认→主页正文与文件→手动发问。不自动创建真实宿主会话。
