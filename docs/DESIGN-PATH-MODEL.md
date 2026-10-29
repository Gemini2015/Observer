# Observer 路径与身份模型（设计建议稿）

> 版本：v0.3　日期：2026-10-29　性质：设计建议稿
>
> 本文只解决一个问题：**一个文件在某一台机器的某一处，如何被唯一、跨平台、可追溯地定位。**
> 结论：身份是三元组 `(machine_id, mount_id, relpath)`，字符串只是引用；`root` 更名 `mount`。
> 待你拍板的决策点收在 §8，尚未决定的问题收在 §9。

标记说明：✅ 已确认　🟡 建议（可改）　❓ 待讨论

## 1. 结论摘要

- ✅ 一个 agent 对应**一个文件系统命名空间**：默认一台物理机一个 agent；NAS 上宿主与容器是两个命名空间，允许同机多 agent。
- ✅ mount 由 **agent 本地配置**声明：`mount_id` 是稳定逻辑标识，`physical_path` 只在本机解析，不进入身份。
- ✅ 逻辑路径 = `mount_id` + 相对路径；全局身份以**三字段结构体**入库与传输。
- ✅ **任何地方都不得把引用串解析回身份**；收到字符串一律走统一解析器。
- ✅ 对外引用串：`observer://<machine>/<mount>/<relpath>`；机器已确定的上下文可用短形式 `<mount>:/<relpath>`。
- ✅ `root` 全文更名 `mount`，中文「挂载点」，首次出现注明「受管目录」。
- 🟡 同一 agent 内挂载路径不得相同或互相嵌套。
- 🟡 **挂载缺失必须熔断**，不得产生成批「丢失」异常（见 §6.1）。

## 2. 为什么不能用路径拼接

`movie/2024/a.mkv` 的问题不是分隔符选得不好，而是结构性的：

1. **边界不可判**：`movie` 是 mount，还是 mount 下的第一层目录？只有知道 mount 清单才能判断，而字符串里没有清单。
2. **换分隔符也不解决**：`:`、`|`、`::` 在 POSIX 文件名里都合法（`/` 与 NUL 除外）；Windows 上 `:` 还有盘符与 ADS 语义。允许拼接就得允许转义，一旦引入转义，字符串未必能原样读回。
3. **根因是把身份存成字符串**：身份一旦是字符串，重命名比较、跨机关联、修复寻址都要反解，反解就有歧义。

`mount:/relpath`（短形式）能解决第 1 点，但在全局语境里 `movie:` 会被误读成 URI scheme，所以它只适合**限定机器之后**使用。全局引用需要一个自解释的语法，见 §5。

## 3. 身份模型

### 3.1 mount 是什么

一个 mount = 某台机器上「一个被纳入巡检的目录 + 一组策略」。它既不是 Docker 的 volume，也不是操作系统的挂载表条目，而是 Observer 的**逻辑命名空间节点**。

| 字段 | 含义 | 可变 |
| --- | --- | --- |
| `mount_id` | 稳定逻辑标识，全局身份的一部分；`^[a-z0-9][a-z0-9_-]{0,31}$`；同一 agent 内唯一 | ❌ |
| `label` | 人类可读名，如「电影库」 | ✅ |
| `physical_path` | 本机可见路径，如 `/volume1/media/movie`、`D:\Media` | ✅ |
| `sentinel` | 挂载点标记文件的相对路径（内容含 `mount_id`），用于识别「盘没挂载」 | ✅ |
| `fs_kind` | `local` / `network` / `removable` / `fuse`，决定跳过与告警策略 | ✅ |
| `case_sensitive` / `unicode` | 大小写与 Unicode 归一化声明，默认 `auto` 探测 | ✅ |
| `exclude` | 相对路径排除规则（优先于 include） | ✅ |
| `include` | 相对路径白名单规则（为空表示全部纳入；exclude 优先） | ✅ |
| `limits` | 双闸限速：`bytes_per_sec`、`files_per_sec`、`burst_bytes`、`on_window_end` | ✅ |
| `schedule` | 巡检预算与时间窗 | ✅ |
| `read_only` / `repair_allowed` | 是否允许修复写入 | ✅ |
| `volume_id` | 物理卷标识（序列号 / UUID），用于判断「两份副本是否在同一块盘」 | ✅ |

`mount_id` 一旦登记不可直接编辑；需要改名时走迁移操作（见 §9）。

### 3.2 三元组

```
location = (machine_id, mount_id, relpath)
```

- 这是**位置**的身份，不是**文件**的身份。文件身份是内容哈希（另一议题）。
- 三个字段各有明确来源：`machine_id` 由 **agent 配置声明**、hub 注册时校验全局唯一性；`mount_id` 由 agent 配置声明并经 hub 登记；`relpath` 由 agent 遍历时产生。
- `physical_path`、`label`、`volume_id` 都是位置属性，可以变，不参与身份比较。

### 3.3 四层表示

