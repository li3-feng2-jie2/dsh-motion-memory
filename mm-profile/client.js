// mm-profile client half — classic-script bundle（非 ESM）
// 运动记忆插件的「用户画像」页签（conversation.view slot，order 30，位于「记忆」之后）：
// 编辑用户画像 + 用户要求两份全局共享记忆文件（跨会话跨智能体，随首轮总览注入）。
// 经 fetch POST /mmprofile/<endpoint> 调本包 host 半（index.js 注册的 connection channel），
// 信封格式与 mm-settings 一致（{ type:'client-request', rpcId, method, payload }）。
// 页面顶部含运动记忆插件功能说明（本页在插件中的定位 + 完整能力一览）。

window.__ModuleLoader__.load({
  id: 'mm-profile',
  factory: function (require) {
    var React = require('react')

    var rowStyle = { display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px', marginBottom: 10, fontSize: 13 }
    var labelStyle = { color: 'var(--dsw-alias-label-secondary)', fontWeight: 600, fontSize: 12 }
    var hintStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, whiteSpace: 'pre-wrap', lineHeight: 1.6 }
    var inputStyle = {
      width: '100%', minHeight: 120, padding: '8px 10px',
      border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6,
      background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
      fontFamily: 'inherit', fontSize: 12, lineHeight: 1.7, boxSizing: 'border-box',
    }
    var btnStyle = {
      padding: '4px 12px', borderRadius: 4, fontSize: 12, cursor: 'pointer',
      background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
      border: '1px solid var(--dsw-alias-border-l1)',
    }
    var msgStyle = { padding: '6px 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }

    // 信封与 mm-settings 一致：host connection.rpc.handle 收到 { type, method, payload } 后
    // 返回 full.result.value = handle(endpoint, payload) 的结果
    function callHost(endpoint, payload) {
      return fetch('/mmprofile/' + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'mmp-' + Math.random().toString(36).slice(2, 12),
          method: endpoint,
          payload: payload || {},
        }),
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      }).then(function (full) {
        if (full && full.result && full.result.value !== undefined) return full.result.value
        if (full && full.result && full.result.ok === false) throw new Error('rpc error')
        return full
      })
    }

    function ProfilePage() {
      var profileS = React.useState(null)
      var setProfile = profileS[1]
      var reqsS = React.useState(null)
      var setReqs = reqsS[1]
      var profileTextS = React.useState('')
      var profileText = profileTextS[0]
      var setProfileText = profileTextS[1]
      var reqsTextS = React.useState('')
      var reqsText = reqsTextS[0]
      var setReqsText = reqsTextS[1]
      var msgS = React.useState('')
      var msg = msgS[0]
      var setMsg = msgS[1]
      var busyS = React.useState(false)
      var busy = busyS[0]
      var setBusy = busyS[1]
      var cfgS = React.useState(null)
      var cfg = cfgS[0]
      var setCfg = cfgS[1]
      var loadedRef = React.useRef(false)

      // 配置读取（显示注入开关状态提示；motion-memory 配置固定位由 mm-settings host 提供）
      React.useEffect(function () {
        fetch('/mmsettings/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'mmp-cfg', method: 'config', payload: {} }),
        }).then(function (r) { return r.json() }).then(function (full) {
          var v = full && full.result && full.result.value
          if (v && typeof v === 'object') setCfg(v)
        }).catch(function () {})
      }, [])

      function load() {
        if (loadedRef.current) return
        loadedRef.current = true
        setBusy(true)
        return Promise.all([
          callHost('profile-read', { which: 'profile' }),
          callHost('profile-read', { which: 'req' }),
        ]).then(function (rs) {
          var p = rs[0] || {}
          var q = rs[1] || {}
          setProfile(p)
          setReqs(q)
          setProfileText(p.content || '')
          setReqsText(q.content || '')
        }).catch(function (e) { setMsg('加载失败：' + String((e && e.message) || e)) }).finally(function () { setBusy(false) })
      }
      React.useEffect(function () { load() }, [])

      function save(which) {
        var text = which === 'req' ? reqsText : profileText
        setBusy(true)
        callHost('profile-save', { which: which, content: text }).then(function (r) {
          setMsg('已保存用户' + (which === 'req' ? '要求' : '画像') + '（' + new Date().toLocaleTimeString() + '）')
        }).catch(function (e) { setMsg('保存失败：' + String((e && e.message) || e)) }).finally(function () { setBusy(false) })
      }

      var injP = (cfg && cfg.injectUserProfile !== false) ? '随首轮总览注入' : '注入已关闭（仅手动编辑）'
      var injR = (cfg && cfg.injectUserReqs !== false) ? '随首轮总览注入' : '注入已关闭（仅手动编辑）'

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
        React.createElement('div', { style: { padding: '8px 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', borderBottom: '1px dashed var(--dsw-alias-border-l1)', lineHeight: 1.7, whiteSpace: 'pre-wrap' } },
          '【运动记忆 Motion Memory】本页是运动记忆插件的「用户画像」功能：把「关于用户」和「用户反复强调的要求」沉淀成两份全局记忆文件，跨会话、跨智能体共享，所有智能体在首轮总览时自动载入，用于快速了解你的习惯与偏好（相当于 ChatGPT 记忆中的用户画像 + 自定义指令）。\n\n运动记忆插件完整能力：① 对话跟踪——每个会话的轮次自动总结，沉淀为可溯源的记忆文档（会话@轮次 引用）；② 记忆总览——首轮自动注入必要记忆/活跃关键词/最近会话工作/用户画像；③ 关键词记忆——重要内容一键落档、增量更新、遗忘管理；④ 周期总结——按时间窗口把零散记忆压缩成周期摘要；⑤ 记忆页面——轮次总结/会话记忆/活跃记忆/关键词/周期总结分页浏览编辑。详细说明见「设置 → 运动记忆」页。\n\n本页操作说明：编辑下方两块内容后点击对应“保存”立即写入全局共享文件；注入开关在“设置 → 运动记忆 → 提示词注入”（注入用户画像 / 注入用户要求）。'),
        React.createElement('div', { style: { flex: 1, overflowY: 'auto', padding: 8 } },
          React.createElement('div', { style: rowStyle },
            React.createElement('span', { style: labelStyle }, '用户画像（用户习惯 / 背景 / 技术栈 / 协作偏好） · ' + injP),
            React.createElement('textarea', {
              style: inputStyle, value: profileText, disabled: busy,
              placeholder: '例：\n- 常用语言：中文；偏好简洁直接的技术讨论\n- UE5 / Python / 插件开发背景\n- 喜欢先讨论方案再动手',
              onChange: function (e) { setProfileText(e.target.value) },
            }),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
              React.createElement('button', { style: btnStyle, disabled: busy, onClick: function () { save('profile') } }, busy ? '保存中…' : '保存用户画像'),
            ),
          ),
          React.createElement('div', { style: rowStyle },
            React.createElement('span', { style: labelStyle }, '用户要求（用户反复强调的通用要求） · ' + injR),
            React.createElement('textarea', {
              style: inputStyle, value: reqsText, disabled: busy,
              placeholder: '例：\n- 重要决策先记录记忆再继续\n- 代码改动后做语法验证\n- 术语保持统一',
              onChange: function (e) { setReqsText(e.target.value) },
            }),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
              React.createElement('button', { style: btnStyle, disabled: busy, onClick: function () { save('req') } }, busy ? '保存中…' : '保存用户要求'),
            ),
          ),
          msg ? React.createElement('div', { style: msgStyle }, msg) : null,
        ),
      )
    }

    return {
      name: 'mm-profile',
      inject: ['slots'],
      apply: function (ctx) {
        var slots = ctx.get('slots')
        if (!slots) return
        // 「用户画像」独立页签：紧随记忆面板（order 20）之后
        slots.inject('conversation.view', function () {
          return slots.register(
            { name: 'conversation.view', id: 'mm-profile', order: 30, label: '用户画像' },
            function () { return React.createElement(ProfilePage) },
          )
        })
      },
    }
  },
})
