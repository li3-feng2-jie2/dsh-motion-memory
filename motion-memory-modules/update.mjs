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
          '\n' + pairingLine(lp),
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
        '\n' + pairingLine(lp),
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
      if (cmpVer(remoteVer, lp.plugin) <= 0) return { ok: true, noop: true, text: '已是最新（v' + lp.plugin + '）' }
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
  // 执行更新（git 分支：pull --ff-only；非 git 分支：清单驱动增量下载覆盖）
  async function applyUpdate() {
    const gate = await updateEligibility()
    if (gate && gate.noop) return { ok: true, text: gate.text, pairing: gate.pairing }
    if (!gate || !gate.ok) return gate || { ok: false, text: '更新已阻止：更新范围检查失败' }
    const dir = pluginGitDir()
    if (dir) {
      const pull = await execGit(['pull', '--ff-only'], { cwd: dir, timeout: 60000 })
      if (!pull.ok) return { ok: false, text: '更新失败：' + pull.error + '（请先处理本地未提交改动）' }
      const head = await execGit(['rev-parse', '--short', 'HEAD'], { cwd: dir })
      return { ok: true, text: '已更新到 v' + gate.remoteVersion + '（提交 ' + (head.ok ? head.out : '?') + '），请重启 DSH 生效。\n' + pull.out, data: { head: head.ok ? head.out : '', version: gate.remoteVersion } }
    }
    // 非 git：清单驱动增量下载覆盖（MANIFEST 对比 → 下载变化文件 → 校验 → 原子覆盖 → 备份/清理）
    return downloadUpdateFromManifest()
  }
  // 清单驱动增量更新（非 git 手动安装）：从 GitHub raw 拉 MANIFEST.json（文件清单+哈希+版本），
  // 对比本地只下载变化文件，临时目录校验后原子覆盖；备份保留最近一份，每次更新清理上上版本缓存。
  async function downloadUpdateFromManifest() {
    const base = pluginDir()
    if (!base) return { ok: false, text: '无法定位插件目录，更新中止' }
    try {
      // ① 拉远端 MANIFEST
      const mf = await fetch('https://raw.githubusercontent.com/li3-feng2-jie2/dsh-motion-memory/main/MANIFEST.json', { signal: AbortSignal.timeout(20000) })
      if (!mf || !mf.ok) return { ok: false, text: '无法获取远端文件清单（MANIFEST.json），请检查网络' }
      const manifest = await parseRemoteJson(mf)
      const remoteVer = String((manifest && manifest.version) || '')
      if (!remoteVer || !manifest.files || typeof manifest.files !== 'object') return { ok: false, text: '远端文件清单格式无效' }
      const localPkg = readJsonFileNative(p(base, 'package.json'))
      const localVer = (localPkg && localPkg.version) || '0.1.0'
      if (compareVersions(remoteVer, localVer) <= 0) return { ok: true, text: '已是最新版本（v' + localVer + '），无需更新' }
      // ② 对比本地：找出需要更新的文件（缺失 / 哈希不同）
      const toUpdate = []
      const localFiles = {}
      const walkLocal = (dirAbs) => {
        try {
          const entries = readdirSync(dirAbs, { withFileTypes: true })
          for (const en of entries) {
            if (en.name === '.git') continue
            const full = p(dirAbs, en.name)
            if (en.isDirectory()) walkLocal(full)
            else if (en.isFile()) localFiles[full] = true
          }
        } catch (e) {}
      }
      walkLocal(base)
      for (const rel of Object.keys(manifest.files)) {
        const remoteHash = normHash(manifest.files[rel])
        // 路径统一 / 分隔（p() 输出即 /；远端清单也是 /）
        const normRel = String(rel).replace(/\\/g, '/')
        const normAbs = p(base, normRel)
        const localBytes = existsSync(normAbs) ? readFileSync(normAbs) : null
        if (!localBytes) { toUpdate.push({ rel, abs: normAbs }); continue }
        if (!hashMatches(localBytes, remoteHash)) toUpdate.push({ rel, abs: normAbs })
        delete localFiles[normAbs]
      }
      // 多余文件（远端清单没有的本地文件）：不删除，仅记录（避免误伤用户自加文件）
      const extraFiles = Object.keys(localFiles)
      if (!toUpdate.length) {
        // 版本号比远端旧但文件哈希全一致（本地手动改过但内容等价）→ 更新 package.json 版本
        const pkgAbs = p(base, 'package.json')
        const pkg = readJsonFileNative(pkgAbs) || {}
        pkg.version = remoteVer
        nativeWriteAllowed(pkgAbs) && writeFileSync(pkgAbs, JSON.stringify(pkg, null, 1), 'utf8')
        return { ok: true, text: '文件已是最新（版本号同步为 v' + remoteVer + '），请重启 DSH 生效' + (extraFiles.length ? '\n（忽略本地额外文件 ' + extraFiles.length + ' 个）' : '') }
      }
      // ③ 下载到临时目录 → 校验 → 原子覆盖
      const tmpDir = p(base, '.motion-memory-tmp')
      const bakDir = p(base, '.motion-memory-bak')
      try { mkdirSync(tmpDir, { recursive: true }); rmSyncSafe(tmpDir) } catch (e) {}
      mkdirSync(tmpDir, { recursive: true })
      const downloaded = []
      for (const f of toUpdate) {
        const rawUrl = 'https://raw.githubusercontent.com/li3-feng2-jie2/dsh-motion-memory/main/' + f.rel.replace(/\\/g, '/')
        const resp = await fetch(rawUrl, { signal: AbortSignal.timeout(30000) })
        if (!resp || !resp.ok) { cleanupUpdateCache(tmpDir); return { ok: false, text: '下载失败：' + f.rel + '（HTTP ' + (resp && resp.status) + '），已清理临时文件，未改动插件' } }
        const buf = Buffer.from(await resp.arrayBuffer())
        if (!hashMatches(buf, manifest.files[f.rel])) { cleanupUpdateCache(tmpDir); return { ok: false, text: '校验失败：' + f.rel + '（哈希不匹配），已清理临时文件，未改动插件' } }
        const normRelT = String(f.rel).replace(/\\/g, '/')
        const tmpAbs = p(tmpDir, normRelT)
        mkdirSync(tmpAbs.slice(0, tmpAbs.lastIndexOf('/')), { recursive: true })
        writeFileSync(tmpAbs, buf)
        downloaded.push({ rel: f.rel, abs: f.abs, tmpAbs })
      }
      // ④ 备份旧文件（保留最近一份，清掉更早的）
      try { mkdirSync(bakDir, { recursive: true }); rmSyncSafe(bakDir) } catch (e) {}
      mkdirSync(bakDir, { recursive: true })
      for (const f of downloaded) {
        if (existsSync(f.abs)) {
          const bakAbs = p(bakDir, String(f.rel).replace(/\\/g, '/'))
          mkdirSync(bakAbs.slice(0, bakAbs.lastIndexOf('/')), { recursive: true })
          writeFileSync(bakAbs, readFileSync(f.abs))
        }
      }
      // ⑤ 原子覆盖（全部就绪后一次性替换）
      for (const f of downloaded) {
        mkdirSync(f.abs.slice(0, f.abs.lastIndexOf('/')), { recursive: true })
        writeFileSync(f.abs, readFileSync(f.tmpAbs))
      }
      // ⑥ 清理：临时目录删除；备份只保留最近一份（本次已写入，删除后下次再建）
      cleanupUpdateCache(tmpDir)
      const extraNote = extraFiles.length ? '\n（忽略本地额外文件 ' + extraFiles.length + ' 个，未删除）' : ''
      return { ok: true, text: '已更新到 v' + remoteVer + '（更新 ' + downloaded.length + ' 个文件），请重启 DSH 生效。\n备份保留在 .motion-memory-bak（最近一份）。' + extraNote, data: { version: remoteVer, updated: downloaded.length } }
    } catch (e) {
      return { ok: false, text: '更新失败：' + ((e && e.message) || e) + '（未改动插件文件）' }
    }
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
  // memory cmd=update（action=check 检查 / apply 更新）
  async function memCmdUpdate(args, meta) {
    const action = (args && args.action) || 'check'
    if (action === 'apply') return applyUpdate()
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
  }
}
