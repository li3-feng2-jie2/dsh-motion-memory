/**
 * motion-memory 语义/强化域模块（拆分自 motion-memory.js，C 档第九刀）
 *
 * 查询强化（enhanceQuery）+ 更新强化（enhanceUpdate）+ 语义检索
 * （embedding 索引/upsertEmbedding/removeEmbedding/semanticHits）+ 写入消歧判定
 * （dedupJudgeVerdict）+ memory_enhance/recent 命令。
 * 依赖经 createSemantic(core, deps) 注入：core 为共享运行时；deps 提供
 * { adminLlm, parseAdminJson, resolveModelConfig, scheduleWork,
 *   queryDayCount, expandLinks, readTurnUserTextRetry }。
 */

import { diffContent } from './text-utils.mjs'
import { histEntry } from './memory-objects.mjs'

export function createSemantic(core, deps) {
  const {
    cfg, adminCfg, p, root, relOf, nowIso, parseIso,
    readJson, writeJson, listFiles, isTombstone, tombstone,
    importantDir, archiveBaseDir, noModelDir, searchTitles, findImportant,
    findKeyword, scopeOwner, scanDir, lastOpTime, isoStr,
  } = core
  const {
    adminLlm, parseAdminJson, resolveModelConfig, scheduleWork,
    queryDayCount, expandLinks, readTurnUserTextRetry,
  } = deps || {}

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
  async function searchAllMemories(keyword, withArchive, owner) {
    const hits = []
    const kw = String(keyword || '')
    if (!kw) return hits
    const imp = await searchTitles(importantDir(), kw, false, owner)
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
      const arc = await searchTitles(archiveBaseDir(), kw, true, owner)
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

  return {
    enhanceCfg, searchAllMemories, semanticCfg, upsertEmbedding, removeEmbedding,
    rebuildEmbeddingIndex, semanticHits, enhanceQuery, enhanceUpdate,
    dedupJudgeVerdict, memCmdEnhance, memCmdRecent,
  }
}
