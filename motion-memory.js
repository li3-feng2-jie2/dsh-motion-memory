/**
 * motion-memory — 运动记忆 host-plane plugin（固化版）。
 *
 * 动态插件 mymem-1/pkg-15 验证通过后的常驻移植：工具、事件链、存储、隔离
 * 全部保留；去掉浏览器设置页与 RPC（本地文件插件无 client 半），配置读写
 * 由 memory_config 工具接管。
 *
 * 挂载方式：profile 用户补丁层（~/.dsh/profiles/web/cordis.patch.yml insert 一行），
 * 所有会话可见，进程重启不丢。
 *
 * @module motion-memory
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'
// 原生 fs：仅用于读写插件自身持久化配置（~/.dsh/profiles/web/motion-memory.config.json），
// 固定位置不随工作区/会话漂移；记忆文件仍走 ctx.fs（沙箱）。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync, rmdirSync, unlinkSync } from 'node:fs'
// zstdDecompressSync 已随会话日志读取拆至 motion-memory-modules/session-log.mjs
// 版本更新检查（v0.1.x）：git 绑定安装时用 git fetch/pull 检查并更新
import { execFile as execFileCb } from 'node:child_process'
// import { installAdmin } from './motion-admin.js'
// 周期总结模块（拆分）：素材档位纯逻辑
import { SCOPE_DEFAULTS, scopeLabelOf } from './motion-memory-modules/period-scope.mjs'
// 会话日志帧级读取模块（拆分）：路径推导 + zstd 帧扫描 + 状态化读取工厂
// （ZSTD_MAGIC/encodeSegment/projectKeyOf/sessionLogsRoot/scanZstdFrames/sessionLogPathOf
//   已拆至 motion-memory-modules/session-log.mjs；createSessionLogReader 工厂在 apply 内注入）
// 文本工具模块（拆分）：段落/句子切分、diff、历史重建、delta 摘要（纯函数）
import { splitParagraphs, splitSentences, diffParagraph, diffContent, applyInverseParagraph, applyInverse, reconstructAt, deltaOverlap, trunc, deltaSummary, opLabel } from './motion-memory-modules/text-utils.mjs'
// 分块/估算模块（拆分）：token 估算、批次摘要、单块预算、句子切块、末尾小段合并（纯函数）
import { estimateTokens, batchDigest, blockBudget, chunkItemsByBudget, splitItemBySentences, mergeTailSmallChunk } from './motion-memory-modules/chunker.mjs'
// 时间/路径工具模块（拆分，A 档）：本地时间格式化、ISO 解析、日期路径段、唯一 id（纯函数）
import { pad, nowIso, parts, ymdPath, ymPath, isEventRel, stamp, ymdCompact, parseIso, uid } from './motion-memory-modules/time-utils.mjs'
// 记忆文件对象构造模块（拆分，A 档）：历史条目、溯源引用、关键词对象、文件名安全化、事件命名（自洽模块）
import { histEntry, turnRefOfMeta, newKeywordObj, sanitizeFile, eventFileName } from './motion-memory-modules/memory-objects.mjs'
// 事件文本提取模块（拆分，A 档）：内容块文本化、token 用量、step 文本、超长省略（纯函数）
import { textOfContent, usageOf, stepTextOf, trimTextMiddle } from './motion-memory-modules/event-text.mjs'
// 记忆文件对象管理模块（拆分，B 档）：MemFiles 工厂（7 类记忆文件 load/save/migrate，依赖注入）
import { createMemFiles } from './motion-memory-modules/mem-files.mjs'
// 会话日志状态化读取模块（拆分，B 档）：帧级增量读取/事件读取/标题读取工厂（依赖注入）
import { createSessionLogReader } from './motion-memory-modules/session-log.mjs'
// 核心运行时模块（拆分，C 档）：state/paths/fs/归属/查找/配置 共享基础设施（依赖注入）
import { createCore } from './motion-memory-modules/core.mjs'
// 隔离域模块（拆分，C 档）：记忆隔离快照/回滚/解除（依赖注入）
import { createIsolation } from './motion-memory-modules/isolation.mjs'
// 版本更新域模块（拆分，C 档）：git/清单驱动检查与更新（依赖注入）
import { createUpdate } from './motion-memory-modules/update.mjs'
// 活跃记忆域模块（拆分，C 档）：读写/索引/works 段管理（依赖注入）
import { createActive } from './motion-memory-modules/active.mjs'
// 记忆管理员域模块（拆分，C 档）：调度/模型/压缩引擎（依赖注入）
import { createAdmin } from './motion-memory-modules/admin.mjs'
// 对话跟踪域模块（拆分，C 档）：间隔总结/聚合写入/无模型降级/懒归档（依赖注入）
import { createTrack } from './motion-memory-modules/track.mjs'
// 周期总结域模块（拆分，C 档）：定时周期/请求检测/手动触发（依赖注入）
import { createPeriod } from './motion-memory-modules/period.mjs'
// 写入域模块（拆分，C 档）：memory_add 6 kind 实现（依赖注入）
import { createWrite } from './motion-memory-modules/write.mjs'
// 语义/强化域模块（拆分，C 档）：查询强化/语义检索/消歧判定（依赖注入）
import { createSemantic } from './motion-memory-modules/semantic.mjs'
// 查询/回忆域模块（拆分，C 档）：memory_query 实现/往时回忆/捡回/历史（依赖注入）
import { createQuery } from './motion-memory-modules/query.mjs'

export const name = 'motion-memory'

export const inject = ['fs', 'tools', 'sandboxPolicy']

export function apply(ctx) {
  // ── 核心运行时（C 档拆分）：state/paths/会话/fs/归属/查找/配置 全部移入 core.mjs，
  const core = createCore(ctx)
  const {
    state, fs, tools, sandboxPolicy, llm, p, root, relOf, normWs, baseWs,
    defaultRootFrom, dshHome, dshProfile, configPath, readConfigFile, writeConfigFile,
    legacyConfigPaths, readJsonFileNative, parseRemoteJson, memoryFileCount,
    globalDefaultRoot, necessaryDir, importantDir, archiveBaseDir, archiveDirFor,
    dailyBaseDir, activeDir, noModelDir, isolationDir, quarantineDir, queryLogPath,
    periodBaseDir,
    setSessionCwd, sessionCwdOf, cwdOf, sessionPolicy,
    acquireWriteLock, readJson, bumpVersion, isUnderMemoryRoot, isUnderPluginDir,
    nativeWriteAllowed, writeTextChannel, writeJson, writeJsonCAS, listFiles,
    tombstone, isTombstone, fileNameOf, stateAt,
    ownerOf, currentOwner, isAdminAgent, scopeOwner, queryOwnerOf,
    sessionPresetOf, ownerKeyOf, sessionPresetOfAsync, ownerKeyOfAsync, mergeLegacyOwners,
    scanDir, findInDir, findImportant, findArchive, findKeyword, titleWords,
    findSimilarTitles, searchTitles, lastOpTime, lastOp, isoStr, uniquePath, pageSlice,
    defaultConfig, cfg, adminCfg, pluginGitDir, pluginDir,
    setReaderFirstFrames, setMemFiles,
  } = core
  // ── 会话日志帧级读取（B 档拆分）：须先于 MemFiles（buildSessionRef 是 const 解构，TDZ 不可后置引用）
  const {
    sessionLogPathOf, readSessionLogFrames, readSessionEvents,
    readSessionEventsFirstFrames, readSessionTitleFromLog, buildSessionRef,
  } = createSessionLogReader({ p, state, ctx })
  // 注入 session-log 的限帧读取（sessionPresetOfAsync 兜底用）
  setReaderFirstFrames(readSessionEventsFirstFrames)
  const MemFiles = createMemFiles({
    p, root, readJson, writeJson, listFiles, isTombstone, relOf, uniquePath,
    sanitizeFile, histEntry, newKeywordObj, eventFileName, uid, nowIso, ymPath,
    buildSessionRef, withActiveParents,
    importantDir, dailyBaseDir, periodBaseDir, necessaryDir, noModelDir, isolationDir, activeDir,
  })
  // 注入 MemFiles（core 的 init 迁移兜底用）
  setMemFiles(MemFiles)

  // 隔离域（C 档拆分）：runIsolation/memCmdIsolation*/isolation-restore/clear
  const isolation = createIsolation(core)
  const { runIsolation, memCmdIsolation, memCmdIsolationRestore, memCmdIsolationClear } = isolation

  // 版本更新域（C 档拆分）：execGit/checkUpdate/applyUpdate/memCmdUpdate/startAutoUpdateCheck
  const update = createUpdate(core, { execFileCb, createHash })
  const {
    UPDATE_PROJECT_URL, execGit, pluginVersionInfo, compareVersions, checkUpdate,
    applyUpdate, downloadUpdateFromManifest, cleanupUpdateCache, rmSyncSafe, rmRecursiveSafe,
    memCmdUpdate, autoUpdateCheck, startAutoUpdateCheck,
  } = update

  // 活跃记忆域（C 档拆分）：readTurnUserText 为跨域依赖（adminCfg 已归 core），组装时传入
  const active = createActive(core, { readTurnUserText })
  const {
    activeIndexPath, activeKeyOf, readTurnUserTextRetry, summarySimilar,
    agentActivePath, agentActiveTitle, readAgentActive, withSourceRef,
    pushMergedHistory, queryDayCount, ensureSessionWorkSegment,
    archiveWorksSegment, restoreWorksSegment, writeActive, refreshActiveIndex, touchActive,
  } = active

  // 记忆管理员域（C 档拆分）：调度/模型/压缩引擎（跨域 deps：链接段/active/track/轮次读取）
  const admin = createAdmin(core, {
    autoLink, withActiveParents, buildSessionRef,
    touchActive, activeIndexPath,
    readStepRange, stepsToText,
  })
  const {
    resolveModelConfig, adminHasModel, scheduleWork, sweepSpilledQueues,
    adminContextText, activeRecordsContextText, adminLlm, parseAdminJson,
    summarizeChunk, chunkCompress, memCmdAdminView, memCmdAdminSummarize,
  } = admin

  // 对话跟踪域（C 档拆分）：间隔总结/聚合写入/无模型降级/懒归档（turn/end 钩子在工厂内自注册）
  const track = createTrack(core, {
    scheduleWork, resolveModelConfig, chunkCompress,
    readStepRange, stepsToText, readTurnUserText,
    restoreWorksSegment, ensureSessionWorkSegment, readAgentActive, writeActive,
    withSourceRef, buildSessionRef, reloadConfigIfChanged,
  })
  const {
    trackCfg, hasTrackSummary, runTurnSummary, runTurnSummaryTask, applyEconomize,
    appendTurnToAggregate, mergeScatteredTurnEvents, lazyArchive, memCmdTrackRun,
  } = track

  // 语义/强化域（C 档拆分）：查询强化/更新强化/语义检索/消歧判定（period/write 的 upsertEmbedding 等由此提供）
  const semantic = createSemantic(core, {
    adminLlm, parseAdminJson, resolveModelConfig, scheduleWork,
    queryDayCount, expandLinks, readTurnUserTextRetry,
  })
  const {
    enhanceCfg, searchAllMemories, semanticCfg, upsertEmbedding, removeEmbedding,
    rebuildEmbeddingIndex, semanticHits, enhanceQuery, enhanceUpdate,
    dedupJudgeVerdict, memCmdEnhance, memCmdRecent,
  } = semantic

  // 查询/回忆域（C 档拆分）：memory_query 实现/往时回忆/捡回/历史（注册壳留主文件）
  const query = createQuery(core, {
    resolveModelConfig, expandLinks, readTurnUserTextRetry, readAgentActive,
    activeIndexPath, touchActive, logQuery, recentQueries, readTurnRef,
    recordModelText, searchAllMemories, semanticHits,
  })
  const { memCmdQuery, memCmdRecallPast, memCmdRestore, memCmdHistory } = query
  // 后置注入：admin 溢出重建需 track 函数（运行时才用，避免工厂创建期循环依赖）
  admin.setTrackFns({ hasTrackSummary, trackCfg, runTurnSummaryTask })

  // 周期总结域（C 档拆分）：定时周期/请求检测/手动触发（timerSvc 定时器在工厂内自注册）
  const period = createPeriod(core, {
    scheduleWork, adminLlm, parseAdminJson, resolveModelConfig, adminContextText,
    activeRecordsContextText, chunkCompress, sweepSpilledQueues,
    runTurnSummary, appendTurnToAggregate, applyEconomize,
    readAgentActive, activeIndexPath, refreshActiveIndex, writeActive, archiveWorksSegment,
    queryDayCount, readStepRange, stepsToText, readTurnUserText, readTurnRef,
    upsertEmbedding, pushDiff, reloadConfigIfChanged, readSessionLogFrames,
  })
  const {
    periodCfg, runPeriodSummary, sessionTurnsOf, removeNoModelTurnRef,
    memCmdPeriodRun, memCmdPeriodStatus,
  } = period

  // 写入域（C 档拆分）：memory_add 6 kind（注册壳留主文件，run 体 memCmdAdd 在工厂）
  const write = createWrite(core, {
    validateLinks, withActiveParents, autoLink, unmountFromActive,
    appendTurnToAggregate, writeActive, withSourceRef, touchActive,
    buildSessionRef, dedupJudgeVerdict, upsertEmbedding, removeEmbedding,
  })
  const { memCmdAdd } = write
  // SessionEvent 信封 = { type, seq, time, data }：轮次号/步骤号/消息均在 e.data。
  // （textOfContent/usageOf/stepTextOf 已拆至 ../motion-memory-modules/event-text.mjs——顶层 import 同名引入）
  // ── 会话日志帧级读取（②-A 缓存 + ②-B 帧级定位）──────────────────
  // 会话日志物理格式（dsh-session-persistence-jsonl）：
  //   <DSH_HOME>/sessions/<projectKey(cwd)>/<encodeSegment(sid)>/session.jsonl.zstd
  //   文件 = 多个独立可解压的 zstd 帧拼接（帧边界=事件批次，行不跨帧）
  //   帧[0] = header 行（含 cwd），后续帧 = 事件批次 JSONL 行
  // 本实现：① 会话级缓存（mtime+size 失效）② 增量解压新增帧（而非每次全量解压）
  // （ZSTD_MAGIC/encodeSegment/projectKeyOf/sessionLogsRoot/scanZstdFrames 已拆至
  //   ../motion-memory-modules/session-log.js）
  // ── 会话日志帧级读取（②-A 缓存 + ②-B 帧级定位）──────────────────
  // （已拆至 ../motion-memory-modules/session-log.mjs——createSessionLogReader 解构已提前至 MemFiles 之前）

  // 超长文本中部省略：已拆至 ../motion-memory-modules/event-text.mjs（trimTextMiddle，顶层 import 同名引入）
  function trimCap(cap) {
    return Math.min(Math.max(1, Number(cfg().readTrimChars) || 500), Math.max(1, Math.floor(Number(cap) / 2)))
  }
  // 整轮文本读取（兼容旧调用：openTurn 全篇）
  async function readTurn(sid, turn, cap) {
    const events = await readSessionEvents(sid)
    const parts = []
    let inTurn = false
    for (const e of events) {
      const d = (e && e.data) || {}
      if (e.type === 'turn/start' && d.turn === turn) { inTurn = true; continue }
      if (e.type === 'turn/end' && d.turn === turn) break
      if (!inTurn && !(e.type === 'assistant/message' && d.turn === turn)) continue
      if (e.type === 'user/message') {
        const t = textOfContent(d.content)
        if (t) parts.push('用户：' + t)
      } else if (e.type === 'assistant/message' && d.turn === turn) {
        const t = textOfContent(d.message && d.message.content)
        if (t) parts.push('回答：' + t)
      }
    }
    const text = parts.join('\n')
    if (!text) return '（该轮次无文本内容）'
    return text.length > cap ? trimTextMiddle(text, trimCap(cap)) : text
  }
  // 步骤级读取：turn 内 stepFrom..stepTo（含）切片，按 step 归组
  // 返回 [{ step, parts: [{kind, text}], usage }]，parts 按事件顺序
  async function readStepRange(sid, turn, stepFrom, stepTo) {
    const events = await readSessionEvents(sid)
    const from = (stepFrom === undefined || stepFrom === null) ? 1 : stepFrom
    const to = (stepTo === undefined || stepTo === null) ? from : stepTo
    const steps = []
    let inTurn = false
    for (const e of events) {
      const d = (e && e.data) || {}
      if (e.type === 'turn/start' && d.turn === turn) { inTurn = true; continue }
      if (e.type === 'turn/end' && d.turn === turn) break
      if (!inTurn) continue
      const st = d.step
      if (st === undefined || st < from || st > to) continue
      if (e.type === 'step/start') {
        steps.push({ step: st, parts: [], usage: null })
        continue
      }
      const cur = steps[steps.length - 1]
      if (!cur || cur.step !== st) continue
      if (e.type === 'assistant/message') {
        const t = textOfContent(d.message && d.message.content)
        if (t) cur.parts.push({ kind: 'assistant', text: t })
        const u = usageOf(e)
        if (u && u.total) cur.usage = u
      } else if (e.type === 'tool/call' || e.type === 'tool/result') {
        const t = stepTextOf(e)
        if (t) cur.parts.push({ kind: e.type === 'tool/call' ? 'tool-call' : 'tool-result', text: t })
      }
    }
    return steps
  }
  // 步骤级文本拼接（用于压缩引擎输入）
  function stepsToText(steps, withStepLabel) {
    const out = []
    for (const s of steps) {
      const label = withStepLabel ? '[step ' + s.step + '] ' : ''
      const body = (s.parts || []).map(p => p.text).join('\n')
      if (body) out.push(label + body)
    }
    return out.join('\n')
  }
  // 用户消息文本（本轮入口，压缩引擎需要）
  async function readTurnUserText(sid, turn, cap) {
    const events = await readSessionEvents(sid)
    let inTurn = false
    let out = ''
    for (const e of events) {
      const d = (e && e.data) || {}
      if (e.type === 'turn/start' && d.turn === turn) { inTurn = true; continue }
      if (e.type === 'turn/end' && d.turn === turn) break
      if (!inTurn) continue
      if (e.type === 'user/message') {
        const t = textOfContent(d.content)
        if (t) { out += (out ? '\n' : '') + t; break }
      }
    }
    return out.length > cap ? trimTextMiddle(out, trimCap(cap)) : out
  }
  // 轮次引用统一读取：ref 格式 `会话id@轮次`（整轮）、`会话id@轮次:step1-2`（步骤段）、
  // 兼容节约模式产生的 `会话id@轮次:truncated` 与句子切分后缀 `#sN`（剥掉后回退到轮次级）
  async function readTurnRef(ref, cap) {
    const s = String(ref || '')
    // 剥掉 #sN 句子切分后缀 与 :truncated/:truncated#sN 节约模式后缀
    const normalized = s.replace(/#s\d+$/, '').replace(/:truncated(#s\d+)?$/, '')
    const m = normalized.match(/^(.+)@(\d+)(?::step(\d+)(?:-(\d+))?)?$/)
    if (!m) return '（轮次指向格式无效：' + s + '）'
    const sid = m[1]
    const turn = Number(m[2])
    const stepFrom = m[3] !== undefined ? Number(m[3]) : undefined
    const stepTo = m[4] !== undefined ? Number(m[4]) : stepFrom
    if (stepFrom === undefined) return readTurn(sid, turn, cap)
    const steps = await readStepRange(sid, turn, stepFrom, stepTo)
    const text = stepsToText(steps, true)
    if (!text) return '（该步骤段无文本内容）'
    return text.length > cap ? trimTextMiddle(text, trimCap(cap)) : text
  }

  // ── 关联展开（cascadeDepth）───────────────────────────────────────────
  async function expandLinks(obj, depth, seen, cap) {
    const out = []
    let used = 0
    let capped = false
    const lists = ((obj.links && obj.links.children) || []).concat((obj.links && obj.links.parents) || [])
    for (const l of lists) {
      if (!l || capped) continue
      if (l.kind === 'keyword' && l.title) {
        const key = 'k:' + l.title
        if (seen.indexOf(key) >= 0) continue
        seen.push(key)
        const e = await findKeyword(l.title)
        if (!e) continue
        // v4 #4：展开拒绝——该记忆被标记为长期不用，不再展开（防过度展开）
        if (e.obj.expandRefused) { out.push('【' + l.title + '】（已设置展开拒绝，长期未使用）'); continue }
        const block = '【' + l.title + '】' + (e.obj.content || '（空）')
        if (used + block.length > cap) { capped = true; out.push(block.slice(0, Math.max(0, cap - used)) + '\n（超出上限已截断）'); break }
        out.push(block)
        used += block.length
        if (depth > 1) {
          const sub = await expandLinks(e.obj, depth - 1, seen, cap - used)
          if (sub.text) { out.push(sub.text); used += sub.text.length; capped = capped || sub.capped }
        }
            } else if (l.kind === 'turn' && l.ref) {
              const key = 't:' + l.ref
              if (seen.indexOf(key) >= 0) continue
              seen.push(key)
              const block = await readTurnRef(l.ref, 2048)
              const full = '【轮次 ' + l.ref + '】' + block
              if (used + full.length > cap) { capped = true; out.push(full.slice(0, Math.max(0, cap - used)) + '\n（超出上限已截断）'); break }
              out.push(full)
              used += full.length
            }
    }
    return { text: out.join('\n'), capped }
  }

  // ── 关联引用有效性校验（写入前检查；无效者提示且不写入）────────────────
  // 支持类型：
  //   { kind: 'keyword', title }        → 重要/补充文件夹存在同名关键词记忆
  //   { kind: 'turn', ref }             → readTurnRef 能读到会话@轮次[:step] 内容
  //   { kind: 'event', date, title }    → 记忆累积/日期目录存在该标题事件（date 形如 YYYY/MM/DD，缺省当前日期）
  // 返回 { ok, valid[], invalid[] }；调用方只写 valid，invalid 逐条提示。
  async function validateLinks(links) {
    const valid = []
    const invalid = []
    const lists = [
      { side: 'children', items: (links && links.children) || [] },
      { side: 'parents', items: (links && links.parents) || [] },
    ]
    for (const { side, items } of lists) {
      for (const l of items || []) {
        if (!l || typeof l !== 'object') { invalid.push({ side, reason: '引用项不是对象' }); continue }
        const kind = l.kind
        if (kind === 'keyword') {
          const title = String(l.title || '').trim()
          if (!title) { invalid.push({ side, reason: 'keyword 引用缺 title' }); continue }
          const e = await findKeyword(title)
          if (!e) { invalid.push({ side, reason: 'keyword 引用无效：未找到记忆「' + title + '」' }); continue }
          valid.push({ side, link: { kind: 'keyword', location: e.zone === 'archive' ? 'archive' : 'important', title } })
        } else if (kind === 'turn') {
          const ref = String(l.ref || '').trim()
          if (!ref) { invalid.push({ side, reason: 'turn 引用缺 ref' }); continue }
          try {
            const block = await readTurnRef(ref, 2048)
            if (!block) { invalid.push({ side, reason: 'turn 引用无效：无法读取「' + ref + '」（会话/轮次不存在或不可达）' }); continue }
          } catch (e) { invalid.push({ side, reason: 'turn 引用无效：「' + ref + '」读取失败：' + String((e && e.message) || e) }); continue }
          valid.push({ side, link: { kind: 'turn', ref } })
        } else if (kind === 'event') {
          const title = String(l.title || '').trim()
          if (!title) { invalid.push({ side, reason: 'event 引用缺 title' }); continue }
          const date = String(l.date || '').trim() || ymdPath(new Date())
          // v5：目录 = 年月（YYYY/MM），文件名带 DD_ 前缀；date 保持 YYYY/MM/DD 语义
          const dateParts = date.match(/^(\d{4})\/(\d{2})(?:\/(\d{2}))?/)
          const monthDir = dateParts ? (dateParts[1] + '/' + dateParts[2]) : date.slice(0, 7)
          const dayPref = dateParts && dateParts[3] ? dateParts[3] + '_' : ''
          const dir = p(dailyBaseDir(), monthDir)
          let found = false
          try {
            for (const f of await listFiles(dir, false)) {
              if (dayPref && f.name.indexOf(dayPref) !== 0) continue
              const o = await readJson(f.path)
              if (o && !isTombstone(o) && o.kind === 'event' && String(o.title || '') === title) { found = true; break }
            }
          } catch (e) {}
          if (!found) { invalid.push({ side, reason: 'event 引用无效：日期 ' + date + ' 下未找到事件「' + title + '」' }); continue }
          valid.push({ side, link: { kind: 'event', date, title } })
        } else {
          invalid.push({ side, reason: '未知引用类型：' + String(kind) + '（支持 keyword/turn/event）' })
        }
      }
    }
    return { ok: invalid.length === 0, valid, invalid }
  }

  // ── 双向关联自动连接（子关联触发时父关联自动连上，TArray 去重）─────────
  // v4 扩展：支持 kind:'active' 引用 —— 挂载到智能体活跃文件（该记忆成为其 refs 成员）
  // 自动挂载辅助：links 的 parents 加本智能体 active 引用（preset 智能体）
  function withActiveParents(links, meta) {
    const parents = (links && links.parents) ? links.parents.slice() : []
    const mg = meta && meta.agent
    if (mg && String(mg).indexOf('preset:') === 0 && !parents.some(p => p && p.kind === 'active')) {
      parents.push({ kind: 'active', agent: String(mg) })
    }
    return { parents, children: (links && links.children) || [] }
  }
  // 移除挂载：记忆被遗忘/移除时，从本智能体活跃文件的 refs 清除对应引用
  async function unmountFromActive(agentKey, titleOrId) {
    try {
      if (!agentKey) return
      const { obj: act, path } = await readAgentActive(agentKey)
      act.refs = act.refs || []
      const before = act.refs.length
      act.refs = act.refs.filter(r => r.title !== titleOrId && r.ref !== titleOrId)
      if (act.refs.length === before) return
      act.updatedAt = nowIso()
      await writeJson(path, act)
    } catch (e) {}
  }
  async function autoLink(obj, meta) {
    try {
      const myTitle = obj && obj.title
      const myLoc = (obj && obj.location) || 'important'
      if (!myTitle) return
      const children = (obj.links && obj.links.children) || []
      const parents = (obj.links && obj.links.parents) || []
      const connect = async (title, reverseList) => {
        if (!title) return
        const target = await findKeyword(title)
        if (!target) return
        const tObj = target.obj
        const list = reverseList === 'parents' ? ((tObj.links && tObj.links.parents) || []) : ((tObj.links && tObj.links.children) || [])
        const dup = list.some(x => x.kind === 'keyword' && x.title === myTitle && (x.location || 'important') === myLoc)
        if (dup) return
        tObj.links = tObj.links || { parents: [], children: [] }
        if (reverseList === 'parents') tObj.links.parents = list.concat([{ kind: 'keyword', location: myLoc, title: myTitle }])
        else tObj.links.children = list.concat([{ kind: 'keyword', location: myLoc, title: myTitle }])
        tObj.history = tObj.history || []
        tObj.history.push(histEntry('update', { ...meta, note: '自动关联' + (reverseList === 'parents' ? '子' : '父') + '记忆：' + myTitle }))
        tObj.updatedAt = nowIso()
        await writeJson(target.path, tObj)
      }
      // v4：active 引用 → 在智能体活跃文件登记该记忆（挂载）
      const connectActive = async (agentKey) => {
        if (!agentKey) return
        const { obj: act, path: actPath } = await readAgentActive(agentKey)
        act.refs = act.refs || []
        const dup = act.refs.some(r => r.title === myTitle && r.ref === (obj && obj.id))
        if (dup) return
        act.refs.push({ title: myTitle, ref: (obj && obj.id) || myTitle, kind: myLoc, at: nowIso() })
        act.refs = act.refs.slice(-50)
        act.updatedAt = nowIso()
        await writeJson(actPath, act)
      }
      for (const l of children) { if (l && l.kind === 'keyword') await connect(l.title, 'parents') }
      for (const l of parents) {
        if (l && l.kind === 'keyword') await connect(l.title, 'children')
        if (l && l.kind === 'active' && l.agent) await connectActive(l.agent)
      }
    } catch (e) {}
  }

  // ── 配置（defaultConfig/cfg 已拆至 ../motion-memory-modules/core.mjs——顶层解构同名引入）
  async function init() {
    let conf = readConfigFile()
    // 一次性迁移：固定位置无配置时，从旧位置读取并合并。
    // 只采纳「记忆文件数 > 0」的已有配置（数据在哪儿就用哪份），全新环境则生成默认
    if (!conf) {
      let best = null, bestScore = 0, bestPath = ''
      for (const old of legacyConfigPaths()) {
        const oldConf = readJsonFileNative(old)
        if (!oldConf) continue
        let score = 0
        const r2 = (oldConf.root && String(oldConf.root).trim()) ? String(oldConf.root).replace(/\\/g, '/').replace(/\/+$/, '') : ''
        if (r2) score = memoryFileCount(r2)
        if (score > bestScore) { best = oldConf; bestScore = score; bestPath = old }
      }
      if (best) { conf = best; console.log('motion-memory: 采用已有配置 ' + bestPath + '（记忆文件 ' + bestScore + ' 个，root=' + (conf.root || '') + '）') }
    }
    if (!conf) { conf = defaultConfig(baseWs()) }
    // 合并默认字段（旧配置缺字段补齐，已有字段保留，不覆盖用户设置）
    const def = defaultConfig(baseWs())
    for (const k of Object.keys(def)) { if (conf[k] === undefined) conf[k] = def[k] }
    // 旧配置迁移：cascadeLinks(bool) → cascadeDepth(int)
    if (conf.cascadeDepth === undefined && conf.cascadeLinks !== undefined) {
      conf.cascadeDepth = conf.cascadeLinks ? 1 : 0
      delete conf.cascadeLinks
    }
    writeConfigFile(conf)
    state.config = conf
    state.root = (conf.root && String(conf.root).trim()) ? String(conf.root).replace(/\\/g, '/').replace(/\/+$/, '') : globalDefaultRoot()
    // 方案B：记录配置 mtime（供热重载检测）
    try {
      const cp = configPath()
      if (existsSync(cp)) state.configMtime = statSync(cp).mtimeMs
    } catch (e) {}
    for (const e of await listFiles(isolationDir(), false)) {
      if (e.name === 'incident.json') continue
      const inc = await readJson(p(e.path, 'incident.json'))
      if (inc && inc.id) state.incidents.set(inc.id, inc)
    }
    // 启动时全量迁移：活跃文件旧版本 → v4（兜底，保证任意存量文件都被转换）
    try {
      const mig = await MemFiles.active.migrateAll()
      if (mig.migrated || mig.failed) {
        console.log('[motion-memory] 活跃文件迁移报告：共 ' + mig.total + ' 个待迁移，成功 ' + mig.migrated + '，失败 ' + mig.failed + (mig.items.length ? '\n  ' + mig.items.join('\n  ') : ''))
        state.activeMigrateReport = mig
      }
    } catch (e) { console.error('[motion-memory] 活跃文件启动迁移失败: ' + (e && e.message)) }
  }
  function ready() { if (!state.readyPromise) state.readyPromise = init().catch(e => { console.error('motion-memory init failed: ' + (e && e.message)); state.readyPromise = null }); return state.readyPromise }

  // ── 配置热重载（方案B）：检测 profile 配置文件 mtime，变化则重载进内存 ──
  // 解决"设置界面改配置不生效于运行中进程"：界面写入 profile 文件后，
  // 下一次任何记忆操作（工具/pre-step/turn-end）前调用本函数即读到新配置。
  // 与 writeConfigFile 的内存写回不冲突：本函数只处理「文件被外部（如 mm-settings UI）改动」。
  async function reloadConfigIfChanged() {
    await ready().catch(() => {})
    try {
      const cp = configPath()
      if (!existsSync(cp)) return
      const mtime = statSync(cp).mtimeMs
      if (mtime === state.configMtime) return // 未变化
      const text = readFileSync(cp, 'utf8').replace(/^\uFEFF/, '')  // 剥 BOM（防御外部工具写入）
      const conf = JSON.parse(text)
      if (!conf || typeof conf !== 'object') return
      // 合并默认字段（与 init 同逻辑）
      const def = defaultConfig(baseWs())
      for (const k of Object.keys(def)) { if (conf[k] === undefined) conf[k] = def[k] }
      if (conf.cascadeDepth === undefined && conf.cascadeLinks !== undefined) {
        conf.cascadeDepth = conf.cascadeLinks ? 1 : 0
        delete conf.cascadeLinks
      }
      const newRoot = (conf.root && String(conf.root).trim()) ? String(conf.root).replace(/\\/g, '/').replace(/\/+$/, '') : globalDefaultRoot()
      state.config = conf
      state.root = newRoot
      state.configMtime = mtime
      console.log('[motion-memory] 配置热重载：' + cp + '（mtime 变化）')
    } catch (e) { console.error('[motion-memory] 配置热重载失败: ' + (e && e.message)) }
  }

  // ── 记忆根固定（不再随工作区/会话迁移；root 只由固定 config 决定）────────
  async function maybeMigrate() {
    if (state.migrated) return
    await ready().catch(() => {})
    state.migrated = true
  }

  // ── 记录模型 ───────────────────────────────────────────────────────────
  // 轻量整理/摘要/增强调用：统一使用管理员模型（recordModel 已移除）
  async function recordModelText(promptText) {
    const mc = resolveModelConfig()
    if (!llm || !mc.provider || !mc.model) return null
    try {
      let text = ''
      const messages = [{ id: 'mm-1', role: 'user', content: [{ type: 'text', text: promptText }], source: { kind: 'plugin', plugin: 'motion-memory' } }]
      const outCap = Math.max(256, Number(mc.outputTokens) || 1024)
      const streamOpts = { provider: mc.provider, model: mc.model, messages, maxTokens: outCap }
      if (mc.extraJson && typeof mc.extraJson === 'object') {
        try { Object.assign(streamOpts, JSON.parse(JSON.stringify(mc.extraJson))) } catch (e) {}
      }
      for await (const chunk of llm.stream(streamOpts)) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') text += chunk.block.text
      }
      return text.trim() || null
    } catch (e) { return null }
  }
  function parseModelJson(text) {
    if (!text) return null
    let t = String(text).trim()
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    try { const o = JSON.parse(t); if (o && typeof o === 'object') return o } catch (e) {}
    const m = t.match(/\{\s*"title"\s*:\s*"([\s\S]*?)"\s*,\s*"content"\s*:\s*"([\s\S]*?)"\s*(,\s*"reason"\s*:\s*"([\s\S]*?)")?\s*\}/)
    if (m) return { title: m[1], content: m[2], reason: m[3] }
    return null
  }

  // ── 查询日志 ───────────────────────────────────────────────────────────
  async function logQuery(session, keyword, opened) {
    const ql = (await readJson(queryLogPath())) || { entries: [] }
    ql.entries.unshift({ at: nowIso(), session: session || '', keyword: keyword || '', opened: opened || null })
    ql.entries = ql.entries.slice(0, 50)
    await writeJson(queryLogPath(), ql)
  }
  async function recentQueries(n) {
    const ql = (await readJson(queryLogPath())) || { entries: [] }
    return ql.entries.slice(0, Math.max(1, n || 5))
  }

  // ── 自动归档（读取时惰性检查）──────────────────────────────────────────
  async function maybeArchive(entry) {
    if (entry.zone !== 'important') return null
    const c = cfg()
    const days = Math.max(1, c.archiveDays || 30)
    const last = parseIso(entry.obj.lastAccessedAt) || parseIso(entry.obj.createdAt)
    if (Date.now() - last <= days * 86400000) return null
    // v4 #4：长期未访问 → 标记展开拒绝（防过度展开；已被引用但不再展开）
    entry.obj.expandRefused = true
    const dst = p(archiveDirFor(new Date(last)), fileNameOf(entry.path))
    entry.obj.location = 'archive'
    entry.obj.history.push(histEntry('move', { note: '自动归档：超过' + days + '日未访问（已设展开拒绝）', fromPath: relOf(entry.path), toPath: relOf(dst) }))
    entry.obj.updatedAt = nowIso()
    await writeJson(dst, entry.obj)
    await tombstone(entry.path, dst)
    return dst
  }

  // ── 当前活跃/轮次（已拆至 ../motion-memory-modules/active.mjs——createActive(core,{readTurnUserText,adminCfg}) 工厂解构引入）──

  ctx.on('session/event', (session, event) => {
    if (!session || !event) return
    const sid = session.id
    if (!sid) return
    state.eventDelivered = true
    state.lastSid = sid
    setSessionCwd(sessionCwdOf(session))
    // SessionEvent 信封为 { type, seq, time, data }，轮次号在 event.data.turn
    const d = (event && event.data) || {}
    if (event.type === 'turn/start') {
      state.currentTurn.set(sid, d.turn || 0)
    } else if (event.type === 'turn/end') {
      state.turnEvents++
      state.currentTurn.set(sid, d.turn || 0)
      reloadConfigIfChanged().catch(() => {})  // 方案B：turn/end 前热重载配置
      // 解析 ownerKey（preset:cordis）——turn/end 路径补上，避免指针 ownerKey 退化成语 id
      let ownerKey = ''
      try {
        const preset = sessionPresetOf(session)
        if (preset) ownerKey = 'preset:' + preset
      } catch (e) {}
      maybeMigrate().then(() => writeActive(sid, d.turn || 0, Object.assign({ summarize: false }, ownerKey ? { ownerKey } : {}))).catch(() => {})
    }
  })
  ctx.on('agent/request', (payload, next) => {
    const a = payload && payload.agent
    const aid = a && (a.id || (a.session && a.session.id))
    if (aid) {
      state.requestEvents++
      setSessionCwd(cwdOf(a, aid))
      maybeMigrate().catch(() => {})
      state.currentTurn.set(aid, payload.turn || 0)
    }
    return next()
  })

  // ── 记忆总览注入（首轮一次性 + digest 去重；不做每轮检查）──────────────
  // 机制：agent/pre-step 时对比「会话历史中最后可见的总览消息」与「当前记忆
  // 状态」的 sha256 digest —— 首次会话注入一条持久 user 消息；此后记忆无变化
  // 则绝不再发（agent 按需调用 memory_query 查看）；必要记忆、
  // 重要记忆、最近事件或隔离事件变化时才替换。不再注册 systemPrompt.section
  // （那是每轮现算注入）。session/event 与 agent/request 监听保留用于状态维护，
  // 为后续 agent 自动总结整理记忆功能预留事件通道。
  function activeIncident() {
    for (const inc of state.incidents.values()) {
      if (!inc.restoredAt && !inc.clearedAt) return inc
    }
    return null
  }

  // 总览条目：参与 digest 的最小纯 JSON 数据
  async function overviewEntries(sid, ownerKey) {
    // 懒归档：挪入空闲队列（scheduleWork），不在查询/总览路径同步全扫；
    // 扫描顺序固定"先未压缩（重要+无模型）"，补充/周期等已压缩区不做全量扫描
    try { scheduleWork('archive', () => lazyArchive(), '懒归档扫描').catch(() => {}) } catch (e) {}
    // 必要记忆（agent.md 语义）：智能体活跃 custom，随总览注入；为空不注入
    let nec = null
    try {
      const act = await readAgentActive(ownerKey || sid || '')
      if (act && act.obj && String(act.obj.custom || '').trim()) nec = { content: String(act.obj.custom) }
    } catch (e) {}
    // 重要记忆标题不再注入（v6：改为当前活跃关键词指针 + 按需 memory_query open 挂载本体）
    const importantTop = []
    // 最近会话工作：各智能体活跃文件 works 的最近工作段摘要（条数用 recentOverviewN 设定）
    const recentWorks = []
    try {
      const files = await listFiles(activeDir(), false)
      for (const f of files) {
        if (f.name === 'active.json' || !f.name.endsWith('.json')) continue
        const o = await readJson(f.path)
        if (!o || isTombstone(o)) continue
        const works = Array.isArray(o.works) ? o.works : []
        for (const w of works) {
          if (!w || !String(w.text || '').trim()) continue
          recentWorks.push({ sid: w.sid || '', text: String(w.text || '').slice(0, 120), updatedAt: w.updatedAt || o.updatedAt || '' })
        }
      }
    } catch (e) {}
    recentWorks.sort((a, b) => parseIso(b.updatedAt) - parseIso(a.updatedAt))
    const worksTop = recentWorks.slice(0, Math.max(1, Number(cfg().recentOverviewN) || 3))
    // 本智能体活跃关键词（注入给模型：当前活跃主题词，随总览自动载入）
    let keywords = []
    let blankWorks = []
    try {
      const act = await readAgentActive(ownerKey || sid || '')
      if (act && act.obj) {
        if (Array.isArray(act.obj.keywords)) keywords = act.obj.keywords.slice(0, 50)  // 指针全量（安全上限 50，维护规则控制实际数量）
        // 空白工作段检测：程序已建段但尚无内容（模型总结失败/无模型待转正）→ 提醒需要总结
        if (Array.isArray(act.obj.works)) {
          blankWorks = act.obj.works
            .filter(w => w && w.sid && w.sid !== sid && !(w.text && String(w.text).trim()))
            .map(w => String(w.sid).slice(-8))
        }
      }
    } catch (e) {}
    const inc = activeIncident()
    return {
      necessary: (nec && nec.content) || '',
      important: importantTop,
      recentWorks: worksTop,
      keywords,
      blankWorks,
      incident: inc ? { id: inc.id, at: inc.at, targetTime: inc.targetTime, files: (inc.files || []).length } : null,
    }
  }

  function overviewDigest(entries) {
    // digest 只含低频变化内容：必要记忆 + 重要记忆标题 + 活跃关键词 + 隔离状态。
    // 最近会话工作不参与 digest——工作段频繁变化（对话跟踪等），若计入会导致
    // 每有新记录就重注入总览。需要最新记录时 agent 自行调 memory_query。
    const canonical = JSON.stringify({
      necessary: entries.necessary,
      important: entries.important,
      keywords: entries.keywords || [],
      incidentId: entries.incident ? entries.incident.id : null,
    })
    return createHash('sha256').update(canonical).digest('hex')
  }

  function renderOverview(entries) {
    const trackOn = !!(cfg().admin && cfg().admin.track)
    const lines = [
      '<system-reminder>',
      '运动记忆·会话总览（仅当记忆变化时更新；需要细节时用 memory_query 查看）：',
    ]
    if (entries.necessary) lines.push('必要记忆：' + entries.necessary)
    if (entries.keywords && entries.keywords.length) lines.push('当前活跃关键词：' + entries.keywords.join('、'))
    // 待总结提醒：区分对话跟踪状态——未开启：大段工作完成后自行总结；已开启：跟踪自动总结，不需全部自行总结
    if (!trackOn) {
      lines.push('⚠ 本会话未开启对话跟踪：大段工作完成后请自行总结记录——把总结写入当前会话工作（works）；若该会话尚无对应的事件记忆，同时创建事件记忆记录同样的轮次总结。')
    } else {
      lines.push('本会话已开启对话跟踪：轮次总结由跟踪自动处理，不需要全部都自行总结；用户明确要求时仍可总结记录记忆。')
    }
    if (entries.blankWorks && entries.blankWorks.length) lines.push('⚠ 待总结提醒：会话 ' + entries.blankWorks.join('、') + ' 的工作段仍为空白（模型总结未成功或等待转正），需要总结补全。')
    if (entries.recentWorks && entries.recentWorks.length) {
      lines.push('最近会话工作：' + entries.recentWorks.map(w => (w.sid ? '[' + String(w.sid).slice(-8) + '] ' : '') + w.text).join('；'))
    }
    // 隔离通知并入必要记忆区显示
    if (entries.incident) {
      lines.push('必要记忆·隔离通知：事件 ' + entries.incident.id + ' 于 ' + entries.incident.at + ' 触发，目标时间 ' + entries.incident.targetTime + '，涉及 ' + entries.incident.files + ' 个文件。可调用 memory（cmd=isolation_restore，回滚）或 memory（cmd=isolation_clear，解除）。')
    }
    // 使用指引（行为引导，解决"调用频率低"）：
    lines.push('记忆使用约定：')
    lines.push('- 对话中出现 关键决策/用户偏好/项目事实/踩坑教训 → memory_add 记录')
    lines.push('- 任务涉及以往工作、用户提及"上次/之前" → 先 memory_query 查相关记忆')
    lines.push('- 用户反复强调的内容（"记住/以后都这样"） → memory_add（kind=necessary）写入必要记忆')
    lines.push('- 达成阶段性成果/重要经验 → memory_add（kind=event）沉淀事件；需要时 memory（cmd=notify）查看变更通知')
    lines.push('</system-reminder>')
    return createUserMessage({
      content: [{ type: 'text', text: lines.join('\n') }],
      source: {
        kind: 'motion-memory-overview',
        form: 'catalog',
        entries: {
          necessary: entries.necessary,
          important: entries.important,
          recent: [],
          keywords: entries.keywords || [],
          incidentId: entries.incident ? entries.incident.id : null,
        },
      },
    })
  }

  function readOverview(source) {
    if (!source || source.kind !== 'motion-memory-overview') return undefined
    const e = source.entries
    if (!e || typeof e !== 'object') return undefined
    if (typeof e.necessary !== 'string' || !Array.isArray(e.important) || !Array.isArray(e.recent)) return undefined
    for (const t of e.important) if (!t || typeof t.title !== 'string') return undefined
    return {
      necessary: e.necessary,
      important: e.important,
      recent: e.recent,
      keywords: Array.isArray(e.keywords) ? e.keywords.map(String) : [],
      incidentId: typeof e.incidentId === 'string' ? e.incidentId : null,
    }
  }

  function overviewDigestOfSource(source) {
    const e = readOverview(source)
    if (!e) return undefined
    return overviewDigest({
      necessary: e.necessary,
      important: e.important,
      keywords: e.keywords,
      incident: e.incidentId ? { id: e.incidentId } : null,
    })
  }

  function overviewHistory(agent) {
    try {
      const visible = new Set(agent.session.surface.nodes)
      const events = agent.session.events
      let published = false
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]
        const src = ev && ev.data && ev.data.source
        if (ev.type !== 'user/message' || !src || src.kind !== 'motion-memory-overview') continue
        const digest = overviewDigestOfSource(src)
        if (digest === undefined) continue
        published = true
        if (visible.has(ev.seq)) return { visibleDigest: digest, published }
      }
      return { published }
    } catch (e) {
      return { published: false }
    }
  }

  function overviewMessage(messages) {
    for (const m of messages) {
      const digest = overviewDigestOfSource(m.source)
      if (digest !== undefined) return { message: m, digest }
    }
    return undefined
  }

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      const sid = agent && (agent.id || (agent.session && agent.session.id))
      if (!sid) return decision
      setSessionCwd(cwdOf(agent, sid))
      await ready().catch(() => {})
      await reloadConfigIfChanged().catch(() => {})  // 方案B：pre-step 前热重载配置
      maybeMigrate().catch(() => {})
      signal.throwIfAborted()
      // 只注入一次：本会话已发布过总览 → 永不再注入。
      // 后续有需求由 agent 自行调用 memory_query / memory（cmd=recall_past / recent）。
      const history = overviewHistory(agent)
      if (history.published) return decision
      const existing = overviewMessage(decision.messages)
      if (existing !== undefined) return decision
      const ownerKey = (await ownerKeyOfAsync(sid)) || ownerKeyOf(agent)
      // 子会话/无智能体归属：不注入记忆总览（省 token；需要时自行调 memory_query）
      if (!ownerKey) return decision
      if (ownerKey) await mergeLegacyOwners(ownerKey).catch(() => {})
      const entries = await overviewEntries(sid, ownerKey || sid)
      // 无记忆也注入（携带使用指引，引导新会话产生记忆）——空总览不再是噪音
      const overview = renderOverview(entries)
      return {
        kind: 'enter',
        messages: [...decision.messages, overview],
      }
    } catch (e) {
      return decision
    }
  })
  // 阶段3：变更 diff 注入。仅 active.json 更新触发（state.lastActiveDiff 由 touchActive 记录）：
  // 变更 diff 入队（v4：队列防覆盖；注入失败/本轮未注入 → 下轮重试）
  function pushDiff(diff) {
    if (!diff) return
    state.diffQueue = state.diffQueue || []
    state.diffQueue.push(diff)
    state.diffQueue = state.diffQueue.slice(-50)  // 上限防膨胀（每轮清空，正常不会积累）
  }
  // - 本会话自己触发的变更不注入（避免自反馈噪音）
  // - 该会话 memory_notify off 时不注入
  // - 一次性合并队列全部注入，注入后清空（等待下轮输出→清空）
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      state.diffQueue = state.diffQueue || []
      // 过滤掉本会话自己触发的（出队丢弃），其余合并
      const sid = agent && (agent.id || (agent.session && agent.session.id))
      if (!sid || state.notifyOff.has(sid)) return decision
      if (cfg().activeNotify === false) return decision
      const own = state.diffQueue.filter(d => d.session === sid && d.ownerKey && d.ownerKey === ownerKeyOf(agent) && !d.track)
      if (own.length) state.diffQueue = state.diffQueue.filter(d => !own.includes(d))  // 自己触发的丢弃（对话跟踪 track 例外，保留注入）
      const pendings = state.diffQueue.filter(d => d && d.added && d.added.some(a => a.kind === 'summary'))
      if (!pendings.length) return decision
      const lines = ['<system-reminder>', '运动记忆·当前活跃更新：']
      for (const diff of pendings) {
        const srcLabel = (diff.session === sid) ? '本会话' : '会话' + String(diff.session || '').slice(-8)
        for (const a of diff.added) {
          if (a.kind === 'summary') lines.push('· ' + srcLabel + '@轮次' + (diff.turn || '?') + ' 摘要：' + (a.title || ''))
        }
      }
      lines.push('</system-reminder>')
      state.diffQueue = []  // 一次性输出后清空
      const note = createUserMessage({
        content: [{ type: 'text', text: lines.join('\n') }],
        source: { kind: 'motion-memory-diff', at: nowIso() },
      })
      return {
        kind: 'enter',
        messages: [...decision.messages, note],
      }
    } catch (e) {
      return decision
    }
  })
  // memory_notify：会话级变更注入开关（默认开；off 后本会话停止接收 diff 注入，查询/写入不受影响）
  async function memCmdNotify(args, meta) {
    const sid = (meta && meta.session) || ''
    if (args.action === 'off') { state.notifyOff.add(sid); return { ok: true, text: '已关闭本会话的记忆变更注入通知（可 memory cmd=notify action=on 恢复）' } }
    if (args.action === 'on') { state.notifyOff.delete(sid); return { ok: true, text: '已开启本会话的记忆变更注入通知' } }
    return { ok: true, text: state.notifyOff.has(sid) ? '本会话变更通知：关闭' : '本会话变更通知：开启' }
  }
  // 记忆综合入口（低频/管理员/隔离/手动）
  tool('memory', '运动记忆·综合入口：status=状态；config=配置读写；notify=变更通知开关；recent=最近活动；history=历史记录；recall_past=往时回忆；restore=捡回；track_run=对话跟踪手动；period_run=周期手动（普通会话触发需用户确认）；period_status=周期状态；enhance=查询强化；admin_view=查看失败记录；admin_summarize=管理员压缩；isolation=隔离；isolation_restore=隔离回滚；isolation_clear=解除隔离。记忆写入后当前活跃的 keywords 会同步整理（移除过时/重复词、加入新主题）。', {
    cmd: { type: 'string', enum: ['status', 'config', 'notify', 'recent', 'history', 'recall_past', 'restore', 'track_run', 'period_run', 'period_status', 'enhance', 'admin_view', 'admin_summarize', 'isolation', 'isolation_restore', 'isolation_clear', 'update'], description: '子命令' },
    action: { type: 'string', description: 'cmd=notify: on/off/status' },
    title: { type: 'string', description: 'cmd=history/restore 等：标题' },
    keyword: { type: 'string', description: '通用关键词/查询词' },
    page: { type: 'integer', description: '页码' },
    pageSize: { type: 'integer', description: '分页条数' },
    months: { type: 'integer', description: 'cmd=recall_past：往前月数' },
    days: { type: 'integer', description: 'cmd=recall_past：往前天数' },
    id: { type: 'string', description: 'cmd=isolation_restore/clear：隔离事件 id' },
    turn: { type: 'integer', description: 'cmd=track_run/admin_summarize：轮次' },
    sessionId: { type: 'string', description: '目标会话 id' },
    query: { type: 'string', description: 'cmd=enhance：原始查询词' },
    detail: { type: 'boolean', description: 'cmd=status/admin_view：更多详情' },
    // cmd=period_run 参数：周期总结手动触发（普通会话触发会弹用户确认；管理员/界面/定时无闸门）
    scope: { type: 'integer', description: 'cmd=period_run：素材广度 1/2/3（1=仅事件+无模型记忆；2=+会话首尾；3=+全量轮次）' },
    scopeDetail: { type: 'string', description: 'cmd=period_run：素材档位细节（infer / infer-full / infer-tail）' },
    useSessionModel: { type: 'boolean', description: 'cmd=period_run：true=用当前会话主力模型执行（默认用周期独立模型，空则管理员模型）' },
    from: { type: 'integer', description: 'cmd=period_run：起始时间戳（历史重总结）' },
    to: { type: 'integer', description: 'cmd=period_run：结束时间戳（历史重总结）' },
    ignoreSummarized: { type: 'boolean', description: 'cmd=period_run：忽略已总结标记，强制重新处理' },
    truncK: { type: 'integer', description: 'cmd=period_run：省 token 截断量（k）' },
    resetTimer: { type: 'boolean', description: 'cmd=period_run：true=只重置定时倒计时、不执行总结' },
  }, ['cmd'], async (args, meta) => {
    switch (args.cmd) {
      case 'notify': return memCmdNotify(args, meta)
      case 'status': return memCmdStatus(args, meta)
      case 'config': return memCmdConfig(args, meta)
      case 'recall_past': return memCmdRecallPast(args, meta)
      case 'restore': return memCmdRestore(args, meta)
      case 'history': return memCmdHistory(args, meta)
      case 'recent': return memCmdRecent(args, meta)
      case 'enhance': return memCmdEnhance(args, meta)
      case 'admin_view': return memCmdAdminView(args, meta)
      case 'admin_summarize': return memCmdAdminSummarize(args, meta)
      case 'track_run': return memCmdTrackRun(args, meta)
      case 'period_run': return memCmdPeriodRun(args, meta)
      case 'period_status': return memCmdPeriodStatus(args, meta)
      case 'isolation': return memCmdIsolation(args, meta)
      case 'isolation_restore': return memCmdIsolationRestore(args, meta)
      case 'isolation_clear': return memCmdIsolationClear(args, meta)
      case 'update': return memCmdUpdate(args, meta)
      default: return { ok: false, text: '（memory cmd=' + args.cmd + ' 待迁移）' }
    }
  })
  // memory_noop 不再注册为会话工具：它是内部组装提示词的降级通道契约
  // （管理员 LLM 输出 {"tool":"memory_noop"} 表示无更新，见 parseToolFormatOutput / 降级执行），
  // 不暴露给会话模型直接调用；会话内"无更新"通过管理员 JSON 契约 compress=false 表达。

  // ── 工具注册 ───────────────────────────────────────────────────────────
  function tool(name, description, properties, required, run) {
    const def = defineTool({
      name, 
      description,
      parameters: properties,  // 直接使用 properties，不需要额外包装
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, text: { type: 'string' }, data: { type: 'json' } } },
        render: (args, value) => [{ type: 'text', text: (value && typeof value.text === 'string') ? value.text : JSON.stringify(value) }],
      },
      async execute(args, exec) {
        await ready().catch(() => {})
        await reloadConfigIfChanged().catch(() => {})  // 方案B：工具调用前热重载配置
        const agent = exec && exec.agent
        const session = (agent && (agent.id || (agent.session && agent.session.id))) || ''
        setSessionCwd(cwdOf(agent, session))
        maybeMigrate().catch(() => {})
        const turn = (session && state.currentTurn.get(session)) || 0
        // agent 是 Cordis 代理对象：直接存入记忆 JSON 会在 stringify 时触发
        // "cannot get property toJSON without inject"，这里只取可序列化的 id 字符串。
        // 归属键：preset:<agentPreset>（同一智能体跨会话共享记忆）；无 preset 回退会话 id
        let agentId = ''
        try {
          if (agent) agentId = (await ownerKeyOfAsync(session)) || ownerKeyOf(agent) || String(agent.id || (agent.session && agent.session.id) || '')
        } catch (e) {}
        // v4 #5：注入模型溯源（模型功能=当前工具名，模型名称=会话默认模型）
        let modelProvider = '', modelName = ''
        try {
          const adm = ctx.get('agentDefaultModel')
          if (adm) {
            const sel = adm.currentSelection && adm.currentSelection()
            if (sel) { modelProvider = String(sel.provider || ''); modelName = String(sel.model || '') }
          }
        } catch (e) {}
        // 调用定位（v5）：从 agent 内存事件流取当前 turn 的最后 step，供历史记录溯源
        let step = 0
        try {
          const evs = agent && agent.session && agent.session.events
          if (Array.isArray(evs)) {
            for (let i = evs.length - 1; i >= 0; i--) {
              const e = evs[i]
              const d = e && e.data
              if (e.type === 'step/start' && d && d.turn === turn) { step = Number(d.step) || 0; break }
            }
          }
        } catch (e) {}
        try {
          if (agentId.indexOf('preset:') === 0) await mergeLegacyOwners(agentId).catch(() => {})
          return await run(args || {}, { session, turn, step, agent: agentId, _execAgent: agent, modelProvider, modelName, toolContext: name })
        }
        catch (e) { return { ok: false, text: '运动记忆错误: ' + (e && e.message || String(e)) } }
      },
    })
    tools.register(def)
  }
  // ── 查询增强（批4）：拦截式深度查询 ─────────────────────────────────────
  // 流程：基础结果 + 设定深度(3)关联展开 + 本轮上下文前N步填充到 summaryPercent 预算
  //      → 有模型则总结合并输出；无模型原样返回；模型报错正常返回+报错信息
  // 1. 查询（普通查询 = 纯文件读取：活跃 + 必要 + 重要/周期关键词 + 最近事件。不调模型）
  // 深度增强（调模型整合）仅 enhance=true 时触发，默认关
  tool('memory_query', '运动记忆·查询/回忆：开工总览（默认：必要+当前活跃+索引+最近事件）；keyword=匹配记忆标题列表；open=阅读指定标题（关联展开+历史记录）；openTurn=读会话轮次原文（会话id@轮次[:step]）；recent=最近事件条数；enhance=true 深度增强。纯文件读取不调模型（enhance 除外）。', {
    keyword: { type: 'string', description: '匹配词：列出重要/周期记忆标题中包含该词（或内容包含）的条目' },
    open: { type: 'string', description: '阅读指定标题的记忆文件（展开关联+历史记录）' },
    openTurn: { type: 'string', description: '读对话轮次原文，格式 会话id@轮次[:stepN]' },
    recent: { type: 'integer', description: '返回最近 n 条事件记忆总览（默认取配置 recentOverviewN）' },
    enhance: { type: 'boolean', description: 'true 时启用深度查询增强（调模型整合关联展开与上下文，较慢）' },
    queryHistory: { type: 'integer', description: 'open 时附带的查询记录条数；-1=5，>=0 用该值，缺省按配置（0=不附带）' },
    updateHistory: { type: 'integer', description: 'open 时附带的增量更新记录条数；-1=5，>=0 用该值，缺省按配置（0=不附带）' },
    expandDepth: { type: 'integer', description: 'open 时关联展开层数：-1=按配置，0=不展开，n=n 层' },
    ownerKey: { type: 'string', description: '查询智能体范围：空=本智能体；preset:xxx=指定智能体；all=所有智能体' },
    agents: { type: 'boolean', description: 'true 时列出智能体记忆概览（有哪些智能体、各自记忆量），不执行普通查询' },
  }, [], memCmdQuery)
  // 5. 记忆写入（统一入口）：kind=keyword 重要关键词（同名返回已有）；necessary 必要记忆；event 事件；update 更新；forget 遗忘
  tool('memory_add', '运动记忆·写入：kind=keyword（默认）创建重要关键词记忆——先查同名与近似标题：精确同名返回已有内容（同一实体信息变化→kind=update 更新；不同实体→用更具体标题新建并自动关联既有记忆），近似候选一并列出供判断消歧；kind=necessary 写入本智能体必要记忆（agent.md 语义，写入当前活跃 custom，随总览注入）；kind=event 创建事件记忆（日期目录，直接写入；带会话@轮次自动并入会话聚合记忆）；kind=update 更新已有关键词记忆（diff+mergeDated 自动合并时间变体+forgetIndexes）；kind=edit 按用户明确确认修改任意记忆文件（默认只读保护，必须 force=true）；kind=forget 主动遗忘移入补充。规则：①重要内容先落关键词（kind=keyword），默认自动挂载到当前活跃 keywords 成为指针（方便其他窗口按指针查询），无无缘无故的指向——引用必须真实溯源；②创建/更新关键词时同步维护当前活跃 keywords：对照近期会话工作（works）主题，移除与当前会话无关的过时词，保持关键词与近期工作相关有效（移除时说明理由）；③关键词数量不设硬上限，靠相关性维护约束。', {
    kind: { type: 'string', enum: ['keyword', 'event', 'necessary', 'update', 'edit', 'forget'], description: '写入类型（默认 keyword）' },
    title: { type: 'string', description: '标题（keyword/event/update/edit/forget 用）' },
    content: { type: 'string', description: '内容（keyword/necessary/update/edit 用）' },
    material: { type: 'string', description: '素材（kind=event 用，直接写入）' },
    reason: { type: 'string', description: '记忆理由' },
    force: { type: 'boolean', description: 'kind=edit 时必传：仅当用户明确要求修改该记忆（含事件/周期等只读文件）时才传 true' },
    links: { type: 'object', additionalProperties: true, description: '可选关联引用（keyword/event 用）' },
    clear: { type: 'boolean', description: 'kind=necessary 时 true=清空必要记忆' },
    append: { type: 'boolean', description: 'kind=update 时末尾追加' },
    mergeDated: { type: 'boolean', description: 'kind=update 时合并日期变体' },
    forgetIndexes: { type: 'array', items: { type: 'integer' }, description: 'kind=update 遗忘更新历史索引' },
  }, [], memCmdAdd)
  // 8. 捡回

  // ── 隔离（已拆至 ../motion-memory-modules/isolation.mjs——createIsolation(core) 工厂解构引入）──

  // 14. 状态
  async function memCmdStatus(args, meta) {
    const c = cfg()
    const lines = ['【运动记忆配置】', '根目录：' + root() + '（配置固定 ' + configPath() + '）', '会话工作区：' + (state.sessionCwd || '（未捕获）') + (state.migrated ? '（已固定）' : '（初始化中）'), '智能体归属键：' + (meta.agent || '（无，回退会话隔离）') + ' · queryOtherAgents=' + !!cfg().queryOtherAgents, '事件计数：请求 ' + state.requestEvents + ' · 轮次结束 ' + state.turnEvents + (state.eventDelivered ? ' · session/event 已送达' : ' · session/event 未送达'), '总览注入：' + (c.inject ? '每会话仅一次' : '关闭（' + (c.injectLimitBytes || 4096) + ' 字节上限）'), '管理员模型：' + ((c.admin && c.admin.model && c.admin.model.provider) ? c.admin.model.provider + ' / ' + c.admin.model.model : '未配置（无模型降级）'), '归档天数：' + (c.archiveDays || 30), '最近总览 n：' + (c.recentOverviewN || 3), '关联记忆展开：' + (c.cascadeDepth === undefined ? 1 : c.cascadeDepth) + ' 层', '查询/增量历史条数：' + (c.queryHistoryN || 0) + '/' + (c.updateHistoryN || 0) + '（0=不附带）']
    const sOwner = scopeOwner(meta)
    const important = (await scanDir(importantDir(), false, sOwner)).length
    const archive = (await scanDir(archiveBaseDir(), true, sOwner)).length
    const events = (await listFiles(dailyBaseDir(), true)).filter(f => isEventRel(relOf(f.path))).length
    lines.push('【存储统计】重要 ' + important + ' 条，补充 ' + archive + ' 条，事件 ' + events + ' 条' + (sOwner ? '（本智能体视角；queryOtherAgents=' + !!cfg().queryOtherAgents + '）' : '（全量视角）'))
    const incs = [...state.incidents.values()]
    lines.push('【隔离事件】' + (incs.length ? incs.map(i => i.id + '（目标 ' + i.targetTime + (i.restoredAt ? '，已回滚' : i.clearedAt ? '，已解除' : '，待处理') + '，' + (i.files || []).length + ' 文件）').join('；') : '（无）'))
    const adm = c.admin || {}
    const admModel = (adm.model && adm.model.provider && adm.model.model) ? adm.model.provider + ' / ' + adm.model.model : '（未配置）'
    lines.push('【记忆管理员】' + (adm.enabled ? '已启用' : '关闭') + '：模型 ' + admModel + '，上下文 ' + (adm.contextTokens || 128000) + ' × ' + (adm.summaryPercent || 50) + '%（约 ' + Math.floor((adm.contextTokens || 128000) * (adm.summaryPercent || 50) / 100) + ' tokens），并发 ' + (adm.concurrency || 0) + '，单文件 ' + (adm.singleFileTokens || 2048) + ' tokens，深度 ' + (adm.recallDepth || 1) + (adm.dailyBudget ? '，日预算 ' + adm.dailyBudget : '，日预算不限'))
    if (args.detail) {
      const q = await recentQueries(10)
      lines.push('【最近查询】' + (q.length ? q.map(x => x.at + ' ' + (x.keyword || x.opened || '-')).join('；') : '（无）'))
    }
    return { ok: true, text: lines.join('\n'), data: { root: root(), important, archive, events, incidents: incs.map(i => i.id) } }
  }

  // 15. 配置读写（固化版接管设置页职责）
  async function memCmdConfig(args, meta) {
    await ready().catch(() => {})
    const c = cfg()
    let changed = false
    const patch = (args && args.patch) || {}
    const keys = ['enabled', 'inject', 'injectLimitBytes', 'root', 'recentOverviewN', 'cascadeDepth', 'archiveDays', 'queryHistoryN', 'updateHistoryN', 'historyPageSize', 'queryOtherAgents', 'decayDays', 'activeNotify', 'activeNoModelSummarize', 'summaryInjectChars', 'summaryCharsK', 'autoUpdateCheck']
    for (const k of keys) { if (patch[k] !== undefined && patch[k] !== c[k]) { c[k] = patch[k]; changed = true } }
    // indexScore（活跃索引 score 参数）子对象
    if (patch.indexScore && typeof patch.indexScore === 'object') {
      c.indexScore = c.indexScore || {}
      for (const k of ['period', 'event', 'keyword', 'floor', 'threshold', 'maxRefs', 'scanMonths']) {
        if (patch.indexScore[k] !== undefined && patch.indexScore[k] !== c.indexScore[k]) { c.indexScore[k] = patch.indexScore[k]; changed = true }
      }
    }
    // dedupJudge（LLM 写入消歧）子对象
    if (patch.dedupJudge && typeof patch.dedupJudge === 'object') {
      c.dedupJudge = c.dedupJudge || {}
      const d = c.dedupJudge
      const pd = patch.dedupJudge
      if (pd.enabled !== undefined && pd.enabled !== d.enabled) { d.enabled = !!pd.enabled; changed = true }
      if (pd.topCandidates !== undefined && pd.topCandidates !== d.topCandidates) { d.topCandidates = Number(pd.topCandidates); changed = true }
      if (pd.model && typeof pd.model === 'object') {
        d.model = d.model || { provider: '', model: '' }
        if (pd.model.provider !== undefined && pd.model.provider !== d.model.provider) { d.model.provider = String(pd.model.provider); changed = true }
        if (pd.model.model !== undefined && pd.model.model !== d.model.model) { d.model.model = String(pd.model.model); changed = true }
      }
    }
    // semanticSearch（语义检索）子对象
    if (patch.semanticSearch && typeof patch.semanticSearch === 'object') {
      c.semanticSearch = c.semanticSearch || {}
      const s = c.semanticSearch
      const ps = patch.semanticSearch
      for (const k of ['enabled', 'provider', 'model', 'topK', 'threshold', 'weight', 'indexEvents']) {
        if (ps[k] !== undefined && ps[k] !== s[k]) { s[k] = ps[k]; changed = true }
      }
    }
    if (patch.root !== undefined && patch.root !== c.root) c.rootUserSet = true
    if (patch.recordModel && typeof patch.recordModel === 'object') {
      c.recordModel = c.recordModel || { provider: '', model: '' }
      if (patch.recordModel.provider !== undefined && patch.recordModel.provider !== c.recordModel.provider) { c.recordModel.provider = String(patch.recordModel.provider); changed = true }
      if (patch.recordModel.model !== undefined && patch.recordModel.model !== c.recordModel.model) { c.recordModel.model = String(patch.recordModel.model); changed = true }
    }
    // admin（记忆管理员）字段：模型指定后 enabled 自动置 true；清空 provider/model 视为关闭
    if (patch.admin && typeof patch.admin === 'object') {
      c.admin = c.admin || {}
      const a = c.admin
      const pa = patch.admin
      const aKeys = ['enabled', 'contextTokens', 'summaryPercent', 'concurrency', 'singleFileTokens', 'recallDepth', 'outputTokens', 'dailyBudget']
      for (const k of aKeys) { if (pa[k] !== undefined && pa[k] !== a[k]) { a[k] = pa[k]; changed = true } }
      if (pa.extraJson !== undefined) { a.extraJson = pa.extraJson; changed = true }
      if (pa.model && typeof pa.model === 'object') {
        a.model = a.model || { provider: '', model: '' }
        if (pa.model.provider !== undefined && pa.model.provider !== a.model.provider) { a.model.provider = String(pa.model.provider); changed = true }
        if (pa.model.model !== undefined && pa.model.model !== a.model.model) { a.model.model = String(pa.model.model); changed = true }
      }
      if (Array.isArray(pa.langTokens)) { a.langTokens = pa.langTokens; changed = true }
      // 子模式配置：track（对话跟踪）/ period（定时周期）/ enhance（强化）
      const subKeys = ['track', 'period', 'enhance']
      for (const sk of subKeys) {
        if (pa[sk] && typeof pa[sk] === 'object') {
          a[sk] = a[sk] || {}
          for (const k of Object.keys(pa[sk])) {
            if (pa[sk][k] !== undefined && pa[sk][k] !== a[sk][k]) { a[sk][k] = pa[sk][k]; changed = true }
          }
        }
      }
      // 模型指定则启用，模型清空则关闭
      const hasModel = !!(a.model && a.model.provider && a.model.model)
      if (hasModel !== !!a.enabled) { a.enabled = hasModel; changed = true }
    }
    if (changed) {
      writeConfigFile(c)
      state.root = (c.root && String(c.root).trim()) ? String(c.root).replace(/\\/g, '/').replace(/\/+$/, '') : globalDefaultRoot()
    }
    return { ok: true, text: changed ? '配置已更新' : '当前配置', data: c }
  }


  // ── 版本与更新（已拆至 ../motion-memory-modules/update.mjs——createUpdate(core,{execFileCb,createHash}) 工厂解构引入）──

  // ═════════════════════════════════════════════════════════════════════
  // 配置界面 RPC（host 半，供 settings.section client 页面调用）
  // ═════════════════════════════════════════════════════════════════════
  // 注意：本地文件插件无独立 client 半；此 RPC 由动态插件 client 或
  // 后续固化的 client 文件通过 host.call 调用（Package-private 通道）。
  const harnessApi = ctx.get('harness')
  if (harnessApi) {
    // 读完整配置（含 admin 全部字段，未配置时给默认值）
    // 版本与更新（界面按钮：检查 / 执行更新）；check 优先返回自动检查缓存，force=true 强制重新 fetch
    harnessApi.handle('motion-memory/update-check', async (args) => {
      await ready().catch(() => {})
      const force = !!(args && args.force)
      if (!force && state.lastUpdateCheck) return state.lastUpdateCheck
      return autoUpdateCheck()
    })
    harnessApi.handle('motion-memory/update', async () => {
      await ready().catch(() => {})
      return applyUpdate()
    })
    harnessApi.handle('motion-memory/config', async () => {
      await ready().catch(() => {})
      const c = cfg()
      const adm = c.admin || {}
      return {
        config: {
          enabled: !!c.enabled,
          inject: !!c.inject,
          injectLimitBytes: c.injectLimitBytes || 4096,
          root: c.root || '',
          recentOverviewN: c.recentOverviewN || 3,
          archiveDays: c.archiveDays || 30,
          cascadeDepth: c.cascadeDepth === undefined ? 1 : c.cascadeDepth,
          queryHistoryN: c.queryHistoryN || 0,
          updateHistoryN: c.updateHistoryN || 0,
          historyPageSize: c.historyPageSize || 20,
          summaryInjectChars: c.summaryInjectChars || 300,
          summaryCharsK: (c.summaryCharsK === undefined || c.summaryCharsK === null) ? 2 : c.summaryCharsK,
          autoUpdateCheck: c.autoUpdateCheck !== false,
          recordModel: { provider: (c.recordModel && c.recordModel.provider) || '', model: (c.recordModel && c.recordModel.model) || '' },
          admin: {
            enabled: !!adm.enabled,
            model: (adm.model && adm.model.provider && adm.model.model) ? adm.model.provider + '/' + adm.model.model : '',
            contextTokens: adm.contextTokens || 128000,
            summaryPercent: adm.summaryPercent || 50,
            langTokens: Array.isArray(adm.langTokens) ? adm.langTokens : [{ lang: '中文', per: 1.5 }, { lang: 'english', per: 4 }],
            concurrency: adm.concurrency || 0,
            singleFileTokens: adm.singleFileTokens || 2048,
            recallDepth: adm.recallDepth || 1,
            outputTokens: adm.outputTokens || 1024,
            extraJson: adm.extraJson || null,
            dailyBudget: adm.dailyBudget || 0,
            track: !!(adm.track && adm.track.enabled),
            trackInterval: (adm.track && adm.track.interval !== undefined && adm.track.interval !== null) ? adm.track.interval : 0,
            trackStartTurn: (adm.track && adm.track.startTurn !== undefined && adm.track.startTurn !== null) ? adm.track.startTurn : 0,
            trackEconomize: (adm.track && adm.track.economize) || 'none',
            trackTruncK: (adm.track && adm.track.truncK) || 2,
            trackModel: ((adm.track && adm.track.model && adm.track.model.provider && adm.track.model.model) ? adm.track.model.provider + '/' + adm.track.model.model : ''),
            enhance: !!(adm.enhance && adm.enhance.enabled),
            enhanceAutoWrite: !!(adm.enhance && adm.enhance.autoWrite),
            enhanceMaxDepth: (adm.enhance && adm.enhance.maxExpandDepth) || 3,
            enhanceModel: ((adm.enhance && adm.enhance.model && adm.enhance.model.provider && adm.enhance.model.model) ? adm.enhance.model.provider + '/' + adm.enhance.model.model : ''),
            period: !!(adm.period && adm.period.enabled),
            periodDays: (adm.period && adm.period.intervalDays) || 1,
            periodHours: (adm.period && adm.period.intervalHours) || 0,
            periodScope: (adm.period && adm.period.scope) || 1,
            periodScopeDetail: (adm.period && adm.period.scopeDetail) || SCOPE_DEFAULTS[(adm.period && adm.period.scope) || 1],
            periodUseTools: (adm.period && adm.period.useTools) !== false,
            periodImpactPercent: (adm.period && adm.period.impactPercent) || 100,
            periodImpactCount: (adm.period && adm.period.impactCount) || 0,
            periodModel: ((adm.period && adm.period.model && adm.period.model.provider && adm.period.model.model) ? adm.period.model.provider + '/' + adm.period.model.model : ''),
          },
        },
      }
    })
    // 可用模型（provider 列表 + 各 provider 模型列表）
    harnessApi.handle('motion-memory/providers', async () => {
      const llmSvc = ctx.get('llm')
      const providers = []
      const models = {}
      if (llmSvc) {
        try {
          const list = llmSvc.listProviders ? llmSvc.listProviders() : []
          for (const p of list) {
            const name = typeof p === 'string' ? p : (p && (p.name || p.id || p.provider))
            if (name) providers.push(name)
          }
          for (const p of providers) {
            try {
              const ms = await llmSvc.listModels(p)
              models[p] = Array.isArray(ms) ? ms.map(m => (typeof m === 'string' ? m : (m && (m.model || m.id || m.name)))).filter(Boolean) : []
            } catch (e) { models[p] = [] }
          }
        } catch (e) {}
      }
      return { providers, models }
    })
    // 隔离事件列表
    harnessApi.handle('motion-memory/incidents', async () => {
      await ready().catch(() => {})
      const incs = [...state.incidents.values()]
      return {
        incidents: incs.map(i => ({
          id: i.id,
          targetTime: i.targetTime,
          fileCount: (i.files || []).length,
          restoredAt: i.restoredAt || null,
          clearedAt: i.clearedAt || null,
        })),
      }
    })
    // 状态统计
    harnessApi.handle('motion-memory/stats', async () => {
      await ready().catch(() => {})
      const important = (await scanDir(importantDir(), false)).length
      const archive = (await scanDir(archiveBaseDir(), true)).length
      const events = (await listFiles(dailyBaseDir(), true)).filter(f => isEventRel(relOf(f.path))).length
      return {
        root: root(),
        sessionCwd: state.sessionCwd || '',
        migrated: !!state.migrated,
        requestEvents: state.requestEvents || 0,
        turnEvents: state.turnEvents || 0,
        important, archive, events,
        incidents: state.incidents.size,
      }
    })
    // 诊断
    harnessApi.handle('motion-memory/diag', async () => {
      let headerCwd = ''
      try {
        const sessions = ctx.get('sessions')
        const s = sessions && sessions.get(state.lastSid)
        headerCwd = (s && s.header && s.header.cwd) || ''
      } catch (e) {}
      let workspaces = []
      try {
        const ws = ctx.get('workspaceRegistry')
        if (ws) { const list = ws.list(); workspaces = list.map(w => w.path).filter(Boolean) }
      } catch (e) {}
      return { lastSid: state.lastSid || '', headerCwd, workspaces, eventDelivered: !!state.eventDelivered }
    })
    // 周期总结执行（设置界面触发 = 管理员身份，绕过会话同意闸门）
    harnessApi.handle('motion-memory/period-run', async (args) => {
      await ready().catch(() => {})
      const resetTimer = !!(args && args.resetTimer)
      const res = await scheduleWork('period', () => runPeriodSummary({ agent: 'memory-admin', session: '', turn: 0 }, true, false), '周期总结（界面）')
      if (!res.ok) return { ok: false, text: res.text || '周期总结失败' }
      // 若勾选重置倒计时：标记该次为新的计时基准（lastAutoPeriodFile 会按创建时间取最近 auto）
      return { ok: true, text: (resetTimer ? '已执行并重置周期倒计时：' : '已执行：') + (res.text || ''), data: res.data }
    })
    // 保存配置（合并写，不丢未出现的字段）
    harnessApi.handle('motion-memory/config-set', async (args) => {
      await ready().catch(() => {})
      const patch = (args && args.patch) || {}
      const c = cfg()
      let changed = false
      const baseKeys = ['enabled', 'inject', 'injectLimitBytes', 'root', 'recentOverviewN', 'archiveDays', 'cascadeDepth', 'queryHistoryN', 'updateHistoryN', 'historyPageSize', 'queryOtherAgents', 'summaryCharsK', 'autoUpdateCheck']
      for (const k of baseKeys) { if (patch[k] !== undefined && patch[k] !== c[k]) { c[k] = patch[k]; changed = true } }
      if (patch.recordModel && typeof patch.recordModel === 'object') {
        c.recordModel = c.recordModel || { provider: '', model: '' }
        if (patch.recordModel.provider !== undefined) c.recordModel.provider = String(patch.recordModel.provider)
        if (patch.recordModel.model !== undefined) c.recordModel.model = String(patch.recordModel.model)
        changed = true
      }
      const pa = patch.admin || {}
      if (Object.keys(pa).length) {
        c.admin = c.admin || {}
        const a = c.admin
        if (pa.model !== undefined) {
          const parts = String(pa.model).split('/')
          a.model = { provider: parts[0] || '', model: parts[1] || '' }
        }
        if (pa.trackModel !== undefined) {
          a.track = a.track || {}
          const parts = String(pa.trackModel).split('/')
          a.track.model = { provider: parts[0] || '', model: parts[1] || '' }
          changed = true
        }
        if (pa.enhanceModel !== undefined) {
          a.enhance = a.enhance || {}
          const parts = String(pa.enhanceModel).split('/')
          a.enhance.model = { provider: parts[0] || '', model: parts[1] || '' }
          changed = true
        }
        if (pa.periodModel !== undefined) {
          a.period = a.period || {}
          const parts = String(pa.periodModel).split('/')
          a.period.model = { provider: parts[0] || '', model: parts[1] || '' }
          changed = true
        }
        const nums = ['contextTokens', 'summaryPercent', 'concurrency', 'singleFileTokens', 'recallDepth', 'outputTokens', 'dailyBudget', 'trackInterval', 'trackTruncK', 'enhanceMaxDepth', 'periodDays', 'periodHours', 'periodImpactPercent', 'periodImpactCount', 'periodScope']
        for (const k of nums) { if (pa[k] !== undefined) { a[k] = Number(pa[k]); changed = true } }
        const bools = ['track', 'enhance', 'period', 'enhanceAutoWrite']
        for (const k of bools) { if (pa[k] !== undefined) { a[k] = !!pa[k]; changed = true } }
        if (pa.trackEconomize !== undefined) { a.track = a.track || {}; a.track.economize = String(pa.trackEconomize) }
        if (pa.periodUseTools !== undefined) { a.period = a.period || {}; a.period.useTools = !!pa.periodUseTools }
        if (pa.periodScopeDetail !== undefined) { a.period = a.period || {}; a.period.scopeDetail = String(pa.periodScopeDetail) }
        if (pa.periodTruncK !== undefined) { a.period = a.period || {}; a.period.truncK = Number(pa.periodTruncK) }
        if (Array.isArray(pa.langTokens)) { a.langTokens = pa.langTokens; changed = true }
        if (pa.extraJson !== undefined) { a.extraJson = pa.extraJson; changed = true }
        // 把扁平开关写回子对象
        if (pa.track !== undefined || pa.trackInterval !== undefined || pa.trackStartTurn !== undefined || pa.trackEconomize !== undefined || pa.trackTruncK !== undefined || pa.trackDelegateBlocks !== undefined) {
          a.track = a.track || {}
          if (pa.track !== undefined) a.track.enabled = !!pa.track
          if (pa.trackInterval !== undefined) a.track.interval = Number(pa.trackInterval)
          if (pa.trackStartTurn !== undefined) a.track.startTurn = Number(pa.trackStartTurn)
          if (pa.trackEconomize !== undefined) a.track.economize = String(pa.trackEconomize)
          if (pa.trackTruncK !== undefined) a.track.truncK = Number(pa.trackTruncK)
          if (pa.trackDelegateBlocks !== undefined) a.track.delegateBlocks = !!pa.trackDelegateBlocks
        }
        if (pa.enhance !== undefined || pa.enhanceAutoWrite !== undefined || pa.enhanceMaxDepth !== undefined) {
          a.enhance = a.enhance || {}
          if (pa.enhance !== undefined) a.enhance.enabled = !!pa.enhance
          if (pa.enhanceAutoWrite !== undefined) a.enhance.autoWrite = !!pa.enhanceAutoWrite
          if (pa.enhanceMaxDepth !== undefined) a.enhance.maxExpandDepth = Number(pa.enhanceMaxDepth)
        }
        if (pa.period !== undefined || pa.periodDays !== undefined || pa.periodHours !== undefined || pa.periodScope !== undefined || pa.periodScopeDetail !== undefined || pa.periodUseTools !== undefined || pa.periodImpactPercent !== undefined || pa.periodImpactCount !== undefined || pa.periodSkipRecent !== undefined) {
          a.period = a.period || {}
          if (pa.period !== undefined) a.period.enabled = !!pa.period
          if (pa.periodDays !== undefined) a.period.intervalDays = Number(pa.periodDays)
          if (pa.periodHours !== undefined) a.period.intervalHours = Number(pa.periodHours)
          if (pa.periodScope !== undefined) a.period.scope = Math.min(3, Math.max(1, Number(pa.periodScope) || 1))
          if (pa.periodScopeDetail !== undefined) a.period.scopeDetail = String(pa.periodScopeDetail)
          if (pa.periodTruncK !== undefined) a.period.truncK = Number(pa.periodTruncK)
          if (pa.periodUseTools !== undefined) a.period.useTools = !!pa.periodUseTools
          if (pa.periodImpactPercent !== undefined) a.period.impactPercent = Number(pa.periodImpactPercent)
          if (pa.periodImpactCount !== undefined) a.period.impactCount = Number(pa.periodImpactCount)
          if (pa.periodSkipRecent !== undefined) a.period.skipRecentDays = Math.max(7, Number(pa.periodSkipRecent) || 14)
        }
        const hasModel = !!(a.model && a.model.provider && a.model.model)
        if (hasModel !== !!a.enabled) { a.enabled = hasModel; changed = true }
      }
      if (changed) {
        writeConfigFile(c)
        state.root = (c.root && String(c.root).trim()) ? String(c.root).replace(/\\/g, '/').replace(/\/+$/, '') : globalDefaultRoot()
      }
      // 回读完整配置返回
      const adm = c.admin || {}
      return {
        config: {
          enabled: !!c.enabled, inject: !!c.inject, injectLimitBytes: c.injectLimitBytes || 4096, root: c.root || '',
          queryOtherAgents: !!c.queryOtherAgents,
          recentOverviewN: c.recentOverviewN || 3, archiveDays: c.archiveDays || 30,
          cascadeDepth: c.cascadeDepth === undefined ? 1 : c.cascadeDepth,
          queryHistoryN: c.queryHistoryN || 0, updateHistoryN: c.updateHistoryN || 0, historyPageSize: c.historyPageSize || 20,
          summaryInjectChars: c.summaryInjectChars || 300,
          summaryCharsK: (c.summaryCharsK === undefined || c.summaryCharsK === null) ? 2 : c.summaryCharsK,
          autoUpdateCheck: c.autoUpdateCheck !== false,
          recordModel: { provider: (c.recordModel && c.recordModel.provider) || '', model: (c.recordModel && c.recordModel.model) || '' },
          admin: {
            enabled: !!adm.enabled,
            model: (adm.model && adm.model.provider && adm.model.model) ? adm.model.provider + '/' + adm.model.model : '',
            contextTokens: adm.contextTokens || 128000, summaryPercent: adm.summaryPercent || 50,
            langTokens: Array.isArray(adm.langTokens) ? adm.langTokens : [{ lang: '中文', per: 1.5 }, { lang: 'english', per: 4 }],
            concurrency: adm.concurrency || 0, singleFileTokens: adm.singleFileTokens || 2048, recallDepth: adm.recallDepth || 1,
            outputTokens: adm.outputTokens || 1024, extraJson: adm.extraJson || null, dailyBudget: adm.dailyBudget || 0,
            track: !!(adm.track && adm.track.enabled), trackInterval: (adm.track && adm.track.interval !== undefined && adm.track.interval !== null) ? adm.track.interval : 0,
            trackEconomize: (adm.track && adm.track.economize) || 'none', trackTruncK: (adm.track && adm.track.truncK) || 2,
            trackModel: ((adm.track && adm.track.model && adm.track.model.provider && adm.track.model.model) ? adm.track.model.provider + '/' + adm.track.model.model : ''),
            enhance: !!(adm.enhance && adm.enhance.enabled), enhanceAutoWrite: !!(adm.enhance && adm.enhance.autoWrite),
            enhanceMaxDepth: (adm.enhance && adm.enhance.maxExpandDepth) || 3,
            enhanceModel: ((adm.enhance && adm.enhance.model && adm.enhance.model.provider && adm.enhance.model.model) ? adm.enhance.model.provider + '/' + adm.enhance.model.model : ''),
            period: !!(adm.period && adm.period.enabled), periodDays: (adm.period && adm.period.intervalDays) || 1,
            periodHours: (adm.period && adm.period.intervalHours) || 0, periodScope: (adm.period && adm.period.scope) || 1,
            periodScopeDetail: (adm.period && adm.period.scopeDetail) || SCOPE_DEFAULTS[(adm.period && adm.period.scope) || 1],
            periodTruncK: (adm.period && adm.period.truncK) || 2,
            periodUseTools: (adm.period && adm.period.useTools) !== false,
            periodImpactPercent: (adm.period && adm.period.impactPercent) || 100, periodImpactCount: (adm.period && adm.period.impactCount) || 0,
            periodModel: ((adm.period && adm.period.model && adm.period.model.provider && adm.period.model.model) ? adm.period.model.provider + '/' + adm.period.model.model : ''),
          },
        },
      }
    })
    // 触发隔离（复用 runIsolation）
    harnessApi.handle('motion-memory/isolation', async (args) => {
      const res = await runIsolation(args || {}, { session: state.lastSid || '', turn: 0, agent: 'settings-ui' })
      return res
    })
    // 隔离回滚
    harnessApi.handle('motion-memory/incident-restore', async (args) => {
      const id = args && args.id
      const inc = state.incidents.get(id)
      if (!inc) return { ok: false, text: '未找到隔离事件：' + id }
      if (inc.restoredAt) return { ok: false, text: '该事件已回滚' }
      const tMs = parseIso(inc.targetTime)
      let restored = 0, quarantined = 0
      for (const f of inc.files || []) {
        const src = p(root(), f.rel)
        const o = await readJson(src)
        if (!o || isTombstone(o)) continue
        if (f.createdAfter) {
          const q = await uniquePath(quarantineDir(), fileNameOf(f.rel))
          await writeJson(q, o)
          await tombstone(src, q)
          quarantined++
          continue
        }
        const st = stateAt(o, src, tMs)
        const changed = st.content !== (o.content || '')
        if (changed) {
          o.content = st.content
          o.history.push(histEntry('restore', { agent: 'settings-ui', note: '隔离回滚至 ' + inc.targetTime + '（事件 ' + inc.id + '）' }))
          o.updatedAt = nowIso()
        }
        if (st.path !== src) { await writeJson(st.path, o, true); await tombstone(src, st.path) }
        else if (changed) { await writeJson(src, o, true) }
        restored++
      }
      inc.restoredAt = nowIso()
      await writeJson(p(isolationDir(), inc.id, 'incident.json'), inc)
      return { ok: true, text: '已回滚事件 ' + inc.id + '：恢复 ' + restored + ' 个文件，T 之后新建 ' + quarantined + ' 个已移入 _审阅' }
    })
    // 解除隔离
    harnessApi.handle('motion-memory/incident-clear', async (args) => {
      const id = args && args.id
      const inc = state.incidents.get(id)
      if (!inc) return { ok: false, text: '未找到隔离事件：' + id }
      inc.clearedAt = nowIso()
      await writeJson(p(isolationDir(), inc.id, 'incident.json'), inc)
      return { ok: true, text: '已解除隔离通知：' + id }
    })
    // 历史周期总结查询（按时间范围，近→远）
    harnessApi.handle('motion-memory/period-history', async (args) => {
      await ready().catch(() => {})
      const from = args && args.from ? Number(args.from) : 0
      const to = args && args.to ? Number(args.to) : 0
      const out = []
      for (const f of await listFiles(periodBaseDir(), true)) {
        const o = await readJson(f.path)
        if (!o || isTombstone(o) || o.kind !== 'period') continue
        const t = parseIso(o.createdAt) || 0
        if (from && t < from) continue
        if (to && t > to) continue
        out.push({
          path: relOf(f.path), title: o.title || '', content: o.content || '',
          createdAt: o.createdAt || '', trigger: o.trigger || '',
          scope: o.scope || 1, scopeLabel: o.scopeLabel || (scopeLabelOf(o.scope, o.scopeDetail)), scopeDetail: o.scopeDetail || '',
          covered: (o.coveredEvents || []).length, coveredEvents: o.coveredEvents || [],
          sessionTurns: o.sessionTurns || [],
          createdBy: o.createdBy || null,
        })
      }
      out.sort((a, b) => parseIso(b.createdAt) - parseIso(a.createdAt))
      return { ok: true, items: out }
    })
    // 确认升级方案：按历史周期文件的原时间范围 + 新方案重跑（旧文件保留）
    harnessApi.handle('motion-memory/period-upgrade', async (args) => {
      await ready().catch(() => {})
      const rel = args && args.rel
      const newScope = args && args.scope ? Number(args.scope) : 0
      const newDetail = args && args.scopeDetail
      if (!rel) return { ok: false, text: '缺少周期文件指向' }
      if (![1, 2, 3].includes(newScope)) return { ok: false, text: '无效的新方案：' + newScope }
      const path = p(root(), rel)
      const o = await readJson(path)
      if (!o || isTombstone(o)) return { ok: false, text: '周期文件不存在：' + rel }
      // 原文件时间范围：优先文件 range，否则按 createdBy/createdAt 前后各取一个周期跨度
      let from = (o.range && o.range.from) || 0
      let to = (o.range && o.range.to) || 0
      if (!from && !to) {
        const t = parseIso(o.createdAt) || Date.now()
        const span = 30 * 86400000
        from = t - span
        to = t + span
      }
      // 用新方案重跑（ignoreSummarized=true 忽略已总结标记重新收集）
      const res = await scheduleWork('period', () => runPeriodSummary({ agent: 'memory-admin', session: state.lastSid || '', turn: 0 }, true, false, {
        scope: newScope, scopeDetail: newDetail, from, to, ignoreSummarized: true,
        truncK: args && args.truncK,
      }), '周期重总结 ' + rel)
      if (!res.ok) return res
      return { ok: true, text: '已按方案' + newScope + '重新总结原周期（' + rel + '）：\n' + (res.text || ''), data: { oldRel: rel, newScope } }
    })
    // ── 记忆管理面板 RPC（对话页顶部浮层 + 历史周期编辑）──────────────────
    // 周期双模式重总结：mode='current' 用当前活跃摘要；mode='at-time' 用该周期创建时点的活跃摘要
    // （reconstructAt 从活跃文件 history 回溯）
    harnessApi.handle('motion-memory/period-rereview', async (args) => {
      await ready().catch(() => {})
      const rel = args && args.rel
      const mode = (args && args.mode) || 'current'
      if (!rel) return { ok: false, text: '缺少周期文件指向' }
      const path = p(root(), rel)
      const o = await readJson(path)
      if (!o || isTombstone(o)) return { ok: false, text: '周期文件不存在：' + rel }
      const ownerKey = (o.createdBy && o.createdBy.agent) || 'memory-admin'
      const tMs = parseIso(o.createdAt) || Date.now()
      // 取活跃摘要：mode='current' 用最新；mode='at-time' 用 reconstructAt 回溯到周期创建前
      let activeSummary = ''
      try {
        const act = await readAgentActive(ownerKey)
        if (mode === 'at-time' && act.obj && act.obj.history && act.obj.history.length) {
          activeSummary = reconstructAt({ content: act.obj.summary || '', history: act.obj.history }, tMs, parseIso)
        } else {
          activeSummary = (act.obj && act.obj.summary) || ''
        }
      } catch (e) {}
      const prompt = (mode === 'at-time' ? '【当时的活跃记忆（' + (o.createdAt || '') + '）】' : '【当前活跃记忆】') + '\n' + (activeSummary || '（无）') +
        '\n\n【原周期总结内容】\n' + (o.content || '') +
        '\n\n请以活跃记忆的态度重新审视这段周期总结，输出 JSON：{"content":"重新审视后的周期总结正文","note":"本次修正说明"}'
      const res = await scheduleWork('admin', () => adminLlm(prompt, resolveModelConfig(o.scopeModel || null), 3), '周期重审 ' + rel)
      if (!res.ok) return res
      const parsed = parseAdminJson(res.text)
      const newContent = (parsed && parsed.content) ? String(parsed.content) : res.text
      o.content = newContent
      o.history = o.history || []
      o.history.push(histEntry('update', { agent: 'memory-admin', session: state.lastSid || '', turn: 0, note: '重新审视（' + (mode === 'at-time' ? '当时活跃' : '当前活跃') + '）：' + ((parsed && parsed.note) || '') }))
      o.updatedAt = nowIso()
      await writeJson(path, o, true)
      return { ok: true, text: '已按' + (mode === 'at-time' ? '当时活跃记忆' : '当前活跃记忆') + '重新审视周期总结：\n' + (parsed && parsed.note ? '说明：' + parsed.note + '\n' : '') + newContent.slice(0, 200), data: { rel, mode } }
    })
    // 轮次总结列表：按 会话@轮次 反查事件记忆（可限定会话）
    harnessApi.handle('motion-memory/turn-list', async (args) => {
      await ready().catch(() => {})
      const sid = args && args.sid
      const out = []
      for (const f of await listFiles(dailyBaseDir(), true)) {
        const rel = relOf(f.path)
        if (!isEventRel(rel)) continue
        if (rel.indexOf('周期记忆/') >= 0) continue
        const o = await readJson(f.path)
        if (!o || isTombstone(o) || o.kind !== 'event') continue
        // 从 sourceChain/sessionRef/links 提取 会话@轮次
        let ref = ''
        if (o.sessionRef && o.sessionRef.sessionId && o.sessionRef.turn) ref = o.sessionRef.sessionId + '@' + o.sessionRef.turn
        if (!ref && o.links && Array.isArray(o.links.children)) {
          for (const l of o.links.children) if (l && l.kind === 'turn' && l.ref) { ref = l.ref; break }
        }
        if (!ref && Array.isArray(o.sourceChain)) {
          for (const s of o.sourceChain) if (typeof s === 'string' && s.indexOf('@') >= 0) { const m = s.match(/^(.+)@(\d+)/); if (m) { ref = m[1] + '@' + Number(m[2]); break } }
        }
        if (!ref) continue
        if (sid && !ref.startsWith(sid + '@')) continue
        out.push({
          path: rel, title: o.title || '', content: o.content || '',
          createdAt: o.createdAt || '', ref, noModel: !!o.noModel,
          summarizedAt: o.summarizedAt || null,
        })
      }
      out.sort((a, b) => {
        const ma = a.ref.match(/@(\d+)/), mb = b.ref.match(/@(\d+)/)
        const ta = ma ? Number(ma[1]) : 0, tb = mb ? Number(mb[1]) : 0
        return ta - tb || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)
      })
      return { ok: true, items: out }
    })
    // 轮次总结编辑/新增：rel 存在=编辑；ref 存在（无 rel）=新增并指向 会话@轮次
    harnessApi.handle('motion-memory/turn-save', async (args) => {
      await ready().catch(() => {})
      const rel = args && args.rel
      const ref = args && args.ref
      const content = String((args && args.content) || '').trim()
      if (!content) return { ok: false, text: '内容为空' }
      const me = { agent: 'memory-admin', session: state.lastSid || '', turn: 0 }
      if (rel) {
        // 编辑已有事件
        const path = p(root(), rel)
        const o = await readJson(path)
        if (!o || isTombstone(o)) return { ok: false, text: '事件不存在：' + rel }
        o.content = content
        o.history = o.history || []
        o.history.push(histEntry('update', { ...me, note: '界面手动修改轮次总结' }))
        o.updatedAt = nowIso()
        await writeJson(path, o, true)
        return { ok: true, text: '已保存：' + rel }
      }
      // 新增：解析 会话@轮次 → 统一写入该会话聚合文件（不再生成散落的单轮次事件文件）
      const m = String(ref || '').match(/^(.+)@(\d+)$/)
      if (!m) return { ok: false, text: 'ref 格式无效（需 会话@轮次）：' + ref }
      const sid = m[1], turn = Number(m[2])
      const r = await appendTurnToAggregate(sid, turn, content, { note: '界面手动创建轮次总结', reason: '界面手动新增' })
      if (!r || !r.ok) return { ok: false, text: '创建轮次总结失败' }
      await touchActive(me, relOf(r.path), 'memory_event_add')
      return { ok: true, text: '已创建轮次总结：' + sid + '@' + turn, data: { path: relOf(r.path) } }
    })
    // 轮次重新总结（force 重新调模型）：mode='model' 有模型；无模型则提示
    harnessApi.handle('motion-memory/turn-rereview', async (args) => {
      await ready().catch(() => {})
      const ref = args && args.ref
      const m = String(ref || '').match(/^(.+)@(\d+)$/)
      if (!m) return { ok: false, text: 'ref 格式无效：' + ref }
      const sid = m[1], turn = Number(m[2])
      const tc = trackCfg()
      const hasModel = !!(tc.model && tc.model.provider && tc.model.model)
      if (!hasModel) return { ok: false, text: '无模型模式，无法重新总结（仅可手动编辑）' }
      const res = await runTurnSummary(sid, turn, { agent: 'memory-admin', session: state.lastSid || '', turn: 0, force: true })
      if (!res.ok) return res
      return { ok: true, text: '已重新总结轮次 ' + sid + '@' + turn + '：\n' + ((res && res.text) || '完成') }
    })
    // 当前智能体活跃页读取（摘要 + 引用 + 最近动作）
    harnessApi.handle('motion-memory/active-read', async (args) => {
      await ready().catch(() => {})
      const ownerKey = (args && args.ownerKey) || (state.lastOwnerKey || '')
      const { obj } = await readAgentActive(ownerKey)
      const idx = await readJson(activeIndexPath()).catch(() => null)
      return {
        ok: true,
        data: {
          agent: obj.agent || ownerKey, summary: obj.summary || '',
          lastMemRef: obj.lastMemRef || '', lastAction: obj.lastAction || '',
          updatedAt: obj.updatedAt || '', summaryNoModel: !!obj.summaryNoModel,
          refs: (obj.refs || []).slice(0, 50),
          history: (obj.history || []).slice(-20),
          agents: (idx && idx.agents || []).slice(0, 10),
        },
      }
    })
    // 重要关键词列表（重要文件夹，可编辑）
    harnessApi.handle('motion-memory/keyword-list', async (args) => {
      await ready().catch(() => {})
      const out = []
      for (const f of await listFiles(importantDir(), false)) {
        const o = await readJson(f.path)
        if (!o || isTombstone(o)) continue
        out.push({ path: relOf(f.path), title: o.title || '', content: o.content || '', reason: o.reason || '', updatedAt: o.updatedAt || '' })
      }
      out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      return { ok: true, items: out }
    })
    // 重要关键词编辑（title 定位，改写 content）
    harnessApi.handle('motion-memory/keyword-save', async (args) => {
      await ready().catch(() => {})
      const title = args && args.title
      const content = String((args && args.content) || '').trim()
      if (!title) return { ok: false, text: '缺少标题' }
      const found = await findKeyword(title)
      if (!found) return { ok: false, text: '未找到关键词记忆：' + title }
      const me = { agent: 'memory-admin', session: state.lastSid || '', turn: 0 }
      found.obj.content = content
      found.obj.history = found.obj.history || []
      found.obj.history.push(histEntry('update', { ...me, note: '界面手动修改关键词记忆' }))
      found.obj.updatedAt = nowIso()
      await writeJson(found.path, found.obj)
      return { ok: true, text: '已保存关键词记忆：' + title }
    })
  }

  // ── 运动记忆服务接口（同进程 file 插件 mm-settings 内部调用）────────
  // UE5 类比：业务模块导出接口类；mm-settings 声明 inject: ['motionMemoryApi']
  // 后直接 ctx.motionMemoryApi.turnRereview() —— 进程内函数直调，
  // 不走"写请求文件 → 定时器 → 轮询结果文件"的文件接力链路。
  ctx.provide('motionMemoryApi', {
    // 智能体归属键解析（日志 agent-preset/selected 优先，header 兜底）——供设置界面与记忆页按当前会话智能体读取活跃
    async resolveOwnerKey(args) {
      await ready().catch(() => {})
      const sid = (args && args.sid) || ''
      if (!sid) return { ok: false, text: '缺少会话 id' }
      const ownerKey = (await ownerKeyOfAsync(sid)) || ''
      return { ok: true, ownerKey, text: ownerKey || '（无 preset，会话隔离）' }
    },
    // 版本检查 / 执行更新（git 绑定安装；供 mm-settings 界面按钮调用）
    async updateCheck(args) {
      await ready().catch(() => {})
      const force = !!(args && args.force)
      if (!force && state.lastUpdateCheck) return state.lastUpdateCheck
      return autoUpdateCheck()
    },
    async updateApply() {
      await ready().catch(() => {})
      return applyUpdate()
    },
    // 轮次重新总结（同步直调模型，当场等返回；mode=current/at-time 双模式）
    async turnRereview(args) {
      await ready().catch(() => {})
      const ref = (args && args.ref) || ''
      const m = ref ? String(ref).match(/^(.+)@(\d+)$/) : null
      const sid = (args && args.sid) || (m ? m[1] : '')
      const turn = ((args && args.turn) ? Number(args.turn) : 0) || (m ? Number(m[2]) : 0)
      const mode = (args && args.mode) || 'current'
      if (!sid || !turn) return { ok: false, text: '缺少会话或轮次' }
      const tc = trackCfg()
      const hasModel = !!(tc.model && tc.model.provider && tc.model.model)
      if (!hasModel) return { ok: false, text: '无模型模式，无法重新总结（仅可手动编辑）' }
      const res = await runTurnSummary(sid, turn, {
        agent: 'memory-admin', session: state.lastSid || '', turn: 0,
        force: true, ownerKey: ownerKeyOf(sid), mode,
      }).catch(e => ({ ok: false, text: String((e && e.message) || e) }))
      if (!res || !res.ok) return res || { ok: false, text: '重新总结失败' }
      try { await removeNoModelTurnRef(sid, turn) } catch (e) {}
      return { ok: true, text: '已重新总结轮次 ' + sid + '@' + turn + '：\n' + ((res && res.text) || '完成'), data: { sid, turn, mode } }
    },
    // 活跃文件读取（v4 结构：custom/keywords/works；兼容视图带 summary/records 派生）
    async activeRead(args) {
      await ready().catch(() => {})
      const ownerKey = (args && args.ownerKey) || (state.lastOwnerKey || '')
      const { obj, path } = await readAgentActive(ownerKey)
      const works = Array.isArray(obj.works) ? obj.works : []
      return {
        ok: true,
        data: {
          agent: obj.agent || ownerKey,
          session: (args && args.session) || state.lastSid || '',
          summary: works.length ? String(works[0].text || '').slice(0, 120) : '',
          custom: obj.custom || '',
          keywords: (Array.isArray(obj.keywords) ? obj.keywords.slice(0, 50) : []).map(k => ({ word: String(k), exists: existsSync(p(importantDir(), sanitizeFile(String(k)) + '.json')) })),
          works: works.slice(0, 30).map(w => ({ sid: w.sid || '', text: String(w.text || ''), refs: Array.isArray(w.refs) ? w.refs : [], updatedAt: w.updatedAt || '' })),
          lastMemRef: obj.lastMemRef || '', lastAction: obj.lastAction || '', updatedAt: obj.updatedAt || '',
          refs: (obj.refs || []).slice(0, 50),
          history: (obj.history || []).slice(-20),
          migrated: !!obj._migratedFrom,
          migrateReport: state.activeMigrateReport || null,
        },
      }
    },
    // 活跃文件保存（v4：custom / keywords / works 分块编辑；summary 派生不落盘）
    async activeSave(args) {
      await ready().catch(() => {})
      const ownerKey = (args && args.ownerKey) || (args && args.agent) || ''
      const { obj, path } = await readAgentActive(ownerKey)
      if (args && args.custom !== undefined) obj.custom = String(args.custom)
      if (args && Array.isArray(args.keywords)) obj.keywords = args.keywords.map(String).slice(0, 100)
      if (args && Array.isArray(args.works)) {
        obj.works = args.works.map(w => ({ sid: String(w.sid || ''), text: String(w.text || ''), refs: Array.isArray(w.refs) ? w.refs : [], updatedAt: w.updatedAt || nowIso() }))
      }
      // 兼容：仅传 summary 时，合并到 works 首条（旧 UI 修改摘要路径）
      if (args && args.summary !== undefined && !Array.isArray(args.works)) {
        const works = Array.isArray(obj.works) ? obj.works : []
        if (works.length) works[0] = Object.assign({}, works[0], { text: String(args.summary) })
        else works.unshift({ sid: 'summary', text: String(args.summary), refs: [], updatedAt: nowIso() })
        obj.works = works
      }
      obj.agent = String(ownerKey || '')
      obj.schemaVersion = 4
      obj.history = obj.history || []
      obj.history.push(histEntry('update', { agent: 'user+memory-admin', session: state.lastSid || '', turn: 0, note: '界面手动修改活跃记忆：' + String(ownerKey || ''), keep: true }))
      obj.history = obj.history.slice(-50)
      obj.updatedAt = nowIso()
      await writeJson(path, obj)
      await refreshActiveIndex().catch(() => null)
      return { ok: true, text: '已保存活跃记忆：' + String(ownerKey || '') }
    },
    // 会话标题轻量读取（只解会话日志前 20 帧找 session/title；供 mm-settings 会话列表兜底，
    // 避免两个插件并发 import 同一 ESM 模块触发 Node 24 require(ESM) 竞态）
    async readSessionTitle(args) {
      const sid = (args && args.sid) || ''
      if (!sid) return { ok: true, title: '' }
      return { ok: true, title: readSessionTitleFromLog(sid) }
    },
    // 轮次原文读取（会话日志 zstd 帧）：供记忆页"原文"按钮查看原始对话记录
    async readTurnRaw(args) {
      const ref = (args && args.ref) || ''
      if (!ref) return { ok: false, text: '缺少引用（会话@轮次）' }
      const text = await readTurnRef(ref, 32768)
      return { ok: true, content: text || '（该轮次无文本内容）' }
    },
    // 会话真实轮次范围（读会话日志 turn/start 事件）：轮次页按"1 到当前轮次"显示空白轮次供手动补充
    async sessionTurnRange(args) {
      const sid = (args && args.sid) || ''
      if (!sid) return { ok: true, data: null }
      const turns = sessionTurnsOf(sid)
      if (!turns.length) return { ok: true, data: null }
      return { ok: true, data: { min: turns[0], max: turns[turns.length - 1] } }
    },
    // 轮次总结写入会话聚合文件（mm-settings 手动创建轮次总结走这里，不再生成散事件文件）
    async turnSaveToAggregate(args) {
      const sid = (args && args.sid) || ''
      const turn = Number(args && args.turn) || 0
      const content = String((args && args.content) || '').trim()
      if (!sid || !turn) return { ok: false, text: '缺少会话或轮次' }
      if (!content) return { ok: false, text: '内容为空' }
      const r = await appendTurnToAggregate(sid, turn, content, {
        note: (args && args.note) || '界面手动创建轮次总结', reason: (args && args.reason) || '界面手动新增',
      })
      if (!r || !r.ok) return { ok: false, text: '创建轮次总结失败' }
      return { ok: true, text: '已创建轮次总结：' + sid + '@' + turn, data: { path: relOf(r.path) } }
    },
  })

  ready()
  // 启动后后台执行一次散事件文件合并（并入会话聚合文件；幂等，失败不阻塞）
  Promise.resolve().then(() => { ready().then(() => mergeScatteredTurnEvents()).catch(() => {}) })
  // 自动更新检查：启动后 8 秒检查一次，之后每 12 小时一次（结果缓存，失败静默）
  startAutoUpdateCheck()
}
