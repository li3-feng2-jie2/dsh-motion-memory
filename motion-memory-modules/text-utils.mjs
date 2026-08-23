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

/** 按中文/英文句读切句子 */
export function splitSentences(para) {
  const s = String(para || '').trim()
  if (!s) return []
  const out = []
  const re = /[^。！？!?；;.]+[。！？!?；;.]*/gu
  let m
  while ((m = re.exec(s)) !== null) { const t = m[0].trim(); if (t) out.push(t) }
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

/** delta 摘要文本 */
export function deltaSummary(delta) {
  if (!delta || !delta.length) return '（无文本变化）'
  const lines = []
  for (const pc of delta) {
    for (const c of (pc.changes || [])) {
      lines.push('第' + (pc.paragraph + 1) + '段，共' + pc.sentenceCount + '句；第' + (c.index + 1) + '句：' + (c.from === null ? '（无）' : trunc(c.from, 40)) + ' → ' + (c.to === null ? '（无）' : trunc(c.to, 40)))
    }
  }
  return lines.join('\n')
}

/** 操作类型显示名 */
export function opLabel(op) {
  return ({ create: '创建', query: '查询', update: '增量更新', forget: '遗忘', 'forget-update': '遗忘更新', restore: '捡回/回滚', move: '移动', isolation: '隔离', necessary: '必要注入' })[op] || op
}
