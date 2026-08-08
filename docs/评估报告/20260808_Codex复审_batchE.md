核验完成。以下为复审结论。

## 复审结论：有条件通过 ✅（P0 全部修复、P1 9/10 完整修复、1 项文档小缺口；2 项放行条件）

说明：本沙箱为只读且 8080/9100 服务未运行，无法实际启动冒烟/压测；以下均以代码逐行核验、合规引擎直调实测、原始 JSON 全量复算、tsc 基线对比替代，结论依据充分。

## 逐项验证表

| # | 项目 | 是否修复 | 证据（文件:行） | 新问题 |
|:--|:--|:--:|:--|:--|
| P0-1 | chat.ts 输出侧合规 | ✅ | checkCompliance 为 `fetch(COMPLIANCE_BASE_URL/check)` + fail-closed `AppError(503)`：chat.ts:77-95；输出侧改为 `outputCheck = await checkCompliance(replyText)`：chat.ts:231；失败时 SSE error 事件、不结算不落库：chat.ts:232-236；diff 确认已删除 `app.inject` 绝对 URL | 流已 hijack，HTTP 状态无法改 503，fail-closed 以 SSE error 事件呈现（语义满足，见剩余问题 4） |
| P0-2 | imagegen.ts 生图前置合规 | ✅ | fetch + `COMPLIANCE_BASE_URL`（imagegen.ts:217,221）、5s 超时（:219）、fail-closed 503（:234）、blocked 返回含 reason（:243-248）；引擎直调实测「生成一张术前术后对比图」→ `blocked=true`，reason 含《医疗美容广告执法指南》2021 第 37 号（rule_packs.py:135-143） | 无 prompt/空串时跳过检查但只生成固定占位文案（无注入面，见剩余问题 3） |
| P0-3 | 真实 Seedream 未实现降级声明 | ✅ | 部署手册 6 处口径统一「真实接入待实现、试点 mock 演示、真实接入=试点前置任务」：101, 211-212, 266-267, 277, 315-316, 373, 424；`generateReal()` 仍为显式抛错（seedream.ts:128-134） | 无 |
| P1-4 | 压测驱动计费采样 + C2b/C2c | ✅ | 采样数组声明 stress_driver.mjs:56-61，逐次 push：:181/215/269/284/286/300/313；C2b 第 20 轮 charge=0（:295-306）、C2c 第 51 轮 429（:308-323）；ms 数组写入 JSON（:415-423）；边界断言走真实 API（轮次前置用 DB 快进，报告 §3.3 已注明） | 无 |
| P1-5 | stress_cleanup.sh | ✅ | 按 RUN_ID/`all` 清理 4 张表 + artifacts 文件；`--dry-run`/`--restore-balance`/`--yes`；余额返还按净冻结额逐租户并前后核对（脚本 1-163 全量） | 无 |
| P1-6 | 压测报告降级与修正 | ✅ | 结论「mock 链路有条件通过」+ G1 真实 Hermes 首包≤2s / G2 真实 Seedream P95≤60s 放行条件（报告 §四）；合规次数修正为每轮输入+输出 2 次真实外呼（§3.5）；轮询量化误差≤400ms 注明（§3.2 注①）；计费延迟可由 JSON 复算（§3.4） | 无 |
| P1-7 | stress_raw_T14.json 可复算 | ✅ | 全量复算一致：chat 首包 P50/P90/P95=370.9/858.1/861.7、full P95=1174.8；image doneMs P95=11323、P50=6076.4；计费 P95=12.7/1.3/22.9 ms（n=8/4/10）；余额 802→571 pass；C2b/C2c pass=true；artifacts 含服务端 completed_at | 无 |
| P1-8 | 部署手册 §7/§8 等 | ⚠️ 基本修复 | ef53891 引用（:326）、§8 改密/备案/Opt-in/定价（:371-377）、Node ≥20（:73）、备份仅 sqlite3 .backup（:136-147, 379）、P0-3 统一 | **§7 未显式写 f058f8b 提交号**，仅「batchE 产物为最新 HEAD」（剩余问题 1） |
| P1-9 | 合规与定价重算报告 | ✅ | NFR-04 备案评估+checklist（§1）、NFR-02 Opt-in 条款草案 TC-01~05（§2）、FR-606 部署费收付/开票/转 active（§3）、DeepSeek 重算方法+敏感性+调价阈值（§4）、可执行 SQL 落 price_config（§4.5） | 无；SQL key 与 credit.ts:53-59 `PRICE_KEYS` 逐项一致 |
| P1-10 | change_password.js | ✅ | user/admin 双表匹配（:100-105）、bcryptjs rounds=10（:137）、双表命中歧义保护（:115-121）、audit_log 审计（:144-152）、写入后 compareSync 验证（:161-172）、生产 JWT_SECRET 强制（:75-88） | 无 |

