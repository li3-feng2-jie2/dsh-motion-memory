/**
 * motion-memory 版本配对域（纯函数 + 本机版本探测）
 *
 * 配对口径（与 compat.json 同源）：
 *   stable = 这个「插件版本 ↔ DSH 版本」组合逐条复核过，可稳定使用；
 *   maybe  = 同一子版本族内的其他 DSH 版本（如 0.1.6 只复核了 alpha.2，其余 0.1.6-* 落这里），
 *            可能兼容但未验证；
 *   其他   = 未收录 / 不保证——DSH 的失败方式是 fail-closed（整棵插件树挂载失败、
 *            或整份会话历史打不开），不是"少个功能"，所以版本不同就当作不配对。
 *
 * 本模块**不联网**：远端适配表由 update.mjs 在检查更新时取回，再交给这里的纯函数判定。
 * 本机 DSH 版本从磁盘探测（装好的 dsh 包 / 源码树），可用环境变量 DSH_VERSION 覆盖。
 */

import { existsSync, readFileSync } from 'node:fs'

// ── 版本号工具 ──────────────────────────────────────────────────────────
export function normVer(v) {
  return String(v == null ? '' : v).trim().replace(/^v/i, '')
}
// 子版本族：0.1.6-alpha.2 → 0.1.6（只取前三段数字）
export function familyOf(v) {
  const m = normVer(v).match(/^(\d+\.\d+\.\d+)/)
  return m ? m[1] : ''
}
// 语义化比较：a>b → 1，相等 → 0，a<b → -1（预发布后缀按字符串兜底比较）
export function cmpVer(a, b) {
  const pa = normVer(a).split(/[.\-+]/).filter(s => s !== '')
  const pb = normVer(b).split(/[.\-+]/).filter(s => s !== '')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i]
    // 段数不同：带预发布后缀的（0.1.6-alpha.2）小于同族正式版（0.1.6）
    if (x === undefined) return 1
    if (y === undefined) return -1
    const nx = Number(x), ny = Number(y)
    if (!isNaN(nx) && !isNaN(ny)) { if (nx !== ny) return nx > ny ? 1 : -1; continue }
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}
// 读 JSON（剥 BOM；失败返回 undefined，不抛）
export function readJsonIfExists(file) {
  try {
    if (!file || !existsSync(file)) return undefined
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
    return JSON.parse(text)
  } catch (e) { return undefined }
}

// ── 适配表读取（本地）────────────────────────────────────────────────────
// 插件目录下的 compat.json：随插件发布，是"本机这一版自带的适配表"。
export function loadCompatTable(dir) {
  const t = readJsonIfExists(String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '') + '/compat.json')
  if (!t || !Array.isArray(t.entries)) return null
  return t
}
// 插件自身版本（package.json）
export function pluginVersionOf(dir) {
  const pkg = readJsonIfExists(String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '') + '/package.json')
  return normVer(pkg && pkg.version)
}
export function findEntry(table, pluginVersion) {
  const v = normVer(pluginVersion)
  if (!table || !Array.isArray(table.entries) || !v) return null
  for (const e of table.entries) if (normVer(e && e.plugin) === v) return e
  return null
}
// 接口世代查表：先按精确版本命中，再按子版本族键（如 "0.1.6"）命中，都没有则返回 ''
export function ifaceOf(table, dshVersion) {
  const d = normVer(dshVersion)
  if (!d || !table || !table.iface || typeof table.iface !== 'object') return ''
  if (table.iface[d]) return String(table.iface[d])
  const fam = familyOf(d)
  if (fam && table.iface[fam]) return String(table.iface[fam])
  return ''
}

// ── 配对判定（纯函数）───────────────────────────────────────────────────
// 返回 { status, plugin, dsh, entry, label, advice }
//   status: stable | maybe | unsupported | unlisted | unknown-dsh | no-table
export function evaluatePairing(table, pluginVersion, dshVersion) {
  const plugin = normVer(pluginVersion)
  const dsh = normVer(dshVersion)
  const base = { plugin, dsh, entry: null }
  if (!dsh) {
    return Object.assign(base, {
      status: 'unknown-dsh',
        label: '未探测到 DSH 版本',
        advice: '可用环境变量 DSH_VERSION 指定本机版本后再查。',
    })
  }
  if (!table) {
    return Object.assign(base, {
      status: 'no-table',
        label: '缺少适配表',
        advice: '插件目录里没有适配表。',
    })
  }
  const entry = findEntry(table, plugin)
  if (!entry) {
    return Object.assign(base, {
      status: 'unlisted',
        label: '版本未收录',
        advice: '适配表未收录 v' + plugin + '。',
    })
  }
  const stable = (entry.stable || []).map(normVer)
  const maybe = (entry.maybe || []).map(normVer)
  base.entry = entry
  if (stable.indexOf(dsh) >= 0) {
    return Object.assign(base, {
      status: 'stable',
        label: '精确配对',
        advice: '',
    })
  }
  // 接口世代相同 → 允许放宽（接口没大变动，只是没逐条复核本机这个子版本）
  const myIface = ifaceOf(table, dsh)
  const itsIface = entry.iface ? String(entry.iface) : ''
  if (myIface && itsIface && myIface === itsIface) {
    return Object.assign(base, {
      status: 'epoch',
        label: '同接口世代（未复核本机子版本）',
        advice: '接口世代相同，但本机子版本未复核；出问题先退回 ' + (stable.join('/') || '（无）') + '。',
    })
  }
  const fam = familyOf(dsh)
  const sameFamily = maybe.some(m => m && fam && (normVer(m) === dsh || normVer(m) === fam))
  if (sameFamily) {
    return Object.assign(base, {
      status: 'maybe',
        label: '同族未验证',
        advice: '精确配对的是 ' + (stable.join('/') || '（无）') + '。',
    })
  }
  return Object.assign(base, {
    status: 'unsupported',
      label: '不在适配表',
      advice: '只对 ' + (stable.join('/') || '（无）') + ' 精确配对。',
  })
}

