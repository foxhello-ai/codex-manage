# 桌面会话性能、途中交互与 instabox 实施记录

日期：2026-11-12。需求及批准范围见 [需求文档](../desktop-interaction-sync-requirements.md)。基线 `main@e3b4986`，实施分支 `codex/desktop-interaction-sync`，独立 worktree `desktop-interaction-sync/codex-manage`。本次尚未合并或发布，也没有重启现有 4310/4311 服务。

## 说明原因

已确认两类独立问题。Manage 首屏和轮询会读取全部历史，paginated 会话还会遍历历史分页；HTTP 状态序号又被当作 WebSocket 已消费事件序号，可能使包含审批内容的较早快照被丢弃。标准问答已有协议处理，但复用了权限审批按钮；取消、拒绝和允许曾返回同一份答案。MCP elicitation 未处理时被回复空对象。

官方桌面的默认私有后台是另一项能力边界。现有文字队列可以投递后续聊天，但没有把桌面持有的 pending RPC 传给 Manage。**本次修复不能让 Web 直接回答官方桌面私有后台中的挂起问题。** 用户截图的确切底层请求仍未取得，不能把 MCP 表单或 Manage 自身测试当成截图场景已经通过。

## 当前代码问题点与完成状态

原始需求只按完整效果标注：1 已实现，2 没实现，3 没实现，4 没实现。第 2、3 项缺默认桌面原挂起请求的可用通道，不能靠用户补账号授权解决；当前没有需要用户重复操作的前置项。第 4 项正在通过验证分支 push 触发 pilot，不依赖只读 gh 账号的手动触发权限。下表记录代码组件，不能替代原始场景验收。

| 需求 | 本次状态 | 实际结果与限制 |
| --- | --- | --- |
| DSI-01 历史读取 | 已实现并验证 | Web 首次取最近 20 轮，旧历史按需分页，轮询保持最近一页；合并保留原 ID 和已加载旧页，时间缺失/相同也保持服务端顺序。paginated 存储的 rollout 文件时间不能证明内容未变化，因此仍读取最近一页。非 paginated 文件签名相同可复用已读结果。 |
| DSI-02 审批恢复 | Manage 链路已验证 | HTTP 返回 runtime 和 pending 请求，分别管理运行态版本、待交互版本和已消费事件位置。支持刷新/重连恢复；另一客户端解决后清除，旧快照不复活请求。后台断开使原请求失效并清除，未承诺重启后台后恢复已失效 RPC。 |
| DSI-03 标准问答 | Manage 链路已验证 | 自动打开专用回答面板，显示“等待你回答”、选项描述、自定义回答、必填校验；回复原 request ID。“稍后回答”仅关闭面板；不伪造标准协议没有的取消/拒绝动作。 |
| DSI-04 MCP 交互 | 支持范围已实现并验证 | 支持扁平 primitive 表单、字符串枚举、多选、数值/布尔类型和基本长度/数量约束，后端转换 wire 类型。明确保留 decline/cancel。URL 需要用户显式确认；未知交互返回协议错误。嵌套对象、pattern/format 等未支持 schema 显式显示不支持，不能静默忽略其验证条件。 |
| DSI-05 桌面原生跨端交互 | 调查完成，未打通 | 当前安装版本的协议和默认后台未提供已确认可用的外部 pending 请求读取/答复通道。保持桌面启动方式不变时，审批、途中提问、UI 选择仍需桌面操作。没有进行真实桌面挂起请求的跨端回答验收。 |
| DSI-06 instabox | Linux 环境通过，Actions 切换待激活 | 隔离 instabox CI 模板通过测试/构建和已发布包安装生命周期验证。提供手动 pilot 工作流及 Linux runner 开关；已确认 foxhello-ai 的 App 安装与 workspace 关联，具体仓库访问权限及首次目标仓库 Actions 实跑未验证，默认继续 GitHub Ubuntu；Intel/ARM macOS runner 保留。 |

## 代码错误位置

- `src/server/services/SessionService.ts`、`src/server/routes/sessions.ts`：详情读取和历史分页查询。
- `src/client/App.tsx`：HTTP/WS 事件序号、待交互恢复、历史合并及面板入口。
- `src/server/services/ApprovalService.ts`、`RuntimeManager.ts`：问答回复语义、MCP 请求处理、等待状态、外端解决通知与请求失效。
- `src/server/services/CodexAppServerClient.ts`：JSON-RPC 字符串/数字 request ID 和不支持请求的错误回复。

