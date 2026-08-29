/**
 * motion-memory 对话跟踪域模块（拆分自 motion-memory.js，C 档第六刀）
 *
 * 间隔触发轮次总结（runTurnSummary/runTurnSummaryTask）+ 会话聚合文件写入
 * （appendTurnToAggregate）+ 无模型降级（trackNoModelRecord）+ 懒归档（lazyArchive）
 * + turn/end 触发钩子（ctx.on，工厂内自注册）。
 * 依赖经 createTrack(core, deps) 注入：core 为共享运行时；deps 提供
 * { scheduleWork, resolveModelConfig, chunkCompress, readStepRange, stepsToText,
 *   readTurnUserText, restoreWorksSegment, ensureSessionWorkSegment,
 *   readAgentActive, writeActive, withSourceRef, buildSessionRef,
 *   reloadConfigIfChanged }。
 */

import { estimateTokens } from './chunker.mjs'
import { histEntry, newKeywordObj, sanitizeFile } from './memory-objects.mjs'
import { pad, ymPath, isEventRel, parseIso } from './time-utils.mjs'
import { reconstructAt } from './text-utils.mjs'

export function createTrack(core, deps) {
  const {
    state, ctx, p, root, relOf, nowIso, parseIso, uid,
    readJson, writeJson, writeJsonCAS, listFiles, isTombstone, tombstone,
    cfg, adminCfg, importantDir, archiveBaseDir, dailyBaseDir, noModelDir,
    uniquePath, findImportant, lastOpTime, sessionPresetOf, sessionPresetOfAsync,
  } = core
  const {
    scheduleWork, resolveModelConfig, chunkCompress,
    readStepRange, stepsToText, readTurnUserText,
    restoreWorksSegment, ensureSessionWorkSegment, readAgentActive, writeActive,
    withSourceRef, buildSessionRef, reloadConfigIfChanged,
  } = deps || {}

  // ═════════════════════════════════════════════════════════════════════
  // 阶段2：对话跟踪模式（间隔触发总结）
  // ═════════════════════════════════════════════════════════════════════
  // 配置：admin.track = { enabled, interval(默认5轮), startTurn(默认0不限), economize: none|output|truncated, truncK(默认2) }
  // 触发：turn/end → 距上次总结 ≥ interval 轮 → 读本轮步骤 → 切割 → 压缩引擎
  //       → 写事件记忆（links 指向 turn-step）+ 教训条目增量更新
  function trackCfg() {
    const c = cfg()
    if (!c.admin) c.admin = {}
    if (!c.admin.track) c.admin.track = { enabled: false, interval: 5, economize: 'none', truncK: 2, startTurn: 0, refPrecision: 'turn', injectActive: false }
    if (!c.admin.track.refPrecision) c.admin.track.refPrecision = 'turn'
    // 块级委派开关迁到模型结构体（track.model.delegateBlocks，模型高级设置），默认关（仅工具模型不外派）
    if (c.admin.track.model && c.admin.track.model.delegateBlocks === undefined) c.admin.track.model.delegateBlocks = false
    return c.admin.track
  }
  // 切段规则：含工具调用的 step 独立成段；连续纯文本 step 合并；末尾无工具的报告段独立
  function segmentSteps(steps) {
    const segs = []
    let cur = null
    for (const s of steps) {
      const hasTool = (s.parts || []).some(p => p.kind === 'tool-call' || p.kind === 'tool-result')
      const isReport = !hasTool && (s.parts || []).length > 0
      if (hasTool) {
        if (cur) { segs.push(cur); cur = null }
        segs.push({ steps: [s], kind: 'tool' })
      } else if (isReport) {
        if (!cur) cur = { steps: [], kind: 'report' }
        cur.steps.push(s)
      }
    }
    if (cur) segs.push(cur)
    return segs
  }
  // 节约模式裁剪：output=只看用户+assistant文本；truncated=用户+末尾 truncK k tokens
  async function applyEconomize(sid, turn, steps, mode, truncK) {
    // mode 兼容：字符串（'none'/'output'/'truncated'）或数组（多选叠加，如 ['output','truncated']）
    const modes = Array.isArray(mode) ? mode : (mode && mode !== 'none' ? [mode] : [])
    if (!modes.length) return { steps, userText: await readTurnUserText(sid, turn, 4096) }
    const dropTools = modes.indexOf('output') >= 0 || modes.indexOf('truncated') >= 0
    const filtered = []
    for (const s of steps) {
      const out = { step: s.step, parts: [], usage: s.usage }
      for (const p of (s.parts || [])) {
        if (p.kind === 'assistant') out.parts.push(p)
        // output/truncated 都丢弃工具调用与结果
      }
      if (out.parts.length) filtered.push(out)
    }
    let userText = await readTurnUserText(sid, turn, 4096)
    if (modes.indexOf('truncated') >= 0) {
      const k = Math.max(0, Number(truncK) || 2)
      const capChars = k * 1000 // 1k token ≈ 1000 中文字符
      const all = stepsToText(filtered, true)
      userText = (userText ? userText + '\n' : '') + (all.length > capChars ? '…（截断，保留末尾）\n' + all.slice(-capChars) : all)
      return { steps: null, userText, truncated: true }
    }
    return { steps: dropTools ? filtered : steps, userText }
  }
  // 按 会话@轮次(:step) 查找已关联的记忆文件（links.children turn ref / sourceChain 匹配）
  async function findMemoriesByRef(ref) {
    const hits = []
    const target = String(ref || '')
    if (!target) return hits
    const match = (r) => r === target || r.startsWith(target + ':') || target.startsWith(r + ':')
    const scan = async (dir, recursive, zone) => {
      for (const f of await listFiles(dir, recursive)) {
        const o = await readJson(f.path)
        if (!o || isTombstone(o)) continue
        const refs = []
        if (o.links && Array.isArray(o.links.children)) {
          for (const l of o.links.children) if (l && l.kind === 'turn' && l.ref) refs.push(String(l.ref))
        }
        if (Array.isArray(o.sourceChain)) {
          for (const s of o.sourceChain) if (s && String(s).indexOf('@') >= 0) refs.push(String(s))
        }
        if (refs.some(match)) hits.push({ zone, title: o.title || '', path: f.path, ref: relOf(f.path) })
      }
    }
    await scan(importantDir(), false, 'important')
    await scan(archiveBaseDir(), true, 'archive')
    await scan(p(root(), '记忆累积', '周期记忆'), true, 'period')
    // v5 事件区定向扫描：按 年/月 目录从新到旧翻，文件名带日（DD_）或旧日目录；命中即停（最多翻 scanMonths 个月）
    await scanDailyRecent(target, match, hits)
    await scan(noModelDir(), true, 'no-model')
    return hits
  }
  // 事件区按月份倒序定向扫描（配合 v5 年月两级目录）：最近 scanMonths 个月优先，命中即停
  const scanMonths = Math.max(1, Number(cfg().indexScore && cfg().indexScore.scanMonths) || 3)
  async function scanDailyRecent(target, match, hits) {
    try {
      // 收集 年/月 目录（记忆累积/<YYYY>/<MM>，排除 周期记忆/补充/重要/必要/无模型）
      const now = new Date()
      const months = []
      for (let i = 0; i < scanMonths; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
        months.push(String(d.getFullYear()) + '/' + pad(d.getMonth() + 1))
      }
      for (const ym of months) {
        const dir = p(dailyBaseDir(), ym)
        const files = await listFiles(dir, false).catch(() => [])
        // 倒序（同月内按文件名带日排序，新的在前）
        files.sort((a, b) => (b.name < a.name ? -1 : b.name > a.name ? 1 : 0))
        for (const f of files) {
          const rel = relOf(f.path)
          if (!isEventRel(rel)) continue
          const o = await readJson(f.path)
          if (!o || isTombstone(o)) continue
          const refs = []
          if (o.links && Array.isArray(o.links.children)) {
            for (const l of o.links.children) if (l && l.kind === 'turn' && l.ref) refs.push(String(l.ref))
          }
          if (Array.isArray(o.sourceChain)) {
            for (const s of o.sourceChain) if (s && String(s).indexOf('@') >= 0) refs.push(String(s))
          }
          // v5 聚合文件：turns[] 的 turn 引用也加入匹配
          if (Array.isArray(o.turns)) {
            const sref = o.sessionRef && o.sessionRef.sessionId
            for (const t of o.turns) if (t && t.turn && sref) refs.push(sref + '@' + Number(t.turn))
          }
          if (refs.some(match)) {
            hits.push({ zone: 'event', title: o.title || '', path: f.path, ref: relOf(f.path) })
            // 精确命中目标引用 → 直接返回（聚合文件已含目标轮次，不必继续扫旧月份）
            if (refs.some(r => r === target || r.startsWith(target + ':') || target.startsWith(r + ':'))) return
          }
        }
      }
    } catch (e) { console.error('[motion-memory] scanDailyRecent 失败: ' + (e && e.message)) }
  }
  // 持久去重：按「会话@轮次」引用查是否已有记忆文件覆盖（跨重启/清缓存仍有效）
  // v5 会话聚合：优先读 记忆累积/YYYY/MM/<sid>.json 聚合文件的 links.children（轮次级精确匹配）；
  // 兜底 findMemoriesByRef（旧格式每轮一文件）
  async function hasTrackSummary(sid, turn) {
    try {
      // 当前月聚合文件
      const aggPath = p(dailyBaseDir(), ymPath(new Date()), sanitizeFile(sid) + '.json')
      const agg = await readJson(aggPath)
      if (agg && !isTombstone(agg) && agg.kind === 'event') {
        const children = (agg.links && agg.links.children) || []
        if (children.some(l => l && l.kind === 'turn' && l.ref === sid + '@' + turn)) return true
        const turns = agg.turns || []
        if (turns.some(t => t && t.turn === turn)) return true
        // 聚合文件存在但该轮次不在 → 未总结（聚合文件只累积有内容的轮次）
        return false
      }
      const hits = await findMemoriesByRef(sid + '@' + turn)
      return hits.length > 0
    } catch (e) {}
    return false
  }
  // 已总结轮次记录（state 持久，仅防同一轮重复触发；间隔/起始判断走会话文件持久化基准）
  state.trackLastTurn = state.trackLastTurn || new Map()
  // 读取会话聚合文件的跟踪基准（trackMeta 最后一条 + 已总结轮次末尾）：
  // 无聚合文件时用全局配置 + lastTurn=0（首次即总结）。跨重启/切会话不丢。
  async function readTurnTrackBasis(sid) {
    const tc = trackCfg()
    let startTurn = Math.max(0, Number(tc.startTurn) || 0)
    let interval = Math.max(0, Number(tc.interval) || 0)
    let lastTurn = 0
    try {
      const aggPath = p(dailyBaseDir(), ymPath(new Date()), sanitizeFile(sid) + '.json')
      const agg = await readJson(aggPath)
      if (agg && !isTombstone(agg) && agg.kind === 'event') {
        const tm = Array.isArray(agg.trackMeta) && agg.trackMeta.length ? agg.trackMeta[agg.trackMeta.length - 1] : null
        if (tm) {
          startTurn = Math.max(0, Number(tm.startTurn) || 0)
          interval = Math.max(0, Number(tm.interval) || 0)
        }
        const turns = Array.isArray(agg.turns) ? agg.turns : []
        if (turns.length) lastTurn = Number(turns[turns.length - 1].turn) || 0
      }
    } catch (e) {}
    return { startTurn, interval, lastTurn }
  }
  async function runTurnSummary(sid, turn, meta) {
    const tc = trackCfg()
    if (!tc.enabled) return { ok: false, text: '对话跟踪未启用' }
    const force = !!(meta && meta.force)
    // 起始轮次/触发间隔按该会话持久化基准判断（记录在会话聚合文件 trackMeta，配置变化会追加新条）
    const basis = await readTurnTrackBasis(sid)
    if (basis.startTurn > 0 && turn < basis.startTurn && !force) {
      return { ok: false, text: '未到起始轮次（第 ' + turn + ' 轮，起始 ' + basis.startTurn + '）' }
    }
    if (basis.lastTurn > 0 && !force && basis.interval > 0 && turn - basis.lastTurn < basis.interval) {
      return { ok: false, text: '间隔未到（第 ' + turn + ' 轮，基准 ' + basis.lastTurn + '，间隔 ' + basis.interval + ' 轮）' }
    }
    // 持久去重：查事件记忆文件判断该轮是否已总结（跨重启/清缓存仍有效）
    if (!force && await hasTrackSummary(sid, turn)) {
      state.trackLastTurn.set(sid, turn)
      return { ok: false, text: '轮次 ' + turn + ' 已有对话跟踪总结（事件记忆已存在），跳过' }
    }
    // 触发后立即记基准（乐观），防止任务排队期间重复触发同一轮
    state.trackLastTurn.set(sid, turn)
    const gap = Math.max(0, Number(tc.interval) || 0)
    // 重活（读步骤→模型总结→写盘）入全局队列：多 agent 并发时一次只跑一个总结任务
    return scheduleWork('track', () => runTurnSummaryTask(sid, turn, meta, gap), '对话跟踪 ' + String(sid).slice(-8) + '@' + turn, { type: 'track', sid, turn, meta })
  }
  // 更新会话聚合文件的跟踪配置记录（trackMeta 为数组）：首次总结记录起始轮次+触发间隔；
  // 之后若配置（间隔/起始）与最后一条不一致则追加新条（"换回继续对话，检查到不一致，增加新条记录轮次"）
  function bumpAggTrackMeta(obj, turn, tc) {
    obj.trackMeta = Array.isArray(obj.trackMeta) ? obj.trackMeta : []
    const last = obj.trackMeta.length ? obj.trackMeta[obj.trackMeta.length - 1] : null
    const interval = Math.max(0, Number(tc.interval) || 0)
    // 起始轮次语义：该跟踪段从哪一轮开始生效——显式配置的 startTurn 优先，否则用触发轮次。
    // （以前默认 0 会导致"启用跟踪前的老轮次也被算进跟踪设定内"，轮次页显示失真）
    const startTurn = Math.max(0, Number(tc.startTurn) || 0, turn)
    if (!last || last.interval !== interval || last.startTurn !== startTurn) {
      obj.trackMeta.push({ startTurn, interval, at: nowIso(), turn })
      if (obj.trackMeta.length > 20) obj.trackMeta = obj.trackMeta.slice(-20)
    }
  }
  // 对话跟踪任务主体（排队执行）
  async function runTurnSummaryTask(sid, turn, meta, gap) {
    const tc = trackCfg()
    // 程序保证本会话工作段存在：优先尝试复原（周期下沉后旧会话复活）→ 复原失败才建空白段
    const ownerKey0 = (meta && meta.ownerKey) || (meta && meta.agent) || sid
    try {
      const rst = await restoreWorksSegment(ownerKey0, sid, meta)
      if (rst && rst.ok) console.log('[motion-memory] 会话工作复原：' + String(sid).slice(-8) + ' ← ' + rst.path)
      else if (!(rst && rst.ok)) await ensureSessionWorkSegment(ownerKey0, sid, meta)
    } catch (e1) { await ensureSessionWorkSegment(ownerKey0, sid, meta).catch(() => {}) }
    // 读本轮步骤
    const steps = await readStepRange(sid, turn, 1, undefined)
    if (!steps.length) return { ok: false, text: '轮次 ' + turn + ' 无步骤内容' }
    // 节约模式
    const eco = await applyEconomize(sid, turn, steps, tc.economize, tc.truncK)
    // 模型配置结构体：对话跟踪子实例覆盖全局（上下文/百分比/输出/并发/extraJson）
    const mc = resolveModelConfig(tc.model)
    // 历史身份识别：模型操作=模型名（provider/model）；无模型=工具名 memory_track（用户手动操作=user+memory-admin）
    const trackWho = (mc && mc.provider && mc.model) ? (mc.provider + '/' + mc.model) : 'memory_track'
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
    if (!opts.provider || !opts.model) {
      // 无模型模式：不调模型，记录会话全部轮次用户消息到无模型整理区（保持原始指向，供周期总结/模型转正）
      return trackNoModelRecord(sid, turn, meta)
    }
    // 切段 → 组装 items（每段一个 item；id 按 refPrecision 决定粒度：turn=整轮 / step=步骤段）
    const refPrecision = (tc.refPrecision === 'step') ? 'step' : 'turn'
    const segs = eco.steps ? segmentSteps(eco.steps) : []
    let items = []
    if (segs.length) {
      items = segs.map(seg => ({
        id: refPrecision === 'step'
          ? sid + '@' + turn + ':step' + seg.steps[0].step + (seg.steps.length > 1 ? '-' + seg.steps[seg.steps.length - 1].step : '')
          : sid + '@' + turn,
        text: stepsToText(seg.steps, true),
      }))
    } else if (eco.userText) {
      // truncated 模式：id 归一为 sid@turn（:truncated 是内部标记，不应进入 sourceChain——否则引用解析失败）
      items = [{ id: sid + '@' + turn, text: eco.userText }]
    }
    if (!items.length) return { ok: false, text: '无内容可总结' }
    // B-2：注入本会话现有工作信息（works 里 sid 匹配的段落）+ 会话跟踪状态，
    // 供模型判断 op（append/merge/replace/prepend）。程序已保证段存在（空白段=新会话首次总结）
    try {
      const ownerKey2 = (meta && meta.ownerKey) || (meta && meta.agent) || sid
      const act2 = await readAgentActive(ownerKey2)
      const works2 = Array.isArray(act2.obj && act2.obj.works) ? act2.obj.works : []
      const cur = works2.find(w => w && w.sid === sid)
      // 会话是否被跟踪：聚合文件存在且 trackMeta 有记录 → 已被对话跟踪；否则模型需承担部分跟踪职责
      let trackedStatus = '未被跟踪'
      try {
        const aggPathT = p(dailyBaseDir(), ymPath(new Date()), sanitizeFile(sid) + '.json')
        const aggT = await readJson(aggPathT)
        if (aggT && !isTombstone(aggT) && aggT.kind === 'event' && Array.isArray(aggT.trackMeta) && aggT.trackMeta.length) trackedStatus = '已被跟踪（跟踪基准见聚合文件 trackMeta）'
      } catch (e6) {}
      if (cur && cur.text && String(cur.text).trim()) {
        // 软限制（总结摘要字数 summaryCharsK k token）：正文（剥掉 md 超链接）超预算 → 保留链接 + 关键句 + 注明"完整内容见链接"；
        // 不硬截断（允许略超），输出上限由 outputTokens 兜底
        let workText = String(cur.text)
        const charsK2 = Math.max(1, Number(cfg().summaryCharsK) || 2)
        const linkRe2 = /\[[^\]]*\]\([^)]*\)/g
        const bodyTokens = estimateTokens(workText.replace(linkRe2, ''), adminCfg().langTokens)
        let injectNote = ''
        if (bodyTokens > charsK2 * 1000) {
          const links2 = (workText.match(linkRe2) || []).join(' ')
          const body2 = workText.replace(linkRe2, '').trim()
          const keySent = body2.slice(0, 400)
          workText = [links2 ? '【指向】' + links2 : '', keySent ? '【关键句】' + keySent : '', '（完整内容见上述链接指向的原文 会话@轮次，当前仅注入前 ' + charsK2 + 'k token）'].filter(Boolean).join('\n')
          injectNote = '（注入已按总结摘要字数 ' + charsK2 + 'k token 截取，完整内容见链接指向的原文）'
        }
        items.unshift({ id: sid + '@' + turn + ':curwork', text: '【本会话现有工作信息】\n' + workText + '\n\n【会话跟踪状态】' + trackedStatus + '。请参考上述"现有工作信息"判断本轮进展的 op（更新/合并/覆盖/新增）。字数限制：' + charsK2 + 'k token（md 超链接不计入）；你的输出不得超过输出上限（' + (Number(adminCfg().outputTokens) || 4000) + ' token）。保持内容精简。' + injectNote })
      } else if (cur) {
        // 程序已建空白段（新会话首次有效总结）：提示填充本会话工作段落（段已存在，无需 prepend 新建）
        items.unshift({ id: sid + '@' + turn + ':newwork', text: '【本会话现有工作信息】当前为空（本会话首次总结，程序已为本会话创建空白工作段）。\n【会话跟踪状态】' + trackedStatus + '。\n请按工作事情和进度总结本轮内容，写入本会话的工作段落（op 用 append 更新已有空白段即可），带 轮次/轮次+步 指向对应信息。字数限制：' + (Math.max(1, Number(cfg().summaryCharsK) || 2)) + 'k token（md 超链接不计入）；你的输出不得超过输出上限（' + (Number(adminCfg().outputTokens) || 4000) + ' token）。保持内容精简。' })
      } else {
        // 兜底：程序未建段（异常路径）→ 提示创建
        items.unshift({ id: sid + '@' + turn + ':newwork', text: '【本会话现有工作信息】无 —— 本次为全新会话/新窗口，当前活跃中还没有本会话的"会话工作"段落。请用 op="prepend" 创建本会话的工作段落（插到最前，旧的往后顶），并保持内容精简。\n【会话跟踪状态】' + trackedStatus })
      }
    } catch (e4) {}
    // 空白段 + 无模型整理区有该会话内容 → 读取无模型内容作为推断素材（填充空白段后移除无模型文件）
    try {
      const act3 = await readAgentActive((meta && meta.ownerKey) || (meta && meta.agent) || sid)
      const works3 = Array.isArray(act3.obj && act3.obj.works) ? act3.obj.works : []
      const cur3 = works3.find(w => w && w.sid === sid)
      const isBlank = !(cur3 && cur3.text && String(cur3.text).trim())
      if (isBlank) {
        const nmPath3 = p(noModelDir(), sanitizeFile(sid) + '.json')
        const nm3 = await readJson(nmPath3)
        if (nm3 && !isTombstone(nm3) && nm3.kind === 'no-model' && nm3.content) {
          items.unshift({ id: sid + '@' + turn + ':nomodel', text: '【本会话无模型整理记忆】\n' + String(nm3.content).slice(0, 3000) + '\n\n请基于以上未整理内容推断本会话的工作信息（这些是此前模型不可用时按轮次累积的用户消息引用），总结后写入本会话工作段（op 用 append 更新空白段），并保持内容精简。' })
        }
      }
    } catch (e7) {}
    // 双模式：重新总结时注入活跃记忆作为"态度"上下文（mode=current/at-time；at-time 回溯到该轮次发生时间）
    const mode = (meta && meta.mode) || ''
    if (mode) {
      let activeSummary = ''
      try {
        const ownerKey = (meta && meta.ownerKey) || ''
        if (ownerKey) {
          const act = await readAgentActive(ownerKey)
          if (mode === 'at-time') {
            let tMs = 0
            try {
              const evs = await readSessionEvents(sid)
              for (const e of evs) {
                if (e && e.type === 'turn/start' && e.data && e.data.turn === turn && e.time) { tMs = Number(e.time) || 0; break }
              }
            } catch (e2) {}
            activeSummary = reconstructAt({ content: (act.obj && act.obj.summary) || '', history: (act.obj && act.obj.history) || [] }, tMs || Date.now(), parseIso)
          } else {
            activeSummary = (act.obj && act.obj.summary) || ''
          }
        }
      } catch (e3) {}
      if (activeSummary) {
        items.unshift({ id: sid + '@' + turn + ':active', text: '【' + (mode === 'at-time' ? '当时' : '当前') + '活跃记忆】\n' + activeSummary + '\n\n请以上述活跃记忆的态度总结下面的轮次内容。' })
      }
    }
    // 压缩引擎（meta 携带 refPrecision，summarizeChunk 据此决定提示词精度；delegateBlocks 控制块级委派，来自工具模型结构体）
    const res = await chunkCompress(items, opts, Object.assign({}, meta, { refPrecision, delegateBlocks: !!(tc.model && tc.model.delegateBlocks) }), '对话跟踪 会话 ' + sid + ' 轮次 ' + turn)
    if (!res.ok) {
      // 总结失败 → 走无模型整理流程（用户要求：失败也在轮次页显示，标注"模型总结失败"）
      await trackNoModelRecord(sid, turn, Object.assign({}, meta, { failNote: res.error || '模型总结失败' }))
      return { ok: false, text: '总结失败，已转无模型记录：' + res.error }
    }
    if (res.allSkipped || !res.content) {
      state.trackLastTurn.set(sid, turn)
      return { ok: true, text: '轮次 ' + turn + ' 判定无需总结（compress=false）', skipped: true }
    }
    // 写事件记忆（v5 会话聚合：每会话一个文件，轮次追加；links.children 累积多条 turn）
    const d = new Date()
    const dir = ymPath(d)
    const me = { agent: meta && meta.agent, session: sid, turn }
    const evMeta = { agent: (meta && (meta.ownerKey || meta.agent)) || sid, session: sid, turn }
    // 会话聚合文件路径：记忆累积/YYYY/MM/<sid>.json（会话 id 唯一，天然定位）
    const aggPath = p(dailyBaseDir(), dir, sanitizeFile(sid) + '.json')
    const existingAgg = await readJson(aggPath)
    if (existingAgg && !isTombstone(existingAgg) && existingAgg.kind === 'event') {
      // 已存在：追加本轮次（content 分段累积 + children 加 turn 引用）
      existingAgg.links = existingAgg.links || { parents: [], children: [] }
      existingAgg.links.children = existingAgg.links.children || []
      if (!existingAgg.links.children.some(l => l && l.kind === 'turn' && l.ref === sid + '@' + turn)) {
        existingAgg.links.children.push({ kind: 'turn', ref: sid + '@' + turn, location: 'session' })
      }
      existingAgg.turns = existingAgg.turns || []
      const turnIdx = existingAgg.turns.findIndex(t => t && t.turn === turn)
      if (turnIdx >= 0) {
        // force 重总结：替换该轮次内容（保持 turns 与 content 一致，不重复拼接）
        existingAgg.turns[turnIdx] = { turn, content: res.content, at: nowIso(), sourceChain: res.chain || [] }
        const segRe = new RegExp('(^|\\n\\n)【轮次 ' + turn + '】[\\s\\S]*?(?=\\n\\n【轮次 |$)')
        existingAgg.content = String(existingAgg.content || '').replace(segRe, (m) => {
          const head = m.indexOf('【轮次 ' + turn + '】') >= 0 ? m.slice(0, m.indexOf('【轮次 ' + turn + '】')) : ''
          return head + '【轮次 ' + turn + '】' + res.content
        })
        existingAgg.history.push(histEntry('update', { agent: trackWho, session: sid, turn, note: '对话跟踪重总结（force）：' + sid + '@' + turn, keep: false }))
      } else {
        existingAgg.turns.push({ turn, content: res.content, at: nowIso(), sourceChain: res.chain || [] })
        existingAgg.content = (existingAgg.content || '') + (existingAgg.content ? '\n\n' : '') +
          '【轮次 ' + turn + '】' + res.content
        existingAgg.history.push(histEntry('update', { agent: trackWho, session: sid, turn, note: '对话跟踪轮次追加：' + sid + '@' + turn, keep: false }))
      }
      // 跟踪配置记录（trackMeta）：配置变化追加新条
      bumpAggTrackMeta(existingAgg, turn, tc)
      existingAgg.updatedAt = nowIso()
      existingAgg.lastModifiedBy = { agent: trackWho, session: sid, turn }
      // CAS 时间快照写（阶段4）：读时记录版本，写入带 expectedVersion 校验——期间被其它窗口/工具改过则重读重试
      const aggVersion = (existingAgg && typeof existingAgg.version === 'number') ? existingAgg.version : 0
      let casAgg = await writeJsonCAS(aggPath, existingAgg, aggVersion)
      if (casAgg && casAgg.conflict) {
        // 冲突：以最新版本为基底重放本轮 turn（覆盖语义安全：本轮内容以最新结果为准）
        const latestAgg = await readJson(aggPath)
        if (latestAgg && !isTombstone(latestAgg) && latestAgg.kind === 'event') {
          latestAgg.turns = latestAgg.turns || []
          const tIdx = latestAgg.turns.findIndex(t => t && t.turn === turn)
          if (tIdx >= 0) latestAgg.turns[tIdx] = { turn, content: res.content, at: nowIso(), sourceChain: res.chain || [] }
          else latestAgg.turns.push({ turn, content: res.content, at: nowIso(), sourceChain: res.chain || [] })
          latestAgg.content = latestAgg.turns.map(t => '【轮次 ' + (t.turn || '?') + '】' + (t.content || '')).join('\n\n')
          latestAgg.history = latestAgg.history || []
          latestAgg.history.push(histEntry('update', { agent: trackWho, session: sid, turn, note: '对话跟踪轮次追加（CAS重试）：' + sid + '@' + turn, keep: false }))
          latestAgg.updatedAt = nowIso()
          latestAgg.lastModifiedBy = { agent: trackWho, session: sid, turn }
          await writeJsonCAS(aggPath, latestAgg, (latestAgg && typeof latestAgg.version === 'number') ? latestAgg.version : 0)
        }
      }
      if (!(casAgg && casAgg.ok)) { await writeJson(aggPath, existingAgg) }  // 兜底：CAS 不可用时降级普通写
      state.trackLastTurn.set(sid, turn)
      // 教训条目 → 重要文件夹增量（与新建路径共用）
      let lessonCount2 = 0
      const parsed2 = res.final && res.final.parsed
      const lessons2 = (parsed2 && parsed2.lessons) || []
      for (const l of lessons2) {
        if (!l || !l.title || !l.content) continue
        const title = String(l.title).trim()
        const existingTitle = await findImportant(title)
        if (existingTitle) {
          existingTitle.obj.content = (existingTitle.obj.content || '') + '\n' + String(l.content)
          existingTitle.obj.history.push(histEntry('update', { agent: sid, session: sid, turn, note: '对话跟踪教训增量' }))
          existingTitle.obj.updatedAt = nowIso()
          await writeJson(existingTitle.path, existingTitle.obj)
        } else {
          const p2 = await uniquePath(importantDir(), sanitizeFile(title) + '.json')
          const obj2 = newKeywordObj(title, String(l.content), '对话跟踪自动沉淀的教训/经验', { agent: sid, session: sid, turn }, { parents: [], children: [{ kind: 'turn', ref: sid + '@' + turn, location: 'session' }] })
          obj2.lastModifiedBy = { agent: sid, session: sid, turn }
          await writeJson(p2, obj2)
        }
        lessonCount2++
      }
      // 更新当前活跃文件（记录 diff：对话跟踪产生的事件/教训是活跃变更）
      // B-2：采用模型输出的 op（白名单校验；无/非法回退 append）
      // at-time 重审：用"当时活跃"总结 → 不触发当前活跃记录/摘要更新（仅更新引用）
      const parsedOp = (res.final && res.final.parsed && res.final.parsed.op) || ''
      const opValid = ['prepend', 'append', 'merge', 'replace'].indexOf(String(parsedOp)) >= 0
      const activeBase = {
        ownerKey: (meta && meta.ownerKey) || (meta && meta.agent) || sid,
        lastMemRef: relOf(aggPath), lastAction: 'memory_track', recordDiff: true,
        noNotify: tc.injectActive === false,
        summarize: false,
        explicitSummary: res.content || '',
        record: {
          op: opValid ? String(parsedOp) : 'append', key: 'session:' + sid,
          text: withSourceRef(String(res.content || ''), sid, turn),
          refs: [{ kind: 'event', title: '对话跟踪总结：会话 ' + sid, ref: relOf(aggPath) }],
        },
      }
      if (meta && meta.mode === 'at-time') {
        delete activeBase.explicitSummary
        delete activeBase.record
        activeBase.recordDiff = false
        activeBase.lastAction = 'memory_track_at-time'
      }
      await writeActive(sid, turn, activeBase)
      // 总结成功：移除该会话无模型整理记忆（内容已转正到聚合文件/活跃 works，避免重复推断）
      try {
        const nmP = p(noModelDir(), sanitizeFile(sid) + '.json')
        const nmO = await readJson(nmP)
        if (nmO && !isTombstone(nmO) && nmO.kind === 'no-model') await tombstone(nmP, nmP)
      } catch (e8) {}
      return { ok: true, text: '对话跟踪总结已追加（会话 ' + String(sid).slice(-8) + ' 轮次 ' + turn + '）：\n' + res.content + '\n\n教训条目 ' + lessonCount2 + ' 条', data: { turn, path: relOf(aggPath), lessons: lessonCount2, chain: res.chain } }
    }
    // 新建聚合文件（首轮）
    const seq = 1
    const path = aggPath
    const obj = {
      schemaVersion: 1, id: uid(), kind: 'event', location: 'daily',
      title: '对话跟踪总结：会话 ' + sid,
      reason: '对话跟踪模式自动总结（间隔 ' + gap + ' 轮）',
      content: '【轮次 ' + turn + '】' + res.content,
      turns: [{ turn, content: res.content, at: nowIso(), sourceChain: res.chain || [] }],
      trackMeta: [{ startTurn: Math.max(0, Number(tc.startTurn) || 0), interval: Math.max(0, Number(tc.interval) || 0), at: nowIso(), turn }],
      links: {
        parents: [],
        children: [{
          kind: 'turn', ref: sid + '@' + turn,
          location: 'session',
        }],
      },
      sessionRef: buildSessionRef(sid, turn),
      createdAt: nowIso(), updatedAt: nowIso(), lastAccessedAt: nowIso(),
      createdBy: { agent: trackWho, session: sid, turn },
      lastModifiedBy: { agent: trackWho, session: sid, turn },
      originalId: null,
      history: [histEntry('create', { agent: trackWho, session: sid, turn, note: '对话跟踪自动总结' })],
      sourceChain: res.chain || [],
    }
    await writeJson(path, obj)
    // 教训条目 → 重要文件夹增量
    let lessonCount = 0
    const parsed = res.final && res.final.parsed
    const lessons = (parsed && parsed.lessons) || []
    for (const l of lessons) {
      if (!l || !l.title || !l.content) continue
      const title = String(l.title).trim()
      const existingTitle = await findImportant(title)
      if (existingTitle) {
        existingTitle.obj.content = (existingTitle.obj.content || '') + '\n' + String(l.content)
        existingTitle.obj.history.push(histEntry('update', { agent: sid, session: sid, turn, note: '对话跟踪教训增量' }))
        existingTitle.obj.updatedAt = nowIso()
        await writeJson(existingTitle.path, existingTitle.obj)
      } else {
        const p2 = await uniquePath(importantDir(), sanitizeFile(title) + '.json')
        const obj2 = newKeywordObj(title, String(l.content), '对话跟踪自动沉淀的教训/经验', { agent: sid, session: sid, turn }, { parents: [], children: [{ kind: 'turn', ref: sid + '@' + turn, location: 'session' }] })
        obj2.lastModifiedBy = { agent: sid, session: sid, turn }
        await writeJson(p2, obj2)
      }
      lessonCount++
    }
    state.trackLastTurn.set(sid, turn)
    // 更新当前活跃文件（记录 diff：对话跟踪产生的事件/教训是活跃变更）
    // ownerKey 从 turn/end 解析的 preset 来；摘要用对话跟踪的总结内容（避免重复调模型）
    // B-2：采用模型输出的 op（白名单校验；新建会话默认 prepend）
    const parsedOp2 = (res.final && res.final.parsed && res.final.parsed.op) || ''
    const opValid2 = ['prepend', 'append', 'merge', 'replace'].indexOf(String(parsedOp2)) >= 0
    const activeBase2 = {
      ownerKey: (meta && meta.ownerKey) || (meta && meta.agent) || sid,
      lastMemRef: relOf(path), lastAction: 'memory_track', recordDiff: true,
      noNotify: tc.injectActive === false,
      summarize: false,
      explicitSummary: res.content || '',
      record: {
        op: opValid2 ? String(parsedOp2) : 'prepend', key: 'session:' + sid,
        text: withSourceRef(String(res.content || '').split('\n')[0].slice(0, 80), sid, turn),
        refs: [{ kind: 'event', title: '对话跟踪总结：会话 ' + sid, ref: relOf(path) }],
      },
    }
    // at-time 重审：不触发当前活跃记录/摘要更新（仅更新引用）
    if (meta && meta.mode === 'at-time') {
      delete activeBase2.explicitSummary
      delete activeBase2.record
      activeBase2.recordDiff = false
      activeBase2.lastAction = 'memory_track_at-time'
    }
    await writeActive(sid, turn, activeBase2)
    // 总结成功：移除该会话无模型整理记忆（内容已转正到聚合文件/活跃 works）
    try {
      const nmP2 = p(noModelDir(), sanitizeFile(sid) + '.json')
      const nmO2 = await readJson(nmP2)
      if (nmO2 && !isTombstone(nmO2) && nmO2.kind === 'no-model') await tombstone(nmP2, nmP2)
    } catch (e9) {}
    return { ok: true, text: '对话跟踪总结完成（轮次 ' + turn + '）：\n' + res.content + '\n\n教训条目 ' + lessonCount + ' 条，溯源 ' + (res.chain.length ? res.chain.join(' → ') : '（无）'), data: { turn, path: relOf(path), lessons: lessonCount, chain: res.chain } }
  }
  // ═══════════════════════════════════════════════════════════════════
  // 会话聚合写入统一入口：手动创建 / 散文件合并 / 周期转正等所有"轮次总结进会话"都走这里。
  // 目标文件：记忆累积/YYYY/MM/<sid>.json，turns[] 按轮次追加（同轮次替换），content 重拼。
  // opts: { note, reason, sourceChain, skipIfExists }
  // ═══════════════════════════════════════════════════════════════════
  async function appendTurnToAggregate(sid, turn, content, opts) {
    const d = new Date()
    const aggPath = p(dailyBaseDir(), ymPath(d), sanitizeFile(sid) + '.json')
    const me = { agent: (opts && opts.agent) || 'user+memory-admin', session: sid, turn }
    const existingAgg = await readJson(aggPath)
    if (existingAgg && !isTombstone(existingAgg) && existingAgg.kind === 'event') {
      existingAgg.turns = Array.isArray(existingAgg.turns) ? existingAgg.turns : []
      const idx = existingAgg.turns.findIndex(t => t && t.turn === turn)
      if (opts && opts.skipIfExists && idx >= 0) return { ok: true, skipped: true, path: aggPath }
      existingAgg.links = existingAgg.links || { parents: [], children: [] }
      existingAgg.links.children = existingAgg.links.children || []
      if (!existingAgg.links.children.some(l => l && l.kind === 'turn' && l.ref === sid + '@' + turn)) {
        existingAgg.links.children.push({ kind: 'turn', ref: sid + '@' + turn, location: 'session' })
      }
      const turnEntry = { turn, content: String(content || ''), at: nowIso(), sourceChain: (opts && opts.sourceChain) || [] }
      if (idx >= 0) existingAgg.turns[idx] = turnEntry
      else existingAgg.turns.push(turnEntry)
      existingAgg.content = existingAgg.turns.map(t => '【轮次 ' + (t.turn || '?') + '】' + (t.content || '')).join('\n\n')
      existingAgg.history = existingAgg.history || []
      existingAgg.history.push(histEntry('update', { ...me, note: (opts && opts.note) || ('轮次总结写入：' + sid + '@' + turn), keep: true }))
      existingAgg.updatedAt = nowIso()
      existingAgg.lastModifiedBy = me
      await writeJson(aggPath, existingAgg)
      return { ok: true, path: aggPath, created: false }
    }
    const obj = {
      schemaVersion: 1, id: uid(), kind: 'event', location: 'daily',
      title: '对话总结：会话 ' + sid,
      reason: (opts && opts.reason) || '会话轮次总结聚合',
      content: '【轮次 ' + turn + '】' + String(content || ''),
      turns: [{ turn, content: String(content || ''), at: nowIso(), sourceChain: (opts && opts.sourceChain) || [] }],
      trackMeta: [],
      links: { parents: [], children: [{ kind: 'turn', ref: sid + '@' + turn, location: 'session' }] },
      sessionRef: buildSessionRef(sid, turn),
      createdAt: nowIso(), updatedAt: nowIso(), lastAccessedAt: nowIso(),
      createdBy: me, lastModifiedBy: me, originalId: null,
      history: [histEntry('create', { ...me, note: (opts && opts.note) || '创建轮次总结' })],
      sourceChain: (opts && opts.sourceChain) || [],
    }
    await writeJson(aggPath, obj)
    return { ok: true, path: aggPath, created: true }
  }
  // 一次性合并工具：把 年/月/ 下散落的单轮次事件文件并入对应会话聚合文件（原文件标记已合并，保留溯源）。
  // 只处理带「会话@轮次」指向的事件；聚合已有该轮次的跳过（不覆盖）；幂等（已标记合并的跳过）。
  async function mergeScatteredTurnEvents() {
    try {
      let merged = 0, skipped = 0
      for (const f of await listFiles(dailyBaseDir(), true)) {
        const rel = relOf(f.path)
        // 只处理 年/月/ 两级下的散文件（非 session- 聚合、非日目录、非周期/补充/无模型）
        if (!/\d{4}\/\d{2}\/[^/]+\.json$/.test(rel)) continue
        const name = f.name
        if (name.indexOf('session-') === 0) continue
        if (rel.indexOf('周期记忆/') >= 0 || rel.indexOf('补充/') >= 0 || rel.indexOf('无模型记忆整理/') >= 0) continue
        const o = await readJson(f.path)
        if (!o || isTombstone(o) || o.kind !== 'event' || o.mergedInto) continue
        // 提取 会话@轮次
        let sid = '', turn = 0
        if (o.sessionRef && o.sessionRef.sessionId && o.sessionRef.turn) { sid = o.sessionRef.sessionId; turn = Number(o.sessionRef.turn) || 0 }
        if ((!sid || !turn) && Array.isArray(o.links && o.links.children)) {
          for (const l of o.links.children) {
            if (l && l.kind === 'turn' && l.ref) { const m = String(l.ref).match(/^(.+)@(\d+)$/); if (m) { sid = m[1]; turn = Number(m[2]); break } }
          }
        }
        if (!sid || !turn) continue
        const r = await appendTurnToAggregate(sid, turn, o.content || '', {
          note: '散事件文件合并（原 ' + rel + '）', reason: o.reason || '', sourceChain: Array.isArray(o.sourceChain) ? o.sourceChain : [],
          skipIfExists: true, agent: 'memory-admin',
        })
        if (r && r.ok && !r.skipped) {
          o.history = o.history || []
          o.history.push(histEntry('update', { agent: 'memory-admin', session: sid, turn, note: '已合并入会话聚合：' + relOf(r.path), keep: true }))
          o.mergedInto = relOf(r.path)
          await writeJson(f.path, o, true)
          merged++
        } else if (r && r.skipped) {
          skipped++
        }
      }
      // 仅真正合并了文件时输出（跳过=常态，不再每次启动刷日志）
      if (merged) console.log('[motion-memory] 散事件文件合并完成：合并 ' + merged + ' 个')
    } catch (e) { console.error('[motion-memory] 散文件合并失败: ' + (e && e.message)) }
  }
  // 对话跟踪无模型降级：不调模型，在无模型记忆整理区按会话累积用户消息引用（标题=会话id）
  async function trackNoModelRecord(sid, turn, meta) {
    try {
      const owner = (meta && (meta.ownerKey || meta.agent)) || sid
      const fname = sanitizeFile(sid) + '.json'
      const path = p(noModelDir(), fname)
      const existing = await readJson(path)
      const now = nowIso()
      const obj = existing || {
        schemaVersion: 1, id: uid(), kind: 'no-model', location: 'no-model',
        title: '会话 ' + sid,
        reason: '对话跟踪无模型模式：按轮次累积用户消息引用（[用户消息](会话@轮次)），保持原始指向',
        content: '',
        links: { parents: [], children: [] },
        meta: { agent: owner },
        createdAt: now, updatedAt: now, lastAccessedAt: now,
        createdBy: { agent: owner, session: sid, turn },
        lastModifiedBy: { agent: owner, session: sid, turn },
        originalId: null,
        history: [histEntry('create', { agent: owner, session: sid, turn, note: '对话跟踪无模型记录' })],
        sourceChain: [],
      }
      const failNote = (meta && meta.failNote) || ''
      // 附带本轮用户消息文本（前 120 字），轮次页无模型记录直接显示用户说了什么（链接可点原文）
      let userText = ''
      try {
        const ut = await readTurnUserText(sid, turn, 200)
        if (ut && ut !== '（该轮次无文本内容）') userText = ut.slice(0, 120)
      } catch (e) {}
      const line = '[用户消息](' + sid + '@' + turn + ')' + (userText ? '：' + userText : '') + (failNote ? '（模型总结失败：' + failNote + '）' : '')
      if (obj.content && obj.content.indexOf(line) < 0) obj.content += '\n' + line
      else if (!obj.content) obj.content = line
      obj.links = obj.links || { parents: [], children: [] }
      obj.links.children = obj.links.children || []
      const existChild = obj.links.children.find(l => l && l.kind === 'turn' && l.ref === sid + '@' + turn)
      if (existChild) {
        // 同轮次从无模型模式再失败：更新失败标注
        if (failNote) { existChild.fail = true; existChild.failNote = failNote }
      } else {
        obj.links.children.push({ kind: 'turn', ref: sid + '@' + turn, location: 'session', fail: !!failNote, failNote: failNote || '' })
      }
      obj.sourceChain = obj.sourceChain || []
      if (!obj.sourceChain.includes(sid + '@' + turn)) obj.sourceChain.push(sid + '@' + turn)
      obj.updatedAt = now
      obj.lastModifiedBy = { agent: owner, session: sid, turn }
      obj.history = obj.history || []
      obj.history.push(histEntry('update', { agent: owner, session: sid, turn, note: (failNote ? '模型总结失败转无模型记录：' + failNote : '追加轮次 ' + turn + ' 用户消息引用') }))
      obj.history = obj.history.slice(-50)
      await writeJson(path, obj)
      state.trackLastTurn.set(sid, turn)
      return { ok: true, text: '对话跟踪无模型模式：已更新会话 ' + String(sid).slice(-8) + ' 无模型记录（轮次 ' + turn + '，引用追加）', data: { turn, path: relOf(path), noModel: true } }
    } catch (e) {
      return { ok: false, text: '无模型记录失败：' + ((e && e.message) || e) }
    }
  }
  // 懒归档：无模型记忆（超 archiveDays）→ 无模型记忆整理/归档/年/月/；重要记忆 → 补充/（补充=重要+活跃归档）
  async function lazyArchive() {
    try {
      const cutoff = Date.now() - Math.max(1, Number(cfg().archiveDays) || 30) * 86400000
      for (const f of await listFiles(noModelDir(), false)) {
        const o = await readJson(f.path)
        if (!o || isTombstone(o)) continue
        const last = lastOpTime(o)
        if (last > cutoff) continue
        const d = new Date(last || parseIso(o.createdAt) || Date.now())
        const dir = p(noModelDir(), '归档', String(d.getFullYear()), pad(d.getMonth() + 1))
        const moved = await uniquePath(dir, f.name)
        await writeJson(moved, o)
        await tombstone(f.path, moved)
      }
      for (const f of await listFiles(importantDir(), false)) {
        const o = await readJson(f.path)
        if (!o || isTombstone(o)) continue
        const last = lastOpTime(o)
        if (last > cutoff) continue
        const moved = await uniquePath(archiveBaseDir(), f.name)
        await writeJson(moved, o)
        await tombstone(f.path, moved)
      }
    } catch (e) { console.error('[motion-memory] 懒归档失败: ' + (e && e.message)) }
  }
  // 注册 turn/end 触发（后台执行不阻塞）
  ctx.on('session/event', async (session, event) => {
    if (!session || !event || event.type !== 'turn/end') return
    const sid = session.id
    const d2 = (event && event.data) || {}
    const turn = d2.turn || 0
    if (!sid || !turn) return
    // 解析 ownerKey（日志 agent-preset/selected 优先，header 兜底）——对话跟踪的摘要归本智能体活跃文件
    let ownerKey = ''
    try {
      const preset = (await sessionPresetOfAsync(sid)) || sessionPresetOf(session)
      if (preset) ownerKey = 'preset:' + preset
    } catch (e) {}
    // 子会话/无智能体归属：不做记忆记录——即使触发对话跟踪总结也不运行（memory_query 等查询功能不受影响）
    if (!ownerKey) return
    const meta = { agent: ownerKey || sid, session: sid, turn, ownerKey: ownerKey || sid }
    // 方案B：turn/end 前热重载配置（确保 interval 等最新）
    reloadConfigIfChanged().then(() => {
      runTurnSummary(sid, turn, meta).then(r => {
        if (r && r.ok && !r.skipped) console.log('[motion-memory] ' + r.text.split('\n')[0])
      }).catch(e => console.error('[motion-memory] 对话跟踪失败: ' + (e && e.message)))
    }).catch(() => {
      runTurnSummary(sid, turn, meta).then(r => {
        if (r && r.ok && !r.skipped) console.log('[motion-memory] ' + r.text.split('\n')[0])
      }).catch(e => console.error('[motion-memory] 对话跟踪失败: ' + (e && e.message)))
    })
  })
  // 手动触发工具：memory_track_run
  async function memCmdTrackRun(args, meta) {
    const sid = String(args.sessionId || meta.session || '')
    const turn = args.turn !== undefined ? Number(args.turn) : (meta.turn || 0)
    if (!turn) return { ok: false, text: '无法确定轮次（传 turn 或稍后再试）' }
    return runTurnSummary(sid, turn, { agent: meta.agent, session: sid, turn, force: true })
  }

  return {
    trackCfg, hasTrackSummary, runTurnSummary, runTurnSummaryTask,
    appendTurnToAggregate, mergeScatteredTurnEvents, lazyArchive, memCmdTrackRun,
  }
}
