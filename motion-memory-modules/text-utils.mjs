/**
 * motion-memory 文本工具模块（拆分自 motion-memory.js）
 *
 * 纯函数层：段落/句子切分、diff 计算、逆应用（历史重建）、delta 摘要。
 * 由 motion-memory.js 通过 import 引入。
 */

/** 按换行切段落（去空白行） */
export function splitParagraphs(text) {
  return String(text || '').split(/\r?\n/).map(s => s.trim()).filter(s => s !== '')
}

/** 中文/英文硬句末：这些标点在任何位置都断句 */
const HARD_END = /[。！？!?；;]/
/** 词字符：'.' 两侧都是词字符 → 该点号在词内部，不断句 */
const WORD_CHAR = /[A-Za-z0-9_]/
/** 句末标点后可吸附的收尾符号（右引号/右括号）：与本句同属一句 */
const TRAILING = /[”"’'）」』】〉》\)\]]/
/** 常见拉丁缩写：其后的点号不算句末 */
const ABBR = /(?:^|[^A-Za-z])(?:e\.g|i\.e|etc|vs|resp|approx|cf|al|mr|mrs|ms|dr|prof|st|no|fig)\.$/i

/**
 * '.' 是否算句末。
 * 以下「词内点号 / 标记点号」一律不算句末，否则会被误切成两句：
 * - 数值小数与版本号：1.2、v0.5.0、192.168.1.1
 * - 文件名与路径：text-utils.mjs、docs/a.md、compat.json
 * - 拉丁缩写：e.g.、i.e.、etc.、Mr.
 * - 列表序号：1. 、2. （序号后的点号不是句末）
 */
function isDotBoundary(s, i) {
  const prev = s[i - 1]
  const next = s[i + 1]
  if (next === undefined) return true     // 行末点号＝句末
  if (prev === undefined) return false    // 行首点号不断句
  if (WORD_CHAR.test(prev) && WORD_CHAR.test(next)) return false
  if (ABBR.test(s.slice(0, i + 1))) return false
  if (isEnumMarker(s, i)) return false
  return true
}

/** 列表序号标记（"1. "）：点号前是行首/空白/句末标点，点号后紧跟空白 */
function isEnumMarker(s, i) {
  const before = s.slice(0, i)
  const m = before.match(/(\d+)$/)
  if (!m) return false
  const head = before.slice(0, before.length - m[1].length)
  const atHead = head === '' || /[\s。！？!?；;]$/.test(head)
  return atHead && /\s/.test(s[i + 1] || '')
}

/** 收集 [from,to] 切片（去空白后非空才收） */
function pushSlice(out, s, from, to) {
  const t = s.slice(from, to + 1).trim()
  if (t) out.push(t)
}

/**
 * 按中文/英文句读切句子。
 * - 句末标点连同其后连续的同类标点、收尾引号括号一起归前一句（"？！"、"。。。"不产生空句，“好！”不断开）；
 * - '.' 经 isDotBoundary 判定：数值/版本号/文件名/路径/缩写/列表序号的点号不切。
 */
export function splitSentences(para) {
  const s = String(para || '').trim()
  if (!s) return []
  const out = []
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    const isDot = ch === '.'
    if (!isDot && !HARD_END.test(ch)) continue
    if (isDot && !isDotBoundary(s, i)) continue
    let j = i
    while (isDot ? s[j + 1] === '.' : (j + 1 < s.length && HARD_END.test(s[j + 1]))) j++
    while (j + 1 < s.length && TRAILING.test(s[j + 1])) j++
    pushSlice(out, s, start, j)
    start = j + 1
    i = j
  }
  pushSlice(out, s, start, s.length - 1)
  if (!out.length) out.push(s)
  return out
}

/** 段落级 diff：逐句位置对齐 */
export function diffParagraph(oldP, newP) {
  const a = splitSentences(oldP)
  const b = splitSentences(newP)
  const n = Math.max(a.length, b.length)
  const changes = []
  for (let i = 0; i < n; i++) {
    const from = a[i] === undefined ? null : a[i]
    const to = b[i] === undefined ? null : b[i]
    if (from !== to) changes.push({ index: i, from, to })
  }
  return { sentenceCount: n, changes }
}

/** 内容级 diff：段落对齐 → 段内句子 diff */
export function diffContent(oldContent, newContent) {
  const a = splitParagraphs(oldContent)
  const b = splitParagraphs(newContent)
  const n = Math.max(a.length, b.length)
  const delta = []
  for (let i = 0; i < n; i++) {
    const oldP = a[i] === undefined ? null : a[i]
    const newP = b[i] === undefined ? null : b[i]
    if (oldP === newP) continue
    delta.push({ paragraph: i, ...diffParagraph(oldP, newP) })
  }
  return delta
}

/** 逆应用单段 changes（历史重建用） */
export function applyInverseParagraph(para, changes) {
  let s = splitSentences(para)
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i]
    if (c.from === null) { if (c.index < s.length) s.splice(c.index, 1) }
    else if (c.to === null) { s.splice(Math.min(c.index, s.length), 0, c.from) }
    else if (c.index < s.length) { s[c.index] = c.from }
  }
  return s.join('')
}

/** 逆应用整个 delta（历史重建） */
export function applyInverse(content, delta) {
  const paras = splitParagraphs(content)
  for (let i = delta.length - 1; i >= 0; i--) {
    const pc = delta[i]
    if (pc.paragraph < paras.length) paras[pc.paragraph] = applyInverseParagraph(paras[pc.paragraph], pc.changes || [])
  }
  return paras.join('\n')
}

/** 历史重建：从 history 逆推 tMs 时刻的内容（parseIso 由调用方注入） */
export function reconstructAt(obj, tMs, parseIso) {
  let content = obj.content || ''
  const hist = (obj.history || []).slice()
  for (let i = hist.length - 1; i >= 0; i--) {
    if (parseIso(hist[i].at) <= tMs) break
    if (hist[i].delta && hist[i].delta.length) content = applyInverse(content, hist[i].delta)
  }
  return content
}

/** delta 段落重叠判断 */
export function deltaOverlap(a, b) {
  const pa = {}, pb = {}
  ;(a || []).forEach(d => { pa[d.paragraph] = true })
  ;(b || []).forEach(d => { pb[d.paragraph] = true })
  return Object.keys(pa).some(k => pb[k])
}

/** 截断（加省略号） */
export function trunc(s, n) { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) + '…' : t }

/** delta 摘要文本：只列变化前后文本，不带「第n段 / 共n句 / 第n句」编号 */
export function deltaSummary(delta) {
  if (!delta || !delta.length) return '（无文本变化）'
  const lines = []
  for (const pc of delta) {
    for (const c of (pc.changes || [])) {
      lines.push('- ' + (c.from === null ? '（无）' : trunc(c.from, 40)) + ' → ' + (c.to === null ? '（无）' : trunc(c.to, 40)))
    }
  }
  return lines.join('\n')
}

/** 操作类型显示名 */
export function opLabel(op) {
  return ({ create: '创建', query: '查询', update: '增量更新', forget: '遗忘', 'forget-update': '遗忘更新', restore: '捡回/回滚', move: '移动', isolation: '隔离', necessary: '必要注入' })[op] || op
}
