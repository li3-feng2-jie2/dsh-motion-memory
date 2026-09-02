// mm-profile host half — 运动记忆「用户画像」独立页面插件（批次 B）
// 全局用户级记忆文件（用户画像 + 用户要求，跨会话跨智能体共享）的读写桥：
// 页面（client.js）经 connection channel /mmprofile 调这里，再委托 motion-memory 的
// motionMemoryApi.userProfileRead/userProfileSave（进程内直调，读写同一份全局文件）。
// 设计（2026-09 用户定调）：两份文件可编辑即可——不做历史记录展示、不做专门超期归档；
// 首轮总览注入由 motion-memory 侧处理（bool: injectUserProfile / injectUserReqs）。

export const name = 'mm-profile'
export const inject = ['fs', 'connection', 'motionMemoryApi']

export function apply(ctx) {
  const state = { lastSid: '' }

  // 会话 id 学习（供保存时溯源）
  try {
    ctx.on('session/event', (session) => {
      if (session && session.id) state.lastSid = session.id || state.lastSid
    })
  } catch (e) {}

  async function handle(endpoint, payload) {
    const api = ctx.get('motionMemoryApi')
    if (!api || typeof api.userProfileRead !== 'function') {
      return { ok: false, text: 'motionMemoryApi 服务不可用（motion-memory 插件未加载？）' }
    }
    switch (endpoint) {
      case 'profile-read': {
        const which = String((payload && payload.which) || 'profile')
        const r = await api.userProfileRead({ which })
        return { ok: true, ...((r && r.data) || {}) }
      }
      case 'profile-save': {
        const which = String((payload && payload.which) || 'profile')
        const content = String((payload && payload.content) || '')
        const r = await api.userProfileSave({ which, content, session: state.lastSid || (payload && payload.session) || '' })
        return { ok: true, text: (r && r.text) || '已保存', ...((r && r.data) || {}) }
      }
      default:
        return { ok: false, text: '未知 endpoint：' + endpoint }
    }
  }

  const connection = ctx.get('connection')
  if (connection && connection.rpc && connection.rpc.handle) {
    connection.rpc.handle('/mmprofile', async (endpoint, payload) => {
      try {
        const result = await handle(endpoint, payload)
        return { ok: true, value: result }
      } catch (e) {
        return { ok: true, value: { ok: false, text: 'mm-profile 处理失败：' + String((e && e.message) || e) } }
      }
    }, { authority: 'loopback' })
  }
}
