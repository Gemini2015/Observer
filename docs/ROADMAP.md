# 里程碑与后续

> 返回 [README](../README.md)。验收与测试见 [TESTING](TESTING.md)，部署见 [DEPLOY](DEPLOY.md)。

## 已完成

| 里程碑 | 交付 | tag | 计划文档 |
| --- | --- | --- | --- |
| M1 | 单机闭环：扫描/基线/入库/异常/Web 控制台 | `m1` | [PLAN-M1](PLAN-M1.md) |
| M2 | 自动调度（窗口/预算）、多机、离线标记、Wails 桌面端 | `m2` | [PLAN-M2](PLAN-M2.md) |
| M3 | 副本关联 + 跨机修复（隔离/中转/校验/审计） | `m3` | [PLAN-M3](PLAN-M3.md) |
| M4 | NAS 部署产物、Linux 交叉编译、性能基准、告警聚合 | `m4` | [PLAN-M4](PLAN-M4.md) |

各里程碑的范围、设计取舍与验收记录见对应计划文档。

## 后续（M5 / 按需）

1. **扫描优化**：块级扫描、事件驱动（fsnotify/inotify）增量。
2. **通知**：webhook / IM / 邮件（M2 已暂缓，设计保留在 PLAN-M2 §4）。
3. **修复自动化**：按策略自动选择副本并修复（当前为人工确认触发）。
4. **打包分发**：Windows NSIS 安装包、macOS 签名与公证（需对应平台与证书）。
5. **生产运维**：TLS（Caddy）、备份恢复演练、监控与告警接入。
6. **桌面端体验**：首启引导（填写 hub 地址与注册 token）、托盘通知。

## 说明

- 当前能力与本地运行见 [QUICKSTART](QUICKSTART.md)；配置见 [CONFIG](CONFIG.md)。
- 部署产物见 [deploy/](../deploy/)。
