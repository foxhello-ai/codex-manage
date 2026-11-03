# H5 UI 优化验收

日期：2026-11-03（Asia/Shanghai）

本轮实现只涉及前端组件、布局和交互呈现，沿用现有 API、WebSocket 事件与业务流程。生产代码没有引入审核稿的示例会话、模拟执行、外观或字号设置。后端及 shared API/model 定义未修改。

## 落地内容

- 手机首页直接呈现最近会话、按工作目录、按任务三个稳定顺序的视图。最近视图沿用最近 10 个会话；标题是打开入口，备注编辑有独立按钮；摘要、目录名、更新时间和真实状态分层展示。
- 任务创建、置顶、选择会话归入、选择任务会话打开、新建任务会话集中在按任务视图，继续将任务作为会话分组。
- 历史回复直接完整渲染为正文，去掉需要点击查看全文的预览容器和原始 phase 标签。正文 16px、行距 1.75，保留过程消息折叠。普通内容、链接和路径换行，代码、命令与输出在自身区域滚动。
- 继续使用 `timelineAtLatestRef` 与加载历史前后的高度差逻辑；新增尺寸观察只在用户原本位于最新位置时跟随底部。快速定位按钮采用 44px 点击区，并显示“回到最新”。
- 输入区的附件、当前模型、权限、发送排在同一行，主要控件至少 44×44px。输入文字 16px，自动增高到 132px，短视口（高度不足 500px）上限 72px，继续在输入框内部滚动。保留 Ctrl/Cmd+Enter、中文组合输入保护、发送事务保护及失败时保留输入/附件；成功发送清空附件反馈。
- 普通新会话通过已有目录选择面板调用原 `POST /api/sessions { cwd }`。目录名与选中的完整路径同时可见，明确路径位于 Codex 服务所在机器。
- 任务新会话沿用最近目录、其他历史目录、手填路径和原 API 已有的自动创建目录行为。加载历史期间不沿用前一个任务的目录数据；请求失败在原面板展示并保留选择。
- 新增共享 `BottomSheet`，统一标题、44px 关闭入口、独立滚动正文和固定操作区；支持 Escape、焦点约束、焦点返回和背景 inert。审批关闭仅收起面板，四种决定仍分别提交原 API。
- 模型、权限和失败重试继续使用原业务时机：模型选择即时应用；切换模型后的失败重试仍需原确认；完全权限仍需原确认；成功回复没有新增操作栏。
- 保留桌面可调整宽度的侧栏和对话工作区，并修正未保存宽度时误取最小宽度的问题，默认宽度为原定义的 280px。

## 样式与改动位置

- `src/client/App.tsx`：列表、完整正文、输入区、目录选择、任务入口及审批呈现。
- `src/client/BottomSheet.tsx`：共享面板与键盘焦点管理。
- `src/client/ModelSelector.tsx`：复用共享面板，保留模型/强度选择的即时应用流程。
- `src/client/useVisualViewport.ts`：监听 visual viewport 的高度及偏移，用于键盘和动态浏览器工具栏引起的视口变化；浏览器缩放时保留原缩放行为。
- `src/client/workspace.css`：集中定义本轮受影响的组件样式，包含手机、触屏横屏和桌面布局。
- `src/client/styles.css`：移除受影响组件的历史重复覆盖，保留登录、设置、账号和成员等样式及它们需要的共享布局。
- `src/client/main.tsx`：载入集中后的工作区样式。
- `tests/ui/`、`playwright.ui.config.ts`、`package.json`：增加独立 UI 回归入口 `npm run test:ui`。

原有未提交文档、canvas、研究脚本和其他验收资料保留。本轮没有改写这些已有工作。

## 验证方法

使用与 Playwright 版本匹配的 Chrome Headless Shell 149.0.7827.55（revision 1228）浏览器自动化，在构建后的正式前端页面上验证。`tests/ui/fixtures.ts` 仅在测试中拦截现有接口，提供固定数据和边界状态；生产代码继续通过真实 API 与 WebSocket 获取数据。截图也是该测试页面的截图，不是线上真实会话或真机截图。

| 场景 | 验证内容 |
| --- | --- |
| 会话列表 | 三种视图、搜索请求、备注编辑、任务入口、长标题及摘要、目录全路径 |
| 普通新会话 | 仅选择已有目录、准确提交 cwd、失败留在面板、关闭后焦点返回 |
| 任务 | 创建、置顶、归入会话、选择会话打开、最近/历史/手填目录及任务会话请求 |
| 对话阅读 | 全文无裁切、16px 正文、过程折叠、长路径换行、代码区域独立滚动 |
| 历史定位 | 加载更早 5 轮后原内容相对位置误差不超过 2px；实时消息不会打断历史阅读；回到最新后继续跟随 |
| 输入与附件 | 多行自动增高、局部滚动、上传中禁用、部分上传失败、重复发送保护、失败保留、成功清空 |
| 模型与权限 | 当前模型入口、选择模型、原失败场景的模型后重试确认、完全权限确认/取消与恢复标准权限 |
| 审批 | accept、acceptForSession、decline、cancel 四个请求值；关闭不提交；关闭后仍待审批；处理后输入恢复 |
| 执行中 | 长命令/输出自身滚动、执行状态、模型/权限禁用、已有补充输入条件、命令完成后隐藏 |
| 视口 | 页面与内容滚动区无横向溢出；主要按钮/面板关闭至少 44px；模拟 visual viewport 高度/偏移及恢复；同页旋转保留草稿 |

