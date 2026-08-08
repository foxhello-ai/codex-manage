# Cloud Platform v1.0.6 同期发布记录

## 发布事实与证据边界

- 发布线：Cloud Platform（Control API、Tunnel Worker、Admin Web、PostgreSQL 与部署编排）。
- 发布关系：项目负责人确认 Cloud Platform v1.0.6 与 Desktop v1.0.6 同期发布。
- 关联 Desktop 冻结提交：`3ac606b`。该提交是 Desktop 版本边界，不足以单独证明云端生产镜像的精确来源。
- 当前证据等级：发布确认，证据待补。

这是一条真实发布事实记录，不是对“证据齐全”的宣称。历史部署使用镜像 tag 和 Docker Compose，但当前未回收到不可变镜像 digest、实际部署时间、数据库迁移执行结果、生产环境验收和回滚镜像。

## 应回补的最小证据

1. 当期 `control-api`、`admin-web` 与相关 Worker 的镜像 tag 和 digest。
2. 部署使用的 Compose/.env 版本及实际 Git commit。
3. PostgreSQL 迁移版本、备份和恢复演练记录。
4. Control API、Tunnel、Admin Web、桌面联通性的环境验收记录。
5. 可用于回滚的上一版本镜像与恢复步骤。

在证据回补完成前，不创建追溯性 `cloud/v1.0.6` tag，也不根据 Desktop commit 反推云端镜像。后续 Cloud Platform v1.0.7 可以与 Desktop v1.0.7 同步发布，但需要单独建立 Cloud release、镜像 digest、迁移门禁和回滚记录。
