// mm-settings host half — 运动记忆设置固化包（file 插件，重启自留）
// 提供 connection channel /mmsettings：config/config-set/incidents/stats/diag/isolation/incident-restore/incident-clear
// client 半（client.js）通过 fetch POST /mmsettings/<endpoint> 调用。
// 设计：与 motion-memory.js 读写同一份配置文件（profile 固定位
// ~/.dsh/profiles/<profile>/motion-memory.config.json），UI 保存 = 运行时生效。
// 配置固定位在会话工作区之外，读写走原生 node:fs（同 motion-memory.js），
// 不受会话文件沙箱限制；记忆文件操作仍走 ctx.fs（沙箱）。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'

export const name = 'mm-settings'
export const inject = ['fs', 'connection', 'motionMemoryApi']

export function apply(ctx) {
  const fs = ctx.fs
  const connection = ctx.connection
  const state = { sessionCwd: '', lastSid: '' }

  function normWs(ws) { return String(ws || '').replace(/\\/g, '/').replace(/\/+$/, '') }
  // 会话身份键：session.header/meta.agentPreset → preset:<name>（同一 preset 会话共享活跃）；无则 '' 
  function ownerKeyOfSession(sid) {
    try {
      const sessions = ctx.get('sessions')
      if (sessions && sid) {
        const s = sessions.get(sid)
        if (s) {
          if (s.header && s.header.agentPreset) return 'preset:' + String(s.header.agentPreset)
          if (s.meta && s.meta.agentPreset) return 'preset:' + String(s.meta.agentPreset)
        }
      }
    } catch (e) {}
    return ''
  }
  function sessionCwdOf(session) {
    try {
      if (session && session.header && session.header.cwd) return session.header.cwd
    } catch (e) {}
    try {
      if (session && session.meta && session.meta.cwd) return session.meta.cwd
    } catch (e) {}
    return undefined
  }
  function cwdOf(agent, sid) {
    try {
      if (agent && agent.session && agent.session.header && agent.session.header.cwd) return agent.session.header.cwd
    } catch (e) {}
    try {
      const sessions = ctx.get('sessions')
      if (sessions && sid) {
        const s = sessions.get(sid)
        if (s && s.header && s.header.cwd) return s.header.cwd
      }
    } catch (e) {}
    try {
      const ws = ctx.get('workspaceRegistry')
      if (ws) {
        const list = ws.list()
        if (list && list.length && list[0] && list[0].path) return list[0].path
      }
    } catch (e) {}
    return undefined
  }
  function setSessionCwd(cwd) {
    if (cwd && !state.sessionCwd) state.sessionCwd = normWs(cwd)
  }
  function wsRoot() {
    if (state.sessionCwd) return normWs(state.sessionCwd)
    // 回退：workspaceRegistry 中第一个含 .cache/运动记忆 的工作区
    try {
      const ws = ctx.get('workspaceRegistry')
      if (ws) {
        const list = ws.list()
        for (const w of list || []) {
          if (w && w.path) {
            const p = normWs(w.path)
            if (p.indexOf('.cache/运动记忆') >= 0 || p.indexOf('.cache\\运动记忆') >= 0) return p
          }
        }
        if (list && list.length && list[0] && list[0].path) return normWs(list[0].path)
      }
    } catch (e) {}
    try {
      const sp = ctx.get('sandboxPolicy')
      if (sp && sp.workspaceRoot) return normWs(sp.workspaceRoot)
    } catch (e) {}
    return ''
  }
  // 捕获会话 cwd（= 工作区），与 motion-memory.js 同机制
  ctx.on('session/event', (session, event) => {
    if (!session) return
    state.lastSid = session.id || state.lastSid
    setSessionCwd(sessionCwdOf(session))
  })
  ctx.on('agent/request', (payload, next) => {
    const a = payload && payload.agent
    const aid = a && (a.id || (a.session && a.session.id))
    if (aid) { state.lastSid = aid; setSessionCwd(cwdOf(a, aid)) }
    return next()
  })
  // 会话策略：按最近会话解析 sandboxPolicy（写盘边界 = 会话工作区）
  function sessionPolicy() {
    try {
      const sp = ctx.get('sandboxPolicy')
      if (sp && state.lastSid) {
        const sessions = ctx.get('sessions')
        const s = sessions && sessions.get(state.lastSid)
        if (s) return sp.resolve({ session: s })
      }
    } catch (e) {}
    return undefined
  }
  // ── 配置固定位：与 motion-memory.js 的 configPath() 完全一致 ────────────
  // 优先用宿主注入的 dshHomePath 服务（$DSH_HOME > ~/.dsh），回退环境变量逻辑
  function dshProfileName() { return String(process.env.DSH_PROFILE || 'web') }
  function profileCfgPath() {
    try {
      const dhp = ctx.get('dshHomePath')
      if (dhp && typeof dhp === 'function') return normWs(dhp('profiles', dshProfileName(), 'motion-memory.config.json'))
    } catch (e) {}
    const h = String(process.env.DSH_HOME || '').replace(/\\/g, '/')
    if (h) return normWs(p(h, 'profiles', dshProfileName(), 'motion-memory.config.json'))
    const up = String(process.env.USERPROFILE || '').replace(/\\/g, '/')
    return up ? normWs(p(up, '.dsh', 'profiles', dshProfileName(), 'motion-memory.config.json')) : ''
  }
  function cfgPath() { return profileCfgPath() || (wsRoot() + '/.cache/运动记忆/config.json') }
  function rootOf(c) { return (c.root && String(c.root).trim()) ? String(c.root).replace(/\\/g, '/').replace(/\/+$/, '') : wsRoot() + '/.cache/运动记忆' }
  function p() {
    const out = []
    for (let i = 0; i < arguments.length; i++) {
      const s = String(arguments[i])
      if (s !== '' && s != null) out.push(s.replace(/\\/g, '/'))
    }
    return out.join('/')
  }
  function pad(n) { return n < 10 ? '0' + n : String(n) }
  function nowIso() { return new Date().toISOString() }
  function parseIso(iso) { const t = new Date(iso).getTime(); return Number.isFinite(t) ? t : 0 }
  function isoStr(t) { return new Date(t).toISOString() }
  function stamp(d) { const q = partsOf(d || new Date()); return q.y + '-' + q.m + '-' + q.day + '_' + q.h + '-' + q.min + '-' + q.s }
  function partsOf(d) { return { y: d.getFullYear(), m: pad(d.getMonth() + 1), day: pad(d.getDate()), h: pad(d.getHours()), min: pad(d.getMinutes()), s: pad(d.getSeconds()) } }
  function uid() { return 'mm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) }
  function fileNameOf(path) { return String(path).split('/').pop() }
  function relOf(path, r) { return String(path).replace(String(r).replace(/\\/g, '/'), '').replace(/^\/+/, '') }
  function isolationDirOf(r) { return p(r, '隔离记忆') }
  function quarantineDirOf(r) { return p(isolationDirOf(r), '_审阅') }
  function dailyBaseDirOf(r) { return p(r, '记忆累积') }

  // 周期总结方案/素材档位：与 motion-memory 运行时一致
  // scope 1=仅记忆 2=+会话首尾 3=+全量轮次；档位为该方案下的细化
  const PERIOD_DEFAULTS = { 1: 'events-nomodel', 2: 'first-last', 3: 'infer' }
  const PERIOD_DETAILS = { 1: ['events', 'events-nomodel'], 2: ['first', 'first-last'], 3: ['infer', 'infer-full', 'infer-tail'] }

  function defaultConfig() {
    return {
      enabled: true, inject: true, injectLimitBytes: 4096,
      root: '', recordModel: { provider: '', model: '' },
      recentOverviewN: 3, cascadeDepth: 3, archiveDays: 30,
      queryHistoryN: 0, updateHistoryN: 0, historyPageSize: 20,
      admin: {
        enabled: false, model: { provider: '', model: '' },
        contextTokens: 128000, summaryPercent: 50,
        langTokens: [
          { kind: 'cn', lang: '中文', per: 1.5 },
          { kind: 'en', lang: 'english', per: 1 },
          { kind: 'ja', lang: '日文', per: 1.5 },
          { kind: 'ko', lang: '韩文', per: 1.5 },
          { kind: 'other', lang: '其他', per: 1 },
        ],
        concurrency: 0, singleFileTokens: 2048, recallDepth: 1,
        outputTokens: 1024, extraJson: null, dailyBudget: 0,
        summaryConcurrency: 0,
      },
    }
  }
  // 候选 config 路径：优先 profile 固定位（与运行时一致），其次会话 cwd /
  // workspaceRegistry 各工作区 / sandboxPolicy.workspaceRoot 的旧工作区位置（兼容回退）。
  function candidateCfgPaths() {
    const paths = []
    const seen = new Set()
    const push = (ws) => {
      const w = normWs(ws)
      if (!w || seen.has(w)) return
      seen.add(w)
      paths.push(p(w, '.cache', '运动记忆', 'config.json'))
    }
    const pc = profileCfgPath()
    if (pc && !seen.has(pc)) { seen.add(pc); paths.push(pc) }
    if (state.sessionCwd) push(state.sessionCwd)
    try {
      const ws = ctx.get('workspaceRegistry')
      if (ws) {
        for (const w of ws.list() || []) {
          if (w && w.path) push(w.path)
        }
      }
    } catch (e) {}
    try {
      const sp = ctx.get('sandboxPolicy')
      if (sp && sp.workspaceRoot) push(sp.workspaceRoot)
    } catch (e) {}
    return paths
  }
  async function readCfg() {
    const candidates = candidateCfgPaths()
    // profile 固定位在会话工作区外：原生 fs 直读，不受沙箱限制
    for (const cand of candidates) {
      if (cand === profileCfgPath()) {
        try {
          if (existsSync(cand)) {
            const o = JSON.parse(readFileSync(cand, 'utf8'))
            const d = defaultConfig()
            return Object.assign(d, o || {})
          }
        } catch (e) {}
      }
    }
    // 回退：旧工作区位置（ctx.fs）
    for (const cand of candidates) {
      try {
        const t = await fs.resolve(cand)
        const info = await fs.stat(t)
        if (!info || info.type !== 'file') continue
        const txt = await fs.readText(t)
        const o = JSON.parse(txt)
        const d = defaultConfig()
        return Object.assign(d, o || {})
      } catch (e) {}
    }
    return defaultConfig()
  }
  async function writeCfg(c) {
    // 写回 profile 固定位（与运行时同一文件），原生 fs 直写
    const pc = profileCfgPath()
    if (pc) {
      try {
        const idx = pc.lastIndexOf('/')
        if (idx > 0) mkdirSync(pc.slice(0, idx), { recursive: true })
        writeFileSync(pc, JSON.stringify(c, null, 1), 'utf8')
        return
      } catch (e) {
        console.error('mm-settings: 写固定位配置失败 ' + pc + ': ' + (e && e.message))
      }
    }
    // 回退：写与读一致的位置（旧工作区路径）
    let target = cfgPath()
    const candidates = candidateCfgPaths()
    if (candidates.length) target = candidates[0]
    const t = await fs.resolve(target)
    await fs.writeText(t, JSON.stringify(c, null, 1), undefined, undefined, sessionPolicy())
  }
  async function readJson(path) {
    try {
      const target = await fs.resolve(path)
      const info = await fs.stat(target)
      if (!info || info.type !== 'file') return undefined
      const text = await fs.readText(target)
      return JSON.parse(text)
    } catch (e) { return undefined }
  }
  async function writeJson(path, obj) {
    await readJson(path)
    const target = await fs.resolve(path)
    await fs.writeText(target, JSON.stringify(obj, null, 1), undefined, undefined, sessionPolicy())
    return path
  }
  async function tombstone(path, movedTo) { await writeJson(path, { tombstone: true, movedTo, at: nowIso() }) }
  function isTombstone(o) { return !!(o && o.tombstone) }
  async function listFiles(dirPath, recursive) {
    const out = []
    try {
      const target = await fs.resolve(dirPath)
      const info = await fs.stat(target)
      if (!info || info.type !== 'directory') return out
      const entries = await fs.listDir(target)
      for (const e of entries) {
        const child = p(dirPath, e.name)
        if (e.type === 'directory') { if (recursive) out.push(...(await listFiles(child, true))) }
        else if (e.type === 'file') out.push({ path: child, name: e.name })
      }
    } catch (e) {}
    return out
  }
  function lastOpTime(o) {
    const h = (o.history || [])
    return h.length ? parseIso(h[h.length - 1].at) : (parseIso(o.updatedAt) || parseIso(o.createdAt))
  }
  function lastOp(o) {
    const h = (o.history || [])
    return h.length ? h[h.length - 1] : null
  }
  function splitParagraphs(text) {
    return String(text || '').split(/\r?\n/).map(s => s.trim()).filter(s => s !== '')
  }
  function splitSentences(para) {
    const s = String(para || '').trim()
    if (!s) return []
    const out = []
    const re = /[^。！？!?；;.]+[。！？!?；;.]*/gu
    let m
    while ((m = re.exec(s)) !== null) { const t = m[0].trim(); if (t) out.push(t) }
    if (!out.length) out.push(s)
    return out
  }
  function applyInverseParagraph(para, changes) {
    let s = splitSentences(para)
    for (let i = changes.length - 1; i >= 0; i--) {
      const c = changes[i]
      if (c.from === null) { if (c.index < s.length) s.splice(c.index, 1) }
      else if (c.to === null) { s.splice(Math.min(c.index, s.length), 0, c.from) }
      else if (c.index < s.length) { s[c.index] = c.from }
    }
    return s.join('')
  }
  function applyInverse(content, delta) {
    const paras = splitParagraphs(content)
    for (let i = delta.length - 1; i >= 0; i--) {
      const pc = delta[i]
      if (pc.paragraph < paras.length) paras[pc.paragraph] = applyInverseParagraph(paras[pc.paragraph], pc.changes || [])
    }
    return paras.join('\n')
  }
  function reconstructAt(obj, tMs) {
    let content = obj.content || ''
    const hist = (obj.history || []).slice()
    for (let i = hist.length - 1; i >= 0; i--) {
      if (parseIso(hist[i].at) <= tMs) break
      if (hist[i].delta && hist[i].delta.length) content = applyInverse(content, hist[i].delta)
    }
    return content
  }
  function stateAt(obj, path, tMs, r) {
    const content = reconstructAt(obj, tMs)
    let cur = path
    const hist = (obj.history || []).slice()
    for (let i = hist.length - 1; i >= 0; i--) {
      if (parseIso(hist[i].at) <= tMs) break
      if (hist[i].op === 'move' && hist[i].toPath === relOf(cur, r)) cur = p(r, hist[i].fromPath)
    }
    return { content, path: cur }
  }
  function histEntry(op, meta) {
    return {
      at: nowIso(),
      agent: (meta && meta.agent) || '',
      session: (meta && meta.session) || '',
      turn: (meta && meta.turn) || 0,
      op,
      note: (meta && meta.note) || '',
      keep: !(meta && meta.keep === false),
      delta: (meta && meta.delta) || [],
      fromPath: meta && meta.fromPath,
      toPath: meta && meta.toPath,
    }
  }
  async function uniquePath(dir, filename) {
    const names = new Set((await listFiles(dir, false)).map(f => f.name))
    if (!names.has(filename)) return p(dir, filename)
    for (let i = 2; i < 100; i++) { const cand = filename.replace(/\.json$/, '') + '-' + i + '.json'; if (!names.has(cand)) return p(dir, cand) }
    return p(dir, 'x-' + uid() + '.json')
  }
  function fmt(m) { return (m && m.provider && m.model) ? m.provider + '/' + m.model : '' }
  function parseModel(s) { const parts = String(s || '').split('/'); return { provider: parts[0] || '', model: parts[1] || '' } }
  // 子级 model 结构体（track/enhance/period）：空字段 = 跟随全局（placeholder 显示全局值）
  function modelStruct(m) {
    m = m || {}
    return {
      provider: m.provider || '',
      model: m.model || '',
      contextTokens: (m.contextTokens !== undefined && m.contextTokens !== null) ? m.contextTokens : '',
      summaryPercent: (m.summaryPercent !== undefined && m.summaryPercent !== null) ? m.summaryPercent : '',
      outputTokens: (m.outputTokens !== undefined && m.outputTokens !== null) ? m.outputTokens : '',
      concurrency: (m.concurrency !== undefined && m.concurrency !== null) ? m.concurrency : '',
      delegateBlocks: !!(m.delegateBlocks),
      extraJson: (m.extraJson !== undefined && m.extraJson !== null) ? m.extraJson : null,
    }
  }
  // 写回子级 model 结构体：空字符串/空值 = 清除该字段（继承全局）；extraJson null = 清除覆盖
  function applySubModel(a, key, paVal) {
    if (paVal === undefined) return false
    a[key] = a[key] || {}
    const m = a[key]
    if (typeof paVal === 'string') {
      const pm = parseModel(paVal)
      if (pm.provider || pm.model) { m.provider = pm.provider; m.model = pm.model }
    } else if (paVal && typeof paVal === 'object') {
      if (paVal.provider !== undefined && paVal.provider !== '') m.provider = String(paVal.provider)
      else if (paVal.provider === '') delete m.provider
      if (paVal.model !== undefined && paVal.model !== '') m.model = String(paVal.model)
      else if (paVal.model === '') delete m.model
      for (const k of ['contextTokens', 'summaryPercent', 'outputTokens', 'concurrency']) {
        if (paVal[k] === undefined || paVal[k] === null || paVal[k] === '') delete m[k]
        else m[k] = Number(paVal[k])
      }
      if ('extraJson' in paVal) {
        if (paVal.extraJson === null || paVal.extraJson === '' || paVal.extraJson === undefined) delete m.extraJson
        else m.extraJson = paVal.extraJson
      }
      if ('allowThinking' in paVal) {
        if (paVal.allowThinking === null || paVal.allowThinking === undefined) delete m.allowThinking
        else m.allowThinking = !!paVal.allowThinking
      }
    }
    if (Object.keys(m).length === 0) delete a[key]
    return true
  }

  function flatten(c) {
    const adm = c.admin || {}
    const track = adm.track || {}
    const enhance = adm.enhance || {}
    const period = adm.period || {}
    return {
      config: {
        enabled: !!c.enabled, inject: !!c.inject, injectLimitBytes: c.injectLimitBytes || 4096, root: c.root || '',
        recentOverviewN: c.recentOverviewN || 3, archiveDays: c.archiveDays || 30,
        cascadeDepth: c.cascadeDepth === undefined ? 3 : c.cascadeDepth,
        queryHistoryN: c.queryHistoryN || 0, updateHistoryN: c.updateHistoryN || 0, historyPageSize: c.historyPageSize || 20, queryOtherAgents: !!c.queryOtherAgents,
        decayDays: c.decayDays || 30, activeNotify: c.activeNotify !== false, readTrimChars: c.readTrimChars || 500,
        recordModel: { provider: (c.recordModel && c.recordModel.provider) || '', model: (c.recordModel && c.recordModel.model) || '' },
        admin: {
          enabled: !!adm.enabled,
          model: fmt(adm.model),
          trackModel: modelStruct(track.model),
          enhanceModel: modelStruct(enhance.model),
          periodModel: modelStruct(period.model),
          contextTokens: adm.contextTokens || 128000, summaryPercent: adm.summaryPercent || 50,
          langTokens: Array.isArray(adm.langTokens) ? adm.langTokens : [
            { kind: 'cn', lang: '中文', per: 1.5 },
            { kind: 'en', lang: 'english', per: 4 },
            { kind: 'ja', lang: '日文', per: 1.5 },
            { kind: 'ko', lang: '韩文', per: 1.5 },
          ],
          concurrency: adm.concurrency || 0, singleFileTokens: adm.singleFileTokens || 2048, recallDepth: adm.recallDepth || 1,
          outputTokens: adm.outputTokens || 1024, extraJson: adm.extraJson || null, dailyBudget: adm.dailyBudget || 0,
          summaryConcurrency: adm.summaryConcurrency || 0,
          track: !!(track.enabled), trackInjectActive: track.injectActive !== false, trackInterval: track.interval === undefined || track.interval === null ? 0 : track.interval,
          trackStartTurn: track.startTurn === undefined || track.startTurn === null ? 0 : track.startTurn,
          trackEconomize: track.economize || 'none', trackTruncK: track.truncK || 2,
          trackRefPrecision: (track.refPrecision === 'step') ? 'step' : 'turn',
          trackDelegateBlocks: !!(track.delegateBlocks),
          enhance: !!(enhance.enabled), enhanceMaxDepth: enhance.maxExpandDepth || 3,
          period: !!(period.enabled), periodDays: period.intervalDays || 1, periodHours: period.intervalHours || 0,
          periodMultiWindow: !!(period.multiWindowTail), periodUseTools: period.useTools !== false,
          periodImpactPercent: period.impactPercent || 100, periodImpactCount: period.impactCount || 0,
          periodSessionBounds: !!(period.sessionBounds),
          periodMemFiles: !!(period.memFiles),
          periodScope: Number(period.scope) || 1,
          periodScopeDetail: period.scopeDetail || PERIOD_DEFAULTS[Number(period.scope) || 1],
          periodTruncK: period.truncK || 2,
          periodEconomize: period.economize || 'none',
          periodSkipRecent: (period.skipRecentDays === undefined || period.skipRecentDays === null) ? 14 : period.skipRecentDays,
        },
      },
    }
  }

  async function runIsolation(args) {
    const c = await readCfg()
    const r = rootOf(c)
    let tMs = 0
    let durationText = ''
    if (args && args.targetTime) {
      tMs = parseIso(args.targetTime)
      if (!tMs) return { ok: false, text: '无法解析目标时间：' + args.targetTime }
      if (tMs > Date.now()) return { ok: false, text: '目标时间不能晚于当前时间' }
      durationText = '指定时间 ' + isoStr(tMs)
    } else {
      const now = new Date()
      const t = new Date(now)
      t.setMonth(t.getMonth() - Math.max(0, (args && args.months) || 0))
      t.setDate(t.getDate() - Math.max(0, (args && args.days) || 0))
      t.setHours(t.getHours() - Math.max(0, (args && args.hours) || 0))
      t.setMinutes(t.getMinutes() - Math.max(0, (args && args.minutes) || 0))
      t.setSeconds(t.getSeconds() - Math.max(0, (args && args.seconds) || 0))
      tMs = t.getTime()
      durationText = (args.months || 0) + '月' + (args.days || 0) + '日' + (args.hours || 0) + '时' + (args.minutes || 0) + '分' + (args.seconds || 0) + '秒'
    }
    const files = []
    for (const f of await listFiles(dailyBaseDirOf(r), true)) {
      const rel = relOf(f.path, r)
      if (/^必要\//.test(rel)) continue
      const o = await readJson(f.path)
      if (!o || isTombstone(o)) continue
      const created = parseIso(o.createdAt)
      const last = lastOpTime(o)
      if (last > tMs || created > tMs) files.push({ rel, created, last, op: lastOp(o), createdAfter: created > tMs })
    }
    if (!files.length) return { ok: true, text: '目标时间 ' + isoStr(tMs) + ' 之后没有任何操作记录，无需隔离' }
    const id = stamp()
    const dir = p(isolationDirOf(r), id)
    const mirror = p(dir, 'mirror')
    for (const f of files) {
      const src = p(r, f.rel)
      const raw = await readJson(src)
      if (raw !== undefined) await writeJson(p(mirror, f.rel), raw)
    }
    const incident = {
      id, at: nowIso(), targetTime: isoStr(tMs),
      durationText,
      files: files.map(f => ({ rel: f.rel, createdAt: isoStr(f.created), lastOpAt: isoStr(f.last), op: f.op ? f.op.op : null, createdAfter: f.createdAfter })),
      restoredAt: null, clearedAt: null, session: 'settings-ui',
    }
    await writeJson(p(dir, 'incident.json'), incident)
    const preview = files.slice(0, 50)
    return {
      ok: true,
      text: '记忆隔离已触发：事件 ' + id + '，目标时间 ' + incident.targetTime + '（' + durationText + '），受影响 ' + files.length + ' 个文件（污染态已复制到 ' + relOf(mirror, r) + '）。\n' + preview.map(f => (f.createdAfter ? '[T之后新建] ' : '[受影响] ') + f.rel + '（最后操作 ' + f.lastOpAt + '）').join('\n') + (files.length > 50 ? '\n…共 ' + files.length + ' 个' : ''),
      data: { id, targetTime: incident.targetTime, fileCount: files.length },
    }
  }

  async function runRestore(args) {
    const c = await readCfg()
    const r = rootOf(c)
    const id = args && args.id
    const incPath = p(isolationDirOf(r), id, 'incident.json')
    const inc = await readJson(incPath)
    if (!inc) return { ok: false, text: '未找到隔离事件：' + id }
    if (inc.restoredAt) return { ok: false, text: '该事件已回滚（' + inc.restoredAt + '）' }
    const tMs = parseIso(inc.targetTime)
    let restored = 0, quarantined = 0
    for (const f of inc.files || []) {
      const src = p(r, f.rel)
      const o = await readJson(src)
      if (!o || isTombstone(o)) continue
      if (f.createdAfter) {
        const q = await uniquePath(quarantineDirOf(r), fileNameOf(f.rel))
        await writeJson(q, o)
        await tombstone(src, q)
        quarantined++
        continue
      }
      const st = stateAt(o, src, tMs, r)
      const changed = st.content !== (o.content || '')
      if (changed) {
        o.content = st.content
        o.history.push(histEntry('restore', { agent: 'settings-ui', note: '隔离回滚至 ' + inc.targetTime + '（事件 ' + inc.id + '）' }))
        o.updatedAt = nowIso()
      }
      if (st.path !== src) { await writeJson(st.path, o); await tombstone(src, st.path) }
      else if (changed) { await writeJson(src, o) }
      restored++
    }
    inc.restoredAt = nowIso()
    await writeJson(incPath, inc)
    return { ok: true, text: '已回滚事件 ' + inc.id + ' 至 ' + inc.targetTime + '：恢复 ' + restored + ' 个文件，T 之后新建 ' + quarantined + ' 个文件已移入 _审阅。' }
  }

  // 会话标题兜底：经 motionMemoryApi.readSessionTitle 由 motion-memory 读会话日志（避免并发 import 同一 ESM）
  async function readSessionTitleFromLog(sid) {
    try {
      const api = ctx.motionMemoryApi
      if (!api || typeof api.readSessionTitle !== 'function' || !sid) return ''
      const r = await api.readSessionTitle({ sid })
      return (r && r.ok && r.title) ? String(r.title) : ''
    } catch (e) { return '' }
  }

  async function handle(endpoint, payload) {
    switch (endpoint) {
      case 'config': {
        const c = await readCfg()
        return { ok: true, ...flatten(c) }
      }
      case 'config-set': {
        const patch = (payload && payload.patch) || {}
        const c = await readCfg()
        let changed = false
        const baseKeys = ['enabled', 'inject', 'injectLimitBytes', 'root', 'recentOverviewN', 'archiveDays', 'cascadeDepth', 'queryHistoryN', 'updateHistoryN', 'historyPageSize', 'decayDays', 'activeNotify', 'queryOtherAgents', 'readTrimChars']
        for (const k of baseKeys) { if (patch[k] !== undefined && patch[k] !== c[k]) { c[k] = patch[k]; changed = true } }
        if (patch.root !== undefined && patch.root !== c.root) { c.rootUserSet = true }
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
          if (pa.model !== undefined) { a.model = parseModel(pa.model); changed = true }
          if (pa.trackModel !== undefined) { a.track = a.track || {}; changed = applySubModel(a.track, 'model', pa.trackModel) || changed }
          if (pa.enhanceModel !== undefined) { a.enhance = a.enhance || {}; changed = applySubModel(a.enhance, 'model', pa.enhanceModel) || changed }
          if (pa.periodModel !== undefined) { a.period = a.period || {}; changed = applySubModel(a.period, 'model', pa.periodModel) || changed }
          const nums = ['contextTokens', 'summaryPercent', 'concurrency', 'singleFileTokens', 'recallDepth', 'outputTokens', 'dailyBudget', 'summaryConcurrency', 'trackInterval', 'trackTruncK', 'enhanceMaxDepth', 'periodDays', 'periodHours', 'periodImpactPercent', 'periodImpactCount']
          for (const k of nums) { if (pa[k] !== undefined) { a[k] = Number(pa[k]); changed = true } }
          const bools = ['periodMultiWindow', 'periodSessionBounds', 'periodMemFiles']
          for (const k of bools) { if (pa[k] !== undefined) { a[k] = !!pa[k]; changed = true } }
          if (pa.trackEconomize !== undefined) { a.track = a.track || {}; a.track.economize = Array.isArray(pa.trackEconomize) ? pa.trackEconomize : String(pa.trackEconomize); changed = true }
          if (pa.periodUseTools !== undefined) { a.period = a.period || {}; a.period.useTools = !!pa.periodUseTools; changed = true }
          if (Array.isArray(pa.langTokens)) { a.langTokens = pa.langTokens; changed = true }
          if (pa.extraJson !== undefined) { a.extraJson = pa.extraJson; changed = true }
          for (const sk of ['track', 'enhance', 'period']) {
            if (pa[sk] && typeof pa[sk] === 'object') {
              a[sk] = a[sk] || {}
              for (const k of Object.keys(pa[sk])) { if (pa[sk][k] !== undefined) { a[sk][k] = pa[sk][k]; changed = true } }
            }
          }
          // 周期总结方案/素材档位（client 扁平字段 → admin.period.scope/scopeDetail/truncK）
          if (pa.periodScope !== undefined) {
            a.period = a.period || {}
            const s = Math.min(3, Math.max(1, Number(pa.periodScope) || 1))
            a.period.scope = s
            // 切方案时若当前档位不适用，重置为该方案的默认档位（与 client 的 valid 表一致）
            const cur = a.period.scopeDetail
            if (!cur || (PERIOD_DETAILS[s] || []).indexOf(cur) < 0) a.period.scopeDetail = PERIOD_DEFAULTS[s]
            changed = true
          }
          if (pa.periodScopeDetail !== undefined) {
            a.period = a.period || {}
            const s = Math.min(3, Math.max(1, Number(a.period.scope) || 1))
            const d = String(pa.periodScopeDetail)
            a.period.scopeDetail = (PERIOD_DETAILS[s] || []).indexOf(d) >= 0 ? d : PERIOD_DEFAULTS[s]
            changed = true
          }
          if (pa.periodTruncK !== undefined) { a.period = a.period || {}; a.period.truncK = Math.max(0, Number(pa.periodTruncK) || 2); changed = true }
          if (pa.periodEconomize !== undefined) { a.period = a.period || {}; a.period.economize = Array.isArray(pa.periodEconomize) ? pa.periodEconomize : String(pa.periodEconomize); changed = true }
          if (pa.track !== undefined || pa.trackInterval !== undefined || pa.trackStartTurn !== undefined || pa.trackEconomize !== undefined || pa.trackTruncK !== undefined || pa.trackModel !== undefined || pa.trackRefPrecision !== undefined || pa.trackDelegateBlocks !== undefined) {
            a.track = a.track || {}
            if (pa.track !== undefined) a.track.enabled = !!pa.track
            if (pa.trackInjectActive !== undefined) a.track.injectActive = !!pa.trackInjectActive
            if (pa.trackInterval !== undefined) a.track.interval = Number(pa.trackInterval)
            if (pa.trackStartTurn !== undefined) a.track.startTurn = Number(pa.trackStartTurn)
            if (pa.trackEconomize !== undefined) a.track.economize = Array.isArray(pa.trackEconomize) ? pa.trackEconomize : String(pa.trackEconomize)
            if (pa.trackTruncK !== undefined) a.track.truncK = Number(pa.trackTruncK)
            if (pa.trackRefPrecision !== undefined) { a.track.refPrecision = (String(pa.trackRefPrecision) === 'step') ? 'step' : 'turn'; changed = true }
            if (pa.trackDelegateBlocks !== undefined) { a.track.delegateBlocks = !!pa.trackDelegateBlocks; changed = true }
          }
          if (pa.enhance !== undefined || pa.enhanceMaxDepth !== undefined || pa.enhanceModel !== undefined) {
            a.enhance = a.enhance || {}
            if (pa.enhance !== undefined) a.enhance.enabled = !!pa.enhance
            if (pa.enhanceMaxDepth !== undefined) a.enhance.maxExpandDepth = Number(pa.enhanceMaxDepth)
          }
          if (pa.period !== undefined || pa.periodDays !== undefined || pa.periodHours !== undefined || pa.periodMultiWindow !== undefined || pa.periodUseTools !== undefined || pa.periodImpactPercent !== undefined || pa.periodImpactCount !== undefined || pa.periodModel !== undefined || pa.periodSessionBounds !== undefined || pa.periodMemFiles !== undefined || pa.periodSkipRecent !== undefined) {
            a.period = a.period || {}
            if (pa.period !== undefined) a.period.enabled = !!pa.period
            if (pa.periodDays !== undefined) a.period.intervalDays = Number(pa.periodDays)
            if (pa.periodHours !== undefined) a.period.intervalHours = Number(pa.periodHours)
            if (pa.periodMultiWindow !== undefined) a.period.multiWindowTail = !!pa.periodMultiWindow
            if (pa.periodUseTools !== undefined) a.period.useTools = !!pa.periodUseTools
            if (pa.periodImpactPercent !== undefined) a.period.impactPercent = Number(pa.periodImpactPercent)
            if (pa.periodImpactCount !== undefined) a.period.impactCount = Number(pa.periodImpactCount)
            if (pa.periodSessionBounds !== undefined) a.period.sessionBounds = !!pa.periodSessionBounds
            if (pa.periodMemFiles !== undefined) a.period.memFiles = !!pa.periodMemFiles
            if (pa.periodSkipRecent !== undefined) a.period.skipRecentDays = Math.max(7, Number(pa.periodSkipRecent) || 14)
          }
          const hasModel = !!(a.model && a.model.provider && a.model.model)
          if (hasModel !== !!a.enabled) { a.enabled = hasModel; changed = true }
        }
        if (changed) await writeCfg(c)
        return { ok: true, ...flatten(c) }
      }
      case 'incidents': {
        const c = await readCfg()
        const isoDir = isolationDirOf(rootOf(c))
        const incs = []
        try {
          const t = await fs.resolve(isoDir)
          const entries = await fs.listDir(t)
          for (const e of entries || []) {
            try {
              const it = await fs.resolve(isoDir + '/' + e.name + '/incident.json')
              const o = JSON.parse(await fs.readText(it))
              if (o && o.id) incs.push({ id: o.id, targetTime: o.targetTime || '', fileCount: (o.files || []).length, restoredAt: o.restoredAt || null, clearedAt: o.clearedAt || null })
            } catch (err) {}
          }
        } catch (e) {}
        return { ok: true, incidents: incs }
      }
      case 'stats': {
        // 分层统计：本日新增 / 归档时间内 / 全部（事件含无模型整理记忆）
        const c = await readCfg()
        const r = rootOf(c)
        const days = Math.max(1, Number(c.archiveDays) || 30)
        const nd = new Date()
        const todayStr = nd.getFullYear() + '/' + pad(nd.getMonth() + 1) + '/' + pad(nd.getDate())
        const cutoff = Date.now() - days * 86400000
        let important = 0, archive = 0, period = 0, events = 0, noModel = 0
        let todayImportant = 0, todayEvents = 0
        let withinImportant = 0, withinPeriod = 0, withinEvents = 0
        for (const f of await listFiles(p(r, '记忆累积'), true)) {
          const rel = relOf(f.path, r)
          const o = await readJson(f.path)
          if (!o || isTombstone(o)) continue
          const created = parseIso(o.createdAt) || 0
          const last = lastOpTime(o) || created
          const cd = created ? (new Date(created).getFullYear() + '/' + pad(new Date(created).getMonth() + 1) + '/' + pad(new Date(created).getDate())) : ''
          const isToday = cd === todayStr
          if (rel.indexOf('记忆累积/重要/') === 0) {
            important++; if (isToday) todayImportant++; if (last > cutoff) withinImportant++
          } else if (rel.indexOf('记忆累积/补充/') === 0) {
            archive++
          } else if (rel.indexOf('记忆累积/周期记忆/') === 0) {
            period++; if (last > cutoff) withinPeriod++
          } else if (rel.indexOf('记忆累积/无模型记忆整理/') === 0) {
            noModel++
            if (isToday) todayEvents++
            if (last > cutoff) withinEvents++
          } else if (/\d{4}\/\d{2}\/\d{2}(?:\/|_)/.test('/' + rel)) {
            events++; if (isToday) todayEvents++; if (last > cutoff) withinEvents++
          }
        }
        return {
          ok: true, root: r, cfgPath: cfgPath(), sessionCwd: wsRoot(), days,
          important, archive, period, events, noModel,
          today: { important: todayImportant, events: todayEvents },
          within: { important: withinImportant, period: withinPeriod, events: withinEvents },
        }
      }
      case 'diag': {
        const c = await readCfg()
        return { ok: true, cfgPath: cfgPath(), root: rootOf(c), wsRoot: wsRoot() }
      }
      case 'isolation':
        return runIsolation(payload || {})
      case 'incident-restore':
        return runRestore(payload || {})
      case 'incident-clear': {
        const id = payload && payload.id
        const c = await readCfg()
        const incPath = p(isolationDirOf(rootOf(c)), id, 'incident.json')
        try {
          const o = await readJson(incPath)
          if (!o) return { ok: false, text: '未找到隔离事件：' + id }
          o.clearedAt = nowIso()
          await writeJson(incPath, o)
          return { ok: true, text: '已解除隔离通知：' + id + '。隔离文件夹内容保留待人工清理。' }
        } catch (e) { return { ok: false, text: '未找到隔离事件：' + id } }
      }
      case 'models': {
        // 探测 DSH 可用模型：settings 服务 + llm 目录（供界面提供模型选择）
        const out = { providers: [], defaultModel: null, current: null }
        let defaultProvider = ''
        let defaultModel = ''
        try {
          const settingsSvc = ctx.get('settings')
          if (settingsSvc && settingsSvc.get) {
            const val = settingsSvc.get('agent-default-model')
            if (val && val.provider) {
              defaultProvider = String(val.provider)
              defaultModel = String(val.model || '')
              out.defaultModel = defaultProvider + '/' + defaultModel
              out.current = { provider: defaultProvider, model: defaultModel }
            }
          }
        } catch (e) { out.settingsErr = String(e) }
        try {
          const llmSvc = ctx.get('llm')
          if (llmSvc) {
            // active = 已注册适配器的路由（listProviders），而不是目录项的 active 字段
            const activeSet = new Set()
            try {
              const reg = llmSvc.listProviders ? llmSvc.listProviders() : []
              for (const rp of reg) {
                const nm = (typeof rp === 'string' ? rp : (rp && (rp.provider || rp.id || rp.name))) || ''
                if (nm) activeSet.add(nm)
              }
            } catch (e) {}
            // 默认 provider 视为 active（settings 显式配置）
            if (defaultProvider) activeSet.add(defaultProvider)
            const seen = new Set()
            const dir = llmSvc.listConfigurableProviders ? llmSvc.listConfigurableProviders() : []
            for (const p of dir || []) {
              const provider = (p && (p.provider || p.id || p.name)) || ''
              if (!provider || seen.has(provider)) continue
              seen.add(provider)
              let models = []
              try {
                const ms = llmSvc.listModels ? await llmSvc.listModels(provider) : []
                models = Array.isArray(ms) ? ms.map(m => (typeof m === 'string' ? m : (m && (m.model || m.id || m.name)))).filter(Boolean) : []
              } catch (e) {}
              // 若目录 provider 无模型且是当前默认 → 用 settings 的默认模型兜底
              if (!models.length && provider === defaultProvider && defaultModel) models = [defaultModel]
              out.providers.push({
                provider,
                displayName: (p && p.displayName) || provider,
                settingsNs: (p && p.settingsNs) || '',
                active: activeSet.has(provider),
                models,
              })
            }
            // settings 默认 provider 若不在目录中，也补一条（保证下拉有当前模型）
            if (defaultProvider && !seen.has(defaultProvider)) {
              out.providers.push({ provider: defaultProvider, displayName: defaultProvider, settingsNs: '', active: true, models: defaultModel ? [defaultModel] : [] })
            }
            // 排序：active 优先，其次当前默认置顶
            out.providers.sort((a, b) => {
              if (a.active !== b.active) return a.active ? -1 : 1
              if (a.provider === defaultProvider) return -1
              if (b.provider === defaultProvider) return 1
              return 0
            })
          }
        } catch (e) { out.llmErr = String(e) }
        return { ok: true, ...out }
      }
      case 'period-run': {
        // 文件标记触发：写请求文件，motion-memory 周期定时器检测并执行（管理员身份）
        // 携带界面选定的方案/档位/时间范围/末尾k，motion-memory 侧按此执行
        try {
          const c = await readCfg()
          const r = rootOf(c)
          const reqPath = p(r, '_admin', 'period-run-request.json')
          const req = {
            at: nowIso(), resetTimer: !!(payload && payload.resetTimer), trigger: 'settings-ui',
            scope: (payload && payload.scope !== undefined && payload.scope !== null) ? Math.min(3, Math.max(1, Number(payload.scope) || 1)) : undefined,
            scopeDetail: (payload && payload.scopeDetail) || undefined,
            from: (payload && payload.from) || undefined,
            to: (payload && payload.to) || undefined,
            truncK: (payload && payload.truncK !== undefined && payload.truncK !== null) ? Number(payload.truncK) : undefined,
            ignoreSummarized: !!(payload && payload.ignoreSummarized),
          }
          await writeJson(reqPath, req)
          return { ok: true, text: '周期总结请求已提交（motion-memory 将在下个周期检查时执行，最多 1 分钟延迟）' }
        } catch (e) { return { ok: false, text: '周期总结请求失败: ' + String((e && e.message) || e) } }
      }
      case 'tokens': {
        // token 估算（与 motion-memory.js estimateTokens 一致：中文 1.5/字、英文 4/词、其他 1/字符）
        const text = String((payload && payload.text) || '')
        const s = text || ''
        if (!s) return { ok: true, tokens: 0, cn: 0, en: 0, other: 0 }
        const cn = (s.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
        const en = (s.match(/[A-Za-z0-9]+/g) || []).length
        const other = s.length - cn - en
        const tokens = Math.ceil(cn * 1.5 + en * 4 + other)
        let bytes = 0
        try { bytes = new TextEncoder().encode(s).length } catch (e) {}
        return { ok: true, tokens, cn, en, other, bytes }
      }
      // ── 记忆管理面板 RPC（对话页"记忆"页签；纯文件操作）──────────────
      // 会话列表：从事件文件 sessionRef/links 收集所有会话（未归档），带轮次统计。
      // 结果带 30s 内存缓存（避免频繁打开时全量重扫变慢）。
      case 'mm-session-list': {
        const cacheKey = 'sessions'
        const now = Date.now()
        if (state.mmCache && state.mmCache[cacheKey] && now - state.mmCache[cacheKey].at < 30000) {
          return { ok: true, ...state.mmCache[cacheKey].data }
        }
        const c = await readCfg()
        const r = rootOf(c)
        const map = new Map()
        // 全部记忆文件的时间范围（供"会话记忆"页初始时间选择：最新 ~ 最旧）
        let gMin = 0, gMax = 0
        for (const f of await listFiles(dailyBaseDirOf(r), true)) {
          const rel = relOf(f.path, r)
          if (!/\d{4}\/\d{2}\/\d{2}(?:\/|_)/.test('/' + rel)) continue
          if (rel.indexOf('周期记忆/') >= 0 || rel.indexOf('补充/') >= 0 || rel.indexOf('无模型记忆整理/') >= 0) continue
          const o = await readJson(f.path)
          if (!o || o.tombstone || o.kind !== 'event') continue
          // 全局时间范围统计（文件创建/更新时间，忽略无时间文件）
          const gCreated = parseIso(o.createdAt || '')
          const gUpdated = parseIso(o.updatedAt || '') || gCreated
          if (gCreated && (!gMin || gCreated < gMin)) gMin = gCreated
          if (gUpdated && gUpdated > gMax) gMax = gUpdated
          // sid 提取：优先 sessionRef；兜底 links.children 的 turn ref / sourceChain（旧格式无 sessionRef）
          let sid = (o.sessionRef && o.sessionRef.sessionId) ? o.sessionRef.sessionId : ''
          if (!sid) {
            if (o.links && Array.isArray(o.links.children)) {
              for (const l of o.links.children) {
                if (l && l.kind === 'turn' && l.ref) { const mm = String(l.ref).match(/^(session-[\w-]+)@/); if (mm) { sid = mm[1]; break } }
              }
            }
          }
          if (!sid && Array.isArray(o.sourceChain)) {
            for (const s of o.sourceChain) { const mm = String(s).match(/^(session-[\w-]+)@/); if (mm) { sid = mm[1]; break } }
          }
          if (!sid) continue
          // title 初始为空：会话标题只取会话日志标题（界面会话顶部的短标题），
          // 聚合文件标题（"对话跟踪总结：会话 xxx"）无信息量，不作为列表标题
          const cur = map.get(sid) || { sid, turns: 0, firstAt: '', lastAt: '', title: '', summary: '', records: [] }
          const turns = Array.isArray(o.turns) ? o.turns.length : (o.links && Array.isArray(o.links.children) ? o.links.children.filter(l => l && l.kind === 'turn').length : 1)
          cur.turns += turns
          const ats = []
          if (Array.isArray(o.turns) && o.turns.length) {
            for (const t of o.turns) { if (t && t.at) ats.push(String(t.at)) }
          }
          ats.push(o.updatedAt || o.createdAt || '')
          for (const a of ats) {
            if (!a) continue
            if (!cur.firstAt || a < cur.firstAt) cur.firstAt = a
            if (!cur.lastAt || a > cur.lastAt) cur.lastAt = a
          }
          // 摘要副标题：最新聚合文件 content 首行（回忆"这个会话在做什么"）
          const contentFirst = String(o.content || '').split('\n')[0].slice(0, 80)
          if (contentFirst && (!cur.summary || (o.updatedAt || '') > (cur.lastAt || ''))) cur.summary = contentFirst
          cur.records.push({ rel, turnCount: turns, title: o.title || '', at: o.updatedAt || o.createdAt || '' })
          map.set(sid, cur)
        }
        const items = [...map.values()].sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''))
        // 会话标题：优先 sessionQuery 标题服务（快）；无标题的会话再直接读 DSH 会话日志（zstd 帧）兜底
        const sids = items.map(x => x.sid)
        try {
          const sq = ctx.get('sessionQuery')
          if (sq && typeof sq.readTitleSnapshots === 'function' && sids.length) {
            const titles = await sq.readTitleSnapshots(sids)
            if (Array.isArray(titles)) {
              for (let i = 0; i < titles.length && i < sids.length; i++) {
                const t = titles[i] && titles[i].snapshot
                if (t && t.title) items[i].title = String(t.title)
              }
            }
          }
        } catch (e) {}
        for (const it of items) {
          if (!it.title) it.title = await readSessionTitleFromLog(it.sid)
        }
        const data = { items, globalRange: gMin ? { from: gMin, to: gMax || gMin } : null }
        state.mmCache = state.mmCache || {}
        state.mmCache[cacheKey] = { at: Date.now(), data }
        return { ok: true, ...data }
      }
      case 'mm-turn-list': {
        // 不做前端缓存：对话跟踪实时写聚合文件，列表必须永远新鲜（散文件已合并，扫描量小不慢）
        const c = await readCfg()
        const r = rootOf(c)
        const out = []
        // 会话跟踪配置映射（sid → {startTurn, interval}，来自聚合文件 trackMeta 最后一条）
        const trackMetaMap = {}
        // 时间段过滤（from/to 为毫秒时间戳）
        const fromMs = payload && payload.from ? Number(payload.from) : 0
        const toMs = payload && payload.to ? Number(payload.to) : 0
        // 会话轮次范围（仅当按单一 sid 查询时统计）：min/max，供 client 检测缺失轮次
        const rangeSid = payload && payload.sid ? String(payload.sid) : ''
        let rangeMin = 0, rangeMax = 0
        const bumpRange = (turn) => {
          if (!turn) return
          if (!rangeMin || turn < rangeMin) rangeMin = turn
          if (turn > rangeMax) rangeMax = turn
        }
        for (const f of await listFiles(dailyBaseDirOf(r), true)) {
          const rel = relOf(f.path, r)
          // 事件文件路径：年/月/日 或 年/月/日_（单事件）；对话跟踪聚合文件为 年/月/session-<sid>.json（年月两级）
          if (!/\d{4}\/\d{2}(?:\/|_)(?:\d{2}(?:\/|_))?/.test('/' + rel)) continue
          if (rel.indexOf('周期记忆/') >= 0) continue
          if (rel.indexOf('补充/') >= 0 || rel.indexOf('无模型记忆整理/') >= 0) continue
          const o = await readJson(f.path)
          if (!o || (o.tombstone) || o.kind !== 'event') continue
          if (fromMs || toMs) {
            let inRange = false
            const tAt = (t) => parseIso((t && t.at) || '')
            if (Array.isArray(o.turns) && o.turns.length) {
              inRange = o.turns.some(x => { const tm = tAt(x); return (!fromMs || tm >= fromMs) && (!toMs || tm <= toMs) })
            } else {
              const cm = parseIso(o.createdAt || '')
              inRange = (!fromMs || cm >= fromMs) && (!toMs || cm <= toMs)
            }
            if (!inRange) continue
          }
          // 该文件的界面手动修改历史（note 含"轮次总结"的 update 记录，最多 5 条，供页面显示）
          const editHist = (o.history || []).filter(x => x && x.op === 'update' && String(x.note || '').indexOf('轮次总结') >= 0).slice(-5).map(x => ({ at: x.at || '', note: x.note || '' }))
          // v5 会话聚合：文件含 turns[] → 逐条展开为独立轮次记录
          if (Array.isArray(o.turns) && o.turns.length) {
            // 会话归属：优先 sessionRef.sessionId；兜底 links.children 中第一个 turn 引用
            const fileSid = (o.sessionRef && o.sessionRef.sessionId) ? o.sessionRef.sessionId : ''
            // 该会话的跟踪配置（trackMeta 最后一条），供轮次页"跟踪设定内未总结"判断
            if (fileSid && Array.isArray(o.trackMeta) && o.trackMeta.length) {
              const tm = o.trackMeta[o.trackMeta.length - 1]
              trackMetaMap[fileSid] = { startTurn: Number(tm.startTurn) || 0, interval: Number(tm.interval) || 0 }
            }
            for (const t of o.turns) {
              if (!t || !t.turn) continue
              if (fromMs || toMs) {
                const tm = parseIso((t && t.at) || '')
                if ((fromMs && tm < fromMs) || (toMs && tm > toMs)) continue
              }
              const ref = fileSid + '@' + t.turn
              if (payload && payload.sid && !ref.startsWith(String(payload.sid) + '@')) continue
              if (rangeSid && fileSid === rangeSid) bumpRange(Number(t.turn))
              out.push({ path: rel, title: (o.title || '') + ' · 轮次 ' + t.turn, content: String(t.content || ''), createdAt: t.at || o.createdAt || '', ref, noModel: !!o.noModel, editHistory: editHist })
            }
            continue
          }
          let ref = ''
          if (o.sessionRef && o.sessionRef.sessionId && o.sessionRef.turn) ref = o.sessionRef.sessionId + '@' + o.sessionRef.turn
          if (!ref && o.links && Array.isArray(o.links.children)) {
            for (const l of o.links.children) if (l && l.kind === 'turn' && l.ref) { ref = l.ref; break }
          }
          if (!ref && Array.isArray(o.sourceChain)) {
            for (const s of o.sourceChain) if (typeof s === 'string' && s.indexOf('@') >= 0) { const m = s.match(/^(.+)@(\d+)/); if (m) { ref = m[1] + '@' + Number(m[2]); break } }
          }
          if (!ref) continue
          if (payload && payload.sid && !ref.startsWith(String(payload.sid) + '@')) continue
          if (rangeSid && ref.startsWith(rangeSid + '@')) bumpRange(Number(ref.split('@')[1]))
          out.push({ path: rel, title: o.title || '', content: o.content || '', createdAt: o.createdAt || '', ref, noModel: !!o.noModel, editHistory: editHist })
        }
        // 归档内记忆搜索（includeArchive=true，配合时间段）：补充区 年/月 目录只读扫描（不触发移动回重要）
        if (payload && payload.includeArchive) {
          const archBase = p(r, '记忆累积', '补充')
          for (const f of await listFiles(archBase, true)) {
            const rel = relOf(f.path, r)
            if (!rel) continue
            const o = await readJson(f.path)
            if (!o || o.tombstone || o.kind !== 'event') continue
            const cm = parseIso(o.createdAt || '')
            if ((fromMs && cm < fromMs) || (toMs && cm > toMs)) continue
            const sref = o.sessionRef
            const sid = sref && sref.sessionId ? sref.sessionId : ''
            const ref = sid ? sid + '@' + (sref.turn || 0) : ''
            if (payload && payload.sid && ref && !ref.startsWith(String(payload.sid) + '@')) continue
            // 归档聚合文件：turns[] 逐条展开
            if (Array.isArray(o.turns) && o.turns.length) {
              for (const t of o.turns) {
                if (!t || !t.turn) continue
                if (fromMs || toMs) {
                  const tm = parseIso((t && t.at) || '')
                  if ((fromMs && tm < fromMs) || (toMs && tm > toMs)) continue
                }
                const tref = sid ? sid + '@' + t.turn : ''
                if (payload && payload.sid && tref && !tref.startsWith(String(payload.sid) + '@')) continue
                out.push({ path: rel, title: (o.title || '') + ' · 轮次 ' + t.turn + '（归档）', content: String(t.content || ''), createdAt: t.at || o.createdAt || '', ref: tref, noModel: !!o.noModel, archived: true, month: (o.createdAt || '').slice(0, 7) })
              }
              continue
            }
            out.push({ path: rel, title: (o.title || '') + '（归档）', content: o.content || '', createdAt: o.createdAt || '', ref, noModel: !!o.noModel, archived: true, month: (o.createdAt || '').slice(0, 7) })
          }
        }
        // 无模型记忆整理区扫描：总结失败/无模型模式的轮次也进列表（轮次页标注"模型总结失败/可总结"）
        const noModelBase = p(r, '记忆累积', '无模型记忆整理')
        for (const f of await listFiles(noModelBase, false)) {
          const o = await readJson(f.path)
          if (!o || o.tombstone) continue
          const children = (o.links && o.links.children) || []
          for (const c of children) {
            if (!c || c.kind !== 'turn' || !c.ref) continue
            const cref = String(c.ref)
            if (payload && payload.sid && !cref.startsWith(String(payload.sid) + '@')) continue
            const crefSid = cref.split('@')[0]
            const turn = Number(cref.split('@')[1]) || 0
            if (rangeSid && crefSid === rangeSid) bumpRange(turn)
            let lineText = ''
            if (o.content) {
              const hit = String(o.content).split('\n').find(l => l.indexOf(cref) >= 0)
              if (hit) lineText = hit
            }
            out.push({ path: relOf(f.path, r), title: '无模型记录', content: lineText || ('[用户消息](' + cref + ')'), createdAt: o.createdAt || '', ref: cref, noModel: true, fail: !!c.fail, failNote: c.failNote || '' })
          }
        }
        out.sort((a, b) => {
          const ma = a.ref.match(/@(\d+)/), mb = b.ref.match(/@(\d+)/)
          const ta = ma ? Number(ma[1]) : 0, tb = mb ? Number(mb[1]) : 0
          return ta - tb || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)
        })
        // 会话真实轮次上限兜底：即使无任何总结记录，也按"1 到当前轮次"显示空白轮次（用户可手动补充）
        // ——未跟踪/0 条总结时，轮次页仍能显示空白区间并创建对应事件记忆
        if (rangeSid) {
          try {
            const api = ctx.get('motionMemoryApi')
            if (api && typeof api.sessionTurnRange === 'function') {
              const rr = await api.sessionTurnRange({ sid: rangeSid })
              if (rr && rr.ok && rr.data) {
                if (!rangeMin || rr.data.min < rangeMin) rangeMin = rr.data.min
                if (!rangeMax || rr.data.max > rangeMax) rangeMax = rr.data.max
              }
            }
          } catch (e) {}
        }
        return { ok: true, items: out, turnRange: rangeSid && rangeMin ? { min: rangeMin, max: rangeMax } : null, trackMetaMap }
      }
      case 'mm-turn-save': {
        const c = await readCfg()
        const r = rootOf(c)
        const rel = payload && payload.rel
        const ref = payload && payload.ref
        const content = String((payload && payload.content) || '').trim()
        if (!content) return { ok: false, text: '内容为空' }
        if (rel) {
          const path = p(r, rel)
          const o = await readJson(path)
          if (!o || o.tombstone) return { ok: false, text: '事件不存在：' + rel }
          o.content = content
          o.history = o.history || []
          o.history.push({ op: 'update', agent: 'user+memory-admin', session: '', turn: 0, at: nowIso(), note: '界面手动修改轮次总结：' + rel, keep: true })
          o.updatedAt = nowIso()
          await writeJson(path, o)
          return { ok: true, text: '已保存：' + rel }
        }
        const m = String(ref || '').match(/^(.+)@(\d+)$/)
        if (!m) return { ok: false, text: 'ref 格式无效（需 会话@轮次）：' + ref }
        const sid = m[1], turn = Number(m[2])
        // 统一写入该会话聚合文件（经 motionMemoryApi，与对话跟踪同一文件，不再生成散事件文件）
        try {
          const api = ctx.motionMemoryApi
          if (api && typeof api.turnSaveToAggregate === 'function') {
            const rr = await api.turnSaveToAggregate({ sid, turn, content, note: '界面手动创建轮次总结', reason: '界面手动新增' })
            if (rr && rr.ok) { state.mmCache = {}; return { ok: true, text: rr.text || ('已创建轮次总结：' + sid + '@' + turn), data: rr.data } }
          }
        } catch (e) {}
        // 兜底：仍走本地单事件文件（api 不可用时不丢请求）
        const d = new Date()
        const dir = d.getFullYear() + '/' + pad(d.getMonth() + 1)
        const base = p(dailyBaseDirOf(r), dir)
        const existing = await listFiles(base, false)
        const seq = existing.length + 1
        const path = p(base, pad(d.getDate()) + '_preset_cordis_' + String(sid).slice(-12) + '_turn' + turn + '_' + (stamp(d).replace(/[^\d]/g, '')) + '_' + seq + '.json')
        const obj = {
          schemaVersion: 1, id: uid(), kind: 'event', location: 'daily', readonly: true,
          title: '手动轮次总结：会话 ' + sid + ' 轮次 ' + turn + '（' + stamp(d) + '）',
          reason: '界面手动新增', content,
          links: { parents: [], children: [{ kind: 'turn', ref: sid + '@' + turn, location: 'session' }] },
          createdAt: nowIso(), updatedAt: nowIso(), lastAccessedAt: nowIso(),
          createdBy: { agent: 'user+memory-admin', session: '', turn: 0 },
          lastModifiedBy: { agent: 'user+memory-admin', session: '', turn: 0 },
          originalId: null,
          history: [{ op: 'create', agent: 'user+memory-admin', session: '', turn: 0, at: nowIso(), note: '界面手动创建轮次总结', keep: true }],
        }
        await writeJson(path, obj)
        state.mmCache = {}
        return { ok: true, text: '已创建轮次总结：' + sid + '@' + turn, data: { path: relOf(path, r) } }
      }
      case 'mm-keyword-list': {
        const c = await readCfg()
        const r = rootOf(c)
        const out = []
        // ① 重要文件夹（关键词 + 多词限定标题，一律以关键词方式处理）
        for (const f of await listFiles(p(r, '记忆累积', '重要'), false)) {
          const o = await readJson(f.path)
          if (!o || o.tombstone) continue
          // 分数（与 memory_recent / searchAllMemories 一致）：创建×3 + 查询×次数(times) + 更新×2 + 遗忘×1 + 捡回×1 + 时间衰减
          const hist = Array.isArray(o.history) ? o.history : []
          let score = 0
          for (const h of hist) {
            const op = h && h.op
            if (op === 'create') score += 3
            else if (op === 'query') score += Array.isArray(h.times) && h.times.length ? h.times.length : 1
            else if (op === 'update') score += 2
            else if (op === 'forget' || op === 'restore') score += 1
          }
          // 时间衰减：最近访问/操作时间基准，decayDays 天线性降到 floor（与核心 searchAllMemories 一致）
          const lastAt = parseIso(o.lastAccessedAt) || lastOpTime(o) || 0
          if (lastAt) {
            const ageDays = Math.max(0, (Date.now() - lastAt) / 86400000)
            const scDecay = Math.max(1, Number(c && c.decayDays) || 30)
            const floor = Math.max(0.1, Number(c && c.indexScore && c.indexScore.floor) || 0.2)
            score = score * Math.max(floor, 1 - ageDays / scDecay)
          }
          const links = (o.links && (Array.isArray(o.links.children) || Array.isArray(o.links.parents)))
            ? { children: Array.isArray(o.links.children) ? o.links.children : [], parents: Array.isArray(o.links.parents) ? o.links.parents : [] }
            : { children: [], parents: [] }
          out.push({ path: relOf(f.path, r), title: o.title || '', content: o.content || '', reason: o.reason || '', updatedAt: o.updatedAt || '', score, zone: 'important', links })
        }
        // ② 周期总结（近 decayDays 天）一并载入
        const decay = Math.max(1, Number(c && c.decayDays) || 30)
        const cutoff = Date.now() - decay * 86400000
        for (const f of await listFiles(p(r, '记忆累积', '周期记忆'), true)) {
          const o = await readJson(f.path)
          if (!o || o.tombstone || o.kind !== 'period') continue
          const at = parseIso(o.createdAt) || parseIso(o.updatedAt) || 0
          if (at && at < cutoff) continue
          out.push({ path: relOf(f.path, r), title: o.title || '', content: o.content || '', reason: o.reason || '', updatedAt: o.updatedAt || '', score: 0, zone: 'period', links: { children: [], parents: [] } })
        }
        // 按分数降序，同级按更新时间降序（周期 score=0 排在末尾）
        out.sort((a, b) => (b.score - a.score) || (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        return { ok: true, items: out }
      }
      case 'mm-keyword-save': {
        const c = await readCfg()
        const r = rootOf(c)
        const title = payload && payload.title
        const content = String((payload && payload.content) || '').trim()
        if (!title) return { ok: false, text: '缺少标题' }
        const cand = p(r, '记忆累积', '重要', String(title).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) + '.json')
        const o = await readJson(cand)
        if (!o || o.tombstone) return { ok: false, text: '未找到关键词记忆：' + title }
        o.content = content
        o.history = o.history || []
        o.history.push({ op: 'update', agent: 'user+memory-admin', session: '', turn: 0, at: nowIso(), note: '界面手动修改关键词记忆：' + title, keep: true })
        o.updatedAt = nowIso()
        await writeJson(cand, o)
        return { ok: true, text: '已保存关键词记忆：' + title }
      }
      case 'mm-keyword-add': {
        // 新增关键词记忆（重要文件夹）
        const c = await readCfg()
        const r = rootOf(c)
        const title = String((payload && payload.title) || '').trim()
        const content = String((payload && payload.content) || '').trim()
        if (!title) return { ok: false, text: '缺少标题' }
        const safe = String(title).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) + '.json'
        const cand = p(r, '记忆累积', '重要', safe)
        const existing = await readJson(cand)
        if (existing && !existing.tombstone) return { ok: false, text: '关键词已存在：' + title }
        const d = new Date()
        const obj = {
          schemaVersion: 1, id: uid(), kind: 'keyword', location: 'important',
          title, reason: '界面手动新增', content,
          links: { parents: [], children: [] },
          createdAt: nowIso(), updatedAt: nowIso(), lastAccessedAt: nowIso(),
          createdBy: { agent: 'user+memory-admin', session: '', turn: 0 },
          lastModifiedBy: { agent: 'user+memory-admin', session: '', turn: 0 },
          originalId: null,
          history: [{ op: 'create', agent: 'user+memory-admin', session: '', turn: 0, at: nowIso(), note: '界面手动创建关键词记忆', keep: true }],
        }
        await writeJson(cand, obj)
        return { ok: true, text: '已新增关键词记忆：' + title, data: { path: relOf(cand, r) } }
      }
      case 'mm-keyword-del': {
        // 删除关键词记忆（重要文件夹 → 移入补充归档）
        const c = await readCfg()
        const r = rootOf(c)
        const title = String((payload && payload.title) || '').trim()
        if (!title) return { ok: false, text: '缺少标题' }
        const safe = String(title).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) + '.json'
        const src = p(r, '记忆累积', '重要', safe)
        const o = await readJson(src)
        if (!o || o.tombstone) return { ok: false, text: '未找到关键词记忆：' + title }
        // 移入补充区（年/月）
        const d = new Date()
        const dstDir = p(r, '记忆累积', '补充', String(d.getFullYear()), pad(d.getMonth() + 1))
        const dst = p(dstDir, safe)
        o.location = 'archive'
        o.history = o.history || []
        o.history.push({ op: 'move', agent: 'user+memory-admin', session: '', turn: 0, at: nowIso(), note: '界面手动删除（归档到补充）', keep: false })
        o.updatedAt = nowIso()
        await writeJson(dst, o)
        // 原位置留 tombstone
        await writeJson(src, { tombstone: true, movedTo: relOf(dst, r), at: nowIso() })
        return { ok: true, text: '已删除关键词记忆：' + title + '（归档到补充区）' }
      }
      case 'mm-keyword-restore': {
        // 加回：补充区 → 重要区（重要区已有同名则内容追加合并；原位置留 tombstone）
        const c = await readCfg()
        const r = rootOf(c)
        const title = String((payload && payload.title) || '').trim()
        if (!title) return { ok: false, text: '缺少标题' }
        const safe = String(title).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) + '.json'
        let src = null
        for (const f of await listFiles(p(r, '记忆累积', '补充'), true)) {
          if (f.name !== safe) continue
          const o = await readJson(f.path)
          if (o && !o.tombstone) { src = { path: f.path, obj: o }; break }
        }
        if (!src) return { ok: false, text: '补充区未找到：' + title }
        const dst = p(r, '记忆累积', '重要', safe)
        const existing = await readJson(dst)
        if (existing && !existing.tombstone) {
          existing.content = (existing.content ? existing.content + '\n' : '') + String(src.obj.content || '')
          existing.links = existing.links || { parents: [], children: [] }
          existing.links.children = (existing.links.children || []).concat({ kind: 'keyword', location: 'archive', title })
          existing.history = existing.history || []
          existing.history.push({ op: 'restore', agent: 'user+memory-admin', session: '', turn: 0, at: nowIso(), note: '界面加回（合并同名）', keep: true })
          existing.updatedAt = nowIso()
          await writeJson(dst, existing)
        } else {
          src.obj.location = 'important'
          src.obj.history = src.obj.history || []
          src.obj.history.push({ op: 'restore', agent: 'user+memory-admin', session: '', turn: 0, at: nowIso(), note: '界面加回', keep: true })
          src.obj.updatedAt = nowIso()
          await writeJson(dst, src.obj)
        }
        await writeJson(src.path, { tombstone: true, movedTo: relOf(dst, r), at: nowIso() })
        return { ok: true, text: '已加回关键词记忆：' + title }
      }
      case 'mm-keyword-archive': {
        // 补充区（归档）关键词查询：按归档时间范围过滤（from/to 毫秒时间戳，0=不限）
        // 返回最旧/最新归档时间，供界面默认时间范围（最新归档 - N 天 起）
        const c = await readCfg()
        const r = rootOf(c)
        const fromMs = Number((payload && payload.from) || 0)
        const toMs = Number((payload && payload.to) || 0)
        const out = []
        let oldest = 0, newest = 0
        for (const f of await listFiles(p(r, '记忆累积', '补充'), true)) {
          const o = await readJson(f.path)
          if (!o || o.tombstone) continue
          const at = parseIso(o.updatedAt) || parseIso(o.createdAt) || 0
          if (fromMs && at < fromMs) continue
          if (toMs && at > toMs) continue
          if (!oldest || (at && at < oldest)) oldest = at
          if (at > newest) newest = at
          out.push({ path: relOf(f.path, r), title: o.title || '', content: o.content || '', reason: o.reason || '', updatedAt: o.updatedAt || '', at, zone: 'archive', links: { children: [], parents: [] } })
        }
        out.sort((a, b) => (b.at || 0) - (a.at || 0))
        return { ok: true, items: out, oldestArchiveAt: oldest, newestArchiveAt: newest }
      }
      case 'mm-active-save': {
        // 修改当前智能体活跃记忆（v4：custom/keywords/works；直调 motionMemoryApi）
        const api = ctx.get('motionMemoryApi')
        if (!api || typeof api.activeSave !== 'function') return { ok: false, text: 'motionMemoryApi 服务不可用' }
        const sidFromClient = String((payload && payload.session) || state.lastSid || '')
        const ownerFromSession = sidFromClient ? ownerKeyOfSession(sidFromClient) : ''
        const agentKey = ownerFromSession || String((payload && payload.agent) || '').trim() || 'preset_cordis'
        return api.activeSave({
          ownerKey: agentKey,
          custom: payload && payload.custom,
          keywords: payload && payload.keywords,
          works: payload && payload.works,
          summary: payload && payload.content !== undefined ? payload.content : payload.summary,
        })
      }
      case 'mm-period-save': {
        // 修改周期总结内容
        const c = await readCfg()
        const r = rootOf(c)
        const rel = payload && payload.rel
        const content = String((payload && payload.content) || '').trim()
        if (!rel || !content) return { ok: false, text: '缺少周期文件指向或内容' }
        const path = p(r, rel)
        const o = await readJson(path)
        if (!o || o.tombstone) return { ok: false, text: '周期文件不存在：' + rel }
        o.content = content
        o.history = o.history || []
        o.history.push({ op: 'update', agent: 'user+memory-admin', session: '', turn: 0, at: nowIso(), note: '界面手动修改周期总结：' + rel, keep: true })
        o.updatedAt = nowIso()
        await writeJson(path, o, true)
        return { ok: true, text: '已保存周期总结：' + rel }
      }
      case 'mm-turn-raw': {
        // 轮次原文读取：直调 motionMemoryApi.readTurnRaw（会话日志 zstd 帧，弹窗展示原始对话）
        const api = ctx.get('motionMemoryApi')
        if (!api || typeof api.readTurnRaw !== 'function') return { ok: false, text: 'motionMemoryApi 服务不可用' }
        const ref = String((payload && payload.ref) || '').trim()
        if (!ref) return { ok: false, text: '缺少引用（会话@轮次）' }
        return api.readTurnRaw({ ref })
      }
      case 'mm-ref-read': {
        // 按引用/路径读内容（超链接弹窗用）：ref 会话@轮次 / path 记忆文件路径
        const c = await readCfg()
        const r = rootOf(c)
        const ref = payload && payload.ref
        const pathArg = payload && payload.path
        // 路径优先：记忆累积/... → 读文件
        if (pathArg && String(pathArg).indexOf('记忆累积') >= 0) {
          const cand = String(pathArg).replace(/\\/g, '/').replace(/^\/+/, '')
          const full = cand.startsWith('记忆累积') ? p(r, cand) : p(r, cand)
          const o = await readJson(full)
          if (o && !o.tombstone) return { ok: true, title: o.title || pathArg, content: o.content || '（无内容）' }
          return { ok: false, text: '未找到文件：' + pathArg }
        }
        // 会话@轮次（可带 :stepN）：优先读会话日志原始对话（readTurnRaw），让链接指向轮次时展示该轮次的对话信息
        const m = String(ref || '').match(/^session-[\w-]+@(\d+)(?::step(\d+)(?:-(\d+))?)?/)
        if (m) {
          const api = ctx.get('motionMemoryApi')
          if (api && typeof api.readTurnRaw === 'function') {
            try {
              const raw = await api.readTurnRaw({ ref: String(ref) })
              if (raw && raw.ok) return { ok: true, title: '轮次原文 · ' + ref, content: raw.content || '（无内容）' }
            } catch (eRaw) {}
          }
          // 兜底：会话日志不可读时回退聚合文件轮次总结
          const sid = String(ref).split('@')[0]
          const turn = Number(m[1])
          for (const f of await listFiles(dailyBaseDirOf(r), true)) {
            const o = await readJson(f.path)
            if (!o || o.tombstone) continue
            // v5 聚合文件：从 turns[] 精确取目标轮次
            if (Array.isArray(o.turns) && o.turns.length) {
              const t = o.turns.find(x => x && x.turn === turn)
              if (t && String(o.sessionRef && o.sessionRef.sessionId || '') === sid) {
                return { ok: true, title: (o.title || '') + ' · 轮次 ' + turn, content: String(t.content || '（无内容）') }
              }
              continue
            }
            let evRef = ''
            if (o.sessionRef && o.sessionRef.sessionId && o.sessionRef.turn && o.sessionRef.sessionId === sid && o.sessionRef.turn === turn) evRef = sid + '@' + turn
            if (!evRef && o.links && Array.isArray(o.links.children)) {
              for (const l of o.links.children) if (l && l.kind === 'turn' && l.ref === (sid + '@' + turn)) { evRef = l.ref; break }
            }
            if (evRef) return { ok: true, title: o.title || evRef, content: o.content || '（无内容）' }
          }
          return { ok: false, text: '未找到轮次总结：' + ref }
        }
        return { ok: false, text: '无法解析引用：' + (ref || pathArg) }
      }
      case 'mm-update-check': {
        const api = ctx.get('motionMemoryApi')
        if (!api || typeof api.updateCheck !== 'function') return { ok: false, text: 'motionMemoryApi 服务不可用' }
        return api.updateCheck({ force: !!(payload && payload.force) })
      }
      case 'mm-update': {
        const api = ctx.get('motionMemoryApi')
        if (!api || typeof api.updateApply !== 'function') return { ok: false, text: 'motionMemoryApi 服务不可用' }
        return api.updateApply()
      }
      case 'mm-active-read': {
        // 活跃记忆与轮次总结同源：优先按 session 解析 ownerKey（preset），回退 payload.agent
        const api = ctx.get('motionMemoryApi')
        if (!api || typeof api.activeRead !== 'function') return { ok: false, text: 'motionMemoryApi 服务不可用' }
        const sidFromClient = String((payload && payload.session) || state.lastSid || '')
        const ownerFromSession = sidFromClient ? ownerKeyOfSession(sidFromClient) : ''
        const agentKey = ownerFromSession || String((payload && payload.agent) || '').trim() || 'preset_cordis'
        return api.activeRead({ ownerKey: agentKey, session: sidFromClient })
      }
      case 'mm-turn-resummarize': {
        // 模型重新总结：直调 motion-memory 的 motionMemoryApi.turnRereview（同步调模型，不写请求文件/不等定时器）
        const sid = payload && payload.sid
        const turn = payload && payload.turn ? Number(payload.turn) : 0
        const mode = (payload && payload.mode) || 'current'
        if (!sid || !turn) return { ok: false, text: '缺少会话或轮次' }
        const api = ctx.get('motionMemoryApi')
        if (!api || typeof api.turnRereview !== 'function') return { ok: false, text: 'motionMemoryApi 服务不可用（motion-memory 插件未加载？）' }
        return api.turnRereview({ sid, turn, mode })
      }
      case 'mm-turn-resummarize-status': {
        // 同步模式不再需要轮询：直接返回最近一次结果（兼容旧客户端）
        return { ok: true, done: false }
      }

      case 'mm-period-upgrade': {
        // 确认升级方案：写请求标记文件，由 motion-memory 定时器执行（按原周期时间范围 + 新方案重跑，旧文件保留）
        const c = await readCfg()
        const r = rootOf(c)
        const rel = payload && payload.rel
        const newScope = payload && payload.scope ? Number(payload.scope) : 0
        const newDetail = payload && payload.scopeDetail
        if (!rel) return { ok: false, text: '缺少周期文件指向' }
        if (![1, 2, 3].includes(newScope)) return { ok: false, text: '无效的新方案：' + newScope }
        const path = p(r, rel)
        const o = await readJson(path)
        if (!o || o.tombstone) return { ok: false, text: '周期文件不存在：' + rel }
        // 写请求标记文件（与 period-rereview 同模式）
        const req = { at: nowIso(), rel, scope: newScope, scopeDetail: newDetail, trigger: 'settings-ui' }
        await writeJson(p(r, '_admin', 'period-upgrade-request.json'), req)
        return { ok: true, text: '升级方案请求已提交：' + rel + ' → 方案' + newScope + '（motion-memory 将在下个周期检查时执行，最多 1 分钟延迟；旧文件保留）' }
      }
      case 'mm-period-rereview': {
        // 双模式重审：mode=current 用当前活跃摘要；at-time 回溯（简化为读周期文件 + 当前活跃，模型重审走标记文件）
        const c = await readCfg()
        const r = rootOf(c)
        const rel = payload && payload.rel
        const mode = (payload && payload.mode) || 'current'
        if (!rel) return { ok: false, text: '缺少周期文件指向' }
        const path = p(r, rel)
        const o = await readJson(path)
        if (!o || o.tombstone) return { ok: false, text: '周期文件不存在：' + rel }
        // 写重审请求标记文件，由 motion-memory 定时器执行（与 period-run 同模式）
        const req = { at: nowIso(), rel, mode, trigger: 'settings-ui' }
        await writeJson(p(r, '_admin', 'period-rereview-request.json'), req)
        return { ok: true, text: '重审请求已提交（motion-memory 将在下个周期检查时执行，最多 1 分钟延迟）' }
      }
      case 'period-history': {
        // 历史周期总结查询（按时间范围，近→远）
        const c = await readCfg()
        const r = rootOf(c)
        const from = payload && payload.from ? Number(payload.from) : 0
        const to = payload && payload.to ? Number(payload.to) : 0
        const out = []
        for (const f of await listFiles(p(r, '记忆累积', '周期记忆'), true)) {
          const o = await readJson(f.path)
          if (!o || o.tombstone || o.kind !== 'period') continue
          const t = parseIso(o.createdAt) || 0
          if (from && t < from) continue
          if (to && t > to) continue
          out.push({
            path: relOf(f.path, r), title: o.title || '', content: o.content || '',
            createdAt: o.createdAt || '', trigger: o.trigger || '',
            scope: o.scope || 1, scopeLabel: o.scopeLabel || ('方案' + (o.scope || 1)), scopeDetail: o.scopeDetail || '',
            covered: (o.coveredEvents || []).length, coveredEvents: o.coveredEvents || [],
            sessionTurns: o.sessionTurns || [],
            createdBy: o.createdBy || null,
          })
        }
        out.sort((a, b) => parseIso(b.createdAt) - parseIso(a.createdAt))
        return { ok: true, items: out }
      }
      default:
        return { ok: false, text: '未知 endpoint：' + endpoint }
    }
  }

  // 注册 connection channel /mmsettings（loopback 信任）
  if (connection && connection.rpc && connection.rpc.handle) {
    connection.rpc.handle('/mmsettings', async (endpoint, payload) => {
      try {
        const result = await handle(endpoint, payload)
        // 记忆写操作成功后清空会话列表/轮次列表缓存（下次读取重新扫描）
        if (result && result.ok && ['mm-turn-save', 'mm-keyword-save', 'mm-keyword-del', 'mm-active-save', 'mm-period-save'].indexOf(endpoint) >= 0) {
          state.mmCache = {}
        }
        return { ok: true, value: result }
      } catch (e) {
        return { ok: true, value: { ok: false, text: 'mm-settings 处理失败：' + String((e && e.message) || e) } }
      }
    }, { authority: 'loopback' })
  }
}
