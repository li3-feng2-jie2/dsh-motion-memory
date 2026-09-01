# 运动记忆（Motion Memory）v0.4.3

> 适配 DeepSeek Harness（DSH）的记忆管理插件：把会话中值得保留的内容自动沉淀为本地记忆文档，通过**对话跟踪 + 周期总结**维护一份"越用越懂你"的长期记忆。全程**本地存储、本地模型、可控可查**。

> ⚠️ **DSH 版本适配说明**：v0.4.0 针对 DSH **0.1.2-alpha.1** 适配（会话日志 `agentPreset` 字段格式、`ctx.fs` 接口、`DSH_HOME` 环境变量等）。**旧版本（≤ v0.3.3）按旧 DSH 设计，在 DSH 0.1.2+ 下不保证正常运行**——已确认失效点：会话归属解析（记忆页会话列表只显示当前会话）、轮次总结查询、会话日志帧级读取（轮次范围/标题）。**升级 DSH 后请务必同步升级本插件到 v0.4.0+。**

## 特性

- **四层记忆结构**：当前活跃 → 周期 → 事件 → 原始对话，层层可溯源（`sourceChain` 一路落到会话@轮次[:stepN]）
- **对话跟踪**：每轮结束自动把本轮内容压成记忆（含经验教训），累积进该会话聚合文件
- **周期总结**：定时把未总结的活跃/重要/事件收拢压缩，防止记忆越积越多
- **关键词查重分流**：写入前自动查同名/近似标题，同一实体更新、不同实体消歧新建并关联
- **引用转跳**：记忆正文用 `[文字](会话id@轮次)` 等链接格式，页面点击即溯源
- **只读保护**：事件/周期默认只读，用户明确确认才可强改；记忆污染可隔离回滚
- **记忆面板增强**：关键词页按智能体筛选（白名单，显示预设显示名）+ 归属标签；活跃页关键词独立词条维护、从关键词库挑选增加
- **首轮总览注入**：重要记忆按分数排序、最近会话工作摘要、隔离通知并入必要记忆区；对话跟踪关闭时提醒大段工作完成后自行总结
- **无模型降级**：不配模型也能用（用户消息引用累积 + 周期转正）
- 多智能体归属、自动归档、CAS 并发、失败续跑等工程细节齐全

## 安装

### 方式一：一行命令安装（推荐）

本仓库是标准 DSH 组合包（bundle），用官方安装器装进 profile 即可，配置层自动生效：

```bash
dsh plugin --profile <你的profile名> add github:li3-feng2-jie2/dsh-motion-memory
```

**重启 DSH**，记忆工具与设置界面随重启生效。之后升级版本：`dsh plugin --profile <你的profile名> update dsh-motion-memory`。

### 方式二：git clone 安装（推荐 · 支持自动更新检查）

插件内置"版本与更新"功能（启动自动检查 + 每 12 小时一次），依赖 git 工作副本，所以**推荐用 git clone 安装**：

```bash
cd <你的profile>/plugins
git clone https://github.com/li3-feng2-jie2/dsh-motion-memory motion-memory-dist
```

然后在 profile 的 `cordis.patch.yml` 里启用：

```yaml
- insert:
    - id: motion-memory
      name: ./plugins/motion-memory-dist/motion-memory.js
    - id: mm-settings
      name: mm-settings
```

并把 `mm-settings` 挂到 profile 的 `node_modules/`（Windows 推荐用 junction）：

```powershell
mklink /J "<你的profile>\node_modules\mm-settings" "<你的profile>\plugins\motion-memory-dist\mm-settings"
```

