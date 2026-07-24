# Windows 启动、远程通道与会话展示补丁记录

| 跟踪项 | 内容 |
| --- | --- |
| 故障编号 | `CM-INC-20260724-003`、`CM-INC-20260724-004` |
| 日期 | 2026-07-24 |
| 状态 | 已修复、待重新打包和目标环境回归 |
| 严重程度 | 高：Windows 桌面端可能无法启动本地服务、无法稳定启动远程通道，或只展示部分会话 |
| 影响范围 | Windows x64 桌面端、远程通道、正式权益 Named Tunnel、会话列表与会话详情 |
| 修复分支 | `feature/f-20260721-desktop` |
| 关联提交 | `07cd4de`、`2d5a927`、`808d0c8`、`5df9aec`、`8a36c10`、`3ff7faa`、`9805d6d`、`0c3856f`、`fbc4c24`、`2243b00` |

## 变更总览

- Windows Codex CLI 发现顺序改为优先使用 `where.exe codex` 返回的完整路径，避免 PowerShell 默认命中 `codex.ps1` 后被执行策略拦截。
- Windows 启动 `codex.cmd` 时补充 `shell: true` 和 `windowsHide: true`，解决 `spawn EINVAL`、窗口闪烁和 app-server 无法 ready 的问题。
- 本地 Web 服务启动失败时，不再吞掉 `codex app-server` 的真实错误；启动异常会向桌面端暴露，方便诊断 `Codex app-server is not ready`。
- 启动失败路径补充 runtime/app 关闭逻辑，减少孤儿 `codex app-server` 进程占用资源后影响下一次启动。
- 正式权益用户在云端仍返回 Quick Tunnel 配置时，桌面端会主动触发 Named Tunnel provision，再重新读取配置并启动专属域名。
- 云端控制 API 对 `500`、`503` 做短重试，`desktop:start-tunnel` 也对同类临时错误重试，降低首次点击“服务暂时不可用”的概率。
- Windows 托盘增加双击恢复主窗口能力，补齐 Windows 托盘交互差异。
- iPhone 扫码区域增加“添加到主屏幕”引导，让用户可以把远程 H5 作为桌面标签使用。
- 会话列表按 `thread/list.nextCursor` 分页扫描，搜索不再只查第一页；会话详情兼容 `id` 与 `sessionId` 两种字段。

## Windows 本地服务启动问题

### 现象

- Windows 安装后提示 `Codex app-server is not ready`。
- 远程 Windows `admin@192.168.31.50` 上可以复现本地服务启动不起来。
- PowerShell 中直接执行 `codex --version` 命中 `codex.ps1`，被执行策略拦截。
- 直接执行 `C:\nvm4w\nodejs\codex.cmd --version` 可以正常输出版本。

### 根因

Windows 上 Node/NPM 通常同时生成 `codex`、`codex.cmd`、`codex.ps1`。桌面应用不能依赖 shell 的默认解析顺序：

1. PowerShell 优先解析 `.ps1`，客户机器执行策略可能禁止脚本。
2. Electron/Node 直接 `spawn` `.cmd` 在 Windows 下需要通过 shell 兼容启动，否则可能报 `EINVAL`。
3. 旧逻辑把裸命令 `codex` 放在候选列表靠前，可能绕过已经发现的完整 `.cmd` 路径。

### 修改的代码点

- `src/server/services/CodexAppServerClient.ts`：Windows 且路径以 `.cmd` 结尾时使用 shell 启动，并隐藏控制台窗口；启动时仍将 Codex 所在目录前置到 `PATH`。
- `src/server/services/codexVersion.ts`：版本检测改为 `execFile`，对 Windows `.cmd` 增加 shell 兼容和隐藏窗口。
- `apps/desktop/src/main/CodexLocator.ts`：Windows 下优先使用 `where.exe codex` 返回的候选路径，再回退裸命令 `codex`。
- `src/server/start.ts`：本地服务监听失败时先停止 runtime 并关闭 Fastify 实例，再抛出原始错误。
- `apps/desktop/src/main/LocalServiceSupervisor.ts`、`apps/desktop/src/main/index.ts`：退出和失败路径增加子进程清理，避免孤儿进程影响下一次启动。

### 验证记录

- Windows 31.50 复现环境确认 `where codex` 返回 `C:\nvm4w\nodejs\codex` 和 `C:\nvm4w\nodejs\codex.cmd`。
- 直接 `.cmd` 路径可用，PowerShell `.ps1` 路径不可用，和修复方向一致。
- 修复后本地服务启动失败应返回真实错误，而不是只显示 `Codex app-server is not ready`。

## 正式权益仍使用 Cloudflare 随机域名

### 现象

- 客户账号已开通正式权益，Windows 重启后仍使用 `trycloudflare.com` 随机域名。
- macOS 正常使用专属域名。

### 根因

桌面端启动远程通道时仅按云端 `tunnel-config` 当前返回结果执行。如果设备已有正式权益但云端尚未完成 Named Tunnel provision，旧逻辑会直接落入 Quick Tunnel，不会主动创建 Named Tunnel。

