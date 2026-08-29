/**
 * motion-memory 查询/回忆域模块（拆分自 motion-memory.js，C 档第十刀）
 *
 * memory_query 工具实现（memCmdQuery：开工总览/关键词/打开/轮次原文/智能体概览
 * + deepQueryEnhance 深度增强）+ 往时回忆（memCmdRecallPast）+ 捡回（memCmdRestore）
 * + 历史分页（memCmdHistory）。注册壳留在主文件。
 * 依赖经 createQuery(core, deps) 注入：core 为共享运行时；deps 提供
 * { resolveModelConfig, expandLinks, readTurnUserTextRetry, readAgentActive,
 *   activeIndexPath, touchActive, logQuery, recentQueries, readTurnRef,
 *   recordModelText, searchAllMemories, semanticHits }。
 */

import { histEntry, sanitizeFile } from './memory-objects.mjs'
import { pad } from './time-utils.mjs'
import { opLabel, deltaSummary } from './text-utils.mjs'

export function createQuery(core, deps) {
  const {
    cfg, adminCfg, p, root, relOf, nowIso, parseIso, isEventRel,
    readJson, writeJson, listFiles, isTombstone, tombstone,
    necessaryDir, importantDir, archiveBaseDir, dailyBaseDir, noModelDir, periodBaseDir,
    queryOwnerOf, findImportant, findKeyword, findArchive, scopeOwner,
    scanDir, lastOpTime, pageSlice, isoStr, ownerOf,
  } = core
  const {
    resolveModelConfig, expandLinks, readTurnUserTextRetry, readAgentActive,
    activeIndexPath, touchActive, logQuery, recentQueries, readTurnRef,
    recordModelText, searchAllMemories, semanticHits,
  } = deps || {}

  async function memCmdQuery(args, meta) {
  async function deepQueryEnhance(meta, baseText, titles) {
    try {
      const c = cfg()
      const mc0 = resolveModelConfig()
        const hasModel = !!(mc0.provider && mc0.model)
      const budget = Math.max(1024, Math.floor((Number(adminCfg().contextTokens) || 128000) * (Number(adminCfg().summaryPercent) || 50) / 100))
      const sid = (meta && meta.session) || ''
      const turn = (meta && meta.turn) || 0
      // ① 深度 3 展开：对命中的标题逐个展开关联（最多 3 个，避免爆炸）
      let expanded = ''
      let used = (baseText || '').length
      const seen = []
      const expandCap = Math.floor(budget * 0.6)
      for (const t of (titles || []).slice(0, 3)) {
        if (used > expandCap) break
        const e = await findKeyword(t, scopeOwner(meta))
        if (!e) continue
        const exp = await expandLinks(e.obj, 3, seen, Math.max(512, expandCap - used))
        if (exp.text) { expanded += (expanded ? '\n' : '') + '【' + t + ' 关联展开】\n' + exp.text; used += exp.text.length }
      }
      // ② 上下文填充：本轮前 N 步 + 每步引用，直到预算
      let ctx = ''
      const ctxBudget = budget - used
      for (let t = Math.max(1, turn - 4); t <= turn; t++) {
        if (ctx.length >= ctxBudget) break
        const step = await readTurnUserTextRetry(sid, t, 1024)
        if (step && step !== '（该轮次无文本内容）') ctx += (ctx ? '\n' : '') + '轮次' + t + '：' + step.slice(0, Math.max(128, ctxBudget - ctx.length))
      }
      // ③ 模型总结合并
      if (!hasModel) {
        // 无模型：拼接输出（基础 + 深度展开 + 上下文摘要），不调模型
        return { ok: true, text: baseText + (expanded ? '\n\n' + expanded : '') + (ctx ? '\n\n【本轮上下文】\n' + ctx.slice(0, 800) : ''), enhanced: true }
      }
      const prompt = [
        '你是运动记忆的查询整合器。基于以下基础查询结果、关联展开和本轮上下文，输出一个整合后的记忆查询报告：',
        '- 基础结果（必含）',
        '- 若关联展开有额外价值则整合进去（判断是否有必要）',
        '- 若上下文充足可扩展到更远历史/关联（判断必要性）',
        '- 只输出整合后的文本，不要 JSON。',
        '',
        '【基础结果】\n' + baseText.slice(0, 2000),
        expanded ? '【关联展开】\n' + expanded.slice(0, 2000) : '',
        ctx ? '【本轮上下文】\n' + ctx.slice(0, 1500) : '',
      ].join('\n')
      const text = await recordModelText(prompt)
      if (text) return { ok: true, text: text.trim(), enhanced: true }
      // 模型报错/空 → 正常返回基础（附报错说明）
      return { ok: true, text: baseText + '\n\n（查询增强模型未返回，已输出基础结果）', enhanced: false }
    } catch (e) {
      return { ok: true, text: baseText + '\n\n（查询增强失败：' + (e && e.message || String(e)) + '，已输出基础结果）', enhanced: false }
    }
  }
  // 1. 查询（普通查询 = 纯文件读取：活跃 + 必要 + 重要/周期关键词 + 最近事件。不调模型）
  // 深度增强（调模型整合）仅 enhance=true 时触发，默认关
    // ① 列出智能体记忆概览（先枚举有哪些智能体，再 ownerKey 定向查询）
    if (args.agents) {
      const own = queryOwnerOf(meta, args)
      const stat = {}
      const touch = (key) => { key = String(key || ''); if (!key) key = '（无归属）'; if (!stat[key]) stat[key] = { important: 0, events: 0, period: 0, recent: [] } }
      const push = (key, kind, title) => { touch(key); stat[key][kind]++; if (stat[key].recent.length < 3) stat[key].recent.push(String(title || '')) }
      const inScope = (ow) => !own || ow === own
      for (const f of await listFiles(importantDir(), false)) {
        const o = await readJson(f.path)
        if (!o || isTombstone(o)) continue
        const ow = ownerOf(o)
        if (!inScope(ow)) continue
        push(ow, 'important', o.title)
      }
      for (const f of await listFiles(dailyBaseDir(), true)) {
        const rel = relOf(f.path)
        if (!isEventRel(rel)) continue
        if (rel.indexOf('周期记忆/') >= 0) continue
        const o = await readJson(f.path)
        if (!o || isTombstone(o) || o.kind !== 'event') continue
        const ow = ownerOf(o)
        if (!inScope(ow)) continue
        push(ow, 'events', o.title)
      }
      for (const f of await listFiles(periodBaseDir(), true)) {
        const o = await readJson(f.path)
        if (!o || isTombstone(o) || o.kind !== 'period') continue
        const ow = String(o.ownerKey || '')
        if (!inScope(ow)) continue
        push(ow, 'period', o.title)
      }
      const keys = Object.keys(stat).sort()
      if (!keys.length) return { ok: true, text: '【智能体记忆概览】（无记忆文件）', data: { agents: [] } }
      const lines = ['【智能体记忆概览】' + (own ? '（范围：' + own + '）' : '（全部）')]
      for (const k of keys) {
        const s = stat[k]
        lines.push('· ' + k + '：重要 ' + s.important + ' · 事件 ' + s.events + ' · 周期 ' + s.period + (s.recent.length ? ' · 最近：' + s.recent.join('；') : ''))
      }
      lines.push('（可用 memory_query ownerKey=preset:xxx keyword=词 / open=标题 定向查询；ownerKey=all 查询所有智能体）')
      await logQuery(meta.session, '智能体记忆概览', null)
      return { ok: true, text: lines.join('\n'), data: { agents: keys } }
    }
    // ① 轮次原文阅读（openTurn）
    if (args.openTurn) {
      const text = await readTurnRef(String(args.openTurn), 32768)
      await logQuery(meta.session, args.openTurn, null)
      return { ok: true, text: '【对话轮次 ' + args.openTurn + '】\n' + text, data: { ref: args.openTurn } }
    }
    // ② 打开指定标题阅读（关联展开 + 历史记录）
    if (args.open) {
      const found = await findImportant(args.open, queryOwnerOf(meta, args))
      if (!found) return { ok: false, text: '重要记忆中未找到标题：' + args.open + '（可先 keyword 搜索，或开启 queryOtherAgents 扩大范围）' }
      found.obj.lastAccessedAt = nowIso()
      found.obj.history = found.obj.history || []
      // 防重（v5.1）：同 agent + 同会话 + 同一天 的重复阅读不新增记录，只追加时间到 times 数组
      // （评分按 times 按天去重计一次；跨天/跨会话/跨 agent 阅读才新增记录）
      const nowI = nowIso()
      const sameCtx = found.obj.history.filter(h => h.op === 'query' && h.session === meta.session && (meta.agent ? h.agent === meta.agent : true) && String(h.at || '').slice(0, 10) === nowI.slice(0, 10))
      if (sameCtx.length) {
        const rec = sameCtx[sameCtx.length - 1]
        rec.times = Array.isArray(rec.times) ? rec.times : (rec.at ? [rec.at] : [])
        rec.times.push(nowI)
      } else {
        const entry = histEntry('query', { ...meta, note: '回忆查询：' + args.open })
        entry.times = [nowI]
        found.obj.history.push(entry)
      }
      found.obj.history = found.obj.history.slice(-50)  // 防膨胀：与 update/界面保存对齐
      await writeJson(found.path, found.obj)
      const c = cfg()
      const qn = args.queryHistory === undefined ? (c.queryHistoryN || 0) : (args.queryHistory === -1 ? 5 : Math.max(0, args.queryHistory))
      const un = args.updateHistory === undefined ? (c.updateHistoryN || 0) : (args.updateHistory === -1 ? 5 : Math.max(0, args.updateHistory))
      const links = (found.obj.links && found.obj.links.children || []).concat(found.obj.links && found.obj.links.parents || [])
      let contentMd = String(found.obj.content || '')
      const kwLinks = links.filter(l => l.kind === 'keyword' && l.title && contentMd.indexOf(l.title) >= 0)
      for (const kl of kwLinks) {
        const href = '记忆累积/' + (kl.location === 'archive' ? '补充' : '重要') + '/' + sanitizeFile(kl.title) + '.json'
        contentMd = contentMd.split(kl.title).join('[' + kl.title + '](' + href + ')')
      }
      const lines = ['【内容】' + contentMd, '【记忆理由】' + (found.obj.reason || '（无）')]
      if (qn > 0) {
        const queries = (await recentQueries(qn)).map(q => q.at + ' ' + (q.keyword || q.opened || '-'))
        lines.push('【最近查询】' + (queries.length ? queries.join('；') : '（无）'))
      }
      if (un > 0) {
        const updates = (found.obj.history || []).filter(h => h.keep && (h.op === 'update' || h.op === 'create')).slice(-un)
        lines.push('【最近增量更新】' + (updates.length ? updates.map(u => u.at + ' ' + opLabel(u.op) + (u.note ? ' ' + u.note : '')).join('；') : '（无）'))
      }
      if (links.length) lines.push('【关联】' + links.map(l => {
        if (l.kind === 'keyword') return '[' + l.title + '](记忆累积/' + (l.location === 'archive' ? '补充' : '重要') + '/' + sanitizeFile(l.title) + '.json)'
        if (l.kind === 'turn') return '[轮次 ' + l.ref + '](turn:' + l.ref + ')'
        if (l.kind === 'active') return '[智能体活跃 ' + (l.agent || '') + '](active:' + (l.agent || '') + ')'
        return l.path || l.title || ''
      }).join('；'))
      const eff = (args.expandDepth === undefined || args.expandDepth === -1) ? (c.cascadeDepth === undefined ? 1 : c.cascadeDepth) : args.expandDepth
      if (eff > 0 && links.length) {
        const exp = await expandLinks(found.obj, eff, ['k:' + (found.obj.title || '')], c.injectLimitBytes || 4096)
        if (exp.text) lines.push('【关联展开】' + exp.text + (exp.capped ? '\n（超出上限已截断）' : ''))
      }
      await logQuery(meta.session, args.keyword || args.open, args.open)
      return { ok: true, text: lines.join('\n'), data: { title: args.open, content: found.obj.content, reason: found.obj.reason } }
    }
    // ③ 开工总览（默认）+ keyword 匹配列表 + enhance 深度增强
    const parts = []
    const nec = await readJson(p(necessaryDir(), meta.session + '.json'))
    parts.push('【必要记忆】' + (nec && nec.content ? nec.content : '（无）'))
    const myOwnerKey = (meta && meta.agent && String(meta.agent).indexOf('preset:') === 0) ? String(meta.agent) : (meta && meta.session) || ''
    const myAct = myOwnerKey ? await readAgentActive(myOwnerKey) : null
    if (myAct && myAct.obj) {
      const o = myAct.obj
      const segs = ['智能体 ' + myOwnerKey]
      // v4 三块：custom / keywords / works（每会话一段）
      if (o.custom && String(o.custom).trim()) segs.push('【自定义设定】' + String(o.custom).slice(0, 200))
      if (Array.isArray(o.keywords) && o.keywords.length) segs.push('【关键词】' + o.keywords.slice(0, 10).join('、'))
      const works = Array.isArray(o.works) ? o.works.slice(0, 3) : []
      if (works.length) segs.push('【会话工作】' + works.map(w => (w.sid ? '[' + String(w.sid).slice(-8) + '] ' : '') + String(w.text || '').slice(0, 100)).join('；'))
      else if (o.summary) segs.push('【会话工作】' + String(o.summary).slice(0, 200))
      parts.push('【当前活跃】' + segs.join('\n'))
    } else {
      parts.push('【当前活跃】（本智能体无活跃摘要）')
    }
    const idx = await readJson(activeIndexPath())
    if (idx && ((idx.refs || []).length || (idx.agents || []).length)) {
      const lines = ['【活跃索引】']
      if ((idx.recentPeriods || []).length) lines.push('周期：' + idx.recentPeriods.map(r => r.split('/').pop()).join('、'))
      if ((idx.refs || []).length) {
        const kw = (idx.refs || []).filter(r => r.kind === 'keyword').slice(0, 10)
        if (kw.length) lines.push('关键词：' + kw.map(r => r.title).join('、'))
        const ev = (idx.refs || []).filter(r => r.kind === 'event').slice(0, 5)
        if (ev.length) lines.push('事件：' + ev.map(r => r.title).join('、'))
      }
      if ((idx.agents || []).length) {
        lines.push('智能体：' + idx.agents.slice(0, 5).map(a => {
          const isSelf = a.agent === myOwnerKey
          return a.agent + (isSelf ? '（本智能体）' : '') + (a.summary ? '：' + a.summary.slice(0, 40) : '')
        }).join('；'))
      }
      parts.push(lines.join('\n'))
    } else {
      parts.push('【活跃索引】（无，可在产生记忆后查看）')
    }
    const n = Math.max(1, args.recent || cfg().recentOverviewN || 3)
    const qOwner = queryOwnerOf(meta, args)
    const evs = []
    // v5 定向扫描：按 年/月 目录从新到旧翻，取最近 n 条事件（避免全量递归扫全部日期）
    const now = new Date()
    const scanMonths = Math.max(1, Number(cfg().indexScore && cfg().indexScore.scanMonths) || 3)
    for (let i = 0; i < scanMonths && evs.length < n; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const ym = String(d.getFullYear()) + '/' + pad(d.getMonth() + 1)
      const files = await listFiles(p(dailyBaseDir(), ym), false).catch(() => [])
      files.sort((a, b) => (b.name < a.name ? -1 : b.name > a.name ? 1 : 0))
      for (const f of files) {
        const rel = relOf(f.path)
        if (!isEventRel(rel)) continue
        const o = await readJson(f.path)
        if (o && !isTombstone(o) && o.kind === 'event') {
          if (qOwner) { const ow = ownerOf(o); if (ow && ow !== qOwner && ow !== 'memory-admin') continue }
          evs.push(o)
          if (evs.length >= n) break
        }
      }
    }
    evs.sort((a, b) => parseIso(b.createdAt) - parseIso(a.createdAt))
    const top = evs.slice(0, n)
    parts.push('【最近' + top.length + '条事件记忆总览】' + (top.length ? top.map(o => o.title + '（' + o.createdAt + '）').join('；') : '（无）'))
    const noModelPending = []
    for (const f of await listFiles(noModelDir(), true)) {
      const o = await readJson(f.path)
      if (o && !isTombstone(o) && o.kind === 'no-model' && !o.summarizedAt) noModelPending.push(o)
    }
    if (noModelPending.length) {
      noModelPending.sort((a, b) => parseIso(b.updatedAt) - parseIso(a.updatedAt))
      parts.push('【无模型待整理】' + noModelPending.slice(0, 3).map(o => (o.title || '') + '（轮次' + (o.turn || '?') + '）').join('；') + '（可经周期总结或模型总结转正）')
    }
    let titles = []
    if (args.keyword) {
      const hits = await searchAllMemories(args.keyword, false, queryOwnerOf(meta, args))
      titles = hits.map(h => h.title)
      const zones = hits.map(h => h.zone)
      parts.push('【记忆匹配标题】' + (titles.length ? titles.map((t, i) => t + (zones[i] === 'period' ? '（周期）' : '')).join('；') : '（无）'))
      // P0-1：语义召回融合（enabled 时）——关键词未命中的语义近似条目单独列出并标注相似度
      if (cfg().semanticSearch && cfg().semanticSearch.enabled) {
        const semantic = await semanticHits(args.keyword)
        const kwSet = new Set(titles)
        const extra = []
        for (const s of semantic) {
          if (!kwSet.has(s.title) && !extra.some(x => x.title === s.title)) extra.push(s)
        }
        if (extra.length) {
          for (const s of extra) { titles.push(s.title); zones.push('') }
          parts.push('【语义匹配（关键词未命中）】' + extra.map(s => s.title + '（' + (s.zone === 'period' ? '周期·' : '') + '相似度 ' + s.sim.toFixed(2) + '）').join('；'))
        }
      }
    }
    await logQuery(meta.session, args.keyword || '', null)
    const baseText = parts.join('\n\n')
    if (args.enhance) {
      const enhanced = await deepQueryEnhance(meta, baseText, titles)
      return { ok: true, text: enhanced.text, data: { necessary: (nec && nec.content) || '', recent: top.map(o => ({ title: o.title, createdAt: o.createdAt })), titles } }
    }
    return { ok: true, text: baseText, data: { necessary: (nec && nec.content) || '', recent: top.map(o => ({ title: o.title, createdAt: o.createdAt })), titles } }
  }
  // 3. 往时回忆
  async function memCmdRecallPast(args, meta) {
    const now0 = new Date()
    const t = new Date(now0)
    t.setMonth(t.getMonth() - Math.max(0, args.months || 0))
    t.setDate(t.getDate() - Math.max(0, args.days || 0))
    const tMs = t.getTime()
    const list = []
    for (const e of await scanDir(archiveBaseDir(), true, scopeOwner(meta))) {
      const last = lastOpTime(e.obj)
      if (last >= tMs) list.push({ title: e.obj.title, last, path: e.path })
    }
    list.sort((a, b) => b.last - a.last)
    const pg = pageSlice(list, args.page, 10)
    await logQuery(meta.session, '往时回忆 ' + (args.months || 0) + '月' + (args.days || 0) + '日', null)
    return {
      ok: true,
      text: '【补充记忆·往时回忆 ' + (args.months || 0) + '月' + (args.days || 0) + '日→现在】共 ' + pg.total + ' 条，第 ' + pg.page + ' 页' + (pg.items.length ? '\n' + pg.items.map((x, i) => (pg.page - 1) * 10 + i + 1 + '. ' + x.title + '（最后操作 ' + isoStr(x.last) + '）').join('\n') + '\n（可用 memory（cmd=restore）捡回）' : ''),
      data: { items: pg.items.map(x => ({ title: x.title, last: isoStr(x.last) })), page: pg.page, total: pg.total },
    }
  }

  // 8. 捡回
  async function memCmdRestore(args, meta) {
    const found = await findArchive(args.title, scopeOwner(meta))
    if (!found) return { ok: false, text: '补充文件夹中未找到：' + args.title + '（仅限本智能体记忆；开启 queryOtherAgents 可扩大到其他智能体）' }
    const existing = await findImportant(args.title, scopeOwner(meta))
    if (existing) {
      existing.obj.content = (existing.obj.content ? existing.obj.content + '\n' : '') + found.obj.content
      existing.obj.links = existing.obj.links || { parents: [], children: [] }
      existing.obj.links.children.push({ kind: 'keyword', location: 'archive', title: found.obj.title })
      existing.obj.history.push(histEntry('restore', { ...meta, note: '回忆到补充记忆文件：' + relOf(found.path), fromPath: relOf(found.path), toPath: relOf(existing.path) }))
      existing.obj.updatedAt = nowIso()
      await writeJson(existing.path, existing.obj)
      await tombstone(found.path, existing.path)
      await touchActive(meta, relOf(existing.path), 'memory_restore')
      return { ok: true, text: '已捡回并合并到同名记忆：' + args.title + '（补充内容已追加）' }
    }
    const dst = await uniquePath(importantDir(), fileNameOf(found.path))
    found.obj.location = 'important'
    found.obj.history.push(histEntry('move', { ...meta, note: '回忆捡回：移入重要', fromPath: relOf(found.path), toPath: relOf(dst) }))
    found.obj.updatedAt = nowIso()
    await writeJson(dst, found.obj)
    await tombstone(found.path, dst)
    await touchActive(meta, relOf(dst), 'memory_restore')
    return { ok: true, text: '已捡回移入重要：' + args.title + '（' + relOf(dst) + '）' }
  }

  // 10. 历史分页
  async function memCmdHistory(args, meta) {
    const copies = []
    const hOwner = scopeOwner(meta)
    const a = await findImportant(args.title, hOwner)
    if (a) copies.push({ obj: a.obj, zone: 'important' })
    const b = await findArchive(args.title, hOwner)
    if (b) copies.push({ obj: b.obj, zone: 'archive' })
    if (!copies.length) return { ok: false, text: '未找到：' + args.title + '（仅限本智能体记忆）' }
    const all = []
    for (const c of copies) {
      ;(c.obj.history || []).forEach((h) => all.push({ at: parseIso(h.at), h, zone: c.zone }))
    }
    all.sort((x, y) => y.at - x.at)
    const size = Math.max(1, args.pageSize || cfg().historyPageSize || 20)
    const pg = pageSlice(all, args.page, size)
    const lines = ['【' + args.title + ' 历史操作记录】共 ' + pg.total + ' 条，第 ' + pg.page + ' 页（每页 ' + pg.pageSize + '）']
    for (const x of pg.items) {
      lines.push(x.h.at + ' ' + opLabel(x.h.op) + ' keep=' + (x.h.keep === false ? 'false' : 'true') + ' agent=' + (x.h.agent || '-') + ' ' + (x.h.session || '') + '@' + (x.h.turn || 0) + ' [' + x.zone + ']' + (x.h.note ? ' ' + x.h.note : '') + (x.h.delta && x.h.delta.length ? '\n  ' + deltaSummary(x.h.delta) : ''))
    }
    return { ok: true, text: lines.join('\n'), data: { total: pg.total, page: pg.page } }
  }

  return {
    memCmdQuery, memCmdRecallPast, memCmdRestore, memCmdHistory,
  }
}
