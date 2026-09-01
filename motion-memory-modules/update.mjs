/**
 * motion-memory 版本更新域模块（拆分自 motion-memory.js，C 档）
 *
 * 版本检查/更新：git 分支（fetch/pull）与非 git 分支（清单驱动增量下载覆盖）。
 * 依赖经 createUpdate(core, deps) 注入：core 为共享运行时，deps 提供
 *   { execFileCb, createHash }（node 模块，由主文件顶层 import 传入）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, rmSync, rmdirSync, unlinkSync } from 'node:fs'

export function createUpdate(core, deps) {
  const { execFileCb, createHash } = deps || {}
  const {
    state, ctx, p, pluginGitDir, pluginDir, readJsonFileNative, parseRemoteJson,
    nativeWriteAllowed, cfg, nowIso,
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
  // 检查更新（git 分支：fetch 对比提交；非 git 分支：版本号对比）
  async function checkUpdate() {
    const dir = pluginGitDir()
    if (dir) {
      const info = await pluginVersionInfo()
      const fet = await execGit(['fetch', 'origin'], { cwd: dir, timeout: 30000 })
      if (!fet.ok) return { ok: false, text: '检查更新失败：' + fet.error + '（请确认 git 与网络可用）\n项目地址：' + info.projectUrl, info, projectUrl: info.projectUrl }
      const behind = await execGit(['rev-list', '--count', 'HEAD..@{u}'], { cwd: dir })
      const latest = await execGit(['log', '-1', '--format=%h %s', '@{u}'], { cwd: dir })
      const behindN = behind.ok ? (Number(behind.out) || 0) : 0
      return {
        ok: true, hasUpdate: behindN > 0, behind: behindN, mode: 'git',
        info: Object.assign({}, info, { latest: latest.ok ? latest.out : '' }),
        projectUrl: info.projectUrl,
        text: '版本 v' + info.version + (info.tag ? '（' + info.tag + '）' : '') + ' · 提交 ' + info.head +
          (behindN > 0 ? '\n发现新版本（落后 ' + behindN + ' 个提交，最新：' + (latest.ok ? latest.out : '?') + '）\n点击"更新"拉取（更新后需重启 DSH 生效）' : '\n已是最新版本'),
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
    } catch (e) { return { ok: false, text: '检查更新失败：' + ((e && e.message) || e) + '（请确认网络可用）\n项目地址：' + UPDATE_PROJECT_URL, info: null, projectUrl: UPDATE_PROJECT_URL, mode: 'version' } }
    if (!remoteVer) return { ok: false, text: '检查更新失败：无法获取远端版本号\n项目地址：' + UPDATE_PROJECT_URL, info: null, projectUrl: UPDATE_PROJECT_URL, mode: 'version' }
    const cmp = compareVersions(remoteVer, localVer)
    // 版本不一致 → 再拉 MANIFEST 做结构/哈希对比，检查阶段就给出差异清单
    let diffText = ''
    let diffCount = 0
    if (cmp > 0) {
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
              const lh = createHash('sha256').update(localBytes).digest('hex')
              if (lh !== normHash(manifest.files[rel])) changed.push(rel)
              if (abs) delete localSeen[abs]
            }
            if (base) extra = Object.keys(localSeen)
            diffCount = missing.length + changed.length
            diffText = '\n差异：' + (missing.length ? '缺失 ' + missing.length + '（' + missing.slice(0, 3).join('、') + (missing.length > 3 ? '…' : '') + '）' : '') +
              (changed.length ? (missing.length ? '；' : '') + '变更 ' + changed.length + '（' + changed.slice(0, 3).join('、') + (changed.length > 3 ? '…' : '') + '）' : '') +
              (extra.length ? '；本地额外 ' + extra.length + '（不删除）' : '') +
              '\n点击"更新"按清单增量下载覆盖（校验哈希后原子替换，备份保留最近一份）'
          }
        }
      } catch (e) {}
    }
    return {
      ok: true, hasUpdate: cmp > 0, behind: cmp > 0 ? 1 : 0, mode: 'version', diffCount,
      info: { git: false, version: localVer, remoteVersion: remoteVer, projectUrl: remoteUrl || UPDATE_PROJECT_URL },
      projectUrl: remoteUrl || UPDATE_PROJECT_URL,
      text: '本地版本 v' + localVer + ' · 远端版本 v' + remoteVer +
        (cmp > 0 ? '\n发现新版本（远端 ' + remoteVer + ' > 本地 ' + localVer + '）' + diffText : '\n已是最新版本'),
    }
  }
  // 执行更新（git 分支：pull --ff-only；非 git 分支：清单驱动增量下载覆盖）
  async function applyUpdate() {
    const dir = pluginGitDir()
    if (dir) {
      const pull = await execGit(['pull', '--ff-only'], { cwd: dir, timeout: 60000 })
      if (!pull.ok) return { ok: false, text: '更新失败：' + pull.error + '（请先处理本地未提交改动）' }
      const head = await execGit(['rev-parse', '--short', 'HEAD'], { cwd: dir })
      return { ok: true, text: '已更新（提交 ' + (head.ok ? head.out : '?') + '），请重启 DSH 生效。\n' + pull.out, data: { head: head.ok ? head.out : '' } }
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
        const localHash = createHash('sha256').update(localBytes).digest('hex')
        if (localHash !== remoteHash) toUpdate.push({ rel, abs: normAbs })
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
        const hash = createHash('sha256').update(buf).digest('hex')
        if (hash !== normHash(manifest.files[f.rel])) { cleanupUpdateCache(tmpDir); return { ok: false, text: '校验失败：' + f.rel + '（哈希不匹配），已清理临时文件，未改动插件' } }
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
    memCmdUpdate, autoUpdateCheck, startAutoUpdateCheck,
  }
}
