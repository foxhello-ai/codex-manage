# 需求、Backlog、Bug 与客户报告生命周期

## 1. 术语和使用边界

| 对象 | 用途 | 存放位置 |
| --- | --- | --- |
| 需求文档 | 说明为什么做、范围、非目标、验收和约束 | `docs/`，并链接到 Linear Document |
| Feature | 为满足需求而交付的新增能力 | Linear Issue，可含子 Issue |
| Improvement | 不改变核心目标的体验、性能、稳定性或流程改进 | Linear Issue |
| Bug | 已有行为违反约定、回归或故障 | Linear Issue |
| Backlog | 尚未进入版本范围的 Issue 状态，不是另一套文档系统 | Linear Issue 状态 |
| 客户问题报告 | 用户主动或客户端自动采集的运行问题 | Control API 问题库，先聚合再分诊 |

## 2. Linear Issue 最小字段

- 类型标签：恰好一个 `Feature`、`Improvement` 或 `Bug`。
- 平台标签：Linux Runtime、Desktop、Cloud Platform；跨端事项可添加多个。
- 优先级：使用 Linear 原生优先级，不以标签替代。
- 目标：Backlog 中不绑定版本；确认实施后关联 Milestone/Release。
- 描述：背景、影响、验收、非目标、依赖、关联需求文档、相关客户报告/故障号。
- 追溯：开发开始后填写分支和关键提交；发布时填写最终 tag、构建物和验证链接。

一个较大的 Feature 使用父 Issue 管理用户价值，开发、测试、文档、迁移或平台差异使用子 Issue；用 `blocks` / `blocked by` 表达真实依赖。

## 3. 客户问题报告到 Linear 的分诊

```text
桌面端主动/自动报告 → Control API 去重与运行快照 → 人工分诊
  ├─ 重复：关联已有 Linear Issue，仅更新发生次数/受影响版本
  ├─ 确认缺陷：新建或关联 Linear Bug
  ├─ 产品建议：新建或关联 Linear Feature / Improvement
  ├─ 需要客户信息：Control API 状态设为 waiting_user
  └─ 无法复现/非产品问题：记录原因后关闭或忽略
```

禁止将每条自动崩溃、网络失败或重复反馈自动转换成一个 Linear Issue。只有完成去重、确认影响和确定责任边界后才创建或关联 Issue。Linear Issue 描述仅保存脱敏摘要和报告 ID，不复制会话、命令、Token、项目文件或完整日志。

## 4. Bug 的版本规则

- 已发布版本发现的 Bug 必须记录“首次受影响版本”和“计划修复版本”。
- 影响当前发布候选的阻断 Bug 关联当前 Milestone/Release，并明确阻塞关系。
- 没有确定修复版本的 Bug 保持 Backlog；不应把“发现了”误写成“下个版本必修”。
- 已修复 Bug 只有在目标环境验证完成后才可标为 Done；修复提交不等于客户安装包已经包含修复。