| 层 | 形式 | 用途 |
| --- | --- | --- |
| 身份（唯一真相） | `(machine_id, mount_id, relpath)` | 数据库主键、wire 协议、内部比较、修复寻址 |
| 匹配键 | `path_key`：NFC 归一化 + `/` + 按 mount 声明折叠大小写 | 唯一索引、排除规则匹配、跨机定位 |
| 引用串 | `observer://nas-01/movie/2024/a.mkv` | 日志、告警、导出、文档 |
| 短形式 | `movie:/2024/a.mkv` | 已限定机器的 UI 与 CLI |

## 4. mount 配置草案

```yaml
agent:
  machine_id: nas-01            # 本机声明；hub 注册时校验唯一性，之后不可直接改
  hub: https://hub.lan:8787
  token_file: /etc/observer/token

mounts:
  - id: movie                   # 稳定身份，不随物理位置变化
    label: 电影库                # 显示名，随便改
    path: /volume1/media/movie  # 仅本 agent 可见的物理路径
    sentinel: .observer-mount
    fs_kind: local
    case_sensitive: auto
    unicode: auto
    read_only: true
    repair_allowed: false
    volume_id: auto             # 自动探测；network / fuse 可能为 unknown
    include:
      - "**/*.{jpg,jpeg,png,heic,heif}"   # 为空表示全部纳入
    exclude:
      - "@eaDir/**"
      - "**/*.tmp"
    limits:
      bytes_per_sec: 200MiB
      files_per_sec: 300
      burst_bytes: 12GiB        # 默认 = 60 秒额度
      on_window_end: finish     # finish | abort
    schedule:
      budget_minutes_per_day: 120
      window: "01:00-06:00"
```

这份文件是 agent 的**声明**，不是 hub 的真相源；两者的分工见 §6.3。
限速语义（文件为原子单位、长期平均）与 include/exclude 匹配细节见 [技术方案 §5.5–5.6](DESIGN-TECH.md)。

## 5. 引用串语法

### 5.1 语法

```
reference  := "observer://" machine-id "/" mount-id [ "/" relpath ]
short-form := mount-id ":/" relpath
machine-id := [a-z0-9][a-z0-9_-]{0,31}
mount-id   := [a-z0-9][a-z0-9_-]{0,31}
relpath    := 相对路径，见 §5.2
```

因为 `mount-id` 不含 `/`，第二段必定是 mount：**解析由位置唯一确定，不依赖猜测**。这与 `s3://bucket/key` 同构——bucket 不含 `/`，所以第一段永远是桶。

### 5.2 规范化规则

1. 统一 `/` 分隔：Windows agent 拼完本地路径后把 `\` 转成 `/`；Unix 文件名中的 `\` 是普通字符，**不转换**。
2. 折叠重复 `/` 与 `.` 段（物理等价、无损）。
3. 拒绝 `..`、NUL、前导斜杠；mount 根本身用空 `relpath`，引用串不带尾斜杠。
4. `path_key` = NFC 归一化 + 大小写折叠；若声明不敏感却检测到碰撞（`A.txt` / `a.txt`），**配置报错**，不静默合并。
5. `path_display` 保留原始形式用于展示。
6. 不做 percent 编码：本语法没有 query / fragment 语义；只在写日志时转义控制字符。

### 5.3 示例

| 场景 | 三元组 | 引用串 |
| --- | --- | --- |
| mount 根 | `(nas-01, movie, "")` | `observer://nas-01/movie` |
| 普通文件 | `(nas-01, movie, "2024/a.mkv")` | `observer://nas-01/movie/2024/a.mkv` |
| 含空格 | `(nas-01, music, "A B/C D.flac")` | `observer://nas-01/music/A B/C D.flac` |
| 同一内容在另一机 | `(pc-02, backup, "2024/a.mkv")` | `observer://pc-02/backup/2024/a.mkv` |

### 5.4 硬约束

- 不得在日志、API、文档里使用 `mount/relpath` 的拼接形式。
- 不得把引用串 `split` 后当身份用；必须走统一解析器（`parse_reference`）。
- `label` 不进身份、不进引用串。
- `physical_path` 不进身份、不跨 agent 复用。
- 引用串是自定义语法，不注册为系统 URI scheme，不做 `observer:` 点击打开。

## 6. 失败模式

### 6.1 挂载缺失：最危险的失败模式

场景：磁盘没挂载、容器卷没挂、NAS share 断连。目录对象仍然存在但为空（或只剩少量文件）。如果直接巡检，会在一轮里报出几十万条「文件丢失」，用户的第一反应是卸载产品。

三道防线：

1. **sentinel 校验**：mount 根下必须存在标记文件（默认 `.observer-mount`），内容包含 `mount_id`（可选 `volume_id`）。读不到或不匹配 → mount 置 `unavailable`，本轮**不产生任何 issue**。
2. **消失率熔断**：单轮「丢失 + 不可读」占该 mount 已知文件数的比例超过阈值（mount 文件数 ≥ 100 时按 5%，或绝对数 > 1000）→ 只产生一条「mount 疑似离线」事件，不逐文件报异常，并暂停该 mount 的自动修复。
3. **可达性预检**：建基线、重建基线、批量修复前先做 stat / 列举探测；「目录存在但枚举为空 + 有历史记录」直接判可疑。

