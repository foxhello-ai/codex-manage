# 登录/登出闭环修复记录

## 基本信息

- 日期：2026-07-13
- 相关提交：`99c5bf7 fix: complete login logout flow`
- 相关里程碑：M1 认证和配置
- 影响范围：后端认证 hook、前端登出入口、认证路由测试、需求/设计/任务文档

## 问题描述

首次实现后，未登录访问 Web 页面时没有显示登录按钮，导致无法验证登录功能。

直接原因：前端启动时调用 `GET /api/me` 判断当前认证状态，但后端认证 hook 将 `/api/me` 当作受保护接口处理。未登录请求收到 `401` 后，前端进入错误状态，而不是进入登录页。

同时，用户要求界面必须具备登出功能，才能验证完整登录闭环。

## 修复内容

- 将 `GET /api/me` 加入公开接口列表。
- 保持 `POST /api/login` 公开。
- 其他管理接口继续要求登录，例如 `/api/config`。
- 未登录访问 `GET /api/me` 返回：

```json
{
  "authenticated": false,
  "defaultPassword": false
}
```

- 登录后访问 `GET /api/me` 返回：

```json
{
  "authenticated": true,
  "defaultPassword": false
}
```

- 前端顶部操作按钮文案从“退出”调整为“登出”。
- 新增认证闭环测试，覆盖：
  - 未登录访问 `/api/me` 返回未登录状态。
  - 未登录访问 `/api/config` 返回 `401`。
  - 登录后可访问 `/api/config`。
  - 登出接口返回未登录状态。

## 补充需求

认证相关需求补充为：

- 未登录打开 Web 时，首屏必须显示登录页和登录按钮。
- `GET /api/me` 是认证状态探测接口，允许未登录访问，不应返回 `401`。
- 除 `POST /api/login`、`GET /api/me` 和静态资源外，管理接口必须要求登录。
- 登录后必须有明确可见的登出入口。
- 登出后必须清除登录态，并让管理接口重新拒绝访问。

## 验证记录

已执行：

```bash
npm run typecheck
npm test
npm run build
```

结果：

- TypeScript 类型检查通过。
- 测试通过：2 个测试文件，3 个测试。
- 前端构建通过。

手工接口验证：

```bash
curl -i http://127.0.0.1:3002/api/me
curl -s -c /tmp/codex-manage-cookies.txt -H 'content-type: application/json' -d '{"password":"fmzh2026"}' http://127.0.0.1:3002/api/login
curl -s -b /tmp/codex-manage-cookies.txt http://127.0.0.1:3002/api/config
curl -s -b /tmp/codex-manage-cookies.txt -c /tmp/codex-manage-cookies.txt -H 'content-type: application/json' -d '{}' http://127.0.0.1:3002/api/logout
curl -i -b /tmp/codex-manage-cookies.txt http://127.0.0.1:3002/api/config
```

验证结果：

- 未登录 `/api/me` 返回 `200` 和 `authenticated: false`。
- 登录成功。
- 登录后 `/api/config` 返回配置。
- 登出成功。
- 登出后 `/api/config` 返回 `401`。

## 审计记录

- 未执行删除类危险命令。
- 因 `apply_patch` 受当前环境沙箱问题影响失败，使用 `perl -0pi` 和 `tee` 对当前工作目录内文件做受控修改。
- 工作目录外写入 `/tmp/codex-manage-cookies.txt`，仅用于 curl 登录态验证。
