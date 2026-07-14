# M2 Codex app-server 客户端实现记录

## 基本信息

- 日期：2026-07-13
- 里程碑：M2 Codex app-server 客户端
- 目标：后端能检测 Codex CLI 版本、启动 `codex app-server`、完成 initialize 握手，并向配置接口暴露运行状态。

## 实现内容

- 新增 `CodexAppServerClient`。
- 使用 `child_process.spawn` 启动 `codex app-server`。
- 使用 stdio JSONL 读写 JSON-RPC 消息。
- 实现 request/response 分发。
- 实现 notification 分发。
- 实现 server request 分发。
- 实现 initialize / initialized 握手。
- 实现进程退出和启动失败状态记录。
- 新增 `detectCodexVersion`，通过 `codex --version` 获取版本。
- 新增 `AppRuntime` 聚合 Codex CLI 版本和 app-server 状态。
- `/api/config` 和 `/api/health` 返回 app-server 诊断状态。
- 前端配置区展示 Codex 版本和 App Server 状态。

## 验证记录

已执行：

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

结果：

- TypeScript 类型检查通过。
- 测试通过：3 个测试文件，6 个测试。
- 前端构建通过。
- 生产依赖 audit：0 vulnerabilities。

真实环境验证：

```bash
curl -s -c /tmp/codex-manage-m2-cookies.txt \
  -H 'content-type: application/json' \
  -d '{"password":"fmzh2026"}' \
  http://127.0.0.1:3002/api/login >/dev/null

curl -s -b /tmp/codex-manage-m2-cookies.txt \
  http://127.0.0.1:3002/api/config
```

返回包含：

```json
{
  "codexCliVersion": "codex-cli 0.144.3",
  "codexVersionError": null,
  "appServer": {
    "status": "ready",
    "lastError": null,
    "initialized": true
  }
}
```

## 审计记录

- 未执行删除类危险命令。
- 因 `apply_patch` 受当前环境沙箱问题影响失败，部分当前工作目录内文件使用 Python 脚本受控写入。
- 工作目录外写入 `/tmp/codex-manage-m2-cookies.txt`，仅用于 curl 登录态验证。
