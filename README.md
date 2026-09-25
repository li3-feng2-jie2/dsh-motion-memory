# 运动记忆（Motion Memory）v0.5.0

> 适配 DeepSeek Harness（DSH）的记忆管理插件：把会话里值得保留的内容自动沉淀为本地记忆文档，通过**对话跟踪 + 周期总结**维护一份"越用越懂你"的长期记忆。全程**本地存储、本地模型、可控可查**。

## 安装

本仓库是标准 DSH **组合包（bundle）**：包内 `cordis.patch.yml` 声明三条插件行，安装器把包加进 profile 的 `dsh.profile.bundles` 后配置层自动生效 —— **不需要手工编辑 profile 的 `cordis.patch.yml`，也不需要手工建 `node_modules` 链接**。

「添加插件」（插件页）或 `dsh plugin` 支持三种输入，本包都适用：

| 输入形式 | 命令示例 |
|---|---|
| **GitHub 仓库**（推荐） | `dsh plugin --profile <profile> add github:li3-feng2-jie2/dsh-motion-memory` |
| **本地目录** | `dsh plugin --profile <profile> add "D:\path\to\dsh-motion-memory"`（绝对路径，适用于 clone 下来自行查看/改动） |
| **包名（npm）** | `dsh plugin --profile <profile> add dsh-motion-memory` —— ⚠ **尚未发布到 npm，当前不可用**，等发布后再走这条 |

安装后**重启 DSH**；升级用 `dsh plugin --profile <profile> update dsh-motion-memory`（或在插件页里操作）。装好后设置页会出现「运动记忆」「用户画像」，对话页出现「记忆」面板，模型侧出现 `memory` / `memory_query` / `memory_add` 三个工具。

**安装排错两条**：

1. 包必须声明 `dsh.bundle.patch` —— 否则安装器第一道门就按 `not-a-bundle` 拒绝（本包已声明）；
2. DSH 0.1.7 起，插件行名必须是**包根裸包名**；包内子包要用**相对路径**（写成 `<包名>/<子路径>` 会让两个界面插件的浏览器半收不到，表现为"工具和注入都在、界面整片消失"）。本包已按此写法，改动前请先读 `cordis.patch.yml` 顶部注释。

> **旧版安装方式（v0.4.9 及更早，已废弃）**：手工编辑 profile 的 `cordis.patch.yml` + 用 junction 把 `mm-settings` / `mm-profile` 挂进 `profile/node_modules`。那套方式在 DSH 0.1.7 下会让界面消失，且安装器无法管理；请改用上面的组合包安装。

## 版本适配（重要）

插件与 DSH 是**硬配对**关系：只有逐条复核过的组合才保证可用，其他组合可能整棵插件树挂载失败。

**完整适配表已独立成文 → [COMPAT.md](COMPAT.md)**（机器可读版本是根目录 `compat.json`）。

一句话：**本版 v0.5.0 的精确配对是 DSH 0.1.6-alpha.2 与 0.1.5-rc.1**；DSH 0.1.7 系列需要带 0.1.7 适配层的版本，本仓库发布面暂未包含，请不要直接安装到 0.1.7。

插件会自己报配对情况：设置页 →「运动记忆」→「版本与更新」、`memory cmd=status`（【版本配对】段）、`memory cmd=update`。

## 特性

- **四层记忆结构**：当前活跃 → 周期 → 事件 → 原始对话，层层可溯源（`sourceChain` 一路落到会话@轮次[:stepN]）
- **对话跟踪**：每轮结束自动把本轮内容压成记忆（含经验教训），累积进该会话聚合文件
- **周期总结**：定时把未总结的活跃/重要/事件收拢压缩，防止记忆越积越多
- **关键词查重分流**：写入前自动查同名/近似标题，同一实体更新、不同实体消歧新建并关联
- **引用转跳 + 只读保护**：正文链接点开即溯源；事件/周期默认只读，记忆污染可隔离回滚
- **记忆面板增强**：关键词页按智能体筛选 + 归属标签；活跃页关键词独立词条维护、从关键词库挑选增加
- **首轮总览注入**：用户画像/用户要求全文、最近会话工作摘要、当前活跃关键词、隔离通知并入必要记忆区
- **两阶段更新**：点「下载更新」只把新版文件放进暂存区，**不动正在运行的插件**；重启后自动激活
- **无模型降级**：不配模型也能用（用户消息引用累积 + 周期转正）
- 多智能体归属、自动归档、CAS 并发、失败续跑等工程细节齐全

## 版本与更新

