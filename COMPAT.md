# 版本适配表（Motion Memory ↔ DeepSeek Harness）

> 从 README 剥离独立成文（v0.5.0 起）。机器可读的同一份表是仓库根目录的 **`compat.json`** —— 插件随版本发布它、并读它做配对判定与更新范围判定。

## 为什么是硬配对

DSH 的失败方式是 **fail-closed**：版本不匹配时不是"少个功能"，而可能是**整棵插件树挂载失败**、或**整份会话历史打不开**。所以版本号对不上就当作不配对，不要"差不多能用"。

## 适配表

| 插件版本 | 精确配对（stable，已逐条复核） | 同族可能兼容（maybe，未验证） |
|---|---|---|
| **v0.5.1** | **DSH 0.2.0-rc.2** | 其他 0.2.0-* |
| v0.5.0 | DSH 0.1.6-alpha.2、DSH 0.1.5-rc.1 | 其他 0.1.6-*、其他 0.1.5-* |
| v0.4.9 / v0.4.8 | DSH 0.1.6-alpha.2、DSH 0.1.5-rc.1 | 其他 0.1.6-*、其他 0.1.5-* |
| v0.4.7 | DSH 0.1.5-rc.1 | 其他 0.1.5-* |
| v0.4.4 ~ v0.4.6 | DSH 0.1.2-rc.1 | 其他 0.1.2-* |
| ≤ v0.3.3 | DSH 0.1.0 ~ 0.1.1 | —— |

**关于 DSH 0.1.7 / 0.2.0 系列**：v0.5.0 起发布面已包含 0.1.7 适配层（`defineTool` / `createUserMessage` 改本地实现、`tools.register` 包进 `ctx.effect`），并把插件行名改为「**主行包根裸包名 + 包内子包相对路径**」；v0.5.1 在 **DSH 0.2.0-rc.2** 上逐项实测通过（`memory` / `memory_query` / `memory_add` 可用、界面半正常进客户端插件表、设置页「运动记忆」与会话「用户画像」页签可见）。

- **DSH 0.2.0-rc.2**：v0.5.1 的精确配对（本次实测基准）；
- **DSH 0.1.7 系列**：行名形态与 v0.5.0 相同，但**本次未复核**，装前请自行跑一遍 `memory cmd=status` 并确认三个页签；
- **DSH 0.1.6 及更早**：请按 v0.5.0 行登记的复核基准（0.1.6-alpha.2 / 0.1.5-rc.1），不要直接套用 v0.5.1 的结论。

## compat.json 字段

| 字段 | 含义 |
|---|---|
| `current` | 当前插件版本 |
| `iface` | **接口世代**：DSH 版本 → 世代标签（如 `"0.1.6-alpha.2": "dsh3"`）。只有登记在案的 DSH 版本才参与"放宽更新" |
| `entries[].stable` | 逐条复核过、可稳定使用 |
| `entries[].maybe` | 同子版本族、可能兼容但未验证 |
| `entries[].iface` | 该插件版本所属接口世代 |
| `entries[].note` | 该版本相对上一版改了什么（便于判断是否要升） |

## 更新范围（设置页可调，配置项 `updatePolicy`）

| 取值 | 含义 |
|---|---|
| `exact` | 只认精确配对 |
| `epoch`（默认） | 精确配对 + 同接口世代 |
| `family` | 再放宽到同子版本族 |

放宽只改 `compat.json`（往 `iface` 补一个键即可），**不用改代码**。

## 插件会自己报配对情况

- 设置页 →「运动记忆」→「版本与更新」
- `memory cmd=status`（【版本配对】段）
- `memory cmd=update`（检查更新时一并给出"新版本适配哪个 DSH 版本"）

## 怎么确认本机 DSH 版本

插件内的 `detectDshVersion()` 按可信度探测（v0.5.0 起）：

1. 环境变量 `DSH_VERSION`（最高优先，可手工指定）；
2. **运行时线索**：插件目录、`cwd`、`process.argv[1]`、`process.execArgv` 里的 `--import file://…`（tsx 等加载器路径）逐级上溯 —— 先找 `<dir>/node_modules/@deepseek-ai/dsh/package.json`，再找源码树根 `<dir>/package.json`（包名接受 `@deepseek-ai/dsh` **或** `@deepseek-ai/dsh-root`）；
3. 兜底：`<DSH_HOME>/profiles/<profile>/node_modules/@deepseek-ai/dsh`，其次 `<DSH_HOME>/profiles/node_modules/@deepseek-ai/dsh`。

> **为什么强调这一点**：升级 DSH 后常常残留旧依赖树（例如 `profiles/node_modules` 还指向上一代的 0.1.6）。v0.5.0 之前，探测会先命中那棵旧树，把本机版本认成旧版（于是显示"精确配对"却是错的）。现在运行时线索优先，并且把源码树根的 `@deepseek-ai/dsh-root` 包名纳入判定。升级 DSH 后建议顺手清理这类残留树。

## 升级 DSH 前的检查清单

1. 备份：`~/.dsh/运动记忆`、`~/.dsh/sessions`、profile 的 `motion-memory.config.json`；
2. 确认新 DSH 版本在本表里有精确配对（或在 `iface` 里登记过、且你接受"同世代未逐条复核"的风险）；
3. 升级后跑一遍：`memory cmd=status`（看【版本配对】是否指到新版本）、`memory cmd=update`、设置页三个页签是否正常；
4. 出问题先按本表退回到精确配对的 DSH 版本；插件侧问题请带 `memory cmd=status` 输出提 issue。
