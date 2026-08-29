/**
 * motion-memory 时间/路径工具模块（拆分自 motion-memory.js，A 档）
 *
 * 纯函数层：本地时间格式化、ISO 解析、路径日期段、唯一 id。
 * 由 motion-memory.js 通过 import 引入；不依赖任何闭包变量。
 */

/** 两位补零 */
export function pad(n) { return n < 10 ? '0' + n : String(n) }

/** 当前 ISO 时间（UTC） */
export function nowIso() { return new Date().toISOString() }

/** 本地时间分量（y/m/day/h/min/s） */
export function parts(d) {
  return { y: d.getFullYear(), m: pad(d.getMonth() + 1), day: pad(d.getDate()), h: pad(d.getHours()), min: pad(d.getMinutes()), s: pad(d.getSeconds()) }
}

/** 年/月/日 三级路径段（事件旧布局） */
export function ymdPath(d) { const p = parts(d || new Date()); return p.y + '/' + p.m + '/' + p.day }

/** 年/月 两级路径段（v5 存储瘦身：事件区目录统一年/月两级） */
export function ymPath(d) { const p = parts(d || new Date()); return p.y + '/' + p.m }

/** 事件文件 rel 判断（兼容新旧两种布局）：新 记忆累积/2026/08/16_xxx.json；旧 记忆累积/2026/08/16/xxx.json */
export function isEventRel(rel) {
  const r = '/' + String(rel || '').replace(/\\/g, '/')
  if (r.indexOf('/周期记忆/') >= 0 || r.indexOf('/补充/') >= 0) return false
  return /\d{4}\/\d{2}\/\d{2}(?:\/|_)/.test(r)
}

/** 时间戳文件名段：2026-08-16_11-22-33 */
export function stamp(d) { const p = parts(d || new Date()); return p.y + '-' + p.m + '-' + p.day + '_' + p.h + '-' + p.min + '-' + p.s }

/** 紧凑日期段：20260816 */
export function ymdCompact(d) { const p = parts(d || new Date()); return p.y + p.m + p.day }

/** ISO 字符串 → 毫秒；非法返回 0 */
export function parseIso(iso) { const t = new Date(iso).getTime(); return Number.isFinite(t) ? t : 0 }

/** 唯一 id（时间基 36 + 随机） */
export function uid() { return 'mm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) }
