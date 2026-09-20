# 运动记忆（Motion Memory）v0.4.9

> 适配 DeepSeek Harness（DSH）的记忆管理插件：把会话里值得保留的内容自动沉淀为本地记忆文档，通过**对话跟踪 + 周期总结**维护一份"越用越懂你"的长期记忆。全程**本地存储、本地模型、可控可查**。

## 版本配对（先看这一节）

**插件与 DSH 是硬配对关系：只有下表"精确配对"栏里的组合被实际验证过。** 其他组合不是"少个功能"，而是可能整棵插件树挂载失败、或整份会话历史打不开——DSH 的失败方式是 fail-closed，所以版本号对不上就当作不配对。

| 插件版本 | 精确配对（stable，已逐条复核） | 同族可能兼容（maybe，未验证） |
|---|---|---|
| **v0.4.9** / v0.4.8 | **DSH 0.1.6-alpha.2**、DSH 0.1.5-rc.1 | 其他 0.1.6-*、其他 0.1.5-* |
| v0.4.7 | DSH 0.1.5-rc.1 | 其他 0.1.5-* |
| v0.4.4 ~ v0.4.6 | DSH 0.1.2-rc.1 | 其他 0.1.2-* |
| ≤ v0.3.3 | DSH 0.1.0 ~ 0.1.1 | —— |

- 同一份表的机器可读版本：仓库根目录 **`compat.json`**（`stable` / `maybe` 两档）。
- **不用自己记**：插件会报本机配对情况——设置页 →「运动记忆」→「版本与更新」、命令 `memory cmd=status`（【版本配对】段）、`memory cmd=update`（检查更新时一并给出"新版本适配哪个 DSH 版本"）。
- DSH 仍在高频破坏性升级期（0.1.2 → 0.1.6 之间，本插件被同一条链路干掉过 3 次），**升级 DSH 前先确认有没有对应的适配版本**。

## 特性

- **四层记忆结构**：当前活跃 → 周期 → 事件 → 原始对话，层层可溯源（`sourceChain` 一路落到会话@轮次[:stepN]）
- **对话跟踪**：每轮结束自动把本轮内容压成记忆（含经验教训），累积进该会话聚合文件
- **周期总结**：定时把未总结的活跃/重要/事件收拢压缩，防止记忆越积越多
- **关键词查重分流**：写入前自动查同名/近似标题，同一实体更新、不同实体消歧新建并关联
- **引用转跳 + 只读保护**：正文链接点开即溯源；事件/周期默认只读，记忆污染可隔离回滚
- **记忆面板增强**：关键词页按智能体筛选 + 归属标签；活跃页关键词独立词条维护、从关键词库挑选增加
- **首轮总览注入**：重要记忆按分数排序、最近会话工作摘要、用户画像/用户要求全文、隔离通知并入必要记忆区
- **无模型降级**：不配模型也能用（用户消息引用累积 + 周期转正）
- 多智能体归属、自动归档、CAS 并发、失败续跑等工程细节齐全

## 安装

### 方式一：一行命令安装（推荐）

本仓库是标准 DSH 组合包（bundle），用官方安装器装进 profile 即可，配置层自动生效：

```bash
dsh plugin --profile <你的profile名> add github:li3-feng2-jie2/dsh-motion-memory
```

**重启 DSH**，记忆工具与设置界面随重启生效。之后升级版本：`dsh plugin --profile <你的profile名> update dsh-motion-memory`。

### 方式二：git clone 安装（推荐 · 支持一键更新）

```bash
cd <你的profile>/plugins
git clone https://github.com/li3-feng2-jie2/dsh-motion-memory motion-memory-dist
```

在 profile 的 `cordis.patch.yml` 里启用：

```yaml
- insert:
    - id: motion-memory
      name: ./plugins/motion-memory-dist/motion-memory.js
    - id: mm-settings
      name: mm-settings
    - id: mm-profile
      name: mm-profile
```

把两个界面插件挂到 profile 的 `node_modules/`（Windows 推荐 junction）：

```powershell
mklink /J "<你的profile>\node_modules\mm-settings" "<你的profile>\plugins\motion-memory-dist\mm-settings"
mklink /J "<你的profile>\node_modules\mm-profile"  "<你的profile>\plugins\motion-memory-dist\mm-profile"
```

**重启 DSH** 后，设置页 →「运动记忆」→「版本与更新」可检查并一键更新（见[版本与更新](#版本与更新)）。

### 方式三：手动放置

1. 下载源码：`https://github.com/li3-feng2-jie2/dsh-motion-memory`
2. 把 `motion-memory.js`、`mm-settings/`、`mm-profile/`、`motion-memory-modules/`、`compat.json` 放到 profile 的插件目录（如 `~/.dsh/profiles/<profile名>/plugins/`）
3. 把 `mm-settings`、`mm-profile` 挂到（或复制进）profile 的 `node_modules/`
4. 在 `cordis.patch.yml` 里按方式二的三行启用，**重启 DSH**

## 版本与更新

- **检查更新**：启动 8 秒后 + 每 12 小时一次（设置页可关）；手动入口是设置页「版本与更新」或 `memory cmd=update`（检查）/ `memory cmd=update action=apply`（更新）。只检查不下载。
- **更新只在本机 DSH 的配对范围内进行**：远端"最新版"若不是给本机这个 DSH 版本用的，就**不提示升级**（更新会把人拖到不配对的版本，DSH 是 fail-closed）；执行更新也被同一道门挡住。检查结果一行给全：`插件版本 ↔ DSH 版本 · 配对状态 · 可更新至 vX / 已是最新`。
- **更新范围**（设置页可调，配置项 `updatePolicy`）：`exact` 只认精确配对 / `epoch`（默认）精确配对 + 同接口世代 / `family` 再放宽到同子版本族。放宽依据在 `compat.json` 的 `iface`（接口世代）——接口没大变动时把子版本族登记进去（如 `"0.1.6": "dsh3"`），**不用改代码**。
- **执行更新**：git 安装 `git pull --ff-only`；手动安装按 `MANIFEST.json` 清单增量覆盖（逐个校验 sha256）。都需**重启 DSH** 生效；离线只影响提示，不影响使用。

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
