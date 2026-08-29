/**
 * motion-memory 写入域模块（拆分自 motion-memory.js，C 档第八刀）
 *
 * memory_add 工具实现：6 kind（keyword/necessary/event/update/edit/forget）。
 * 注册壳（description/properties）留在主文件，run 体 = memCmdAdd。
 * 依赖经 createWrite(core, deps) 注入：core 为共享运行时；deps 提供
 * { validateLinks, withActiveParents, autoLink, unmountFromActive,
 *   appendTurnToAggregate, writeActive, withSourceRef, touchActive,
 *   buildSessionRef, dedupJudgeVerdict, upsertEmbedding, removeEmbedding }。
 */

import { diffContent, deltaOverlap, deltaSummary, reconstructAt, opLabel } from './text-utils.mjs'
import { histEntry, newKeywordObj, sanitizeFile, eventFileName } from './memory-objects.mjs'
import { ymPath, stamp } from './time-utils.mjs'

export function createWrite(core, deps) {
  const {
    state, p, root, relOf, nowIso, parseIso, uid,
    readJson, writeJson, listFiles, isTombstone, tombstone, cfg,
    necessaryDir, importantDir, archiveBaseDir, archiveDirFor, dailyBaseDir,
    uniquePath, findImportant, findKeyword, findSimilarTitles, scopeOwner, fileNameOf,
  } = core
  const {
    validateLinks, withActiveParents, autoLink, unmountFromActive,
    appendTurnToAggregate, writeActive, withSourceRef, touchActive,
    buildSessionRef, dedupJudgeVerdict, upsertEmbedding, removeEmbedding,
  } = deps || {}

  async function memCmdAdd(args, meta) {
    const kind = args.kind || 'keyword'
    // ── kind=necessary：智能体级必要记忆（agent.md 语义，写入活跃 custom，随总览注入）──
    if (kind === 'necessary') {
      const ownerKey = (meta && (meta.agent || meta.session)) ? String(meta.agent || meta.session) : ''
      if (!ownerKey) return { ok: false, text: '无法确定智能体归属，必要记忆未写入' }
      const content = args.clear ? '' : String(args.content || '')
      await writeActive(meta.session, meta.turn || 0, { ownerKey, custom: content, me: meta, clear: !!args.clear })
      state.necessaryCache.set(meta.session, { content, updatedAt: nowIso() })
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
      // 自动检测日期变体（标题-YYYYMMDD.json）并合并；传 mergeDated=false 可禁用（默认自动）
      if (args.mergeDated !== false) {
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
  }
  return {
    memCmdAdd,
  }
}
