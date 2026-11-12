# 保持默认桌面启动时，如何回答途中问题

日期：2026-11-12。范围：当前官方桌面本地 Codex/Work 会话，桌面原图标、启动方式与私有后台保持原样。

## 说明原因

最新用户截图已确认是 request_user_input_async。此工具立即返回 accepted，桌面将问题保存为 agentMessage.questions；用户后来提交的是带问题 ID 的关联文字。它与同步 request_user_input RPC 的原连接回复不同。此前将两者混为一谈，得出“只能换共享后台”的结论不正确。

## 当前代码问题点

DesktopQueueService 的普通聊天 thread/queue/add 会等当前 turn 结束，不能及时回答途中问题。另一个 app-server 的 turn/steer 也不能操纵原桌面私有服务。可用路径是通过桌面已有的本机 IPC，交由原桌面自己向原后台 steer 当前 turn。

## 代码错误位置

原队列入口：src/server/services/DesktopQueueService.ts。同步问答原 RPC 回复：ApprovalService.ts。新增异步卡路径：DesktopQuestionService.ts / DesktopIpcClient.ts / shared/desktopQuestions.ts / DesktopQuestionsPanel.tsx。

## 修改方案

Manage 连接当前用户 .codex/ipc/ipc.sock，只发现原会话 owner 并订阅实时快照/patch。Web 显示题目、选项和自定义文字。提交时携带原 questionItemId，通过 thread-follower-steer-turn 投递到原 owner；由桌面使用自己的原后台继续当前 turn。

不需要改桌面包、环境变量、启动命令或开 4500 共享服务；不需要辅助功能/模拟点击或远程桌面。只允许已登录主用户；答案最多 4000 字符。当前 turn 结束，旧问题就不能继续答。未知提交结果保留台账并禁止自动重发。

## 修改的代码点

新增窄范围 GET/POST desktop-questions 接口、原 IPC 客户端与订阅服务、Web 问题面板；原普通文字队列继续服务后续聊天，不作为问答回退。具体见 [实施记录](2026-11-12-desktop-interaction-sync.md)。

第 3 项当前状态：已实现。已确认 Web 回答由原桌面接受；当前任务收到关联答案。 无需新增账号授权、辅助程序或系统权限。

[真实桌面问答证据](../acceptance/2026-11-12-desktop-interaction-sync/desktop-async-questions.json) 和 [HTML 报告](../acceptance/2026-11-12-desktop-interaction-sync/report.html) 区分真实展示、协议桩测试和真实提交结果。未实现不以测试通过率折算。

## 同步与异步实验的适用范围

scripts/research/question-text-queue-feasibility.mjs 用临时 CODEX_HOME 和本地模型桩验证同步 request_user_input：另一连接回复同 request ID 无效，普通聊天会排到下一轮。该实验 5 项检查通过，[原证据](../acceptance/2026-11-12-desktop-interaction-sync/question-text-queue.json) 只说明同步 RPC 边界，不能用于否定截图中的异步卡。

scripts/research/desktop-async-question-read.mjs 是原桌面只读探针，只输出计数和耗时，不提交答案、不输出历史或凭证。真实原桌面问题首次连接读取 3685ms（单次本机采样）；Web 持续订阅后以 3 秒轮询展示新问题。

同步权限审批、停止桌面任务、改变执行模型/权限继续在桌面操作，符合用户范围。内部 IPC 依赖安装版本；不兼容时停止投递并显示不可用，不绕过系统授权/签名检查。共享后台、界面桥接和人工远程桌面不属于本次交付。