// 一行摘要（设置页 / memory cmd=status / 检查更新共用同一口径）
export function pairingLine(r) {
  if (!r) return '插件版本未知'
  return '插件 v' + (r.plugin || '?') + ' ↔ DSH ' + (r.dsh || '未探测到') + ' · ' + (r.label || '未知')
}

// 适配本机 DSH 的**最新可用插件版本**（在给定适配表里找 status=stable 的最大插件版本）
export function latestStableFor(table, dshVersion) {
  if (!table || !Array.isArray(table.entries)) return ''
  let best = ''
  for (const e of table.entries) {
    const v = normVer(e && e.plugin)
    if (!v) continue
    const r = evaluatePairing(table, v, dshVersion)
    if (r.status !== 'stable') continue
    if (!best || cmpVer(v, best) > 0) best = v
  }
  return best
}
// 更新范围（策略）：
//   exact  = 只认精确配对（stable）；
//   epoch  = 默认，精确配对或同接口世代（接口没大变动时放宽到同世代）；
//   family = 再放宽到同子版本族（maybe，纯"可能兼容"）。
export function normPolicy(policy) {
  return (policy === 'exact' || policy === 'family') ? policy : 'epoch'
}
export function policyLabel(policy) {
  const p = normPolicy(policy)
  return p === 'exact' ? '只认精确配对' : p === 'family' ? '精确配对 + 同世代 + 同族' : '精确配对 + 同接口世代'
}
export function levelLabel(level) {
  return level === 'exact' ? '精确配对'
    : level === 'epoch' ? '同接口世代'
      : level === 'family' ? '同族未验证'
        : '不在可更新范围'
}
// 某版本在策略下可不可作为更新目标 → '' | 'exact' | 'epoch' | 'family'
export function pairingLevel(table, pluginVersion, dshVersion, policy) {
  const pol = normPolicy(policy)
  const r = evaluatePairing(table, pluginVersion, dshVersion)
  const level = r.status === 'stable' ? 'exact' : r.status === 'epoch' ? 'epoch' : r.status === 'maybe' ? 'family' : ''
  if (!level) return ''
  if (pol === 'exact' && level !== 'exact') return ''
  if (pol === 'epoch' && level === 'family') return ''
  return level
}
// 更新目标：策略允许范围内、适配本机 DSH 的最高插件版本（无则 null）
export function updateTarget(table, dshVersion, policy) {
  if (!table || !Array.isArray(table.entries)) return null
  let best = null
  for (const e of table.entries) {
    const v = normVer(e && e.plugin)
    if (!v) continue
    const level = pairingLevel(table, v, dshVersion, policy)
    if (!level) continue
    if (!best || cmpVer(v, best.version) > 0) best = { version: v, level: level, label: levelLabel(level) }
  }
  return best
}

// ── 本机 DSH 版本探测（磁盘，不联网）─────────────────────────────────────
// 顺序：DSH_VERSION 环境变量 → 装好的 dsh 包（profile/profiles node_modules，含从插件目录
// 逐级上溯）→ 源码树根 package.json（name=@deepseek-ai/dsh）。
function parentDirs(start) {
  const out = []
  let cur = String(start || '').replace(/\\/g, '/').replace(/\/+$/, '')
  for (let i = 0; i < 12 && cur; i++) {
    out.push(cur)
    const idx = cur.lastIndexOf('/')
    if (idx <= 0) break
    cur = cur.slice(0, idx)
  }
  return out
}
export function detectDshVersion(opts) {
  const o = opts || {}
  const env = normVer(process.env.DSH_VERSION)
  if (env) return { version: env, path: '', source: 'env DSH_VERSION' }
  const home = String(o.home || process.env.DSH_HOME || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const profile = String(o.profile || process.env.DSH_PROFILE || 'web')
  const starts = []
  if (o.pluginDir) starts.push(o.pluginDir)
  if (o.cwd) starts.push(o.cwd)
  const argv1 = (typeof process !== 'undefined' && process.argv && process.argv[1]) ? String(process.argv[1]).replace(/\\/g, '/') : ''
  if (argv1) {
    const idx = argv1.lastIndexOf('/')
    if (idx > 0) starts.push(argv1.slice(0, idx))
  }
  const cands = []
  if (home) {
    cands.push([home + '/profiles/' + profile + '/node_modules/@deepseek-ai/dsh/package.json', 'profile node_modules'])
    cands.push([home + '/profiles/node_modules/@deepseek-ai/dsh/package.json', 'profiles node_modules'])
  }
  for (const s of starts) {
    for (const d of parentDirs(s)) {
      cands.push([d + '/node_modules/@deepseek-ai/dsh/package.json', 'node_modules @ ' + d])
    }
  }
  // 源码树兜底：仓库根 package.json（name 必须是 @deepseek-ai/dsh，避免误认插件自己的包）
  for (const s of starts) {
    for (const d of parentDirs(s)) cands.push([d + '/package.json', 'source tree ' + d])
  }
  const seen = {}
  for (const pair of cands) {
    const file = pair[0], source = pair[1]
    if (!file || seen[file]) continue
    seen[file] = 1
    const o2 = readJsonIfExists(file)
    if (!o2 || !o2.version) continue
    if (String(o2.name || '') !== '@deepseek-ai/dsh') continue
    return { version: normVer(o2.version), path: file, source }
  }
  return { version: '', path: '', source: '' }
}
