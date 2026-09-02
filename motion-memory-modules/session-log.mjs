/**
 * motion-memory 会话日志帧级读取模块（拆分自 motion-memory.js）
 *
 * 纯函数层：会话日志路径推导 + zstd 帧扫描。
 * 状态化层（B 档）：帧级增量读取、事件读取、限帧读取、标题读取、会话引用构造。
 * 依赖：node:fs、node:zlib、process.env.DSH_HOME。
 * 由 motion-memory.js 通过 import 引入（Cordis loader 支持相对路径）。
 */

import { statSync, readdirSync, readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

export const ZSTD_MAGIC = 0xFD2FB528

/** 路径段编码：与 dsh-session-persistence-jsonl/src/format.ts encodeSegment 一致 */
export function encodeSegment(raw) {
  if (!raw) return ''
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** 项目目录键：与 format.ts projectKey 一致（路径分隔符/冒号 → '-'，其余 ~XXXX） */
export function projectKeyOf(cwd) {
  if (!cwd) return ''
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return '--' + slug.slice(0, 251) + '--'
}

/** 会话日志根目录（DSH_HOME/sessions；DSH_HOME 未设置时回退 USERPROFILE/.dsh/sessions——与 core.dshHome 一致，
 *  DSH 0.1.2+ 启动后不再把 home 写入 process.env，无兜底会让帧级日志读取（归属解析/轮次范围/标题）全部失效） */
export function sessionLogsRoot() {
  const home = String(process.env.DSH_HOME || '').replace(/\\/g, '/')
  if (home) return home + '/sessions'
  const up = String(process.env.USERPROFILE || '').replace(/\\/g, '/')
  return up ? up + '/.dsh/sessions' : ''
}

/** 帧扫描（与 zstd.ts scanZstdFrames 一致）：不解压即可切出帧边界 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('invalid frame magic at ' + offset)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error('reserved frame-header bit')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error('reserved block type')
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * 推导会话日志路径（可用 cwd 或 fallback 扫描 sessions 根目录找 <sid>）。
 * joinPath 由调用方注入（原闭包 p()，拼接路径并归一化反斜杠）。
 */
export function sessionLogPathOf(sid, cwd, joinPath) {
  const root = sessionLogsRoot()
  if (!root || !sid) return ''
  if (cwd) {
    const cand = joinPath(root, projectKeyOf(cwd), encodeSegment(sid), 'session.jsonl.zstd')
    try { if (statSync(cand).isFile()) return cand } catch (e) {}
  }
  // fallback：遍历 sessions 根目录下各项目目录找 sid（项目目录数量少）
  try {
    for (const proj of readdirSync(root)) {
      const cand = joinPath(root, proj, encodeSegment(sid), 'session.jsonl.zstd')
      try { if (statSync(cand).isFile()) return cand } catch (e) {}
    }
  } catch (e) {}
  return ''
}
/**
 * 会话日志状态化读取工厂（B 档拆分）：帧级增量读取、事件读取、限帧读取、
 * 标题读取、会话引用构造。依赖（deps）由 motion-memory.js 注入：
 *   { p, state, ctx }（state.sessionLogCache 缓存；ctx.get('sessionQuery') 兜底）
 * @param {object} deps 注入依赖
 */
export function createSessionLogReader(deps) {
  const { p, state, ctx } = deps
  // 推导会话日志路径：包装模块顶层 sessionLogPathOf(sid, cwd, joinPath)，
  // joinPath 固定注入为 p()（拼接路径并归一化反斜杠）
  function resolveLogPath(sid, cwd) {
    return sessionLogPathOf(sid, cwd, p)
  }

  // 帧级增量读取会话日志：返回 { events, header }；失败返回 null（调用方 fallback 到 sessionQuery）
  function readSessionLogFrames(sid, cwd) {
    const path = resolveLogPath(sid, cwd)
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
  // 限帧读取：只解前 maxFrames 帧（agent-preset/selected 等早期事件定位用，
  // 避免为找 1 个事件全量解压大日志；不写 sessionLogCache，不污染全量缓存）
  function readSessionEventsFirstFrames(sid, maxFrames) {
    try {
      const path = resolveLogPath(sid, '')
      if (!path) return []
      const st = statSync(path)
      if (!st.isFile()) return []
      const buf = readFileSync(path)
      const frames = scanZstdFrames(buf).frames
      if (!frames.length) return []
      const out = []
      for (let i = 0; i < Math.min(frames.length, Math.max(1, Number(maxFrames) || 30)); i++) {
        let plain
        try { plain = zstdDecompressSync(buf.subarray(frames[i].start, frames[i].end)).toString('utf8') } catch (e) { continue }
        for (const line of plain.split('\n')) {
          const t = line.trim()
          if (!t) continue
          try {
            const o = JSON.parse(t)
            if (o && typeof o === 'object' && o.type) out.push(o)
          } catch (e) {}
        }
      }
      return out
    } catch (e) { return [] }
  }
  // 轻量读会话标题：只解前 20 帧找 session/title 事件，取最后一条 data.title（供设置界面会话列表使用）
  function readSessionTitleFromLog(sid) {
    try {
      const path = resolveLogPath(sid, '')
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
  // 会话最后轮次信息（只读 turn/start 与 step 事件，不回读内容）：
  // 返回 { lastTurn, lastTurnSteps, turnCount }；失败/无日志返回 null。
  // 供会话列表显示"最后轮次总计步数"（相对步数 = 该轮最大 step 编号，第 1 步即用户消息）。
  function sessionLastTurnInfo(sid) {
    try {
      const fast = readSessionLogFrames(sid)
      if (!fast || !fast.events || !fast.events.length) return null
      let lastTurn = 0, turnCount = 0
      const stepMaxByTurn = {}
      for (const e of fast.events) {
        const d = (e && e.data) || {}
        if (e.type === 'turn/start' && d.turn !== undefined) {
          const t = Number(d.turn)
          if (t > lastTurn) lastTurn = t
          if (t > turnCount) turnCount = t
        } else if ((e.type === 'step/start' || e.type === 'assistant/message') && d.turn !== undefined && d.step !== undefined) {
          const t = Number(d.turn), st = Number(d.step)
          if (t > 0 && st > (stepMaxByTurn[t] || 0)) stepMaxByTurn[t] = st
        }
      }
      if (!lastTurn) return null
      return { lastTurn, lastTurnSteps: stepMaxByTurn[lastTurn] || 0, turnCount }
    } catch (e) { return null }
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
  return { sessionLogPathOf: resolveLogPath, readSessionLogFrames, readSessionEvents, readSessionEventsFirstFrames, readSessionTitleFromLog, buildSessionRef, sessionLastTurnInfo }
}

// B 档别名：createSessionLogReader 内部引用（模块顶层三参数版）
export { sessionLogPathOf as sessionLogPathOfMod }