- **检查**：启动 8 秒后 + 每 12 小时一次（设置页可关）；手动入口：设置页「版本与更新」或 `memory cmd=update`（只读，不改任何文件）。
- **下载**：按钮「下载更新」或 `memory cmd=update action=download` —— 按远端 `MANIFEST.json` 把缺失/变化的文件下载到插件目录的暂存区 `.motion-memory-pending/`，逐个校验 sha256，**不触碰当前插件文件**；git 工作副本形态只执行 `git fetch`（不动工作区）。
- **激活**：重启 DSH 后插件启动自检发现完整暂存 → 备份旧文件到 `.motion-memory-bak/` → 原子替换 → 同步版本号。**本次仍由旧代码运行**，控制台会提示"请再重启一次加载新代码"。
- 命令入口：`action=check`（默认）· `download`（下载）· `activate`（立即激活）· `status`（待激活状态）。
- **更新范围门**（配置项 `updatePolicy`：`exact` / `epoch`（默认）/ `family`）：只把"适配本机 DSH"的远端版本当更新目标，放宽依据是 `compat.json` 的 `iface`——最新版适配别的 DSH 时不提示升级。
- **由包管理器安装**（用「添加插件」装进 `node_modules`）的插件**不支持就地激活**：写它会污染 pnpm store。那类安装请用 DSH 插件页 / `dsh plugin update` 升级；插件会直接拒绝并提示。

## 快速上手（3 步）

1. 按上面安装并重启 DSH；
2. 设置页 →「记忆管理员」→ 选一个**本地模型**（LM Studio / Ollama 加载的 7B~9B 足够）；
3. 设置页 →「对话跟踪」→ 启用、间隔设 0（每轮）；正常聊天即可自动沉淀，之后去对话页「记忆」面板看轮次总结 / 关键词 / 周期总结。

> **为什么不建议用付费模型**：本工具是"组装上下文 + 提示模型处理"，每次调用都带着记忆上下文去提问，缓存几乎必定未命中，用付费大模型成本很高。提示词与模型能力也会明显影响总结质量——同一套提示词在不同模型上效果差异很大。

## 记忆结构（四层）

```
原始对话（DSH 会话日志，不可变）  ← sourceChain：会话@轮次[:stepN]
   ↑
事件记忆（每会话一个聚合文件）    ← links：kind=turn 指向事件
   ↑
关键词记忆（重要/，跨会话知识点，可遗忘入补充区）  ← 周期 coveredEvents
   ↑
周期记忆（中长期摘要）→ 当前活跃（每会话一个工作段，贯穿始终，可指向上面任意一层）
```

## 文档与工具

- **设置与使用说明**（全部配置项、各功能工作原理、引用格式）→ [SETTINGS.md](SETTINGS.md)
- **版本适配表**（哪些 DSH 版本能用、`compat.json` 字段、更新范围策略）→ [COMPAT.md](COMPAT.md)

| 工具 | 用途 |
|---|---|
| `memory` | 综合入口：status / config / notify / recent / history / recall_past / restore / track_run / period_run / period_status / enhance / admin_view / admin_summarize / isolation / update 等 |
| `memory_query` | 查询/回忆：开工总览 / keyword 搜索 / open 阅读（关联展开）/ openTurn 读轮次原文 / recent / enhance |
| `memory_add` | 写入：keyword / necessary / event / update / edit（用户确认强改）/ forget |

> 会话模型可调用工具共 3 个（`memory` / `memory_query` / `memory_add`）；另有内部无更新占位（`memory_noop`）仅用于管理员总结的降级通道，不暴露给会话调用。

## 交流群

- 运动记忆 · 聊天交流群：**1073657377**
- 运动记忆 · 开发交流群：**1090687976**

欢迎反馈使用问题、参与功能设计与代码共建。

---

## 项目状态与协作（请先读）

> 开发模式：**个人提供想法，DeepSeek v4 Flash 负责代码编辑与审阅**——功能设计与迭代方向由作者主导，代码实现与审查由 AI 协助完成。

**完善度说明**：作者未系统学习 TypeScript，也没有做过长期数据累积的正式测试，纯粹靠以往其他语言的代码经验设计管理流程，并在 DSH 的高自定义环境下反复打磨。功能可用、结构清晰，但**请把它当作一个"能跑、可改、欢迎一起完善"的版本**——部分细节和 bug 可能修得不够好，改动未经充分回归测试。

**寻求合作**：主要作者现在还有其他工作，可能没那么多精力做细节开发。欢迎懂一些的朋友参与——提 issue、改代码，一起把记忆流程打磨得更稳。
