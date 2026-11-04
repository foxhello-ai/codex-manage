# Manage 先取得会话写入权后的占用与释放验证

日期：2026-11-03。桌面 `26.1002.52244`，内置 CLI `0.162.0-alpha.2`。

## 说明原因

**Manage 先取得某个 thread 的写入权后，官方桌面也会在恢复该 thread 时遇到 `already has an active writer`。一轮回答完成不会自动释放写入权。可以仅在 Manage 增加空闲取消订阅，随后释放该 thread，桌面启动方式和配置均无需修改。**

关键在于谁先加载并取得写入权，而非谁先启动应用。Manage 的普通历史读取使用 `thread/read`，不等于取得写入权；创建 thread、`thread/resume` 等操作会加载运行时。受控子用户的某些读取路径也可能触发恢复，不能笼统承诺所有打开历史的操作均无占用。

官方 OpenAI Docs 的 [app-server 文档](https://developers.openai.com/codex/app-server)明确说明：`thread/unsubscribe` 移除当前连接的订阅；最后一个订阅者离开后，thread 空闲默认 60 秒才卸载。`thread_unload_delay_secs` 可调整间隔。卸载时发出 `thread/status/changed`（`notLoaded`）及 `thread/closed`。

取消订阅成功与写入权已释放是两个时刻。应等到卸载确认，不能收到 `unsubscribed` 就向用户宣称桌面已可接管。

## 当前代码问题点

当前 Manage 在 `turn/completed` 后只更新为 `waiting_input`，清空 `activeTurnId` 并推送事件。产品运行时代码没有调用 `thread/unsubscribe`，因此等待输入期间仍可能长期持有写入权。

现有状态映射已经能把 `notLoaded` 转为 `history`，本次用实际 RuntimeManager 验证通过。无需因本问题额外断言这段状态映射失效。

## 代码错误位置

- [`RuntimeManager.ts:797`](../../src/server/services/RuntimeManager.ts#L797)：回答完成处理，没有安排取消订阅。
- [`RuntimeManager.ts:1004`](../../src/server/services/RuntimeManager.ts#L1004)：现有 `notLoaded` 状态可落到 `history`。
- [`CodexAppServerClient.ts:93`](../../src/server/services/CodexAppServerClient.ts#L93)：Manage 启动独立 app-server，可在此类的启动参数配置能力中加入仅影响 Manage 后台的卸载间隔。

## 实测结果

使用隔离 `CODEX_HOME`、workspace、Electron profile 和 localhost Responses SSE 模拟模型，无真实聊天、凭证或模型请求。桌面包、真实配置及原桌面进程均未修改。

| 场景 | 结果 | 实测证据 |
| --- | --- | --- |
| Manage 完成回答后，原版桌面恢复同一 thread | 确认冲突 | 桌面 `thread/resume` 日志针对原 ID 返回 `already has an active writer` |
| Manage 对完成的 thread 调用取消订阅，保持默认参数 | 通过 | 约 60,099ms 后收到 `thread/closed`，thread 从 loaded/list 移除 |
| 只释放一个 thread，保留 Manage 后台与其他会话 | 通过 | 后台 PID 不变，另一条 thread 仍加载且可继续回答 |
| 仅给实验中的 Manage 后台设置 `thread_unload_delay_secs=1` | 通过 | 约 1,066ms 后释放，未修改共享配置文件或桌面参数 |
| 释放后另一个官方后台恢复原 ID 并继续 | 通过 | 原 Manage 后台仍活着，第二后台恢复相同 ID；后续模型输入含之前的用户消息及助手回答 |
| 释放后桌面界面自动恢复原会话并继续 | **未验证通过** | UI 实验误操作到另一条新会话；该回复不能作为原会话接管成功证据 |

原版桌面冲突 thread：`01a1a039-1b53-7df2-9417-8cb7a79c89bb`；Manage PID `18102`。独立后台交接验证 thread：`01a1a03f-2fa1-73d1-8ed1-cc86deadecdf`；Manage PID `24127`。

原始 UI 脚本报告保留了两个失败断言：第一个断言在打开后 4.5 秒检查，早于桌面延迟恢复的报错，同次运行后续日志已经证明冲突；第二个未能完成原会话的桌面接管，仍按未验证处理。没有将新会话的回答误计为原会话成功。

证据目录：[2026-11-03-manage-writer-release](../acceptance/2026-11-03-manage-writer-release/)。`stock-desktop-review.json` 对原始断言作复核说明；`backend-handoff-results.json` 为后续 6 项通过的后台交接实验。

复现：

```sh
node --import tsx scripts/research/thread-unsubscribe-handoff.mjs
```

原版桌面与默认 60 秒观测脚本为 `scripts/research/manage-desktop-handoff.mjs`；它的 UI 路由选择仍需修正，不应把整份报告当作桌面无缝交接验收通过。

## 修改方案

建议在 Manage 实现以下交接流程，桌面保持正常启动：

1. 一轮结束且没有审批、执行中工具、后台任务、待发送输入或模型设置操作时，安排取消订阅；仍有工作时不释放。
2. 调用 `thread/unsubscribe`，等待该 thread 真正卸载。默认需要约 60 秒；可仅给 Manage 自己的后台传入 `-c thread_unload_delay_secs=1` 等短间隔。本次已验证 1 秒覆盖参数有效，正式产品间隔仍需结合交互选择。
3. 同一 thread 的发送、恢复和释放进入同一串行操作链，避免刚取消订阅就被新输入或自动刷新重新订阅。下一次 Manage 输入需恢复运行时及订阅；不能仅凭旧 `waiting_input` 状态跳过恢复。
4. 桌面已经持有 thread 时，Manage 使用已验证的原生 `codex queue` 投递路径继续同一会话，并读取更新记录；不要再尝试通过第二后台强行取得写入权，也不要自动改为复制历史的新会话。见[原生续聊验证](2026-11-03-desktop-native-continuation.md)。
5. 桌面先前已经报错的场景，尚不能承诺界面自动恢复；需实际验证重试/重新打开原会话的体验。后台层面原 ID 接管与上下文保留已经确认。

这实现的是会话写入权交接。两个独立后台同时持有同一 thread 的写入权仍不支持。

## 修改的代码点

本轮只增加研究脚本和证据文档，**没有修改 `src/` 产品实现，当前 Manage 仍不会在回答后自动释放**。正式实现应集中在 RuntimeManager 的空闲释放与串行恢复，以及 AppServerClient 的 Manage 专用启动参数；桌面占用时的 queue 投递属于另一项接入改造。
