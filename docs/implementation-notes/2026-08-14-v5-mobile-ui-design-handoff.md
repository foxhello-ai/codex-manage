# V5 移动端 UI 实现交接

## 基本信息

- 日期：2026-08-14
- 状态：已实现并通过多视口验收
- Linear：[`FOX-19`](https://linear.app/foxhello/issue/FOX-19/实现-v4-mobile-drawerapproval-sheet-与无障碍覆盖层)
- Figma：[V5 / 05 Mobile · Optimized](https://www.figma.com/design/7XQVeUWGYPjKjBffEqehE8/Codex%20Manage%20-%20ChatGPT%20Mac%20Style?node-id=186-2)
- 原稿：`V4 / 05 Mobile`（`49:1628`）保留为对照，不作为本次实现目标。

## 目标

将移动端从仅呈现聊天、抽屉和审批的基础状态，升级为可在手机上快速判断任务状态、恢复会话和安全处理审批的工作台。实现时保持现有的 API、审批语义和覆盖层行为，不引入新的后端协议。

## Figma 交接范围

| 画面 | Figma 节点 | 实现意图 |
| --- | --- | --- |
| Conversation · Active task | `186:5` | 在连续对话中明确项目、分支、运行状态、当前命令和变更摘要。 |
| Drawer · Find & resume | `186:75` | 提升找回/切换会话效率，提供新会话、项目连接状态、Pinned/Recent 分组和状态色。 |
| Approval · Risk decision | `186:113` | 按风险、命令、作用范围、决策的顺序组织 bottom sheet，突出一次允许与本会话允许的区别。 |

视觉基线：深色主题、Inter、360×820 参考画布、44px 最小触控高度。Figma 使用当前文件的 `Codex Manage` 色彩变量：`bg/*`、`text/*`、`border/*` 与 `accent/*`；实现应继续使用现有 CSS 主题值，而不是额外引入不一致的色值。

## 实现结果（2026-08-14）

- `src/client/App.tsx` 已落地 V4 工作台适配及 V5 移动 Conversation、Drawer、Review access Sheet；保留既有会话、模型、审批 API 与四种 decision 值。
- 移动会话新增项目/状态顶栏、`Current task` 上下文卡和紧凑 `Message Codex` 输入框；实时缺少消息体时安全降级为空文本，避免动态会话导致页面崩溃。
- Drawer 已实现项目连接卡、本地搜索、Pinned/Recent 分组、状态点及底部 `Settings & diagnostics`；延续 scrim、Escape、焦点陷阱/恢复和 scroll lock。
- Approval Sheet 已按风险、命令、作用范围、决策层级实现 `Allow once`、`Allow for this session`、`Deny request`、`Cancel`，关闭 Sheet 不会清除 pending approval。
- `tests/e2e/mvp.e2e.ts` 已覆盖 375×812、390×844、430×932 下的 Drawer、任务状态、审批、模型切换、无横向溢出与设置入口；会话列表请求对 App Server 短暂初始化状态有限重试。

### 验证证据

- `npm test`：20 files / 95 tests passed。
- `npm run build`：类型检查、客户端和服务端生产构建通过。
- `CODEX_E2E_CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run test:e2e`：16 passed（desktop、375、390、430）。
- 验收截图：[`mobile-375-session-detail.png`](../acceptance/2026-07-15/mobile-375-session-detail.png)、[`mobile-375-session-drawer.png`](../acceptance/2026-07-15/mobile-375-session-drawer.png)、[`mobile-390-approval.png`](../acceptance/2026-07-15/mobile-390-approval.png)、[`mobile-430-session-drawer.png`](../acceptance/2026-07-15/mobile-430-session-drawer.png)、[`desktop-session-detail.png`](../acceptance/2026-07-15/desktop-session-detail.png)。

## 实现范围

### 1. 会话页：任务脉络

- 顶栏展示会话标题、项目/分支和短状态标签（如 `LIVE`、`Approval`）。
- 在消息流中增加紧凑的当前任务卡，显示：任务标题、运行/等待状态、耗时、最近命令、命令结果和文件变更摘要。
- 保持输入区可见；运行中允许发送 follow-up，等待审批时明确显示输入被阻塞的原因。
- 卡片信息来自现有 `RuntimeSnapshot`、live command、变更/会话数据；无数据时不渲染空卡片。

### 2. 会话抽屉：查找与恢复

- 顶部提供 `New` 入口、关闭按钮和搜索。
- 搜索下展示当前项目与连接状态，再按 `Pinned`、`Recent` 分组展示会话。
- 每个会话行必须同时传达标题、状态和简要上下文；使用现有状态颜色而不是仅依赖文字。
- `Settings & diagnostics` 位于抽屉底部工具区，不与会话条目混排。
- 沿用已完成的 scrim、关闭、Escape/系统 Back、焦点恢复和 scroll lock 行为。

### 3. 审批 Bottom Sheet：风险决策

- 保持真正的覆盖式 bottom sheet；关闭面板不等于拒绝，也不得清理 pending approval。
- Sheet 内容顺序固定为：标题/说明 → 风险级别 → 命令 → `cwd` 与权限范围 → 操作。
- `允许一次` 为主操作；`本会话允许` 为次操作，并说明其只影响当前会话；`拒绝` 与 `取消` 为独立的低强调操作。
- 移除或替换没有明确用途的空输入区域；使用“Conversation paused until resolved”说明会话暂停状态。
- 保留问题输入、提交中状态、失败反馈以及 Full Access 下仍可 Deny/Cancel 的既有业务规则。

## 建议改动位置

- `src/client/App.tsx`
  - 移动端详情顶栏与运行摘要。
  - Drawer 的项目摘要、分组数据和底部设置入口。
  - `MobileApprovalSheet`、`ApprovalCard` 的信息顺序与操作层级；不得改变 `accept`、`acceptForSession`、`decline`、`cancel` 的提交含义。
- `src/client/styles.css`
  - 移动断点下的 `.workspaceConversation`、`.workspaceSidebar`、`.taskInput`。
  - `.mobileApprovalSheet`、`.approvalCard`、`.approvalActions` 与移动安全区样式。
  - 运行状态/会话状态标签和任务卡，优先复用已有暗色主题变量与状态类。
- `tests/e2e/mvp.e2e.ts`
  - 覆盖 Drawer、Approval Sheet、Composer 与状态卡在移动视口的可见性、触控和覆盖层行为。

## 实施顺序

1. 保持现有 Drawer 与 Approval overlay 的行为测试为绿，先完成会话页状态卡和顶栏信息。
2. 重构 Drawer 的视觉分组与项目摘要，不改变会话选择、搜索、关闭和焦点逻辑。
3. 按 V5 层级调整 Approval Sheet，复用既有决策回调和错误/提交状态。
4. 统一移动间距、44px 触控目标、安全区和长文本处理。
5. 补充 Playwright 验收截图与断言后再回写 `FOX-19`。

## 验收标准

- 在 375×812、390×844、430×932 下无横向溢出，输入区和安全区始终可达。
- 运行、等待输入、等待审批、失败和完成状态均不会造成布局跳动或信息缺失。
- Drawer 支持打开、关闭、搜索、选择会话、Escape/系统 Back、焦点恢复及 scroll lock。
- Approval Sheet 的命令、目录、权限范围和四类决策在窄屏上清晰、可操作；所有操作目标至少 44×44px。
- 关闭审批面板后，当前会话、Composer 草稿和 pending approval 保持；再次打开内容一致。
- 可访问性：对话框使用正确的 `role="dialog"` 与 `aria-modal`，键盘焦点不逸出覆盖层，状态不可只依赖颜色表达。
- `npm run typecheck`、相关单测、构建及移动 E2E 通过，并在 `FOX-19` 回写结果与截图。

## 非目标

- 不修改审批 API、权限模型、会话状态机或后端协议。
- 不创建新的设计系统或替换桌面端 V4；本次只实现 V5 移动端体验。