## 修改方案与修改的代码点

1. 增加 bounded history API 和 `sessionHistory.ts`；首屏避免 `thread/read includeTurns:true`，随后仅取一个 descending page 并转换为时间顺序。单一“加载更早”入口先揭示已读内容，再读取旧页；最新页刷新不丢旧页和 cursor。
2. HTTP runtime 响应带上待交互内容；三个同步位置独立推进。客户端用已解决 ID 屏蔽旧请求，后台重新连接后复用 RPC ID 也生成新的面板 ID。
3. 新增 `InteractionCard.tsx` 与 `InteractionForms.ts`。普通问答、MCP 表单和权限审批使用各自真实协议动作。等待回答时保持会话占用，避免把“等待回答”当成执行完成后释放。
4. 处理 `serverRequest/resolved`，广播双端清除；后台退出/会话关闭清理失效请求。补充官方 `active` / `waitingOnUserInput` 状态映射，问答期间阻止切换模型或普通输入。
5. 新增独立桌面能力盘点和历史性能脚本；不修改桌面包、入口、真实会话或身份校验。
6. 新增 `.github/workflows/instabox-pilot.yml`，使用 `instabox-medium` 跑测试、构建、Linux 安装验证。现有安装矩阵与发布任务读取 `LINUX_CI_RUNNER`，默认 `ubuntu-24.04`，pilot 成功后设为 `instabox-medium`；删除变量即可恢复。两项 macOS 安装 job 保留原 runner。

## 验证结果

证据目录：[2026-11-12-desktop-interaction-sync](../acceptance/2026-11-12-desktop-interaction-sync/)。

提供 [自包含 HTML 验收报告](../acceptance/2026-11-12-desktop-interaction-sync/report.html)，内嵌 4 张测试截图、核心 JSON 证据、需求完成状态与 instabox 授权说明。原始 4 项需求中，1 项已实现、3 项没实现；均尚未上线。HTML 只是新增呈现，不改变既有验证边界。

- 本地类型检查、前后端构建通过；instabox 最终 30 个测试文件、179 项测试及完整构建通过。Actionlint 1.7.12 校验 3 个工作流通过，已登记 instabox 自定义 runner label。最终汇总见证据目录 `verification.json`。
- 全套 UI 回归（含首批新增交互用例）在桌面 1440px 和手机 375px 视窗执行：33 通过、1 项原有仅适用手机的用例在 desktop 跳过。追加历史分页用例后，交互/历史套件 8/8 通过，覆盖延迟快照、HTTP 恢复、关闭/刷新、重连、已解决旧快照、自定义回答、必填项、MCP 取消和历史按需读取。截图中的问题使用测试数据，非用户真实桌面请求。
- 新增登录 + HTTP + 两个实际 WebSocket 的集成测试：未登录被拒；登录后恢复问题；一端回答回到原 RPC，状态恢复 running；两端收到清理事件；重复提交不产生第二次回复。底层执行服务使用测试 transport，不能据此宣称官方桌面通道通过。
- 同一真实本地 thread 交替读取 4 次：完整历史 7094/5237ms，最近 20 轮 1966/1582ms；均为 2 次 RPC。平均读取时间下降约 71%。完整历史 29 轮约 693KB，最近页约 575KB。该 thread 正在继续写入，样本内容有小幅变化；不是固定静态快照或公网浏览器端到端性能保证。脚本检查 writer 操作为 0。[原始数据](../acceptance/2026-11-12-desktop-interaction-sync/history-performance.json)。
- instabox `ci@2026-11-05.ci.1`，Ubuntu 24.04/systemd 255、4CPU/8GiB、Node 22.23.3。真实安装的是既有 `v1.0.9` / `v1.0.8` 发布包，覆盖全新安装、ZIP artifact、升级、回滚、恢复、restart、stop/start；检查 health、Manage 登录、鉴权、静态资源、配置/会话目录标记保留。**未验证 OpenAI 账户登录或真实模型推理，也不表示本次改动已经发布。** [安装报告](../acceptance/2026-11-12-desktop-interaction-sync/instabox-installation.json)。实验 VM 不加载 Vault/Secrets，完成后删除。

