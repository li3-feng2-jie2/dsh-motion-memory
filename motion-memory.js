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
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
// 版本更新检查（v0.1.x）：git 绑定安装时用 git fetch/pull 检查并更新
import { execFile as execFileCb } from 'node:child_process'
// import { installAdmin } from './motion-admin.js'
// 周期总结模块（拆分）：素材档位纯逻辑
import { SCOPE_DEFAULTS, scopeLabelOf } from './motion-memory-modules/period-scope.mjs'
// 会话日志帧级读取模块（拆分）：路径推导 + zstd 帧扫描（纯函数）
import { ZSTD_MAGIC, encodeSegment, projectKeyOf, sessionLogsRoot, scanZstdFrames, sessionLogPathOf as sessionLogPathOfMod } from './motion-memory-modules/session-log.mjs'
// 文本工具模块（拆分）：段落/句子切分、diff、历史重建、delta 摘要（纯函数）
import { splitParagraphs, splitSentences, diffParagraph, diffContent, applyInverseParagraph, applyInverse, reconstructAt, deltaOverlap, trunc, deltaSummary, opLabel } from './motion-memory-modules/text-utils.mjs'
// 分块/估算模块（拆分）：token 估算、批次摘要、单块预算、句子切块、末尾小段合并（纯函数）
import { estimateTokens, batchDigest, blockBudget, chunkItemsByBudget, splitItemBySentences, mergeTailSmallChunk } from './motion-memory-modules/chunker.mjs'

export const name = 'motion-memory'

export const inject = ['fs', 'tools', 'sandboxPolicy']

