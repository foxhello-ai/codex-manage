# 会话列表和会话详情页面拆分记录

## 基本信息

- 日期：2026-07-14
- 需求：将会话列表和会话详情拆成两个页面；进入会话详情后不展示会话列表，并提供返回会话列表的 icon 指引。

## 实现内容

- `src/client/App.tsx`
  - 新增 `DashboardView`，用 `list` / `detail` 控制列表页和详情页。
  - 点击会话后进入详情页，详情页不再渲染会话列表。
  - 详情页顶部新增返回会话列表的 icon 按钮。
  - 返回列表时保留 `selectedSessionId`，避免中断当前会话的 WebSocket 和运行态刷新。
  - 会话被过滤或列表刷新后不存在时，自动回到列表页。
- `src/client/styles.css`
  - 新增详情页标题栏、返回 icon 布局和无障碍隐藏标题样式。

## 审核记录

- 未调整后端接口和数据模型。
- 未改变恢复、输入、审批和实时输出流程。
- 浮动运行状态仍基于当前选中会话展示，返回列表不清空选中会话。

## 验证

已执行：

```bash
npm run typecheck
npm test
npm run build
```

结果：

- `npm run typecheck`：通过。
- `npm test`：通过，8 个测试文件、23 个测试。
- `npm run build`：通过，Vite 成功构建前端产物。
