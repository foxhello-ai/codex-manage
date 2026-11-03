# 桌面原会话续聊与 Manage 空闲释放

本次实现面向同一台机器、相同 `CODEX_HOME` 下的官方桌面本地 Codex/Work 会话。桌面保持原有启动方式和私有 stdio app-server；Manage 可投递文字到原 thread，并读取已保存的消息和回答。普通 ChatGPT 云端聊天不适用。

## 使用方式与边界

默认启用两个独立能力：

- Manage 尝试恢复原 thread；明确遇到其他写入者时，主用户文字改为原生队列投递。桌面空闲时消费，正在回答时排队，保留原 ID 和上下文。
- Manage 自己执行的 thread 在空闲后取消订阅，并确认真正卸载后显示“已释放占用”。页面一直打开也不会因查看而重新持锁。

桌面无需设置共享服务地址、开放 4500 端口、替换 CLI 或修改配置。Manage 后端仍须运行在桌面所在机器，并使用相同的数据目录和兼容 CLI；浏览器可在其他设备。Manage 从不因占用自动复制历史或建立替代 thread。

队列模式的模型、权限、审批、停止任务和附件由桌面操作。Manage 显示执行入口与投递状态，限制相关设置；后续文字明确沿用桌面设置。受控子用户不走外部队列。附带附件或显式模型/完全权限覆盖的首次请求会被拒绝，保留输入，不能默默丢弃要求。

已入队表示后台接受投递，不代表开始执行或已经完成。目标未加载、桌面退出、数据目录不一致或接收者不消费时，消息可能一直等待；必须由用户在同一数据目录的兼容桌面打开原会话后核对。仅凭 active writer 错误不能断定持有者就是桌面。

## 实现

`DesktopQueueService` 通过 Manage 自有 app-server 调用 `thread/queue/add`。它与内置 `codex queue` 使用同一个原生持久队列，不需要取得目标 thread 的 writer。采用 RPC 是因为可以传入 `clientUserMessageId`，之后与持久 `userMessage.clientId` 精确关联；CLI 打印的队列 ID 与消息 client ID 不相同。

投递台账存放在 `${CODEX_MANAGE_METADATA_FILE}.deliveries.json`，写入前先记录 submitting，再原子替换文件。同一个 `clientRequestId` 的 HTTP 重试返回原记录；浏览器失败重试保留该 ID 和附件路径。超时、返回标识不确定、进程在提交时退出均标为 unknown，先查队列和历史，绝不自动再次投递。明确失败的原请求重试仍返回错误。同一句话使用两个不同 ID 主动发送时会保留两条。

消息状态为 submitting、queued、observed、completed、failed、unknown。完成只依据同一 client ID 所在 turn 的持久状态。Manage 重启后恢复台账，待处理消息所在 thread 保持队列路径，避免抢回 writer 并越过既有队列。

实机发现：另一后台读取桌面尚未完成持久化的 turn 时，可能暂时返回 interrupted，稍后才变成 completed。该快照保持 observed 并继续核对，不判为最终失败；只有明确错误记录才标 failed。真正中断且没有可确认终态的回合也会保留待确认提示，需到桌面核对。

会话页在有待处理投递时约每秒查询一次，空闲约每 5 秒查询；只同步已保存的快照，不承诺桌面逐 token、工具通知或审批事件。历史按原生 turn/item/client ID 合并，并支持 `thread/turns/list` 分页。GET/runtime 与 WebSocket 观察均不调用 resume。

`RuntimeManager` 把发送、恢复和释放放在同一 thread 操作链里。释放前确认本地及原生 idle、无活动 turn/审批/设置/压缩操作、无后台终端，也无仍加载的子任务。条件未知或不满足时显示阻塞原因，并保留 writer。配置重载也会等待自有 thread 完成释放，避免重载打断后台任务。

只给 Manage 自有进程传入 `-c thread_unload_delay_secs=1`，不会写共用配置。`unsubscribed` 本身不视为释放完成；需收到 closed/notLoaded 或在 loaded/list 确认移除。释放期间的新输入等待确认，再显式恢复原 thread；若桌面先取得写入权，则走原生队列。单次确认超时保留“暂未释放”状态。

新建且尚未完成首轮的空会话是例外：本机官方版本此时尚未生成可恢复的 rollout，提前卸载会导致原 ID 无法恢复。因此显示原因并保留占用，首轮完成后再进入自动释放。此限制通过实机复现，不能把空会话当作已保存的历史会话处理。

配置监听排除桌面状态、缓存、历史、台账等运行数据，避免桌面写状态文件反复触发 Manage 重载。

## 开关与兼容

| Manage 环境变量 | 默认 | 关闭后的行为 |
| --- | --- | --- |
| `CODEX_MANAGE_AUTO_RELEASE` | 开启 | 设为 `0` 保留原有持锁方式，不传 1 秒卸载参数 |
| `CODEX_MANAGE_DESKTOP_QUEUE` | 开启 | 设为 `0` 禁止外部队列，外部占用返回错误 |

本机验证版本为桌面 `26.1002.52244`、内置 CLI `0.162.0-alpha.2`。队列属于该版本的原生能力，不能推定所有版本均支持。不支持队列时返回能力错误；不能确认后台工作状态或卸载结果时不伪报释放成功。升级后应重新执行兼容验证。

完整复用桌面私有 app-server 的 RPC/审批/事件流仍是独立可行性研究项，本实现不把它作为依赖。已有启动适配器和外置共享服务实验也不属于此交付范围。

## 验证

- 单元及路由测试覆盖外部占用切换、提交后失败不换路重发、精确 ID 对账、台账恢复、权限与附件边界、分页读取、释放竞争、后台任务与配置重载保护。
- 浏览器回归覆盖失败重试保留请求 ID、结构化附件、队列能力限制和不确定投递提示。
- 实际双端验收脚本：`scripts/research/desktop-session-handoff-acceptance.mjs`。使用已安装官方桌面的独立 profile、临时 `CODEX_HOME`、本地模拟模型以及生产构建的 Manage 页面。脚本只清理本次测试创建的进程，保存原桌面及后台存活证据。

运行双端验收：

```sh
npm ci
npm run build
node scripts/research/desktop-session-handoff-acceptance.mjs
```

需要 macOS、`/Applications/ChatGPT.app` 及已安装的 Google Chrome。测试目录默认位于 `/tmp/mhi-*`；可用 `RESEARCH_REPORT_DIR` 指定结果目录。脚本不使用真实凭据、真实会话或真实模型请求。文本模拟验收不代表真实工程工具副作用、跨版本兼容或发布门禁均已通过。

本次 155 项服务与路由测试、10 项双尺寸专项界面测试、17 项双端实机检查通过。实际结果、截图和当前限制见 [验收记录](../acceptance/2026-11-03-desktop-session-handoff/README.md)。桌面已报占用后，本次未观察到 10 秒内自动恢复，重新打开原会话后可继续。
