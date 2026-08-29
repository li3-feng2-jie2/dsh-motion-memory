/**
 * motion-memory 核心运行时模块（拆分自 motion-memory.js，C 档第一步）
 *
 * createCore(ctx) 工厂：构建并返回全部共享基础设施——
 *   state / paths / 会话工作区解析 / fs helpers / 智能体归属 / 查找 / 配置与 init / 查询日志。
 * 由 motion-memory.js apply() 调用，解构同名局部变量以保持后续代码零改动。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { pad, nowIso, parts, ymPath, parseIso, uid } from './time-utils.mjs'
import { histEntry, sanitizeFile } from './memory-objects.mjs'
import { reconstructAt } from './text-utils.mjs'

export function createCore(ctx) {
  const fs = ctx.fs
  const tools = ctx.tools
  const sandboxPolicy = ctx.sandboxPolicy
  const llm = ctx.get('llm')

  // ── state ──────────────────────────────────────────────────────────────
  const state = {
    config: null,
    root: null,
    currentTurn: new Map(),
    incidents: new Map(),
    readyPromise: null,
    sessionCwd: '',
    necessaryCache: new Map(),
    migrated: false,
    turnEvents: 0,
    requestEvents: 0,
    eventDelivered: false,
    lastSid: '',
    lastActiveDiff: null,   // 阶段3：最近一次活跃变更 diff（注入载体）
    diffQueue: [],          // v4：变更 diff 队列（注入失败/覆盖不丢，下一轮重试）
    notifyOff: new Set(),   // 阶段3：memory_notify off 的会话 sid 集合
    configMtime: 0,         // 配置热重载：上次加载的配置文件 mtime（方案B）
    sessionLogCache: new Map(), // 会话日志缓存：sid -> { path, events, header, size, mtimeMs, frameCount }
    ownerKeyCache: new Map(),   // ownerKey 结果缓存：sid -> 'preset:xxx'（会话内固定，页面刷新免重复解析）
    activeMigrateReport: null,  // 启动迁移报告（界面状态区可展示）
  }

  // ── paths（默认根目录 = 会话工作区 .cache/运动记忆）─────────────────────
  function normWs(ws) { return String(ws || '').replace(/\\/g, '/').replace(/\/+$/, '') }
  function baseWs() { return normWs(state.sessionCwd || (sandboxPolicy && sandboxPolicy.workspaceRoot)) }
  function defaultRootFrom(ws) { return normWs(ws) + '/.cache/运动记忆' }
  function p() {
    const out = []
    for (let i = 0; i < arguments.length; i++) {
      const s = String(arguments[i])
      if (s !== '' && s != null) out.push(s.replace(/\\/g, '/'))
    }
    return out.join('/')
  }
  function relOf(path) { return String(path).replace(String(state.root).replace(/\\/g, '/'), '').replace(/^\/+/, '') }
  function root() { return state.root }
  function dshHome() {
    const h = String(process.env.DSH_HOME || '').replace(/\\/g, '/')
    if (h) return h
    const up = String(process.env.USERPROFILE || '').replace(/\\/g, '/')
    return up ? p(up, '.dsh') : ''
  }
  function dshProfile() { return String(process.env.DSH_PROFILE || 'web') }
  // 配置固定到 profile 全局位置（不随工作区/会话漂移，重启不丢、不重置）；
  // 读写走原生 node:fs —— config 是插件自身持久化文件，不受会话文件沙箱限制
  function configPath() {
    const home = dshHome()
    if (home) return p(home, 'profiles', dshProfile(), 'motion-memory.config.json')
    return p(baseWs(), '.cache', '运动记忆', 'config.json')
  }
  function readConfigFile() {
    const cp = configPath()
    try {
      if (!existsSync(cp)) return undefined
      const text = readFileSync(cp, 'utf8').replace(/^\uFEFF/, '')  // 剥 BOM（防御外部工具写入）
      return JSON.parse(text)
    } catch (e) { return undefined }
  }
  function writeConfigFile(obj) {
    const cp = configPath()
    try {
      const idx = cp.lastIndexOf('/')
      if (idx > 0) mkdirSync(cp.slice(0, idx), { recursive: true })
      writeFileSync(cp, JSON.stringify(obj, null, 1), 'utf8')
      try { state.configMtime = statSync(cp).mtimeMs } catch (e) {}  // 方案B：写回后同步 mtime
      return true
    } catch (e) { console.error('motion-memory: 写配置失败 ' + cp + ': ' + (e && e.message)); return false }
  }
  // 旧配置位置（一次性迁移：固定位无配置时从旧位置读入合并）。
  // 枚举：会话工作区 + 进程 cwd + 工作区注册表（地址管理）里的全部工作区 + 固定位自身，
  // 避免服务启动目录/会话捕获时序不同导致迁错 root
  function legacyConfigPaths() {
    const out = []
    const seen = new Set()
    const add = (r) => {
      const rr = normWs(r)
      if (!rr || seen.has(rr)) return
      seen.add(rr)
      out.push(p(rr, '.cache', '运动记忆', 'config.json'))
    }
    add(baseWs())
    if (sandboxPolicy && sandboxPolicy.workspaceRoot) add(sandboxPolicy.workspaceRoot)
    try {
      const wsReg = ctx.get('workspaceRegistry')
      if (wsReg && typeof wsReg.list === 'function') {
        for (const w of wsReg.list()) { if (w && w.path) add(w.path) }
      }
    } catch (e) {}
    const home = dshHome()
    if (home) out.push(p(home, 'profiles', dshProfile(), 'motion-memory.config.json'))
    return out
  }
  function readJsonFileNative(filePath) {
    try {
      if (!existsSync(filePath)) return undefined
      let text = readFileSync(filePath, 'utf8')
      // 剥离 UTF-8 BOM（Windows PowerShell Set-Content -Encoding UTF8 会写入 BOM，JSON.parse 会失败）
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
      return JSON.parse(text)
    } catch (e) { return undefined }
  }
  // 远端 JSON 解析（BOM 剥离）：GitHub raw 可能返回带 BOM 的内容
  async function parseRemoteJson(resp) {
    const text = String(await resp.text())
    return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text)
  }
  // 统计一个记忆根下的记忆文件数（重要 + 补充 + 事件），用于迁移时选数据最丰富的旧配置
  function memoryFileCount(rootPath) {
    let n = 0
    const countDir = (dir) => {
      try { for (const name of readdirSync(dir)) { const full = dir + '/' + name; try { if (existsSync(full)) n++ } catch (e) {} } } catch (e) {}
    }
    countDir(p(rootPath, '记忆累积', '重要'))
    countDir(p(rootPath, '记忆累积', '补充'))
    countDir(p(rootPath, '记忆累积', '2026'))
    return n
  }
  // 初始默认记忆根 = 当前工作区根（首次写入固定 config 后固定，不再随工作区变）
  function globalDefaultRoot() { return defaultRootFrom(baseWs()) }
  function necessaryDir() { return p(root(), '记忆累积/必要') }
  function importantDir() { return p(root(), '记忆累积/重要') }
  function archiveBaseDir() { return p(root(), '记忆累积/补充') }
  // v3：补充区年/月两级（补充/YYYY/MM）
  function archiveDirFor(d) { const q = parts(d || new Date()); return p(archiveBaseDir(), q.y, q.m) }
  function dailyBaseDir() { return p(root(), '记忆累积') }
  function activeDir() { return p(root(), '当前活跃') }
  // 无模型记忆整理区：无模型降级生成的工作摘要落盘处（可被扫描检索）
  function noModelDir() { return p(root(), '记忆累积', '无模型记忆整理') }
  function isolationDir() { return p(root(), '隔离记忆') }
  function quarantineDir() { return p(isolationDir(), '_审阅') }
  function queryLogPath() { return p(root(), '_querylog.json') }

  // ── 会话工作区解析 ─────────────────────────────────────────────────────
  function setSessionCwd(cwd) {
    if (cwd && !state.sessionCwd) state.sessionCwd = normWs(cwd)
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

  // ── 会话策略（写盘边界 = 会话工作区）───────────────────────────────────
  function sessionPolicy() {
    try {
      if (sandboxPolicy && state.lastSid) {
        const sessions = ctx.get('sessions')
        const s = sessions && sessions.get(state.lastSid)
        if (s) return sandboxPolicy.resolve({ session: s })
      }
    } catch (e) {}
    return undefined
  }

  // ── fs helpers ─────────────────────────────────────────────────────────
  // 写并发控制：进程内 per-path 互斥锁（防止同进程 async 写交错）+ 版本 CAS。
  // version 字段维护：所有 writeJson 自动 version+1；带 expectedVersion 的
  // 调用（writeJsonCAS）在比对不一致时返回冲突，不覆盖。
  const writeLocks = new Map()
  async function acquireWriteLock(path) {
    const key = String(path)
    const prev = writeLocks.get(key) || Promise.resolve()
    let release
    const cur = new Promise(res => { release = res })
    writeLocks.set(key, prev.then(() => cur))
    await prev
    return release
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
  // 维护 version：旧文件 version+1，新文件 version=1
  function bumpVersion(existing, obj) {
    const prev = (existing && typeof existing.version === 'number') ? existing.version : 0
    if (obj && typeof obj === 'object') obj.version = prev + 1
    return obj
  }
  // 记忆根白名单写通道：DSH 沙箱无可写根扩展配置（workspace-write 的可写根
  // 硬编码为 工作区 + 平台临时区），而记忆根固定在工作区外（~/.dsh/运动记忆，
  // 不随工作区/会话漂移）。目标落在记忆根下时，与插件配置文件同待遇走原生
  // node:fs —— 仅放行本插件的固定目录；会话沙箱边界（模型工具写盘）完全不变。
  // 其余路径维持 ctx.fs + 会话 sandboxPolicy。
  function isUnderMemoryRoot(p) {
    const r = normWs(state.root || '')
    const t = normWs(String(p || ''))
    return !!(r && (t === r || t.startsWith(r + '/')))
  }
  // 插件代码目录白名单：更新覆盖（清单驱动增量下载）需要写插件自身文件，
  // 与配置文件同待遇走原生 node:fs（仅放行插件目录本身，不含其它任意路径）。
  function isUnderPluginDir(p) {
    const base = normWs(pluginDir())
    const t = normWs(String(p || ''))
    return !!(base && (t === base || t.startsWith(base + '/')))
  }
  // 原生写（更新覆盖/备份/清理专用）：仅放行插件目录与临时目录，其它路径一律拒绝
  function nativeWriteAllowed(p) {
    return isUnderPluginDir(p) || (String(p || '').indexOf('motion-memory-tmp') >= 0 || String(p || '').indexOf('motion-memory-bak') >= 0)
  }
  async function writeTextChannel(target, text, policy) {
    const disp = (target && typeof target === 'object' ? (target.displayPath || target.targetKey || '') : String(target || ''))
    if (isUnderMemoryRoot(disp)) {
      const idx = Math.max(disp.lastIndexOf('/'), disp.lastIndexOf('\\'))
      if (idx > 0) mkdirSync(disp.slice(0, idx), { recursive: true })
      writeFileSync(disp, text, 'utf8')
      return
    }
    await fs.writeText(target, text, undefined, undefined, policy)
  }
  async function writeJson(path, obj, allowReadonly) {
    const release = await acquireWriteLock(path)
    try {
      const existing = await readJson(path)
      // 只读溯源文件（阶段8）：事件/周期 readonly=true，除显式允许（周期总结标记 summarizedAt）外拒绝写
      if (existing && existing.readonly === true && !allowReadonly) {
        throw new Error('只读溯源文件，不允许修改：' + path)
      }
      const next = bumpVersion(existing, obj)
      await readJson(path) // 观察策略：覆盖前必须读过
      const target = await fs.resolve(path)
      const policy = sessionPolicy()
      await writeTextChannel(target, JSON.stringify(next, null, 1), policy)
      return path
    } finally { release() }
  }
  // CAS 写：expectedVersion 与磁盘当前 version 不一致 → 冲突返回（不覆盖）
  // 返回 { ok:true, path } 或 { ok:false, conflict:true, latest, latestVersion, path }
  async function writeJsonCAS(path, obj, expectedVersion, allowReadonly) {
    const release = await acquireWriteLock(path)
    try {
      const existing = await readJson(path)
      if (existing && existing.readonly === true && !allowReadonly) {
        return { ok: false, conflict: false, readonly: true, path }
      }
      const curVersion = (existing && typeof existing.version === 'number') ? existing.version : 0
      if (expectedVersion !== undefined && expectedVersion !== null && curVersion !== expectedVersion) {
        return { ok: false, conflict: true, latest: existing || null, latestVersion: curVersion, path }
      }
      const next = bumpVersion(existing, obj)
      await readJson(path) // 观察策略：覆盖前必须读过
      const target = await fs.resolve(path)
      const policy = sessionPolicy()
      await writeTextChannel(target, JSON.stringify(next, null, 1), policy)
      return { ok: true, path, version: next.version }
    } finally { release() }
  }
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
    } catch (e) { /* 目录不存在视为空 */ }
    return out
  }
  async function tombstone(path, movedTo) { await writeJson(path, { tombstone: true, movedTo, at: nowIso() }) }
  function isTombstone(o) { return !!(o && o.tombstone) }
  function fileNameOf(path) { return String(path).split('/').pop() }

  // stateAt：结合 history 的 move 操作重建状态（依赖 relOf/p/root，保留在 core）
  function stateAt(obj, path, tMs) {
    const content = reconstructAt(obj, tMs, parseIso)
    let cur = path
    const hist = (obj.history || []).slice()
    for (let i = hist.length - 1; i >= 0; i--) {
      if (parseIso(hist[i].at) <= tMs) break
      if (hist[i].op === 'move' && hist[i].toPath === relOf(cur)) cur = p(root(), hist[i].fromPath)
    }
    return { content, path: cur }
  }

  // ── 智能体归属：谁创造的记忆归谁；管理员 memory-admin 产物对全体共享 ─────
  function ownerOf(obj) {
    if (!obj) return ''
    const c = obj.createdBy || obj.lastModifiedBy
    if (c && c.agent) return String(c.agent)
    const h = obj.history
    if (Array.isArray(h) && h.length) {
      for (const e of h) { if (e && e.agent) return String(e.agent) }
      for (const e of h) { if (e && e.session) return String(e.session) }
    }
    return ''
  }
  function currentOwner(meta) {
    return (meta && (meta.agent || meta.session)) ? String(meta.agent || meta.session) : ''
  }
  function isAdminAgent(meta) {
    return !!meta && String(meta.agent || '') === 'memory-admin'
  }
  // 归属过滤值：'' = 全量（管理员始终全量；queryOtherAgents=true 时普通智能体也全量）
  function scopeOwner(meta) {
    if (isAdminAgent(meta)) return ''
    const c = cfg()
    if (c && c.queryOtherAgents) return ''
    return currentOwner(meta)
  }
  // 查询归属范围（明确指定）：ownerKey 空 = 按开关的本智能体；preset:xxx = 指定智能体；all = 所有智能体
  function queryOwnerOf(meta, args) {
    const ow = String((args && args.ownerKey) || '').trim()
    if (!ow) return scopeOwner(meta)
    if (ow === 'all') return ''
    return ow
  }
  // ── 智能体身份键：优先用 agentPreset（同一 preset 的会话 = 同一智能体，共享记忆；
  //    子智能体/无 preset 的会话回退 session id 隔离）─────────────────────────
  function sessionPresetOf(agentOrSession) {
    try {
      const s = (agentOrSession && agentOrSession.session) || agentOrSession
      if (s && s.header && s.header.agentPreset) return String(s.header.agentPreset)
      if (s && s.meta && s.meta.agentPreset) return String(s.meta.agentPreset)
    } catch (e) {}
    return ''
  }
  function ownerKeyOf(agentOrSession) {
    const preset = sessionPresetOf(agentOrSession)
    return preset ? 'preset:' + preset : ''
  }
  // 异步版：优先 sessions 服务 header（新版 DSH header 事件自带 agentPreset，
  // 内存读取零解压）；header 缺失时才读会话日志找 agent-preset/selected
  // （兼容旧版日志布局 / live 会话 header 未落盘的兜底）。
  async function sessionPresetOfAsync(sid) {
    // ① header 快路径：DSH sessions 服务内存对象，不含文件 IO
    try {
      const sessions = ctx.get('sessions')
      if (sessions && sid) {
        const s = sessions.get(sid)
        if (s) {
          if (s.header && s.header.agentPreset) return String(s.header.agentPreset)
          if (s.meta && s.meta.agentPreset) return String(s.meta.agentPreset)
        }
      }
    } catch (e) {}
    // ② 日志兜底：仅 header 拿不到 preset 时读日志（限前 30 帧，避免全量解压）
    try {
      const events = await (_readerFirstFrames ? _readerFirstFrames(sid, 30) : [])
      if (Array.isArray(events) && events.length) {
        for (const e of events) {
          if (e && e.type === 'agent-preset/selected' && e.data && e.data.agentPreset) return String(e.data.agentPreset)
        }
      }
    } catch (e) {}
    return ''
  }
  // 异步版 ownerKey：结果缓存（会话内 preset 固定，sid → ownerKey 直接复用，
  // 避免会话记忆页每次刷新对全部会话重复解析）
  async function ownerKeyOfAsync(sid) {
    if (!sid) return ''
    const cached = state.ownerKeyCache && state.ownerKeyCache.get(sid)
    if (cached) return cached
    const preset = await sessionPresetOfAsync(sid)
    const ownerKey = preset ? 'preset:' + preset : ''
    state.ownerKeyCache = state.ownerKeyCache || new Map()
    if (state.ownerKeyCache.size > 500) state.ownerKeyCache.clear()
    state.ownerKeyCache.set(sid, ownerKey)
    return ownerKey
  }
  // ── 依赖注入槽（由 apply 组装时注入：session-log 工厂的限帧读取、mem-files 工厂的 MemFiles）──
  let _readerFirstFrames = null
  let _MemFiles = null
  function setReaderFirstFrames(fn) { _readerFirstFrames = fn }
  function setMemFiles(mf) { _MemFiles = mf }
  // 旧记忆归属归并（一次性）：把 owner 为 session-xxx 的历史记忆迁移到当前 preset 名下，
  // 使同一智能体（preset）的新会话能看到上一个会话创建的记忆
  let legacyMerged = false
  async function mergeLegacyOwners(ownerKey) {
    if (legacyMerged || !ownerKey || ownerKey.indexOf('preset:') !== 0) return
    legacyMerged = true
    try {
      const seen = new Set()
      const walk = async (dir, recursive) => {
        for (const f of await listFiles(dir, recursive)) {
          if (seen.has(f.path)) continue
          seen.add(f.path)
          const o = await readJson(f.path)
          if (!o || isTombstone(o)) continue
          const ow = ownerOf(o)
          if (!ow || ow.indexOf('session-') !== 0) continue
          // 旧记忆 createdBy.agent 可能为空、owner 由 history 回退而来：直接归并到当前 preset
          o.createdBy = o.createdBy || {}
          o.createdBy.agent = ownerKey
          o.history = o.history || []
          o.history.push(histEntry('move', { agent: ownerKey, note: '归属归并：' + ow + ' → ' + ownerKey }))
          o.updatedAt = nowIso()
          await writeJson(f.path, o)
          console.log('[motion-memory] 归属归并 ' + f.path + '：' + ow + ' → ' + ownerKey)
        }
      }
      await walk(importantDir(), false)
      await walk(archiveBaseDir(), true)
      // 事件/周期只读（阶段8）：归属归并只处理重要/补充词条，不碰事件与周期溯源文件
      // await walk(dailyBaseDir(), true)
    } catch (e) { console.error('motion-memory: 归属归并失败 ' + (e && e.message)); legacyMerged = false }
  }

  // ── 查找（owner 归属过滤：'' 表示全量；普通查询只返回 自己 + memory-admin 共享）──
  async function scanDir(dir, recursive, owner) {
    const out = []
    for (const f of await listFiles(dir, recursive)) {
      const o = await readJson(f.path)
      if (o && !isTombstone(o)) {
        if (owner) { const ow = ownerOf(o); if (ow && ow !== owner && ow !== 'memory-admin') continue }
        out.push({ obj: o, path: f.path, name: f.name })
      }
    }
    return out
  }
  async function findInDir(dir, title, recursive, owner) {
    for (const e of await scanDir(dir, recursive, owner)) { if (e.obj.title === title) return e }
    return undefined
  }
  async function findImportant(title, owner) { return findInDir(importantDir(), title, false, owner) }
  async function findArchive(title, owner) { return findInDir(archiveBaseDir(), title, true, owner) }
  async function findKeyword(title, owner) {
    const a = await findImportant(title, owner)
    if (a) return { ...a, zone: 'important' }
    const b = await findArchive(title, owner)
    if (b) return { ...b, zone: 'archive' }
    return undefined
  }
  // 近似标题候选（写入分流）：标题包含关系 / 共享词（中文分词：标点与"的"切分）
  // 返回 [{ title, shared }] 按关联强度降序；minShared 控制候选宽度（提示用 1，自动关联用 2）
  function titleWords(s) {
    return String(s || '').split(/[\s，。、；：,.;:的]+/).map(w => w.trim()).filter(w => w.length >= 2)
  }
  async function findSimilarTitles(title, owner, minShared) {
    const out = []
    const t = String(title || '').trim()
    const min = Math.max(1, Number(minShared) || 1)
    if (!t) return out
    const tw = titleWords(t)
    for (const e of await scanDir(importantDir(), false, owner)) {
      const cand = String(e.obj.title || '')
      if (!cand || cand === t) continue
      let shared = 0
      if (t.length >= 4 && (cand.indexOf(t) >= 0 || t.indexOf(cand) >= 0)) {
        shared = Math.max(shared, 3)  // 包含关系 = 强关联
      }
      const cw = titleWords(cand)
      let inter = 0
      for (const w of tw) if (cw.includes(w)) inter++
      shared = Math.max(shared, inter)
      if (shared >= min) out.push({ title: cand, shared })
    }
    out.sort((a, b) => b.shared - a.shared)
    return out.slice(0, 5)
  }
  async function searchTitles(dir, keyword, recursive, owner) {
    const kw = String(keyword || '')
    const hits = []
    for (const e of await scanDir(dir, recursive, owner)) {
      if (!kw || (e.obj.title || '').includes(kw) || (e.obj.content || '').includes(kw)) hits.push(e.obj.title)
    }
    return hits
  }
  function lastOpTime(o) {
    const h = (o.history || [])
    return h.length ? parseIso(h[h.length - 1].at) : (parseIso(o.updatedAt) || parseIso(o.createdAt))
  }
  function lastOp(o) {
    const h = (o.history || [])
    return h.length ? h[h.length - 1] : null
  }
  function isoStr(t) { return new Date(t).toISOString() }
  async function uniquePath(dir, filename) {
    const names = new Set((await listFiles(dir, false)).map(f => f.name))
    if (!names.has(filename)) return p(dir, filename)
    for (let i = 2; i < 100; i++) { const cand = filename.replace(/\.json$/, '') + '-' + i + '.json'; if (!names.has(cand)) return p(dir, cand) }
    return p(dir, 'x-' + uid() + '.json')
  }
  function pageSlice(list, page, pageSize) {
    const pg = Math.max(1, page || 1)
    const size = Math.min(100, Math.max(1, pageSize || 20))
    return { items: list.slice((pg - 1) * size, pg * size), page: pg, pageSize: size, total: list.length }
  }

  // ── 配置 ───────────────────────────────────────────────────────────────
  function defaultConfig(ws) {
    return {
      enabled: true, inject: true, injectLimitBytes: 4096,
      root: globalDefaultRoot(),
      recordModel: { provider: '', model: '' },
      recentOverviewN: 3, cascadeDepth: 3, archiveDays: 30,
      // 总结摘要字数（k token，默认 2）：统一控制 ①works 记录链总量预算 ②B-2 注入【本会话现有工作信息】软限制；
      // 换算走 estimateTokens+langTokens（中文约 1.5 字/token）。旧 activeWorksTokens 值迁移到此。
      summaryCharsK: 2,
      // 自动检查更新（默认开）：启动后 8 秒 + 每 12 小时自动检查一次（git/版本号/清单对比）；
      // 关 = 仅手动点"检查更新"。检查是只读的，不会自动下载覆盖。
      autoUpdateCheck: true,
      queryHistoryN: 0, updateHistoryN: 0, historyPageSize: 20,
      rootUserSet: false,
      // 检索时间衰减（天）：周期/活跃索引引用得分按此线性衰减（默认 30 天 100%→20%）
      decayDays: 30,
      // 活跃索引 score 参数（v5 可配置）：初始分 + 衰减下限 + 淘汰阈值
      indexScore: {
        period: 5, event: 3, keyword: 2,
        floor: 0.2,   // 衰减下限（score 最低保留比例，默认 20%）
        threshold: 0.3, // 淘汰阈值（衰减后低于此分则从索引移除）
        maxRefs: 50,  // refs 最大条数
        scanMonths: 3, // 事件区定向扫描的月份窗口（新→旧，最近 N 个月）
      },
      // 活跃变更注入通知：默认开；agent 可 memory_notify 按会话关闭
      activeNotify: true, readTrimChars: 500,
      // 对话跟踪摘要注入长度上限（字符）：对话跟踪工具每轮更新活跃摘要后，
      // 注入其他会话的摘要截取长度（默认 300，中文语义完整）
      summaryInjectChars: 300,
      // 无模型降级：无模型时是否允许规则提取生成会话工作摘要（默认关；开启后摘要落盘无模型记忆整理区）
      activeNoModelSummarize: false,
      // 智能体归属：默认只查本智能体（创建者）的记忆；true = 扩大到查询其他智能体记忆（管理员始终全量）
      queryOtherAgents: false,
      // 记忆管理员（阶段1+）：指定模型后启用，空 = 全部关闭
      admin: {
        enabled: false,
        model: { provider: '', model: '' },
        contextTokens: 128000,
        summaryPercent: 50,
        langTokens: [
          { kind: 'cn', lang: '中文', per: 1.5 },
          { kind: 'en', lang: 'english', per: 1 },
          { kind: 'ja', lang: '日文', per: 1.5 },
          { kind: 'ko', lang: '韩文', per: 1.5 },
          { kind: 'other', lang: '其他', per: 1 },
        ],
        concurrency: 0,
        singleFileTokens: 2048,
        recallDepth: 1,
        outputTokens: 0,
        extraJson: null,
        dailyBudget: 0,
      },
      // LLM 写入消歧判定（P0-2）：memory_add 有近似候选时让模型判断"同一实体/不同实体/不确定"
      // （默认关省 token；模型失败自动回退机械查重规则）
      dedupJudge: {
        enabled: false,
        model: { provider: '', model: '' },
        topCandidates: 3,
      },
      // 语义检索（P0-1）：本地 embedding（ollama / lmstudio）向量索引 + 关键词多路召回融合
      // （默认关；provider 不可用或 embed 失败自动回退纯关键词检索）
      semanticSearch: {
        enabled: false,
        provider: '',        // 'ollama' | 'lmstudio' | ''
        model: '',           // 如 ollama:bge-m3 / nomic-embed-text；lmstudio:模型名
        topK: 8,             // 语义召回条数
        threshold: 0.35,     // 余弦相似度阈值（低于不召回）
        weight: 0.5,         // 语义分在融合排序中的权重（0-1）
        indexEvents: false,  // 事件记忆是否索引（默认不索引控制体积）
      },
    }
  }
  function cfg() { return state.config || defaultConfig(baseWs()) }
  // admin 子配置读取（C 档：admin 域拆出后归 core——纯配置读取，供各域工厂与主文件共用）
  function adminCfg() {
    const c = cfg()
    if (!c.admin) c.admin = {}
    return c.admin
  }

  // ── 插件目录（供 isUnderPluginDir 前向引用；非 git 安装也适用）──────────
  function pluginGitDir() {
    try {
      let p = ''
      try { p = (typeof import.meta !== 'undefined' && import.meta.url) ? import.meta.url : '' } catch (e) {}
      if (!p && typeof __filename !== 'undefined') p = __filename
      if (!p) return ''
      // file:///C:/... → C:/...（去前导 / 和 file 前缀，统一 / 分隔）
      if (p.startsWith('file://')) p = decodeURIComponent(p.slice(7))
      p = String(p).replace(/\\/g, '/').replace(/^\/+/, '')
      let cur = p
      const idx = cur.toLowerCase().indexOf('motion-memory.js')
      if (idx >= 0) cur = cur.slice(0, idx)
      for (let i = 0; i < 8; i++) {
        if (existsSync(cur + '.git')) return cur.replace(/\/+$/, '')
        const last = cur.lastIndexOf('/')
        if (last <= 0) break
        cur = cur.slice(0, last)
      }
    } catch (e) {}
    return ''
  }
  // 插件所在目录（motion-memory.js 的上级目录；非 git 安装也适用；统一 / 分隔）
  function pluginDir() {
    try {
      let p = ''
      try { p = (typeof import.meta !== 'undefined' && import.meta.url) ? import.meta.url : '' } catch (e) {}
      if (!p && typeof __filename !== 'undefined') p = __filename
      if (!p) return ''
      if (p.startsWith('file://')) p = decodeURIComponent(p.slice(7))
      p = String(p).replace(/\\/g, '/').replace(/^\/+/, '')
      const idx = String(p).toLowerCase().indexOf('motion-memory.js')
      if (idx >= 0) return String(p).slice(0, idx).replace(/\/+$/, '')
    } catch (e) {}
    return ''
  }

  // ── 返回共享对象 ───────────────────────────────────────────────────────
  return {
    ctx, fs, tools, sandboxPolicy, llm, state,
    // paths
    normWs, baseWs, defaultRootFrom, p, relOf, root, dshHome, dshProfile,
    configPath, readConfigFile, writeConfigFile, legacyConfigPaths, readJsonFileNative,
    parseRemoteJson, memoryFileCount, globalDefaultRoot,
    necessaryDir, importantDir, archiveBaseDir, archiveDirFor, dailyBaseDir, activeDir,
    noModelDir, isolationDir, quarantineDir, queryLogPath,
    // 会话工作区
    setSessionCwd, sessionCwdOf, cwdOf, sessionPolicy,
    // fs helpers
    acquireWriteLock, readJson, bumpVersion, isUnderMemoryRoot, isUnderPluginDir,
    nativeWriteAllowed, writeTextChannel, writeJson, writeJsonCAS, listFiles,
    tombstone, isTombstone, fileNameOf, stateAt,
    // 归属
    ownerOf, currentOwner, isAdminAgent, scopeOwner, queryOwnerOf,
    sessionPresetOf, ownerKeyOf, sessionPresetOfAsync, ownerKeyOfAsync, mergeLegacyOwners,
    // 查找
    scanDir, findInDir, findImportant, findArchive, findKeyword, titleWords,
    findSimilarTitles, searchTitles, lastOpTime, lastOp, isoStr, uniquePath, pageSlice,
    // 配置
    defaultConfig, cfg, adminCfg, pluginGitDir, pluginDir,
    // 依赖注入（由 apply 组装时调用）
    setReaderFirstFrames, setMemFiles,
  }
}
