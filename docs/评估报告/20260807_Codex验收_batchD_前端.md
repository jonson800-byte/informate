验收完成。已通读前端全部 26 个源码文件、后端 11 个路由文件 + 积分服务 + 鉴权中间件、UIUX v1、技术方案 §4、原型 HTML 与样式关键段，并复跑了 TypeScript 检查（`tsc -p tsconfig.json --noEmit` 退出码 0，`dist/` 产物存在，构建声明属实）。

# 结论：有条件通过（⚠️ 前 5 项必须修复）

API 对齐、工程质量、三栏布局与状态页主体达标，但存在 **2 个高危功能缺陷**（冻结页充值死链、跨场景传递为本地伪实现）和 5 个中危业务/交互偏差，修复前不建议合入。

---

## 一、API 对齐核对（维度 1）

前端 `client.ts` 共封装 22 个端点，逐一与后端路由比对：**路径、方法、请求体字段全部一致，未发现凭空造端点**。`/api/v1/auth/login|me`、`/workspace`、`/scenarios(+/deploy)`、`/chat/messages`（GET/POST+SSE）、`/credit/conversations(+/:id/rounds|balance|txns|recharge|image-tasks|tasks/:id/fail)`、`/image-tasks/:id(+/execute)`、`/artifacts/:id/download`、`/users`（GET/POST/PATCH）、`/admin/tenants|overview|adjust|export|price-config`（GET/PUT）均存在且请求体字段与后端 Fastify schema 一致。SSE 事件 `delta/round_hint/round_complete/error` 的解析字段与 `chat.ts` 输出逐一对齐。

仅 3 处差异（低）：

| 差异 | 位置 | 说明 |
|---|---|---|
| `EmployeeUser` 类型含 `guide_seen/created_at`，但 POST/PATCH `/users` 响应只有 6 字段 | [types.ts:241](</Users/zhangyihui/Desktop/Informate Project/frontend/src/api/types.ts:241>) vs [users.ts:83](</Users/zhangyihui/Desktop/Informate Project/backend/src/routes/users.ts:83>) | TS 类型过度承诺，运行时无碍 |
| `WorkspaceResponse.workspace.scenarios` 类型声明含 `meta`，但 `/workspace` 实际不返回 `meta` | [types.ts:79](</Users/zhangyihui/Desktop/Informate Project/frontend/src/api/types.ts:79>) vs [workspace.ts:18](</Users/zhangyihui/Desktop/Informate Project/backend/src/routes/workspace.ts:18>) | 前端运行时改用 `/scenarios` 数据，未受影响 |
| 契约缺口：`/scenarios` 未返回 `included_rounds`/`suggestions`，前端被迫硬编码「含 20 轮」与示例 chips | [LeftPanel.tsx:61](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/LeftPanel.tsx:61>)、[ChatPanel.tsx:294](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/ChatPanel.tsx:294>) | 违反「前端零硬编码」，属后端契约缺口 |

错误码处理：后端统一 `{code,message,details}`，前端 `ApiError` 归一化一致；`ROUND_LIMIT_EXCEEDED`(429)、`COMPLIANCE_BLOCKED`(400)、`TRIAL_LIMIT_EXCEEDED`/`INSUFFICIENT_BALANCE`(402)、SSE `COMPLIANCE_BLOCKED_OUTPUT` 均有分支处理，其余透传文案，行为一致。

## 二、业务规则与三栏交互（维度 2/3/4 简评）

通过项：10 积分/会话冻结、20 轮含轮、超轮 1 积分、50 轮上限、第 51 轮 429 拦截与锁定提示、<30 琥珀预警、AI 标识永久保留（头像/卡片/文本页脚/登录页四处呈现）、试用水印按产出物生成时刻标记（转正式后新产出物不带、存量保留）、FR-209 常驻合规条、试用期隐藏跨场景传递、SSE 完整回复前禁发送、数据驱动场景列表（名称/emoji/单价来自 `/scenarios`）、充值即转 active。