**重启 DSH** 后，设置页 →「运动记忆」→「版本与更新」可检查并一键更新（详见下文[版本与更新](#版本与更新)）。

### 方式三：手动放置

1. 下载本仓库源码：`https://github.com/li3-feng2-jie2/dsh-motion-memory`
2. 把仓库根目录下的 `motion-memory.js`（记忆核心插件）、`mm-settings/`（设置界面插件：`index.js` + `client.js` + `package.json`）、`motion-memory-modules/`（纯函数模块）放到 DSH profile 的插件目录（如 `~/.dsh/profiles/<profile名>/plugins/`）
3. 把 `mm-settings` 挂到 profile 的 `node_modules/`：
   - 方式 A（Windows 推荐）：`mklink /J "你的profile\node_modules\mm-settings" "你的profile\plugins\mm-settings"`
   - 方式 B：直接把 `mm-settings/` 目录复制到 `node_modules/mm-settings/`
4. 在 profile 的 `cordis.patch.yml` 里启用：
   ```yaml
   - insert:
       - id: motion-memory
         name: ./plugins/motion-memory.js
       - id: mm-settings
         name: mm-settings
   ```
5. **重启 DSH**，记忆工具与设置界面随重启生效。

## 版本与更新

- **当前版本**：v0.4.3（纯修复：插件目录定位在 DSH 0.1.2-alpha.3 下失效 + MANIFEST 哈希前缀 + 轮次总结折叠 key 修复）
- **git 安装（推荐）**：插件启动后自动检查更新（启动 8 秒后一次 + 每 12 小时一次）。有新版时：
  - 设置页 →「运动记忆」→「版本与更新」→ 点「检查更新」查看，点「更新」拉取，**重启 DSH 生效**；
  - 或命令：`memory cmd=update`（检查） / `memory cmd=update action=apply`（更新）。
- **手动安装**：仍可检查更新——用**版本号对比**（远端 package.json 版本 vs 本地版本），有新版时提示；更新需手动下载替换（避免覆盖你手动安装的本地文件）。检查更新需要网络；连接失败给出项目地址跳转链接，不影响插件使用。
- 检查更新需要 git 与网络可用；连接失败会给出项目地址跳转链接，不影响插件使用。

## 快速上手（3 步）

1. 按上面安装并重启 DSH；
2. 设置页 →「记忆管理员」→ 选一个本地模型（LM Studio / Ollama 加载的 7B~9B 足够，建议不要用付费模型，本工具每次调用都带记忆上下文，付费大模型成本高）；
3. 设置页 →「对话跟踪」→ 启用，间隔设 0（每轮）；正常聊天即可自动沉淀，过一段时间去对话页「记忆」面板看轮次总结 / 关键词 / 周期总结。

## 记忆结构（四层）

```
原始对话（DSH 会话日志，不可变）
   ↑ sourceChain：会话@轮次[:stepN]
事件记忆（对话跟踪/手动/事件工具生成；每会话一个聚合文件 年/月/session-<id>.json）
   ↑ links：kind=turn 指向事件
关键词/多词记忆（重要/ 文件夹；跨会话知识点，可遗忘入补充区）
   ↑ 周期收拢：coveredEvents 指向被覆盖的事件
周期记忆（年/月/；收拢压缩成中长期摘要）
   ↓ 所有层级都可被当前活跃引用
当前活跃（当前活跃/ 文件；每会话一个工作段，贯穿始终）
```

## 文档

- **设置与使用说明**（全部配置项、各功能工作原理、引用格式、工具一览）→ 见 [SETTINGS.md](SETTINGS.md)

## 工具一览

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

**模型选择建议**：选用记忆工具的模型时，最好不要用付费模型。本工具采用"**组装上下文 + 提示模型处理**"的方式，每次调用都会带着当前记忆上下文去提问，缓存未命中率几乎为 100%，用付费大模型会很贵；本地小模型（如 LM Studio / Ollama 加载的 7B~9B 量级）完全够用。

**提示词与模型**：工具内置的总结/判断提示词不一定是最好的，不同模型的能力也影响总结质量——同一套提示词在不同模型上效果差异明显。

**完善度说明**：作者未系统学习 TypeScript，也没有做过长期数据累积的正式测试，纯粹靠以往其他语言的代码经验设计管理流程，并在 DeepSeek Harness 的高自定义环境下反复打磨。功能可用、结构清晰，但**请把它当作一个"能跑、可改、欢迎一起完善"的版本**——部分细节和 bug 可能修得不够好，改动未经充分回归测试。

**寻求合作**：主要作者现在还有其他工作，可能没有那么多精力做细节开发。欢迎懂一些的朋友参与合作——提 issue、改代码，一起把记忆流程打磨得更稳。
