# 运动记忆（Motion Memory）

> 适配 DeepSeek Harness（DSH）的记忆管理插件：把会话中值得保留的内容自动沉淀为本地记忆文档，通过**对话跟踪 + 周期总结**维护一份"越用越懂你"的长期记忆。全程**本地存储、本地模型、可控可查**。

## 特性

- **四层记忆结构**：当前活跃 → 周期 → 事件 → 原始对话，层层可溯源（`sourceChain` 一路落到会话@轮次[:stepN]）
- **对话跟踪**：每轮结束自动把本轮内容压成记忆（含经验教训），累积进该会话聚合文件
- **周期总结**：定时把未总结的活跃/重要/事件收拢压缩，防止记忆越积越多
- **关键词查重分流**：写入前自动查同名/近似标题，同一实体更新、不同实体消歧新建并关联
- **引用转跳**：记忆正文用 `[文字](会话id@轮次)` 等链接格式，页面点击即溯源
- **只读保护**：事件/周期默认只读，用户明确确认才可强改；记忆污染可隔离回滚
- **无模型降级**：不配模型也能用（用户消息引用累积 + 周期转正）
- 多智能体归属、自动归档、CAS 并发、失败续跑等工程细节齐全

## 安装

### 方式一：一行命令安装（推荐）

本仓库是标准 DSH 组合包（bundle），用官方安装器装进 profile 即可，配置层自动生效：

```bash
dsh plugin --profile <你的profile名> add github:li3-feng2-jie2/dsh-motion-memory
```

**重启 DSH**，记忆工具与设置界面随重启生效。之后升级版本：`dsh plugin --profile <你的profile名> update dsh-motion-memory`。

### 方式二：手动放置

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
| `memory` | 综合入口：status / config / notify / recent / history / recall_past / restore / track_run / period_run / period_status / enhance / admin_view / admin_summarize / isolation 等 |
| `memory_query` | 查询/回忆：开工总览 / keyword 搜索 / open 阅读（关联展开）/ openTurn 读轮次原文 / recent / enhance |
| `memory_add` | 写入：keyword / necessary / event / update / edit（用户确认强改）/ forget |
| `memory_noop` | 无更新占位：判定无有效记忆更新时触发，不写文件 |

## 交流群

- 运动记忆 · 聊天交流群：**1073657377**
- 运动记忆 · 开发交流群：**1090687976**

欢迎反馈使用问题、参与功能设计与代码共建。
