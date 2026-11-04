# 会话占用的 Git 历史与 CLI 升级归因

日期：2026-11-03。

## 说明原因

**已确认触发原因是官方 Codex CLI 升级引入单写入者限制。Manage 从早期沿用的独立 app-server + `thread/resume` 接入方式，没有适配新的写入所有权语义。**

用户所述“以前两个入口能够继续同一会话”可以在项目早期记录的 `codex-cli 0.144.3` 复现。新版的占用错误也可以在完全不加载 Manage 代码的情况下复现，因此不能归因为 Manage 某次提交新增了会话锁。

### 官方版本边界

实际读取的官方 [Codex changelog](https://developers.openai.com/codex/changelog) 明确记载：

| 日期 | CLI | 官方变更 |
| --- | --- | --- |
| 2026-07-29 | `0.146.0` | `#34986 Enforce single-writer ownership for paginated threads` |
| 2026-08-07 | `0.147.0` | `#36389 Enforce single-writer ownership for all thread histories` |

也就是说，分页历史先出现限制，之后旧 JSONL 历史也纳入限制。持有 thread 的后台不必正在生成回答，已完成回合后仍可保留写入所有权。

### 本仓库 Git 时间线

| 日期 | 提交 | 代码事实 | 对归因的意义 |
| --- | --- | --- | --- |
| 2026-07-13 | `f75e3ea` | `CodexAppServerClient.start()` 已独立 spawn `codex app-server`，使用 stdio | 独立后台不是最近引入的 |
| 2026-07-14 | `7d1689e` | `RuntimeManager.resumeThread()` 调用 `thread/resume`，随后 `turn/start` | 早期续聊已使用现在的核心路径 |
| 2026-08-26 | `d9ec263` | 首次增加 `active writer` 正则识别和 `SESSION_ACTIVE_WRITER` 错误映射，附模拟错误测试 | 这是处理上游错误的改动，没有新建或获取文件锁 |
| 2026-09-01 | `fb9d796` | 增加 250/500/1000/2000/4000/8000ms 的 writer 重试和显式 Fork | 补充恢复策略，无法改变上游所有权规则 |
| 2026-09-01 | `1eb025f` | 增加 CLI 路径发现与可选版本校验 | 可能改变所选二进制，但发生在 writer 错误处理之后，不能解释首次出现 |
| 2026-09-10 | `d04fd37` | 增加 `continue-from-history`，创建新 thread 读取原 JSONL | 新建会话/重建上下文是后来的兜底，解释重复感；它不是占用错误的起点 |

早期调研文档 `docs/technical-research.md` 在 `3962b33` 中即记录 CLI 为 `0.144.3`。查阅提交内容，而非用当前工作区的后续研究文字反推历史。

注意：`2026-09-02-writer-lock-history-continuation.md` 的文件名日期不是对应实现的 Git 提交日期；实现提交为 9 月 10 日。

### 隔离实测

使用同一份脚本启动两个官方 CLI app-server 进程 A/B，共用同一临时数据目录。A 创建会话并完成一次本地模拟回答，然后保持存活；B 恢复相同 ID。整个实验不加载 Manage 代码、不访问真实会话、不调用真实模型。

| CLI | 历史格式 | A 仍存活时 B resume | B 能否继续生成 | A 退出后 B resume |
| --- | --- | --- | --- | --- |
| `0.144.3` | legacy | 成功 | 成功 | 成功，原 ID |
| `0.146.0` | legacy | 成功 | 成功 | 成功，原 ID |
| `0.146.0` | paginated | `already has an active writer` | resume 已被拒绝 | 成功，原 ID |
| `0.147.0` | legacy | `already has an active writer` | resume 已被拒绝 | 成功，原 ID |
| `0.162.0-alpha.2`，当前桌面内置 | legacy | `already has an active writer` | resume 已被拒绝 | 成功，原 ID |

5 个组合均符合上述版本边界；全部组合在原 writer 退出后都能恢复原 ID 并完成新回合。旧版允许跨进程续聊、新版拒绝跨进程续聊这一差异得到直接验证。

历史版本二进制仅下载到临时目录，来自官方 npm registry；按发布元数据校验 SHA-512 integrity，并记录提取后 SHA-256。没有升级或降级用户安装的 CLI，没有修改桌面包或真实配置。

证据目录：[`../acceptance/2026-11-03-writer-lock-version-audit/`](../acceptance/2026-11-03-writer-lock-version-audit/)。其中 `comparison.json` 是汇总，3 份原始运行结果包含完整 RPC 错误与回合状态，`official-changelog-excerpts.json` 保存官方原文摘录，`git-timeline.txt` 保存提交 ID、实际日期与标题。

本次没有重新测试 `0.163.0`；前一轮研究已记录该版本也存在 writer 拒绝。此次执行环境中 PATH 的 `codex` 实际指向桌面内置 `0.162.0-alpha.2`，不能把 PATH 名称当作版本证据。

## 当前代码问题点

1. **接入方式需要适配。** Manage 将外部会话交给自己独立的 app-server 恢复，遇到桌面仍持有的 thread 就会争取第二份 writer 所有权，新版明确拒绝。
2. **重试不等于所有权移交。** 对方后台保留 thread 时，等待约 15.75 秒仍会失败，回合结束也不保证释放 writer。
3. **新建会话兜底带来上下文重建。** `startHistoryContinuation()` 故意创建新的 thread，让模型重新读历史，因此用户会感觉重复。这是为绕开占用而添加的后续实现。
4. **诊断文案过度归因。** 当前路由直接称“ChatGPT 正在占用”，但实际错误只证明有其他 writer，可能来自桌面、CLI 或其他后台。
5. **版本管理只有可选约束。** `CODEX_EXPECTED_CLI_VERSION` 未设置时，不会固定历史版本；现有 writer 单测使用 FakeAppServer，没有覆盖旧/新官方版本的行为变化。

能确认官方的行为变更版本、旧/新版差异以及仓库应对提交。**尚不能确定用户那台机器具体哪一天升级、首次使用受限版本的桌面 build，或当时每个实际会话的历史格式**；仓库没有保存完整的机器安装流水。当前代码中 9 月的 CLI 发现逻辑可能影响版本选择，但不是 8 月已经出现的 writer 错误处理的根因。

## 代码错误位置

- `src/server/services/CodexAppServerClient.ts:93`：独立启动 `codex app-server`。
- `src/server/services/RuntimeManager.ts:178`、`:220`：外部 thread 统一按本服务 `thread/resume` 处理。
- `src/server/services/RuntimeManager.ts:518`：短暂 writer 重试，无消息转投既有 owner 的能力。
- `src/server/services/RuntimeManager.ts:386`：历史续聊创建新 thread，随后重建上下文。
- `src/server/routes/sessions.ts:874`：writer 错误文案直接认定 ChatGPT 占用。
- `src/server/config.ts:38`、`:44`、`:63`：CLI 发现和可选版本校验，不构成版本固定。

这些是兼容适配及诊断位置，原生锁本身位于官方 CLI，不在 Manage 中实现。

## 修改方案

对仍由桌面持有的原 thread，采用已独立实测的桌面内置 `codex queue --thread ... --message ...` 入口，由现有 owner 执行后续消息。保持桌面原有启动方式与后台，Manage 负责投递、确认和结果展示；详见 [`2026-11-03-desktop-native-continuation.md`](2026-11-03-desktop-native-continuation.md)。

无人占用的会话继续走本服务原生 resume。将“已入队”和“已完成”分开，补充运行版本/能力识别、异步回显和重复投递对账。历史重建保留为用户明确选择的兜底。修正文案，使其只陈述检测到的 writer 冲突，不凭错误字符串认定占用者身份。

不以取消错误映射或增加无限重试来修复；锁由官方后台执行，删除中文提示仍会得到相同原生拒绝。也不把回退旧 CLI 作为修复方案，因为那会失去新版加入的写入一致性保护。

## 修改的代码点

本次仅走查和验证，**没有修改产品 `src/` 代码**。

- 新增版本对照脚本 [`../../scripts/research/writer-lock-version-audit.mjs`](../../scripts/research/writer-lock-version-audit.mjs)。
- 新增本归因报告、证据目录与文档索引入口。
- 复现时先完成 A 的初始化，再启动 B，以排除两个全新进程同时迁移空 SQLite 目录引起的初始化竞争。最初尝试出现过该初始化错误，不计入会话 writer 行为结论；最终矩阵所有进程初始化成功。

重跑示例（旧版二进制需自行准备到临时目录）：

```sh
node scripts/research/writer-lock-version-audit.mjs \
  /tmp/codex-0.144.3 /tmp/codex-0.147.0 \
  /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex

RESEARCH_HISTORY_MODE=paginated \
  node scripts/research/writer-lock-version-audit.mjs /tmp/codex-0.146.0
```
