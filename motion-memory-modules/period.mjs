/**
 * motion-memory 周期总结域模块（拆分自 motion-memory.js，C 档第七刀）
 *
 * 定时周期总结（runPeriodSummary + 影响度筛选 + 素材档位）+ 周期到期调度
 * （timerSvc 定时器 + checkPeriod*Request 请求检测）+ memory_period_run/status。
 * 依赖经 createPeriod(core, deps) 注入：core 为共享运行时；deps 提供
 * { scheduleWork, adminLlm, parseAdminJson, resolveModelConfig, adminContextText,
 *   activeRecordsContextText, chunkCompress, sweepSpilledQueues,
 *   runTurnSummary, appendTurnToAggregate, applyEconomize,
 *   readAgentActive, activeIndexPath, refreshActiveIndex, writeActive, archiveWorksSegment,
 *   queryDayCount, readStepRange, stepsToText, readTurnUserText, readTurnRef,
 *   upsertEmbedding, pushDiff, reloadConfigIfChanged }。
 */

import { estimateTokens } from './chunker.mjs'
import { histEntry, eventFileName, sanitizeFile } from './memory-objects.mjs'
import { parts, ymdPath, ymPath, stamp, isEventRel } from './time-utils.mjs'
import { reconstructAt } from './text-utils.mjs'
import { SCOPE_DEFAULTS, scopeLabelOf } from './period-scope.mjs'

