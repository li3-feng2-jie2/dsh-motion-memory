/**
 * motion-memory 用户画像域模块（批次 B 拆分）
 *
 * 全局用户级记忆文件读写：用户画像 + 用户要求两份文件，跨会话、跨智能体共享
 * （ownerKey 无关——任何智能体读写同一份，首轮总览注入给所有智能体快速了解用户习惯）。
 * 与必要记忆（智能体级：活跃 custom，随总览注入）形成两级：必要 = 智能体细化画像；
 * 本模块 = 用户级画像/要求。
 *
 * 文件位置（记忆根下新目录，与事件/周期/补充并列）：
 *   记忆累积/用户画像/用户画像.json   （kind: user-profile）
 *   记忆累积/用户画像/用户要求.json   （kind: user-requirements）
 *
 * 设计约定（2026-09 用户定调）：
 *   - 不做历史记录展示、不做专门超期归档——内部 history 保留最近若干条（防文件无限膨胀），
 *     按写入时间自然截断，不参与补充区 lazyArchive。
 *   - 两份文件可编辑即可；编辑入口 = memory_add kind=user_profile / kind=user_requirements，
 *     或记忆页面新增「用户画像」页签（mm-profile 独立插件）。
 *
 * 依赖注入：createProfile(core, deps)，core 提供 p/root/readJson/writeJson/nowIso/histEntry/uid。
 */

export function createProfile(core, deps) {
  const {
    p, root, readJson, writeJson, nowIso, histEntry, uid,
  } = core
  const { logWrite } = deps || {}

  /** 用户画像目录（记忆累积/用户画像） */
  function profileDir() {
    return p(root(), '记忆累积', '用户画像')
  }
  /** 两份文件相对路径名（title 语义固定，不做多文件） */
  function profilePathOf(which) {
    return p(profileDir(), (which === 'req' ? '用户要求' : '用户画像') + '.json')
  }
  /** 读取用户画像/用户要求：返回 { ok, content, updatedAt, exists }；无文件 content='' */
  async function readUserProfile(which) {
    const path = profilePathOf(which === 'req' ? 'req' : 'profile')
    try {
      const o = await readJson(path)
      if (o && !o.tombstone) {
        return { ok: true, content: String(o.content || ''), updatedAt: o.updatedAt || o.createdAt || '', exists: true }
      }
    } catch (e) {}
    return { ok: true, content: '', updatedAt: '', exists: false }
  }
  /** 写入用户画像/用户要求（覆盖写，history 追加后截断最近 20 条） */
  async function saveUserProfile(which, content, meta) {
    const path = profilePathOf(which === 'req' ? 'req' : 'profile')
    const o = await readJson(path).catch(() => null)
    const base = (o && !o.tombstone) ? o : {}
    const obj = {
      schemaVersion: 1,
      id: base.id || uid(),
      kind: which === 'req' ? 'user-requirements' : 'user-profile',
      location: 'user-profile',
      title: which === 'req' ? '用户要求' : '用户画像',
      content: String(content || ''),
      createdAt: base.createdAt || nowIso(),
      updatedAt: nowIso(),
      history: Array.isArray(base.history) ? base.history : [],
    }
    obj.history.push(histEntry('update', {
      agent: (meta && (meta.agent || meta.session)) || 'user',
      session: (meta && meta.session) || '',
      turn: (meta && meta.turn) || 0,
      note: '用户' + (which === 'req' ? '要求' : '画像') + '更新',
    }))
    if (obj.history.length > 20) obj.history = obj.history.slice(-20)
    await writeJson(path, obj)
    if (logWrite) { try { logWrite('user_profile:' + which, relOfPath(path)) } catch (e) {} }
    return { ok: true, text: '已保存用户' + (which === 'req' ? '要求' : '画像') + '（全局共享，所有智能体首轮注入）' }
  }
  /** 目录相对路径（写记录用） */
  function relOfPath(path) {
    const r = String(root() || '').replace(/\\/g, '/').replace(/\/+$/, '')
    return String(path).replace(r, '').replace(/^\/+/, '')
  }

  return {
    profileDir, profilePathOf, readUserProfile, saveUserProfile,
  }
}
