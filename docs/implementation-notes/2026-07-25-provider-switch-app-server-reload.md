# cc switch 切换服务商后应用内模型不刷新诊断

| 跟踪项 | 内容 |
| --- | --- |
| 故障编号 | `CM-INC-20260725-005` |
| 日期 | 2026-07-25 |
| 状态 | 已定位、待修复 |
| 严重程度 | 中：不影响既有会话数据，但会导致服务商或模型切换后必须重启应用 |
| 影响范围 | macOS、Windows 桌面端；本地 Web 与远程 H5 共享同一后端运行时 |
| 关联代码 | `src/server/services/AppRuntime.ts`、`src/server/services/CodexAppServerClient.ts`、`src/server/services/ModelCatalogService.ts`、`src/server/services/RuntimeManager.ts`、`src/client/App.tsx` |

## 说明原因

`cc switch` 修改的是 Codex CLI 的全局服务商配置。Codex Manage 启动后会创建一个长生命周期的 `codex app-server` 子进程，本地 Web、桌面端和远程 H5 都通过这个已初始化的 app-server 做模型列表、会话恢复和消息发送。

当前应用没有“重载 Codex app-server”的控制面。外部执行 `cc switch` 后，已经运行中的 app-server 不会重新读取新的服务商配置；只有重启应用时，桌面端重新拉起 app-server，新服务商才生效。因此用户看到的现象是：切换服务商后应用内无法切换到新服务商模型，必须重启应用才正常。

这不是 Windows 专属问题，macOS 和 Windows 都会受影响；只是 Windows 上前面同时存在启动兼容性问题，容易被误判为同一个故障。

## 当前代码问题点

1. `AppRuntime` 只在启动阶段执行 `detectVersion()` 和 `appServer.start()`，没有暴露 restart/reload 能力。
2. `CodexAppServerClient.start()` 在 `ready` 或 `starting` 状态直接返回，不会为外部配置变化重建子进程。
3. `ModelCatalogService` 默认缓存模型列表 60 秒；即使服务商已变化，也可能继续返回旧模型目录。
4. 前端 `loadModelCatalog()` 在已有 `modelCatalog` 且非强制刷新时直接返回，不会主动重新拉取。
5. `RuntimeManager` 切换模型时只发送 `model` 和 `effort`，没有服务商维度；服务商由当前 app-server 进程环境决定。

## 代码错误位置

- `src/server/services/AppRuntime.ts`：运行时构造和启动逻辑只覆盖首次启动，没有 restart API。
- `src/server/services/CodexAppServerClient.ts`：`start()` 对 ready 进程幂等返回，适合普通启动，但不适合外部配置切换后的进程重载。
- `src/server/services/ModelCatalogService.ts`：`list()` 有内存缓存，`invalidate()` 已存在但没有被 provider switch 场景调用。
- `src/client/App.tsx`：`loadModelCatalog(false)` 会复用前端状态中的旧目录。
- `src/server/services/RuntimeManager.ts`：`thread/settings/update`、`turn/start`、`thread/resume` 均依赖当前 app-server，不负责切换服务商。

## 修改方案

### 后端

1. 在 `AppRuntime` 增加 `restart()` 或 `reloadCodexAppServer()`：
   - 停止现有 app-server。
   - 重新检测 Codex CLI 版本。
   - 重新启动 app-server 并完成 initialize。
   - 清空模型目录缓存。
2. 在本地 Fastify API 增加运行时重载接口，例如 `POST /api/runtime/reload`。
3. 对正在运行、等待审批或正在写入的会话加保护：
   - 存在 `running` 或 `waiting_approval` 会话时拒绝重载，返回明确提示。
   - 仅在所有会话处于 `history`、`exited`、`failed` 或空闲状态时允许重载。
4. 重载后广播 runtime 状态变化，让桌面端和 H5 主动刷新模型目录。

### 前端

1. 增加“刷新 Codex 运行时”入口，提示用户在执行 `cc switch` 后点击。
2. 重载成功后调用 `loadModelCatalog(true)`，强制刷新模型目录。
3. 当前会话存在模型 override 时，重新校验该模型是否仍被新服务商支持。
4. 若新服务商不支持旧模型，展示“目标服务商不支持当前模型，请重新选择”的明确错误。

### 桌面端

1. 桌面状态中增加 app-server 重载状态和最近错误，便于诊断。
2. Windows 与 macOS 均需验证：应用不重启，只重载 app-server 后模型列表更新。

## 修改的代码点

当前仅完成根因定位，尚未实现代码修复。预计改动点如下：

- `src/server/services/AppRuntime.ts`：新增 app-server restart/reload 方法。
- `src/server/services/ModelCatalogService.ts`：将 `invalidate()` 接入 runtime reload 流程。
- `src/server/app.ts` 或相关 route：新增本地 API。
- `src/client/App.tsx`：新增操作入口、状态提示和强制刷新。
- `src/server/services/RuntimeManager.ts`：提供运行中会话检查，避免重载中断活跃会话。
- `src/server/services/*.test.ts`：补充 app-server reload、缓存失效、运行中拒绝重载测试。

## 验证方案

1. macOS 启动应用，记录当前模型列表和服务商。
2. 外部执行 `cc switch` 切换到另一个服务商。
3. 不重启应用，点击“刷新 Codex 运行时”。
4. 验证模型列表强制刷新，并能选择新服务商支持的模型。
5. Windows 重复同样流程，确认 `.cmd` 启动兼容性不回退。
6. 运行中会话或等待审批会话存在时，点击刷新应被拒绝并给出明确提示。

## 临时规避

在代码修复前，用户执行 `cc switch` 后必须重启 Codex Manage。重启会重新拉起 `codex app-server`，新服务商配置才会被读取。
