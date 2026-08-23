/**
 * motion-memory 会话日志帧级读取模块（拆分自 motion-memory.js）
 *
 * 纯函数层：会话日志路径推导 + zstd 帧扫描。
 * 依赖：node:fs（statSync/readdirSync）、process.env.DSH_HOME。
 * 由 motion-memory.js 通过 import 引入（Cordis loader 支持相对路径）。
 */

import { statSync, readdirSync } from 'node:fs'

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

/** 会话日志根目录（DSH_HOME/sessions） */
export function sessionLogsRoot() {
  const home = String(process.env.DSH_HOME || '').replace(/\\/g, '/')
  return home ? home + '/sessions' : ''
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
