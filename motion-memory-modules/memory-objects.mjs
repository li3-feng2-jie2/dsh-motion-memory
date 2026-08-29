/**
 * motion-memory 记忆文件对象构造模块（拆分自 motion-memory.js，A 档）
 *
 * 纯逻辑层：历史条目、溯源引用、关键词对象、文件名安全化、事件命名。
 * 自洽模块：时间工具从 ./time-utils.mjs 引入，不依赖调用方闭包。
 */

import { pad, nowIso, parts, uid } from './time-utils.mjs'

/** 创建历史条目（histEntry） */
export function histEntry(op, meta) {
  return {
    at: nowIso(),
    agent: (meta && meta.agent) || '',
    session: (meta && meta.session) || '',
    turn: (meta && meta.turn) || 0,
    op,
    note: (meta && meta.note) || '',
    keep: !(meta && meta.keep === false),
    delta: (meta && meta.delta) || [],
    fromPath: meta && meta.fromPath,
    toPath: meta && meta.toPath,
    // v4 #5：模型溯源——记忆工具操作时记录"模型功能+模型名称"，数据污染来源复盘
    modelProvider: meta && meta.modelProvider,
    modelName: meta && meta.modelName,
    toolContext: meta && meta.toolContext,
    // v5：调用定位——step（会话内第几步调用）；times（同 agent+会话 防重合并后的阅读时间数组）
    step: meta && meta.step,
    times: meta && meta.times,
  }
}

/** 溯源引用构造：会话@轮次[:stepN]（meta 有 session+turn 时；step 可选） */
export function turnRefOfMeta(meta) {
  const sid = meta && meta.session
  const turn = meta && meta.turn
  if (!sid || !turn) return ''
  let ref = sid + '@' + Number(turn)
  if (meta.step !== undefined && meta.step !== null) ref += ':step' + Number(meta.step)
  return ref
}

/** 新建关键词记忆对象（newKeywordObj） */
export function newKeywordObj(title, content, reason, meta, links) {
  // 归属兜底：无独立 agent.id 时用会话 id（谁创建的记到谁名下）
  const me = { agent: (meta && (meta.agent || meta.session)) || '', session: (meta && meta.session) || '', turn: (meta && meta.turn) || 0 }
  // v4：自动挂载到本智能体活跃文件（parents 加 active 引用；autoLink 会登记）
  const parents = (links && links.parents) ? links.parents.slice() : []
  const mg = meta && meta.agent
  if (mg && String(mg).indexOf('preset:') === 0 && !parents.some(p => p && p.kind === 'active')) {
    parents.push({ kind: 'active', agent: String(mg) })
  }
  // 创建后默认自动填 会话@轮次[:step] 溯源（用户设计：创建/更新关键词记忆自动带轮次+步信息）
  const children = (links && links.children) ? links.children.slice() : []
  const turnRef = turnRefOfMeta(meta)
  if (turnRef && !children.some(c => c && c.kind === 'turn' && c.ref === turnRef)) {
    children.push({ kind: 'turn', ref: turnRef, location: 'session' })
  }
  return {
    schemaVersion: 1, id: uid(), kind: 'keyword', location: 'important',
    title, reason: reason || '', content: content || '',
    links: { parents, children },
    sourceChain: turnRef ? [turnRef] : [],
    createdAt: nowIso(), updatedAt: nowIso(), lastAccessedAt: nowIso(),
    createdBy: me, lastModifiedBy: me, originalId: null,
    history: [histEntry('create', { ...meta, note: reason || '新建记忆' })],
  }
}

/** 文件名安全化：非法字符 → 下划线，截断 80 */
export function sanitizeFile(name) { return String(name).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || 'untitled' }

/**
 * v5 事件命名：{DD}_{agent}_{会话id}_turn{turn}_{HHMMSS}_{seq}.json
 * （目录已统一为 年/月 两级，日前缀保证同月内文件可区分日期）
 */
export function eventFileName(meta, d, seq) {
  const agent = sanitizeFile((meta && meta.agent) || 'agent')
  const sid = sanitizeFile((meta && meta.session) || 'nosession').slice(-12)
  const turn = (meta && meta.turn) ? 'turn' + Number(meta.turn) : 'turn0'
  const dd = parts(d || new Date()).day
  const hms = pad((d || new Date()).getHours()) + pad((d || new Date()).getMinutes()) + pad((d || new Date()).getSeconds())
  return dd + '_' + agent + '_' + sid + '_' + turn + '_' + hms + '_' + (seq || 1) + '.json'
}
