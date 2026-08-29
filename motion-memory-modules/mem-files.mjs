/**
 * motion-memory 记忆文件对象管理模块（拆分自 motion-memory.js，B 档）
 *
 * MemFiles — 记忆文件统一管理（结构体方法：每类文件一个类，load/save/migrate）
 * UE5 类比：每类 USTRUCT 配序列化方法；schemaVersion 即存档版本，
 * load 时读到旧版本自动 migrate 到当前结构，写盘统一走 save。
 *
 * 工厂模式：依赖经 createMemFiles(deps) 注入（避免闭包捕获），
 * 由 motion-memory.js apply() 内调用并持有返回的 MemFiles。
 */

/**
 * 创建 MemFiles 对象（7 类记忆文件的管理器）
 * @param {object} deps 注入依赖：
 *   { p, root, readJson, writeJson, listFiles, isTombstone, relOf, uniquePath,
 *     sanitizeFile, histEntry, newKeywordObj, eventFileName, uid, nowIso, ymPath,
 *     buildSessionRef, withActiveParents,
 *     importantDir, dailyBaseDir, periodBaseDir, necessaryDir, noModelDir, isolationDir, activeDir }
 * @returns {object} MemFiles（keyword/event/period/necessary/noModel/incident/active）
 */
export function createMemFiles(deps) {
  const {
    p, root, readJson, writeJson, listFiles, isTombstone, relOf, uniquePath,
    sanitizeFile, histEntry, newKeywordObj, eventFileName, uid, nowIso, ymPath,
    buildSessionRef, withActiveParents,
    importantDir, dailyBaseDir, periodBaseDir, necessaryDir, noModelDir, isolationDir, activeDir,
  } = deps

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
      // v7：不再派生 keywords（只用 refs 引用指向）
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

  return MemFiles
}
