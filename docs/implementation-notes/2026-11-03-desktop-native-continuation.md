# 桌面现有会话的外部续聊入口验证

日期：2026-11-03。结论仅针对本机安装版本，不代表所有 ChatGPT/Codex 桌面版本。

## 结论

**可以。当前桌面自带的 `codex queue` 能从外部给桌面已经打开的原 thread 发送后续消息，由桌面原有后台继续执行。**

这条路径保持桌面原来的启动方式和后台。Manage 侧调用现成 CLI 即可投递消息；无需配置 4500 端口、替换 CLI、增加桌面启动适配器、复制历史或创建替代 thread。

已完成原生发送入口的可行性验证，尚未把这条路径实现到 Manage 产品中。不要把“原生投递已跑通”表述为“Manage 的完整双端交互已交付”。

## 外部怎样调用

```sh
/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex queue \
  --thread '原会话的 thread ID' \
  --message '接着刚才的任务继续处理'
```

外部进程需要使用与桌面相同的本地数据目录 `CODEX_HOME`，通常默认为 `~/.codex`。若 Manage 运行在另一台机器，这个本机调用路径不能直接照搬。这里没有要求调整桌面环境变量。

命令返回的是投递结果：

```text
Queued message 01a1a00c-1178-7a01-99c8-a7468f4055f8 for thread 01a1a00b-d812-75b1-b6ae-d6f6763ed3ce.
```

命令成功退出表示消息已入队，不能直接当作模型已经完成回答。空闲桌面会继续处理；当前轮正在生成时，后续消息会排队。此次空闲场景从启动命令到观察到桌面回复约 7.8 秒，这只是一次本机观测，不是延迟保证。

Manage 的可行接入形态为：发送操作调用 `queue`，桌面继续执行原会话，Manage 再读取更新后的会话记录。当前 Manage 的 `resumeThread` / `sendInput` 仍走它自己 app-server 的 `thread/resume` / `turn/start`，需要另行实现发送路由与结果展示。

## 安装版本与隔离方式

- 应用路径：`/Applications/ChatGPT.app`，bundle ID 为 `com.openai.codex`。
- 桌面版本：`26.1002.52244`。
- 内置 CLI：`0.162.0-alpha.2`；`queue --help` 的说明为 `Queue a message for an existing session`。
- 使用独立临时 `CODEX_HOME`、Electron profile 和 workspace，不触碰用户原有会话或真实凭证。
- 模型响应来自 localhost Responses SSE 模拟服务。验证的是实际桌面、CLI、会话、上下文和界面路径，没有调用真实模型。
- 桌面测试进程仅增加隔离目录与本机 UI 观测参数；后台仍由原版桌面正常创建。没有设置 `CODEX_CLI_PATH`、`CODEX_APP_SERVER_WS_URL` 或 daemon 启动标志。
- 用户原本运行的桌面与后台保持存活；实验进程已清理。

## 实测证据

测试 thread：`01a1a00b-d812-75b1-b6ae-d6f6763ed3ce`。桌面进程 PID `80466`，原生后台 PID `81064`。`queue` 前后都是同一个后台，默认 daemon control socket 不存在。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 桌面使用默认私有后台 | 通过 | 启动命令没有新增 listener 或传输适配器 |
| 桌面先创建并打开原 thread | 通过 | `DEX-DESKTOP-ONE` 与初次回复已显示、持久化 |
| 外部 CLI 续聊原 thread | 通过 | `DEX-EXTERNAL-QUEUE` 的消息与回复自动出现在桌面 |
| 使用原桌面后台 | 通过 | 回答期间后台 PID 保持 `81064` |
| 桌面随后继续输入 | 通过 | `DEX-DESKTOP-THREE` 的模型请求包含外部消息及其前次回答 |
| 桌面正在生成时外部投递 | 通过 | `DEX-EXTERNAL-AFTER-BUSY` 在慢轮次结束后执行，并包含慢轮次的回答 |
| thread 未改变、无重复消息 | 通过 | 同一 thread 的持久记录包含 5 条用户消息和 5 条回答，各标记一次 |
| 用户原桌面和后台仍存活 | 通过 | 受保护的原进程检查通过 |

证据目录：[`../acceptance/2026-11-03-desktop-native-continuation/`](../acceptance/2026-11-03-desktop-native-continuation/)。

- `results.json`：最终 8 项通过，含命令输出、后台进程、上下文标记。
- `thread-records.jsonl`：隔离测试的原 thread 持久记录。
- `desktop-final.png`：桌面当前轮和外部排队消息的回答。
- `desktop-final.txt`：桌面最终可见文本。
- `results-original-ui-count.json`：保留原始运行报告。原来的全页精确文本计数把初始提示在侧栏和标题中的重复显示也计入，导致一项断言误报；通过同次运行的持久消息记录复核后更正。产品行为没有修改，验证脚本已修正统计方式。

可复现脚本：[`../../scripts/research/desktop-native-continuation.mjs`](../../scripts/research/desktop-native-continuation.mjs)。

```sh
RESEARCH_REPORT_DIR=/tmp/desktop-native-continuation-evidence \
  node scripts/research/desktop-native-continuation.mjs
```

## 其他找到的桌面入口

| 入口 | 现有能力 | 外部 Manage 的验证边界 |
| --- | --- | --- |
| 内置 `codex queue` | 向既有 thread 排队发送消息 | 本次实测跑通，是当前已确认的外部续聊路径 |
| `codex://threads/<id>?prompt=<encoded text>` | 已安装代码中，路由处理打开原会话并设置 `prefillPrompt` | 静态代码确认预填语义；隔离实例的命令行 URL 投递未跑通，未确认系统 URL handler 的动态行为，不作为自动发送入口 |
| `codex-app-tools.send_message_to_thread` | 桌面内置工具支持向现有会话发后续消息，并有 list/read/wait 工具 | 桌面内部能力确实存在；外部 Manage 直接接入未验证，桥接依赖桌面提供的 pipe、执行上下文和调用方信任检查 |
| AppleScript scripting dictionary | 标准窗口、标签页和网页脚本操作 | 没有发现专门的会话发送命令 |

桌面没有在本次检查时暴露供 Manage 直接连接的 TCP listener；这不影响原生 `queue` 的本地投递路径。不能因没有共享 app-server 监听端口就断言外部无法续聊。

## 尚未覆盖的产品能力

本次验证覆盖同一台机器、桌面保持运行且拥有既有会话时的文字续聊。尚未验证桌面关闭后的唤醒、未加载会话的自动接管、远程机器投递、审批/中断、附件、逐 token 同步、失败重试及队列幂等。CLI 为本机预发布版本，不能把此命令当成所有版本均有的稳定公开接口。

`queue` 解决了“外部如何把后续消息送给现有桌面会话”。Manage 侧的运行状态、回复读取和审批界面仍需单独设计验证。

## 与前面共享服务研究的关系

SRF-01 和 SRF-02 研究的是让两端连接同一个可复用 app-server。它们属于独立验证项。本项回答的是桌面保持现状时，已有外部入口是否能继续原会话。

早期笔记中“尚未建立直接附着桌面 app-server 的入口”仍描述底层连接的限制，但不能再据此推导“必须改桌面启动方式才能由外部续聊”。本次已经找到并验证原生 `queue` 投递。