export function createPeriod(core, deps) {
  const {
    state, ctx, p, root, relOf, nowIso, parseIso, uid,
    readJson, writeJson, listFiles, isTombstone, tombstone, cfg, adminCfg,
    importantDir, dailyBaseDir, archiveBaseDir, activeDir, noModelDir,
    uniquePath, ownerOf, isoStr, readSessionLogFrames, ownerKeyOf, periodBaseDir,
  } = core
  const {
    scheduleWork, adminLlm, parseAdminJson, resolveModelConfig, adminContextText,
    activeRecordsContextText, chunkCompress, sweepSpilledQueues,
    runTurnSummary, appendTurnToAggregate, applyEconomize,
    readAgentActive, activeIndexPath, refreshActiveIndex, writeActive, archiveWorksSegment,
    queryDayCount, readStepRange, stepsToText, readTurnUserText, readTurnRef,
    upsertEmbedding, pushDiff, reloadConfigIfChanged,
  } = deps || {}

  // ═════════════════════════════════════════════════════════════════════
  // 阶段4：定时周期模式（周期总结 + 影响度筛选 + 手动触发）
  // ═════════════════════════════════════════════════════════════════════
  // 配置：admin.period = { enabled, intervalDays(默认1), intervalHours(0),
  //        scope(1|2|3 素材广度), scopeDetail(档位), useTools(true), impactPercent(100), impactCount(0),
  //        skipRecentDays(默认14，最小7：最近 N 天素材不参与周期总结，设置页告知) }
  // 目录：记忆累积/周期记忆/年/月/日/；时间基准 = 最近 auto 周期文件（无则从现在起算）
  // 影响度：score = 查询次数权重 + 时间衰减（今天≈100% → 线性降至 20%）
  // scope 素材广度：1=仅记忆（事件+无模型）；2=+会话首尾；3=+全量轮次
  // scopeDetail 档位：
  //   scope1: 'events'（仅事件记忆）| 'events-nomodel'（事件+无模型）
  //   scope2: 'first'（首轮）| 'first-last'（首尾轮）| 'first-tools'（首轮+工具触发轮）
  //   scope3: 'full'（全部轮次完整）| 'full-no-tools'（跳过工具输出）| 'full-tail'（只留末尾 k token）
  function periodCfg() {
    const c = cfg()
    if (!c.admin) c.admin = {}
    if (!c.admin.period) c.admin.period = { enabled: false, intervalDays: 1, intervalHours: 0, scope: 1, scopeDetail: 'events-nomodel', useTools: true, impactPercent: 100, impactCount: 0, economize: [], truncK: 2, skipRecentDays: 14, agents: [] }
    const pc = c.admin.period
    if (!Array.isArray(pc.agents)) pc.agents = []
    // 最近 N 天素材不总结：默认 14，最小 14（0/缺省/小于 14 一律回退默认 14，保证近期记忆不被过早压缩）
    if (!(pc.skipRecentDays >= 14)) pc.skipRecentDays = 14
    return pc
  }
  // 全部智能体 key（preset:*）：active.json agents + 记忆文件归属去重
  async function allAgentKeys() {
    const seen = {}
    const out = []
    const add = (k) => { k = String(k || '').trim(); if (k && k.indexOf('preset:') === 0 && !seen[k]) { seen[k] = true; out.push(k) } }
    try {
      const idx = await readJson(activeIndexPath())
      if (idx && Array.isArray(idx.agents)) for (const a of idx.agents) add(a && a.agent)
    } catch (e) {}
    for (const f of await listFiles(importantDir(), false)) {
      const o = await readJson(f.path)
      if (!o || isTombstone(o)) continue
      add(ownerOf(o))
    }
    return out
  }
  // 周期目标智能体：配置 agents（选中）为空 → 全部
  async function periodTargets() {
    const pc = periodCfg()
    const cfgAgents = Array.isArray(pc.agents) ? pc.agents.filter(a => String(a).indexOf('preset:') === 0) : []
    if (cfgAgents.length) return cfgAgents
    return allAgentKeys()
  }
  function periodDirFor(d) { const q = parts(d || new Date()); return p(periodBaseDir(), q.y, q.m) }
  // 影响度：查询次数（accessedCount）+ 时间衰减（线性 100%→20%）
  function impactScore(obj, nowMs) {
    const created = parseIso(obj.createdAt) || nowMs
    const days = Math.max(0, (nowMs - created) / 86400000)
    const timeFactor = Math.max(0.2, 1 - days * 0.8 / 30) // 30 天线性降到 20%
    const accessed = (obj.history || []).filter(h => h.op === 'query').reduce((n, h) => n + queryDayCount(h), 0)
    return accessed * 2 * timeFactor + timeFactor
  }
  // 找到最近 auto 周期文件（跳过 manual），返回 {path, obj} 或 null
  async function lastAutoPeriodFile() {
    const files = await listFiles(periodBaseDir(), true)
    let best = null
    for (const f of files) {
      const o = await readJson(f.path)
      if (!o || isTombstone(o)) continue
      if (o.trigger === 'manual') continue
      const t = parseIso(o.createdAt) || parseIso(o.updatedAt) || 0
      if (!best || t > best.t) best = { path: f.path, obj: o, t }
    }
    return best
  }
  // 周期到期判断
  async function periodDue() {
    const pc = periodCfg()
    if (!pc.enabled) return false
    const days = Math.max(0, Number(pc.intervalDays) || 1)
    const hours = Math.min(24, Math.max(0, Number(pc.intervalHours) || 0))
    const totalMs = (days * 24 + hours) * 3600000
    const last = await lastAutoPeriodFile()
    if (!last) return true // 无历史 → 触发
    const lastTime = last.t
    return (Date.now() - lastTime) >= totalMs
  }
  // 按时间范围枚举会话（sessionQuery filterSessions，SQLite 索引，不读日志正文）
  // 返回 [{ sid, createdAt, cwd }]，按 created-at 过滤 [from, to]
  async function listSessionsInRange(from, to) {
    const sq = ctx.get('sessionQuery')
    if (!sq || typeof sq.filterSessions !== 'function') return []
    try {
      const filters = []
      if (from) filters.push({ kind: 'created-at', from })
      if (to) filters.push({ kind: 'created-at', to })
      const recs = await sq.filterSessions(filters)
      return (recs || []).map(r => ({
        sid: r && r.header && r.header.id,
        createdAt: r && r.header && r.header.createdAt,
        cwd: r && r.header && r.header.cwd,
      })).filter(x => x.sid)
    } catch (e) { return [] }
  }
  // 从会话日志帧级读取取该会话的轮次集合（只读 turn/start 事件，不回读全部内容）
  function sessionTurnsOf(sid) {
    try {
      const fast = readSessionLogFrames(sid)
      const turns = new Set()
      if (fast && fast.events) {
        for (const e of fast.events) {
          if (e && e.type === 'turn/start' && e.data && e.data.turn !== undefined) turns.add(Number(e.data.turn))
        }
      }
      return [...turns].sort((a, b) => a - b)
    } catch (e) { return [] }
  }
  // 范围三：无模型逐轮推理总结（从用户消息态度推理，信息不足再查完整轮次）
  // 返回 [{ sid, turn, text }]；economize=truncated 时只留用户消息+末尾 k token
  // 范围三：无模型逐轮推理总结（从用户消息态度推理，信息不足再查完整轮次）
  // scopeDetail 控制补充深度：infer=查助理推进；infer-full=跳过工具输出；infer-tail=只留末尾 k token
  async function inferTurnItems(sid, turn, detail, truncK) {
    const steps = await readStepRange(sid, turn, 1, undefined)
    if (!steps.length) return null
    // 用户消息（每轮入口，态度/反驳/提示/要求所在）
    const userText = await readTurnUserText(sid, turn, 4096)
    if (!userText) return null
    let body = '【用户要求】' + userText
    const detailMode = detail || 'infer'
    if (detailMode !== 'infer') {
      // 信息不足补充：infer-full 跳工具输出；infer-tail 只留末尾
      const cleanSteps = steps.filter(s => (s.parts || []).some(p => p.kind === 'assistant'))
      const cleanText = stepsToText(cleanSteps, true)
      if (cleanText) {
        let part = cleanText
        if (detailMode === 'infer-tail') {
          const cap = Math.max(1, truncK || 2) * 1000
          part = cleanText.length > cap ? '…（截断）\n' + cleanText.slice(-cap) : cleanText
        } else {
          part = cleanText.slice(0, 3000)
        }
        body += '\n【对话推进】' + part
      }
    }
    return { sid, turn, text: body }
  }
  // 读会话聚合文件里某轮次的总结内容（对话跟踪已总结的轮次，周期方案3直接合并用）
  async function readTurnAggContent(sid, turn) {
    try {
      const cand = p(dailyBaseDir(), ymPath(new Date()), sanitizeFile(sid) + '.json')
      const agg = await readJson(cand)
      if (agg && !isTombstone(agg) && agg.kind === 'event' && Array.isArray(agg.turns)) {
        const t = agg.turns.find(x => x && x.turn === turn)
        if (t && String(t.content || '').trim()) return String(t.content)
      }
      // 兜底：跨月聚合文件
      for (const f of await listFiles(dailyBaseDir(), true)) {
        const rel = relOf(f.path)
        if (rel.indexOf('session-' + sanitizeFile(sid) + '.json') < 0) continue
        const o2 = await readJson(f.path)
        if (o2 && !isTombstone(o2) && o2.kind === 'event' && Array.isArray(o2.turns)) {
          const t2 = o2.turns.find(x => x && x.turn === turn)
          if (t2 && String(t2.content || '').trim()) return String(t2.content)
        }
      }
    } catch (e) {}
    return ''
  }
  // 读某轮次原文（未总结轮次触发总结用），按周期 economize 运行参数节约（output/truncated）
  async function readTurnEconomized(sid, turn, eco, truncK) {
    try {
      const steps = await readStepRange(sid, turn, 1, undefined)
      if (!steps || !steps.length) return ''
      const res = await applyEconomize(sid, turn, steps, eco, truncK)
      const parts = []
      if (res && res.userText) parts.push('【用户要求】' + res.userText)
      if (res && res.steps && res.steps.length) parts.push(stepsToText(res.steps, true))
      return parts.join('\n').slice(0, 8000)
    } catch (e) { return '' }
  }
  // 执行一次周期总结
  async function runPeriodSummary(meta, force, useSessionModel, extra) {
    const pc = periodCfg()
    if (!pc.enabled && !force) return { ok: false, text: '定时周期未启用' }
    // 方案/档位/时间范围/忽略已总结（历史重总结传参）
    const scope = Math.min(3, Math.max(1, Number((extra && extra.scope) || pc.scope) || 1))
    const scopeDetail = (extra && extra.scopeDetail) || pc.scopeDetail || SCOPE_DEFAULTS[scope]
    const rangeFrom = (extra && extra.from) ? Number(extra.from) : 0
    const rangeTo0 = (extra && extra.to) ? Number(extra.to) : 0
    const ignoreSummarized = !!(extra && extra.ignoreSummarized)
    const truncK = Math.max(0, Number((extra && extra.truncK) || pc.truncK) || 2)
    // 目标智能体（按智能体分类周期总结）：extra.ownerKey 指定；空 = 全部
    const periodOwner = String((extra && extra.ownerKey) || '').trim()
    // 窗口：最近 7 天固定不压缩（最近使用的会话保持热）→ rangeTo 上限收窄到 now-7；
    // 放弃判定窗口 = [now - skipRecentDays, now - 7]（可总结区）；历史重总结（显式 from/to）不套用。
    let rangeTo = rangeTo0
    const skipMs = Math.max(14, Number(pc.skipRecentDays) || 14) * 86400000
    const winFrom = Date.now() - skipMs
    const recentCap7 = Date.now() - 7 * 86400000
    if (!(extra && (extra.from || extra.to))) {
      if (!rangeTo || rangeTo > recentCap7) rangeTo = recentCap7
    }
    // 定时周期可独立指定模型（空则用全局管理员模型）；useSessionModel=true 用会话主力模型
    let mc = resolveModelConfig(pc.model)
    if (useSessionModel) {
      try {
        const adm = ctx.get('agentDefaultModel')
        if (adm) {
          const sel = adm.currentSelection && adm.currentSelection()
          if (sel && sel.provider && sel.model) mc = Object.assign({}, mc, { provider: String(sel.provider), model: String(sel.model) })
        }
      } catch (e) {}
      if (!mc.provider || !mc.model) return { ok: false, text: 'useSessionModel=true 但无法获取会话默认模型' }
    }
    const opts = {
      provider: mc.provider,
      model: mc.model,
      contextTokens: mc.contextTokens,
      percent: mc.summaryPercent,
      outputTokens: mc.outputTokens,
      concurrency: mc.concurrency,
      langTokens: adminCfg().langTokens,
      extraJson: mc.extraJson,
    }
    if (!opts.provider || !opts.model) return { ok: false, text: '未配置管理员模型（定时周期或全局）' }
    // 收集事件记忆（未总结过的；历史重总结可忽略 summarizedAt 标记）
    const evs = []
    for (const f of await listFiles(dailyBaseDir(), true)) {
      const rel = relOf(f.path)
      if (!isEventRel(rel)) continue
      if (rel.indexOf('周期记忆/') >= 0) continue
      const o = await readJson(f.path)
      if (!o || isTombstone(o) || o.kind !== 'event') continue
      if (periodOwner && ownerOf(o) !== periodOwner) continue
      if (!ignoreSummarized && o.summarizedAt) continue
      const created = parseIso(o.createdAt) || 0
      if (rangeFrom && created < rangeFrom) continue
      if (rangeTo && created > rangeTo) continue
      evs.push({ obj: o, path: f.path, rel })
    }
    // v3：无模型记忆整理区也纳入周期总结素材（未总结过的 no-model 文件）
    for (const f of await listFiles(noModelDir(), true)) {
      const o = await readJson(f.path)
      if (!o || isTombstone(o) || o.kind !== 'no-model') continue
      if (periodOwner && ownerOf(o) !== periodOwner) continue
      if (!ignoreSummarized && o.summarizedAt) continue
      const created = parseIso(o.createdAt) || 0
      if (rangeFrom && created < rangeFrom) continue
      if (rangeTo && created > rangeTo) continue
      evs.push({ obj: o, path: f.path, rel: relOf(f.path), isNoModel: true })
    }
    // v6：补充区（移动到补充的关键词）纳入周期总结素材——被遗忘/移补充的内容周期总结也要覆盖
    for (const f of await listFiles(p(root(), '记忆累积', '补充'), true)) {
      const o = await readJson(f.path)
      if (!o || isTombstone(o) || o.kind !== 'keyword') continue
      if (periodOwner && ownerOf(o) !== periodOwner) continue
      if (!ignoreSummarized && o.summarizedAt) continue
      const created = parseIso(o.updatedAt) || parseIso(o.createdAt) || 0
      if (rangeFrom && created < rangeFrom) continue
      if (rangeTo && created > rangeTo) continue
      evs.push({ obj: o, path: f.path, rel: relOf(f.path), isArchive: true })
    }
    // 素材档位是否包含无模型：scope1 档位 'events' 排除；其余包含
    const includeNoModel = !(scope === 1 && scopeDetail === 'events')
    const evsFiltered = includeNoModel ? evs : evs.filter(e => !e.isNoModel)
    // scope>=2：会话素材。
    // 范围二 = 枚举周期内所有会话（filterSessions created-at），取首轮/首尾轮（未总结过才做）
    // 范围三 = 范围二基础上，对未总结轮次做无模型逐轮推理总结
    // 已总结轮次索引：一次性收集周期内事件记忆的 会话@轮次 指向（避免逐轮 findMemoriesByRef 全库扫描）
    const summarizedTurns = new Set()
    if (scope >= 2) {
      for (const e of evsFiltered) {
        const sc = e.obj.sourceChain || []
        for (const s of sc) {
          if (typeof s === 'string' && s.indexOf('@') >= 0) {
            const m = s.match(/^(.+)@(\d+)/)
            if (m) summarizedTurns.add(m[1] + '@' + Number(m[2]))
          }
        }
        const sref = e.obj.sessionRef
        if (sref && sref.sessionId && sref.turn) summarizedTurns.add(sref.sessionId + '@' + Number(sref.turn))
        // v5 聚合文件：turns[] 全部轮次视为已总结（内容已在本文件，周期总结不再逐轮处理）
        if (Array.isArray(e.obj.turns) && e.obj.turns.length && sref && sref.sessionId) {
          for (const t of e.obj.turns) if (t && t.turn) summarizedTurns.add(sref.sessionId + '@' + Number(t.turn))
        }
        // 聚合文件的 children turn 引用（无 sessionRef 兜底）
        if (Array.isArray(e.obj.links && e.obj.links.children)) {
          for (const l of e.obj.links.children) {
            if (l && l.kind === 'turn' && l.ref) {
              const mm = String(l.ref).match(/^(.+)@(\d+)/)
              if (mm) summarizedTurns.add(mm[1] + '@' + Number(mm[2]))
            }
          }
        }
      }
    }
    let sessionItems = []
    if (scope >= 2) {
      const sess = await listSessionsInRange(rangeFrom || undefined, rangeTo || undefined)
      if (sess.length) {
        const summarizable = []
        for (const s of sess) {
          const turns = sessionTurnsOf(s.sid)
          if (!turns.length) continue
          const first = turns[0]
          const last = turns[turns.length - 1]
          const targets = []
          if (scope === 2) {
            if (scopeDetail === 'first') targets.push(first)
            else if (scopeDetail === 'first-last') { targets.push(first); if (last !== first) targets.push(last) }
            else { targets.push(first); targets.push(last) } // first-tools 回退为首尾
          }
          // 范围三：全部轮次都纳入（已总结的取对话跟踪内容合并；未总结的读原文触发总结）
          if (scope === 3) targets.push(...turns)
          for (const turn of [...new Set(targets)]) {
            let item = null
            try {
              if (scope === 3) {
                // 已总结（对话跟踪生成过）→ 直接取该会话聚合文件里的总结内容，合并进周期素材
                const aggContent = await readTurnAggContent(s.sid, turn)
                if (aggContent) {
                  item = { sid: s.sid, turn, text: '【已总结轮次 ' + turn + '】' + aggContent, summarized: true }
                } else {
                  // 未总结 → 触发总结：读该轮原始内容（按周期 economize 运行参数节约）作为素材
                  const raw = await readTurnEconomized(s.sid, turn, pc.economize, truncK)
                  if (raw) item = { sid: s.sid, turn, text: '【轮次 ' + turn + '】' + raw }
                }
              } else {
                // 范围二：首/尾轮——未总结过的才读（已总结跳过）
                if (summarizedTurns.has(s.sid + '@' + turn)) continue
                const text = await readTurnRef(s.sid + '@' + turn, 8192)
                if (text && text.indexOf('（该轮次无文本内容）') < 0 && text.indexOf('（轮次指向格式无效') < 0) {
                  item = { sid: s.sid, turn, text }
                }
              }
            } catch (e) { item = null }
            if (item) sessionItems.push(item)
          }
        }
        if (sessionItems.length) {
          sessionItems.sort((a, b) => a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : a.turn - b.turn)
        }
      }
    }
    // 影响度筛选：count>0 用 count，否则用 percent（仅对事件素材）
    let selected = evsFiltered
    const count = Math.max(0, Number(pc.impactCount) || 0)
    const percent = Math.min(100, Math.max(1, Number(pc.impactPercent) || 100))
    if (evsFiltered.length > 0 && (count > 0 || percent < 100)) {
      const scored = evsFiltered.map(e => ({ ...e, score: impactScore(e.obj, Date.now()) }))
      scored.sort((a, b) => b.score - a.score)
      const limit = count > 0 ? Math.min(count, evsFiltered.length) : Math.max(1, Math.floor(evsFiltered.length * percent / 100))
      selected = scored.slice(0, limit)
    }
    // 自动放弃：可总结窗口 [now-skipRecentDays, now-7]（再 ∩ [rangeFrom, rangeTo]）内无可总结内容 → 跳过（不生成空周期）
    if (!(extra && (extra.from || extra.to))) {
      const hasWin = evsFiltered.some(function (e) {
        const t = parseIso(e.obj.createdAt) || parseIso(e.obj.updatedAt) || 0
        if (!t) return false
        if (t < winFrom) return false
        if (t > recentCap7) return false
        if (rangeFrom && t < rangeFrom) return false
        if (rangeTo && t > rangeTo) return false
        return true
      })
      if (!hasWin && !sessionItems.length) {
        return { ok: true, text: '可总结窗口（最近 ' + Math.round(skipMs / 86400000) + ' 天 ~ 最近 7 天）内无可总结内容，自动放弃', skipped: true }
      }
    }
    if (!selected.length && !sessionItems.length) return { ok: true, text: '周期内无未总结的事件记忆' + (scope >= 2 ? '且无会话素材' : ''), skipped: true }
    // 组装 items（事件 + 会话素材）
    // v4 #3：管理员上下文装在素材最前面（占 summaryPercent 预算）
    const adminCtx = await adminContextText(Math.floor(estimateTokens('', opts.langTokens) * 0 + (Number(opts.contextTokens) || 128000) * (Number(opts.percent) || 50) / 100 / 4))
    // v5：压缩当前活跃（各智能体记录链尾部）→ 作为周期总结的状态素材（"活跃末尾下沉"）
    const activeCtx = await activeRecordsContextText(periodOwner || undefined)
    const eventItems = selected.map(e => ({ id: e.rel, text: '【' + e.obj.title + '】' + (e.obj.content || '') }))
    const sessItems = sessionItems.map(s => ({ id: s.sid + '@' + s.turn, text: '【会话轮次 ' + s.sid + '@' + s.turn + '】' + s.text }))
    const pre = []
    if (adminCtx) pre.push({ id: 'admin-context', text: adminCtx })
    if (activeCtx) pre.push({ id: 'active-context', text: activeCtx })
    const base = pre.length ? pre.concat(eventItems, sessItems) : eventItems.concat(sessItems)
    const res = await chunkCompress(base, opts, Object.assign({}, meta, { delegateBlocks: !!(pc.model && pc.model.delegateBlocks) }), '周期总结 ' + ymdPath(new Date()) + '（' + scopeLabelOf(scope, scopeDetail) + '）')
    if (!res.ok) return { ok: false, text: '周期总结失败：' + res.error }
    // 写周期文件（auto 或 manual）
    const d = new Date()
    const dir = periodDirFor(d)
    const existing = await listFiles(dir, false)
    const seq = existing.length + 1
    const trigger = force ? 'manual' : 'auto'
    const ownerTag = periodOwner ? String(periodOwner).replace(/^preset:/, '') : 'all'
    const path = await uniquePath(dir, stamp(d) + '_' + ownerTag + (trigger === 'manual' ? '_manual' : '') + '-' + seq + '.json')
    const obj = {
      schemaVersion: 1, id: uid(), kind: 'period', location: 'period', readonly: true,
      title: '周期总结 ' + ymdPath(d) + (periodOwner ? '（' + periodOwner + '）' : '（全部智能体）') + (trigger === 'manual' ? '（手动）' : '') + '（' + scopeLabelOf(scope, scopeDetail) + '）',
      trigger, ownerKey: periodOwner || 'all',
      scope, scopeLabel: scopeLabelOf(scope, scopeDetail), scopeDetail,
      range: { from: rangeFrom || null, to: rangeTo || null },
      reason: '定时周期模式' + (trigger === 'manual' ? '手动触发' : '自动触发'),
      content: res.content || '',
      links: { parents: [], children: [] },
      createdAt: nowIso(), updatedAt: nowIso(), lastAccessedAt: nowIso(),
      createdBy: { agent: 'memory-admin', session: meta && meta.session, turn: meta && meta.turn, scope, scopeDetail },
      lastModifiedBy: { agent: 'memory-admin', session: meta && meta.session, turn: meta && meta.turn, scope, scopeDetail },
      originalId: null,
      history: [histEntry('create', { agent: 'memory-admin', note: '周期总结（' + scopeLabelOf(scope, scopeDetail) + '）', scope, scopeDetail })],
      sourceChain: res.chain || [],
      coveredEvents: selected.map(e => e.rel),
      sessionTurns: sessionItems.map(s => s.sid + '@' + s.turn),
    }
    await writeJson(path, obj)
    upsertEmbedding(relOf(path), obj.title, obj.content, 'period').catch(() => {})  // P0-1：周期文件入语义索引
    // 高缓存登记：sid → 周期文件（本次周期覆盖的会话；事实累积，不按配置天数计算）
    try {
      state.periodSidCache = state.periodSidCache || {}
      for (const st of sessionItems) {
        if (st && st.sid && st.sid.indexOf('@') < 0) state.periodSidCache[st.sid] = relOf(path)
      }
      for (const st of (obj.sessionTurns || [])) {
        const mm = String(st || '').match(/^(.+)@\d+/)
        if (mm) state.periodSidCache[mm[1]] = relOf(path)
      }
    } catch (eC) {}
    // 周期记忆也算会话工作：更新当前活跃（记录指向周期记忆文件，可点击转跳查看周期内容）
    try {
      const periodOwner = (meta && (meta.ownerKey || meta.agent)) || 'preset:cordis'
      await writeActive('', 0, {
        ownerKey: periodOwner,
        lastMemRef: relOf(path), lastAction: 'memory_period', recordDiff: false,
        summarize: false,
        record: {
          op: 'prepend', key: 'period:' + relOf(path),
          text: '[周期总结](' + relOf(path) + ')：' + String(obj.title || '').slice(0, 60) + '（素材 ' + selected.length + ' 条）',
          refs: [{ kind: 'period', title: obj.title || '周期总结', ref: relOf(path) }],
        },
      })
    } catch (e) { console.error('[motion-memory] 周期写活跃失败: ' + (e && e.message)) }
    // 标记已总结；no-model 文件总结后移动回事件区（v3）
    for (const e of selected) {
      if (e.obj.summarizedAt) continue
      e.obj.summarizedAt = nowIso()
      e.obj.summarizedBy = path
      if (e.isNoModel) {
        // 无模型记忆被周期总结 → 转正：若关联「会话@轮次」则写回对应会话聚合文件；否则回事件区单文件
        try {
          e.obj.kind = 'event'
          e.obj.location = 'daily'
          const sid2 = e.obj.sessionId || ''
          const turn2 = Number(e.obj.turn) || 0
          let dst = ''
          let viaAgg = false
          if (sid2 && turn2) {
            // 写回该会话聚合文件（与轮次总结同一文件）
            const r2 = await appendTurnToAggregate(sid2, turn2, String(e.obj.content || ''), {
              note: '无模型记忆经周期总结转正（原 ' + relOf(e.path) + '）',
              reason: '周期总结转正',
              agent: 'memory-admin',
            })
            if (r2 && r2.ok) { dst = r2.path; viaAgg = true }
          }
          if (!dst) {
            // 无会话关联 → 回事件区单文件（保留原格式）
            const d = new Date()
            const dir = ymPath(d)
            const existing = await listFiles(p(dailyBaseDir(), dir), false)
            const seq = existing.length + 1
            // 转正文件归属 = 触发会话的智能体（无模型文件 createdBy 即该归属），而非 memory-admin
            const evMeta = { agent: ownerOf(e.obj) || 'memory-admin', session: sid2 || '', turn: turn2 }
            dst = await uniquePath(p(dailyBaseDir(), dir), eventFileName(evMeta, d, seq))
          }
          e.obj.meta = e.obj.meta || {}
          e.obj.meta.promotedFrom = relOf(e.path)  // 溯源：原无模型区位置
          e.obj.history = e.obj.history || []
          e.obj.history.push(histEntry('move', { agent: 'memory-admin', note: '无模型记忆经周期总结转正', fromPath: relOf(e.path), toPath: relOf(dst), keep: false }))
          if (viaAgg) {
            // 已写入会话聚合（appendTurnToAggregate 已建 turns/links/history）：只标记原文件，不再覆盖聚合文件
            await writeJson(e.path, e.obj, true)
            await tombstone(e.path, dst)
          } else {
            await writeJson(dst, e.obj, true)
            await tombstone(e.path, dst)
          }
          e._promotedTo = relOf(dst)  // 记录转正后路径（供 coveredEvents 更新）
          console.log('[motion-memory] 无模型记忆转正：' + relOf(e.path) + ' → ' + relOf(dst))
          continue
        } catch (err) {
          console.error('[motion-memory] no-model 转正失败: ' + (err && err.message))
          await writeJson(e.path, e.obj, true)  // 兜底：原地标记
        }
      }
      // allowReadonly：仅追加 summarizedAt/summarizedBy 标记（不修改事件内容）
      await writeJson(e.path, e.obj, true)
    }
    // v3：no-model 转正后，周期文件 coveredEvents 指向新事件路径
    const promoted = selected.filter(e => e.isNoModel && e._promotedTo)
    if (promoted.length) {
      try {
        const pobj = await readJson(path)
        if (pobj) {
          pobj.coveredEvents = (pobj.coveredEvents || []).map(rel => {
            const src = promoted.find(p => p.rel === rel)
            return src && src._promotedTo ? src._promotedTo : rel
          })
          await writeJson(path, pobj, true)
        }
      } catch (err) { console.error('[motion-memory] 周期 coveredEvents 更新失败: ' + (err && err.message)) }
    }
    // 周期总结是活跃变更：刷新索引并记录 diff（通知其他窗口有新周期）
    const beforeIdx = await readJson(activeIndexPath())
    const newIdx = await refreshActiveIndex().catch(() => null)
    if (newIdx) {
      pushDiff({
        at: nowIso(), ownerKey: 'memory-admin', session: (meta && meta.session) || '', turn: (meta && meta.turn) || 0,
        added: (newIdx.recentPeriods || []).filter(r => !(beforeIdx && beforeIdx.recentPeriods || []).includes(r)).map(r => ({ title: r, ref: r, kind: 'period' })),
        removed: [],
      })
    }
    // v5 周期总结联动②：向每个有工作记录（records/works）的智能体活跃 prepend 一条指向周期文件的记录
    try {
      const periodRel = relOf(path)
      const acts = []
      for (const f of await listFiles(activeDir(), false)) {
        if (f.name === 'active.json' || !f.name.endsWith('.json')) continue
        const o = await readJson(f.path)
        if (!o || isTombstone(o) || !o.agent) continue
        const items = Array.isArray(o.works) ? o.works : (Array.isArray(o.records) ? o.records : [])
        if (items.length) acts.push({ ownerKey: o.agent, path: f.path, obj: o })
      }
      for (const a of acts) {
        const entry = {
          sid: 'period:' + periodRel,
          text: '周期总结 ' + ymdPath(new Date()) + '（' + scopeLabelOf(scope, scopeDetail) + '）：收拢 ' + selected.length + ' 条事件，旧事件记录已下沉',
          refs: [{ kind: 'period', title: periodRel, ref: periodRel }],
          updatedAt: nowIso(),
        }
        // B 下沉（用户确认）：周期总结删除被覆盖的旧会话工作段（先归档到补充同名文件，只保留周期指向）
        try {
          const wkArr = Array.isArray(a.obj.works) ? a.obj.works : (Array.isArray(a.obj.records) ? a.obj.records : [])
          const coveredSids = new Set()
          for (const e of selected) {
            const sref = e.obj && e.obj.sessionRef
            if (sref && sref.sessionId) coveredSids.add(sref.sessionId)
            if (e.obj && Array.isArray(e.obj.sourceChain)) {
              for (const sc of e.obj.sourceChain) {
                const mm = String(sc || '').match(/^(.+)@\d+/)
                if (mm) coveredSids.add(mm[1])
              }
            }
          }
          if (coveredSids.size) {
            for (const w of wkArr.slice()) {
              if (!w || !w.sid) continue
              if (w.sid.indexOf('period:') === 0) continue  // 周期指向段不参与下沉
              if (coveredSids.has(w.sid)) {
                // 该会话被本次周期覆盖 → 归档完整文本到补充同名文件后移除（B 下沉）
                await archiveWorksSegment(w.sid, w, { agent: a.ownerKey, session: w.sid, turn: 0 }).catch(() => {})
                const wIdx = wkArr.indexOf(w)
                if (wIdx >= 0) wkArr.splice(wIdx, 1)
              }
            }
            if (Array.isArray(a.obj.works)) a.obj.works = wkArr
            else a.obj.records = wkArr
          }
        } catch (eB) { console.error('[motion-memory] 周期下沉归档失败: ' + ((eB && eB.message) || eB)) }
        if (Array.isArray(a.obj.works)) {
          a.obj.works.unshift(entry)
        } else {
          a.obj.records = a.obj.records || []
          a.obj.records.unshift({ op: 'prepend', key: 'period:' + periodRel, text: entry.text, refs: entry.refs, at: entry.updatedAt })
        }
        const recMax = Math.max(1, Number(cfg().indexScore && cfg().indexScore.maxRefs) || 50)
        const arr = Array.isArray(a.obj.works) ? a.obj.works : (a.obj.records || [])
        if (arr.length > recMax) { if (Array.isArray(a.obj.works)) a.obj.works = arr.slice(0, recMax); else a.obj.records = arr.slice(0, recMax) }
        a.obj.updatedAt = nowIso()
        a.obj.schemaVersion = 4
        await writeJson(a.path, a.obj)
      }
      if (acts.length) await refreshActiveIndex().catch(() => null)
    } catch (err) { console.error('[motion-memory] 周期总结活跃记录链更新失败: ' + (err && err.message)) }
    return { ok: true, text: '周期总结完成（' + (trigger === 'manual' ? '手动' : '自动') + '）：\n' + (res.content || '（空）') + '\n\n覆盖 ' + selected.length + ' 条事件，溯源 ' + (res.chain.length ? res.chain.join(' → ') : '（无）'), data: { path: relOf(path), trigger, covered: selected.length } }
  }
  // 定时调度：启动时注册 interval（最小 1 分钟测试用；正式按配置周期）
  const timerSvc = ctx.get('timer')
  if (timerSvc) {
    // 每分钟检查一次：① 界面"立刻执行"请求文件（批4）；② 周期重审请求；③ 周期到期；④ 溢出缓存兜底载回
    timerSvc.interval(() => {
      // ⑤ 周期相关配置热重载（设置页改方案/间隔/economize 后，无对话活动时定时器也能用最新配置）
      reloadConfigIfChanged().catch(() => {})
      // ④ 溢出落盘缓存兜底载回（跨重启恢复；队列忙时跳过）
      sweepSpilledQueues().catch(() => {})
      // ⓪① 模型重新总结请求：_admin/turn-resummarize-request.json（轮次页"模型重新总结"）
      checkTurnResummarizeRequest().then(async resummarized => {
        if (resummarized) return
        // ⓪② 方案升级请求：_admin/period-upgrade-request.json（周期页"确认升级方案"）
        return checkPeriodUpgradeRequest().then(async upgradeHandled => {
          if (upgradeHandled) return
          // ① 界面触发：_admin/period-run-request.json 存在 → 立即执行（管理员身份）
          return checkPeriodRunRequest().then(async handled => {
            if (handled) return
            // ② 周期重审请求：_admin/period-rereview-request.json（对话页"记忆"页签）
            const rereviewHandled = await checkPeriodRereviewRequest().catch(() => false)
            if (rereviewHandled) return
            // ③ 周期到期自动执行（按智能体分类：统一时间周期，每个目标智能体各生成自己的周期总结）
            return periodDue().then(due => {
              if (due) {
                periodTargets().then(targets => {
                  for (const ow of targets) {
                    scheduleWork('period', () => runPeriodSummary({ agent: 'memory-admin', session: '', turn: 0 }, false, false, { ownerKey: ow }), '定时周期总结（' + ow + '）').catch(e => console.error('[motion-memory] 周期总结失败 ' + ow + ': ' + (e && e.message)))
                  }
                }).catch(() => {})
              }
            })
          })
        })
      }).catch(() => {})
    }, 60000)
  }
  // 周期重审请求检测（mm-settings mm-period-rereview 写请求文件；模式 current/at-time）
  async function checkPeriodRereviewRequest() {
    try {
      const reqPath = p(root(), '_admin', 'period-rereview-request.json')
      const req = await readJson(reqPath)
      if (!req || isTombstone(req)) return false
      const rel = req.rel
      const mode = (req.mode) || 'current'
      const path = p(root(), rel)
      const o = await readJson(path)
      if (!o || isTombstone(o)) { await tombstone(reqPath, reqPath); return true }
      const ownerKey = (o.createdBy && o.createdBy.agent) || 'memory-admin'
      const tMs = parseIso(o.createdAt) || Date.now()
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
      const res = await scheduleWork('admin', () => adminLlm(prompt, resolveModelConfig(null), 3), '周期重审 ' + rel)
      if (res.ok) {
        const parsed = parseAdminJson(res.text)
        const newContent = (parsed && parsed.content) ? String(parsed.content) : res.text
        o.content = newContent
        o.history = o.history || []
        o.history.push(histEntry('update', { agent: 'memory-admin', session: '', turn: 0, note: '重新审视（' + (mode === 'at-time' ? '当时活跃' : '当前活跃') + '）：' + ((parsed && parsed.note) || '') }))
        o.updatedAt = nowIso()
        await writeJson(path, o, true)
        console.log('[motion-memory] 周期重审完成：' + rel + '（' + mode + '）')
      } else {
        console.error('[motion-memory] 周期重审失败：' + rel + ' - ' + (res.error || ''))
      }
      await tombstone(reqPath, reqPath)
      return true
    } catch (e) { return false }
  }
  // 界面"模型重新总结"请求检测（mm-settings mm-turn-resummarize 写请求文件；force 重跑该轮）
  async function checkTurnResummarizeRequest() {
    try {
      const reqPath = p(root(), '_admin', 'turn-resummarize-request.json')
      const resultPath = p(root(), '_admin', 'turn-resummarize-result.json')
      const req = await readJson(reqPath)
      if (!req || isTombstone(req)) return false
      const sid = req.sid
      const turn = req.turn ? Number(req.turn) : 0
      const mode = (req.mode) || 'current'
      let ok = false
      let text = ''
      if (sid && turn) {
        const r = await runTurnSummary(sid, turn, { agent: 'memory-admin', session: sid, turn, force: true, ownerKey: ownerKeyOf(sid), mode })
          .catch(e => ({ ok: false, text: String((e && e.message) || e) }))
        ok = !!(r && r.ok)
        text = (r && r.text) || ''
        console.log('[motion-memory] 模型重新总结' + (ok ? '完成' : '失败') + '：' + String(sid).slice(-8) + '@' + turn + (ok ? '' : '（' + text + '）'))
        // 成功后：删除该轮在无模型整理区的引用（模型总结已生成事件替代无模型记录）
        if (ok) await removeNoModelTurnRef(sid, turn)
      } else {
        text = '缺少会话或轮次'
      }
      // 写结果文件供界面轮询（成功/失败都写；界面据此刷新或报错）
      await writeJson(resultPath, { at: nowIso(), sid, turn, ok, text, trigger: 'settings-ui' })
      await tombstone(reqPath, reqPath)
      return true
    } catch (e) { return false }
  }
  // 删除无模型整理区中某轮次的引用（模型总结成功后：无模型记录被事件替换）
  async function removeNoModelTurnRef(sid, turn) {
    try {
      const path = p(noModelDir(), sanitizeFile(sid) + '.json')
      const o = await readJson(path)
      if (!o || isTombstone(o)) return
      const ref = sid + '@' + turn
      let changed = false
      if (o.content) {
        const before = String(o.content).split('\n')
        const after = before.filter(l => l.indexOf(ref) < 0)
        if (after.length !== before.length) { o.content = after.join('\n'); changed = true }
      }
      if (o.links && Array.isArray(o.links.children)) {
        const before = o.links.children.length
        o.links.children = o.links.children.filter(l => !(l && l.kind === 'turn' && l.ref === ref))
        if (o.links.children.length !== before) changed = true
      }
      if (Array.isArray(o.sourceChain)) {
        const before = o.sourceChain.length
        o.sourceChain = o.sourceChain.filter(s => s !== ref)
        if (o.sourceChain.length !== before) changed = true
      }
      const empty = (!o.content || !String(o.content).trim()) && (!o.links || !o.links.children || !o.links.children.length)
      if (empty) {
        await tombstone(path, path)
      } else if (changed) {
        o.updatedAt = nowIso()
        o.history = o.history || []
        o.history.push(histEntry('update', { agent: 'memory-admin', session: sid, turn, note: '模型重新总结成功，删除无模型轮次引用 ' + ref }))
        o.history = o.history.slice(-50)
        await writeJson(path, o)
      }
    } catch (e) { console.error('[motion-memory] 删除无模型轮次引用失败: ' + (e && e.message)) }
  }
  // 界面"确认升级方案"请求检测（mm-settings mm-period-upgrade 写请求文件）
  async function checkPeriodUpgradeRequest() {
    try {
      const reqPath = p(root(), '_admin', 'period-upgrade-request.json')
      const req = await readJson(reqPath)
      if (!req || isTombstone(req)) return false
      const rel = req.rel
      const newScope = req.scope ? Number(req.scope) : 0
      const newDetail = req.scopeDetail
      if (!rel || ![1, 2, 3].includes(newScope)) { await tombstone(reqPath, reqPath); return true }
      const path = p(root(), rel)
      const o = await readJson(path)
      if (!o || isTombstone(o)) { await tombstone(reqPath, reqPath); return true }
      // 原文件时间范围：优先文件 range，否则按 createdAt 前后各一个周期跨度
      let from = (o.range && o.range.from) || 0
      let to = (o.range && o.range.to) || 0
      if (!from && !to) {
        const t = parseIso(o.createdAt) || Date.now()
        const span = 30 * 86400000
        from = t - span; to = t + span
      }
      await scheduleWork('period', () => runPeriodSummary({ agent: 'memory-admin', session: state.lastSid || '', turn: 0 }, true, false, {
        scope: newScope, scopeDetail: newDetail, from, to, ignoreSummarized: true,
      }), '周期方案升级 ' + rel).then(r => {
        console.log('[motion-memory] 周期方案升级完成：' + rel + ' → 方案' + newScope + (r && r.ok ? '' : '（失败：' + (r && r.text) + '）'))
      }).catch(e => console.error('[motion-memory] 周期方案升级失败: ' + (e && e.message)))
      await tombstone(reqPath, reqPath)
      return true
    } catch (e) { return false }
  }
  // 界面"立刻执行"请求检测（mm-settings period-run 写请求文件）
  async function checkPeriodRunRequest() {
    try {
      const reqPath = p(root(), '_admin', 'period-run-request.json')
      const req = await readJson(reqPath)
      if (!req || isTombstone(req)) return false
      const resetTimer = !!req.resetTimer
      const targets = await periodTargets().catch(() => [])
      const results = []
      for (const ow of targets) {
        const r = await scheduleWork('period', () => runPeriodSummary({ agent: 'memory-admin', session: '', turn: 0 }, true, false, {
          scope: req.scope, scopeDetail: req.scopeDetail, from: req.from, to: req.to,
          ignoreSummarized: !!req.ignoreSummarized, truncK: req.truncK, ownerKey: ow,
        }), '界面周期总结（' + ow + '）').catch(e => ({ ok: false, text: String((e && e.message) || e) }))
        results.push(ow + '：' + ((r && r.text) || '（无返回）'))
      }
      // 处理完移除请求文件（tombstone）
      await tombstone(reqPath, reqPath)
      console.log('[motion-memory] 界面周期总结请求已执行（' + targets.length + ' 个智能体）' + (resetTimer ? '（重置倒计时）' : '') + '：' + results.join('；'))
      return true
    } catch (e) { return false }
  }
  // memory_period_run：立即执行 + resetTimer
  // 权限：记忆管理员（界面/定时）放行；会话 agent 调用需用户同意（阶段4 闸门）
  // useSessionModel=true 时用会话主力模型执行（通常强于管理员配置的小模型）
  async function memCmdPeriodRun(args, meta) {
    const force = !(args && args.resetTimer)
    const useSessionModel = !!(args && args.useSessionModel)
    const agent = (meta && meta.agent) || ''
    // 权限闸门：memory-admin（界面/定时）放行；其他 agent 会话触发需用户同意
    const isAdmin = String(agent) === 'memory-admin' || String(agent) === 'preset:memory-admin' || !agent
    if (!isAdmin) {
      let approved = false
      try {
        const approval = ctx.get('approval')
        const execAgent = meta && meta._execAgent
        if (approval && typeof approval.request === 'function' && execAgent) {
          const outcome = await approval.request({
            agent: execAgent,
            toolName: 'memory_period_run',
            reason: '请求执行一次周期总结' + (useSessionModel ? '（使用会话主力模型）' : '（使用管理员模型）') + (args && args.scope ? '（方案' + args.scope + '）' : '') + '。周期总结会压缩未总结的事件记忆为中长期记忆。是否允许？',
          })
          approved = !!(outcome && (outcome.approved || outcome.result === 'approved'))
        }
      } catch (e) { approved = false }
      if (!approved) return { ok: false, text: '周期总结需用户同意：请在设置界面手动触发，或用户批准后重试（本会话可用 memory cmd=period_run useSessionModel=true 用主力模型执行）' }
    }
    const targets = await periodTargets().catch(() => [])
    const results = []
    for (const ow of targets) {
      const r = await scheduleWork('period', () => runPeriodSummary(meta, force, useSessionModel, {
        scope: args && args.scope,
        scopeDetail: args && args.scopeDetail,
        from: args && args.from,
        to: args && args.to,
        ignoreSummarized: !!(args && args.ignoreSummarized),
        truncK: args && args.truncK,
        ownerKey: ow,
      }), '周期总结（手动·' + ow + '）').catch(e => ({ ok: false, text: String((e && e.message) || e) }))
      results.push(ow + '：' + ((r && (r.text || (r.ok ? '已执行' : '失败'))) || '（无返回）'))
    }
    return { ok: true, text: '周期总结（' + targets.length + ' 个智能体）：\n' + results.join('\n') }
  }
  async function memCmdPeriodStatus(args, meta) {
    const pc = periodCfg()
    const last = await lastAutoPeriodFile()
    const due = await periodDue()
    // 未总结事件数
    let pending = 0
    for (const f of await listFiles(dailyBaseDir(), true)) {
      const rel = relOf(f.path)
      if (!isEventRel(rel)) continue
      if (rel.indexOf('周期记忆/') >= 0) continue
      const o = await readJson(f.path)
      if (o && !isTombstone(o) && o.kind === 'event' && !o.summarizedAt) pending++
    }
    const lines = ['【定时周期】' + (pc.enabled ? '已启用' : '关闭') + '：间隔 ' + (pc.intervalDays || 1) + '日' + (pc.intervalHours ? ' ' + pc.intervalHours + '时' : '')]
    lines.push('上次 auto 周期：' + (last ? isoStr(last.t) : '（无，首次触发）'))
    lines.push('当前状态：' + (due ? '到期（可执行）' : '未到期'))
    lines.push('未总结事件：' + pending + ' 条')
    lines.push('影响度：' + (pc.impactCount ? '固定 ' + pc.impactCount + ' 条' : '前 ' + (pc.impactPercent || 100) + '%') + '，方案 ' + ((pc.scope || 1)) + '（' + (scopeLabelOf(pc.scope, pc.scopeDetail)) + '）')
    lines.push('最近素材跳过：' + (pc.skipRecentDays || 14) + ' 天（最近素材不总结）')
    return { ok: true, text: lines.join('\n'), data: { enabled: pc.enabled, last: last ? isoStr(last.t) : null, due, pending, scope: pc.scope || 1, scopeDetail: pc.scopeDetail || SCOPE_DEFAULTS[pc.scope || 1] } }
  }

  return {
    periodCfg, runPeriodSummary, sessionTurnsOf, removeNoModelTurnRef,
    memCmdPeriodRun, memCmdPeriodStatus,
  }
}