export function apply(ctx) {
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
    activeMigrateReport: null,  // 启动迁移报告（界面状态区可展示）
  }

  // ── time helpers（本地时间用于路径，ISO 用于历史记录）──────────────────
  function pad(n) { return n < 10 ? '0' + n : String(n) }
  function nowIso() { return new Date().toISOString() }
  function parts(d) {
    return { y: d.getFullYear(), m: pad(d.getMonth() + 1), day: pad(d.getDate()), h: pad(d.getHours()), min: pad(d.getMinutes()), s: pad(d.getSeconds()) }
  }
  function ymdPath(d) { const p = parts(d || new Date()); return p.y + '/' + p.m + '/' + p.day }
  // v5 存储瘦身：事件区目录统一为 年/月 两级，文件名带日前缀（DD_xxx.json），对齐补充区/周期区
  function ymPath(d) { const p = parts(d || new Date()); return p.y + '/' + p.m }
  // 事件文件 rel 判断（兼容新旧两种布局）：新 记忆累积/2026/08/16_xxx.json；旧 记忆累积/2026/08/16/xxx.json
  function isEventRel(rel) {
    const r = '/' + String(rel || '').replace(/\\/g, '/')
    if (r.indexOf('/周期记忆/') >= 0 || r.indexOf('/补充/') >= 0) return false
    return /\d{4}\/\d{2}\/\d{2}(?:\/|_)/.test(r)
  }
  function stamp(d) { const p = parts(d || new Date()); return p.y + '-' + p.m + '-' + p.day + '_' + p.h + '-' + p.min + '-' + p.s }
  function ymdCompact(d) { const p = parts(d || new Date()); return p.y + p.m + p.day }
  function parseIso(iso) { const t = new Date(iso).getTime(); return Number.isFinite(t) ? t : 0 }
  function uid() { return 'mm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) }

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
    try { if (!existsSync(filePath)) return undefined; return JSON.parse(readFileSync(filePath, 'utf8')) } catch (e) { return undefined }
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

  // ── 文本工具（splitParagraphs/splitSentences/diffContent/reconstructAt 等
  //     已拆至 ../motion-memory-modules/text-utils.mjs）───────────────────
  // stateAt：结合 history 的 move 操作重建状态（依赖 relOf/p/root，保留在主文件）
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

  // ── 记忆文件对象 ───────────────────────────────────────────────────────
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
      // v4 #5：模型溯源——记忆工具操作时记录"模型功能+模型名称"，数据污染来源复盘
      modelProvider: meta && meta.modelProvider,
      modelName: meta && meta.modelName,
      toolContext: meta && meta.toolContext,
      // v5：调用定位——step（会话内第几步调用）；times（同 agent+会话 防重合并后的阅读时间数组）
      step: meta && meta.step,
      times: meta && meta.times,
    }
  }
  // 溯源引用构造：会话@轮次[:stepN]（meta 有 session+turn 时；step 可选）
  function turnRefOfMeta(meta) {
    const sid = meta && meta.session
    const turn = meta && meta.turn
    if (!sid || !turn) return ''
    let ref = sid + '@' + Number(turn)
    if (meta.step !== undefined && meta.step !== null) ref += ':step' + Number(meta.step)
    return ref
  }
  function newKeywordObj(title, content, reason, meta, links) {
    // 归属兜底：无独立 agent.id 时用会话 id（谁创建的记到谁名下）
    const me = { agent: (meta && (meta.agent || meta.session)) || '', session: (meta && meta.session) || '', turn: (meta && meta.turn) || 0 }
    // v4：自动挂载到本智能体活跃文件（parents 加 active 引用；autoLink 会登记）
    const parents = (links && links.parents) ? links.parents.slice() : []
    const mg = meta && meta.agent
    if (mg && String(mg).indexOf('preset:') === 0 && !parents.some(p => p && p.kind === 'active')) {
      parents.push({ kind: 'active', agent: String(mg) })
    }
    // 创建后默认自动填 会话@轮次[:step] 溯源（用户设计：创建/更新关键词记忆自动带轮次+步信息）
    const children = (links && links.children) ? links.children.slice() : []
    const turnRef = turnRefOfMeta(meta)
    if (turnRef && !children.some(c => c && c.kind === 'turn' && c.ref === turnRef)) {
      children.push({ kind: 'turn', ref: turnRef, location: 'session' })
    }
    return {
      schemaVersion: 1, id: uid(), kind: 'keyword', location: 'important',
      title, reason: reason || '', content: content || '',
      links: { parents, children },
      sourceChain: turnRef ? [turnRef] : [],
      createdAt: nowIso(), updatedAt: nowIso(), lastAccessedAt: nowIso(),
      createdBy: me, lastModifiedBy: me, originalId: null,
      history: [histEntry('create', { ...meta, note: reason || '新建记忆' })],
    }
  }
  function sanitizeFile(name) { return String(name).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || 'untitled' }
  // v5 事件命名：{DD}_{agent}_{会话id}_turn{turn}_{HHMMSS}_{seq}.json —— 日前缀 + 智能体+会话id+轮次+时间分秒+序号
  // （目录已统一为 年/月 两级，日前缀保证同月内文件可区分日期）
  function eventFileName(meta, d, seq) {
    const agent = sanitizeFile((meta && meta.agent) || 'agent')
    const sid = sanitizeFile((meta && meta.session) || 'nosession').slice(-12)
    const turn = (meta && meta.turn) ? 'turn' + Number(meta.turn) : 'turn0'
    const dd = parts(d || new Date()).day
    const hms = pad((d || new Date()).getHours()) + pad((d || new Date()).getMinutes()) + pad((d || new Date()).getSeconds())
    return dd + '_' + agent + '_' + sid + '_' + turn + '_' + hms + '_' + (seq || 1) + '.json'
  }

  // ═════════════════════════════════════════════════════════════════════
  // MemFiles — 记忆文件统一管理（结构体方法：每类文件一个类，load/save/migrate）
  // UE5 类比：每类 USTRUCT 配序列化方法；schemaVersion 即存档版本，
  // load 时读到旧版本自动 migrate 到当前结构，写盘统一走 save。
  // ═════════════════════════════════════════════════════════════════════
  const MemFiles = {}

  // ── 基类：公共路径/读取/版本判断 ────────────────────────────────────
  class MemFileBase {
    static schemaVersion = 1
    static dir() { return root() }
    static isVersion(obj) { return !!(obj && obj.schemaVersion === this.schemaVersion) }
    // 读取：不存在 → null；tombstone → null；旧版本 → 自动迁移（就地转换并写回）
    static async load(path) {
      const o = await readJson(path)
      if (!o || isTombstone(o)) return null
      if (!this.isVersion(o)) {
        const migrated = await this.migrate(o)
        if (migrated) { await writeJson(path, migrated); console.log('[motion-memory] ' + this.name + ' 自动迁移: ' + relOf(path) + ' → v' + this.schemaVersion) }
        return migrated
      }
      return o
    }
    // 子类实现
    static async migrate(o) { return o }
  }

  // ── 关键词记忆（重要/补充）──────────────────────────────────────────
  class KeywordMemory extends MemFileBase {
    static schemaVersion = 1
    static dir() { return importantDir() }
    static path(title) { return p(this.dir(), sanitizeFile(title) + '.json') }
    static async load(title) { return super.load(this.path(title)) }
    static async save(obj) {
      const meta = { agent: obj.agent || '', session: obj.session || '', turn: obj.turn || 0 }
      const base = newKeywordObj(obj.title, obj.content, obj.reason, meta, obj.links)
      const merged = { ...base, ...obj, schemaVersion: this.schemaVersion }
      await writeJson(this.path(merged.title), merged)
      return merged
    }
  }

  // ── 事件记忆（对话跟踪聚合/手动）────────────────────────────────────
  class EventMemory extends MemFileBase {
    static schemaVersion = 1
    static dir() { return dailyBaseDir() }
    static ymDir(d) { return p(this.dir(), ymPath(d || new Date())) }
    static async load(path) { return super.load(path) }
    static async save(obj) {
      const d = new Date()
      const meta = { agent: obj.agent || 'memory-admin', session: obj.session || '', turn: obj.turn || 0 }
      const base = {
        schemaVersion: 1, id: uid(), kind: 'event', location: 'daily', readonly: true,
        title: obj.title, reason: obj.reason || '', content: obj.content,
        links: withActiveParents(obj.links || { parents: [], children: [{ kind: 'turn', ref: meta.session + '@' + meta.turn, location: 'session' }] }, meta),
        sessionRef: buildSessionRef(meta.session, meta.turn),
        createdAt: nowIso(), updatedAt: nowIso(), lastAccessedAt: nowIso(),
        createdBy: meta, lastModifiedBy: meta, originalId: null,
        history: [histEntry('create', { ...meta, note: 'MemFiles 创建事件' })],
      }
      const existing = await listFiles(this.ymDir(d), false)
      const seq = existing.length + 1
      const path = await uniquePath(this.ymDir(d), eventFileName(meta, d, seq))
      await writeJson(path, { ...base, ...obj, schemaVersion: 1 })
      return { path, obj: base }
    }
  }

  // ── 周期记忆 ────────────────────────────────────────────────────────
  class PeriodMemory extends MemFileBase {
    static schemaVersion = 1
    static dir() { return periodBaseDir() }
    static async load(path) { return super.load(path) }
  }

  // ── 必要记忆（per-session，随总览注入）──────────────────────────────
  class NecessaryMemory extends MemFileBase {
    static schemaVersion = 1
    static dir() { return necessaryDir() }
    static path(sid) { return p(this.dir(), String(sid || '') + '.json') }
    static async load(sid) { return super.load(this.path(sid)) }
    static async save(sid, content) {
      const path = this.path(sid)
      const obj = (await readJson(path)) || { sessionId: sid }
      obj.sessionId = sid
      obj.content = content
      obj.updatedAt = nowIso()
      obj.history = obj.history || []
      obj.history.push(histEntry('necessary', { agent: sid, session: sid, turn: 0, note: '必要记忆写入' }))
      await writeJson(path, obj)
      return obj
    }
  }

  // ── 无模型记忆整理区 ────────────────────────────────────────────────
  class NoModelMemory extends MemFileBase {
    static schemaVersion = 1
    static dir() { return noModelDir() }
    static path(sid) { return p(this.dir(), sanitizeFile(sid) + '.json') }
    static async load(sid) { return super.load(this.path(sid)) }
  }

  // ── 隔离事件 ─────────────────────────────────────────────────────────
  class IncidentMemory extends MemFileBase {
    static schemaVersion = 1
    static dir() { return isolationDir() }
    static path(id) { return p(this.dir(), id, 'incident.json') }
    static async load(id) { return super.load(this.path(id)) }
    static async save(inc) { await writeJson(this.path(inc.id), inc); return inc }
  }

  // ── 智能体活跃（v4：custom + keywords + works[]，每会话一段）─────────
  class ActiveMemory extends MemFileBase {
    static schemaVersion = 4
    static dir() { return activeDir() }
    static path(ownerKey) {
      const key = String(ownerKey || '').trim() || 'default'
      const safe = key.replace(/[\\/:*?"<>|]/g, '_')
      return p(this.dir(), safe + '.json')
    }
    static blank(ownerKey) {
      return { schemaVersion: 4, agent: String(ownerKey || ''), custom: '', keywords: [], works: [], refs: [], history: [], updatedAt: '' }
    }
    // 读取：缺失给空白 v4；旧版本（v2/v3/无版本）→ migrate 到 v4 并写回
    static async load(ownerKey) {
      const path = this.path(ownerKey)
      const o = await readJson(path)
      if (o && !isTombstone(o)) {
        if (o.schemaVersion === 4) return { obj: o, path }
        const migrated = this.migrate(o, ownerKey)
        if (migrated) {
          migrated.updatedAt = nowIso()
          migrated._migratedFrom = o.schemaVersion || 0
          migrated._migratedAt = nowIso()
          await writeJson(path, migrated)
          console.log('[motion-memory] ActiveMemory 迁移: ' + relOf(path) + ' v' + (o.schemaVersion || '?') + ' → v4')
        }
        return { obj: migrated || this.blank(ownerKey), path }
      }
      return { obj: this.blank(ownerKey), path }
    }
    // v3 → v4：summary+records[] → custom+keywords[]+works[]
    //  - summary 丢弃（由 works[0].text 派生）
    //  - records[] → works[]（key 里提取 sid；text/refs/at 保留）
    //  - refs[] kind=keyword → keywords[]
    //  - history[] 原样保留（git 式）
    static migrate(o, ownerKey) {
      if (!o || typeof o !== 'object') return null
      const out = this.blank(ownerKey || o.agent || '')
      out.refs = Array.isArray(o.refs) ? o.refs.slice() : []
      out.history = Array.isArray(o.history) ? o.history.slice() : []
      // records → works：key='session:<sid>' 或兜底顺序号
      const works = []
      const recs = Array.isArray(o.records) ? o.records : []
      for (const r of recs) {
        if (!r || !r.text) continue
        let sid = ''
        const k = String(r.key || '')
        const km = k.match(/^session:(.+)$/)
        if (km) sid = km[1]
        else if (r.sid) sid = String(r.sid)
        works.push({ sid: sid || ('w' + (works.length + 1)), text: String(r.text), refs: Array.isArray(r.refs) ? r.refs.slice() : [], updatedAt: r.updatedAt || r.at || '' })
      }
      // summary 兜底：若 works 为空且 summary 存在，作为一条工作记录
      if (!works.length && o.summary) {
        works.push({ sid: 'summary', text: String(o.summary).slice(0, 200), refs: [], updatedAt: '' })
      }
      out.works = works
      // refs → keywords：kind=keyword 的 title
      const kw = new Set()
      for (const r of out.refs) { if (r && r.kind === 'keyword' && r.title) kw.add(String(r.title)) }
      out.keywords = [...kw]
      return out
    }
    // 全量扫描迁移（启动时兜底）：当前活跃/ 下所有非 v4 文件 → v4
    static async migrateAll() {
      const report = { total: 0, migrated: 0, failed: 0, items: [] }
      const files = await listFiles(this.dir(), false)
      for (const f of files) {
        if (f.name === 'active.json' || !f.name.endsWith('.json')) continue
        const o = await readJson(f.path)
        if (!o || isTombstone(o) || o.schemaVersion === 4) continue
        report.total++
        const ownerKey = o.agent || f.name.replace(/\.json$/, '')
        try {
          await this.load(ownerKey)
          report.migrated++
          report.items.push(f.name + ': v' + (o.schemaVersion || '?') + ' → v4')
        } catch (e) { report.failed++; report.items.push(f.name + ': 失败 ' + (e && e.message)) }
      }
      return report
    }
  }

  MemFiles.keyword = KeywordMemory
  MemFiles.event = EventMemory
  MemFiles.period = PeriodMemory
  MemFiles.active = ActiveMemory
  MemFiles.necessary = NecessaryMemory
  MemFiles.noModel = NoModelMemory
  MemFiles.incident = IncidentMemory

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
  // ── 轮次/步骤读取（sessionQuery 事件日志）──────────────────────────────
  // SessionEvent 信封 = { type, seq, time, data }：轮次号/步骤号/消息均在 e.data。
  function textOfContent(blocks) {
    if (!Array.isArray(blocks)) return ''
    let out = ''
    for (const b of blocks) { if (b && b.type === 'text' && typeof b.text === 'string') out += b.text }
    return out.trim()
  }
  function usageOf(e) {
    try {
      const u = e && e.data && e.data.usage
      if (u && typeof u === 'object') return { input: u.inputTokens || u.input || 0, output: u.outputTokens || u.output || 0, total: u.totalTokens || 0 }
    } catch (err) {}
    return null
  }
  // 读取一个 step 的文本内容（assistant 文本 + 工具调用名/参数摘要 + 工具结果摘要）
  function stepTextOf(e) {
    const d = (e && e.data) || {}
    if (e.type === 'assistant/message') return textOfContent(d.message && d.message.content)
    if (e.type === 'tool/call') {
      let args = ''
      try { args = typeof d.arguments === 'string' ? d.arguments.slice(0, 200) : '' } catch (err) {}
      return '[工具调用 ' + d.name + '] ' + args
    }
    if (e.type === 'tool/result') {
      const t = textOfContent(d.message && d.message.content)
      return '[工具结果' + (d.error ? '（错误：' + (d.error.code || d.error.name || '') + '）' : '') + '] ' + (t.slice(0, 300))
    }
    return ''
  }
  // ── 会话日志帧级读取（②-A 缓存 + ②-B 帧级定位）──────────────────
  // 会话日志物理格式（dsh-session-persistence-jsonl）：
  //   <DSH_HOME>/sessions/<projectKey(cwd)>/<encodeSegment(sid)>/session.jsonl.zstd
  //   文件 = 多个独立可解压的 zstd 帧拼接（帧边界=事件批次，行不跨帧）
  //   帧[0] = header 行（含 cwd），后续帧 = 事件批次 JSONL 行
  // 本实现：① 会话级缓存（mtime+size 失效）② 增量解压新增帧（而非每次全量解压）
  // （ZSTD_MAGIC/encodeSegment/projectKeyOf/sessionLogsRoot/scanZstdFrames 已拆至
  //   ../motion-memory-modules/session-log.js）
  // 推导会话日志路径（可用 cwd 或 fallback 扫描 sessions 根目录找 <sid>）
  function sessionLogPathOf(sid, cwd) {
    return sessionLogPathOfMod(sid, cwd, p)
  }
  // 帧级增量读取会话日志：返回 { events, header }；失败返回 null（调用方 fallback 到 sessionQuery）
  function readSessionLogFrames(sid, cwd) {
    const path = sessionLogPathOf(sid, cwd)
    if (!path) return null
    let st
    try { st = statSync(path) } catch (e) { return null }
    const cached = state.sessionLogCache.get(sid)
    // 缓存命中且文件未变 → 直接返回（②-A）
    if (cached && cached.path === path && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      return { events: cached.events, header: cached.header }
    }
    // 读文件 + 帧扫描
    let buf
    try { buf = readFileSync(path) } catch (e) { return null }
    let frames
    try { frames = scanZstdFrames(buf).frames } catch (e) { return null }
    if (!frames.length) return null
    // 增量：同路径且仅变大时，只解压新增帧；否则全量
    const startFrame = (cached && cached.path === path && cached.size < st.size && cached.frameCount > 0)
      ? cached.frameCount : 0
    const events = startFrame > 0 ? cached.events.slice() : []
    let header = startFrame > 0 ? cached.header : null
    const parsed = []
    for (let i = startFrame; i < frames.length; i++) {
      let plain
      try {
        plain = zstdDecompressSync(buf.subarray(frames[i].start, frames[i].end)).toString('utf8')
      } catch (e) { continue }
      for (const line of plain.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const o = JSON.parse(t)
          if (o && o.type === 'session' && !header) { header = o; continue }
          if (o && typeof o === 'object') parsed.push(o)
        } catch (e) {}
      }
    }
    events.push(...parsed)
    const entry = { path, events, header, size: st.size, mtimeMs: st.mtimeMs, frameCount: frames.length }
    state.sessionLogCache.set(sid, entry)
    return { events: entry.events, header: entry.header }
  }
  async function readSessionEvents(sid) {
    // 快速路径：帧级读取（缓存 + 增量解压）
    const fast = readSessionLogFrames(sid)
    if (fast && fast.events && fast.events.length) return fast.events
    // fallback：sessionQuery 服务（live 会话最新事件可能未落盘）
    const sq = ctx.get('sessionQuery')
    if (!sq) return []
    try {
      const snap = await sq.readSession(sid)
      return (snap && snap.events) || []
    } catch (e) { return [] }
  }
  // 轻量读会话标题：只解前 20 帧找 session/title 事件，取最后一条 data.title（供设置界面会话列表使用）
  function readSessionTitleFromLog(sid) {
    try {
      const path = sessionLogPathOf(sid, '')
      if (!path) return ''
      const st = statSync(path)
      if (!st.isFile()) return ''
      const buf = readFileSync(path)
      const frames = scanZstdFrames(buf).frames
      if (!frames.length) return ''
      let title = ''
      // 先解前 20 帧（快路径）；读不到标题再扫全文件（标题帧可能出现在较后的位置）
      const scan = (start, end) => {
        for (let i = start; i < end; i++) {
          let plain
          try { plain = zstdDecompressSync(buf.subarray(frames[i].start, frames[i].end)).toString('utf8') } catch (e) { continue }
          for (const line of plain.split('\n')) {
            const t = line.trim()
            if (!t) continue
            try {
              const o = JSON.parse(t)
              if (o && o.type === 'session/title' && o.data && typeof o.data.title === 'string' && o.data.title.trim()) {
                title = String(o.data.title).trim()
              }
            } catch (e) {}
          }
        }
      }
      scan(0, Math.min(frames.length, 20))
      if (!title && frames.length > 20) scan(20, frames.length)
      return title
    } catch (e) { return '' }
  }
  // 会话日志相对指向（① 引用增强）：工作区 slug + 日志相对路径（相对 DSH_HOME），
  // 供事件记忆溯源时无需 sessionQuery 即可推导会话记录文件位置。
  function buildSessionRef(sid, turn) {
    if (!sid) return null
    let cwd = ''
    try {
      const fast = readSessionLogFrames(sid)
      const h = fast && fast.header
      if (h && typeof h.cwd === 'string') cwd = h.cwd
    } catch (e) {}
    const slug = cwd ? projectKeyOf(cwd) : ''
    const rel = slug ? 'sessions/' + slug + '/' + encodeSegment(sid) + '/session.jsonl.zstd' : ''
    return {
      kind: 'session', sessionId: sid, turn,
      workspaceSlug: slug || null,
      logRelPath: rel || null,
    }
  }
  // 超长文本中部省略：超过 2n 字符时只保留开头+结尾各 n（防止报错/冗长内容全量喂模型）
  function trimTextMiddle(text, n) {
    const s = String(text || '')
    const nn = Math.max(1, Math.floor(Number(n) || 500))
    return s.length > nn * 2 ? s.slice(0, nn) + '\n…（中间省略 ' + (s.length - nn * 2) + ' 字符）…\n' + s.slice(-nn) : s
  }
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
  // 轮次引用统一读取：ref 格式 `会话id@轮次`（整轮）或 `会话id@轮次:step1-2`（步骤段）
  async function readTurnRef(ref, cap) {
    const s = String(ref || '')
    const m = s.match(/^(.+)@(\d+)(?::step(\d+)(?:-(\d+))?)?$/)
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
        // 总结队列并发（对话跟踪等重活同时运行数；0=按顺序执行，默认防本地小模型排队）
        summaryConcurrency: 0,
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

  // ── 当前活跃/轮次（session/event 全局可达）─────────────────────────────
  function activeIndexPath() { return p(activeDir(), 'active.json') }
  function activeKeyOf(ownerKey, sid) { return (ownerKey || '') + '@' + sid }
  // 会话工作摘要生成（turn/end 时调用）：
  // - 有模型（recordModel 或 admin.model）：模型生成一句话工作摘要
  // - 无模型且 activeNoModelSummarize=true：规则提取本轮用户消息 + 同会话前几轮用户消息，落盘无模型记忆整理区
  // - 无模型且开关关：返回 null（不更新摘要）
  // 返回 { summary, noModel: bool, ref } 或 null
  // 读取本轮用户文本（带延迟重试：turn/end 回调时 live 快照可能未含最新轮次）
  async function readTurnUserTextRetry(sid, turn, cap, attempts) {
    const max = Math.max(1, attempts || 3)
    for (let i = 0; i < max; i++) {
      const text = await readTurnUserText(sid, turn, cap)
      if (text && text !== '（该轮次无文本内容）') return text
      if (i < max - 1) await new Promise(r => setTimeout(r, 350 * (i + 1)))
    }
    return ''
  }
  // （已移除）会话工作摘要器 summarizeSessionTurn：无调用方（所有 writeActive 调用均显式传
  // summarize:false），活跃摘要由对话跟踪的 explicitSummary + record 机制驱动。
  // 会话指针：{ownerKey}@{sid}.json（v2；v1 的 {sid}.json 由迁移脚本处理）
  // summary 去重：与上次摘要相同/相似则只更新轮次（不更新摘要、不触发 diff）
  function summarySimilar(a, b) {
    if (!a || !b) return false
    if (a === b) return true
    const s1 = String(a).trim(), s2 = String(b).trim()
    if (!s1 || !s2) return false
    // 简单相似：一方包含另一方 80% 以上，或 Jaccard 词重叠 > 0.7
    const longer = s1.length >= s2.length ? s1 : s2
    const shorter = s1.length >= s2.length ? s2 : s1
    if (longer.indexOf(shorter) >= 0 && shorter.length >= longer.length * 0.5) return true
    const w1 = new Set(s1.split(/[\s，。、；：,.;:]+/)), w2 = new Set(s2.split(/[\s，。、；：,.;:]+/))
    let inter = 0
    for (const w of w1) if (w2.has(w)) inter++
    const union = w1.size + w2.size - inter
    return union > 0 && inter / union > 0.7
  }
  // ── 智能体活跃文件（v4：#1 每智能体一个活跃记忆，父关联终点）───────────
  // 文件名：preset_cordis.json（ownerKey 的 : 转 _）；内容按智能体聚合，替代每会话指针
  function agentActivePath(ownerKey) {
    return MemFiles.active.path(ownerKey)
  }
  function agentActiveTitle(ownerKey) {
    const key = String(ownerKey || '').trim() || 'default'
    return '智能体活跃：' + key
  }
  // 读取智能体活跃文件（缺失时给空白 v4；旧版本自动迁移到 v4）
  // 兼容视图：返回对象同时带 v4 字段（works/custom/keywords）与旧字段（summary/records 派生），
  // 旧调用方读 act.summary / act.records 不崩；写盘统一 v4。
  async function readAgentActive(ownerKey) {
    const { obj, path } = await MemFiles.active.load(ownerKey)
    // 派生兼容字段（不写回，仅读兼容）
    if (!Array.isArray(obj.works)) obj.works = []
    obj.summary = obj.works.length ? String(obj.works[0].text || '').slice(0, 120) : ''
    obj.records = obj.works.map(w => ({ key: w.sid ? 'session:' + w.sid : '', text: w.text, refs: w.refs || [], at: w.updatedAt || '', sid: w.sid || '' }))
    obj.summaryNoModel = !!obj.summaryNoModel
    return { obj, path }
  }
  // 记录链来源指向兜底：每次更新必须带来源指向（[文字](会话@轮次[:step]) md 链接），
  // 内容已含轮次引用链接则原样保留（增量时多指向累积），否则程序自动补前缀指向
  function withSourceRef(text, sid, turn) {
    const t = String(text || '')
    if (!t) return t
    if (/\]\([^)]*@\d+/.test(t)) return t
    return '[会话工作更新](' + sid + '@' + Number(turn) + ')：' + t
  }
  // 历史记录按「agent + 会话 + 天」合并：同键(agent+session+日期)的同类操作记录合并为一条，
  // times 内部保留每次准确时间，delta 留当天最终版（按天粒度下"当天结束状态"即可复原/计分）
  function pushMergedHistory(act, entry, meta) {
    act.history = act.history || []
    const dayKey = String(entry.at || '').slice(0, 10)
    const agentKey = String(entry.agent || '')
    const sessKey = String(entry.session || '')
    const idx = act.history.findIndex(h => h && h.op === entry.op &&
      String(h.agent || '') === agentKey && String(h.session || '') === sessKey &&
      String(h.at || '').slice(0, 10) === dayKey)
    if (idx >= 0) {
      const old = act.history[idx]
      old.times = Array.isArray(old.times)
        ? old.times.concat(entry.at || nowIso())
        : (old.at ? [old.at, entry.at || nowIso()] : [entry.at || nowIso()])
      if (entry.delta && entry.delta.length) old.delta = entry.delta
      if (entry.note) old.note = entry.note
      old.at = entry.at || old.at
      act.history[idx] = old
    } else {
      act.history.push(entry)
    }
    act.history = act.history.slice(-50)
  }
  // 查询次数按天去重：times 数组（或 at）按日期去重后的天数——同 agent+会话+同日只算一次查询（计分防刷）
  function queryDayCount(h) {
    const days = new Set()
    if (Array.isArray(h && h.times) && h.times.length) {
      for (const t of h.times) { const s = String(t || '').slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(s)) days.add(s) }
    }
    if (!days.size) {
      const s = String((h && h.at) || '').slice(0, 10)
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) days.add(s)
    }
    return days.size || 1
  }
  // 程序保证本会话工作段存在（不依赖模型 op=prepend）：works 无本会话 sid 段 → 自动创建空白段。
  // 空白段不写 history（未产生有效内容）；后续对话跟踪成功总结时更新内容并统一记一次更新；
  // 空白段保留（用户确认：无内容=走无模型整理，空白段保留并提醒，不删除）。
  async function ensureSessionWorkSegment(ownerKey, sid, meta) {
    try {
      const { obj: act, path } = await readAgentActive(ownerKey)
      const works = Array.isArray(act.works) ? act.works : []
      if (works.some(w => w && w.sid === sid)) return { ok: true, created: false, path }
      const out = Object.assign({}, act, {
        works: works.concat([{ sid, text: '', refs: [], updatedAt: nowIso() }]),
        updatedAt: nowIso(),
        schemaVersion: 4,
      })
      delete out.records
      delete out.summary
      await writeJson(path, out)
      return { ok: true, created: true, path }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }
  // works 段归档：被压缩/下沉删除前，把该段完整文本 + refs + 历史写入 补充/YYYY/MM/<sid>.json（同名追加）。
  // 语义=「会话工作历史记录」，按年月时间分散存储（与懒归档一致）；查询记录按天合并。
  async function archiveWorksSegment(sid, seg, meta) {
    try {
      const text = String((seg && seg.text) || '')
      if (!text || !text.trim()) return { ok: false, error: '空段不归档' }
      const d = new Date()
      const dst = p(archiveDirFor(d), sanitizeFile(sid) + '.json')
      const rep = await readJson(dst)
      const me = { agent: (meta && (meta.agent || meta.session)) || 'memory-admin', session: sid, turn: (meta && meta.turn) || 0 }
      const entry = {
        kind: 'works-history',
        title: '会话工作历史：' + sid,
        reason: 'works 段压缩/下沉归档（按年月分散存储）',
        at: nowIso(),
        content: text,
        refs: Array.isArray(seg && seg.refs) ? seg.refs : [],
        updatedAt: (seg && seg.updatedAt) || nowIso(),
        archivedBy: me,
        source: 'active-works',
      }
      if (rep && !isTombstone(rep)) {
        // 同名文件存在：按天合并——同一天归档追加到当天条目，跨天新增条目
        rep.entries = Array.isArray(rep.entries) ? rep.entries : []
        const dayKey = entry.at.slice(0, 10)
        const sameDay = rep.entries.findIndex(e2 => e2 && e2.kind === 'works-history' && String(e2.at || '').slice(0, 10) === dayKey)
        if (sameDay >= 0) {
          const prev = rep.entries[sameDay]
          prev.content = prev.content + '\n---\n' + entry.content
          prev.refs = (prev.refs || []).concat(entry.refs)
          prev.updatedAt = entry.updatedAt
          rep.entries[sameDay] = prev
        } else {
          rep.entries.push(entry)
        }
        rep.history = rep.history || []
        rep.history.push(histEntry('move', { ...me, note: 'works 段归档追加：' + sid, fromPath: 'active-works', toPath: relOf(dst), keep: false }))
        rep.updatedAt = nowIso()
        await writeJson(dst, rep)
      } else {
        await writeJson(dst, {
          schemaVersion: 1, id: uid(), kind: 'works-history', location: 'archive',
          title: '会话工作历史：' + sid,
          reason: 'works 段压缩/下沉归档',
          entries: [entry],
          links: { parents: [], children: [] },
          createdAt: nowIso(), updatedAt: nowIso(), lastAccessedAt: nowIso(),
          createdBy: me, lastModifiedBy: me, originalId: null,
          history: [histEntry('move', { ...me, note: 'works 段归档创建：' + sid, fromPath: 'active-works', toPath: relOf(dst), keep: false })],
        })
      }
      return { ok: true, path: relOf(dst) }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }
  // 会话工作复原（周期下沉后旧会话复活）：works 无该会话段时，从 补充/YYYY/MM/<sid>.json 归档历史取回，
  // 写回 works（refs 加 period-restore 标记，history 记一条"复原"）。高缓存 sid→周期文件映射（state 登记，
  // 周期总结完成时写入）避免翻历史；定位依据是周期文件的 range/sessionTurns 事实，不按配置天数计算。
  state.periodSidCache = state.periodSidCache || {}   // sid → periodRel（周期完成时登记）
  async function restoreWorksSegment(ownerKey, sid, meta) {
    try {
      // ① 补充区同名文件定位（按年月时间分散）：扫 补充/ 下 <sid>.json
      let found = null
      for (const f of await listFiles(archiveBaseDir(), true)) {
        if (!String(f.name).startsWith(sanitizeFile(sid))) continue
        const o = await readJson(f.path)
        if (!o || isTombstone(o)) continue
        if (o.kind === 'works-history' || (o.entries && o.entries.length)) { found = { path: f.path, obj: o }; break }
      }
      if (!found) return { ok: false, error: '补充区无该会话工作历史' }
      // ② 取最新一条历史（entries 按天合并，取最后一天 = 最近状态）
      const entries = Array.isArray(found.obj.entries) ? found.obj.entries : []
      const lastEntry = entries.length ? entries[entries.length - 1] : null
      const restoredText = (lastEntry && lastEntry.content) || found.obj.content || ''
      if (!restoredText || !restoredText.trim()) return { ok: false, error: '归档内容为空' }
      // ③ 写回 works（refs 加 period-restore 标记，history 记一条复原）
      const { obj: act, path } = await readAgentActive(ownerKey)
      const works = Array.isArray(act.works) ? act.works : []
      if (works.some(w => w && w.sid === sid)) return { ok: false, error: '已存在本会话工作段，无需复原' }
      act.works = works.concat([{ sid, text: restoredText, refs: (lastEntry && lastEntry.refs) || [], updatedAt: nowIso() }])
      pushMergedHistory(act, histEntry('update', {
        agent: ownerKey || sid, session: sid, turn: (meta && meta.turn) || 0,
        note: '会话工作复原（来源补充区历史 ' + relOf(found.path) + '）',
        keep: false,
      }))
      act.updatedAt = nowIso()
      act.schemaVersion = 4
      delete act.records
      delete act.summary
      await writeJson(path, act)
      // ④ 高缓存登记：本次复原关联的周期文件（由归档路径无法直接推，仅登记 sid→补充文件）
      state.periodSidCache[sid] = relOf(found.path)
      return { ok: true, restored: true, text: restoredText.slice(0, 120), path: relOf(found.path) }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }
  async function writeActive(sid, turn, extra) {
    const ownerKey = (extra && extra.ownerKey) || ''
    const { obj: act, path } = await readAgentActive(ownerKey)
    // 记录本次变更前的旧摘要（用于 history 保留）
    const oldSummary = act.summary || ''
    let summaryChanged = false
    let refChanged = false
    if (extra) {
      if (extra.lastMemRef !== undefined && extra.lastMemRef !== act.lastMemRef) { act.lastMemRef = extra.lastMemRef; refChanged = true }
      if (extra.lastAction !== undefined && extra.lastAction !== act.lastAction) { act.lastAction = extra.lastAction; refChanged = true }
    }
    // v5 记录链：extra.record 提供一条工作记录（prepend/append/merge/replace）
    // record = { text, refs?: [{kind,title,ref}], op?: 'prepend'|'append'|'merge'|'replace', key?: 主题键 }
    let recordChanged = false
    if (extra && extra.record && extra.record.text) {
      act.records = act.records || []
      // key/sid 必须落盘：后续 append/merge/replace 靠 key 定位同主题（如 session:<sid>）记录；
      // 之前丢 key 导致 findIndex 永远落空、只能覆盖最后一条 → 会话工作变成"单个会话一轮次"
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
          // 找同主题记录（key 匹配）；再按会话 id 匹配；仍找不到 = 该会话还没有段 → 走下方新建分支
          // （不再回退最后一条：否则新会话第一次总结会 append 到别的会话的段，把多会话混成 1 段）
          let idx = -1
          if (recKey) idx = act.records.findIndex(r => r && r.key === recKey)
          if (idx < 0 && rec.sid) idx = act.records.findIndex(r => r && r.sid === rec.sid)
          // prepend：即使已有同主题段也不走"整合替换"，而是并入下方"插到段前"分支（全新工作插到最前）
          if (idx >= 0 && op !== 'prepend') {
            const oldRec = act.records[idx]
            const oldSnapshot = { ...oldRec, keptAt: nowIso() }
            pushMergedHistory(act, histEntry('update', {
              agent: ownerKey || sid, session: sid, turn,
              note: '活跃记录' + (op === 'replace' ? '覆盖' : op === 'merge' ? '合并' : '追加') + '（旧记录归档）：' + String(oldRec.text || '').slice(0, 60),
              keep: false,
              delta: [{ type: 'record', from: oldRec.text, to: rec.text }],
            }))
            // append/merge/replace 统一为"整合替换"：模型输出的是完整整合后的新段落
            // （提示词 7 规则：增量是信息整合不是累加），直接替换文本（旧版已进 history），
            // refs 保留旧指向 + 新指向——不再拼接堆叠（否则会话工作越长越重复）
            act.records[idx] = Object.assign({}, oldRec, { text: rec.text, refs: (oldRec.refs || []).concat(rec.refs), updatedAt: nowIso() })
          } else {
            // prepend（默认）：新记录插到最前；若同主题（key/sid）段已存在 → 合并到该段前面（保证每会话一段）
            const mergeIdx = recKey ? act.records.findIndex(r => r && (r.key === recKey || (rec.sid && r.sid === rec.sid))) : -1
            if (mergeIdx >= 0) {
              const oldRec = act.records[mergeIdx]
              act.records[mergeIdx] = Object.assign({}, oldRec, { text: rec.text + '。' + String(oldRec.text || ''), refs: rec.refs.concat(oldRec.refs || []), updatedAt: nowIso(), key: recKey || oldRec.key, sid: rec.sid || oldRec.sid })
            } else {
              act.records.unshift(rec)
            }
          }
        }
        // 收敛：同 key/sid 段只保留一条（历史 bug 曾产生重复段；合并文本，最新在前）
        if (recKey || rec.sid) {
          const seen = {}
          act.records = act.records.filter(r => {
            const k = r && (r.key || (r.sid ? 'sid:' + r.sid : ''))
            if (!k) return true
            if (seen[k]) {
              // 重复：内容并入保留的那条（保留更新更早/文本更长的？简单并入第一条）
              const keep = seen[k]
              keep.text = String(keep.text || '') + '。' + String(r.text || '')
              keep.refs = (keep.refs || []).concat(r.refs || [])
              return false
            }
            seen[k] = r
            return true
          })
        }
        // 记录链上限（防膨胀，默认 50 条）
        const recMax = Math.max(1, Number(cfg().indexScore && cfg().indexScore.maxRefs) || 50)
        if (act.records.length > recMax) act.records = act.records.slice(0, recMax)
        recordChanged = true
      }
    }
    // keywords 整理联动：extra.keywords（模型按工具提示词显式整理的词列表）合并进活跃 keywords
    if (extra && Array.isArray(extra.keywords)) {
      const merged = (Array.isArray(act.keywords) ? act.keywords : []).concat(extra.keywords.map(String))
      const seen = new Set()
      const next = merged.filter(k => { const s = String(k || '').trim(); if (!s || seen.has(s)) return false; seen.add(s); return true }).slice(0, 20)
      if (next.join('|') !== (Array.isArray(act.keywords) ? act.keywords : []).join('|')) { act.keywords = next; recordChanged = true }
    }
    // 会话工作摘要（turn/end 或显式 extra.summarize 时生成）
    // 对话跟踪传 explicitSummary（总结内容），不再调模型；否则按需生成
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
      // （已移除）独立摘要器 summarizeSessionTurn：活跃摘要统一由 explicitSummary + record 驱动，
      // 此分支保留结构但不再生成模型摘要（所有调用方均传 summarize:false）
    }
    // 零无效更新：无任何有效变化 → 不写文件、不刷索引、不注入
    if (!summaryChanged && !refChanged && !recordChanged) return undefined
    // v5：summary 与记录链联动——有记录变化时，summary 从 records 顶部截取（最新工作）
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
    // works 总量预算（总结摘要字数 summaryCharsK k token）：超预算时从最旧记录开始压缩为
    // "保留指向链接 + 正文前 20 字"（想看细节点链接查原文/历史），直到总量合规——增量是整合不是堆叠
    if (recordChanged && Array.isArray(act.records) && act.records.length) {
      // k token → 字符预算：按内部语言表换算（中文约 1.5 字/token，取各类 per 最大值粗估，下限 500 字）
      const charsK = Math.max(1, Number(cfg().summaryCharsK) || 2)
      const langTable = (Array.isArray(adminCfg().langTokens) && adminCfg().langTokens.length) ? adminCfg().langTokens : [{ kind: 'cn', per: 1.5 }, { kind: 'en', per: 4 }]
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
          // 保留 md 链接（指向），压缩正文
          const links = (full.match(linkRe) || []).join(' ')
          const body = full.replace(linkRe, '').trim()
          const cut = [links, body ? body.slice(0, 20) : ''].filter(Boolean).join(' ')
          if (cut.length < full.length) {
            pushMergedHistory(act, histEntry('update', {
              agent: 'memory-admin', session: sid, turn,
              note: '会话工作总量压缩（' + (budgetChars / 1000).toFixed(1) + 'k 字预算）：' + full.slice(0, 30) + '…',
              keep: false,
            }))
            total = total - full.length + cut.length
            r.text = cut
          } else {
            // 压缩后仍不短（如纯链接）：归档该条后移除（指向已并入其它记录；完整文本进补充同名文件）
            total -= full.length
            archiveWorksSegment(r.sid || sid, { text: full, refs: r.refs, updatedAt: r.updatedAt || r.at }, { agent: ownerKey || sid, session: sid, turn }).catch(() => {})
            act.records.splice(i, 1)
          }
        } else {
          total -= full.length
          archiveWorksSegment(r.sid || sid, { text: full, refs: r.refs, updatedAt: r.updatedAt || r.at }, { agent: ownerKey || sid, session: sid, turn }).catch(() => {})
          act.records.splice(i, 1)
        }
      }
    }
    act.agent = String(ownerKey || '')
    // v4 写盘：records 兼容视图 → 同步回 works（每会话一段）；summary 不落盘（由 works[0] 派生）
    if (recordChanged && Array.isArray(act.records)) {
      act.works = act.records.map(r => ({
        sid: r.sid || (r.key && r.key.indexOf('session:') === 0 ? r.key.slice(8) : '') || 'w' + Math.random().toString(36).slice(2, 6),
        text: String(r.text || ''),
        refs: Array.isArray(r.refs) ? r.refs : [],
        updatedAt: r.updatedAt || r.at || nowIso(),
      }))
    }
    if (!Array.isArray(act.works)) act.works = []
    if (!Array.isArray(act.keywords)) act.keywords = []
    if (typeof act.custom !== 'string') act.custom = ''
    delete act.summary
    delete act.records
    act.schemaVersion = 4
    act.updatedAt = nowIso()
    await writeJson(path, act)
    await refreshActiveIndex()
    // #8 注入只含摘要：事件/教训等 refs 新增不进注入文本（v4：摘要派生自 works[0]）
    if ((summaryChanged || (extra && extra.recordDiff)) && !(extra && extra.noNotify)) {
      const topText = (act.works && act.works.length) ? String(act.works[0].text || '') : ''
      const added = summaryChanged && topText
        ? [{ title: topText.slice(0, Math.max(20, Number(cfg().summaryInjectChars) || 300)), ref: '', kind: 'summary' }]
        : []
      pushDiff({ at: nowIso(), ownerKey, session: sid, turn, added, removed: (extra && extra.removed) || [], track: !!(extra && extra.recordDiff) })
    }
    return undefined
  }
  // 全局活跃索引 active.json（派生数据，可重建；无 history）
  async function refreshActiveIndex() {
    const idxPath = activeIndexPath()
    const idx = (await readJson(idxPath)) || { schemaVersion: 2, updatedAt: '', pinned: [], refs: [], recentPeriods: [], agents: [], incident: null }
    idx.updatedAt = nowIso()
    // v4：agents（智能体活跃文件聚合，替代旧 sessionPointers）；支持 v2/v3/v4（v4=works 结构）
    const agents = []
    for (const f of await listFiles(activeDir(), false)) {
      if (f.name === 'active.json') continue
      if (!f.name.endsWith('.json')) continue
      const o = await readJson(f.path)
      if (!o || isTombstone(o)) continue
      if ((o.schemaVersion !== 2 && o.schemaVersion !== 3 && o.schemaVersion !== 4) || o.agent === undefined) continue  // 跳过旧会话指针文件（v2 遗留）
      // v4：summary/records 从 works 派生；v2/v3 直接用原字段
      const works = Array.isArray(o.works) ? o.works : []
      const summary = o.schemaVersion === 4
        ? (works.length ? String(works[0].text || '').slice(0, 120) : '')
        : (o.summary || '')
      agents.push({ agent: o.agent || f.name.replace(/\.json$/, ''), summary, lastMemRef: o.lastMemRef || '', lastAction: o.lastAction || '', updatedAt: o.updatedAt || '', records: o.schemaVersion === 4 ? works.length : (o.records || []).length })
    }
    agents.sort((a, b) => parseIso(b.updatedAt) - parseIso(a.updatedAt))
    idx.agents = agents.slice(0, 20)
    // 最近周期：周期记忆目录下按时间取最近 5
    const periods = []
    for (const f of await listFiles(p(root(), '记忆累积', '周期记忆'), true)) {
      const o = await readJson(f.path)
      if (!o || isTombstone(o) || o.kind !== 'period') continue
      periods.push({ title: o.title || '', ref: relOf(f.path), at: o.createdAt || '', score: 0 })
    }
    periods.sort((a, b) => parseIso(b.at) - parseIso(a.at))
    idx.recentPeriods = periods.slice(0, 5).map(x => x.ref)
    // refs 合并：保留 pinned 不动；从 recentPeriods + 最近事件 + 重要标题重建（缺的补、存的保留 score）
    const now = Date.now()
    const decay = Math.max(1, Number(cfg().decayDays) || 30)
    const sc = cfg().indexScore || {}
    const scPeriod = Number(sc.period) || 5
    const scEvent = Number(sc.event) || 3
    const scKeyword = Number(sc.keyword) || 2
    const scFloor = Number(sc.floor) >= 0 ? Number(sc.floor) : 0.2
    const scThreshold = Number(sc.threshold) >= 0 ? Number(sc.threshold) : 0.3
    const scMaxRefs = Math.max(1, Number(sc.maxRefs) || 50)
    const seenRefs = new Map(idx.refs.map(r => [r.ref, r]))
    const fresh = []
    for (const r of idx.recentPeriods) {
      const prev = seenRefs.get(r)
      if (prev) { fresh.push(prev); seenRefs.delete(r) }
      else fresh.push({ title: r, ref: r, score: scPeriod, lastAccess: nowIso(), kind: 'period' })
    }
    // 最近事件：按 年/月 目录从新到旧定向扫描（v5），取最近 5
    const evs = []
    const nowDate = new Date()
    const scanMonths = Math.max(1, Number(cfg().indexScore && cfg().indexScore.scanMonths) || 3)
    for (let i = 0; i < scanMonths && evs.length < 5; i++) {
      const d = new Date(nowDate.getFullYear(), nowDate.getMonth() - i, 1)
      const ym = String(d.getFullYear()) + '/' + pad(d.getMonth() + 1)
      const files = await listFiles(p(root(), '记忆累积', ym), false).catch(() => [])
      files.sort((a, b) => (b.name < a.name ? -1 : b.name > a.name ? 1 : 0))
      for (const f of files) {
        const rel = relOf(f.path)
        if (!isEventRel(rel)) continue
        const o = await readJson(f.path)
        if (o && !isTombstone(o) && o.kind === 'event') { evs.push({ rel, title: o.title || '', at: o.createdAt || '' }); if (evs.length >= 5) break }
      }
    }
    evs.sort((a, b) => parseIso(b.at) - parseIso(a.at))
    for (const e of evs.slice(0, 5)) {
      const prev = seenRefs.get(e.rel)
      if (prev) { fresh.push(prev); seenRefs.delete(e.rel) }
      else fresh.push({ title: e.title, ref: e.rel, score: scEvent, lastAccess: nowIso(), kind: 'event' })
    }
    // 重要标题（全部，但仅标题级别）
    for (const t of await scanDir(importantDir(), false)) {
      const rel = relOf(t.path)
      const prev = seenRefs.get(rel)
      if (prev) { fresh.push(prev); seenRefs.delete(rel) }
      else fresh.push({ title: t.obj.title || '', ref: rel, score: scKeyword, lastAccess: nowIso(), kind: 'keyword' })
    }
    // 剩余旧 refs：时间衰减后保留（score>0），超期降级提示
    for (const [ref, r] of seenRefs) {
      const age = (now - parseIso(r.lastAccess || '')) / 86400000
      const remain = r.score * Math.max(scFloor, 1 - age / decay)
      if (remain > scThreshold) fresh.push({ ...r, score: Math.round(remain * 10) / 10 })
    }
    fresh.sort((a, b) => b.score - a.score)
    idx.refs = fresh.slice(0, scMaxRefs)
    // 隔离状态
    const inc = activeIncident()
    idx.incident = inc ? { id: inc.id, at: inc.at, targetTime: inc.targetTime, files: (inc.files || []).length } : null
    await writeJson(idxPath, idx)
    return idx
  }
  // 记忆变更后：更新会话指针 + 刷新活跃索引 + 记录 diff（供阶段3注入）
  // removed: [{title, ref}] 本次移除项（memory_forget/update-forget 传入）
  async function touchActive(meta, lastMemRef, lastAction, removed, keywords) {
    try {
      const sid = (meta && meta.session) || ''
      if (!sid) return
      const turn = (meta && meta.turn) || 0
      const ownerKey = (meta && meta.agent && String(meta.agent).indexOf('preset:') === 0) ? String(meta.agent) : ''
      // v4：写智能体活跃文件（替代会话指针）；ownerKey 空则用会话 id 兜底（暂归该会话名下）
      const actKey = ownerKey || (meta && meta.session) || 'default'
      const { obj: act, path } = await readAgentActive(actKey)
      let changed = false
      // keywords 整理联动：memory_add 等传入新主题词时合并进活跃 keywords（去重、上限）
      if (Array.isArray(keywords) && keywords.length) {
        const merged = (Array.isArray(act.keywords) ? act.keywords : []).concat(keywords.map(String))
        const seen = new Set()
        const next = merged.filter(k => { const s = String(k || '').trim(); if (!s || seen.has(s)) return false; seen.add(s); return true }).slice(0, 20)
        if (next.join('|') !== (Array.isArray(act.keywords) ? act.keywords : []).join('|')) { act.keywords = next; changed = true }
      }
      if (lastMemRef && act.lastMemRef !== lastMemRef) { act.lastMemRef = lastMemRef; act.lastAction = lastAction || 'memory_write'; changed = true }
      // 零无效更新——无引用变化则不写、不注入
      if (!changed) return
      act.agent = actKey
      act.updatedAt = nowIso()
      await writeJson(path, act)
      await refreshActiveIndex()
      // v4：touchActive 的 diff 应包含新增记忆引用（标题/kind），供跨会话通知
      // 标题优先从文件读；读失败回退用文件名（避免时序问题导致 added 为空）
      let addedTitle = '', addedKind = 'memory'
      if (lastMemRef) {
        try {
          const t = await readJson(p(root(), lastMemRef))
          if (t) { addedTitle = t.title || ''; addedKind = t.kind || 'memory' }
        } catch (e) {}
        if (!addedTitle) addedTitle = String(lastMemRef).split('/').pop().replace(/\.json$/, '')
      }
      pushDiff({
        at: nowIso(), ownerKey: actKey, session: sid, turn,
        added: addedTitle ? [{ title: addedTitle, ref: lastMemRef, kind: addedKind }] : [],
        removed: (removed || []).slice(0, 10),
      })
    } catch (e) { console.error('[motion-memory] touchActive: ' + (e && e.message)) }
  }
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
    const nec = await readJson(p(necessaryDir(), sid + '.json'))
    // 总览按本智能体归属过滤（只看自己的 + 管理员共享产物；queryOtherAgents 开则全量）
    const ovOwner = cfg().queryOtherAgents ? '' : (ownerKey || sid || '')
    const important = (await scanDir(importantDir(), false, ovOwner))
      .map(e => e.obj.title)
      .sort()
      .slice(0, 100)
    const evs = []
    // v5 定向扫描：按 年/月 目录从新到旧翻，取最近事件（避免全量递归扫全部日期）
    const now = new Date()
    const scanMonths = Math.max(1, Number(cfg().indexScore && cfg().indexScore.scanMonths) || 3)
    for (let i = 0; i < scanMonths && evs.length < 5; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const ym = String(d.getFullYear()) + '/' + pad(d.getMonth() + 1)
      const files = await listFiles(p(dailyBaseDir(), ym), false).catch(() => [])
      files.sort((a, b) => (b.name < a.name ? -1 : b.name > a.name ? 1 : 0))
      for (const f of files) {
        const rel = relOf(f.path)
        if (!isEventRel(rel)) continue
        const o = await readJson(f.path)
        if (o && !isTombstone(o) && o.kind === 'event') {
          if (ovOwner) { const ow = ownerOf(o); if (ow && ow !== ovOwner && ow !== 'memory-admin') continue }
          evs.push(o)
          if (evs.length >= 5) break
        }
      }
    }
    evs.sort((a, b) => parseIso(b.createdAt) - parseIso(a.createdAt))
    const recent = evs.slice(0, 5).map(o => ({ title: o.title, createdAt: o.createdAt }))
    // 本智能体活跃关键词（注入给模型：当前活跃主题词，随总览自动载入）
    let keywords = []
    let blankWorks = []
    try {
      const act = await readAgentActive(ownerKey || sid || '')
      if (act && act.obj) {
        if (Array.isArray(act.obj.keywords)) keywords = act.obj.keywords.slice(0, 20)
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
      important,
      recent,
      keywords,
      blankWorks,
      incident: inc ? { id: inc.id, at: inc.at, targetTime: inc.targetTime, files: (inc.files || []).length } : null,
    }
  }

  function overviewDigest(entries) {
    // digest 只含低频变化内容：必要记忆 + 重要记忆标题 + 活跃关键词 + 隔离状态。
    // 最近事件不参与 digest——事件频繁产生（对话跟踪等），若计入会导致
    // 每有新事件就重注入总览。需要最新事件时 agent 自行调 memory_query。
    const canonical = JSON.stringify({
      necessary: entries.necessary,
      important: entries.important,
      keywords: entries.keywords || [],
      incidentId: entries.incident ? entries.incident.id : null,
    })
    return createHash('sha256').update(canonical).digest('hex')
  }

  function renderOverview(entries) {
    const lines = [
      '<system-reminder>',
      '运动记忆·会话总览（仅当记忆变化时更新；需要细节时用 memory_query 查看）：',
      '必要记忆：' + (entries.necessary || '（无）'),
      '重要记忆（' + entries.important.length + ' 条）：' + (entries.important.length ? entries.important.join('；') : '（无）'),
    ]
    if (entries.keywords && entries.keywords.length) lines.push('当前活跃关键词：' + entries.keywords.join('、'))
    if (entries.blankWorks && entries.blankWorks.length) lines.push('⚠ 待总结提醒：会话 ' + entries.blankWorks.join('、') + ' 的工作段仍为空白（模型总结未成功或等待转正），需要总结补全。')
    if (entries.recent.length) lines.push('最近事件：' + entries.recent.map(o => o.title).join('；'))
    if (entries.incident) {
      lines.push('⚠ 隔离通知：事件 ' + entries.incident.id + ' 于 ' + entries.incident.at + ' 触发，目标时间 ' + entries.incident.targetTime + '，涉及 ' + entries.incident.files + ' 个文件。可调用 memory（cmd=isolation_restore，回滚）或 memory（cmd=isolation_clear，解除）。')
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
          recent: entries.recent,
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
    for (const t of e.important) if (typeof t !== 'string') return undefined
    for (const r of e.recent) if (!r || typeof r.title !== 'string' || typeof r.createdAt !== 'string') return undefined
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
        if (ev.type !== 'user/message' || ev.data.source.kind !== 'motion-memory-overview') continue
        const digest = overviewDigestOfSource(ev.data.source)
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
      const ownerKey = ownerKeyOf(agent)
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
          if (agent) agentId = ownerKeyOf(agent) || String(agent.id || (agent.session && agent.session.id) || '')
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
  tool('memory_query', '运动记忆·查询/回忆：开工总览（默认：必要+当前活跃+索引+最近事件）；keyword=匹配记忆标题列表；open=阅读指定标题（关联展开+历史记录）；openTurn=读会话轮次原文（会话id@轮次[:step]）；recent=最近事件条数；enhance=true 深度增强。纯文件读取不调模型（enhance 除外）。', {
    keyword: { type: 'string', description: '匹配词：列出重要/周期记忆标题中包含该词（或内容包含）的条目' },
    open: { type: 'string', description: '阅读指定标题的记忆文件（展开关联+历史记录）' },
    openTurn: { type: 'string', description: '读对话轮次原文，格式 会话id@轮次[:stepN]' },
    recent: { type: 'integer', description: '返回最近 n 条事件记忆总览（默认取配置 recentOverviewN）' },
    enhance: { type: 'boolean', description: 'true 时启用深度查询增强（调模型整合关联展开与上下文，较慢）' },
    queryHistory: { type: 'integer', description: 'open 时附带的查询记录条数；-1=5，>=0 用该值，缺省按配置（0=不附带）' },
    updateHistory: { type: 'integer', description: 'open 时附带的增量更新记录条数；-1=5，>=0 用该值，缺省按配置（0=不附带）' },
    expandDepth: { type: 'integer', description: 'open 时关联展开层数：-1=按配置，0=不展开，n=n 层' },
  }, [], async (args, meta) => {
    // ① 轮次原文阅读（openTurn）
    if (args.openTurn) {
      const text = await readTurnRef(String(args.openTurn), 32768)
      await logQuery(meta.session, args.openTurn, null)
      return { ok: true, text: '【对话轮次 ' + args.openTurn + '】\n' + text, data: { ref: args.openTurn } }
    }
    // ② 打开指定标题阅读（关联展开 + 历史记录）
    if (args.open) {
      const found = await findImportant(args.open, scopeOwner(meta))
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
    const qOwner = scopeOwner(meta)
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
      const hits = await searchAllMemories(args.keyword, false)
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
  })
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

  // 5. 记忆写入（统一入口）：kind=keyword 重要关键词（同名返回已有）；necessary 必要记忆；event 事件；update 更新；forget 遗忘
  tool('memory_add', '运动记忆·写入：kind=keyword（默认）创建重要关键词记忆——先查同名与近似标题：精确同名返回已有内容（同一实体信息变化→kind=update 更新；不同实体→用更具体标题新建并自动关联既有记忆），近似候选一并列出供判断消歧；kind=necessary 写入每会话必要记忆（随总览注入）；kind=event 创建事件记忆（日期目录，直接写入；带会话@轮次自动并入会话聚合记忆）；kind=update 更新已有关键词记忆（diff+mergeDated+forgetIndexes）；kind=edit 按用户明确确认修改任意记忆文件（默认只读保护，必须 force=true）；kind=forget 主动遗忘移入补充。规则：重要内容先落关键词（kind=keyword），当前活跃里再指向它；更新当前活跃记忆时同步整理 keywords 块（移除已过时/重复的词，加入本轮新主题，keywords 是短词列表 ≤10 个）；无无缘无故的指向——引用必须真实溯源（事件/会话@轮次[:step]/关键词），用户手动操作豁免。', {
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
  }, [], async (args, meta) => {
    const kind = args.kind || 'keyword'
    // ── kind=necessary：每会话必要记忆（覆盖写，随总览注入）──
    if (kind === 'necessary') {
      const path = p(necessaryDir(), meta.session + '.json')
      const nec = (await readJson(path)) || { sessionId: meta.session }
      nec.sessionId = meta.session
      nec.content = args.clear ? '' : String(args.content || '')
      nec.turn = meta.turn
      nec.updatedAt = nowIso()
      nec.history = nec.history || []
      nec.history.push(histEntry('necessary', { ...meta, note: args.clear ? '清空必要记忆' : '写入必要记忆' }))
      await writeJson(path, nec)
      state.necessaryCache.set(meta.session, { content: nec.content, updatedAt: nec.updatedAt })
      return { ok: true, text: args.clear ? '已清空必要记忆' : '必要记忆已写入（第' + meta.turn + '轮），下次请求将随记忆总览注入' }
    }
    // ── kind=event：事件记忆（日期目录，直接写入；带会话@轮次时并入会话聚合）──
    if (kind === 'event') {
      const etitle = String(args.title || '').trim()
      const econtent = String(args.material || args.content || '')
      const ereason = String(args.reason || '')
      const d = new Date()
      const dir = ymPath(d)
      const existing = await listFiles(p(dailyBaseDir(), dir), false)
      const seq = existing.length + 1
      const path = await uniquePath(p(dailyBaseDir(), dir), eventFileName(meta, d, seq))
      const me = { agent: (meta && (meta.agent || meta.session)) || '', session: (meta && meta.session) || '', turn: (meta && meta.turn) || 0 }
      let links = args.links
      let linkWarnings = ''
      if (links && (links.children || links.parents)) {
        const vres = await validateLinks(links)
        links = { children: vres.valid.filter(v => v.side === 'children').map(v => v.link), parents: vres.valid.filter(v => v.side === 'parents').map(v => v.link) }
        if (vres.invalid.length) linkWarnings = '\n\n【关联引用校验】' + vres.invalid.map(x => '· ' + x.side + '：' + x.reason).join('\n') + '\n（无效引用未写入）'
      }
      // 带会话@轮次 → 并入会话聚合文件（与对话跟踪同一文件），并更新当前活跃（同对话跟踪语义）
      const evSid = (meta && meta.session) || ''
      const evTurn = Number((meta && meta.turn) || 0)
      if (evSid && evTurn) {
        const agg = await appendTurnToAggregate(evSid, evTurn, econtent, {
          note: 'memory_add event：' + (etitle || '事件记忆'),
          reason: ereason || 'memory_add event',
          agent: (meta && meta.agent) || 'memory-admin',
        })
        if (agg && agg.ok) {
          await writeActive(evSid, evTurn, {
            ownerKey: (meta && meta.ownerKey) || (meta && meta.agent) || evSid,
            lastMemRef: relOf(agg.path), lastAction: 'memory_event_add', recordDiff: true,
            summarize: false,
            record: {
              op: 'append', key: 'session:' + evSid,
              text: withSourceRef(String(etitle || econtent.split('\n')[0] || '事件记忆').slice(0, 80), evSid, evTurn),
              refs: [{ kind: 'event', title: etitle || '事件记忆', ref: relOf(agg.path) }],
            },
          })
          return { ok: true, text: '事件已并入会话聚合记忆：' + (etitle || '事件 ' + stamp(d)) + '（' + relOf(agg.path) + '）' + linkWarnings, data: { title: etitle, path: relOf(agg.path), aggregate: true } }
        }
        // 并入失败 → 回退独立单事件文件
      }
      const obj = {
        schemaVersion: 1, id: uid(), kind: 'event', location: 'daily', readonly: true,
        title: etitle || ('事件 ' + stamp(d)), reason: ereason, content: econtent,
        links: withActiveParents(links, meta),
        sessionRef: buildSessionRef(me.session, me.turn),
        createdAt: nowIso(), updatedAt: nowIso(), lastAccessedAt: nowIso(),
        createdBy: me, lastModifiedBy: me, originalId: null,
        history: [histEntry('create', { ...meta, note: ereason || '事件记忆' })],
      }
      await writeJson(path, obj)
      await autoLink(obj, meta)
      await touchActive(meta, relOf(path), 'memory_event_add')
      return { ok: true, text: '已创建事件记忆：' + (etitle || '事件 ' + stamp(d)) + '（' + relOf(path) + '）' + linkWarnings, data: { title: etitle, path: relOf(path) } }
    }
    // ── kind=edit：用户明确确认后修改任意记忆文件（默认只读保护，force=true 放行）──
    if (kind === 'edit') {
      const etitle = String(args.title || '').trim()
      if (!etitle) return { ok: false, text: '需要 title' }
      if (!args.force) return { ok: false, text: '编辑受保护记忆需要用户确认：仅当用户明确要求修改该记忆时传 force=true（默认只读保护）' }
      let found = await findKeyword(etitle, scopeOwner(meta))
      let zone = found ? found.zone : ''
      if (!found) {
        // 事件/周期区：按标题精确或内容片段定位（用户确认修改任意记忆）
        for (const f of await listFiles(dailyBaseDir(), true)) {
          const o = await readJson(f.path)
          if (!o || isTombstone(o)) continue
          if (o.title === etitle || (String(o.content || '').indexOf(String(args.content || '').slice(0, 20)) >= 0 && String(args.content || '').length >= 20)) { found = { obj: o, path: f.path }; break }
        }
        if (found) zone = 'daily'
      }
      if (!found) return { ok: false, text: '未找到记忆：' + etitle }
      const obj = found.obj
      if (typeof args.content === 'string' && args.content.trim()) obj.content = args.content
      obj.history = obj.history || []
      obj.history.push(histEntry('update', { ...meta, note: '用户确认强制修改：' + (args.reason || '仅内容修改'), keep: true }))
      obj.updatedAt = nowIso()
      obj.lastModifiedBy = { agent: meta.agent, session: meta.session, turn: meta.turn }
      await writeJson(found.path, obj, true)  // allowReadonly：用户确认放行
      await touchActive(meta, relOf(found.path), 'memory_edit')
      return { ok: true, text: '已按用户确认修改记忆：' + etitle + '（' + zone + ' · ' + relOf(found.path) + '）' }
    }
    // ── kind=update：增量更新已有关键词记忆（diff + mergeDated + forgetIndexes）──
    if (kind === 'update') {
      const found = await findKeyword(args.title, scopeOwner(meta))
      if (!found) return { ok: false, text: '未找到标题：' + args.title + '（可用 kind=keyword 先创建）' }
      if (found.zone === 'archive') return { ok: false, text: '该记忆在补充文件夹（已归档），先 memory restore 捡回再更新' }
      const obj = found.obj
      let delta = []
      const oldContent = obj.content || ''
      if (typeof args.content === 'string') {
        obj.content = args.append ? (oldContent ? oldContent + '\n' + args.content : args.content) : args.content
        delta = diffContent(oldContent, obj.content)
      }
      let mergedVariant = null
      if (args.mergeDated) {
        let best = null
        for (const f of await listFiles(importantDir(), false)) {
          if (!/\d{8}\.json$/.test(f.name)) continue
          const o = await readJson(f.path)
          if (o && !isTombstone(o) && o.title && o.title.startsWith(args.title + '-')) {
            if (!best || parseIso(o.createdAt) > parseIso(best.obj.createdAt)) best = { obj: o, path: f.path }
          }
        }
        if (best) {
          obj.content = (obj.content ? obj.content + '\n' : '') + best.obj.content
          obj.links = obj.links || { parents: [], children: [] }
          obj.links.children.push({ kind: 'keyword', location: 'important', title: best.obj.title })
          mergedVariant = best.obj.title
          await tombstone(best.path, found.path)
        }
      }
      const candidates = (obj.history || [])
        .map((h, i) => ({ h, i }))
        .filter(x => x.h.keep && x.h.delta && x.h.delta.length && deltaOverlap(x.h.delta, delta))
        .slice(-10)
      obj.history = obj.history || []
      obj.history.push(histEntry('update', { ...meta, note: args.reason || '', delta }))
      obj.updatedAt = nowIso()
      obj.lastModifiedBy = { agent: meta.agent, session: meta.session, turn: meta.turn }
      await writeJson(found.path, obj)
      const forgets = []
      if (Array.isArray(args.forgetIndexes) && args.forgetIndexes.length) {
        for (const idx of args.forgetIndexes) {
          const h = obj.history[idx]
          if (!h || h.keep === false) continue
          h.keep = false
          const oldVersion = reconstructAt(obj, parseIso(h.at), parseIso)
          // 归档时带上该记忆的查询记录（按天合并，计分防刷语义一致）
          const queryRecords = (obj.history || []).filter(qh => qh.op === 'query' && qh !== h).map(qh => ({ at: qh.at, session: qh.session, agent: qh.agent, times: Array.isArray(qh.times) ? qh.times : (qh.at ? [qh.at] : []) }))
          const dst = p(archiveDirFor(new Date(h.at)), sanitizeFile(obj.title) + '.json')
          const rep = (await readJson(dst))
          if (rep && !isTombstone(rep)) {
            rep.content = rep.content ? rep.content + '\n---\n' + oldVersion : oldVersion
            rep.queryRecords = (Array.isArray(rep.queryRecords) ? rep.queryRecords : []).concat(queryRecords)
            rep.history.push(histEntry('forget-update', { note: '遗忘更新：原意图不再保留（合并入 ' + obj.title + '）', keep: false }))
            rep.updatedAt = nowIso()
            await writeJson(dst, rep)
          } else {
            await writeJson(dst, {
              schemaVersion: 1, id: uid(), kind: 'keyword', location: 'archive', title: obj.title,
              reason: '遗忘更新：' + (h.note || '原意图不再保留'), content: oldVersion,
              queryRecords,
              links: { parents: [{ kind: 'keyword', location: obj.location, title: obj.title }], children: [] },
              createdAt: h.at, updatedAt: nowIso(), lastAccessedAt: nowIso(),
              createdBy: { agent: h.agent, session: h.session, turn: h.turn }, lastModifiedBy: { agent: meta.agent, session: meta.session, turn: meta.turn },
              originalId: obj.id,
              history: [histEntry('forget-update', { note: '遗忘更新：原意图不再保留，复现自重要记忆 ' + obj.title, keep: false })],
            })
          }
          forgets.push({ index: idx, archivePath: relOf(dst) })
        }
        await writeJson(found.path, obj)
      }
      const lines = ['已更新：' + args.title]
      if (delta.length) lines.push('【文本变更】\n' + deltaSummary(delta))
      if (candidates.length) lines.push('【待判断的历史记录（原意图是否仍保留）】\n' + candidates.map(x => '[' + x.i + '] ' + x.h.at + ' ' + opLabel(x.h.op) + (x.h.note ? ' ' + x.h.note : '') + '\n  ' + deltaSummary(x.h.delta)).join('\n') + '\n若旧意图已不符合新内容，再传 forgetIndexes=[' + candidates.map(x => x.i).join(',') + ']')
      if (mergedVariant) lines.push('已合并日期变体：' + mergedVariant)
      if (forgets.length) lines.push('遗忘更新完成：' + forgets.map(f => '[' + f.index + '] → ' + f.archivePath).join('；'))
      await touchActive(meta, relOf(found.path), 'memory_update', forgets.map(f => ({ title: args.title, ref: f.archivePath })))
      upsertEmbedding(relOf(found.path), args.title, obj.content, 'important').catch(() => {})  // P0-1：语义索引增量更新
      return { ok: true, text: lines.join('\n'), data: { title: args.title, deltaCount: delta.length, candidates: candidates.map(x => x.i), forgets } }
    }
    // ── kind=forget：主动遗忘（重要 → 补充，年/月同名合并）──
    if (kind === 'forget') {
      const found = await findImportant(args.title, scopeOwner(meta))
      if (!found) return { ok: false, text: '重要记忆中未找到：' + args.title + '（仅限本智能体记忆）' }
      const dst = p(archiveDirFor(new Date()), fileNameOf(found.path))
      const existing = await readJson(dst)
      if (existing && !isTombstone(existing)) {
        existing.content = existing.content ? existing.content + '\n---\n' + (found.obj.content || '') : (found.obj.content || '')
        existing.history = existing.history || []
        existing.history.push(histEntry('move', { ...meta, note: '同名合并归档（来自 ' + relOf(found.path) + '）', fromPath: relOf(found.path), toPath: relOf(dst), keep: false }))
        existing.updatedAt = nowIso()
        await writeJson(dst, existing)
        found.obj.history.push(histEntry('move', { ...meta, note: '主动遗忘：合并入补充同名文件', fromPath: relOf(found.path), toPath: relOf(dst), keep: false }))
        await writeJson(found.path, found.obj, true)
        await tombstone(found.path, dst)
        await unmountFromActive(meta && meta.agent, args.title)
        await touchActive(meta, relOf(dst), 'memory_forget', [{ title: args.title, ref: relOf(found.path) }])
        removeEmbedding(relOf(found.path)).catch(() => {})  // P0-1：语义索引移除已遗忘条目
        return { ok: true, text: '已遗忘并合并归档到补充：' + args.title + '（' + relOf(dst) + '）。' }
      }
      found.obj.location = 'archive'
      found.obj.history.push(histEntry('move', { ...meta, note: '主动遗忘：移入补充', fromPath: relOf(found.path), toPath: relOf(dst) }))
      found.obj.updatedAt = nowIso()
      await writeJson(dst, found.obj)
      await tombstone(found.path, dst)
      await unmountFromActive(meta && meta.agent, args.title)
      await touchActive(meta, relOf(dst), 'memory_forget', [{ title: args.title, ref: relOf(found.path) }])
      return { ok: true, text: '已遗忘并移入补充：' + args.title + '（' + relOf(dst) + '）。可用 memory restore 捡回。' }
    }
    // ── keyword（默认）：同名返回已有，否则创建 ──
    const title = String(args.title || '').trim()
    if (!title) return { ok: false, text: '需要 title' }
    let links = args.links
    let linkWarnings = ''
    if (links && (links.children || links.parents)) {
      const vres = await validateLinks(links)
      links = { children: vres.valid.filter(v => v.side === 'children').map(v => v.link), parents: vres.valid.filter(v => v.side === 'parents').map(v => v.link) }
      if (vres.invalid.length) linkWarnings = '\n\n【关联引用校验】' + vres.invalid.map(x => '· ' + x.side + '：' + x.reason).join('\n') + '\n（无效引用未写入）'
    }
    const existing = await findImportant(title)
    if (existing) {
      return { ok: true, text: '已存在同名记忆，返回已有：\n标题：' + existing.obj.title + '\n内容：' + (existing.obj.content || '').slice(0, 300) + '\n（同一实体信息变化请用 kind=update 更新；若是不同实体，请用更具体标题新建并自动关联既有记忆）' + linkWarnings, data: { duplicate: true, existing: { title: existing.obj.title, content: existing.obj.content }, path: relOf(existing.path) } }
    }
    // 近似标题候选：供判断"同主题不同实体"与消歧（写入分流）
    const similar = await findSimilarTitles(title, scopeOwner(meta), 1)
    if (similar.length) {
      linkWarnings += '\n\n【近似标题候选】' + similar.map(s => s.title + (s.shared >= 3 ? '（包含）' : '（共享' + s.shared + '词）')).join('；') + '\n（同一实体请 kind=update 更新；不同实体建议用更具体标题新建，将自动关联最强候选）'
    }
    // P0-2：LLM 消歧判定（可选，默认关）——有近似候选时让模型判断"同一实体/不同实体/不确定"
    // 模型判定 same → 直接建议 kind=update（不新建）；different/ambiguous/失败 → 走下方机械流程
    if (similar.length) {
      const dj = cfg().dedupJudge
      if (dj && dj.enabled) {
        const verdict = await dedupJudgeVerdict(title, String(args.content || ''), similar, meta)
        if (verdict) {
          if (verdict.relation === 'same' && verdict.target) {
            return { ok: true, text: 'LLM 消歧判定：与「' + verdict.target + '」是同一实体' + (verdict.reason ? '（' + verdict.reason + '）' : '') + '\n建议用 kind=update title="' + verdict.target + '" 更新该记忆（含新内容），不要新建。' + linkWarnings, data: { duplicate: true, judge: 'same', target: verdict.target, existing: { title: verdict.target } } }
          }
          if (verdict.relation === 'different') {
            linkWarnings += '\n\n【LLM 消歧判定】与候选不是同一实体' + (verdict.reason ? '：' + verdict.reason : '') + '，将新建并自动关联最强候选。'
          } else {
            linkWarnings += '\n\n【LLM 消歧判定】无法确定' + (verdict.reason ? '：' + verdict.reason : '') + '，请参考【近似标题候选】自行判断。'
          }
        }
      }
    }
    // 消歧关联：新建时若存在强近似（包含关系或共享≥2词），自动关联最强候选（"下次扫描查询时看到两者相关"）
    const strong = similar.filter(s => s.shared >= 2)
    if (strong.length) {
      links = links || { parents: [], children: [] }
      links.children = (links.children || []).concat([{ kind: 'keyword', location: 'important', title: strong[0].title }])
    }
    const path = await uniquePath(importantDir(), sanitizeFile(title) + '.json')
    const obj = newKeywordObj(title, String(args.content || ''), args.reason || '', meta, links)
    await writeJson(path, obj)
    await autoLink(obj, meta)
    await touchActive(meta, relOf(path), 'memory_add', undefined, [title])
    upsertEmbedding(relOf(path), title, String(args.content || ''), 'important').catch(() => {})  // P0-1：语义索引增量
    return { ok: true, text: '已创建重要记忆：' + title + '（' + relOf(path) + '）' + linkWarnings, data: { title, path: relOf(path) } }
  })
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

  // ── 隔离（共享函数）────────────────────────────────────────────────────
  async function runIsolation(args, meta) {
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
    for (const f of await listFiles(dailyBaseDir(), true)) {
      const rel = relOf(f.path)
      if (/^必要\//.test(rel)) continue
      const o = await readJson(f.path)
      if (!o || isTombstone(o)) continue
      const created = parseIso(o.createdAt)
      const last = lastOpTime(o)
      if (last > tMs || created > tMs) files.push({ rel, created, last, op: lastOp(o), createdAfter: created > tMs })
    }
    if (!files.length) return { ok: true, text: '目标时间 ' + isoStr(tMs) + ' 之后没有任何操作记录，无需隔离' }
    const id = stamp()
    const dir = p(isolationDir(), id)
    const mirror = p(dir, 'mirror')
    for (const f of files) {
      const src = p(root(), f.rel)
      const raw = await readJson(src)
      if (raw !== undefined) await writeJson(p(mirror, f.rel), raw)
    }
    const incident = {
      id, at: nowIso(), targetTime: isoStr(tMs),
      durationText,
      files: files.map(f => ({ rel: f.rel, createdAt: isoStr(f.created), lastOpAt: isoStr(f.last), op: f.op ? f.op.op : null, createdAfter: f.createdAfter })),
      restoredAt: null, clearedAt: null, session: meta.session,
    }
    await writeJson(p(dir, 'incident.json'), incident)
    state.incidents.set(id, incident)
    const preview = files.slice(0, 50)
    return {
      ok: true,
      text: '记忆隔离已触发：事件 ' + id + '，目标时间 ' + incident.targetTime + '（' + durationText + '），受影响 ' + files.length + ' 个文件（污染态已复制到 ' + relOf(mirror) + '）。\n' + preview.map(f => (f.createdAfter ? '[T之后新建] ' : '[受影响] ') + f.rel + '（最后操作 ' + f.lastOpAt + '）').join('\n') + (files.length > 50 ? '\n…共 ' + files.length + ' 个' : '') + '\n\n确认无误后调用 memory（cmd=isolation_restore id=' + id + '）回滚；不需要则 memory（cmd=isolation_clear id=' + id + '）。',
      data: { id, targetTime: incident.targetTime, fileCount: files.length, files: incident.files },
    }
  }

  // 11. 隔离（阶段1：快照+预览+通知）
  async function memCmdIsolation(args, meta) { return runIsolation(args, meta) }

  // 12. 隔离回滚（阶段2）
  async function memCmdIsolationRestore(args, meta) {
    const inc = state.incidents.get(args.id)
    if (!inc) return { ok: false, text: '未找到隔离事件：' + args.id + '（memory（cmd=status）可查看）' }
    if (inc.restoredAt) return { ok: false, text: '该事件已回滚（' + inc.restoredAt + '）' }
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
        o.history.push(histEntry('restore', { ...meta, note: '隔离回滚至 ' + inc.targetTime + '（事件 ' + inc.id + '）' }))
        o.updatedAt = nowIso()
        o.lastModifiedBy = { agent: meta.agent, session: meta.session, turn: meta.turn }
      }
      if (st.path !== src) {
        await writeJson(st.path, o, true) // 隔离恢复：允许写 readonly 溯源文件（回滚污染态）
        await tombstone(src, st.path)
      } else if (changed) {
        await writeJson(src, o, true)
      }
      restored++
    }
    inc.restoredAt = nowIso()
    await writeJson(p(isolationDir(), inc.id, 'incident.json'), inc)
    return { ok: true, text: '已回滚事件 ' + inc.id + ' 至 ' + inc.targetTime + '：恢复 ' + restored + ' 个文件，T 之后新建 ' + quarantined + ' 个文件已移入 _审阅。审阅确认污染排除后 memory isolation_clear id=' + inc.id + '。' }
  }

  // 13. 解除隔离
  async function memCmdIsolationClear(args, meta) {
    const inc = state.incidents.get(args.id)
    if (!inc) return { ok: false, text: '未找到隔离事件：' + args.id }
    inc.clearedAt = nowIso()
    await writeJson(p(isolationDir(), inc.id, 'incident.json'), inc)
    return { ok: true, text: '已解除隔离通知：' + args.id + '。隔离文件夹 ' + relOf(p(isolationDir(), inc.id)) + ' 的内容保留待人工清理（fs 无删除能力）。' }
  }

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
    const keys = ['enabled', 'inject', 'injectLimitBytes', 'root', 'recentOverviewN', 'cascadeDepth', 'archiveDays', 'queryHistoryN', 'updateHistoryN', 'historyPageSize', 'queryOtherAgents', 'decayDays', 'activeNotify', 'activeNoModelSummarize', 'summaryInjectChars', 'summaryCharsK']
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
  // ═════════════════════════════════════════════════════════════════════
  // 阶段0：记忆管理员 — token 估算 / prompt / LLM 调用 / 分块压缩引擎 / 查看
  // ═════════════════════════════════════════════════════════════════════

  // ── admin 配置（并入 config.json 的 admin 字段，缺省值在此）───────────
  function adminCfg() {
    const c = cfg()
    if (!c.admin) c.admin = {}
    return c.admin
  }

  // ── 模型配置结构体（UE 结构体继承语义）：全局 admin.model(provider/model) +
  // admin 顶层参数(contextTokens/summaryPercent/outputTokens/concurrency/extraJson)
  // 构成「默认实例」；子功能（track/enhance/period）的 model 是子实例：
  // 字段未定义 → 继承全局；已定义 → 覆盖（extraJson/concurrency 激活即整体覆盖）。
  function resolveModelConfig(sub) {
    const g = adminCfg()
    const gModel = g.model || {}
    const s = (sub && typeof sub === 'object') ? sub : {}
    const pick = (key, conv) => {
      const v = s[key] !== undefined && s[key] !== null ? s[key] : g[key]
      return (v === undefined || v === null) ? undefined : (conv ? conv(v) : v)
    }
    // extraJson 规范化：字符串 JSON → 对象（兼容历史配置存字符串）；非法/空 → undefined
    const pickExtraJson = () => {
      let v = pick('extraJson')
      if (v === undefined || v === null) return undefined
      if (typeof v === 'string') { try { v = JSON.parse(v) } catch (e) { return undefined } }
      return (v && typeof v === 'object') ? v : undefined
    }
    return {
      provider: (s.provider === '__none__') ? '' : ((s.provider !== undefined && s.provider !== '') ? String(s.provider) : (gModel.provider || '')),
      model: (s.provider === '__none__') ? '' : ((s.model !== undefined && s.model !== '') ? String(s.model) : (gModel.model || '')),
      contextTokens: pick('contextTokens', Number),
      summaryPercent: pick('summaryPercent', Number),
      outputTokens: pick('outputTokens', Number),
      concurrency: pick('concurrency', Number),
      allowThinking: pick('allowThinking') === undefined ? false : !!pick('allowThinking'),
      extraJson: pickExtraJson(),
    }
  }
  // ═════════════════════════════════════════════════════════════════════
  // 统一模型工作调度器：按工作类型独立 FIFO 排队 + 并发池。
  //   track  = 对话跟踪（热路径，并发 = admin.summaryConcurrency，0=按顺序执行）
  //   period = 周期总结   enhance = 强化搜索   admin = 整理/重审/手动压缩
  // period/enhance/admin 并发固定 1（互不抢占也互不阻塞，避免并发请求数翻倍）。
  // 队列不设硬上限：超出高水位（SUMMARY_WATERMARK，默认 50）的任务不丢弃：
  //   ① 记忆管理员已配模型 → 直接移交给管理员队列处理（不占 track 并发位）；
  //   ② 管理员没配模型 → 溢出落盘缓存 _admin/pending/<type>/，队列空闲时拾起续跑。
  // 拾起时统一回到内存队列，受并发控制；同进程等待方会收到结果，跨重启可恢复。
  // 去重/间隔检查在入队前完成（不占队）。
  // ═════════════════════════════════════════════════════════════════════
  const SUMMARY_WATERMARK = 50
  const SUMMARY_TIMEOUT_MS = 180000
  const typeStates = {}   // type -> { wait: [], workers: 0 }
  const spilledWaiters = {} // type -> [ { resolve, file } ]（同进程等待缓存任务结果的调用方）
  const drainLocks = {}   // type -> boolean（防并发扫描同一缓存目录）
  // 并发数：track 读 admin.summaryConcurrency，0/缺省 = 1（按顺序执行，防本地小模型排队乱序）
  function queueConcurrencyOf(type) {
    if (type !== 'track') return 1
    const c = Number(adminCfg().summaryConcurrency) || 0
    return c > 0 ? c : 1
  }
  function adminHasModel() {
    const a = adminCfg().model || {}
    return !!(a && a.provider && a.model)
  }
  function pendingDirOf(type) { return p(root(), '_admin', 'pending', type) }
  function scheduleWork(type, taskFn, label, spill) {
    const st = typeStates[type] || (typeStates[type] = { wait: [], workers: 0 })
    // 超过高水位 → 溢出（spill 提供可序列化重建参数；仅 track 等高频类型提供）
    if (spill && st.wait.length + st.workers >= SUMMARY_WATERMARK) {
      return spillTask(type, taskFn, spill, label)
    }
    return new Promise((resolve) => {
      st.wait.push({ taskFn, label, resolve })
      pumpWork(type)
    })
  }
  function pumpWork(type) {
    const st = typeStates[type]
    if (!st) return
    const concurrency = queueConcurrencyOf(type)
    while (st.wait.length && st.workers < concurrency) {
      const job = st.wait.shift()
      st.workers++
      runWorkJob(type, job).finally(() => { st.workers--; pumpWork(type) })
    }
    // 队列空闲时拾起溢出缓存任务（回到内存队列，受并发控制）
    if (!st.wait.length && st.workers < concurrency) drainSpilled(type)
  }
  async function runWorkJob(type, job) {
    try {
      const result = await Promise.race([
        job.taskFn(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('模型任务超时（' + Math.round(SUMMARY_TIMEOUT_MS / 1000) + 's）')), SUMMARY_TIMEOUT_MS)),
      ])
      job.resolve(result)
      return result
    } catch (e) {
      console.error('[motion-memory] ' + (job.label || type) + ' 任务异常: ' + (e && e.message))
      const r = { ok: false, text: '任务异常：' + ((e && e.message) || e) }
      job.resolve(r)
      return r
    }
  }
  // ── 溢出处理：优先移交给记忆管理员；无管理员模型则落盘缓存 ──
  async function spillTask(type, taskFn, spill, label) {
    try {
      const obj = Object.assign({ type, label, at: nowIso() }, spill)
      const dir = pendingDirOf(type)
      const file = p(dir, 'pending-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.json')
      // ① 记忆管理员已配模型 → 立即移交管理员队列（先落盘兜底、重建后删除缓存防重复拾起）
      if (type === 'track' && adminHasModel()) {
        await writeJson(file, obj)
        const rebuilt = await rebuildSpilledTask(type, obj)
        if (!rebuilt) { await tombstone(file, file); return { ok: false, text: '溢出任务重建失败（' + label + '）' } }
        await tombstone(file, file) // 已移交，删除缓存凭证
        return scheduleWork('admin', rebuilt, label + '（移交管理员）', null)
      }
      // ② 管理员没配模型 → 正常落盘缓存，等队列空闲拾起
      await writeJson(file, obj)
      if (!spilledWaiters[type]) spilledWaiters[type] = []
      return new Promise((resolve) => {
        spilledWaiters[type].push({ resolve, file, label })
        pumpWork(type)
      })
    } catch (e) {
      // 落盘失败（磁盘/沙箱异常）→ 退回内存排队，保证任务不丢
      console.error('[motion-memory] 溢出落盘失败（退回内存排队）：' + (e && e.message))
      return scheduleWork(type, taskFn, label, null)
    }
  }
  // 扫描 _admin/pending/<type>/：拾起缓存 → claim（删除缓存）→ 重新入队受并发控制
  async function drainSpilled(type) {
    if (drainLocks[type]) return
    drainLocks[type] = true
    try {
      const files = await listFiles(pendingDirOf(type), false)
      const st = typeStates[type] || (typeStates[type] = { wait: [], workers: 0 })
      for (const f of files) {
        if (!String(f.name).endsWith('.json')) continue
        const o = await readJson(f.path)
        if (!o || isTombstone(o) || o.type !== type) continue
        const rebuilt = await rebuildSpilledTask(type, o)
        if (!rebuilt) { await tombstone(f.path, f.path); continue } // 幂等已满足/无法重建 → 丢弃缓存
        // 匹配同进程等待方（按文件路径）
        const waiters = spilledWaiters[type] || []
        let waiter = null
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].file === f.path) { waiter = waiters.splice(i, 1)[0]; break }
        }
        await tombstone(f.path, f.path) // claim：缓存凭证移交内存队列，防重复拾起
        st.wait.push({
          taskFn: rebuilt,
          label: o.label || ('溢出任务·' + type),
          resolve: function (r) { if (waiter) { try { waiter.resolve(r) } catch (e) {} } },
        })
      }
      if (files.length) pumpWork(type)
    } catch (e) {
      console.error('[motion-memory] 溢出缓存拾起失败：' + (e && e.message))
    } finally { drainLocks[type] = false }
  }
  // 各类型溢出任务重建：返回可执行任务函数；无法重建（幂等已满足等）返回 null
  async function rebuildSpilledTask(type, o) {
    if (type === 'track') {
      const sid = o.sid, turn = Number(o.turn) || 0
      if (!sid || !turn) return null
      // 拾起时幂等复查：该轮已被总结则丢弃缓存
      if (await hasTrackSummary(sid, turn)) return null
      const tc = trackCfg()
      const gap = Math.max(0, Number(tc.interval) || 0)
      const meta = o.meta || { agent: 'memory-admin', session: sid, turn }
      return () => runTurnSummaryTask(sid, turn, meta, gap)
    }
    return null
  }
  // 定时安全兜底：周期检查时把遗留的溢出缓存也拾起执行（跨重启恢复）
  async function sweepSpilledQueues() {
    for (const type of ['track', 'period', 'enhance', 'admin']) {
      const st = typeStates[type]
      if (st && st.wait.length) continue
      await drainSpilled(type).catch(() => {})
    }
  }

  // ── 管理员工作上下文（v4 #3）：装在上下文最前面，占用 summaryPercent 预算 ──
  // 读 active.json（全局）+ 各智能体活跃文件摘要，供记忆管理员（周期总结等）理解全局
  async function adminContextText(capTokens) {
    try {
      const cap = Math.max(256, Number(capTokens) || 1024)
      const idx = await readJson(activeIndexPath())
      const lines = ['【记忆管理员全局上下文】']
      if (idx && (idx.recentPeriods || []).length) lines.push('最近周期：' + idx.recentPeriods.map(r => r.split('/').pop()).join('、'))
      if (idx && (idx.agents || []).length) {
        lines.push('智能体活跃：' + idx.agents.slice(0, 10).map(a => a.agent + (a.summary ? '：' + a.summary.slice(0, 60) : '')).join('；'))
      }
      if (idx && (idx.refs || []).length) {
        const kw = (idx.refs || []).filter(r => r.kind === 'keyword').slice(0, 15)
        if (kw.length) lines.push('关键词：' + kw.map(r => r.title).join('、'))
      }
      const text = lines.join('\n')
      return text.length > cap * 2 ? text.slice(0, cap * 2) : text  // 粗略按字符上限
    } catch (e) { return '' }
  }

  // v5 周期总结联动①：压缩当前活跃（各智能体记录链/works）→ 状态素材
  // 读取 当前活跃/ 下所有 v3/v4 活跃文件，取记录链每条文本前 80 字 + 指向，拼成"当前状态"段落
  async function activeRecordsContextText() {
    try {
      const lines = ['【当前活跃记录链】']
      const acts = []
      for (const f of await listFiles(activeDir(), false)) {
        if (f.name === 'active.json' || !f.name.endsWith('.json')) continue
        const o = await readJson(f.path)
        if (!o || isTombstone(o) || !o.agent) continue
        // v4=works / v3=records 统一取"每条记录文本"
        const items = Array.isArray(o.works) ? o.works : (Array.isArray(o.records) ? o.records : [])
        acts.push({ agent: o.agent, items })
      }
      if (!acts.length) return ''
      for (const a of acts) {
        const recs = a.items.slice(0, 5)
        if (!recs.length) continue
        lines.push(a.agent + '：' + recs.map(r => String(r.text || '').slice(0, 80)).join('；'))
      }
      return lines.join('\n')
    } catch (e) { return '' }
  }

  // ── token 估算（estimateTokens 已拆至 ../motion-memory-modules/chunker.mjs）──

  // ── 管理员 LLM 调用（单次文本生成，带容错降级 + 工具格式降级通道）─────
  // 读 DSH settings.yaml 里 llm-pi-ai.providers.<provider>.baseURL（正则提取，免完整 YAML 解析）
  function piAiBaseUrlOf(provider) {
    try {
      const home = dshHome()
      if (!home) return ''
      const f = p(home, 'settings.yaml')
      if (!existsSync(f)) return ''
      const text = readFileSync(f, 'utf8')
      const m = text.match(new RegExp('llm-pi-ai:[\\s\\S]*?' + provider + ':[\\s\\S]*?baseURL:\\s*([^,\\s]+)'))
      return m ? String(m[1]).replace(/['"]/g, '') : ''
    } catch (e) { return '' }
  }
  // 思考型小模型直连：LM Studio 冷启动思考默认开，pi-ai 无法发 enable_thinking:false。
  // 对 lmstudio + 非思考场景，直接用原生 fetch 调 /chat/completions。
  // extraJson 作为请求体附加字段透传给 LM Studio——高级设置 JSON 里写 {"enable_thinking": false} 即可组装进请求。
  async function adminLlmDirect(provider, model, messages, outCap, apiKey, extraJson) {
    const base = piAiBaseUrlOf(provider)
    if (!base) return null
    const wire = messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: (m.content && m.content.map ? m.content.map(c => c.text || '').join('\n') : String(m.content || '')) }))
    const body = {
      model,
      messages: wire,
      max_tokens: outCap,
      stream: false,
      enable_thinking: false,   // 默认显式关思考；extraJson 可覆盖（如 {"enable_thinking": true}）
    }
    // extraJson 透传：高级设置 JSON 的字段直接进 LM Studio 请求体
    if (extraJson && typeof extraJson === 'object') {
      try { Object.assign(body, JSON.parse(JSON.stringify(extraJson))) } catch (e) {}
    }
    const headers = { 'content-type': 'application/json' }
    if (apiKey) headers.authorization = 'Bearer ' + apiKey
    const res = await fetch(base.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error('lmstudio HTTP ' + res.status + (errText ? ': ' + errText.slice(0, 200) : ''))
    }
    const data = await res.json()
    const choice = data && data.choices && data.choices[0]
    const content = choice && choice.message && choice.message.content
    // 思考失控检测：text 空且 finish=length（思考烧满 token）→ 报错提示（不空等）
    if (!String(content || '').trim() && choice && choice.finish_reason === 'length') {
      const reasoning = (choice.message && (choice.message.reasoning_content || choice.message.reasoning)) || ''
      throw new Error('思考失控：模型只输出思考未产出答案（' + (data.usage ? data.usage.completion_tokens + ' tokens' : '') + (reasoning ? '，思考 ' + reasoning.length + ' 字' : '') + '）。请在 LM Studio 关闭该模型思考，或换非思考模型')
    }
    return String(content || '').trim()
  }
  // opts: { provider, model, contextTokens, percent, outputTokens, extraJson }
  // 返回 { ok, text, attempt }；上下文超限按 90%→80%→70% 递减重试
  // 批2：模型能力差时（输出非 JSON），追加"工具格式"指令重试——模型可输出
  //       {"tool":"memory_noop"} 表示无更新，或 {"tool":"memory_add","args":{...}}
  //       等工具调用格式，下一回应作为工具输入执行。
  async function adminLlm(promptText, opts, maxRetries) {
    const retries = Math.max(0, maxRetries === undefined ? 3 : maxRetries)
    const ctxCap = Math.max(1024, Number(opts.contextTokens) || 128000)
    const pct = Math.min(90, Math.max(5, Number(opts.percent) || 50))
    const baseBudget = Math.floor(ctxCap * pct / 100)
    // 输出上限：显式 outputTokens 优先；未配置则用剩余预算（100% − summaryPercent），但 cap 4096（小模型 max output 有限，过大报错）
    const outCap = Math.max(256, Number(opts.outputTokens) || Math.min(4096, Math.floor(ctxCap * (100 - pct) / 100)))
    const promptTokens = estimateTokens(promptText, (opts.langTokens))
    let attempt = 0
    let lastErr = ''
    // 尝试序列：目标 100% → 90% → 80% → 70% → 失败
    const ratios = [1, 0.9, 0.8, 0.7]
    const maxAttempts = Math.min(1 + retries, ratios.length)
    for (let i = 0; i < maxAttempts; i++) {
      const budget = Math.floor(baseBudget * ratios[i])
      if (promptTokens + outCap > budget) {
        attempt = i + 1
        lastErr = '上下文预算不足：输入约 ' + promptTokens + ' tokens，预算 ' + budget + '（' + (pct * ratios[i]).toFixed(0) + '%）'
        continue
      }
      try {
        // 批2：最后一次尝试追加工具格式降级指令（模型能力差时的兜底）
        let finalPrompt = promptText
        if (i === maxAttempts - 1) {
          finalPrompt = promptText + '\n\n【降级指令】如果无法按上述 JSON 格式总结，改为只输出一个工具调用：\n' +
            '- 判定无更新 → 输出 {"tool":"memory_noop"}\n' +
            '- 有记忆要写 → 输出 {"tool":"memory_add","args":{"title":"...","content":"...","reason":"..."}} 或 {"tool":"memory_event_add","args":{...}}\n' +
            '只输出这个 JSON 工具调用对象，不要任何其他文字。'
        }
        const messages = [{ id: 'mm-admin-' + uid(), role: 'user', content: [{ type: 'text', text: finalPrompt }], source: { kind: 'plugin', plugin: 'motion-memory' } }]
        let text = ''
        // 批4：extraJson 合并进模型调用参数（temperature/top_p 等自定义配置）
        const streamOpts = { provider: opts.provider, model: opts.model, messages, maxTokens: outCap }
        // 思考控制：LM Studio 冷启动思考默认开且 pi-ai 无法发 enable_thinking:false（qwen 分支只发 true；
        // thinking.type disabled 不被 LM Studio 接受；extraJson 不透传）。对 lmstudio + 非思考场景直连。
        const useDirect = opts.provider === 'lmstudio' && !opts.allowThinking
        if (opts.extraJson && typeof opts.extraJson === 'object') {
          try { Object.assign(streamOpts, JSON.parse(JSON.stringify(opts.extraJson))) } catch (e) {}
        }
        // 只收 text-delta（最终答案）。思考型模型（qwen3.5-9b）经通用通道会把思考草稿
        // 混进 text——记忆总结应换非思考模型；text 空视为失败，绝不用 reasoning 草稿当结果
        if (useDirect) {
          const direct = await adminLlmDirect(opts.provider, opts.model, messages, outCap, undefined, opts.extraJson)
          if (direct) text = direct
          else lastErr = 'lmstudio 直连失败'
        } else {
          for await (const chunk of llm.stream(streamOpts)) {
            if (chunk.type === 'text-delta') text += chunk.text
            else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') text += chunk.block.text
          }
        }
        const trimmed = text.trim()
        if (!trimmed) { lastErr = '模型输出为空'; continue }
        return { ok: true, text: trimmed, attempt: i + 1 }
      } catch (e) {
        attempt = i + 1
        lastErr = (e && e.message) || String(e)
        // 若错误明显与上下文无关（如鉴权失败），不降级直接失败
        const msg = String(lastErr)
        if (!/context|token|length|limit|max|预算/i.test(msg)) break
      }
    }
    return { ok: false, text: '', attempt, error: lastErr }
  }

  // 批2：解析"工具格式"降级输出——{tool: memory_noop | memory_add | memory_event_add | ..., args: {...}}
  // 返回 { tool, args } 或 null（非工具格式）
  function parseToolFormatOutput(text) {
    if (!text) return null
    let t = String(text).trim()
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    try {
      const o = JSON.parse(t)
      if (o && typeof o === 'object' && typeof o.tool === 'string') {
        const args = (o.args && typeof o.args === 'object') ? o.args : {}
        if (o.tool === 'memory_noop' || o.tool === 'memory_add' || o.tool === 'memory_event_add' || o.tool === 'memory_necessary' || o.tool === 'memory_update') {
          return { tool: o.tool, args }
        }
      }
    } catch (e) {}
    // 宽松匹配：文本里含 "tool":"memory_noop" 等
    const m = t.match(/"tool"\s*:\s*"(memory_\w+)"/)
    if (m) return { tool: m[1], args: {} }
    return null
  }

  // ── 管理员 prompt 模板（身份 + 价值判断 + 分块压缩指令 + JSON 输出契约）──
  function adminPrompt(refPrecision) {
    const stepNote = refPrecision === 'step'
      ? '必须准确到步：每条 sourceChain 用 会话id@轮次:stepN 或 stepN-M（如 session-abc@12:step3-5）'
      : '用 会话id@轮次（整轮指向即可，不需要细分到步）'
    return [
      '你是「记忆管理员」，负责判断对话/素材是否有长期记忆价值，并把值得的压缩成高质量、可溯源的运动记忆。',
      '输出必须严格是单个 JSON 对象，不要输出任何其他文字：',
      '{"compress": true|false, "reason": "一句话说明", "content": "压缩后的记忆正文", "op": "prepend|append|merge|replace", "lessons": [{"title": "标题", "content": "教训内容"}], "sourceChain": ["溯源引用"]}',
      '规则：',
      '1. 先判断价值：可复用的结论/用户偏好/项目约束/流程方法/踩坑教训 → compress=true；临时性、重复性、无信息量、纯寒暄 → compress=false（reason 说明理由，content 可为空）。',
      '2. compress=true 时压缩保留：结论、关键事实、流程、数字、教训；丢弃修辞和重复展开。',
      '3. content 要求 2k token 内完成，简洁为主，不要过长信息描述。',
      '4. lessons 是总结中发现的最有价值的工具使用教训或经验（踩坑/高效做法），没有则为空数组——这对用户最有用，务必认真提取。',
      '5. sourceChain 逐条记录内容来源（' + stepNote + '）。',
      '5.5 content 正文每个要点段落末尾附 [该要点的真实短标题](会话id@轮次[:stepN]) md 链接引用（不是 sourceChain 语法），保证正文可点击溯源。链接文字必须是能直接说明要点内容的短标题（3~12 字，如 [周期总结新增方案3]、[会话工作按会话分段]），界面显示的就是链接文字——禁止使用"要点短名""工作要点""新进展"等无信息量占位文字，否则读者看不出每个链接指向什么。更新"会话工作"记录链时尤其要带指向：首次 [首条工作要点](触发轮次)，增量追加 [新进展要点](触发轮次) 且保留旧指向，完成整理 [整合后的要点](触发轮次)。',
      '6. 总结要简明高效，直接给出要点，不需要过长冗余的展开。',
      '7. op 决定本轮进展如何更新当前活跃记忆的"会话工作"段落（若输入中提供了【本会话现有工作信息】则必须参考它判断）：',
      '   - 全新工作/新窗口 → "prepend"（插到最前，旧的往后顶）；',
      '   - 同一件事继续做、补充新进展 → "append"（整合：基于【本会话现有工作信息】+ 本轮新进展输出**完整整合后的新段落**，多个指向按时间顺序保留；不要无限制拼接堆叠）；',
      '   - **增量是信息整合不是累加**：同主题始终整合成一条——首轮 [xx更新a内容](轮次N)，后续 [xx更新a]、[b内容](轮次N+1)，再后续 [xx更新a]、[b]、[c内容，修复a](轮次N+2)；内容优化整合时 [xx更新且优化a、b、c](轮次N+3)，旧内容中**重要教训/关键决策的指向保留在末尾**，不重要的移除；',
      '   - 同一件事收束、需整合 → "merge"（合并旧内容与进展，保留仍有效的部分）；',
      '   - 需求变更、旧内容已过时 → "replace"（用新内容覆盖，旧版自动进 history）；',
      '   - 仅当内容未变或无需更新时省略 op。',
      '   - 无无缘无故的指向：每条记录必须带真实溯源（事件/会话@轮次[:step]/关键词）；用户手动操作豁免；',
      '   - 重要内容先落关键词记忆，当前活跃里再指向它。',
      '8. 字数限制：注入的【本会话现有工作信息】受"总结摘要字数"（k token）限制，**md 格式的引用指向超链接不计入字数**；若注入内容注明"仅注入前 Nk token"，以链接指向的原文为准。你的输出受输出上限（outputTokens）约束——这是硬上限，到达即截断；在限制内应完整表达，不要为凑字数堆叠。',
    ].join('\n')
  }

  // 解析管理员输出 JSON（容错：剥离围栏 / 前后杂文 / 重复输出 / 字符串内未转义括号）
  // 策略：1) 整段严格解析；2) 提取所有 {...} 候选（括号深度归零点）逐个尝试；
  //       3) 尝试移除重复输出后的拼接。模型可能输出两遍 JSON 或含未转义字符。
