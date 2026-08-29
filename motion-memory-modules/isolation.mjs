/**
 * motion-memory 隔离域模块（拆分自 motion-memory.js，C 档）
 *
 * 记忆隔离（阶段1-3）：目标时间快照 → 预览 → 回滚（T 后新建移入 _审阅）→ 解除。
 * 依赖经 createIsolation(core) 注入（core 为 createCore(ctx) 返回的共享运行时）。
 */

export function createIsolation(core) {
  const {
    state, p, root, relOf, parseIso, isoStr, stamp, nowIso,
    listFiles, readJson, writeJson, isTombstone, tombstone, uniquePath, fileNameOf,
    stateAt, histEntry, dailyBaseDir, isolationDir, quarantineDir,
  } = core

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
      const last = core.lastOpTime(o)
      if (last > tMs || created > tMs) files.push({ rel, created, last, op: core.lastOp(o), createdAfter: created > tMs })
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

  async function memCmdIsolation(args, meta) { return runIsolation(args, meta) }

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

  async function memCmdIsolationClear(args, meta) {
    const inc = state.incidents.get(args.id)
    if (!inc) return { ok: false, text: '未找到隔离事件：' + args.id }
    inc.clearedAt = nowIso()
    await writeJson(p(isolationDir(), inc.id, 'incident.json'), inc)
    return { ok: true, text: '已解除隔离通知：' + args.id + '。隔离文件夹 ' + relOf(p(isolationDir(), inc.id)) + ' 的内容保留待人工清理（fs 无删除能力）。' }
  }

  return { runIsolation, memCmdIsolation, memCmdIsolationRestore, memCmdIsolationClear }
}