`fs_kind = network` 时阈值更保守，并允许短暂断连后重试一次再判定。

### 6.2 其他失败模式

| 场景 | 后果 | 对策 |
| --- | --- | --- |
| 两个 mount 路径相同或嵌套 | 同一文件两个逻辑路径、重复观测 | 配置加载期硬校验，拒绝启动 |
| 两份「副本」在同一块物理盘 | 冗余度虚高，用户误以为安全 | location 记 `volume_id`；冗余度按物理卷去重；`unknown` 时保守标注 |
| 宿主 agent 与容器 agent 各管同一目录 | 被算成两台机器各一份副本 | 同 `volume_id` + 同路径前缀 → 标「同一物理副本」，不重复计入冗余度 |
| 网络盘（SMB / NFS / UNC） | mtime 精度仅 1–2s、rename 非原子、偶发超时 | `fs_kind=network` → 更宽的跳过判定、不升为高置信异常、超时重试 |
| 符号链接指向 mount 外 | 越界读取、身份混乱 | 默认不跟随，记 `skipped(reason=symbolic_link)` |
| mount 删除或改名 | 历史断链、幻觉丢失 | 显式迁移操作 + 审计；删除只置状态，**不删历史** |
| 大小写 / NFD 碰撞 | 一个文件两个身份 | 折叠后碰撞立即报错，不静默合并 |
| mount 内嵌套子挂载 | 与重叠等价 | 要求拆成两个 mount，或用排除规则切掉 |

### 6.3 配置归属

| 归属 | 内容 |
| --- | --- |
| hub | 身份登记与唯一性校验（`machine_id`、`mount_id`）、排除规则、策略、预算、配额 |
| agent | `machine_id` / `mount_id` 声明、`physical_path`、文件系统能力、`volume_id`、实际可达性 |

冲突处理：

- agent 报了 hub 不认识的 mount → 进 `pending_mount` 待批准，**不自动入库**。
- hub 有记录但 agent 未声明 → 标 `unreachable`，**不删历史**。

## 7. 与需求文档的对应

| 需求文档位置 | 变化 |
| --- | --- |
| §5 FR-1 挂载点登记 | 增加 `mount_id` 稳定、路径规范化、重叠校验、缺失熔断 |
| §8 概念模型 | `root` → `mount`，补字段与逻辑路径说明 |
| §9.2 定期巡检 | 遍历单位由 root 改为 mount |
| §12 术语表 | 受管目录 / root → 挂载点 / mount，补逻辑路径与引用串 |

## 8. 决策点（J1–J6，均已确认）

| 编号 | 问题 | 结论 |
| --- | --- | --- |
| J1 | 全局引用串语法 | ✅ 已采纳 `observer://<machine>/<mount>/<relpath>`；`machine:mount:/relpath` 备选不再使用 |
| J2 | 是否保留 `mount:/relpath` 短形式 | ✅ 已采纳，仅限机器已知上下文 |
| J3 | `root` 是否全文更名 `mount` | ✅ 已采纳（v0.2 落地） |
| J4 | 中文术语 | ✅ 已采纳「挂载点」，首次出现注明「受管目录」 |
| J5 | relpath 是否折叠 `//` 与 `.` 段 | ✅ 已采纳（物理等价、无损） |
| J6 | `machine_id` 来源 | ✅ 已采纳：**agent 配置声明**，hub 校验格式并按 machine_id 归并机器；同机多 agent 共享同一 machine_id（mount 冲突拒绝）；改名走迁移操作 |

## 9. 尚未决定的问题

- ❓ **`mount_id` 改名策略**：建议只走迁移操作（批量改写该 mount 下所有 location 的 `mount_id` 并记审计），禁止直接编辑。
- ❓ **`machine_id` 改名策略**：与 `mount_id` 同理，只走迁移操作并记审计；直接改配置文件会让历史观测断链。
- ❓ **sentinel 是否强制**：建议默认强制；`fs_kind=network` 可关闭并自动降级为「仅熔断」。
- ❓ **同机多 agent 是否进 M1**：建议 schema 支持，M1 只做单 agent。
- ❓ **排除规则归属**：建议 hub 下发为主，agent 可追加「硬排除」（安全相关），双方规则版本随观测上报。
- ❓ **冗余度是否按物理卷去重**：建议是，属于 FR-9 与需求 §10-D 的判定规则。
- ❓ **导出格式**：建议 JSON 同时给出三元组字段与引用串，避免消费方自己拼接。

## 10. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.1 | 2026-10-29 | 初稿：三元组身份、mount 映射、引用串语法、失败模式、决策点 |
| v0.2 | 2026-10-29 | 增加 `include` 白名单与 `limits` 双闸限速字段，与技术方案对齐 |
| v0.3 | 2026-10-29 | J 组定稿：`machine_id` 改为 agent 配置声明、hub 校验唯一性；J1 / J2 / J5 按默认采纳 |