function parseAdminJson(text) {
    if (!text) return null
    let t = String(text).trim()
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    // 1) 整段尝试
    const tryParse = (s) => {
      try {
        const o = JSON.parse(s)
        if (o && typeof o === 'object') return o
      } catch (e) {}
      return null
    }
    const whole = tryParse(t)
    if (whole) return whole
    // 2) 提取所有可能的 JSON 对象
    const start = t.indexOf('{')
    if (start < 0) return null
    const candidates = []
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < t.length; i++) {
      const ch = t[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) candidates.push(t.slice(start, i + 1))
      }
    }
    // 3) 逐个尝试
    for (const cand of candidates) {
      const o = tryParse(cand)
      if (o) return o
    }
    // 4) 字段级容错提取
    const grab = (key) => {
      const re = new RegExp('"' + key + '"\\s*:\\s*"([\\s\\S]*?)"(?=,|})')
      const m = t.match(re)
      return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : undefined
    }
    const compressRaw = t.match(/"compress"\s*:\s*(true|false)/)
    const out = {}
    if (compressRaw) out.compress = compressRaw[1] === 'true'
    const reason = grab('reason')
    if (reason !== undefined) out.reason = reason
    const content = grab('content')
    if (content !== undefined) out.content = content
    const lessonsM = t.match(/"lessons"\s*:\s*(\[[\s\S]*?\])/)
    if (lessonsM) {
      try {
        const arr = JSON.parse(lessonsM[1].replace(/,\s*\]/g, ']'))
        if (Array.isArray(arr)) out.lessons = arr
      } catch (e) {}
    }
    const chainM = t.match(/"sourceChain"\s*:\s*(\[[\s\S]*?\])/)
    if (chainM) {
      try {
        const arr = JSON.parse(chainM[1].replace(/,\s*\]/g, ']'))
        if (Array.isArray(arr)) out.sourceChain = arr
      } catch (e) {}
    }
    if (compressRaw || content !== undefined || reason !== undefined) return out
    return null
  }

  // ── 批次/分块工具（batchDigest/blockBudget/chunkItemsByBudget/splitItemBySentences
  //     已拆至 ../motion-memory-modules/chunker.mjs）──────────────────────
  function adminFailDir() { return p(root(), '_admin', '_failures') }
  // 单块压缩（调用管理员模型）
  async function summarizeChunk(chunkItems, opts, meta, sourceLabel) {
    const inputText = chunkItems.map(it => '【' + (it.id || '') + '】\n' + (it.text || '')).join('\n\n')
    const refPrecision = (meta && meta.refPrecision) || ''
    const prompt = adminPrompt(refPrecision) + '\n\n来源标注：' + (sourceLabel || '') + '\n\n待压缩内容：\n' + inputText
    const res = await adminLlm(prompt, opts, 3)
    if (!res.ok) return { ok: false, error: res.error }
    const parsed = parseAdminJson(res.text)
    if (!parsed) {
      // 批2：管理员输出无法解析 → 尝试工具格式降级（memory_noop / memory_add 等）
      const toolOut = parseToolFormatOutput(res.text)
      if (toolOut && toolOut.tool === 'memory_noop') {
        // 无更新：返回 compress=false 语义，调用方判定无需总结
        return { ok: true, parsed: { compress: false, reason: 'memory_noop：判定无更新', content: '', lessons: [], sourceChain: [] }, text: res.text, attempt: res.attempt, itemIds: chunkItems.map(it => it.id), degraded: true, toolOut }
      }
      if (toolOut && toolOut.args && (toolOut.tool === 'memory_add' || toolOut.tool === 'memory_event_add' || toolOut.tool === 'memory_necessary' || toolOut.tool === 'memory_update')) {
        // 工具格式：尝试执行（降级通道）——用当前会话上下文执行该工具
        return { ok: true, parsed: { compress: true, content: '', lessons: [], sourceChain: [] }, text: res.text, attempt: res.attempt, itemIds: chunkItems.map(it => it.id), degraded: true, toolOut }
      }
      return { ok: false, error: '管理员输出无法解析为 JSON：' + res.text.slice(0, 200) }
    }
    return {
      ok: true,
      parsed,
      text: res.text,
      attempt: res.attempt,
      itemIds: chunkItems.map(it => it.id),
    }
  }
  // 中间结果落盘：_partial/{batchId}_L{layer}_{index}.json
  // ── 分块压缩引擎（通用归并管道）────────────────────────────────────────
  // 输入 items: [{id, text}]；输出最终压缩（含 sourceChain 完整溯源）
  // 流程：预算分块 → 每块独立总结(并发受 opts.concurrency) → 中间落盘
  //       → 中间结果超限再归并 → 最终单块总结 → 返回 { ok, content, chain, parts }
  // 分块压缩引擎：内存中分块总结 → 归并 → 最终单文件（不落盘 _partial 中间产物）。
  // 幂等由各调用方的事件级去重保证（对话跟踪=会话@轮次引用、周期=summarizedAt/coveredEvents）；
  // sourceChain 完整保留各块「会话+轮次:step」指向，不丢失溯源末端。
  async function chunkCompress(items, opts, meta, sourceLabel) {
    const budget = blockBudget(opts)
    let expanded = []
    for (const it of items) {
      const s = splitItemBySentences(it, budget, opts.langTokens)
      expanded.push(...s)
    }
    const chunks = chunkItemsByBudget(expanded, budget, opts.langTokens)
    if (!chunks.length) return { ok: false, error: '无内容可分块' }
    // 末尾小段自适应（阶段4）：末尾块过小单独派发信息不足 → 并入前块 / 拆半派发 / 下限保护
    mergeTailSmallChunk(chunks, budget, opts.langTokens)
    // 最终块的 parsed（lessons/op 等模型输出）随 final 透传：
    // 调用方（对话跟踪 lessons/op、周期总结）依赖 res.final.parsed，此前从未被填充。
    let lastParsed = null
    // 并发执行各块总结（concurrency: 0=串行，N>0=同时最多 N 个）
    const concurrency = Math.max(0, Number(opts.concurrency) || 0)
    const results = []
    const runOne = async (chunk, idx) => {
      const label = (sourceLabel || '') + '（块' + (idx + 1) + '/' + chunks.length + '）'
      // 失败重派：块总结失败移除标记重新派单（重试 1 次，仍失败才记失败）
      let res = await summarizeChunk(chunk, opts, meta, label)
      if (!res.ok) {
        const label2 = label + '（重试）'
        res = await summarizeChunk(chunk, opts, meta, label2)
        if (!res.ok) return res
      }
      // 批2：工具格式降级——模型输出的工具调用在这里真实执行
      if (res.degraded && res.toolOut && res.toolOut.tool && res.toolOut.tool !== 'memory_noop') {
        const toolName = res.toolOut.tool
        const tArgs = res.toolOut.args || {}
        const execMeta = { session: (meta && meta.session) || '', turn: (meta && meta.turn) || 0, agent: (meta && meta.agent) || 'memory-admin' }
        try {
          if (toolName === 'memory_add') {
            const obj = newKeywordObj(String(tArgs.title || '降级记忆'), String(tArgs.content || chunk.map(it => it.text).join('\n').slice(0, 2000)), String(tArgs.reason || '模型降级工具调用'), execMeta, null)
            const p2 = await uniquePath(importantDir(), sanitizeFile(obj.title) + '.json')
            await writeJson(p2, obj)
            await autoLink(obj, execMeta)
            await touchActive(execMeta, relOf(p2), 'memory_add_degraded')
            return { ok: true, parsed: { compress: true, reason: '降级 memory_add 已执行', content: obj.content.slice(0, 200), lessons: [], sourceChain: chunk.map(it => it.id) }, sourceChain: chunk.map(it => it.id), content: obj.content.slice(0, 200), itemIds: chunk.map(it => it.id), degraded: true }
          }
          if (toolName === 'memory_event_add' || toolName === 'memory_necessary') {
            const isEvent = toolName === 'memory_event_add'
            const d = new Date()
            const dir = ymPath(d)
            const existing = await listFiles(p(dailyBaseDir(), dir), false)
            const seq = existing.length + 1
            const path = await uniquePath(p(dailyBaseDir(), dir), eventFileName(execMeta, d, seq))
            const me = { agent: execMeta.agent, session: execMeta.session, turn: execMeta.turn }
            const obj = {
              schemaVersion: 1, id: uid(), kind: 'event', location: 'daily', readonly: true,
              title: String(tArgs.title || '降级事件'), reason: String(tArgs.reason || '模型降级工具调用'),
              content: String(tArgs.content || chunk.map(it => it.text).join('\n').slice(0, 2000)),
              links: withActiveParents({ parents: [], children: [{ kind: 'turn', ref: (execMeta.session || '') + '@' + (execMeta.turn || 0), location: 'session' }] }, execMeta),
              sessionRef: buildSessionRef(execMeta.session, execMeta.turn),
              createdAt: nowIso(), updatedAt: nowIso(), lastAccessedAt: nowIso(),
              createdBy: me, lastModifiedBy: me, originalId: null,
              history: [histEntry('create', { ...execMeta, note: '模型降级工具调用' })],
            }
            await writeJson(path, obj)
            await autoLink(obj, execMeta)
            await touchActive(execMeta, relOf(path), 'memory_' + (isEvent ? 'event_add' : 'necessary') + '_degraded')
            return { ok: true, parsed: { compress: true, reason: '降级 ' + toolName + ' 已执行', content: obj.content.slice(0, 200), lessons: [], sourceChain: chunk.map(it => it.id) }, sourceChain: chunk.map(it => it.id), content: obj.content.slice(0, 200), itemIds: chunk.map(it => it.id), degraded: true }
          }
        } catch (e) {
          console.error('[motion-memory] 降级工具执行失败: ' + (e && e.message))
          return { ok: false, error: '降级工具 ' + toolName + ' 执行失败：' + (e && e.message) }
        }
      }
      const chain = res.parsed.sourceChain && res.parsed.sourceChain.length ? res.parsed.sourceChain : res.itemIds
      const content = res.parsed.compress === false ? '' : (res.parsed.content || res.text)
      return { ok: true, parsed: res.parsed, sourceChain: chain, content, itemIds: res.itemIds, model: (opts && (opts.provider + '/' + opts.model)) || 'main' }
    }
    // 块级委派（阶段3）：工具模型主池 worker 全忙 + 仍有剩余块 + 管理员有模型 + 开关允许 → 启动管理员委派池。
    // 委派块用管理员模型（同一 adminPrompt 契约，仅模型实例不同），块预算取 min(工具, 管理员) 保证两模型都能处理。
    // 开关在工具模型高级设置（track/enhance/period 各自 delegateBlocks），默认关（仅工具模型，不外派）。
    const delegateOn = !!(meta && meta.delegateBlocks) && adminHasModel()
    let adminOpts = null
    let adminConcurrency = 0
    if (delegateOn) {
      const admC = adminCfg()
      adminOpts = {
        provider: admC.model && admC.model.provider,
        model: admC.model && admC.model.model,
        contextTokens: admC.contextTokens,
        percent: admC.summaryPercent,
        outputTokens: admC.outputTokens,
        concurrency: Math.max(1, Number(admC.concurrency) || 1),
        langTokens: admC.langTokens,
        extraJson: admC.extraJson,
      }
      if (adminOpts.provider && adminOpts.model) {
        // 工具模型 == 管理员模型时委派无意义（同一个模型），直接不委派
        const toolKey = String((opts && (opts.provider + '/' + opts.model)) || '')
        const adminKey = String((adminOpts.provider + '/' + adminOpts.model) || '')
        if (toolKey === adminKey) { adminOpts = null; adminConcurrency = 0 }
        else adminConcurrency = Math.max(1, Number(adminOpts.concurrency) || 1)
      } else {
        adminOpts = null
        adminConcurrency = 0
      }
    }
    if (concurrency <= 0 && adminConcurrency <= 0) {
      for (let i = 0; i < chunks.length; i++) results.push(await runOne(chunks[i], i))
    } else {
      let next = 0
      const workers = []
      // 主池（工具模型，concurrency 个）
      const mainWorkers = Math.max(0, concurrency)
      for (let w = 0; w < mainWorkers; w++) {
        workers.push((async () => {
          while (next < chunks.length) {
            const i = next++
            results[i] = await runOne(chunks[i], i)
          }
        })())
      }
      // 委派池（管理员模型）：仅在主池 worker 全忙（mainWorkers>0 且已有等待）或主池为 0 时生效。
      // 实现：主池 worker 数量固定；委派池与主池共享 next 计数器（工作窃取），块按各自模型预算领走。
      if (adminConcurrency > 0 && (concurrency > 0 || chunks.length > 0)) {
        // 只有开启委派且工具并发不足（块数 > 主池并发）才真正启动委派池，避免正常场景外派
        if (chunks.length > Math.max(1, mainWorkers)) {
          for (let w = 0; w < adminConcurrency; w++) {
            workers.push((async () => {
              while (next < chunks.length) {
                const i = next++
                // 委派池领块：若该块超管理员预算，交给主池（next 已抢占则重试——简单起见直接跳过超大块）
                const chunk = chunks[i]
                const chunkTokens = chunk.reduce((n, it) => n + estimateTokens(it.text || '', opts.langTokens), 0)
                const adminBudget = adminOpts ? blockBudget(adminOpts) : 0
                if (chunkTokens > adminBudget) { results[i] = await runOne(chunk, i); continue }
                const label = (sourceLabel || '') + '（块' + (i + 1) + '/' + chunks.length + '·管理员委派）'
                const res = await summarizeChunk(chunk, adminOpts, meta, label)
                if (!res.ok) { results[i] = res; continue }
                const chain2 = res.parsed.sourceChain && res.parsed.sourceChain.length ? res.parsed.sourceChain : res.itemIds
                const content2 = res.parsed.compress === false ? '' : (res.parsed.content || res.text)
                results[i] = { ok: true, parsed: res.parsed, sourceChain: chain2, content: content2, itemIds: res.itemIds, model: (adminOpts && (adminOpts.provider + '/' + adminOpts.model)) || 'admin' }
              }
            })())
          }
        }
      }
      await Promise.all(workers)
    }
    // 各块结果检查
    const failed = results.filter(r => !r.ok)
    if (failed.length) return { ok: false, error: '块总结失败：' + failed.map(f => f.error).join('；') }
    // 单块（无需归并）时直接以该块 parsed 作为最终 parsed
    if (results.length === 1 && results[0].parsed) lastParsed = results[0].parsed
    // 中间结果拼接 → 归并层：每层总结输出尽量到达目标（默认 2k，受输出上限约束），
    // 聚合后仍超目标 → 再拆再派（层数由内容量自然收敛：每层压缩约 5:1，50k→10k→2k 两层即可）
    let mids = results.map((r, i) => ({ id: 'm' + (i + 1), text: r.parsed.compress === false ? '' : (r.content || '') }))
    mids = mids.filter(m => m.text)
    let chain = []
    for (const r of results) {
      if (r.sourceChain && r.sourceChain.length) chain.push(...r.sourceChain)
    }
    if (!mids.length) {
      return { ok: true, content: '', chain, final: { content: '', sourceChain: chain, compress: false, parsed: lastParsed }, allSkipped: true }
    }
    // 总结压缩目标：每层输出尽量到达 2k（目标 token），上限受输出限制（outCap）兜底
    const outCapTok = Math.max(1024, Number(opts.outputTokens) || Number(adminCfg().outputTokens) || 2048)
    const targetTokens = Math.min(2048, outCapTok)  // 目标 2k；输出上限小于 2k 时以上限为准
    let layer = 1
    const maxLayer = 12  // 安全上限（正常 3-4 层收敛；仅防极端情况死循环）
    while (layer < maxLayer) {
      const single = mids.length === 1
      const curTokens = estimateTokens(mids[0].text, opts.langTokens)
      // 已满足目标：单块且 ≤ 目标 token → 收敛停止
      if (single && curTokens <= targetTokens) break
      // 拆不动：单块但已 ≤ 预算（无法再拆）→ 若仍超目标则本层直接压缩该块一次
      if (single) {
        layer++
        const label = (sourceLabel || '') + '（归并层' + layer + ' 单块压缩）'
        const res = await summarizeChunk(mids, opts, meta, label)
        if (!res.ok) return res
        lastParsed = res.parsed
        const c = res.parsed.compress === false ? '' : (res.parsed.content || res.text)
        const ch = res.parsed.sourceChain && res.parsed.sourceChain.length ? res.parsed.sourceChain : res.itemIds
        mids = c ? [{ id: 'm1', text: c }] : []
        if (ch && ch.length) chain = ch
        if (!mids.length) break
        continue
      }
      // 多块：本层聚合压缩（每块输出尽量到达 2k，超目标则拆组继续）
      const groups = chunkItemsByBudget(mids, budget, opts.langTokens)
      layer++
      const groupResults = []
      for (let g = 0; g < groups.length; g++) {
        const label = (sourceLabel || '') + '（归并层' + layer + ' 组' + (g + 1) + '）'
        const res = await summarizeChunk(groups[g], opts, meta, label)
        if (!res.ok) return res
        lastParsed = res.parsed
        const c = res.parsed.compress === false ? '' : (res.parsed.content || res.text)
        const ch = res.parsed.sourceChain && res.parsed.sourceChain.length ? res.parsed.sourceChain : res.itemIds
        groupResults.push({ ok: true, parsed: res.parsed, sourceChain: ch, content: c, itemIds: res.itemIds })
      }
      const gf = groupResults.filter(r => !r.ok)
      if (gf.length) return { ok: false, error: '归并层' + layer + '失败：' + gf.map(f => f.error).join('；') }
      mids = groupResults.map((r, i) => ({ id: 'm' + (i + 1), text: r.parsed.compress === false ? '' : (r.content || '') })).filter(m => m.text)
      chain = []
      for (const r of groupResults) if (r.sourceChain && r.sourceChain.length) chain.push(...r.sourceChain)
    }
    const finalContent = mids.length ? mids[0].text : ''
    return { ok: true, content: finalContent, chain, final: { content: finalContent, sourceChain: chain, layer, parsed: lastParsed } }
  }
  // ── 15. memory_admin_view（只读查看：失败记录；_partial 中间产物已移除）───
  async function memCmdAdminView(args, meta) {
    const lines = ['【记忆管理员·只读查看】']
    if (args.batchId) {
      lines.push('（_partial 中间产物已移除：不再保留批次中间文件；压缩幂等由对话跟踪「会话@轮次引用」与周期「summarizedAt/coveredEvents」保证）')
    } else {
      const failFiles = await listFiles(adminFailDir(), false)
      if (!failFiles.length) lines.push('（无失败记录）')
      else {
        lines.push('失败记录：' + failFiles.length + ' 条')
        for (const f of failFiles) {
          const o = await readJson(f.path)
          if (o) lines.push('  ' + f.name + '：' + (o.error || '') + '（' + (o.at || '') + '）')
        }
      }
    }
    return { ok: true, text: lines.join('\n'), data: { count: lines.length } }
  }
  // ── 16. memory_admin_summarize（手动触发：素材/事件/轮次压缩入口）──────
  async function memCmdAdminSummarize(args, meta) {
    const sid = String(args.sessionId || meta.session || '')
    let items = args.items
    if (!items || !items.length) {
      if (args.turn === undefined) return { ok: false, text: '需要 items 或 turn（+sessionId）' }
      const turn = Number(args.turn)
      const steps = await readStepRange(sid, turn, args.stepFrom, args.stepTo)
      if (!steps.length) return { ok: false, text: '轮次 ' + turn + ' 的步骤段无内容（会话 ' + sid + '）' }
      items = steps.map(s => ({ id: sid + '@' + turn + ':step' + s.step, text: stepsToText([s], true) }))
    }
    if (!items || !items.length) return { ok: false, text: '无内容可压缩' }
    const opts = {
      provider: adminCfg().model && adminCfg().model.provider,
      model: adminCfg().model && adminCfg().model.model,
      contextTokens: adminCfg().contextTokens,
      percent: adminCfg().summaryPercent,
      outputTokens: adminCfg().outputTokens,
      concurrency: adminCfg().concurrency,
      langTokens: adminCfg().langTokens,
      extraJson: adminCfg().extraJson,
    }
    if (!opts.provider || !opts.model) return { ok: false, text: '未配置管理员模型（memory_config 设置 admin.model）' }
    const label = '会话 ' + sid + ' 轮次 ' + (args.turn !== undefined ? args.turn : '手动素材')
    const res = await scheduleWork('admin', () => chunkCompress(items, opts, meta, label), '管理员压缩 ' + label)
    if (!res.ok) return { ok: false, text: '压缩失败：' + res.error + '（可 memory_admin_view 查看，配置后重跑自动续传）' }
    return {
      ok: true,
      text: '压缩完成' + (res.cached ? '（命中缓存）' : '') + (res.allSkipped ? '（全部判定无需压缩）' : '') + '：\n' + (res.content || '（空）') + '\n\n溯源：' + (res.chain.length ? res.chain.join(' → ') : '（无）'),
      data: { batchId: batchDigest(items), content: res.content, chain: res.chain, cached: !!res.cached },
    }
  }

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
      items = [{ id: sid + '@' + turn + (refPrecision === 'step' ? ':truncated' : ''), text: eco.userText }]
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
  ctx.on('session/event', (session, event) => {
    if (!session || !event || event.type !== 'turn/end') return
    const sid = session.id
    const d2 = (event && event.data) || {}
    const turn = d2.turn || 0
    if (!sid || !turn) return
    // 解析 ownerKey（preset:cordis）——对话跟踪的摘要归本智能体活跃文件
    let ownerKey = ''
    try {
      const preset = sessionPresetOf(session)
      if (preset) ownerKey = 'preset:' + preset
    } catch (e) {}
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
  // ═════════════════════════════════════════════════════════════════════
  // 阶段3：强化引擎（查询强化 / 更新强化）+ 最近活动查询
  // ═════════════════════════════════════════════════════════════════════
  // 配置：admin.enhance = { enabled, autoWrite(默认false), maxExpandDepth(3), maxExpandPerLevel(5) }
  // 查询强化：查询词 + 本轮上下文 → 扩展查询词 → 额外召回 → 合并输出
  // 更新强化：目标记忆 → 终点父类3层只读校验 → 冲突警告；引用变更机械同步 + linkDelta 历史
  function enhanceCfg() {
    const c = cfg()
    if (!c.admin) c.admin = {}
    if (!c.admin.enhance) c.admin.enhance = { enabled: false, autoWrite: false, maxExpandDepth: 3, maxExpandPerLevel: 5 }
    return c.admin.enhance
  }
  // 收集记忆文件按标题搜索（v2 检索规则）：
  // 1. 重要/ 全部标题（无时间限制）
  // 2. 周期记忆/ 近 decayDays(30) 天标题（新增）
  // 3. 补充/ 仅当 withArchive=true（有关联引用触发的场景，如强化/周期线索）才进入
  async function searchAllMemories(keyword, withArchive) {
    const hits = []
    const kw = String(keyword || '')
    if (!kw) return hits
    const imp = await searchTitles(importantDir(), kw, false)
    for (const t of imp) hits.push({ title: t, zone: 'important' })
    // 周期近 decayDays 天
    const decay = Math.max(1, Number(cfg().decayDays) || 30)
    const cutoff = Date.now() - decay * 86400000
    for (const f of await listFiles(p(root(), '记忆累积', '周期记忆'), true)) {
      const o = await readJson(f.path)
      if (!o || isTombstone(o) || o.kind !== 'period') continue
      const at = parseIso(o.createdAt) || parseIso(o.updatedAt) || 0
      if (at < cutoff) continue
      const t = String(o.title || '')
      if (t && (t.indexOf(kw) >= 0 || (o.content || '').indexOf(kw) >= 0)) {
        if (!hits.some(h => h.title === t)) hits.push({ title: t, zone: 'period', ref: relOf(f.path) })
      }
    }
    if (withArchive) {
      const arc = await searchTitles(archiveBaseDir(), kw, true)
      for (const t of arc) { if (!hits.some(h => h.title === t)) hits.push({ title: t, zone: 'archive' }) }
    }
    // 无模型记忆整理区（可被扫描检索）
    for (const f of await listFiles(noModelDir(), true)) {
      const o = await readJson(f.path)
      if (!o || isTombstone(o) || o.kind !== 'no-model') continue
      const t = String(o.title || '')
      if (t && (t.indexOf(kw) >= 0 || (o.content || '').indexOf(kw) >= 0)) {
        if (!hits.some(h => h.title === t)) hits.push({ title: t, zone: 'no-model', ref: relOf(f.path) })
      }
    }
    // 结合关键词分数排序（与关键词页一致：create×3 + query×times + update×2 + forget/restore×1），
    // 同级按标题字典序——高频使用/常更新的记忆排在前面；
    // v5：query 按 times 数组计次（同 agent+会话 防重合并），并加时间衰减（decayDays 天线性降到 floor，公式同活跃索引）
    const scored = []
    const scDecay = Math.max(1, Number(cfg().decayDays) || 30)
    const floor = Math.max(0.1, Number(cfg().indexScore && cfg().indexScore.floor) || 0.2)
    const nowMs = Date.now()
    for (const h of hits) {
      let score = 0
      let lastAt = 0
      if (h.zone === 'important') {
        const f = await findImportant(h.title)
        if (f && Array.isArray(f.obj.history)) {
          for (const hh of f.obj.history) {
            const op = hh && hh.op
            if (op === 'create') score += 3
            else if (op === 'query') score += queryDayCount(hh)
            else if (op === 'update') score += 2
            else if (op === 'forget' || op === 'restore') score += 1
          }
        }
        // 时间衰减基准：最近访问时间优先，其次最后操作时间
        lastAt = parseIso(f && f.obj && f.obj.lastAccessedAt) || ((f && f.obj) ? lastOpTime(f.obj) : 0) || 0
      }
      if (lastAt) {
        const ageDays = Math.max(0, (nowMs - lastAt) / 86400000)
        score = score * Math.max(floor, 1 - ageDays / scDecay)
      }
      scored.push(Object.assign({}, h, { score }))
    }
    scored.sort((a, b) => (b.score - a.score) || String(a.title).localeCompare(String(b.title)))
    return scored
  }
  // 终点父类链（parents 链顶端，上限 3 层）
  async function parentChain(obj, maxDepth) {
    const chain = []
    const seen = new Set()
    let cur = obj
    const depth = Math.max(1, Number(maxDepth) || 3)
    for (let i = 0; i < depth; i++) {
      const parents = (cur.links && cur.links.parents) || []
      if (!parents.length) break
      const first = parents[0]
      if (!first || !first.title || seen.has(first.title)) break
      seen.add(first.title)
      const e = await findKeyword(first.title)
      if (!e) break
      chain.push(e)
      cur = e.obj
    }
    return chain
  }
  // 更新强化：参考会话跟踪总结（runTurnSummary/adminLlm）模式——
  // 组装目标+父链上下文 → 模型读取后判断是否更新/冲突 → autoWrite 且判定通过才落盘
  async function enhanceUpdate(args, meta) {
    const ec = enhanceCfg()
    const title = String(args.title || '').trim()
    const newContent = args.content !== undefined ? String(args.content) : null
    const found = await findKeyword(title)
    if (!found) return { ok: false, text: '未找到记忆：' + title }
    const obj = found.obj
    let updated = false
    const lines = ['【更新强化】目标：' + title + '（' + found.zone + '）']
    // ① 组装上下文：目标记忆 + 父链内容（只读参考）+ 建议新内容（若有）
    const chain = await parentChain(obj, ec.maxExpandDepth || 3)
    const parts = []
    parts.push('【目标记忆】' + title + '\n' + String(obj.content || ''))
    if (chain.length) parts.push('【父链记忆（只读参考）】\n' + chain.map(e => '· ' + e.obj.title + '：' + String(e.obj.content || '').slice(0, 300)).join('\n'))
    if (newContent !== null) parts.push('【建议的新内容】\n' + newContent)
    // ② 模型读取上下文后判断（参考会话跟踪总结的 adminLlm + parseAdminJson 管线）
    const enhModel = (ec.model && ec.model.provider && ec.model.model) ? ec.model : (adminCfg().model || {})
    const opts = {
      provider: enhModel.provider,
      model: enhModel.model,
      contextTokens: adminCfg().contextTokens,
      percent: adminCfg().summaryPercent,
      outputTokens: Math.max(256, Number(adminCfg().outputTokens) || 1024),
      langTokens: adminCfg().langTokens,
      extraJson: adminCfg().extraJson,
    }
    if (!opts.provider || !opts.model) return { ok: false, text: '未配置管理员模型' }
    const prompt = [
      '你是「记忆管理员」的更新判断器。读取下方上下文，判断是否应该更新目标记忆。',
      '只输出 JSON：{"should_update": true|false, "conflicts": [{"title": "父链记忆标题", "reason": "冲突原因"}], "reason": "一句话说明", "suggestion": "建议如何更新（无则空字符串）"}',
      '规则：1. 新内容与目标记忆或父链记忆冲突/重复 → should_update=false 并在 conflicts 说明；2. 新内容有增量价值 → should_update=true；3. conflicts 只列下方上下文中真实存在的记忆，禁止编造。',
      '',
      parts.join('\n\n'),
    ].join('\n')
    const res = await adminLlm(prompt, opts, 2)
    let verdict = null
    if (res.ok) {
      const parsed = parseAdminJson(res.text)
      if (parsed) {
        verdict = {
          shouldUpdate: parsed.should_update === true,
          conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts : [],
          reason: String(parsed.reason || ''),
          suggestion: String(parsed.suggestion || ''),
        }
      }
    }
    // ③ 展示模型判断
    if (verdict) {
      lines.push('【模型判断】should_update=' + (verdict.shouldUpdate ? 'true' : 'false') + '；reason：' + (verdict.reason || '（无）'))
      if (verdict.conflicts.length) {
        for (const c of verdict.conflicts) {
          const cTitle = String((c && c.title) || '')
          const real = cTitle ? await findKeyword(cTitle) : null
          lines.push('  冲突⚠ ' + (real ? cTitle : '（未在库中，已忽略）' + cTitle) + '：' + String((c && c.reason) || ''))
        }
      } else if (chain.length) {
        lines.push('  （父链 ' + chain.length + ' 层无冲突迹象）')
      }
      if (verdict.suggestion) lines.push('【建议】' + verdict.suggestion)
      // ④ autoWrite 且模型判定应更新 → 落盘（历史 + diff + 溯源）
      if (newContent !== null && ec.autoWrite && verdict.shouldUpdate) {
        const oldContent = obj.content || ''
        obj.content = newContent
        obj.history = obj.history || []
        obj.history.push(histEntry('update', { ...meta, note: '更新强化（autoWrite，模型判断通过）', delta: diffContent(oldContent, newContent) }))
        obj.updatedAt = nowIso()
        obj.lastModifiedBy = { agent: 'memory-admin', session: meta.session, turn: meta.turn }
        await writeJson(found.path, obj)
        updated = true
        lines.push('已按模型判断自动更新内容')
      } else if (newContent !== null) {
        lines.push('（autoWrite 关闭或模型判定不更新，未写入）')
      }
    } else {
      // 模型失败降级：机械路径（autoWrite 直写 + 父链机械列出）
      lines.push('（模型判断不可用' + (res && res.error ? '：' + res.error : '') + '，走机械路径）')
      if (newContent !== null && ec.autoWrite) {
        const oldContent = obj.content || ''
        obj.content = newContent
        obj.history = obj.history || []
        obj.history.push(histEntry('update', { ...meta, note: '更新强化（autoWrite 机械降级）', delta: diffContent(oldContent, newContent) }))
        obj.updatedAt = nowIso()
        obj.lastModifiedBy = { agent: 'memory-admin', session: meta.session, turn: meta.turn }
        await writeJson(found.path, obj)
        updated = true
        lines.push('已自动更新内容（机械降级）')
      } else if (newContent !== null) {
        lines.push('【建议更新】新内容：\n' + newContent + '\n（autoWrite 关闭，未写入）')
      }
      if (chain.length) {
        lines.push('【父链（机械只读校验）】')
        for (const e of chain) lines.push('  · ' + e.obj.title)
      }
    }
    // ⑤ 引用变更同步（机械：移除时摘除 + linkDelta 历史）
    const removeRef = args.removeRef
    if (removeRef && typeof removeRef === 'object' && removeRef.title) {
      const lists = (obj.links && obj.links.children) || []
      const before = lists.length
      obj.links = obj.links || { parents: [], children: [] }
      obj.links.children = lists.filter(l => !(l.kind === 'keyword' && l.title === removeRef.title))
      if (obj.links.children.length !== before) {
        obj.history = obj.history || []
        obj.history.push(histEntry('update', { ...meta, note: '引用移除：' + removeRef.title, linkDelta: { op: 'remove', link: { kind: 'keyword', title: removeRef.title } } }))
        obj.updatedAt = nowIso()
        await writeJson(found.path, obj)
        lines.push('已机械移除子引用：' + removeRef.title + '（linkDelta 已记录）')
      } else {
        lines.push('未找到子引用：' + removeRef.title)
      }
    }
    return { ok: true, text: lines.join('\n'), data: { title, updated, parentCount: chain.length, modelJudged: !!verdict } }
  }
  // ── P0-2：写入消歧判定（dedupJudge）────────────────────────────────────
  // 有近似候选时，让模型判断新记忆与候选是"同一实体 / 不同实体 / 不确定"。
  // 复用 adminLlm + parseAdminJson 管线；模型失败/未配置 → 返回 null，调用方回退机械规则。
  async function dedupJudgeVerdict(title, content, similar, meta) {
    try {
      const dj = cfg().dedupJudge || {}
      const jm = (dj.model && dj.model.provider && dj.model.model) ? dj.model : (adminCfg().model || {})
      if (!jm.provider || !jm.model) return null
      const opts = {
        provider: jm.provider,
        model: jm.model,
        contextTokens: adminCfg().contextTokens,
        percent: adminCfg().summaryPercent,
        outputTokens: Math.max(256, Number(adminCfg().outputTokens) || 1024),
        langTokens: adminCfg().langTokens,
        extraJson: adminCfg().extraJson,
      }
      const cands = similar.slice(0, Math.max(1, Number(dj.topCandidates) || 3))
      const candText = []
      for (const s of cands) {
        const e = await findKeyword(s.title, scopeOwner(meta))
        candText.push('· ' + (s.title || '') + '：' + (e && e.obj ? String(e.obj.content || '').slice(0, 200) : '（内容不可读）'))
      }
      const prompt = [
        '你是「记忆管理员」的写入消歧判断器。用户正在写入一条新记忆，系统找到若干近似候选。判断新记忆与候选是「同一实体」还是「不同实体」。',
        '只输出 JSON：{"relation": "same|different|ambiguous", "target": "同一实体时的候选标题（否则空字符串）", "action": "update|create|link|ask", "reason": "一句话说明"}',
        '规则：1. 同一件事/同一主题的新进展 → relation=same（target 填最强候选标题，action=update）；2. 仅主题相近但确实是不同内容 → relation=different（action=create）；3. 信息不足无法判断 → relation=ambiguous（action=ask）；4. target 只能从下方【近似候选】里选，禁止编造。',
        '',
        '【新记忆标题】' + String(title || '').slice(0, 100),
        '【新记忆内容】' + String(content || '').slice(0, 300),
        '【近似候选】\n' + (candText.join('\n') || '（无）'),
      ].join('\n')
      const res = await adminLlm(prompt, opts, 2)
      if (!res.ok || !res.text) return null
      const parsed = parseAdminJson(res.text)
      if (!parsed) return null
      const relation = String(parsed.relation || '').trim()
      if (!['same', 'different', 'ambiguous'].includes(relation)) return null
      let target = String(parsed.target || '').trim()
      if (relation === 'same' && target && !cands.some(c => c.title === target)) target = cands[0] ? cands[0].title : ''
      return { relation, target, action: String(parsed.action || ''), reason: String(parsed.reason || '') }
    } catch (e) { return null }
  }
  // ── P0-1：语义检索（本地 embedding，纯文件索引）────────────────────────
  // 目标：解决"换说法搜不到"。可选接入本地 embedding（ollama / lmstudio），
  // 向量存 _embeddings.json（记忆根下，走白名单写通道）；默认关、失败静默回退关键词检索。
  function semanticCfg() { return cfg().semanticSearch || {} }
  function embeddingIndexPath() { return p(root(), '_embeddings.json') }
  async function readEmbeddingIndex() {
    const idx = await readJson(embeddingIndexPath())
    return (idx && Array.isArray(idx.items)) ? idx : { schemaVersion: 1, model: '', updatedAt: '', items: [] }
  }
  async function writeEmbeddingIndex(idx) {
    idx.updatedAt = nowIso()
    await writeJson(embeddingIndexPath(), idx)
  }
  // 调用本地 embedding 服务，返回向量数组；服务不可用/失败 → null（调用方回退）
  async function embedTexts(texts) {
    const sc = semanticCfg()
    if (!sc.enabled || !sc.provider || !sc.model) return null
    const list = (Array.isArray(texts) ? texts : [texts]).map(t => String(t || '').slice(0, 2000)).filter(Boolean)
    if (!list.length) return null
    try {
      if (sc.provider === 'ollama') {
        const res = await fetch('http://127.0.0.1:11434/api/embed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: sc.model, input: list }),
        })
        if (!res.ok) return null
        const data = await res.json()
        return Array.isArray(data && data.embeddings) ? data.embeddings : null
      }
      if (sc.provider === 'lmstudio') {
        const res = await fetch('http://127.0.0.1:1234/v1/embeddings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: sc.model, input: list }),
        })
        if (!res.ok) return null
        const data = await res.json()
        return Array.isArray(data && data.data) ? data.data.map(x => x && x.embedding) : null
      }
    } catch (e) {}
    return null
  }
  function cosineSim(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0
    let dot = 0, na = 0, nb = 0
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
    if (!na || !nb) return 0
    return dot / (Math.sqrt(na) * Math.sqrt(nb))
  }
  // 索引单条（增量；embedding 失败静默——语义是增强能力，不影响主流程）
  async function upsertEmbedding(ref, title, content, zone) {
    try {
      const sc = semanticCfg()
      if (!sc.enabled) return
      const vec = await embedTexts([String(title || '') + '\n' + String(content || '').slice(0, 1500)])
      if (!vec || !vec[0]) return
      const idx = await readEmbeddingIndex()
      idx.model = sc.model
      idx.items = idx.items.filter(x => x.ref !== ref)
      idx.items.push({ ref, zone: zone || 'important', title: String(title || ''), vec: vec[0], updatedAt: nowIso() })
      await writeEmbeddingIndex(idx)
    } catch (e) {}
  }
  async function removeEmbedding(ref) {
    try {
      const idx = await readEmbeddingIndex()
      const before = idx.items.length
      idx.items = idx.items.filter(x => x.ref !== ref)
      if (idx.items.length !== before) await writeEmbeddingIndex(idx)
    } catch (e) {}
  }
  // 全量重建索引（重要 + 周期近 decayDays；分块 embed，失败即停）
  async function rebuildEmbeddingIndex() {
    try {
      const sc = semanticCfg()
      if (!sc.enabled || !sc.provider || !sc.model) return { ok: false, text: '语义检索未启用或未配置模型' }
      const items = []
      for (const f of await listFiles(importantDir(), false)) {
        const o = await readJson(f.path)
        if (!o || isTombstone(o)) continue
        items.push({ ref: relOf(f.path), title: String(o.title || ''), content: String(o.content || ''), zone: 'important' })
      }
      const decay = Math.max(1, Number(cfg().decayDays) || 30)
      const cutoff = Date.now() - decay * 86400000
      for (const f of await listFiles(p(root(), '记忆累积', '周期记忆'), true)) {
        const o = await readJson(f.path)
        if (!o || isTombstone(o) || o.kind !== 'period') continue
        const at = parseIso(o.createdAt) || parseIso(o.updatedAt) || 0
        if (at < cutoff) continue
        items.push({ ref: relOf(f.path), title: String(o.title || ''), content: String(o.content || ''), zone: 'period' })
      }
      const idx = { schemaVersion: 1, model: sc.model, updatedAt: nowIso(), items: [] }
      for (let i = 0; i < items.length; i += 16) {
        const batch = items.slice(i, i + 16)
        const vecs = await embedTexts(batch.map(b => b.title + '\n' + b.content.slice(0, 1500)))
        if (!vecs) return { ok: false, text: 'embedding 服务不可用，索引未完成（已完成 ' + idx.items.length + ' 条）' }
        for (let j = 0; j < batch.length; j++) {
          if (vecs[j]) idx.items.push({ ref: batch[j].ref, zone: batch[j].zone, title: batch[j].title, vec: vecs[j], updatedAt: nowIso() })
        }
      }
      await writeEmbeddingIndex(idx)
      return { ok: true, text: '语义索引已重建：' + idx.items.length + ' 条' }
    } catch (e) { return { ok: false, text: '索引重建失败：' + (e && e.message || String(e)) } }
  }
  // 语义召回：query → topK 余弦命中（按相似度降序）
  async function semanticHits(query) {
    try {
      const sc = semanticCfg()
      if (!sc.enabled) return []
      const idx = await readEmbeddingIndex()
      if (!idx.items.length) {
        // 懒建：后台全量重建，不阻塞当前查询
        scheduleWork('semantic', () => rebuildEmbeddingIndex(), '语义索引重建').catch(() => {})
        return []
      }
      const qv = await embedTexts([query])
      if (!qv || !qv[0]) return []
      const scored = []
      for (const it of idx.items) {
        const sim = cosineSim(qv[0], it.vec)
        if (sim >= (Number(sc.threshold) || 0.35)) scored.push({ title: it.title, zone: it.zone, ref: it.ref, sim })
      }
      scored.sort((a, b) => b.sim - a.sim)
      return scored.slice(0, Math.max(1, Number(sc.topK) || 8))
    } catch (e) { return [] }
  }
  // 查询强化：完整上下文模式——命中材料 + 引用记忆深度展开（≤预算25%，越远截断）
  // + 触发前对话步填满剩余 → 一次模型判断（参考会话跟踪总结管线）
  async function enhanceQuery(args, meta) {
    const query = String(args.query || '')
    if (!query) return { ok: false, text: '需要 query' }
    const ec2 = enhanceCfg()
    const mc = resolveModelConfig(ec2.model)
    const opts = {
      provider: mc.provider,
      model: mc.model,
      contextTokens: mc.contextTokens,
      percent: mc.summaryPercent,
      outputTokens: Math.max(256, Number(mc.outputTokens) || 1024),
      concurrency: mc.concurrency,
      langTokens: adminCfg().langTokens,
      extraJson: mc.extraJson,
    }
    if (!opts.provider || !opts.model) return { ok: false, text: '未配置管理员模型' }
    const budget = Math.max(1024, Math.floor((Number(opts.contextTokens) || 128000) * (Number(opts.percent) || 50) / 100))
    const expandCap = Math.floor(budget * 0.25)   // 引用展开信息占预算 25%，越远越先截断
    const sid = (meta && meta.session) || ''
    const turn = (meta && meta.turn) || 0
    // ① 真实召回命中：整句 + 拆词/2-gram 宽召回（长查询整句无法子串命中，需拆短词匹配内容）
    const hits = []
    {
      const seen = new Set()
      const grams = []
      const qq = String(query)
      for (let i = 0; i < qq.length - 1; i++) { const g = qq.slice(i, i + 2); if (!grams.includes(g)) grams.push(g) }
      for (const w of qq.split(/[\s,，。；;、/（）()]+/)) { if (w.length >= 2 && !grams.includes(w)) grams.push(w) }
      for (const w of [query, ...grams]) {
        const r = await searchAllMemories(w, true)
        for (const h of r) {
          if (seen.has(h.title)) continue
          seen.add(h.title)
          hits.push(h)
          if (hits.length >= 15) break
        }
        if (hits.length >= 15) break
      }
    }
    const hitDetails = []
    for (const h of hits.slice(0, 6)) {
      const e = await findKeyword(h.title)
      if (e) hitDetails.push('【' + h.title + '】' + String(e.obj.content || '').slice(0, 180))
    }
    const hitText = hitDetails.join('\n')
    // ② 引用记忆深度展开（预算25%内，按查阅深度，越远截断）
    const refParts = []
    let used = 0
    const seenRef = []
    for (const h of hits.slice(0, 3)) {
      if (used >= expandCap) break
      const e = await findKeyword(h.title)
      if (!e) continue
      const exp = await expandLinks(e.obj, Number(ec2.maxExpandDepth) || 3, seenRef, Math.max(256, expandCap - used))
      if (exp.text) { refParts.push(exp.text); used += exp.text.length }
    }
    const refText = refParts.join('\n')
    // ③ 对话上下文：剩余空间填满（预算 − 命中材料 − 引用展开），超出截断
    const ctxBudget = Math.max(0, budget - hitText.length - used)
    let ctx = ''
    for (let t = Math.max(1, turn - 10); t <= turn; t++) {
      if (ctx.length >= ctxBudget) break
      const step = await readTurnUserTextRetry(sid, t, 1024)
      if (step && step !== '（该轮次无文本内容）') {
        ctx += (ctx ? '\n' : '') + '轮次' + t + '：' + step.slice(0, Math.max(128, ctxBudget - ctx.length))
      }
    }
    // ④ 一次模型判断（完整上下文）
    const prompt = [
      '你是「记忆管理员」的查询强化器。结合下方【对话上下文】判断：引用记忆文件中哪些对当前查询/上下文有用。',
      '输出必须严格是单个 JSON 对象：{"expanded": ["扩展检索词"], "related": ["命中材料中的记忆标题"], "add_refs": [{"title": "引用记忆标题", "reason": "结合对话上下文有用的原因"}], "reason": "一句话"}',
      '约束：',
      '1. related 只能从【已有命中材料】中选真实存在的标题，禁止编造；',
      '2. add_refs 只能从【引用记忆文件】中选，结合对话上下文判断是否对查询有用；用不上的留空数组；',
      '3. expanded 是继续召回用的扩展检索词（与查询相关的新词）。',
      '原始查询：' + query,
      '【已有命中材料】\n' + (hitText || '（无直接命中）'),
      '【引用记忆文件】\n' + (refText || '（无）'),
      '【对话上下文】\n' + (ctx || '（无）'),
    ].join('\n')
    const res = await adminLlm(prompt, opts, 2)
    const parsed = res.ok ? parseAdminJson(res.text) : null
    if (!parsed) {
      // 降级：只输出正常返回（不报错）
      const lines = ['【查询强化】原始：' + query]
      lines.push('扩展词：（强化模型不可用，未扩展）')
      lines.push('相关记忆：' + (hits.length ? hits.map(h => h.title).join('；') : '（无）'))
      if (refText) lines.push('【引用记忆文件】\n' + refText)
      if (hitText) lines.push('\n' + hitText)
      if (res && res.error) lines.push('（强化失败：' + res.error + '）')
      return { ok: true, text: lines.join('\n'), data: { degraded: true, hits: hits.map(h => h.title) } }
    }
    // ⑤ 扩展词二次召回 + related/add_refs 真实性校验
    const expanded = Array.isArray(parsed.expanded) ? parsed.expanded : []
    const related = Array.isArray(parsed.related) ? parsed.related : []
    const addRefs = Array.isArray(parsed.add_refs) ? parsed.add_refs : []
    const lines = ['【查询强化】原始：' + query]
    lines.push('扩展词：' + (expanded.length ? expanded.join('、') : '（无）') + (parsed.reason ? '；' + parsed.reason : ''))
    for (const w of expanded) {
      if (typeof w !== 'string') continue
      const r = await searchAllMemories(w, true)
      for (const h of r) { if (!hits.some(x => x.title === h.title)) hits.push(h) }
    }
    lines.push('相关记忆：' + (hits.length ? hits.map(h => h.title).join('；') : '（无）'))
    if (refText) lines.push('【引用记忆文件】\n' + refText)
    const details = []
    for (const h of hits.slice(0, 5)) {
      const e = await findKeyword(h.title)
      if (e) details.push('【' + h.title + '】' + (e.obj.content || '').slice(0, 200))
    }
    if (details.length) lines.push('\n' + details.join('\n'))
    // ⑥ 模型推荐额外引用（仅 add_refs 非空时显示）
    const realRefs = []
    for (const r2 of addRefs) {
      const t2 = String((r2 && r2.title) || '')
      if (!t2) continue
      const e = await findKeyword(t2)
      if (e && !realRefs.some(x => x.title === t2)) realRefs.push({ title: t2, reason: String((r2 && r2.reason) || '') })
      else lines.push('（模型建议引用未在库中，已忽略：' + t2 + '）')
    }
    if (realRefs.length) {
      lines.push('【模型推荐额外引用】')
      for (const x of realRefs) lines.push('  · ' + x.title + (x.reason ? '：' + x.reason : ''))
    }
    return { ok: true, text: lines.join('\n'), data: { expanded, related: related.filter(t => hits.some(h => h.title === t)), addRefs: realRefs, hits: hits.map(h => h.title) } }
  }
  // memory_enhance 工具
  async function memCmdEnhance(args, meta) {
    const ec = enhanceCfg()
    if (!ec.enabled) return { ok: false, text: '强化引擎未启用（admin.enhance.enabled）' }
    if (args.mode === 'query' || args.query) return scheduleWork('enhance', () => enhanceQuery(args, meta), '查询强化 ' + String(args.query || '').slice(0, 30))
    return { ok: false, text: '未知模式：' + args.mode }
  }
  // memory_recent：最近活动查询（创建×3 + 查询×1 + 更新×2 + 遗忘×1 + 捡回×1）
  async function memCmdRecent(args, meta) {
    const checkN = Math.max(1, Number(args.checkN) || 10)
    const expandN = Math.min(checkN, Math.max(0, Number(args.expandN) || 10))
    const weight = Math.max(1, Number(args.weight) || 2)
    const all = []
    const rOwner = scopeOwner(meta)
    for (const e of await scanDir(importantDir(), false, rOwner)) all.push({ obj: e.obj, path: e.path, zone: 'important' })
    for (const e of await scanDir(archiveBaseDir(), true, rOwner)) all.push({ obj: e.obj, path: e.path, zone: 'archive' })
    // 按最近操作时间排序取 checkN
    all.sort((a, b) => lastOpTime(b.obj) - lastOpTime(a.obj))
    const top = all.slice(0, checkN)
    // 统计得分
    const scored = []
    for (const e of top) {
      let create = 0, query = 0, update = 0, forget = 0, restore = 0
      for (const h of (e.obj.history || [])) {
        if (h.op === 'create') create++
        else if (h.op === 'query') query += queryDayCount(h)
        else if (h.op === 'update') update++
        else if (h.op === 'forget-update') forget++
        else if (h.op === 'restore') restore++
        else if (h.op === 'move') { if (h.note && h.note.indexOf('自动归档') < 0) forget++ }
      }
      const score = create * 3 + query * 1 + update * weight + forget * 1 + restore * 1
      scored.push({ title: e.obj.title, score, create, query, update, forget, restore, last: lastOpTime(e.obj), zone: e.zone, obj: e.obj })
    }
    scored.sort((a, b) => b.score - a.score || b.last - a.last)
    const lines = ['【最近活动】检查 ' + checkN + ' 个，得分 = 创×3 + 查×次数 + 更×' + weight + ' + 忘×1 + 捡×1']
    for (const s of scored) {
      lines.push(s.title + ' | 得分 ' + s.score + ' (创' + s.create + ' 查' + s.query + ' 更' + s.update + ' 忘' + s.forget + ' 捡' + s.restore + ') | ' + isoStr(s.last))
    }
    if (expandN > 0) {
      lines.push('【展开】')
      for (const s of scored.slice(0, expandN)) {
        lines.push('── ' + s.title + ' ──')
        lines.push((s.obj.content || '').slice(0, 300))
      }
    }
    return { ok: true, text: lines.join('\n'), data: { total: scored.length, items: scored.map(s => ({ title: s.title, score: s.score })) } }
  }
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
    if (!c.admin.period) c.admin.period = { enabled: false, intervalDays: 1, intervalHours: 0, scope: 1, scopeDetail: 'events-nomodel', useTools: true, impactPercent: 100, impactCount: 0, economize: [], truncK: 2, skipRecentDays: 14 }
    const pc = c.admin.period
    // 最近 N 天素材不总结：默认 14，最小 7（0/缺省回退默认）
    if (pc.skipRecentDays === undefined || pc.skipRecentDays === null || pc.skipRecentDays < 7) pc.skipRecentDays = pc.skipRecentDays === 0 ? 0 : 14
    return pc
  }
  function periodBaseDir() { return p(dailyBaseDir(), '周期记忆') }
  // v2 目录粒度：YYYY/MM（中长期记忆，年月足够；文件名含完整时间区分同月多次）
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
    const rangeTo = (extra && extra.to) ? Number(extra.to) : 0
    const ignoreSummarized = !!(extra && extra.ignoreSummarized)
    const truncK = Math.max(0, Number((extra && extra.truncK) || pc.truncK) || 2)
    // 最近 N 天素材不总结（skipRecentDays，默认 14，最小 7）：定时/手动周期收集时把 rangeTo 收窄到「现在 - N 天」，
    // 只总结 N 天前的素材；历史重总结（extra.from/to 显式传入）不套用此收窄。
    if (!(extra && (extra.from || extra.to)) && pc.skipRecentDays) {
      const skipMs = Math.max(7, Number(pc.skipRecentDays) || 14) * 86400000
      const recentCap = Date.now() - skipMs
      if (!rangeTo || rangeTo > recentCap) rangeTo = recentCap
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
      if (!ignoreSummarized && o.summarizedAt) continue
      const created = parseIso(o.createdAt) || 0
      if (rangeFrom && created < rangeFrom) continue
      if (rangeTo && created > rangeTo) continue
      evs.push({ obj: o, path: f.path, rel: relOf(f.path), isNoModel: true })
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
    if (!selected.length && !sessionItems.length) return { ok: true, text: '周期内无未总结的事件记忆' + (scope >= 2 ? '且无会话素材' : ''), skipped: true }
    // 组装 items（事件 + 会话素材）
    // v4 #3：管理员上下文装在素材最前面（占 summaryPercent 预算）
    const adminCtx = await adminContextText(Math.floor(estimateTokens('', opts.langTokens) * 0 + (Number(opts.contextTokens) || 128000) * (Number(opts.percent) || 50) / 100 / 4))
    // v5：压缩当前活跃（各智能体记录链尾部）→ 作为周期总结的状态素材（"活跃末尾下沉"）
    const activeCtx = await activeRecordsContextText()
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
    const path = await uniquePath(dir, stamp(d) + (trigger === 'manual' ? '_manual' : '') + '-' + seq + '.json')
    const obj = {
      schemaVersion: 1, id: uid(), kind: 'period', location: 'period', readonly: true,
      title: '周期总结 ' + ymdPath(d) + (trigger === 'manual' ? '（手动）' : '') + '（' + scopeLabelOf(scope, scopeDetail) + '）',
      trigger,
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
            const evMeta = { agent: 'memory-admin', session: sid2 || '', turn: turn2 }
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
            // ③ 周期到期自动执行
            return periodDue().then(due => {
              if (due) scheduleWork('period', () => runPeriodSummary({ agent: 'memory-admin', session: '', turn: 0 }, false), '定时周期总结').catch(e => console.error('[motion-memory] 周期总结失败: ' + (e && e.message)))
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
      await scheduleWork('period', () => runPeriodSummary({ agent: 'memory-admin', session: '', turn: 0 }, true, false, {
        scope: req.scope, scopeDetail: req.scopeDetail, from: req.from, to: req.to,
        ignoreSummarized: !!req.ignoreSummarized, truncK: req.truncK,
      }), '界面周期总结').catch(e => console.error('[motion-memory] 界面周期总结失败: ' + (e && e.message)))
      // 处理完移除请求文件（tombstone）
      await tombstone(reqPath, reqPath)
      console.log('[motion-memory] 界面周期总结请求已执行' + (resetTimer ? '（重置倒计时）' : ''))
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
    const res = await scheduleWork('period', () => runPeriodSummary(meta, force, useSessionModel, {
      scope: args && args.scope,
      scopeDetail: args && args.scopeDetail,
      from: args && args.from,
      to: args && args.to,
      ignoreSummarized: !!(args && args.ignoreSummarized),
      truncK: args && args.truncK,
    }), '周期总结（手动）')
    if (!res.ok) return res
    return res
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

  // ── 版本与更新（v0.1.x：git 绑定安装的自动更新检查）────────────────────
  // 发布版为 git 仓库（motion-memory-dist 工作副本），用 git fetch 对比远端，
  // 有更新可执行 git pull（重启 DSH 生效）；手动复制安装则提示重新下载。
  // 自动检查：启动后 8 秒检查一次，之后每 12 小时一次（结果缓存，设置页/命令可查）。
  const UPDATE_PROJECT_URL = 'https://github.com/li3-feng2-jie2/dsh-motion-memory'
  // 定位插件文件所在目录（import.meta.url → 向上找 .git）
  function pluginGitDir() {
    try {
      let p = ''
      try { p = (typeof import.meta !== 'undefined' && import.meta.url) ? import.meta.url : '' } catch (e) {}
      if (!p && typeof __filename !== 'undefined') p = __filename
      if (!p) return ''
      if (p.startsWith('file://')) p = decodeURIComponent(p.slice(7)).replace(/\//g, '\\')
      p = String(p).replace(/\\/g, '\\')
      let cur = p
      const idx = cur.toLowerCase().indexOf('motion-memory.js')
      if (idx >= 0) cur = cur.slice(0, idx)
      for (let i = 0; i < 8; i++) {
        if (existsSync(cur + '.git')) return cur.replace(/\\+$/, '')
        const last = cur.lastIndexOf('\\')
        if (last <= 0) break
        cur = cur.slice(0, last)
      }
    } catch (e) {}
    return ''
  }
  // 插件所在目录（motion-memory.js 的上级目录；非 git 安装也适用）
  function pluginDir() {
    try {
      let p = ''
      try { p = (typeof import.meta !== 'undefined' && import.meta.url) ? import.meta.url : '' } catch (e) {}
      if (!p && typeof __filename !== 'undefined') p = __filename
      if (!p) return ''
      if (p.startsWith('file://')) p = decodeURIComponent(p.slice(7)).replace(/\//g, '\\')
      const idx = String(p).toLowerCase().indexOf('motion-memory.js')
      if (idx >= 0) return String(p).slice(0, idx).replace(/\\+$/, '')
    } catch (e) {}
    return ''
  }
  function execGit(args, opts) {
    return new Promise((resolve) => {
      try {
        execFileCb('git', args, Object.assign({ timeout: 20000, windowsHide: true, encoding: 'utf8' }, opts || {}), (err, stdout, stderr) => {
          if (err) resolve({ ok: false, error: String(stderr || err.message || '').trim() || String(err.message || '') })
          else resolve({ ok: true, out: String(stdout || '').trim() })
        })
      } catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }) }
    })
  }
  async function pluginVersionInfo() {
    const dir = pluginGitDir()
    if (!dir) return { git: false, version: '0.1.0', projectUrl: UPDATE_PROJECT_URL }
    const tag = await execGit(['describe', '--tags', '--always'], { cwd: dir })
    const head = await execGit(['rev-parse', '--short', 'HEAD'], { cwd: dir })
    const remote = await execGit(['remote', 'get-url', 'origin'], { cwd: dir })
    const pkg = readJsonFileNative(p(dir, 'package.json'))
    return {
      git: true, dir, version: (pkg && pkg.version) || '0.1.0',
      tag: tag.ok ? tag.out : '', head: head.ok ? head.out : '',
      remote: remote.ok ? remote.out : '',
      projectUrl: (pkg && pkg.repository && pkg.repository.url) ? String(pkg.repository.url).replace(/^git\+/, '').replace(/\.git$/, '') : UPDATE_PROJECT_URL,
    }
  }
  // 版本号比较（语义化 vX.Y.Z）：a>b 返回 1，相等 0，a<b 返回 -1
  function compareVersions(a, b) {
    const pa = String(a || '0').replace(/^v/i, '').split('.').map(n => Number(n) || 0)
    const pb = String(b || '0').replace(/^v/i, '').split('.').map(n => Number(n) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0
      if (x > y) return 1
      if (x < y) return -1
    }
    return 0
  }
  // 检查更新（git 分支：fetch 对比提交；非 git 分支：版本号对比）
  async function checkUpdate() {
    const dir = pluginGitDir()
    if (dir) {
      const info = await pluginVersionInfo()
      const fet = await execGit(['fetch', 'origin'], { cwd: dir, timeout: 30000 })
      if (!fet.ok) return { ok: false, text: '检查更新失败：' + fet.error + '（请确认 git 与网络可用）\n项目地址：' + info.projectUrl, info, projectUrl: info.projectUrl }
      const behind = await execGit(['rev-list', '--count', 'HEAD..@{u}'], { cwd: dir })
      const latest = await execGit(['log', '-1', '--format=%h %s', '@{u}'], { cwd: dir })
      const behindN = behind.ok ? (Number(behind.out) || 0) : 0
      return {
        ok: true, hasUpdate: behindN > 0, behind: behindN, mode: 'git',
        info: Object.assign({}, info, { latest: latest.ok ? latest.out : '' }),
        projectUrl: info.projectUrl,
        text: '版本 v' + info.version + (info.tag ? '（' + info.tag + '）' : '') + ' · 提交 ' + info.head +
          (behindN > 0 ? '\n发现新版本（落后 ' + behindN + ' 个提交，最新：' + (latest.ok ? latest.out : '?') + '）\n点击"更新"拉取（更新后需重启 DSH 生效）' : '\n已是最新版本'),
      }
    }
    // 非 git 分支：版本号判断（手动复制安装）。远端版本 = GitHub raw 的 package.json version
    const localPkg = readJsonFileNative(p(pluginDir(), 'package.json'))
    const localVer = (localPkg && localPkg.version) || '0.1.0'
    let remoteVer = ''
    let remoteUrl = ''
    try {
      const r = await fetch('https://raw.githubusercontent.com/li3-feng2-jie2/dsh-motion-memory/main/package.json', { signal: AbortSignal.timeout(15000) })
      if (r && r.ok) {
        const rj = await r.json()
        remoteVer = (rj && rj.version) || ''
        remoteUrl = (rj && rj.repository && rj.repository.url) ? String(rj.repository.url).replace(/^git\+/, '').replace(/\.git$/, '') : UPDATE_PROJECT_URL
      }
    } catch (e) { return { ok: false, text: '检查更新失败：' + ((e && e.message) || e) + '（请确认网络可用）\n项目地址：' + UPDATE_PROJECT_URL, info: null, projectUrl: UPDATE_PROJECT_URL, mode: 'version' } }
    if (!remoteVer) return { ok: false, text: '检查更新失败：无法获取远端版本号\n项目地址：' + UPDATE_PROJECT_URL, info: null, projectUrl: UPDATE_PROJECT_URL, mode: 'version' }
    const cmp = compareVersions(remoteVer, localVer)
    return {
      ok: true, hasUpdate: cmp > 0, behind: cmp > 0 ? 1 : 0, mode: 'version',
      info: { git: false, version: localVer, remoteVersion: remoteVer, projectUrl: remoteUrl || UPDATE_PROJECT_URL },
      projectUrl: remoteUrl || UPDATE_PROJECT_URL,
      text: '本地版本 v' + localVer + ' · 远端版本 v' + remoteVer +
        (cmp > 0 ? '\n发现新版本（远端 ' + remoteVer + ' > 本地 ' + localVer + '）\n点击"更新"下载最新文件（更新后需重启 DSH 生效）' : '\n已是最新版本'),
    }
  }
  // 执行更新（git 分支：pull --ff-only；非 git 分支：版本号对比，仅提示手动下载——无法安全覆盖本地文件）
  async function applyUpdate() {
    const dir = pluginGitDir()
    if (dir) {
      const pull = await execGit(['pull', '--ff-only'], { cwd: dir, timeout: 60000 })
      if (!pull.ok) return { ok: false, text: '更新失败：' + pull.error + '（请先处理本地未提交改动）' }
      const head = await execGit(['rev-parse', '--short', 'HEAD'], { cwd: dir })
      return { ok: true, text: '已更新（提交 ' + (head.ok ? head.out : '?') + '），请重启 DSH 生效。\n' + pull.out, data: { head: head.ok ? head.out : '' } }
    }
    // 非 git：版本号已对比有新版 → 提示手动下载（不自动覆盖，避免破坏手动安装的本地改动）
    return { ok: false, text: '手动复制安装无法自动更新（避免覆盖你的本地文件）。\n请从发布仓库下载最新源码替换：' + UPDATE_PROJECT_URL + '\n（或用 git clone 安装以获得自动更新）' }
  }
  // memory cmd=update（action=check 检查 / apply 更新）
  async function memCmdUpdate(args, meta) {
    const action = (args && args.action) || 'check'
    if (action === 'apply') return applyUpdate()
    return checkUpdate()
  }
  // 自动更新检查：结果缓存到 state.lastUpdateCheck（设置页/命令可读，避免频繁 fetch）
  async function autoUpdateCheck() {
    const r = await checkUpdate().catch(() => ({ ok: false, text: '更新检查失败' }))
    state.lastUpdateCheck = Object.assign({ at: nowIso() }, r)
    if (r && r.ok && r.hasUpdate) console.log('[motion-memory] 检测到新版本（落后 ' + r.behind + ' 个提交），可在设置页"版本与更新"执行更新')
    return state.lastUpdateCheck
  }
  // 启动后 8 秒检查一次，之后每 12 小时一次（生命周期自动清理）
  let autoTimerId = null
  function startAutoUpdateCheck() {
    try {
      const bootTimer = setTimeout(() => {
        autoUpdateCheck().catch(() => {})
        scheduleLoop()
      }, 8000)
      function scheduleLoop() {
        autoTimerId = setTimeout(() => { autoUpdateCheck().catch(() => {}); scheduleLoop() }, 12 * 3600 * 1000)
      }
      const disposer = () => {
        try { if (bootTimer) clearTimeout(bootTimer) } catch (e) {}
        try { if (autoTimerId) clearTimeout(autoTimerId) } catch (e) {}
      }
      try { if (ctx && typeof ctx.effect === 'function') ctx.effect(disposer) } catch (e) {}
    } catch (e) {}
  }

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
      const baseKeys = ['enabled', 'inject', 'injectLimitBytes', 'root', 'recentOverviewN', 'archiveDays', 'cascadeDepth', 'queryHistoryN', 'updateHistoryN', 'historyPageSize', 'queryOtherAgents', 'summaryCharsK']
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