截图使用视口尺寸捕获，避免 full-page 截图工具临时改变视口高度、触发横屏断点切换而影响验证。

## 最终验证结果

- `npm run build` 通过，包含项目类型检查、前端构建和服务端构建；服务端源码没有改动。
- `npm test` 通过：24 个测试文件，138 项测试。
- UI 自动化正常退出：83 项通过、1 项跳过、0 项失败、0 项不稳定测试。桌面端跳过仅用于手机的 visual viewport 模拟；手机及横屏均验证了该场景。
- 320×844、375×844、390×844、430×844、736×375、844×390 各 12 项通过；1440×960 桌面 11 项通过、1 项跳过。
- UI 测试文件及配置的 TypeScript 检查、`git diff --check` 通过。
- 最终运行时间为 2026-11-03 15:24:55–15:27:15（Asia/Shanghai），原始结果见 [playwright-results.json](playwright-results.json)。

复现 UI 验证：

```sh
npx playwright install chromium --only-shell
npm run test:ui
```

`npm run test:ui` 会先构建前端，再启动独立的 Vite preview 测试服务。需要使用自定义浏览器时可以设置 `CODEX_E2E_CHROMIUM_PATH`；本次最终通过的运行未设置该变量。此前使用系统 Chrome 156 的运行发生测试进程退出挂起，没有记作整套通过；切换到匹配浏览器后已完整重跑并正常退出。

## 截图索引

| 尺寸 | 会话列表 | 对话 | 审批 | 目录选择 | 模型 | 异常恢复 |
| --- | --- | --- | --- | --- | --- | --- |
| 320×844 | [列表](mobile-320-sessions.png) | [对话](mobile-320-conversation.png) | [审批](mobile-320-approval.png) | [目录](mobile-320-new-session.png) | [模型](mobile-320-models.png) | [恢复](mobile-320-failed-send.png) |
| 375×844 | [列表](mobile-375-sessions.png) | [对话](mobile-375-conversation.png) | [审批](mobile-375-approval.png) | [目录](mobile-375-new-session.png) | [模型](mobile-375-models.png) | [恢复](mobile-375-failed-send.png) |
| 390×844 | [列表](mobile-390-sessions.png) | [对话](mobile-390-conversation.png) | [审批](mobile-390-approval.png) | [目录](mobile-390-new-session.png) | [模型](mobile-390-models.png) | [恢复](mobile-390-failed-send.png) |
| 430×844 | [列表](mobile-430-sessions.png) | [对话](mobile-430-conversation.png) | [审批](mobile-430-approval.png) | [目录](mobile-430-new-session.png) | [模型](mobile-430-models.png) | [恢复](mobile-430-failed-send.png) |
| 736×375 | [列表](landscape-736-sessions.png) | [对话](landscape-736-conversation.png) | [审批](landscape-736-approval.png) | [目录](landscape-736-new-session.png) | [模型](landscape-736-models.png) | [恢复](landscape-736-failed-send.png) |
| 844×390 | [列表](landscape-844-sessions.png) | [对话](landscape-844-conversation.png) | [审批](landscape-844-approval.png) | [目录](landscape-844-new-session.png) | [模型](landscape-844-models.png) | [恢复](landscape-844-failed-send.png) |
| 1440×960 | [列表](desktop-sessions.png) | [对话](desktop-conversation.png) | [审批](desktop-approval.png) | [目录](desktop-new-session.png) | [模型](desktop-models.png) | [恢复](desktop-failed-send.png) |

同目录还保存按目录视图、任务视图、任务目录、历史阅读、执行中及视口变化模拟的截图。

## 剩余限制

- 没有 iOS Safari 或 Android 真机验证。本轮的键盘高度、visual viewport 偏移、旋转及恢复为浏览器模拟，不能据此宣称真实软键盘、浏览器工具栏、中文输入法、底部手势区或刘海安全区域均已通过。
- safe-area 的 CSS 预留已实现；Chromium 模拟中的 env 值不能证明真实设备手势区效果。
- UI 测试验证现有请求形状、页面状态和交互，不实际授权执行命令、不调用线上模型、不在真实服务器创建任务目录。本次没有重新执行依赖本地 Codex 实际会话与运行时的旧 `tests/e2e/mvp.e2e.ts` 集成套件。
- 未增加服务器目录扫描、独立项目管理、停止执行、文件差异、智能追问、步骤清单、外观/字号设置或草稿持久化。
- 本轮没有部署。按用户后续指令，前端实现、UI 回归测试、验收文档与截图分为三笔提交并推送到 `origin/main`；其他已有未提交工作未纳入。
