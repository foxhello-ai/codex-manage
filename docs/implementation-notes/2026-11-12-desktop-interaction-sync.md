# 桌面会话性能、途中交互与 instabox 实施记录

日期：2026-11-12。需求见 [批准范围](../desktop-interaction-sync-requirements.md)。基线 main@e3b4986，独立分支 codex/desktop-interaction-sync。功能验收阶段未合并发布；后续已按用户指令合并 main 并正式发布 v1.0.10，见文末发布记录。桌面原安装和启动保持原样。

## 说明原因

历史读取曾遍历全部轮次；HTTP 状态序号被当成 WebSocket 已消费序号，延迟到达的审批快照可能被丢弃。标准同步问答误用权限审批按钮，取消与允许曾返回同一答案；MCP elicitation 未处理时被回复空对象。

此前将截图里的独立问题卡误判为同步挂起 RPC，因而错误推断必须共享 app-server。最新从真实原桌面的 live canonical history 确认：截图是 request_user_input_async，问题存于 agentMessage.questions，答案是带 questionItemId 的关联文字。它可通过原桌面已有 IPC 的当前 turn 投递通道处理，无需修改桌面启动。早期仅检查 CLI stdio 方法与 TCP 监听，未覆盖 ipc/ipc.sock，不能据此断言不存在桌面入口。

## 当前代码问题点

原 DesktopQueueService 只用 thread/queue/add 排队普通消息；该队列会在当前 turn 完成后消费，不能及时回答异步问题。SessionService 转换曾丢弃 questions/delivery，Web 也未订阅桌面实时问题。默认“history”状态不代表桌面空闲；不能等用户发送普通聊天触发占用错误后才识别外部运行。

完整需求状态：1 已实现、2 已实现、3 已实现、4 已实现。已确认 Web 回答由原桌面接受；当前任务收到关联答案。 无需新增账号授权、辅助程序或系统权限。

## 代码错误位置

- src/server/services/SessionService.ts：历史转换、最近一页读取和异步问题字段。
- src/client/App.tsx：HTTP/WS 对账、问答入口和关联答案展示。
- src/server/services/ApprovalService.ts、RuntimeManager.ts：同步交互语义、等待状态和原请求清理。
- src/server/services/DesktopQueueService.ts：原普通续聊队列，不能代答当前问题。

## 修改方案

1. 首屏取最近 20 轮，旧页按需读；刷新保留原 ID、顺序和已加载旧页。独立管理 HTTP runtime 版本、交互状态版本和已消费 WS 事件位置。
2. 保留 Manage 自身权限审批；同步问答使用专用提交、必填校验和自定义文字。MCP 支持明确 schema 范围，未知类型失败，不静默成功。解决、断开或关闭时清理原 pending 请求。
3. 新增窄范围桌面异步问题接口。只连接当前同用户已存在的 IPC，发现该 thread 的真实 owner，订阅 version 11 快照和增量；不启动 router，不 resume 桌面 thread，不拿 writer。
4. 选项与自定义文字以原问题 ID 关联，通过 thread-follower-steer-turn v1 投给原 owner 的当前 turn。严格校验 thread/turn/question，只允许主用户；同步 RPC 审批不走该接口。
5. 提交前持久记录稳定 ID；相同重复提交不再发送，未知结果不重放、不降级为普通队列。收到原 owner 的准确 turn 确认或对应 accepted steering 消息才确认成功；原 turn 结束则问题过期。
6. Linux 安装和发布 runner 默认 instabox-medium，保留 Intel/ARM macOS。LINUX_CI_RUNNER=ubuntu-24.04 可回退；无需再补项目授权。

## 修改的代码点

新增 DesktopIpcClient.ts、DesktopQuestionService.ts、shared/desktopQuestions.ts、DesktopQuestionsPanel.tsx；扩展 sessions.ts 的 owner-only GET/POST desktop-questions。index.ts 管理连接生命周期；RuntimeManager.observeDesktopThread 仅更新观察状态，保留 Manage 自有 writer。SessionService 保留异步问题，App 独立挂载并显示可回答卡片，InteractionCard 复用已有表单。

前批已新增 sessionHistory.ts、InteractionForms.ts、历史分页和 Web 审批对账修复，以及 instabox-pilot.yml 和现有 Linux workflows 默认 runner 调整。

## 验证结果

[自包含 HTML 报告](../acceptance/2026-11-12-desktop-interaction-sync/report.html)。最新本地 189 项单元/集成测试通过，375/1440px 交互/历史专项 14 项通过，类型检查和前后端构建通过。UI 包含自动开卡、自定义文字、单次提交、未知结果不重发；协议测试使用临时 Unix socket，覆盖真实帧格式、canonical history、patch、过期和重启去重。它们不代替真实桌面提交验收。

真实原桌面 26.1002.52244、CLI 0.162.0-alpha.2：owner discovery、快照及持续 patch 通过；新发专用问题已自动出现 Web，截图只保留测试卡片。已确认 Web 回答由原桌面接受；当前任务收到关联答案。 [证据](../acceptance/2026-11-12-desktop-interaction-sync/desktop-async-questions.json)。

历史性能同一活动会话 4 次交替采样：完整历史 7094/5237ms，最近 20 轮 1966/1582ms，平均下降约 71%；非浏览器公网耗时保证。writer 操作 0。[证据](../acceptance/2026-11-12-desktop-interaction-sync/history-performance.json)。

早期目标仓库 [Instabox Pilot 43148957035](https://github.com/foxhello-ai/codex-manage/actions/runs/43148957035)，源码 d3d6315：179 项测试、完整构建、8 项安装生命周期通过。Linux Ubuntu 24.04/systemd255，Node22.23.3。安装验证使用既有 v1.0.9/v1.0.8 包，该次早期 CI 不含问答补丁；最新发布代码与安装验证见文末正式发布记录。未验证 OpenAI 账户重新登录/真实模型推理。[CI](../acceptance/2026-11-12-desktop-interaction-sync/instabox-actions.json)、[安装](../acceptance/2026-11-12-desktop-interaction-sync/actions-installation.json)。

## 能力边界与回滚

桌面 IPC 是已安装版本的内部入口，尚无官方稳定兼容承诺；OpenAI Docs 页面前次抓取失败，不能把本机验证描述为官方支持。需同主机、同用户、保持原 thread 在桌面打开。桌面关闭或版本不兼容时明确显示不可用；不接管已失效同步 RPC、不新增桌面停止/模型/权限功能。

回滚撤销本分支代码/workflow；无需修改桌面或回滚会话历史。提交未知状态时保留提交台账供核对，禁止删除后盲目重发。功能验收使用独立 4330 端口；后续 main 已合并修复，未自动升级用户生产服务。

## 正式发布记录

修复源码 e375a3a 已合并 main，v1.0.10 正式发布。最新代码在 instabox 通过 189 项测试和构建；发布前 8 项 Linux 安装检查及发布后下载复核通过。发布后 Linux、Intel Mac、Apple ARM Mac 三平台检查和本机 Intel Mac 10 项检查均通过。[证据与校验和](../acceptance/2026-11-12-runtime-v1.0.10/README.md)。用户现有服务未自动升级；桌面启动方式未变更。