不通过项见问题表：冻结页充值死链（H1）、跨场景传递伪实现（H2）、消费记录错接充值（M3）、生图对外展示价错误（M4）、充值档位未随后台配置（M5）、余额不足/试用用尽缺充值 CTA（M6）。

## 三、管理后台（维度 5）

8 个导航模块齐全（6 模块 + 数据导出 + 运营看板），`/admin/tenants|overview|adjust|export|price-config` 全部接真实端点；员工管理、会话审计、积分管理、场景部署页对后端缺失端点（`/admin/users`、`/admin/conversations`、`/admin/scenario-deployments`）的 **api-note 标注总体诚实**。扣分点：场景部署页「部署场景」列按行业硬编码断言两个场景已部署（M9），虽有注明数据源，但列内容本身属伪造。

## 四、工程质量（维度 6）

- **构建**：`tsc -b && vite build` 声明的产物存在，复跑类型检查通过（exit 0）。
- **持久化**：token/user/tenant、会话 id、产出物、引导 seen 均走 localStorage，键按租户/场景隔离，方案合理但无容量上限（L18）。
- **错误处理**：统一 `ApiError` 归一化、加载失败整页重试、SSE 断流 catch，覆盖较完整。
- **安全**：未发现 `dangerouslySetInnerHTML`，消息/产出物均为 React 文本渲染，XSS 风险低；图片预览/下载均带 token fetch，不经 `<img src>` 裸 URL。风险集中在 token 存 localStorage（L19）。

---

## 五、问题清单表

