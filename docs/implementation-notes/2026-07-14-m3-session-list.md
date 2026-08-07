# M3 会话列表实现记录

## 基本信息

- 日期：2026-07-14
- 里程碑：M3 会话列表
- 同步修复：登录页控件垂直居中问题

## 登录页布局修复

问题：登录控件没有稳定上下居中展示，移动端布局规则会造成视觉偏移。

修复：

- 登录页使用 `100dvh` 适配移动端动态视口。
- 登录页显式设置 `align-content: center`。
- 移动端不再将登录页内容拉伸到顶部。

## M3 实现内容

后端：

- 新增 `SessionService`。
- 通过 Codex app-server `thread/list` 获取历史会话。
- 新增 `GET /api/sessions`。
- 支持 `search` 和 `limit` 查询参数。
- 将 app-server thread 映射为 Web 端 `SessionSummary`。
- 状态映射为 `history`、`running`、`failed` 等前端状态。
- app-server 未 ready 时返回明确错误。

前端：

- 管理台首页展示会话列表。
- 支持搜索和刷新。
- 展示标题、摘要、workspace、更新时间、状态和 session id。
- 移动端使用单栏布局。
- 长标题、长路径和长 id 做截断或换行处理。

## 协议修正

真实验证时发现 `thread/list.sortKey` 需要使用 app-server 当前协议中的蛇形值：

```text
updated_at
```

不能使用 camelCase：

```text
updatedAt
```

已修正代码和测试。

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
- 测试通过：4 个测试文件，9 个测试。
- 前端构建通过。
- 生产依赖 audit：0 vulnerabilities。

真实接口验证：

```bash
curl -s -c /tmp/codex-manage-m3-cookies.txt \
  -H 'content-type: application/json' \
  -d '{"password":"admin"}' \
  http://127.0.0.1:3002/api/login >/dev/null

curl -i -b /tmp/codex-manage-m3-cookies.txt \
  'http://127.0.0.1:3002/api/sessions'
```

结果：

- `/api/sessions` 返回 `200`。
- 返回 2 个历史会话。
- 包含 `id`、`title`、`summary`、`workspace`、`createdAt`、`updatedAt`、`status`、`cliVersion`、`source`。

搜索验证：

```bash
curl -s -b /tmp/codex-manage-m3-cookies.txt \
  'http://127.0.0.1:3002/api/sessions?search=%E4%BD%A0%E6%98%AF%E8%B0%81'
```

结果：

- 返回匹配搜索词的会话。

## 审计记录

- 未执行删除类危险命令。
- 因 `apply_patch` 受当前环境沙箱问题影响失败，部分当前工作目录内文件使用 Python 脚本和 `tee` 受控写入。
- 工作目录外写入 `/tmp/codex-manage-m3-cookies.txt`，仅用于 curl 登录态验证。
