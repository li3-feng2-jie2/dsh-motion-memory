/**
 * motion-memory 版本更新域模块（拆分自 motion-memory.js，C 档）
 *
 * 版本检查/更新：git 分支（fetch/pull）与非 git 分支（清单驱动增量下载覆盖）。
 * 依赖经 createUpdate(core, deps) 注入：core 为共享运行时，deps 提供
 *   { execFileCb, createHash }（node 模块，由主文件顶层 import 传入）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, rmSync, rmdirSync, unlinkSync } from 'node:fs'
// 版本配对域（纯函数 + 本机 DSH 版本探测）：检查更新的提示按"插件版本 ↔ DSH 版本"口径给出
import { loadCompatTable, pluginVersionOf, detectDshVersion, evaluatePairing, pairingLine, cmpVer, normPolicy, policyLabel, pairingLevel, levelLabel, updateTarget } from './compat.mjs'

export function createUpdate(core, deps) {
  const { execFileCb, createHash } = deps || {}
  const {
    state, ctx, p, pluginGitDir, pluginDir, readJsonFileNative, parseRemoteJson,
    nativeWriteAllowed, cfg, nowIso, dshHome, dshProfile,
  } = core

  const UPDATE_PROJECT_URL = 'https://github.com/li3-feng2-jie2/dsh-motion-memory'

  function execGit(args, opts) {
    return new Promise((resolve) => {
      try {
        execFileCb('git', args, Object.assign({ timeout: 20000, windowsHide: true, encoding: 'utf8' }, opts || {}), (err, stdout, stderr) => {
          if (err) resolve({ ok: false, error: String(stderr || err.message || '').trim() || String(err.message || '') })
          else resolve({ ok: true, out: String(stdout || '').trim() })
        })
      } catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }) }
    })
  }
  async function pluginVersionInfo() {
    const dir = pluginGitDir()
    if (!dir) return { git: false, version: '0.1.0', projectUrl: UPDATE_PROJECT_URL }
    const tag = await execGit(['describe', '--tags', '--always'], { cwd: dir })
    const head = await execGit(['rev-parse', '--short', 'HEAD'], { cwd: dir })
    const remote = await execGit(['remote', 'get-url', 'origin'], { cwd: dir })
    const pkg = readJsonFileNative(p(dir, 'package.json'))
    return {
      git: true, dir, version: (pkg && pkg.version) || '0.1.0',
      tag: tag.ok ? tag.out : '', head: head.ok ? head.out : '',
      remote: remote.ok ? remote.out : '',
      projectUrl: (pkg && pkg.repository && pkg.repository.url) ? String(pkg.repository.url).replace(/^git\+/, '').replace(/\.git$/, '') : UPDATE_PROJECT_URL,
    }
  }
  // 更新范围策略（配置项 updatePolicy）：exact=只认精确配对 / epoch=默认，精确配对+同接口世代 / family=再放宽到同子版本族
  function curPolicy() {
    try { return normPolicy(cfg() && cfg().updatePolicy) } catch (e) { return 'epoch' }
  }
  function curDsh() {
    return detectDshVersion({ pluginDir: pluginDir(), home: dshHome ? dshHome() : '', profile: dshProfile ? dshProfile() : '' })
  }
  // ── 版本配对（插件版本 ↔ DSH 版本）────────────────────────────────────
  // 本机信息：插件版本（自身 package.json）+ 本机 DSH 版本（磁盘探测）+ 本机自带适配表（compat.json）的判定，
  // 以及"在更新范围策略下，本机能升到的最新插件版本"。纯本地读取、不联网。
  function localPairing() {
    const dir = pluginDir()
    const table = loadCompatTable(dir)
    const plugin = pluginVersionOf(dir) || '?'
    const dsh = curDsh()
    const r = evaluatePairing(table, plugin, dsh.version)
    const policy = curPolicy()
    // 更新目标 = 策略允许范围内、适配本机 DSH 的最高插件版本
    const target = updateTarget(table, dsh.version, policy)
    const lines = [pairingLine(r)]
    if (target && target.version === plugin) lines[0] += ' · 已是最新'
    else if (target && cmpVer(target.version, plugin) > 0) lines[0] += ' · 可更新至 v' + target.version + (target.level === 'exact' ? '' : '（' + target.label + '）')
    else lines[0] += ' · 无适配本机的可更新版本'
    return {
      plugin, dsh: dsh.version, dshVersion: dsh.version, dshSource: dsh.source || '', status: r.status, label: r.label,
      policy, policyLabel: policyLabel(policy),
      latestStable: target ? target.version : '', target,
      text: lines.join('\n'),
    }
  }
  // 远端适配表：git 安装读远端分支里的 compat.json；手动安装取 GitHub raw（都失败返回 null，不影响检查结果）
  async function remoteCompatTable(dir) {
    try {
      if (dir) {
        const r = await execGit(['show', '@{u}:compat.json'], { cwd: dir, timeout: 15000 })
        if (r.ok && r.out) {
          const t = JSON.parse(r.out.charCodeAt(0) === 0xFEFF ? r.out.slice(1) : r.out)
          if (t && Array.isArray(t.entries)) return t
        }
        return null
      }
      const resp = await fetch('https://raw.githubusercontent.com/li3-feng2-jie2/dsh-motion-memory/main/compat.json', { signal: AbortSignal.timeout(15000) })
      if (!resp || !resp.ok) return null
      const t = await parseRemoteJson(resp)
      return (t && Array.isArray(t.entries)) ? t : null
    } catch (e) { return null }
  }
  // 远端版本"为什么不能升"的一句话（适配表里它写给哪些 DSH 用）
  function notEligibleReason(table, remoteVersion, dshVersion) {
    const r = evaluatePairing(table, remoteVersion, dshVersion)
    const list = (r.entry && Array.isArray(r.entry.stable)) ? r.entry.stable.join('/') : ''
    return list ? ('远端 v' + remoteVersion + ' 适配 DSH ' + list + '，不在更新范围') : ('远端 v' + remoteVersion + ' 不在更新范围（' + r.label + '）')
  }
  // 远端最新版本号（git 模式读 @{u} 的 package.json）
  async function remoteVersionOf(dir) {
    if (!dir) return ''
    try {
      const r = await execGit(['show', '@{u}:package.json'], { cwd: dir, timeout: 15000 })
      if (!r.ok || !r.out) return ''
      const pkg = JSON.parse(r.out.charCodeAt(0) === 0xFEFF ? r.out.slice(1) : r.out)
      return String((pkg && pkg.version) || '')
    } catch (e) { return '' }
  }
  // 版本号比较（语义化 vX.Y.Z）：a>b 返回 1，相等 0，a<b 返回 -1
  function compareVersions(a, b) {
    const pa = String(a || '0').replace(/^v/i, '').split('.').map(n => Number(n) || 0)
    const pb = String(b || '0').replace(/^v/i, '').split('.').map(n => Number(n) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0
      if (x > y) return 1
      if (x < y) return -1
    }
    return 0
  }
  // MANIFEST 哈希值归一化：清单存 "sha256:<hex>"，digest('hex') 产出纯 hex，统一去掉前缀再比较
  function normHash(v) {
    return String(v || '').replace(/^sha256:/i, '').trim()
  }
  // MANIFEST 哈希的行尾归一化比较：MANIFEST 历史上是按 Windows 检出的 CRLF 工作区算哈希，
  // 而 GitHub raw / git archive 给的是 LF 字节 → 直接比 sha256 会恒不匹配（非 git 安装的更新从来没成功过）。
  // 两种字节形态都算一遍，命中任一即视为一致；将来改成按 LF 重建 MANIFEST 也照样兼容。
  function hashMatches(buf, expected) {
    const want = normHash(expected)
    if (!want) return false
    if (createHash('sha256').update(buf).digest('hex') === want) return true
    // 行尾形态可能不同：清单可能按 CRLF（Windows 检出）或 LF（仓库/raw）算过哈希，
    // 两个方向都归一化后再比，命中任一即视为一致。
    const s = String(buf)
    const lf = s.replace(/\r\n/g, '\n')
    const variants = [lf, lf.replace(/\n/g, '\r\n')]
    const seen = {}
    for (const v of variants) {
      if (v === s || seen[v]) continue
      seen[v] = 1
      if (createHash('sha256').update(Buffer.from(v, 'utf8')).digest('hex') === want) return true
    }
    return false
  }
  // 检查更新（git 分支：fetch 对比提交；非 git 分支：版本号对比）
  async function checkUpdate() {
    const dir = pluginGitDir()
    const lp = localPairing()
    if (dir) {
      const info = await pluginVersionInfo()
      const fet = await execGit(['fetch', 'origin'], { cwd: dir, timeout: 30000 })
      if (!fet.ok) return { ok: false, text: '检查更新失败：' + fet.error + '（请确认 git 与网络可用）\n' + lp.text + '\n项目地址：' + info.projectUrl, info, pairing: lp, projectUrl: info.projectUrl }
      const behind = await execGit(['rev-list', '--count', 'HEAD..@{u}'], { cwd: dir })
      const latest = await execGit(['log', '-1', '--format=%h %s', '@{u}'], { cwd: dir })
      const behindN = behind.ok ? (Number(behind.out) || 0) : 0
      // ── 更新范围门（用户 2026-09-19 要求）：只把"与本机 DSH 配对（按 updatePolicy 放宽）"的远端版本当作可更新目标 ──
      const remoteVer = await remoteVersionOf(dir)
      const remoteTable = (behindN > 0 || remoteVer) ? await remoteCompatTable(dir) : null
      const level = remoteVer ? pairingLevel(remoteTable || loadCompatTable(pluginDir()), remoteVer, lp.dshVersion, lp.policy) : ''
      const newer = !!remoteVer && cmpVer(remoteVer, lp.plugin) > 0
      const canUpdate = newer && !!level
      return {
        ok: true, hasUpdate: canUpdate, behind: behindN, mode: 'git', eligible: !!level, remoteVersion: remoteVer,
        info: Object.assign({}, info, { latest: latest.ok ? latest.out : '' }),
        pairing: lp,
        projectUrl: info.projectUrl,
        text: '本机 v' + lp.plugin +
          (canUpdate
            ? ' · 可更新至 v' + remoteVer + '（' + levelLabel(level) + '）\n点"更新"拉取，重启 DSH 生效'
            : newer
              ? ' · ' + (remoteTable ? notEligibleReason(remoteTable, remoteVer, lp.dshVersion) : '远端适配表取不到，按 fail-closed 不提示更新')
              : ' · 已是最新') +
          '\n' + pairingLine(lp) + pendingLine(),
      }
    }
    // 非 git 分支：版本号判断（手动复制安装）。远端版本 = GitHub raw 的 package.json version
    const localPkg = readJsonFileNative(p(pluginDir(), 'package.json'))
    const localVer = (localPkg && localPkg.version) || '0.1.0'
    let remoteVer = ''
    let remoteUrl = ''
    try {
      const r = await fetch('https://raw.githubusercontent.com/li3-feng2-jie2/dsh-motion-memory/main/package.json', { signal: AbortSignal.timeout(15000) })
      if (r && r.ok) {
        const rj = await parseRemoteJson(r)
        remoteVer = (rj && rj.version) || ''
        remoteUrl = (rj && rj.repository && rj.repository.url) ? String(rj.repository.url).replace(/^git\+/, '').replace(/\.git$/, '') : UPDATE_PROJECT_URL
      }
    } catch (e) { return { ok: false, text: '检查更新失败：' + ((e && e.message) || e) + '（请确认网络可用）\n' + lp.text + '\n项目地址：' + UPDATE_PROJECT_URL, info: null, pairing: lp, projectUrl: UPDATE_PROJECT_URL, mode: 'version' } }
    if (!remoteVer) return { ok: false, text: '检查更新失败：无法获取远端版本号\n' + lp.text + '\n项目地址：' + UPDATE_PROJECT_URL, info: null, pairing: lp, projectUrl: UPDATE_PROJECT_URL, mode: 'version' }
    const cmp = compareVersions(remoteVer, localVer)
    // 更新范围门：远端最新版本必须落在本机 DSH 允许的范围内（否则不提示更新——更新会把人拖到不配对的版本）
    const remoteTable = cmp > 0 ? await remoteCompatTable('') : null
    const level = cmp > 0 ? pairingLevel(remoteTable || loadCompatTable(pluginDir()), remoteVer, lp.dshVersion, lp.policy) : ''
    const canUpdate = cmp > 0 && !!level
    // 版本不一致且在范围内 → 再拉 MANIFEST 做结构/哈希对比，检查阶段就给出差异清单
    let diffText = ''
    let diffCount = 0
    if (canUpdate) {
      try {
        const mf = await fetch('https://raw.githubusercontent.com/li3-feng2-jie2/dsh-motion-memory/main/MANIFEST.json', { signal: AbortSignal.timeout(20000) })
        if (mf && mf.ok) {
          const manifest = await parseRemoteJson(mf)
          if (manifest && manifest.files && typeof manifest.files === 'object') {
            const base = pluginDir()
            const missing = [], changed = [], extra = []
            const localSeen = {}
            const walkL = (dirAbs) => { try { for (const en of readdirSync(dirAbs, { withFileTypes: true })) { if (en.name === '.git') continue; const full = p(dirAbs, en.name); if (en.isDirectory()) walkL(full); else if (en.isFile()) localSeen[full] = true } } catch (e) {} }
            if (base) walkL(base)
            for (const rel of Object.keys(manifest.files)) {
              const normRel = String(rel).replace(/\//g, '\\')
              const abs = base ? p(base, normRel) : ''
              const localBytes = abs && existsSync(abs) ? readFileSync(abs) : null
              if (!localBytes) { missing.push(rel); continue }
              if (!hashMatches(localBytes, manifest.files[rel])) changed.push(rel)
              if (abs) delete localSeen[abs]
            }
            if (base) extra = Object.keys(localSeen)
            diffCount = missing.length + changed.length
            diffText = '\n差异：' + (missing.length ? '缺失 ' + missing.length + '（' + missing.slice(0, 3).join('、') + (missing.length > 3 ? '…' : '') + '）' : '') +
              (changed.length ? (missing.length ? '；' : '') + '变更 ' + changed.length + '（' + changed.slice(0, 3).join('、') + (changed.length > 3 ? '…' : '') + '）' : '') +
              (extra.length ? '；本地额外 ' + extra.length + '（不删除）' : '') +
              '\n点"更新"增量覆盖（校验哈希后原子替换）'
          }
        }
      } catch (e) {}
    }
    return {
      ok: true, hasUpdate: canUpdate, behind: canUpdate ? 1 : 0, mode: 'version', diffCount, eligible: !!level, remoteVersion: remoteVer,
      info: { git: false, version: localVer, remoteVersion: remoteVer, projectUrl: remoteUrl || UPDATE_PROJECT_URL },
      pairing: lp,
      projectUrl: remoteUrl || UPDATE_PROJECT_URL,
      text: '本机 v' + localVer +
        (canUpdate
          ? ' · 可更新至 v' + remoteVer + '（' + levelLabel(level) + '）' + diffText
          : cmp > 0
            ? ' · ' + (remoteTable ? notEligibleReason(remoteTable, remoteVer, lp.dshVersion) : '远端适配表取不到，按 fail-closed 不提示更新')
            : ' · 已是最新') +
        '\n' + pairingLine(lp) + pendingLine(),
    }
  }
  // 执行更新前的最后一道门（更新范围）：界面按钮已被 hasUpdate 挡住，这里再挡一次，
  // 免得 `memory cmd=update action=apply` 被直接调用时把插件拖到与本机 DSH 不配对的版本上。
  async function updateEligibility() {
    const dir = pluginGitDir()
    const lp = localPairing()
    let remoteVer = ''
    let remoteTable = null
    if (dir) {
      await execGit(['fetch', 'origin'], { cwd: dir, timeout: 30000 })
      remoteVer = await remoteVersionOf(dir)
      remoteTable = await remoteCompatTable(dir)
    } else {
      try {
        const r = await fetch('https://raw.githubusercontent.com/li3-feng2-jie2/dsh-motion-memory/main/package.json', { signal: AbortSignal.timeout(15000) })
        if (r && r.ok) { const rj = await parseRemoteJson(r); remoteVer = String((rj && rj.version) || '') }
      } catch (e) { return { ok: false, updateBlocked: true, text: '更新已阻止：拿不到远端版本信息' } }
      remoteTable = await remoteCompatTable('')
    }
      if (!remoteVer) return { ok: false, updateBlocked: true, text: '更新已阻止：拿不到远端版本号' }
            if (cmpVer(remoteVer, lp.plugin) <= 0) return { ok: true, noop: true, pairing: lp, text: '已是最新（v' + lp.plugin + '）' }
      if (!remoteTable) return { ok: false, updateBlocked: true, text: '更新已阻止：拿不到远端适配表，按 fail-closed 不更新\n' + lp.text }
    const level = pairingLevel(remoteTable, remoteVer, lp.dshVersion, lp.policy)
    if (!level) {
      const r = evaluatePairing(remoteTable, remoteVer, lp.dshVersion)
      return {
        ok: false, updateBlocked: true, remoteVersion: remoteVer,
          text: '更新已阻止：远端 v' + remoteVer + ' 不在更新范围（' + r.label + '）\n' + lp.text +
            '\n要装的话：换配对的版本，或在设置页调整更新范围。',
      }
    }
    return { ok: true, remoteVersion: remoteVer, level, pairing: lp }
  }
  // ── 两阶段更新（用户定调 2026-09-25）──────────────────────────────────────
  // ① 下载：只把新版文件放进插件目录旁的暂存区（.motion-memory-pending/），
  //    绝不改动正在运行的插件文件；② 激活：重启后插件启动自检发现完整暂存，
  //    备份旧文件后原子替换；本次仍由旧代码运行（再重启一次加载新代码）。
  // 包管理器安装（目录位于 node_modules 内）不支持就地激活：写它会污染 pnpm store，
  // 应改用 DSH 插件页 / dsh plugin update。
  function pendingRoot() { const b = pluginDir(); return b ? p(b, '.motion-memory-pending') : '' }
  function pendingMetaPath() { const r = pendingRoot(); return r ? p(r, 'pending.json') : '' }
  function readPending() {
    try {
      const m = readJsonFileNative(pendingMetaPath())
      return (m && m.version && Array.isArray(m.files)) ? m : null
    } catch (e) { return null }
  }
  function insideNodeModules(dir) { return /[\\/]node_modules[\\/]/i.test(String(dir || '')) }
  function pendingLine() {
    const m = readPending()
    if (!m) return ''
    return '\n已下载 v' + m.version + '（' + m.files.length + ' 个文件，下载于 ' + (m.at || '') + '）：重启 DSH 后由插件自检激活。'
  }
  // 执行更新 = 【只下载】：不改动正在运行的插件文件；替换发生在重启后的启动自检。
  async function applyUpdate() {
    const existing = readPending()
    if (existing) return { ok: true, downloaded: true, pending: existing.version, text: '已下载 v' + existing.version + '，请重启 DSH 后由插件自检激活。' }
    const gate = await updateEligibility()
          if (gate && gate.noop) return { ok: true, text: gate.text, pairing: gate.pairing || null }
    if (!gate || !gate.ok) return gate || { ok: false, text: '更新已阻止：更新范围检查失败' }
    const dir = pluginGitDir()
    if (dir) {
      const fet = await execGit(['fetch', 'origin'], { cwd: dir, timeout: 30000 })
      if (!fet.ok) return { ok: false, text: '下载失败：' + fet.error + '（请确认 git 与网络可用）' }
      const behind = await execGit(['rev-list', '--count', 'HEAD..@{u}'], { cwd: dir })
      return { ok: true, downloaded: true, text: '已下载远端引用（落后 ' + (behind.ok ? behind.out : '?') + ' 个提交），未改动工作区文件。请重启 DSH，重启后自检执行 ff-only 合并激活。' }
    }
    return downloadUpdateFromManifest()
  }
  // 清单驱动的下载（非 git 安装）：只把缺失/变化文件下载到暂存区并校验哈希，
  // 写 pending.json 供重启后激活；不触碰当前插件文件。
  async function downloadUpdateFromManifest() {
    const base = pluginDir()
    if (!base) return { ok: false, text: '无法定位插件目录，下载中止' }
    if (insideNodeModules(base)) return { ok: false, text: '当前插件由包管理器安装（目录在 node_modules 内），就地写会污染包缓存；请用 DSH 插件页 / dsh plugin 更新。' }
    try {
      const mf = await fetch('https://raw.githubusercontent.com/li3-feng2-jie2/dsh-motion-memory/main/MANIFEST.json', { signal: AbortSignal.timeout(20000) })
      if (!mf || !mf.ok) return { ok: false, text: '无法获取远端文件清单（MANIFEST.json），请检查网络' }
      const manifest = await parseRemoteJson(mf)
      const remoteVer = String((manifest && manifest.version) || '')
      if (!remoteVer || !manifest.files || typeof manifest.files !== 'object') return { ok: false, text: '远端文件清单格式无效' }
      const localPkg = readJsonFileNative(p(base, 'package.json'))
      const localVer = (localPkg && localPkg.version) || '0.1.0'
      if (compareVersions(remoteVer, localVer) <= 0) return { ok: true, text: '已是最新版本（v' + localVer + '），无需下载' }
      const root = pendingRoot()
      const filesDir = p(root, 'files')
      rmSyncSafe(root)
      mkdirSync(filesDir, { recursive: true })
      const entries = []
      for (const rel of Object.keys(manifest.files)) {
        const expected = manifest.files[rel]
        const normRel = String(rel).replace(/\\/g, '/')
        const localAbs = p(base, normRel)
        const localBytes = existsSync(localAbs) ? readFileSync(localAbs) : null
        if (localBytes && hashMatches(localBytes, expected)) continue
        const rawUrl = 'https://raw.githubusercontent.com/li3-feng2-jie2/dsh-motion-memory/main/' + normRel
        const resp = await fetch(rawUrl, { signal: AbortSignal.timeout(30000) })
        if (!resp || !resp.ok) { rmSyncSafe(root); return { ok: false, text: '下载失败：' + normRel + '（HTTP ' + (resp && resp.status) + '），已清理暂存，未改动插件' } }
        const buf = Buffer.from(await resp.arrayBuffer())
        if (!hashMatches(buf, expected)) { rmSyncSafe(root); return { ok: false, text: '校验失败：' + normRel + '（哈希不匹配），已清理暂存，未改动插件' } }
        const stagingAbs = p(filesDir, normRel)
        mkdirSync(stagingAbs.slice(0, stagingAbs.lastIndexOf('/')), { recursive: true })
        writeFileSync(stagingAbs, buf)
        entries.push({ rel: normRel, hash: normHash(expected) })
      }
      writeFileSync(pendingMetaPath(), JSON.stringify({ version: remoteVer, from: localVer, at: nowIso(), files: entries }, null, 2) + '\n', 'utf8')
      if (!entries.length) return { ok: true, downloaded: true, pending: remoteVer, text: '远端 v' + remoteVer + ' 的文件与本地一致（仅版本号差异），已记录；重启 DSH 后同步版本号。' }
      return { ok: true, downloaded: true, pending: remoteVer, text: '已下载 v' + remoteVer + '（' + entries.length + ' 个文件）到暂存区，未改动当前插件。请重启 DSH，重启后由插件自检激活。' }
    } catch (e) {
      return { ok: false, text: '下载失败：' + ((e && e.message) || e) + '（未改动插件）' }
    }
  }
  // 启动自检激活（重启后执行）：暂存完整 → 备份旧文件并原子替换；git 工作副本则 ff-only 合并。
  async function activatePendingUpdate() {
    const base = pluginDir()
    if (!base) return { ok: false, skipped: true, text: '无法定位插件目录，跳过激活' }
    const dir = pluginGitDir()
    if (dir) {
      try {
        const fet = await execGit(['fetch', 'origin'], { cwd: dir, timeout: 30000 })
        if (!fet.ok) return { ok: false, skipped: true, text: 'git 激活失败：' + fet.error }
        const behind = await execGit(['rev-list', '--count', 'HEAD..@{u}'], { cwd: dir })
        const n = behind.ok ? (Number(behind.out) || 0) : 0
        if (!n) return { ok: false, skipped: true, text: 'git 工作副本已是最新，无需激活' }
        const merge = await execGit(['merge', '--ff-only', '@{u}'], { cwd: dir, timeout: 60000 })
        if (!merge.ok) return { ok: false, text: 'git 激活失败（ff-only 合并被拒）：' + merge.error }
        const v = await remoteVersionOf(dir)
        state.lastActivation = { version: v, at: nowIso(), files: n, mode: 'git' }
        return { ok: true, version: v, files: n, text: '已激活 git 工作副本（合并 ' + n + ' 个提交）。本次仍由旧代码运行，请再重启一次 DSH 让它生效。' }
      } catch (e) { return { ok: false, text: 'git 激活异常：' + ((e && e.message) || e) } }
    }
    const pending = readPending()
    if (!pending) return { ok: false, skipped: true, text: '没有待激活的更新' }
    if (insideNodeModules(base)) return { ok: false, text: '当前插件由包管理器安装（node_modules 内），不支持就地激活；请用 DSH 插件页 / dsh plugin 更新。' }
    const root = pendingRoot()
    const filesDir = p(root, 'files')
    const files = Array.isArray(pending.files) ? pending.files : []
    if (files.length) {
      const missing = [], bad = []
      for (const f of files) {
        const rel = String((f && f.rel) || '').replace(/\\/g, '/')
        const src = rel ? p(filesDir, rel) : ''
        if (!src || !existsSync(src)) { missing.push(rel || '(空)'); continue }
        if (!hashMatches(readFileSync(src), f.hash)) bad.push(rel)
      }
      if (missing.length || bad.length) return { ok: false, text: '待激活文件不完整（缺失 ' + missing.length + '、校验失败 ' + bad.length + '），暂存保留，下次重启重试。' }
      const bak = p(base, '.motion-memory-bak')
      try { mkdirSync(bak, { recursive: true }) } catch (e) {}
      for (const f of files) {
        const rel = String((f && f.rel) || '').replace(/\\/g, '/')
        const abs = p(base, rel)
        const src = p(filesDir, rel)
        if (!nativeWriteAllowed(abs)) return { ok: false, text: '激活被拒绝：目标不在插件目录内（' + rel + '）' }
        try {
          if (existsSync(abs)) {
            const bakAbs = p(bak, rel)
            mkdirSync(bakAbs.slice(0, bakAbs.lastIndexOf('/')), { recursive: true })
            writeFileSync(bakAbs, readFileSync(abs))
          }
          mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true })
          writeFileSync(abs, readFileSync(src))
        } catch (e) { return { ok: false, text: '激活失败于 ' + rel + '：' + ((e && e.message) || e) } }
      }
    }
    try {
      const pkgAbs = p(base, 'package.json')
      const pkg = readJsonFileNative(pkgAbs)
      if (pkg && pending.version && pkg.version !== pending.version && nativeWriteAllowed(pkgAbs)) {
        pkg.version = pending.version
        writeFileSync(pkgAbs, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
      }
    } catch (e) {}
    rmSyncSafe(root)
    state.lastActivation = { version: pending.version, at: nowIso(), files: files.length }
    return { ok: true, version: pending.version, files: files.length, text: '已激活 v' + pending.version + '（替换 ' + files.length + ' 个文件，旧文件备份在 .motion-memory-bak）。本次仍由旧代码运行，请再重启一次 DSH 让它生效。' }
  }
  // 更新缓存清理：删除临时目录内容；备份目录由下次更新重建（只留最近一份）
  function cleanupUpdateCache(tmpDir) {
    try { rmSyncSafe(tmpDir) } catch (e) {}
  }
  // 递归删除（ESM 下直接用 node:fs rmSync，失败降级手动递归）
  function rmSyncSafe(target) {
    try { rmSync(target, { recursive: true, force: true }) }
    catch (e) { try { rmRecursiveSafe(target) } catch (e2) {} }
  }
  function rmRecursiveSafe(target) {
    if (!existsSync(target)) return
    const st = statSync(target)
    if (st.isDirectory()) {
      for (const en of readdirSync(target)) rmRecursiveSafe(p(target, en))
      try { rmdirSync(target) } catch (e) {}
    } else { try { unlinkSync(target) } catch (e) {} }
  }
  // memory cmd=update（action=check 检查 / download|apply 下载到暂存 / activate 立即激活 / status 待激活状态）
  async function memCmdUpdate(args, meta) {
    const action = (args && args.action) || 'check'
    if (action === 'activate') return activatePendingUpdate()
    if (action === 'status') {
      const m = readPending()
      return { ok: true, pending: m ? m.version : '', text: m ? ('已下载 v' + m.version + '，重启 DSH 后由插件自检激活') : '没有待激活的更新' }
    }
    if (action === 'apply' || action === 'download') return applyUpdate()
    return checkUpdate()
  }
  // 自动更新检查：结果缓存到 state.lastUpdateCheck（设置页/命令可读，避免频繁 fetch）
  async function autoUpdateCheck() {
    const r = await checkUpdate().catch(() => ({ ok: false, text: '更新检查失败' }))
    state.lastUpdateCheck = Object.assign({ at: nowIso() }, r)
    if (r && r.ok && r.hasUpdate) console.log('[motion-memory] 检测到新版本（落后 ' + r.behind + ' 个提交），可在设置页"版本与更新"执行更新')
    return state.lastUpdateCheck
  }
  // 启动后 8 秒检查一次，之后每 12 小时一次（生命周期自动清理）
  let autoTimerId = null
  function startAutoUpdateCheck() {
    try {
      // 自动检查开关（默认开）：关 = 不启动定时器，仅手动检查
      if (cfg().autoUpdateCheck === false) return
      const bootTimer = setTimeout(() => {
        autoUpdateCheck().catch(() => {})
        scheduleLoop()
      }, 8000)
      function scheduleLoop() {
        autoTimerId = setTimeout(() => { autoUpdateCheck().catch(() => {}); scheduleLoop() }, 12 * 3600 * 1000)
      }
      const disposer = () => {
        try { if (bootTimer) clearTimeout(bootTimer) } catch (e) {}
        try { if (autoTimerId) clearTimeout(autoTimerId) } catch (e) {}
      }
      try { if (ctx && typeof ctx.effect === 'function') ctx.effect(disposer) } catch (e) {}
    } catch (e) {}
  }

  return {
    UPDATE_PROJECT_URL, execGit, pluginVersionInfo, compareVersions, checkUpdate,
    applyUpdate, downloadUpdateFromManifest, cleanupUpdateCache, rmSyncSafe, rmRecursiveSafe,
    memCmdUpdate, autoUpdateCheck, startAutoUpdateCheck, localPairing, updateEligibility, hashMatches,
    activatePendingUpdate, readPending, pendingRoot,
  }
}