| 编号 | 严重度 | 文件:行 | 问题 | 证据 | 修改建议 |
|---|---|---|---|---|---|
| 1 | 高 | [Workspace.tsx:295](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/Workspace.tsx:295>) | 冻结页「立即充值」死链：`paused/expired` 提前 `return`，`RechargeModal` 只在主 return 渲染，`onRecharge` 置位后弹窗永远不出现 | [Workspace.tsx:436](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/Workspace.tsx:436>) 的 `{rechargeOpen && <RechargeModal/>}` 在冻结分支之后；AC-605「充值即恢复 active」不可达 | 将 `RechargeModal` 渲染提至冻结分支内（或把冻结页改为条件块而非提前 return） |
| 2 | 高 | [Workspace.tsx:268](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/Workspace.tsx:268>) | 跨场景传递为本地伪实现：仅 `createConversation`（正式版实扣冻结 10 积分）+ 本地注入一条 user 消息，不落库、目标助手收不到、刷新即丢，无 FR-405 审计；传往生图场景还产生无意义空会话 | [TransferModal.tsx:17](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/TransferModal.tsx:17>) 自述"后端无 transfer 端点→本地注入"；后端确无 `/artifacts/:id/transfer` | 后端补传递端点（写审计 FR-405）或复用 chatStream 真发消息；MVP 无法实现时应隐藏按钮，且不得对伪传递冻结计费 |
| 3 | 中 | [LeftPanel.tsx:83](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/LeftPanel.tsx:83>) | 「消费记录」按钮 `onClick={onRecharge}` 错接充值弹窗；`api.txns`（[client.ts:168](</Users/zhangyihui/Desktop/Informate Project/frontend/src/api/client.ts:168>)）定义后全工程无消费记录 UI，FR-602/AC-602 缺失 | 点击"消费记录"打开的是充值弹窗 | 新建消费记录弹窗/面板接 `api.txns`（时间/场景/类型/积分/ref_id），修正按钮绑定 |
| 4 | 中 | [types.ts:332](</Users/zhangyihui/Desktop/Informate Project/frontend/src/api/types.ts:332>) | 生图对外展示价用了实扣价 15 而非 20：`imageDisplay: 20` 常量定义了但从未引用；左栏/提交提示/重生成确认均显示 15 | [LeftPanel.tsx:47](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/LeftPanel.tsx:47>)、[ChatPanel.tsx:203](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/ChatPanel.tsx:203>)、[ArtifactsPanel.tsx:230](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/ArtifactsPanel.tsx:230>) | 展示统一用 `imageDisplay=20`，实扣文案用 `image=15`，与"对外 20 实扣 15"口径一致 |
| 5 | 中 | [RechargeModal.tsx:11](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/RechargeModal.tsx:11>) | 充值三档到账数字硬编码 `DEFAULT_PRICES.recharge`（1100/6000/25000），后台 `recharge.*` 改价后展示与到账不一致，违背 FR-704「后台可配、前端跟随」 | 后端 `credit.ts:recharge` 用 `getPrice(PRICE_KEYS.rechargeTier(tier))` 计算到账 | 弹窗接收 workspace `prices` prop，按 `recharge.100/500/2000` 渲染到账数字与赠比 |
| 6 | 中 | [ChatPanel.tsx:177](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/ChatPanel.tsx:177>) | 余额不足/试用次数用尽仅有 toast + 系统条，无 UIUX §2.3/§4.7 要求的「充值」按钮（主账号）或「联系管理员」提示（员工） | `INSUFFICIENT_BALANCE`/`TRIAL_LIMIT_EXCEEDED` 分支只 `onToast` | 拦截消息下附加充值/联系管理员 CTA，主账号可直达充值弹窗 |
| 7 | 中 | [LeftPanel.tsx:42](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/LeftPanel.tsx:42>) | 场景部署闭环断裂：owner 空态提示"联系管理员部署"，但管理后台场景部署页只读、`api.deployScenario`（[client.ts:240](</Users/zhangyihui/Desktop/Informate Project/frontend/src/api/client.ts:240>)）无任何 UI 接线，无场景租户无法自助开通 | 后端 `POST /scenarios/deploy`（owner）已存在 | 空态提供 owner 部署入口接 `deployScenario`，或在后台提供开通操作 |
| 8 | 中 | [ArtifactsPanel.tsx:69](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/ArtifactsPanel.tsx:69>) | 生图产出物 `conversation_id` 恒为 `''`，全部落入「当前对话」标签，历史图片污染当前会话视图（FR-401/AC-401） | [ChatPanel.tsx:233](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/ChatPanel.tsx:233>)、[Workspace.tsx:411](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/Workspace.tsx:411>) 均写空串 | 生图任务创建时记录当前会话/来源标记，当前对话按会话过滤 |
| 9 | 中 | [ScenarioDeploy.tsx:81](</Users/zhangyihui/Desktop/Informate Project/frontend/src/pages/admin/ScenarioDeploy.tsx:81>) | 「部署场景」列按行业硬编码断言「行业工作助手·营销生图」已部署，非真实数据，误导运营 | `t.status === 'trial' || 'active'` 时直接拼接两场景名 | 无真实部署数据时显示「—」并标注数据源缺失，等 batchE 端点替换 |
| 10 | 中 | [styles.css:1185](</Users/zhangyihui/Desktop/Informate Project/frontend/src/styles.css:1185>) | ≤1024px 右栏直接 `display:none` 且无三步切换导航，产出物面板彻底不可达，违背 UIUX §2.1 兜底要求 | 媒体查询仅隐藏右栏+缩窄左栏，无 JS 步进逻辑 | 增加「场景→对话→产出物」步进导航或右栏抽屉 |
| 11 | 低 | [AdminLayout.tsx:58](</Users/zhangyihui/Desktop/Informate Project/frontend/src/pages/admin/AdminLayout.tsx:58>) | 「工作台视角」按钮实际调用 `go('dashboard')` 停留在管理后台看板，功能与文案不符；admin 访问 `#/workspace` 被 [App.tsx:75](</Users/zhangyihui/Desktop/Informate Project/frontend/src/App.tsx:75>) 重定向回后台 | 按钮与导航同函数 | 移除按钮或实现运营预览工作台路由 |
| 12 | 低 | [Workspace.tsx:110](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/Workspace.tsx:110>) | 试用引导用 localStorage seen 标记而非规范要求的后端 `guide_seen`（换设备/清缓存重弹） | 后端仅 users 列表返回 `guide_seen`，无写入端点 | 后端补 guide_seen 写接口，或接受现状并注明 |
| 13 | 低 | [ChatPanel.tsx:156](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/ChatPanel.tsx:156>) | 第 50 轮完成即 `locked` 禁用输入，早于规范「第 51 轮发送被拦截」时序；文案「输入已禁用」与 G15「下一轮将无法发送」衔接略差 | `turns >= roundLimit` 即锁定并追加提示条 | 50 轮末仅提示，收到 429 后再锁定 |
| 14 | 低 | [ChatPanel.tsx:126](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/ChatPanel.tsx:126>) | 第 21 轮起后端每轮 `round_hint` 追加为消息流系统条，与输入框上方 `nextRoundCosts` 轻提示重复 | 同一轮出现系统条+输入提示两处"超轮"文案 | 仅渲染输入框轻提示；`round_hint` 只展示 `included_used` |
| 15 | 低 | [ChatPanel.tsx:258](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/ChatPanel.tsx:258>) | 试用期生图必然 `402 INSUFFICIENT_BALANCE`（后端无 trial 生图路径），试用用户看到「余额不足」误导 | 后端 `credit.ts:287` 对 trial 也走余额判断（余额 0） | 试用态显示「试用暂不支持生图」或后端支持试用生图计次 |
| 16 | 低 | [types.ts:241](</Users/zhangyihui/Desktop/Informate Project/frontend/src/api/types.ts:241>) | `EmployeeUser` 类型含 `guide_seen/created_at`，但 POST/PATCH `/users` 响应仅 6 字段，TS 类型过度承诺 | [client.ts:200](</Users/zhangyihui/Desktop/Informate Project/frontend/src/api/client.ts:200>) | 拆出创建/更新响应类型或字段可选化 |
| 17 | 低 | [ArtifactsPanel.tsx:86](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/ArtifactsPanel.tsx:86>) | 每次预览创建新 blob URL，仅卸载时统一 revoke，连续预览内存累积 | `openPreview` 每次 `createObjectURL` | 预览替换前先 revoke 旧 URL |
| 18 | 低 | [Workspace.tsx:180](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/Workspace.tsx:180>) | 产出物全量写入 localStorage，无容量/条数上限，大文本产出物可触发 QuotaExceeded 且未捕获 | `setItem` 无 try-catch、无截断 | 限量/截断 + try-catch 降级 |
| 19 | 低 | [client.ts:30](</Users/zhangyihui/Desktop/Informate Project/frontend/src/api/client.ts:30>) | token/user 存 localStorage，XSS 场景可被窃取；无 httpOnly cookie。前端无 `dangerouslySetInnerHTML`、React 文本转义渲染，未发现直接注入点 | 存储与鉴权头实现 | 后续改 httpOnly cookie 或短时效 token+刷新 |
| 20 | 低 | [RechargeModal.tsx:59](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/RechargeModal.tsx:59>) / [TrialGuide.tsx:30](</Users/zhangyihui/Desktop/Informate Project/frontend/src/components/TrialGuide.tsx:30>) | 充值弹窗无 Esc 关闭（UIUX §2.5）；试用引导无每步区域高亮+箭头（§4.4） | 组件无 keydown 监听、无高亮逻辑 | 补 Esc 监听与引导步骤高亮 |

## 前 5 项必须修复

1. **#1 冻结页充值死链**（高）——核心商业恢复路径不可达，AC-605 直接失败。
2. **#2 跨场景传递伪实现**（高）——扣费但不产生实际功能，刷新即丢、无审计。
3. **#3 消费记录按钮错接充值弹窗**（中）——功能错位 + FR-602 缺失。
4. **#4 生图对外展示价 15≠20**（中）——与「对外 20 实扣 15」计费口径不符。
5. **#5 充值档位不随后台配置**（中）——FR-704 改价后前端展示失真。

其余中/低项建议在合入前一并排期，其中 #6（余额不足/试用用尽缺充值入口）、#8（生图产出物会话归属）、#10（窄屏产出物不可达）对验收体验影响较大，建议紧随前 5 项处理。
