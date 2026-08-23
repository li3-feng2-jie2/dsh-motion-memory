/**
 * motion-memory 周期总结模块（拆分自 motion-memory.js）
 *
 * 纯逻辑函数：周期素材档位定义与展示名。
 * 由 motion-memory.js 通过 import 引入（Cordis loader 支持相对路径）。
 */

// 素材档位默认值（切 scope 时若未指定档位则用该 scope 的默认）
export const SCOPE_DEFAULTS = { 1: 'events-nomodel', 2: 'first-last', 3: 'infer' }

export function scopeLabelOf(scope, detail) {
  const s = Number(scope) || 1
  const d = detail || SCOPE_DEFAULTS[s]
  const base = { 1: '仅记忆', 2: '会话首尾', 3: '无模型推理' }[s] || '仅记忆'
  const detailName = {
    events: '仅事件记忆', 'events-nomodel': '事件+无模型',
    first: '会话首轮', 'first-last': '会话首尾轮',
    infer: '逐轮推理（用户态度）', 'infer-full': '推理+跳工具输出', 'infer-tail': '推理+只留末尾k',
  }[d] || d
  return '方案' + s + '·' + detailName + '（' + base + '）'
}