### 官方桌面能力验证边界

当前桌面 `26.1002.52244`，内置 CLI `0.162.0-alpha.2`。重新生成实验协议 schema，共 170 个 client method；相关交互 client method 只有增减 out-of-band elicitation 计数，没有枚举/答复另一连接 pending 请求的方法。计数接口仅暂停/恢复 timeout accounting，不提供问题或答案传送。标准问答、MCP 和审批是 server → client request，回复走接收该 request 的原 JSON-RPC 连接。

只读盘点正在运行的桌面直接子后台：未带外部 listener 参数、没有 TCP LISTEN，默认 daemon control socket 不存在。只读检查安装包还可见私有 app-tools 管道的授权/签名校验路径；没有绕过这些校验，也没有使用非受支持身份连接。以上说明当前未找到可实施通道，不等于证明所有内部、未来版本或部署方式永远不可能。

[能力证据](../acceptance/2026-11-12-desktop-interaction-sync/desktop-capabilities.json)。重新抓取官方文档遇到网络失败，本次协议细节以实际安装版本生成的 schema 为证据。另外只读检查了 CLI help：`remote-control` 管理开启远控的 daemon，`agents --remote` 连接已有远端 endpoint；都未提供接管当前桌面私有 stdio 连接的命令。本次没有启动远控 daemon 或生成配对码。原共享服务和启动适配器仍是独立研究路线，需要改变启动链，未并入本次默认桌面修复。

## instabox 激活步骤与回滚

已有账号/项目授权不阻止增加其他项目：同一 GitHub OWNER 的新仓库修改现有 App 安装范围，保留旧仓库；另一个账号/组织通过授权页的 **Install on another GitHub account** 安装并授权目标仓库，再将 OWNER **Link** 到当前 workspace。无需因此重新登录 instabox。一个 GitHub OWNER 同时只能关联一个 workspace；显示 **Already used for CI** 时才需处理原关联，普通增加仓库无需解除旧授权。

本次只读检查的近期任务均属于 `fmzh2021/schedule-task-cfworker`，汇总为 12 条、10 成功、0 失败、0 运行/等待；这些记录不证明目标仓库已授权，也不能仅凭缺少运行记录断言其未授权。见 [授权检查摘要](../acceptance/2026-11-12-desktop-interaction-sync/instabox-ci-status.json)。

2026-11-12 11:18（UTC+08:00），用户完成授权后，通过官方只读 `GET /v1/orgs/{id}/github/installations` 接口确认：`foxhello-ai` 安装 ID `181104874` 已关联当前 workspace，`suspended=false`；原有 `fmzh2021` 关联仍保留。该接口不返回具体仓库选择范围，因此组织授权和 Link 已确认，`codex-manage` 的访问权限与首次实际 Actions 结果仍需实跑核验。见 [组织关联证据](../acceptance/2026-11-12-desktop-interaction-sync/instabox-authorization.json)。

1. 组织 App 安装及 workspace 关联已确认；继续核对 `foxhello-ai/codex-manage` 的仓库访问范围。[instabox 授权页面](https://dashboard.instabox.sh/auth/github-app/install?org=org_65a2b3061d17430aa975eecac2ea15a2) 可查看安装与关联；如需调整仓库范围，由相应管理员操作。
2. `Instabox Linux Pilot` 支持实施分支 push 自动触发及 workflow_dispatch。GitHub CLI 账号 `fmzh2025` 对仓库只读，但 git 使用另一套已有 SSH 身份且推送检查通过，因此采用分支 push 完成实跑，不要求用户先修改 gh 权限。检查 GitHub 任务和 `instabox ci` 两边结果，核对安装证据 artifact。
3. 首次 pilot 成功后，将 repository variable `LINUX_CI_RUNNER` 设为 `instabox-medium`，Linux 安装和发布任务才会切换；macOS 不变。恢复时删除该变量。公开仓库未来若增加 fork PR 触发，应启用 GitHub 外部贡献者审批以控制 workspace 任务。

回滚代码时撤销本实施分支改动；没有历史迁移或真实会话数据回滚步骤。