### 修改的代码点

- `apps/desktop/src/main/index.ts`：当 `tunnel-config` 返回 `quick` 且本地权益包含 `named_tunnel` 时，自动调用 `provisionNamedTunnel`，随后重新读取 `tunnel-config`，成功后直接启动 Named Tunnel。

### 验证标准

- 正式权益账号启动远程通道后，优先获得客户专属域名。
- 只有没有 Named Tunnel 权益、provision 失败或云端明确禁用时，才回退或报错。

## 首次启动远程通道偶发“服务暂时不可用”

### 现象

- 首次点击启动远程通道时报：`Error invoking remote method 'desktop:start-tunnel': Error: 服务暂时不可用`。
- 等一会儿再点击停止或重新启动通道又恢复正常。

### 根因

首次启动链路同时触发设备会话刷新、权益读取、Named Tunnel 配置读取或自动 provision。云端控制 API 在短暂未就绪时通过统一错误处理返回 `500`，但桌面端旧逻辑只对部分 `503` 场景有弹性处理，导致首次瞬时失败直接暴露给用户。

### 修改的代码点

- `apps/desktop/src/main/CloudClient.ts`：统一请求层对 HTTP `500` 和 `503` 执行最多 2 次短重试。
- `apps/desktop/src/main/index.ts`：`desktop:start-tunnel` 外层对同类临时错误重试，并写入 `tunnel.start_retry` 诊断日志。

### 验证标准

- 云端短暂返回 `500` 或 `503` 时，首次点击应自动重试。
- 多次重试仍失败时，仍向用户返回最终错误，避免静默卡死。

## Windows 有的会话能展示、有的展示不了

### 现象

- Windows 上部分历史会话可见，部分会话无法在列表或详情中打开。
- 直接探测 Windows 用户目录下 `.codex\sessions` JSONL 文件存在。
- 直接调用 `codex app-server` 的 `thread/list`、`thread/read` 可以读到对应会话。

### 根因

旧代码只读取 `thread/list` 第一页，且搜索只在第一页内执行；当 Codex 会话数超过默认页大小时，后续页会话无法进入应用列表。另一个兼容性问题是部分 app-server 记录只有 `sessionId`，旧 `toSummary()` 只认 `id`，会被静默过滤；前端选中会话时也只按 `id` 匹配。

### 修改的代码点

- `src/server/services/SessionService.ts`：新增 `nextCursor` 分页扫描，默认最多扫描 1000 条；搜索在已扫描集合内执行，不再局限第一页。
- `src/server/services/SessionService.ts`：`toSummary()` 兼容 `source.id` 与 `source.sessionId`，备注标题也兼容两种 key。
- `src/server/services/SessionService.ts`：详情校验兼容 `summary.id` 和 `summary.sessionId`。
- `src/client/App.tsx`：当前选中会话兼容 `id` 与 `sessionId`。
- `src/server/services/SessionService.test.ts`：新增分页、搜索和 `sessionId` 兼容回归测试。

### 验证记录

- 已执行 `npm test -- src/server/services/SessionService.test.ts`。
- 已执行 `npm run typecheck`。
- 已执行 `npm run build`。

## 托盘与 iPhone 桌面入口

### 托盘交互

- Windows 托盘图标增加 `double-click` 事件处理，双击恢复主窗口。
- macOS 原有单击恢复逻辑不变。
- 开机自启动继续通过 `app.setLoginItemSettings({ openAtLogin, args: ["--hidden"] })` 实现静默启动参数。

### iPhone 桌面入口

- 扫码面板增加 iPhone Safari “分享 → 添加到主屏幕”指引。
- 该能力依赖 iOS PWA 机制，不是通过扫码直接静默安装原生 App。

## 当前发布判断

- 代码修复已合入 `feature/f-20260721-desktop` 并已推送到远端。
- 本地 `apps/desktop/release` 中的同名 `1.0.1` 安装包文件时间早于 2026-07-24 的部分修复提交，不能直接声明为“包含全部修复”的最终交付包。
- 对客户交付前必须重新构建 Windows 安装包，并在 Windows 31.50 或干净 Windows x64 设备完成安装回归。

## 回归清单

1. Windows 安装包安装后能检测 Codex CLI，且 `app-server.status=ready`。
2. PowerShell 执行策略禁止 `.ps1` 时，桌面端仍能通过 `.cmd` 启动 Codex。
3. 正式权益账号首次启动远程通道后使用专属域名，而不是 `trycloudflare.com`。
4. 控制 API 首次短暂 `500`、`503` 时，桌面端能自动重试并最终成功或返回明确错误。
5. 会话数超过 100 条时，后续页会话能被搜索并打开详情。
6. 只有 `sessionId` 没有 `id` 的会话不会被列表过滤。
7. Windows 托盘单击或双击均能恢复主窗口；macOS 托盘行为保持正常。
8. iPhone 扫码后能按提示添加到主屏幕并再次打开远程 H5。
