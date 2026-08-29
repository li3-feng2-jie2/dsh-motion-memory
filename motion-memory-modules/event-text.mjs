/**
 * motion-memory 事件文本提取模块（拆分自 motion-memory.js，A 档）
 *
 * 纯函数层：会话事件（assistant/message、tool/call、tool/result）的文本化、
 * token 用量提取、超长文本省略。由 motion-memory.js 通过 import 引入。
 */

/** 内容块（content blocks）→ 纯文本（拼接 text 块并去首尾空白） */
export function textOfContent(blocks) {
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const b of blocks) { if (b && b.type === 'text' && typeof b.text === 'string') out += b.text }
  return out.trim()
}

/** 事件 token 用量提取（usage 归一：input/output/total） */
export function usageOf(e) {
  try {
    const u = e && e.data && e.data.usage
    if (u && typeof u === 'object') return { input: u.inputTokens || u.input || 0, output: u.outputTokens || u.output || 0, total: u.totalTokens || 0 }
  } catch (err) {}
  return null
}

/** 读取一个 step 的文本内容（assistant 文本 + 工具调用名/参数摘要 + 工具结果摘要） */
export function stepTextOf(e) {
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

/** 超长文本中部省略：超过 2n 字符时只保留开头+结尾各 n（防止报错/冗长内容全量喂模型） */
export function trimTextMiddle(text, n) {
  const s = String(text || '')
  const nn = Math.max(1, Math.floor(Number(n) || 500))
  return s.length > nn * 2 ? s.slice(0, nn) + '\n…（中间省略 ' + (s.length - nn * 2) + ' 字符）…\n' + s.slice(-nn) : s
}
