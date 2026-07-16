# 会话详情居中布局修正记录

## 基本信息

- 日期：2026-07-16
- 范围：会话详情页桌面布局、H5 审批操作按钮
- 状态：已完成

## 原有问题

- 会话详情页进入详情视图后会为右侧浮动运行状态启用 `reserveFloatingStatus`。
- 桌面宽度下 `.appShell.reserveFloatingStatus .content` 使用 `margin-left: 24px`，导致主内容区域不再居中，而是整体偏左。
- H5 审批按钮在同步远端变更后仍需要保留防溢出策略，避免较长中文按钮文案被截断。

## 修改内容

- 保留桌面详情页对浮动运行状态的宽度避让：`width: min(1120px, calc(100% - 336px))`。
- 将固定左边距改为左右自动边距，使详情页在可用宽度内居中展示。
- 保留 H5 审批按钮的宽度约束、自动高度、换行和 `overflow-wrap`，避免移动端按钮文字溢出或省略。

## 修改文件

- `src/client/styles.css`

## 验证

- `npm test`：13 个测试文件、46 项测试通过。
- `npm run typecheck`：通过。
- `npm run build`：通过。