## 附加验证

- **git log**：✅ 恰为两提交——`ef53891`（MVP baseline）+ `f058f8b`（batchE: T14/T15 + P0/P1 fixes），无多余提交。
- **冒烟 9/9**：静态数出 dev_smoke.sh 恰 9 项检查（backend health / compliance health / 登录 / 场景×2 / SSE / 冻结 / 入队 / 成功）。⚠️ 本环境未实跑（服务未启动 + 只读沙箱），放行条件 2。
- **tsc --noEmit**：✅ 无新增错误。错误清单全部预存：bcryptjs 缺类型×3、jsonwebtoken 重载×1、better-sqlite3 行类型（auth/scenarios/credit）、imagegen `never` 收窄×2——其中 imagegen 的 `never` 经内存 TS 编译器对基线同构模式（try/catch 赋值）与新版（try/finally）分别编译，两者均报同一错误，确认非 batchE 引入。

## 剩余问题清单

1. **P2-文档**：部署手册 §7（:326）只写基线 `ef53891`，未显式给出整改提交 `f058f8b` 号。回滚指引仍可用，但与该条验收「ef53891/f058f8b 引用」不符，需补一句（如「整改提交 f058f8b 为当前 HEAD」）。
2. **P2-测试基建**：`backend/tests/t7_imagegen.test.js` 未内嵌合规 mock，execute 带 prompt 会真实外呼 127.0.0.1:9100（t7 用例 1/2/4 均带 prompt），`npm test` 依赖外部合规服务在线，否则 T7 会以 503 失败。建议仿 t6 内嵌 mock 或注明测试前置条件。
3. **P2-旁路口**：imagegen.ts:213-214 仅在 `promptToCheck` 非空时过检；不传/传空串时跳过检查，实际生成固定 `DEFAULT_PROMPT` 占位文案（无用户输入注入面，风险低），但「任何生成必过检」的声明不严格成立，建议显式过检或注释豁免理由。
4. **P3-语义**：chat.ts 输出侧合规不可用时，SSE 流已发出 200 头，fail-closed 以 `error: COMPLIANCE_UNAVAILABLE` 事件呈现而非 HTTP 503（不结算不落库，拒绝放行语义满足；压测报告 §3.5 已如实说明）。验收口径建议按「拒绝放行」而非字面状态码理解。
5. **P3-验证缺口（环境所致，非代码问题）**：本沙箱只读且服务未运行，冒烟 9/9 与「违禁 prompt 生图 E2E blocked」未实跑；已用引擎直调 + 代码路径 + 原始数据复算替代。

## 放行条件

1. 部署手册 §7 补写 `f058f8b` 提交号（一处文本修改，改后即可视为 P1-8 完整闭环）。
2. 在可写环境实跑 `bash scripts/dev_smoke.sh`（期望 9/9）与违禁 prompt E2E（期望 execute 返回 `status: blocked` 且 reason 含法规依据）留档一次。

满足上述两条后，MVP 可放行至试点；剩余 P2/P3 项建议作为试点期跟踪项，不阻塞。
