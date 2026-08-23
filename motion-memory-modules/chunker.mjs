/**
 * motion-memory 分块/估算模块（拆分自 motion-memory.js）
 *
 * 纯函数层：token 估算、批次摘要、单块预算、按句子边界切块。
 * 由 motion-memory.js 通过 import 引入。
 */

import { createHash } from 'node:crypto'
import { splitSentences } from './text-utils.mjs'

/** token 估算（语言表：{lang, per} 单字/词 token 值） */
export function estimateTokens(text, langTokens) {
  const s = String(text || '')
  if (!s) return 0
  // 默认语言表：kind 为字符类别（cn 中文 / ja 日文 / ko 韩文 / en 英文按词 / other 其他按字符）
  const defaults = [
    { kind: 'cn', lang: '中文', per: 1.5 },
    { kind: 'en', lang: 'english', per: 4 },
    { kind: 'ja', lang: '日文', per: 1.5 },
    { kind: 'ko', lang: '韩文', per: 1.5 },
  ]
  const table = Array.isArray(langTokens) && langTokens.length ? langTokens : defaults
  // 字符类别计数
  const cn = (s.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const ja = (s.match(/[\u3040-\u30ff]/g) || []).length
  const ko = (s.match(/[\uac00-\ud7af]/g) || []).length
  const en = (s.match(/[A-Za-z0-9]+/g) || []).length
  // other = 剩余字符（减英文/数字字符数而非词数，避免重复计入）
  const enChars = (s.match(/[A-Za-z0-9]/g) || []).length
  const other = s.length - cn - ja - ko - enChars
  // 语言表按 kind 或 lang 名匹配各类 per
  const per = { cn: 1.5, en: 4, ja: 1.5, ko: 1.5, other: 1 }
  for (const t of table) {
    if (!t || typeof t.per !== 'number') continue
    const kind = String(t.kind || '').toLowerCase()
    const l = String(t.lang || '')
    if (kind === 'cn' || l.indexOf('中') >= 0 || l.indexOf('zh') >= 0 || l.indexOf('cn') >= 0) per.cn = t.per
    else if (kind === 'ja' || l.indexOf('日') >= 0 || l.indexOf('ja') >= 0 || l.indexOf('jp') >= 0) per.ja = t.per
    else if (kind === 'ko' || l.indexOf('韩') >= 0 || l.indexOf('ko') >= 0 || l.indexOf('kr') >= 0) per.ko = t.per
    else if (kind === 'en' || l.indexOf('英') >= 0 || l.indexOf('en') >= 0 || l.indexOf('english') >= 0) per.en = t.per
    else if (kind === 'other') per.other = t.per
  }
  return Math.ceil(cn * per.cn + ja * per.ja + ko * per.ko + en * per.en + other * per.other)
}

/** 批次摘要（sha256 前 16 位） */
export function batchDigest(items) {
  const canonical = (items || []).map(it => JSON.stringify([it.id || '', it.text || ''])).join('\n')
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/** 计算单块上限：模型上下文×百分比 与「上下文−输出余量」取小 */
export function blockBudget(opts) {
  const ctxCap = Math.max(1024, Number(opts.contextTokens) || 128000)
  const pct = Math.min(90, Math.max(5, Number(opts.percent) || 50))
  const outCap = Math.max(256, Number(opts.outputTokens) || Math.min(4096, Math.floor(ctxCap * (100 - pct) / 100)))
  return Math.min(Math.floor(ctxCap * pct / 100), ctxCap - outCap - 512)
}

/** 按句子边界切块：累计 token 超过单块预算即切（句切点与 splitSentences 一致） */
export function chunkItemsByBudget(items, budget, langTokens) {
  const chunks = []
  let cur = []
  let curTokens = 0
  for (const it of items) {
    const t = estimateTokens(it.text || '', langTokens)
    if (cur.length && curTokens + t > budget) {
      chunks.push(cur)
      cur = []
      curTokens = 0
    }
    cur.push(it)
    curTokens += t
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

/**
 * 末尾小段自适应派发（阶段4）：末尾块 token 过小 → 单独派发信息不足，可能导致无有效总结。
 * 容量基准：R 与「最小可总结量」比较（minTokens，默认取预算的 8% 或固定 300，取较大者）；
 * 小于基准时不再硬切成碎块：
 *   - 有前一块且并入不超预算 → 直接并入前块（信息连续，最优）
 *   - 并入会超预算 → 拆半：一半并入前块（允许略超预算，预算本身有余量），另一半保留为最后一块
 *   - 下限保护：R < floorTokens（默认 300）→ 强制并入前块（不拆，避免制造更小碎片）
 * 返回处理后的 chunks（原地修改并返回新数组）。
 */
export function mergeTailSmallChunk(chunks, budget, langTokens, minTokens, floorTokens) {
  if (!Array.isArray(chunks) || chunks.length <= 1) return chunks
  const tail = chunks[chunks.length - 1]
  const tailTokens = tail.reduce((n, it) => n + estimateTokens(it.text || '', langTokens), 0)
  const min = Math.max(300, Number(minTokens) || Math.max(300, Math.round(budget * 0.08)))
  const floor = Math.max(100, Number(floorTokens) || 300)
  if (tailTokens >= min) return chunks  // 末尾块足够大，无需处理
  const prev = chunks[chunks.length - 2]
  if (!prev) return chunks
  const prevTokens = prev.reduce((n, it) => n + estimateTokens(it.text || '', langTokens), 0)
  if (tailTokens <= floor || prevTokens + tailTokens <= budget) {
    // 下限保护或并入不超预算：整块并入前一块
    chunks[chunks.length - 2] = prev.concat(tail)
    chunks.pop()
    return chunks
  }
  // 拆半：一半并入前块，一半保留为最后一块（两块都有相对充足的信息）
  const half = []
  let acc = 0
  for (const it of tail) {
    const t = estimateTokens(it.text || '', langTokens)
    if (half.length && acc + t > Math.max(1, Math.round(tailTokens / 2))) { break }
    half.push(it)
    acc += t
  }
  if (!half.length) { chunks[chunks.length - 2] = prev.concat(tail); chunks.pop(); return chunks }
  const rest = tail.slice(half.length)
  chunks[chunks.length - 2] = prev.concat(half)
  if (rest.length) chunks[chunks.length - 1] = rest
  else chunks.pop()
  return chunks
}

/** 句子级二次切块：单条文本超预算时按句子拆分（与 splitSentences 一致） */
export function splitItemBySentences(it, budget, langTokens) {
  const sentences = splitSentences(it.text || '')
  const out = []
  let cur = []
  let curTokens = 0
  for (const s of sentences) {
    const t = estimateTokens(s, langTokens)
    if (cur.length && curTokens + t > budget) {
      out.push({ id: it.id + '#s' + (out.length + 1), text: cur.join('') })
      cur = []
      curTokens = 0
    }
    cur.push(s)
    curTokens += t
  }
  if (cur.length) out.push({ id: it.id + '#s' + (out.length + 1), text: cur.join('') })
  return out.length ? out : [it]
}
