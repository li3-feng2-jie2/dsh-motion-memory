/**
 * motion-memory 活跃记忆域模块（拆分自 motion-memory.js，C 档）
 *
 * 活跃记忆（v4：custom + keywords + works[]，每会话一段）的读写/索引/追踪。
 * 依赖经 createActive(core, deps) 注入：core 为 createCore(ctx) 返回的共享运行时，
 * deps 提供 { readTurnUserText, adminCfg }（主文件侧函数，跨域依赖由调用方组装时传入）。
 */

import { diffContent } from './text-utils.mjs'

export function createActive(core, deps) {
  const {
    state, ctx, p, root, relOf, nowIso, parseIso, uid,
    readJson, writeJson, listFiles, isTombstone, tombstone, uniquePath, fileNameOf,
    histEntry, sanitizeFile, cfg, adminCfg, activeDir, dailyBaseDir, importantDir, archiveBaseDir,
    periodBaseDir,
  } = core
  const { readTurnUserText } = deps || {}

  function activeIndexPath() { return p(activeDir(), 'active.json') }
  function activeKeyOf(ownerKey, sid) { return (ownerKey || '') + '@' + sid }
  async function readTurnUserTextRetry(sid, turn, cap, attempts) {
    for (let i = 0; i < Math.max(1, Number(attempts) || 1); i++) {
      const t = await readTurnUserText(sid, turn, cap)
      if (t) return t
    }
    return ''
  }
  function summarySimilar(a, b) {
    const x = String(a || '').trim(), y = String(b || '').trim()
    if (!x || !y) return false
    return x === y || x.includes(y) || y.includes(x)
  }
  function agentActivePath(ownerKey) {
    const key = String(ownerKey || '').trim() || 'default'
    const safe = key.replace(/[\\/:*?"<>|]/g, '_')
    return p(activeDir(), safe + '.json')
  }
  function agentActiveTitle(ownerKey) { return String(ownerKey || 'default').replace(/^preset:/, '') }
  async function readAgentActive(ownerKey) {
    const path = agentActivePath(ownerKey)
    const o = await readJson(path)
    if (o && !isTombstone(o)) return { obj: o, path }
    return { obj: { schemaVersion: 4, agent: String(ownerKey || ''), custom: '', keywords: [], works: [], records: [], refs: [], summary: '', history: [], updatedAt: '' }, path }
  }
  function withSourceRef(text, sid, turn) {
    const t = String(text || '').trim()
    if (!t || !sid) return t
    return t + '\n\n> 来源：[' + sid + '@' + (turn || 0) + '](' + sid + '@' + (turn || 0) + ')'
  }
  function pushMergedHistory(act, entry, meta) {
    act.history = act.history || []
    const last = act.history[act.history.length - 1]
    if (last && last.op === entry.op && last.agent === entry.agent && last.session === entry.session && last.turn === entry.turn) {
      // 同 op+agent+session+turn 的连续记录 → 合并 note（防膨胀）
      last.note = String(last.note || '') + '；' + String(entry.note || '')
      last.at = entry.at
      return last
    }
    act.history.push(entry)
    return entry
  }
  function queryDayCount(h) {
    try {
      const at = h && h.at
      if (!at) return 0
      const ms = parseIso(at) || 0
      return ms ? Math.max(0, Math.floor((Date.now() - ms) / 86400000)) : 0
    } catch (e) { return 0 }
  }
  async function ensureSessionWorkSegment(ownerKey, sid, meta) {
    const { obj: act, path } = await readAgentActive(ownerKey)
    act.records = act.records || []
    const recKey = 'session:' + sid
    if (!act.records.some(r => r && r.key === recKey)) {
      act.records.unshift({ text: '', refs: [], at: nowIso(), op: 'prepend', key: recKey, sid })
      await writeJson(path, act)
    }
    return { obj: act, path }
  }
  async function archiveWorksSegment(sid, seg, meta) {
    const dst = await uniquePath(p(archiveBaseDir(), 'works'), 'segment-' + sid + '.json')
    const me = { agent: (meta && meta.agent) || '', session: (meta && meta.session) || '', turn: (meta && meta.turn) || 0 }
    const obj = {
      schemaVersion: 1, kind: 'works-archive', title: '会话工作段归档：' + sid,
      content: String(seg && seg.text || ''), reason: '活跃 works 超预算归档',
      links: { parents: [], children: [{ kind: 'turn', ref: sid + '@' + (seg && seg.turn || 0), location: 'session' }] },
      createdAt: nowIso(), updatedAt: nowIso(), createdBy: me, lastModifiedBy: me,
      history: [histEntry('move', { ...me, note: 'works 段归档追加：' + sid, fromPath: 'active-works', toPath: relOf(dst), keep: false })],
    }
    await writeJson(dst, obj)
    return { path: dst, obj }
  }
  async function restoreWorksSegment(ownerKey, sid, meta) {
    const { obj: act, path } = await readAgentActive(ownerKey)
    act.records = act.records || []
    const recKey = 'session:' + sid
    const idx = act.records.findIndex(r => r && r.key === recKey)
    if (idx < 0) return { ok: false, text: '无该会话的 works 段' }
    const seg = act.records[idx]
    if (!seg) return { ok: false, text: 'works 段为空' }
    act.records.splice(idx, 1)
    const dst = await uniquePath(p(archiveBaseDir(), 'works'), 'restored-' + sid + '.json')
    const me = { agent: (meta && meta.agent) || '', session: (meta && meta.session) || '', turn: (meta && meta.turn) || 0 }
    const obj = {
      schemaVersion: 1, kind: 'works-archive', title: '会话工作段恢复：' + sid,
      content: String(seg.text || ''), reason: '活跃 works 恢复',
      links: { parents: [], children: [{ kind: 'turn', ref: sid + '@' + (seg.turn || 0), location: 'session' }] },
      createdAt: nowIso(), updatedAt: nowIso(), createdBy: me, lastModifiedBy: me,
      history: [histEntry('move', { ...me, note: 'works 段恢复：' + sid, fromPath: 'active-works', toPath: relOf(dst), keep: false })],
    }
    await writeJson(dst, obj)
    await writeJson(path, act)
    return { ok: true, text: '已恢复 works 段：' + sid, path: dst }
  }
  async function writeActive(sid, turn, extra) {
    const ownerKey = (extra && extra.ownerKey) || ''
    const { obj: act, path } = await readAgentActive(ownerKey)
    const oldSummary = act.summary || ''
    let summaryChanged = false
    let refChanged = false
    if (extra) {
      if (extra.lastMemRef !== undefined && extra.lastMemRef !== act.lastMemRef) { act.lastMemRef = extra.lastMemRef; refChanged = true }
      if (extra.lastAction !== undefined && extra.lastAction !== act.lastAction) { act.lastAction = extra.lastAction; refChanged = true }
    }
    let recordChanged = false
    if (extra && extra.record && extra.record.text) {
      act.records = act.records || []
      const recKey = String(extra.record.key || '').trim()
      const rec = {
        text: String(extra.record.text).trim(),
        refs: Array.isArray(extra.record.refs) ? extra.record.refs : [],
        at: nowIso(),
        op: extra.record.op || 'prepend',
        key: recKey,
        sid: recKey.indexOf('session:') === 0 ? recKey.slice(8) : String(extra.record.sid || ''),
      }
      if (rec.text) {
        const op = rec.op
        if (op === 'prepend' || op === 'append' || op === 'merge' || op === 'replace') {
          let idx = -1
          if (recKey) idx = act.records.findIndex(r => r && r.key === recKey)
          if (idx < 0 && rec.sid) idx = act.records.findIndex(r => r && r.sid === rec.sid)
          if (idx >= 0 && op !== 'prepend') {
            const oldRec = act.records[idx]
            const oldSnapshot = { ...oldRec, keptAt: nowIso() }
            pushMergedHistory(act, histEntry('update', {
              agent: ownerKey || sid, session: sid, turn,
              note: '活跃记录' + (op === 'replace' ? '覆盖' : op === 'merge' ? '合并' : '追加') + '（旧记录归档）：' + String(oldRec.text || '').slice(0, 60),
              keep: false,
              delta: [{ type: 'record', from: oldRec.text, to: rec.text }],
            }))
            act.records[idx] = Object.assign({}, oldRec, { text: rec.text, refs: (oldRec.refs || []).concat(rec.refs), updatedAt: nowIso() })
          } else {
            const mergeIdx = recKey ? act.records.findIndex(r => r && (r.key === recKey || (rec.sid && r.sid === rec.sid))) : -1
            if (mergeIdx >= 0) {
              const oldRec = act.records[mergeIdx]
              act.records[mergeIdx] = Object.assign({}, oldRec, { text: rec.text + '。' + String(oldRec.text || ''), refs: rec.refs.concat(oldRec.refs || []), updatedAt: nowIso(), key: recKey || oldRec.key, sid: rec.sid || oldRec.sid })
            } else {
              act.records.unshift(rec)
            }
          }
        }
        if (recKey || rec.sid) {
          const seen = {}
          act.records = act.records.filter(r => {
            const k = r && (r.key || (r.sid ? 'sid:' + r.sid : ''))
            if (!k) return true
            if (seen[k]) {
              const keep = seen[k]
              keep.text = String(keep.text || '') + '。' + String(r.text || '')
              keep.refs = (keep.refs || []).concat(r.refs || [])
              return false
            }
            seen[k] = r
            return true
          })
        }
        const recMax = Math.max(1, Number(cfg().indexScore && cfg().indexScore.maxRefs) || 50)
        if (act.records.length > recMax) act.records = act.records.slice(0, recMax)
        recordChanged = true
      }
    }
    if (extra && Array.isArray(extra.keywords)) {
      const merged = (Array.isArray(act.keywords) ? act.keywords : []).concat(extra.keywords.map(String))
      const seen = new Set()
      const next = merged.filter(k => { const s = String(k || '').trim(); if (!s || seen.has(s)) return false; seen.add(s); return true }).slice(0, 20)
      if (next.join('|') !== (Array.isArray(act.keywords) ? act.keywords : []).join('|')) { act.keywords = next; recordChanged = true }
    }
    if (extra && extra.explicitSummary) {
      const newS = String(extra.explicitSummary).trim().slice(0, 120)
      if (newS && !summarySimilar(act.summary, newS)) {
        if (oldSummary) {
          pushMergedHistory(act, histEntry('update', {
            agent: ownerKey || sid, session: sid, turn,
            note: '会话摘要更新（旧摘要归档）：' + oldSummary.slice(0, 80),
            keep: false,
            delta: diffContent(oldSummary, newS),
          }))
        }
        act.summary = newS
        act.summaryNoModel = false
        act.summaryUpdatedAt = nowIso()
        summaryChanged = true
      }
    } else if (!extra || extra.summarize !== false) {
      // （已移除）独立摘要器 summarizeSessionTurn
    }
    if (!summaryChanged && !refChanged && !recordChanged) return undefined
    if (recordChanged && act.records && act.records.length) {
      const topRec = act.records[0]
      const newS = String(topRec.text || '').slice(0, 120)
      if (newS && !summarySimilar(act.summary, newS)) {
        if (oldSummary) {
          pushMergedHistory(act, histEntry('update', {
            agent: ownerKey || sid, session: sid, turn,
            note: '会话摘要同步（记录链顶部）：' + oldSummary.slice(0, 80),
            keep: false,
            delta: diffContent(oldSummary, newS),
          }))
        }
        act.summary = newS
        act.summaryUpdatedAt = nowIso()
        summaryChanged = true
      }
    }
    if (recordChanged && Array.isArray(act.records) && act.records.length) {
      const charsK = Math.max(1, Number(cfg().summaryCharsK) || 2)
      const langTable = (Array.isArray(adminCfg && adminCfg().langTokens) && adminCfg().langTokens.length) ? adminCfg().langTokens : [{ kind: 'cn', per: 1.5 }, { kind: 'en', per: 4 }]
      let maxPer = 1.5
      for (const lt of langTable) { if (lt && typeof lt.per === 'number') maxPer = Math.max(maxPer, lt.per) }
      const budgetChars = Math.max(500, Math.round(charsK * 1000 * maxPer))
      const linkRe = /\[[^\]]*\]\([^)]*\)/g
      let total = 0
      for (const r of act.records) total += String(r.text || '').length
      for (let i = act.records.length - 1; i >= 0 && total > budgetChars; i--) {
        const r = act.records[i]
        const full = String(r.text || '')
        if (!full) { total -= 0; continue }
        if (full.length > 60) {
          total -= full.length
          r.text = full.slice(0, 60) + '…（已压缩，详见 [原文](' + (r.sid ? r.sid + '@' : '') + ')）'
          total += r.text.length
        }
      }
    }
    act.updatedAt = nowIso()
    await writeJson(path, act)
    if (recordChanged) await refreshActiveIndex().catch(() => null)
    return { ok: true, text: '活跃记忆已更新', obj: act }
  }
  async function refreshActiveIndex() {
    // 完整聚合（重构后曾退化为仅 agents）：refs（各活跃文件+works 段指针）/ recentPeriods / agents+summary
    const list = await listFiles(activeDir(), false)
    const idx = { updatedAt: nowIso(), refs: [], recentPeriods: [], agents: [] }
    const seenAgent = new Set()
    const seenRef = new Set()
    for (const f of list) {
      if (f.name === 'active.json') continue
      const o = await readJson(f.path)
      if (!o || isTombstone(o)) continue
      const agent = String(o.agent || f.name.replace(/\.json$/, '') || '').trim()
      if (agent && !seenAgent.has(agent)) {
        seenAgent.add(agent)
        idx.agents.push({ agent, updatedAt: o.updatedAt || '', summary: String(o.summary || '').slice(0, 120) })
      }
      // 顶层 refs + 各 works 段 refs 一并聚合（去重）
      const refs = Array.isArray(o.refs) ? o.refs : []
      if (Array.isArray(o.works)) for (const w of o.works) if (w && Array.isArray(w.refs)) refs.push(...w.refs)
      for (const r of refs) {
        if (!r || !r.title) continue
        const key = (r.kind || '') + '|' + r.title
        if (seenRef.has(key)) continue
        seenRef.add(key)
        idx.refs.push({ kind: r.kind || 'keyword', title: r.title, ref: r.ref || r.title })
      }
    }
    idx.agents.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    // 最近周期：周期记忆目录最新若干文件（recentPeriods = rel 列表）
    try {
      const periods = (await listFiles(periodBaseDir(), true)).map(f => relOf(f.path))
      periods.sort((a, b) => b.localeCompare(a))
      idx.recentPeriods = periods.slice(0, 10)
    } catch (e) { idx.recentPeriods = [] }
    // refs 总量上限（indexScore.maxRefs 防膨胀）
    try {
      const maxRefs = Math.max(20, Number((cfg() && cfg().indexScore && cfg().indexScore.maxRefs) || 50))
      idx.refs = idx.refs.slice(0, maxRefs)
    } catch (e) {}
    await writeJson(activeIndexPath(), idx)
    return idx
  }
  async function touchActive(meta, lastMemRef, lastAction, removed, keywords) {
    const ownerKey = (meta && (meta.agent || meta.session)) ? String(meta.agent || meta.session) : ''
    if (!ownerKey) return undefined
    const { obj: act, path } = await readAgentActive(ownerKey)
    const changed = (lastMemRef !== undefined && lastMemRef !== act.lastMemRef) || (lastAction !== undefined && lastAction !== act.lastAction)
    if (changed) {
      if (lastMemRef !== undefined) act.lastMemRef = lastMemRef
      if (lastAction !== undefined) act.lastAction = lastAction
      act.history = act.history || []
      act.history.push(histEntry('update', { ...meta, note: (lastAction || '记忆操作') + (removed ? '（移除）' : ''), keep: true }))
      act.history = act.history.slice(-50)
      act.updatedAt = nowIso()
      await writeJson(path, act)
    }
    return changed ? { obj: act, path } : undefined
  }

  return {
    activeIndexPath, activeKeyOf, readTurnUserTextRetry, summarySimilar,
    agentActivePath, agentActiveTitle, readAgentActive, withSourceRef,
    pushMergedHistory, queryDayCount, ensureSessionWorkSegment,
    archiveWorksSegment, restoreWorksSegment, writeActive, refreshActiveIndex, touchActive,
  }
}
