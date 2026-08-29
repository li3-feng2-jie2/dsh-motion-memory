// mm-settings client half — classic-script bundle（非 ESM）
// 通过 fetch POST /mmsettings/<endpoint> 调用本包 host 半（index.js 注册的 connection channel）。
// 界面 v11：布局疏散（描述换行小字分区）、模型下拉过滤未激活、主题 token 修正（修复黑夜白底白字）、隔离按钮恢复。

window.__ModuleLoader__.load({
  id: 'mm-settings',
  factory: function (require) {
    var React = require('react')

    // 记忆面板子页签记忆：conversation.view slot 切走即卸载、切回重挂载，
    // 用 sessionStorage 记住上次选中的页签（页面刷新也保留），避免"卡在轮次总结"。
    var mmLastTab = 'turns'
    try { mmLastTab = sessionStorage.getItem('mmLastTab') || 'turns' } catch (e) {}
    // 设置页自动保存防抖定时器（无手动保存按钮；文本输入失焦立即保存，复选框/下拉改动即存）
    var mmSaveTimer = 0
    // 当前设置页最新配置的保存函数（由 Page 每次渲染时设置；Input/Num 失焦、Check/Select 改动时调用）
    var mmPersistLatest = null
    // Collapse 折叠面板状态（模块级 keyed by 标题）与强制刷新通知：
    // Collapse 是普通函数不能调 hooks——Page 在 cfg 为 null 时提前 return（hooks 链短），
    // 若 Collapse 用 useState 会因前后渲染 hooks 数量不一致导致 React 崩溃（设置页空白）。
    var mmCollapseOpen = {}
    var mmCollapseNotify = null

    // 主题变量：仅使用 Theme.listTokens 确认存在的 token（bg-layer-1 / label-primary / label-secondary / border-l1 / state-error-primary / state-warn-primary）
    var rowStyle = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 13 }
    var labelStyle = { width: 170, flexShrink: 0, color: 'var(--dsw-alias-label-secondary)' }
    var inputStyle = {
      flex: 1, minWidth: 0, padding: '4px 8px',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 4,
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
    }
    var btnStyle = {
      padding: '4px 12px', borderRadius: 4,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontSize: 13,
    }
    var dangerStyle = { padding: '6px 14px', borderRadius: 4, border: 'none', background: 'var(--dsw-alias-state-error-primary)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }
    var msgStyle = { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }
    var hintStyle = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '2px 0 14px 170px', paddingBottom: 10, borderBottom: '1px dashed var(--dsw-alias-border-l1)', lineHeight: 1.6 }
    var subHintStyle = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '0 0 8px 0', whiteSpace: 'pre-wrap', lineHeight: 1.6 }
    var h3Style = { margin: '0 0 10px', fontSize: 14, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 4 }
    var adminWarning = { color: 'var(--dsw-alias-state-warn-primary)', fontSize: 12, margin: '0 0 10px 0', whiteSpace: 'pre-wrap', lineHeight: 1.6 }
    var subCard = { marginLeft: 20, paddingLeft: 12, borderLeft: '2px solid var(--dsw-alias-border-l1)', marginBottom: 14 }
    var checkboxRow = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 13 }
    var indent = { paddingLeft: 20 }

    // 功能描述块：换行小字分区
    function DescBlock(text) {
      return React.createElement('div', { style: subHintStyle }, text)
    }

    function Row(label, child, extraHint) {
      return React.createElement('div', { style: { marginBottom: 12 } },
        React.createElement('label', { style: rowStyle },
          React.createElement('span', { style: labelStyle }, label),
          React.createElement('div', { style: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 } }, child),
        ),
        extraHint ? React.createElement('div', { style: hintStyle }, extraHint) : null,
      )
    }
    function Input(props) {
      return React.createElement('input', Object.assign({ style: inputStyle }, props, {
        onBlur: function (e) {
          if (props.onBlur) props.onBlur(e)
          if (mmPersistLatest) mmPersistLatest()
        },
      }))
    }
    function Num(props) {
      return React.createElement('input', Object.assign({ style: Object.assign({}, inputStyle, { width: 90 }), type: 'number' }, props, {
        onBlur: function (e) {
          if (props.onBlur) props.onBlur(e)
          if (mmPersistLatest) mmPersistLatest()
        },
      }))
    }
    function Check(props) {
      return React.createElement('input', Object.assign({ type: 'checkbox', style: { width: 16, height: 16, accentColor: 'var(--dsw-alias-brand-primary)' } }, props, {
        onChange: function (e) {
          if (props.onChange) props.onChange(e)
          if (mmPersistLatest) mmPersistLatest()
        },
      }))
    }
    function Select(props) {
      return React.createElement('select', Object.assign({ style: inputStyle }, props, {
        onChange: function (e) {
          if (props.onChange) props.onChange(e)
          if (mmPersistLatest) mmPersistLatest()
        },
      }))
    }
    function Button(props) {
      var children = Array.prototype.slice.call(arguments, 1)
      return React.createElement('button', Object.assign({ style: btnStyle }, props), children)
    }
    function toLocalInput(d) {
      var p = function (n) { return (n < 10 ? '0' : '') + n }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes())
    }
    function Section(title) {
      var children = Array.prototype.slice.call(arguments, 1)
      return React.createElement('div', { style: { marginBottom: 22 } },
        React.createElement('h3', { style: h3Style }, title),
        children,
      )
    }
    // 折叠面板：标题行点击展开/收起；props.title / props.hint；children 为面板内容。
    // 无 hooks：展开状态存模块级 mmCollapseOpen（keyed by title），点击经 mmCollapseNotify 触发 Page 重渲染。
    function Collapse(props) {
      var children = Array.prototype.slice.call(arguments, 1)
      var key = String(props.title || '')
      // 默认折叠（点击展开）
      var open = mmCollapseOpen[key] === true
      return React.createElement('div', { style: { marginBottom: 8, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-1)' } },
        React.createElement('div', {
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', fontSize: 13, fontWeight: 600, userSelect: 'none' },
          onClick: function () { mmCollapseOpen[key] = !open; if (mmCollapseNotify) mmCollapseNotify() },
        },
          React.createElement('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)', width: 12, flexShrink: 0 } }, open ? '▼' : '▶'),
          React.createElement('span', { style: { flex: 1 } }, props.title),
          props.hint ? React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', fontWeight: 400 } }, props.hint) : null,
        ),
        open ? React.createElement('div', { style: { padding: '8px 10px', borderTop: '1px solid var(--dsw-alias-border-l1)' } }, children) : null,
      )
    }
    function CheckRow(label, checked, onChange, hint) {
      return React.createElement('div', { style: { marginBottom: 8 } },
        React.createElement('label', { style: checkboxRow },
          Check({ checked: checked, onChange: onChange }),
          React.createElement('span', { style: { fontSize: 13 } }, label),
        ),
        hint ? React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '0 0 0 24px', lineHeight: 1.5 } }, hint) : null,
      )
    }
    // 模型选择：provider 两级下拉 + 模型下拉（载入后自动选中第一个有效 provider/模型）
    function ModelSelect(props) {
      var providers = (props.providers || []).filter(function (p) { return !!p.active })
      var current = props.value || ''
      var slash = current.indexOf('/')
      var savedP = slash >= 0 ? current.slice(0, slash) : current
      var savedM = slash >= 0 ? current.slice(slash + 1) : ''
      var modelsOf = function (p) {
        var found = null
        for (var i = 0; i < providers.length; i++) { if (providers[i].provider === p) { found = providers[i]; break } }
        return found ? (found.models || []) : []
      }
      // provider 显示值：尊重已保存值，空即空（不自动选）
      var dispP = savedP
      var ms = modelsOf(dispP)
      // 模型显示值：provider 已选时自动选第一个有效模型；provider 为空则空（禁用）
      var dispM = savedM || (ms.length ? ms[0] : '')
      var modelDisabled = !dispP || !ms.length
      return React.createElement('div', { style: { flex: 1, minWidth: 0, display: 'flex', gap: 6, alignItems: 'center' } },
        React.createElement('select', {
          style: Object.assign({}, inputStyle, { width: '46%' }),
          value: dispP,
          onFocus: function () { if (typeof expandModels === 'function') expandModels() },  // 懒加载完整模型列表
          onChange: function (e) {
            var p = e.target.value
            var m = modelsOf(p)
            var first = m.length ? m[0] : ''
            props.onChange(p && first ? p + '/' + first : p)
          },
        },
          React.createElement('option', { value: '' }, '（空）'),
          providers.map(function (pr) {
            return React.createElement('option', { key: pr.provider, value: pr.provider }, pr.displayName || pr.provider)
          }),
        ),
        React.createElement('select', {
          style: Object.assign({}, inputStyle, { width: '46%' }),
          value: modelDisabled ? '' : dispM,
          disabled: modelDisabled,
          onChange: function (e) { props.onChange(dispP && e.target.value ? dispP + '/' + e.target.value : dispP) },
        },
          modelDisabled
            ? React.createElement('option', { value: '' }, '（模型）')
            : ms.map(function (m) { return React.createElement('option', { key: m, value: m }, m) }),
        ),
      )
    }
    // k 单位：显示 k 值，存储 ×1000
    function KNum(props) {
      var k = (Number(props.value) || 0) / 1000
      return React.createElement('input', Object.assign({
        style: Object.assign({}, inputStyle, { width: 90 }), type: 'number', step: '0.1',
        value: Number.isFinite(k) ? (Math.round(k * 10) / 10) : 0,
        onChange: function (e) { props.onChange(Math.round((Number(e.target.value) || 0) * 1000)) },
        onBlur: function (e) { if (mmPersistLatest) mmPersistLatest() },
      }, props.passthrough || {}))
    }
    function fmtK(n) {
      var v = (Number(n) || 0) / 1000
      return (Math.round(v * 10) / 10) + 'k'
    }
    // 模型配置结构体块：模型选择 + 可展开高级区（上下文/百分比/输出/并发/自定义JSON）
    // value：子级 model 对象（空字段=跟随全局）；global：全局值（placeholder 显示）
    function ModelConfigBlock(props) {
      var value = props.value || {}
      var g = props.global || {}
      var providers = (props.providers || []).filter(function (p) { return !!p.active })  // 未激活的 provider 屏蔽
      var onChange = props.onChange
      var adv = React.useState(false)
      var advanced = adv[0]
      var setAdvanced = adv[1]
      var js = React.useState('')
      var jsonText = js[0]
      var setJsonText = js[1]
      React.useEffect(function () {
        var ev = value.extraJson
        // 兼容字符串和对象两种存储：字符串则解析（历史版本可能存 JSON 字符串）
        if (typeof ev === 'string') { try { ev = JSON.parse(ev) } catch (e) { ev = null } }
        setJsonText((ev && typeof ev === 'object') ? JSON.stringify(ev, null, 1) : '')
      }, [value.extraJson])
      var hasJson = !!(function () {
        var ev = value.extraJson
        if (typeof ev === 'string') { try { ev = JSON.parse(ev) } catch (e) { return false } }
        return ev && typeof ev === 'object'
      })()
      var setF = function (key, v) { var next = Object.assign({}, value); next[key] = v; onChange(next) }
      // extraJson 统一存对象（UI 内部）；写入时保持对象，读取兼容字符串
      var setExtraJson = function (v) { setF('extraJson', v) }
      var mkNum = function (key, kind) {
        var raw = value[key]
        var has = raw !== undefined && raw !== null && raw !== ''
        var gv = g[key]
        return Num({
          type: 'number',
          value: has ? (kind === 'k' ? Math.round(Number(raw) / 1000 * 10) / 10 : Number(raw)) : '',
          placeholder: '跟随全局 ' + (kind === 'k' ? fmtK(gv || 0) : String(gv !== undefined && gv !== null ? gv : '')),
          onChange: function (e) {
            var v = e.target.value
            if (v === '') setF(key, '')
            else setF(key, kind === 'k' ? Math.round(Number(v) * 1000) : Number(v))
          },
        })
      }
      var dispP = value.provider || ''
      var modelsOf = function (p) {
        var found = null
        for (var i = 0; i < providers.length; i++) { if (providers[i].provider === p) { found = providers[i]; break } }
        return found ? (found.models || []) : []
      }
      var ms = modelsOf(dispP)
      var modelDisabled = !dispP || !ms.length
      // 自动回写：provider 已选、model 为空、该 provider 有模型 → 自动补第一个模型并写回 state。
      // 修复断链：此前"自动选中"仅作用于显示层（value.model || ms[0]），从不写回 state，
      // 而自动保存把空 model 视为"清除"（applySubModel delete m.model）→ 配置永远缺 model →
      // resolveModelConfig 回落全局（亦空）→ 无模型模式，模型总结失败/不调模型。
      // 补写后随自动保存（scheduleSave 800ms 防抖）落盘。
      React.useEffect(function () {
        var p = value && value.provider
        if (p && p !== '__none__' && !(value && value.model) && !modelDisabled && ms.length) {
          setF('model', ms[0])
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [value.provider])
      return React.createElement('div', { style: { flex: 1, minWidth: 0 } },
        React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          React.createElement('select', {
            style: Object.assign({}, inputStyle, { width: '46%' }),
            value: dispP,
            onFocus: function () { if (typeof expandModels === 'function') expandModels() },  // 懒加载完整模型列表
            onChange: function (e) {
              var p = e.target.value
              var m = modelsOf(p)
              var first = m.length ? m[0] : ''
              setF('provider', p)
              setF('model', p && first ? first : '')
            },
          },
            React.createElement('option', { value: '' }, '（跟随全局' + (g.provider ? '：' + g.provider + '/' + g.model : '') + '）'),
            (props.allowNone === true) ? React.createElement('option', { value: '__none__' }, '（无模型：不调模型，只记录用户消息）') : null,
            providers.map(function (pr) {
              return React.createElement('option', { key: pr.provider, value: pr.provider }, pr.displayName || pr.provider)
            }),
          ),
          React.createElement('select', {
            style: Object.assign({}, inputStyle, { width: '46%' }),
            value: modelDisabled ? '' : (value.model || (ms.length ? ms[0] : '')),
            disabled: modelDisabled,
            onChange: function (e) { setF('model', e.target.value) },
          },
            modelDisabled
              ? React.createElement('option', { value: '' }, '（模型）')
              : ms.map(function (m) { return React.createElement('option', { key: m, value: m }, m) }),
          ),
        ),
        React.createElement('div', { style: { marginTop: 4, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
          React.createElement('label', { style: { cursor: 'pointer' } },
            React.createElement('input', { type: 'checkbox', checked: advanced, onChange: function (e) { setAdvanced(e.target.checked) } }),
            ' 高级模型参数（留空=跟随全局管理员：上下文/百分比/输出/并发/自定义JSON）'),
        ),
        advanced ? React.createElement('div', { style: indent },
          Row('上下文 token 上限', mkNum('contextTokens', 'k'), '留空跟随全局（' + fmtK(g.contextTokens || 128000) + '）'),
          Row('总结占用百分比（%）', mkNum('summaryPercent', 'num'), '留空跟随全局（' + (g.summaryPercent || 50) + '%）'),
          Row('输出上限（k token）', mkNum('outputTokens', 'k'), '留空跟随全局（' + fmtK(g.outputTokens || 1024) + '）'),
          Row('并发（块级并行）', mkNum('concurrency', 'num'), '0=串行；N=同时 N 个块并行；留空跟随全局'),
          (function () {
            // 允许向记忆管理员委派：工具模型 == 管理员模型（global）时不显示（同一个模型，委派无意义）
            var toolKey = String((value.provider || '') + '/' + (value.model || ''))
            var gKey = String((g.provider || '') + '/' + (g.model || ''))
            if (toolKey && toolKey === gKey) return null
            return CheckRow('允许向记忆管理员委派', !!(value.delegateBlocks), function (e) { setF('delegateBlocks', e.target.checked) }, '开=工具模型 worker 占满、还有剩余块/任务时，空闲的记忆管理员模型接单协作（同一提示词契约，片段标记来源模型；管理员未配置模型则不委派）。关（默认）=仅本工具模型自己做')
          })(),
          CheckRow('自定义 JSON（覆盖全局）', hasJson, function (e) {
            if (e.target.checked) { if (!hasJson) setExtraJson({ temperature: 0.3 }) }
            else setExtraJson(null)
          }, '给模型调用附加参数；勾选后编辑 JSON；取消勾选=恢复跟随全局'),
          hasJson ? Row('JSON 配置', React.createElement('textarea', {
            style: Object.assign({}, inputStyle, { width: '100%', minHeight: 60, fontFamily: 'monospace', fontSize: 12 }),
            value: jsonText,
            onChange: function (e) {
              var v = e.target.value
              setJsonText(v)
              try { setExtraJson(JSON.parse(v)) } catch (e2) {}
            },
          }), '非法 JSON 不保存（实时校验）') : null,
        ) : null,
      )
    }

    function Page() {
      var state = React.useState(null)
      var cfg = state[0]
      var setCfg = state[1]
      var state2 = React.useState([])
      var incidents = state2[0]
      var setIncidents = state2[1]
      var state3 = React.useState(null)
      var stats = state3[0]
      var setStats = state3[1]
      var state4 = React.useState(null)
      var diag = state4[0]
      var setDiag = state4[1]
      var state5 = React.useState('')
      var msg = state5[0]
      var setMsg = state5[1]
      var state6 = React.useState(false)
      var busy = state6[0]
      var setBusy = state6[1]
      // 保存状态提示：''=未修改 / '修改中…' / '已保存 HH:MM:SS' / 失败信息
      var saveState = React.useState('')
      var saveStatus = saveState[0]
      var setSaveStatus = saveState[1]
      // 浮窗提示（toast）：保存成功/失败弹窗，3 秒后自动消失
      var toastState = React.useState(null)
      var toast = toastState[0]
      var setToast = toastState[1]
      // 折叠面板强制刷新（Collapse 无 hooks，点击折叠经此触发 Page 重渲染；必须位于 cfg 判断前）
      var forceS = React.useState(0)
      var setForceTick = forceS[1]
      mmCollapseNotify = function () { setForceTick(function (t) { return t + 1 }) }
      // 最新 cfg 引用（保存读它，避免闭包捕获过期值）
      var cfgRef = React.useRef(null)
      cfgRef.current = cfg
      // 失焦/改动即保存的统一入口（供 Input/Num/Check/Select 组件调用）
      mmPersistLatest = function () { persistCfg(cfgRef.current) }
      var state7 = React.useState([])
      var providers = state7[0]
      var setProviders = state7[1]
      // 版本与更新：检查结果 + 更新执行中
      var stateU = React.useState(null)
      var updateInfo = stateU[0]
      var setUpdateInfo = stateU[1]
      var stateU2 = React.useState(false)
      var updateBusy = stateU2[0]
      var setUpdateBusy = stateU2[1]
      var state8 = React.useState('')
      var countdown = state8[0]
      var setCountdown = state8[1]
      var state9 = React.useState(toLocalInput(new Date(Date.now() - 3600000)))
      var targetTime = state9[0]
      var setTargetTime = state9[1]
      // 隔离目标智能体选择：空=隔离全部；选了只隔离这些智能体的记忆文件
      var isoAgentsS = React.useState([])
      var isoAgents = isoAgentsS[0]
      var setIsoAgents = isoAgentsS[1]
      var isoAgentsListS = React.useState([])
      var isoAgentsList = isoAgentsListS[0]
      var setIsoAgentsList = isoAgentsListS[1]
      var isoPickOpenS = React.useState(false)
      var isoPickOpen = isoPickOpenS[0]
      var setIsoPickOpen = isoPickOpenS[1]
      var isoPickSelS = React.useState({})
      var isoPickSel = isoPickSelS[0]
      var setIsoPickSel = isoPickSelS[1]
      // 周期总结智能体选择弹窗：空=全部（统一时间周期，各智能体各生成自己的周期总结）
      var periodPickOpenS = React.useState(false)
      var periodPickOpen = periodPickOpenS[0]
      var setPeriodPickOpen = periodPickOpenS[1]
      var periodPickSelS = React.useState({})
      var periodPickSel = periodPickSelS[0]
      var setPeriodPickSel = periodPickSelS[1]
      var state10 = React.useState(false)
      var resetPeriodTimer = state10[0]
      var setResetPeriodTimer = state10[1]
      // 页面内确认浮层（替代 window.confirm：嵌入环境可能被拦截导致点击无反应）
      var confirmS = React.useState(null)
      var confirmState = confirmS[0]
      var setConfirmState = confirmS[1]
      function askConfirm(text, fn) { setConfirmState({ text: text, onConfirm: fn }) }
      // 立刻执行周期总结（调 host 的 period-run 通道，管理员身份；带当前方案+时间范围）
      function doPeriodRun(opts) {
        setBusy(true)
        var adm = cfg && cfg.admin
        var payload = { resetTimer: resetPeriodTimer }
        if (adm) {
          if (adm.periodScope) payload.scope = adm.periodScope
          if (adm.periodScopeDetail) payload.scopeDetail = adm.periodScopeDetail
        }
        if (opts) {
          if (opts.scope) payload.scope = opts.scope
          if (opts.scopeDetail) payload.scopeDetail = opts.scopeDetail
          if (opts.from) payload.from = opts.from
          if (opts.to) payload.to = opts.to
          if (opts.ignoreSummarized) payload.ignoreSummarized = true
          if (opts.truncK) payload.truncK = opts.truncK
        }
        callHost('period-run', payload).then(function (r) {
          setMsg((r && r.ok === false) ? (r.text || '周期总结失败') : ((r && r.text) || '周期总结已执行'))
          refresh()
        }).catch(function (e) { setMsg('周期总结失败: ' + String((e && e.message) || e)) })
          .finally(function () { setBusy(false) })
      }

      var refresh = React.useCallback(function () {
        // 设置页主体立即加载（config 等轻量 RPC）；stats 统计后台计算，完成后单独更新统计区块
        Promise.all([
          callHost('config', {}),
          callHost('incidents', {}),
          callHost('diag', {}),
          callHost('models', {}),
          callHost('mm-update-check', {}),
          callHost('mm-agent-list', {}),
        ]).then(function (rs) {
          setCfg(rs[0].config || null)
          setIncidents((rs[1].incidents) || [])
          setDiag(rs[2])
          setProviders(rs[3].providers || [])
          setUpdateInfo(rs[4] || { text: '（版本信息不可用）' })
          setIsoAgentsList((rs[5] && rs[5].items) || [])
        }).catch(function (e) { setMsg('读取失败: ' + String((e && e.message) || e)) })
        callHost('stats', {}).then(function (r) { setStats(r) }).catch(function () {})
      }, [])
      // 模型列表懒加载：仅当用户展开模型选择（provider 下拉聚焦）时才完整探测各 provider 模型
      var expandModels = React.useCallback(function () {
        callHost('models', { expand: true }).then(function (r) { setProviders(r.providers || []) }).catch(function () {})
      }, [])
      React.useEffect(function () { refresh() }, [refresh])

      // 周期倒计时提示（间隔制 → 总小时）
      React.useEffect(function () {
        var calc = function () {
          var adm = cfg && cfg.admin
          if (!adm || !adm.period) { setCountdown(''); return }
          var days = Math.max(0, Number(adm.periodDays) || 1)
          var hours = Math.min(24, Math.max(0, Number(adm.periodHours) || 0))
          var totalH = days * 24 + hours
          if (!totalH) { setCountdown(''); return }
          setCountdown('= ' + totalH + ' 小时（间隔制：从上一次周期总结起算）')
        }
        calc()
        var iv = setInterval(calc, 30000)
        return function () { clearInterval(iv) }
      }, [cfg])

      if (!cfg) return React.createElement('div', { style: msgStyle }, '运动记忆加载中…')

      // 保存触发：文本/数字输入失焦立即保存；复选框/下拉改动即存；防抖 800ms 兜底
      function scheduleSave() {
        setSaveStatus('修改中…')
        if (mmSaveTimer) clearTimeout(mmSaveTimer)
        mmSaveTimer = setTimeout(function () { persistCfg(cfgRef.current) }, 800)
      }
      // 浮窗提示：3 秒后自动消失（同一条不重复延长）
      function showToast(text, ok) {
        var key = Date.now()
        setToast({ text: text, ok: !!ok, key: key })
        setTimeout(function () {
          setToast(function (cur) { return cur && cur.key === key ? null : cur })
        }, 3000)
      }
      function persistCfg(c) {
        if (!c) return
        if (mmSaveTimer) { clearTimeout(mmSaveTimer); mmSaveTimer = 0 }
        setSaveStatus('保存中…')
        callHost('config-set', { patch: c }).then(function () {
          var ts = new Date().toTimeString().slice(0, 8)
          setSaveStatus('已保存 ' + ts)
          showToast('✓ 已保存 ' + ts, true)
        }).catch(function (e) {
          var err = '保存失败：' + String((e && e.message) || e)
          setSaveStatus(err)
          showToast(err, false)
        })
      }
      function set(k, v) {
        var next = Object.assign({}, cfgRef.current || cfg, Object.defineProperty({}, k, { value: v, enumerable: true, writable: true, configurable: true }))
        cfgRef.current = next; setCfg(next); scheduleSave()
      }
      function setA(k, v) {
        var base = cfgRef.current || cfg
        var next = Object.assign({}, base, { admin: Object.assign({}, base.admin, Object.defineProperty({}, k, { value: v, enumerable: true, writable: true, configurable: true })) })
        cfgRef.current = next; setCfg(next); scheduleSave()
      }
      // 活跃索引 score 子对象：{period, event, keyword, floor, threshold, maxRefs}
      function setIndex(k, v) {
        var base = cfgRef.current || cfg
        var next = Object.assign({}, base, { indexScore: Object.assign({}, base.indexScore || {}, Object.defineProperty({}, k, { value: v, enumerable: true, writable: true, configurable: true })) })
        cfgRef.current = next; setCfg(next); scheduleSave()
      }
      // 当前活跃启用得分子对象：{enabled, score, boost}
      function setUsageScore(k, v) {
        var base = cfgRef.current || cfg
        var next = Object.assign({}, base, { activeUsageScore: Object.assign({}, base.activeUsageScore || {}, Object.defineProperty({}, k, { value: v, enumerable: true, writable: true, configurable: true })) })
        cfgRef.current = next; setCfg(next); scheduleSave()
      }
      function doIsolation() {
        var t = new Date(targetTime)
        if (Number.isNaN(t.getTime())) { setMsg('请先填写回溯目标时间'); return }
        if (t.getTime() > Date.now()) { setMsg('目标时间不能晚于当前时间'); return }
        askConfirm('确定要触发记忆隔离并回溯到 ' + toLocalInput(t) + ' 吗？' + (isoAgents.length ? '\n仅隔离智能体：' + isoAgents.map(function (a) { return a.label || a.key || a }).join('、') + ' 的记忆文件' : '\n将隔离全部智能体的记忆文件') + '\n快照受影响记忆的当前污染态到隔离文件夹，可随时回滚。', function () {
          setBusy(true)
          callHost('isolation', { targetTime: t.toISOString(), agents: isoAgents.map(function (a) { return a.key }) }).then(function (r) {
            setMsg(r.ok === false ? (r.text || '隔离失败') : '隔离已触发：' + (r.id || '') + '（' + (r.text || '').slice(0, 300) + '）')
            refresh()
          }).catch(function (e) { setMsg('隔离失败: ' + String((e && e.message) || e)) })
            .finally(function () { setBusy(false) })
        })
      }
      function act(name, id, done) {
        setBusy(true)
        callHost(name, { id: id }).then(function (r) {
          setMsg((r && r.text) || (r && r.ok === false ? '失败' : done))
          refresh()
        }).catch(function (e) { setMsg('操作失败: ' + String((e && e.message) || e)) })
          .finally(function () { setBusy(false) })
      }

      var adm = cfg.admin || {}
      // 全局管理员模型实例（子级留空字段的 placeholder 与继承来源）
      var globalModel = {
        provider: String(adm.model || '').split('/')[0] || '',
        model: String(adm.model || '').split('/')[1] || '',
        contextTokens: adm.contextTokens || 128000,
        summaryPercent: adm.summaryPercent || 50,
        outputTokens: adm.outputTokens || 1024,
        concurrency: (adm.concurrency === undefined || adm.concurrency === null) ? 0 : adm.concurrency,
        extraJson: adm.extraJson || null,
      }
      var sections = []
      // ── 基础配置 ────────────────────────────────────────────────
      sections.push(Section('基础配置',
        Row('记忆根目录', Input({ value: cfg.root || '', onChange: function (e) { set('root', e.target.value) } }), '所有记忆文件存放的文件夹路径'),
        Row('归档天数', Num({ value: cfg.archiveDays || 30, onChange: function (e) { set('archiveDays', Number(e.target.value) || 30) } }), '记忆文件在 N 天后进入归档压缩'),
        Row('记忆衰减天数', Num({ value: cfg.decayDays || 30, onChange: function (e) { set('decayDays', Number(e.target.value) || 30) } }), '记忆得分随时间衰减的窗口（天）：查询时越久远的记忆得分越低，超过窗口后降到衰减下限'),
        Row('总结摘要字数（k token）', Num({ value: cfg.summaryCharsK === undefined ? 2 : cfg.summaryCharsK, onChange: function (e) { set('summaryCharsK', Math.max(1, Number(e.target.value) || 2)) } }), '会话工作的摘要/注入长度预算（k token，换算走内部语言表：中文约 1.5 字/token）。用于：①works 记录链总量预算（超了把最旧记录压缩为"指向+短摘要"）；②对话跟踪注入【本会话现有工作信息】的软字数限制（md 超链接不计入，可略超，输出上限兜底）'),
        Collapse({ title: '提示词注入', hint: '会话开始时加载记忆', defaultOpen: false },
          Row('启用提示词注入', Check({ checked: !!cfg.inject, onChange: function (e) { set('inject', e.target.checked) } }), '任何会话启动时自动加载当前活跃、关键词、重要信息记忆；取消则不注入'),
          Row('注入上限（字节）', Num({ value: cfg.injectLimitBytes || 4096, onChange: function (e) { set('injectLimitBytes', Number(e.target.value) || 4096) } }), '注入总览文本上限（字节），超出后从最早的记录开始截断'),
          Row('最近事件总览', Num({ value: cfg.recentOverviewN || 3, onChange: function (e) { set('recentOverviewN', Number(e.target.value) || 3) } }), '注入显示最近 n 条会话摘要'),
        ),
        Collapse({ title: '阅读与查询设置', hint: '展开层数 / 历史条数 / 截断', defaultOpen: false },
          Row('关联记忆展开（层数）', Num({ value: cfg.cascadeDepth === undefined ? 3 : cfg.cascadeDepth, onChange: function (e) { set('cascadeDepth', Number(e.target.value) || 0) } }), '读取记忆时按关联引用展开子记忆内容 n 层；0=不展开（默认 3 层）'),
          Row('查询历史显示条数', Num({ value: cfg.queryHistoryN || 0, onChange: function (e) { set('queryHistoryN', Number(e.target.value) || 0) } }), '查看记忆时附带最近 n 条查询记录；0=不附带'),
          Row('增量历史显示条数', Num({ value: cfg.updateHistoryN || 0, onChange: function (e) { set('updateHistoryN', Number(e.target.value) || 0) } }), '查看记忆时附带最近 n 条更新记录；0=不附带'),
          Row('历史分页条数', Num({ value: cfg.historyPageSize || 20, onChange: function (e) { set('historyPageSize', Number(e.target.value) || 20) } }), '查看全部历史时每页加载 n 条'),
          Row('读取截断字符（每侧）', Num({ value: cfg.readTrimChars || 500, onChange: function (e) { set('readTrimChars', Number(e.target.value) || 500) } }), '读取长文本时只保留开头+结尾各 N 字符，中间省略（默认 500）'),
          Row('跨智能体查询', Check({ checked: !!cfg.queryOtherAgents, onChange: function (e) { set('queryOtherAgents', e.target.checked) } }), '开=可跨智能体查询：先列出有哪些其他智能体的记忆（memory_query agents），再指定智能体（ownerKey=preset:xxx）或全部（ownerKey=all）定向查询；关（默认）=只查本智能体'),
        ),
        Collapse({ title: '活跃索引（得分参数）', hint: '初始分 / 衰减 / 淘汰', defaultOpen: false },
          React.createElement('div', { style: subHintStyle }, '活跃索引 active.json 的引用得分参数：初始分（周期/事件/关键词）+ 衰减下限 + 淘汰阈值。'),
          Row('周期初始分', Num({ value: (cfg.indexScore && cfg.indexScore.period) || 5, onChange: function (e) { setIndex('period', Number(e.target.value) || 5) } }), '周期记忆引用初始得分'),
          Row('事件初始分', Num({ value: (cfg.indexScore && cfg.indexScore.event) || 3, onChange: function (e) { setIndex('event', Number(e.target.value) || 3) } }), '事件记忆引用初始得分'),
          Row('关键词初始分', Num({ value: (cfg.indexScore && cfg.indexScore.keyword) || 2, onChange: function (e) { setIndex('keyword', Number(e.target.value) || 2) } }), '重要关键词引用初始得分'),
          Row('衰减下限', Num({ value: (cfg.indexScore && cfg.indexScore.floor !== undefined) ? cfg.indexScore.floor : 0.2, onChange: function (e) { setIndex('floor', Math.max(0, Math.min(1, Number(e.target.value) || 0.2))) } }), '引用得分按时间衰减的最低保留比例（0.2 = 最低保留 20%）'),
          Row('淘汰阈值', Num({ value: (cfg.indexScore && cfg.indexScore.threshold !== undefined) ? cfg.indexScore.threshold : 0.3, onChange: function (e) { setIndex('threshold', Number(e.target.value) || 0.3) } }), '衰减后得分低于此值则从索引移除'),
          Row('索引最大条数', Num({ value: (cfg.indexScore && cfg.indexScore.maxRefs) || 50, onChange: function (e) { setIndex('maxRefs', Number(e.target.value) || 50) } }), 'active.json refs 最多保留条数'),
          Row('事件扫描月份', Num({ value: (cfg.indexScore && cfg.indexScore.scanMonths) || 3, onChange: function (e) { setIndex('scanMonths', Number(e.target.value) || 3) } }), '事件区按年月目录定向扫描的窗口（新→旧，最近 N 个月）'),
        ),
        Collapse({ title: '当前活跃启用得分', hint: '挂回/晋升计分', defaultOpen: false },
          React.createElement('div', { style: subHintStyle }, '模型通过上下文判断：补充区记忆挂回当前活跃、或移动回重要时触发计分（写入/查询时说明理由）。'),
          Row('启用', Check({ checked: !!(cfg.activeUsageScore && cfg.activeUsageScore.enabled), onChange: function (e) { setUsageScore('enabled', e.target.checked) } }), '开=阅读挂回/晋升时按分值计分'),
          Row('单次分值', Num({ value: (cfg.activeUsageScore && cfg.activeUsageScore.score) || 1, onChange: function (e) { setUsageScore('score', Math.max(0, Number(e.target.value) || 1)) } }), '补充区记忆挂回当前活跃，每次 +N 分'),
          Row('晋升加成倍数', Num({ value: (cfg.activeUsageScore && cfg.activeUsageScore.boost) || 2, onChange: function (e) { setUsageScore('boost', Math.max(1, Number(e.target.value) || 2)) } }), '移动回重要 = 单次分值 × 倍数（短时间多分）'),
        ),
        Row('活跃变更通知', Check({ checked: cfg.activeNotify !== false, onChange: function (e) { set('activeNotify', e.target.checked) } }), '对话跟踪工具每轮总结后，向其他会话注入记忆变更通知（默认开；关掉后本机各会话不再收到跨会话变更提示）'),
      ))

      // ── 记忆管理员（全局参数）──────────────────────────────────
      sections.push(Section('记忆管理员（全局参数）',
        React.createElement('div', { style: adminWarning }, '⚠ 管理员模型留空 = 管理员功能全部关闭。\n模型下拉来自 DSH 配置（settings.yaml 的 agent-default-model + 可配置 provider 目录），仅显示已激活的 provider。'),
        Row('管理员模型', ModelSelect({ providers: providers, value: adm.model || '', onChange: function (v) { setA('model', v) } }), '指定模型后自动启用管理员功能；留空=管理员功能全部关闭'),
        Row('上下文 token 上限', KNum({ value: adm.contextTokens || 128000, onChange: function (v) { setA('contextTokens', v) } }), '管理员模型上下文长度上限（k token，如 128 = 128k）'),
        Row('总结占用百分比（%）', Num({ value: adm.summaryPercent || 50, onChange: function (e) { setA('summaryPercent', Number(e.target.value) || 50) } }), '总结内容最多占用上下文的百分比（总结预算 ≈ ' + fmtK((adm.contextTokens || 128000) * ((adm.summaryPercent || 50) / 100)) + ' tokens）' + (function () {
          // 低阈值警告：总结预算须覆盖「固定提示词开销 + 预期最小有效总结量」，否则可能无法正常工作
          var ctx = Number(adm.contextTokens) || 128000
          var pct = Number(adm.summaryPercent) || 50
          var budget = ctx * pct / 100
          var promptOverhead = 3.5  // adminPrompt + 输入结构固定开销（k token 粗估）
          var minSummary = 0.8      // 预期最小有效总结量（k token）
          if (budget / 1000 < promptOverhead + minSummary) {
            return '\n⚠ 警告：当前预算仅 ' + Math.round(budget / 10) / 100 + 'k token，低于"固定提示词开销 + 最小有效总结量"（约 ' + (promptOverhead + minSummary) + 'k token），总结可能无法正常工作——建议提高百分比或上下文上限。'
          }
          return ''
        })()),
        Row('并发（段裁剪并行）', Num({ value: adm.concurrency || 0, onChange: function (e) { setA('concurrency', Number(e.target.value) || 0) } }), '内容切块后同时发起多少个总结请求；0=串行（一块处理完再下一块），N=同时最多 N 块并行'),
        Row('输出上限（k token）', KNum({ value: adm.outputTokens || 1024, onChange: function (v) { setA('outputTokens', v) } }), '管理员模型单次输出的最大长度（k token）'),
        (function () {
          var hasExtra = !!(adm.extraJson && String(adm.extraJson).trim() && String(adm.extraJson).trim() !== 'null')
          var extraStr = hasExtra ? String(adm.extraJson).trim() : ''
          var extraParsed = null
          try { extraParsed = extraStr ? JSON.parse(extraStr) : null } catch (e) {}
          return React.createElement('div', { style: { marginBottom: 12 } },
            CheckRow('更多自定义配置（模型参数 JSON）', hasExtra && !!extraParsed, function (e) {
              if (e.target.checked) { if (!hasExtra || !extraParsed) setA('extraJson', JSON.stringify({ temperature: 0.3 }, null, 1)) }
              else setA('extraJson', null)
            }, '给模型调用附加参数（如 {"temperature": 0.3}）。需是合法 JSON，将合并进管理员模型调用。'),
            hasExtra ? Row('JSON 配置', React.createElement('textarea', {
              style: Object.assign({}, inputStyle, { width: '100%', minHeight: 70, fontFamily: 'monospace', fontSize: 12 }),
              value: extraStr,
              onChange: function (e2) {
                var v = e2.target.value
                try { JSON.parse(v); setA('extraJson', v) } catch (e3) {}
              },
            }), '非法 JSON 不保存（实时校验）') : null,
          )
        })(),
        Collapse({ title: 'token 估算语言表', hint: '中文 1.5 / 英文 1 / 日韩 1.5 / 其他 1', defaultOpen: false },
          React.createElement('div', { style: subHintStyle }, '5 个固定字符类别，不可增删；每类填"每字/词 token"数（float），按实际需求填写：'),
          [{ kind: 'cn', lang: '中文（按字）' }, { kind: 'en', lang: '英文/数字（按词）' }, { kind: 'ja', lang: '日文（按字）' }, { kind: 'ko', lang: '韩文（按字）' }, { kind: 'other', lang: '其他（标点/符号，按字符）' }].map(function (row, i) {
            var lt = null
            var arr0 = (adm.langTokens && adm.langTokens.length ? adm.langTokens : [])
            for (var j = 0; j < arr0.length; j++) { if (String(arr0[j].kind || '') === row.kind || (!arr0[j].kind && j < 4 && row.kind === ['cn', 'en', 'ja', 'ko'][j])) { lt = arr0[j]; break } }
            return React.createElement('div', { key: row.kind, style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 } },
              React.createElement('span', { style: Object.assign({}, inputStyle, { width: '45%', display: 'flex', alignItems: 'center' }) }, row.lang),
              React.createElement('input', {
                style: Object.assign({}, inputStyle, { width: '35%' }), type: 'number', step: '0.1', placeholder: '每字/词 token',
                value: (lt && lt.per) || 0, onChange: function (e) {
                  var arr = (adm.langTokens && adm.langTokens.length ? adm.langTokens : [{ kind: 'cn', lang: '中文', per: 1.5 }, { kind: 'en', lang: 'english', per: 1 }, { kind: 'ja', lang: '日文', per: 1.5 }, { kind: 'ko', lang: '韩文', per: 1.5 }, { kind: 'other', lang: '其他', per: 1 }]).map(function (x) { return Object.assign({}, x) })
                  var found = null
                  for (var j2 = 0; j2 < arr.length; j2++) { if (String(arr[j2].kind || '') === row.kind) { found = arr[j2]; break } }
                  if (found) found.per = Number(e.target.value) || 0
                  else arr.push({ kind: row.kind, lang: row.lang, per: Number(e.target.value) || 0 })
                  setA('langTokens', arr)
                },
              }),
            )
          }),
        ),
      ))

      // ── 对话跟踪 ──────────────────────────────────────────────
      sections.push(Section('对话跟踪',
        CheckRow('启用对话跟踪', !!(adm.track), function (e) { setA('track', e.target.checked) }, '自动总结对话内容'),
        adm.track ? React.createElement('div', { style: subCard },
          DescBlock('作用：每个会话按触发间隔把"对话轮次"压成一条记忆，并沉淀经验教训。\n触发：每轮对话结束时检查，按该会话记录的间隔决定是否总结；结果写入该会话的聚合记忆文件（turns[] 累积多轮），教训进重要关键词。\n无模型时：只把用户消息以引用形式累积到"无模型记忆整理"区，可经周期总结转正。'),
          Row('模型配置', React.createElement(ModelConfigBlock, { value: adm.trackModel || {}, global: globalModel, providers: providers, allowNone: true, onChange: function (v) { setA('trackModel', v) } }), '留空字段继承全局管理员模型参数；选「无模型」则不调用模型：每轮结束把该轮用户消息以 [用户消息](会话@轮次) 引用形式累积到无模型记忆整理区（每会话一个文件，标题=会话id，逐行追加），保持原始指向，可经周期总结/模型转正'),
          Row('触发间隔', Num({ value: adm.trackInterval === undefined || adm.trackInterval === null ? 0 : adm.trackInterval, onChange: function (e) { setA('trackInterval', Math.max(0, Number(e.target.value) || 0)) } }), '0=每轮总结；N=每 N 轮总结一次。首次总结时把间隔记录到该会话的记忆文件里，之后该会话按自己的记录判断（配置改了会新增一条记录），跨重启不丢'),
          CheckRow('修改当前活跃后通知注入', (adm.trackInjectActive === undefined ? false : !!adm.trackInjectActive), function (e) { setA('trackInjectActive', e.target.checked) }, '是：每轮新对话尝试注入当前活跃新变化（摘要，仅此一项）；否（默认）：不注入，模型需要时自行 memory_query，节约输入 token'),
          Row('摘要注入长度（字符）', Num({ value: cfg.summaryInjectChars || 300, onChange: function (e) { set('summaryInjectChars', Math.max(20, Number(e.target.value) || 300)) } }), '对话跟踪工具更新活跃摘要后，注入其他会话的摘要截取字符数（默认 300，中文语义完整；设小可省 token）'),
          CheckRow('精确到步骤（步骤指向）', adm.trackRefPrecision === 'step', function (e) { setA('trackRefPrecision', e.target.checked ? 'step' : 'turn') }, '勾选 = 溯源准确到 会话@轮次:stepN（高精度，适合强模型）；不勾 = 整轮指向 会话@轮次（默认，适合一般模型）'),
          React.createElement('div', { style: indent },
            React.createElement('div', { style: subHintStyle }, '节约模式（可多选叠加；都不勾 = 读取全部）：'),
            CheckRow('不总结工具使用和输出', (function () { var v = adm.trackEconomize; return Array.isArray(v) ? v.indexOf('output') >= 0 : v === 'output' })(), function (e) {
              var cur = Array.isArray(adm.trackEconomize) ? adm.trackEconomize.slice() : (adm.trackEconomize && adm.trackEconomize !== 'none' ? [adm.trackEconomize] : [])
              if (e.target.checked) { if (cur.indexOf('output') < 0) cur.push('output') }
              else { cur = cur.filter(function (x) { return x !== 'output' }) }
              setA('trackEconomize', cur)
            }, '只看用户+assistant 文本，跳过工具调用与结果'),
            CheckRow('只保留用户消息+末尾截断', (function () { var v = adm.trackEconomize; return Array.isArray(v) ? v.indexOf('truncated') >= 0 : v === 'truncated' })(), function (e) {
              var cur = Array.isArray(adm.trackEconomize) ? adm.trackEconomize.slice() : (adm.trackEconomize && adm.trackEconomize !== 'none' ? [adm.trackEconomize] : [])
              if (e.target.checked) { if (cur.indexOf('truncated') < 0) cur.push('truncated') }
              else { cur = cur.filter(function (x) { return x !== 'truncated' }) }
              setA('trackEconomize', cur)
            }, '最省 token：用户消息 + 全部步骤文本，超出只保留末尾 k token'),
            (function () { var v = adm.trackEconomize; return Array.isArray(v) ? v.indexOf('truncated') >= 0 : v === 'truncated' })() ? Row('截断保留量', KNum({ value: (adm.trackTruncK || 2) * 1000, onChange: function (v) { setA('trackTruncK', Math.round(v / 1000) || 1) } }), 'k token') : null,
          ),
        ) : null,
      ))

      // ── 强化记忆搜索 ──────────────────────────────────────────
      sections.push(Section('强化记忆搜索',
        CheckRow('启用强化记忆搜索', !!(adm.enhance), function (e) { setA('enhance', e.target.checked) }, ''),
        adm.enhance ? React.createElement('div', { style: subCard },
          DescBlock('作用：帮 agent 做更广的记忆检索，避免只按字面词漏掉相关内容。\n触发：手动调用（memory_enhance mode=query），无定时。\n流程：模型读取「真实命中记忆 + 引用记忆展开 + 对话上下文」后输出扩展检索词和相关记忆；扩展词二次召回，相关项逐条做真实性校验，编造的直接忽略。'),
          Row('模型配置', React.createElement(ModelConfigBlock, { value: adm.enhanceModel || {}, global: globalModel, providers: providers, onChange: function (v) { setA('enhanceModel', v) } }), '必须选择模型：留空跟随记忆管理员模型，管理员未配置则强化搜索不运行（只有对话跟踪支持无模型）'),
          Row('查阅深度', Num({ value: adm.enhanceMaxDepth || 3, onChange: function (e) { setA('enhanceMaxDepth', Number(e.target.value) || 3) } }), '展开命中记忆的关联层数'),
        ) : null,
      ))


      // ── 周期总结记忆 ──────────────────────────────────────────
      sections.push(Section('周期总结记忆',
        CheckRow('启用周期总结', !!(adm.period), function (e) { setA('period', e.target.checked) }, '定时自动总结事件记忆'),
        adm.period ? React.createElement('div', { style: subCard },
          DescBlock('作用：每隔一段时间把"未总结过的事件记忆"批量压缩成一份周期总结，防止事件越积越多。\n触发：后台每分钟检查一次，距上次周期总结 ≥ 设定时长即触发。\n筛选：按影响度（查询次数权重 + 时间衰减）排序取前 N% 或前 N 个。\n输出：周期记忆文件（记录覆盖的事件溯源），已覆盖事件打上 summarizedAt 标记。'),
          Row('模型配置', React.createElement(ModelConfigBlock, { value: adm.periodModel || {}, global: globalModel, providers: providers, onChange: function (v) { setA('periodModel', v) } }), '必须选择模型：留空跟随记忆管理员模型，管理员未配置则周期总结不运行（只有对话跟踪支持无模型）'),
          Row('周期定时（日 + 时）', React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            Num({ value: adm.periodDays || 1, onChange: function (e) { setA('periodDays', Number(e.target.value) || 1) } }),
            React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '日'),
            Num({ value: adm.periodHours || 0, onChange: function (e) { setA('periodHours', Number(e.target.value) || 0) } }),
            React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '时'),
          ), countdown ? React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, countdown) : null),
          Row('最近素材跳过天数', Num({ value: adm.periodSkipRecent === undefined || adm.periodSkipRecent === null ? 14 : adm.periodSkipRecent, min: 14, onChange: function (e) { setA('periodSkipRecent', Math.max(14, Number(e.target.value) || 14)) } }), '最近 N 天的事件素材不参与周期总结（默认 14，**最小 14**）；可总结窗口 = [最近 N 天前 ~ 最近 7 天前]，最近 7 天固定不压缩（保持近期记忆"热"），窗口内无可总结内容时自动放弃本次周期'),
          Row('周期影响度', React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            Num({ value: (adm.periodImpactCount && adm.periodImpactCount > 0) ? adm.periodImpactCount : adm.periodImpactPercent || 100, onChange: function (e) {
              if (adm.periodImpactCount && adm.periodImpactCount > 0) { setA('periodImpactCount', Math.max(1, Math.round(Number(e.target.value) || 1))) }
              else { setA('periodImpactPercent', Math.min(100, Math.max(1, Number(e.target.value) || 100))) }
            } }),
            React.createElement('select', {
              style: Object.assign({}, inputStyle, { width: 130 }),
              value: (adm.periodImpactCount && adm.periodImpactCount > 0) ? 'count' : 'percent',
              onChange: function (e) {
                if (e.target.value === 'count') { setA('periodImpactCount', Math.max(1, Math.round(Number(adm.periodImpactPercent) || 1))); setA('periodImpactPercent', 100) }
                else { setA('periodImpactCount', 0) }
              },
            },
              React.createElement('option', { value: 'percent' }, '%（比例，float）'),
              React.createElement('option', { value: 'count' }, '个（固定条数，int）'),
            ),
          ), '按影响度排序后取前 N% 或前 N 个'),
          React.createElement('div', { style: indent },
            React.createElement('div', { style: subHintStyle }, '素材范围（方案 + 素材档位）：'),
            Row('总结方案', React.createElement('select', {
              style: Object.assign({}, inputStyle, { width: 200 }),
              value: Number(adm.periodScope) || 1,
              onChange: function (e) {
                var s = Number(e.target.value) || 1
                setA('periodScope', s)
              },
            },
              React.createElement('option', { value: 1 }, '方案1 · 仅记忆（省 token）'),
              React.createElement('option', { value: 2 }, '方案2 · +会话首尾（推荐）'),
              React.createElement('option', { value: 3 }, '方案3 · +全量轮次（最准最贵）'),
            ), '方案1=事件记忆+无模型；方案2=再加会话首尾轮；方案3=全部轮次：对话跟踪已总结的直接合并，未总结的读取原文触发总结'),
            (Number(adm.periodScope) || 1) === 3 ? React.createElement('div', { style: indent },
              React.createElement('div', { style: subHintStyle }, '未总结轮次读取原文时的节约参数（周期总结运行配置，持久生效）：'),
              CheckRow('跳过工具输出', (function () { var v = adm.periodEconomize; return Array.isArray(v) ? v.indexOf('output') >= 0 : v === 'output' })(), function (e) {
                var cur = Array.isArray(adm.periodEconomize) ? adm.periodEconomize.slice() : (adm.periodEconomize && adm.periodEconomize !== 'none' ? [adm.periodEconomize] : [])
                if (e.target.checked) { if (cur.indexOf('output') < 0) cur.push('output') }
                else { cur = cur.filter(function (x) { return x !== 'output' }) }
                setA('periodEconomize', cur)
              }, '读取未总结轮次时只保留用户+assistant 文本，跳过工具调用与结果'),
              CheckRow('只保留末尾 k token', (function () { var v = adm.periodEconomize; return Array.isArray(v) ? v.indexOf('truncated') >= 0 : v === 'truncated' })(), function (e) {
                var cur = Array.isArray(adm.periodEconomize) ? adm.periodEconomize.slice() : (adm.periodEconomize && adm.periodEconomize !== 'none' ? [adm.periodEconomize] : [])
                if (e.target.checked) { if (cur.indexOf('truncated') < 0) cur.push('truncated') }
                else { cur = cur.filter(function (x) { return x !== 'truncated' }) }
                setA('periodEconomize', cur)
              }, '最省 token：只保留末尾 k token'),
              (function () { var v = adm.periodEconomize; return Array.isArray(v) ? v.indexOf('truncated') >= 0 : v === 'truncated' })() ? Row('末尾保留量', KNum({ value: (adm.periodTruncK || 2) * 1000, onChange: function (v) { setA('periodTruncK', Math.round(v / 1000) || 1) } }), 'k token') : null,
            ) : null,
            Row('工具记忆参与总结', Check({ checked: (adm.periodUseTools === undefined ? true : !!adm.periodUseTools), onChange: function (e) { setA('periodUseTools', e.target.checked) } }), '是否把工具产生的记忆纳入周期总结素材（默认开）'),
            Row('周期智能体（空=全部）', React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', flex: 1 } },
              (adm.periodAgents && adm.periodAgents.length)
                ? adm.periodAgents.map(function (a) {
                    var lb = a
                    for (var i = 0; i < isoAgentsList.length; i++) { if (isoAgentsList[i] && isoAgentsList[i].key === a) { lb = isoAgentsList[i].label || a; break } }
                    return React.createElement('span', { key: a, style: { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 4, fontSize: 11, background: 'var(--dsw-alias-bg-layer-1)' } },
                      React.createElement('span', {}, lb),
                      React.createElement('a', { href: 'javascript:void(0)', title: '移除（恢复为全部）', style: { color: 'var(--dsw-alias-label-secondary)', textDecoration: 'none', cursor: 'pointer', fontWeight: 700 }, onClick: function (e) { e.stopPropagation(); setA('periodAgents', (adm.periodAgents || []).filter(function (x) { return x !== a })) } }, '×'),
                    )
                  })
                : React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 } }, '未选择 = 全部智能体'),
              React.createElement('button', { style: mmBtn, title: '多选智能体（只做这些智能体的周期总结）', onClick: function () {
                var init = {}
                var cur = adm.periodAgents || []
                for (var i = 0; i < cur.length; i++) init[cur[i]] = true
                setPeriodPickSel(init)
                setPeriodPickOpen(true)
              } }, '+'),
            ), '空=全部智能体（统一时间周期，各智能体各生成自己的周期总结）；选中 = 只做这些智能体；周期文件自动标识所属智能体'),
          ),
          React.createElement('div', { style: { marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 } },
            Button({ disabled: busy, onClick: function () { doPeriodRun() } }, '立刻执行周期总结'),
            React.createElement('label', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginLeft: 8 } },
              Check({ checked: !!(resetPeriodTimer), onChange: function (e) { setResetPeriodTimer(e.target.checked) } }), ' 本次作为新的计时基准（重置倒计时）'),
          ),
        ) : null,
      ))

      // ── 记忆污染隔离 ──────────────────────────────────────────
      sections.push(Section('记忆污染隔离',
        Row('回溯到（年月日时间）', React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          React.createElement('input', { type: 'datetime-local', style: inputStyle, value: targetTime, max: toLocalInput(new Date()), onChange: function (e) { setTargetTime(e.target.value) } }),
          React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '（不超过当前时间）'))),
        // 指定智能体隔离：空=隔离全部；选了只隔离这些智能体的记忆文件
        React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', marginTop: 6, fontSize: 12 } },
          React.createElement('span', { style: { width: 170, flexShrink: 0, color: 'var(--dsw-alias-label-secondary)' } }, '仅隔离智能体（空=全部）'),
          React.createElement('div', { style: { flex: 1, display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', minWidth: 200 } },
            isoAgents.length
              ? isoAgents.map(function (a) {
                  return React.createElement('span', { key: a.key, style: { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 4, fontSize: 11, background: 'var(--dsw-alias-bg-layer-1)' } },
                    React.createElement('span', {}, a.label || a.key),
                    React.createElement('a', { href: 'javascript:void(0)', title: '移除（恢复为全部）', style: { color: 'var(--dsw-alias-label-secondary)', textDecoration: 'none', cursor: 'pointer', fontWeight: 700 }, onClick: function (e) { e.stopPropagation(); setIsoAgents(isoAgents.filter(function (x) { return x.key !== a.key })) } }, '×'),
                  )
                })
              : React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 } }, '未选择 = 隔离全部智能体的记忆文件'),
            React.createElement('button', { style: mmBtn, title: '多选智能体（只隔离这些智能体的记忆）', onClick: function () {
              var init = {}
              for (var i = 0; i < isoAgents.length; i++) init[isoAgents[i].key] = true
              setIsoPickSel(init)
              setIsoPickOpen(true)
            } }, '+'),
          ),
        ),
        React.createElement('div', { style: { marginTop: 6 } }, React.createElement('button', { style: dangerStyle, disabled: busy, onClick: doIsolation }, '⚠ 触发隔离（快照并回溯到指定时间）')),
        React.createElement('div', { style: { marginTop: 10 } },
          incidents.length === 0 ? React.createElement('div', { style: msgStyle }, '（无隔离事件）') : incidents.map(function (inc) { return React.createElement('div', { key: inc.id, style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 12 } },
            React.createElement('span', { style: { flex: 1 } }, inc.id + ' 目标 ' + inc.targetTime + ' ' + inc.fileCount + ' 文件' + (inc.restoredAt ? ' ·已回滚' : inc.clearedAt ? ' ·已解除' : ' ·待处理')),
            !inc.restoredAt && !inc.clearedAt ? React.createElement(Button, { onClick: function () { act('incident-restore', inc.id, '已回滚') } }, '回滚') : null,
            React.createElement(Button, { onClick: function () { act('incident-clear', inc.id, '已解除') } }, '解除'),
          ) }),
        ),
      ))

      // ── 状态与诊断 ────────────────────────────────────────────
      sections.push(Section('状态与诊断',
        React.createElement('div', { style: msgStyle }, '根目录：' + (stats && stats.root || '') + '\n配置路径：' + (diag && diag.cfgPath || '') + '\n本日新增：重要 ' + ((stats && stats.today && stats.today.important) || 0) + ' 条 · 事件 ' + ((stats && stats.today && stats.today.events) || 0) + ' 条' + '\n归档时间内（' + ((stats && stats.days) || 30) + ' 天）：重要 ' + ((stats && stats.within && stats.within.important) || 0) + ' 条 · 周期 ' + ((stats && stats.within && stats.within.period) || 0) + ' 条 · 事件 ' + ((stats && stats.within && stats.within.events) || 0) + ' 条' + '\n全部统计：重要 ' + (stats && stats.important || 0) + ' 条 · 周期 ' + (stats && stats.period || 0) + ' 条 · 补充 ' + (stats && stats.archive || 0) + ' 条 · 事件 ' + (stats && stats.events || 0) + ' 条' + ((stats && stats.noModel > 0) ? '\n无模型记忆 ' + stats.noModel + ' 条' : '')),
      ))
      // 文本里的 URL 渲染成可点击链接（项目地址转跳用）
      function withLinks(text) {
        var s = String(text || '')
        var parts = s.split(/(https?:\/\/[^\s\)\]）]+)/g)
        var out = []
        for (var i = 0; i < parts.length; i++) {
          var seg = parts[i]
          if (/^https?:\/\//.test(seg)) {
            out.push(React.createElement('a', { key: 'u' + i, href: seg, target: '_blank', rel: 'noreferrer', style: { color: 'var(--dsw-alias-label-primary)', textDecoration: 'underline', wordBreak: 'break-all' } }, seg))
          } else if (seg) {
            out.push(seg)
          }
        }
        return out.length ? out : s
      }
      sections.push(Section('版本与更新',
        CheckRow('自动检查更新', cfg.autoUpdateCheck !== false, function (e) { set('autoUpdateCheck', e.target.checked) }, '启动后 8 秒 + 每 12 小时自动检查一次新版本（git 安装 fetch 对比 / 手动安装版本号+清单对比）；仅检查不自动下载。关 = 只手动点"检查更新"'),
        React.createElement('div', { style: msgStyle }, (updateInfo && updateInfo.text) ? withLinks(updateInfo.text) : ('当前版本：' + ((updateInfo && updateInfo.info && updateInfo.info.version) || '?') + (updateInfo && updateInfo.info && updateInfo.info.tag ? '（' + updateInfo.info.tag + '）' : '') + '\n点击"检查更新"查看是否有新版本')),
        React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' } },
          Button({ disabled: busy || updateBusy, onClick: function () {
            setBusy(true)
            callHost('mm-update-check', { force: true }).then(function (r) { setUpdateInfo(r || { text: '（无返回）' }) }).catch(function (e) { setUpdateInfo({ text: '检查失败：' + String((e && e.message) || e) }) }).finally(function () { setBusy(false) })
          } }, '检查更新'),
          Button({ disabled: busy || updateBusy || !(updateInfo && updateInfo.hasUpdate), onClick: function () {
            askConfirm('确认更新插件到最新版本？更新后需重启 DSH 生效。', function () {
              setUpdateBusy(true)
              callHost('mm-update', {}).then(function (r) { setUpdateInfo(r || { text: '（无返回）' }) }).catch(function (e) { setUpdateInfo({ text: '更新失败：' + String((e && e.message) || e) }) }).finally(function () { setUpdateBusy(false) })
            })
          } }, '更新'),
        ),
        React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 6, whiteSpace: 'pre-wrap' } }, '说明：git 安装（推荐）检查并拉取更新；手动安装按版本号 + MANIFEST 清单对比，增量下载校验后原子覆盖（备份保留最近一份，临时文件自动清理），重启 DSH 生效。'),
      ))

      return React.createElement('div', { style: { maxWidth: 640 } },
        sections,
        React.createElement('div', { style: { marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 } },
          React.createElement('span', {
            style: { fontSize: 12, color: saveStatus.indexOf('失败') >= 0 ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)' },
          }, saveStatus || '改动自动保存（输入框失焦 / 勾选即存）'),
          Button({ onClick: function () { persistCfg(cfgRef.current) } }, '立即保存'),
        ),
        msg ? React.createElement('div', { style: msgStyle }, msg) : null,
        // 保存结果浮窗（右上角，3 秒自动消失）
        toast ? React.createElement('div', {
          style: {
            position: 'fixed', top: 16, right: 16, zIndex: 99999,
            padding: '8px 14px', borderRadius: 6, fontSize: 12, lineHeight: 1.5,
            background: toast.ok ? 'var(--dsw-alias-bg-layer-1)' : 'var(--dsw-alias-state-error-primary)',
            border: '1px solid var(--dsw-alias-border-l1)',
            color: toast.ok ? 'var(--dsw-alias-label-primary)' : '#fff',
            boxShadow: '0 4px 14px rgba(0,0,0,0.25)', maxWidth: 320, whiteSpace: 'pre-wrap',
          },
        }, toast.text) : null,
        // 页面内确认浮层（替代 window.confirm）
        confirmState ? React.createElement('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 99999 }, onClick: function (e) { if (e.target === e.currentTarget) setConfirmState(null) } },
          React.createElement('div', { style: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, maxWidth: 420, width: '90%', padding: 16 } },
            React.createElement('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 10, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 8 } }, '确认操作'),
            React.createElement('div', { style: { fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap', marginBottom: 12 } }, confirmState.text),
            React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
              React.createElement('button', { style: btnStyle, onClick: function () { setConfirmState(null) } }, '取消'),
              React.createElement('button', { style: dangerStyle, onClick: function () { var fn = confirmState.onConfirm; setConfirmState(null); if (fn) fn() } }, '确认'),
            ),
          ),
        ) : null,
        // 隔离目标智能体多选弹窗：空=全部；确认=只隔离选中的
        isoPickOpen ? React.createElement('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 99998 }, onClick: function (e) { if (e.target === e.currentTarget) setIsoPickOpen(false) } },
          React.createElement('div', { style: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, maxWidth: 420, width: '90%', maxHeight: '80vh', display: 'flex', flexDirection: 'column', padding: 16 } },
            React.createElement('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 10, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 8 } }, '选择智能体（隔离目标）'),
            React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } }, '勾选后点「确认」，只隔离这些智能体的记忆文件；不勾选任何 = 隔离全部（当前选择的默认勾选，可取消）。'),
            React.createElement('div', { style: { flex: 1, overflowY: 'auto', marginBottom: 12 } },
              isoAgentsList.length
                ? isoAgentsList.map(function (a) {
                    var key = a && a.key
                    var checked = !!isoPickSel[key]
                    return React.createElement('label', { key: key, style: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 2px', fontSize: 12, cursor: 'pointer' } },
                      Check({ checked: checked, onChange: function (e) {
                        setIsoPickSel(function (prev) {
                          var m = Object.assign({}, prev || {})
                          if (e.target.checked) m[key] = true
                          else delete m[key]
                          return m
                        })
                      } }),
                      React.createElement('span', {}, a.label || key),
                    )
                  })
                : React.createElement('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, '（加载智能体列表…）'),
            ),
            React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
              React.createElement('button', { style: btnStyle, onClick: function () { setIsoPickOpen(false) } }, '取消'),
              React.createElement('button', { style: btnStyle, onClick: function () {
                var sel = isoAgentsList.filter(function (a) { return isoPickSel[a.key] })
                setIsoAgents(sel)
                setIsoPickOpen(false)
                setMsg(sel.length ? ('隔离目标：' + sel.length + ' 个智能体') : '隔离目标：全部智能体')
              } }, '确认'),
            ),
          ),
        ) : null,
        // 周期总结智能体多选弹窗：空=全部（统一时间周期，各智能体各生成自己的周期总结）
        periodPickOpen ? React.createElement('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 99997 }, onClick: function (e) { if (e.target === e.currentTarget) setPeriodPickOpen(false) } },
          React.createElement('div', { style: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, maxWidth: 420, width: '90%', maxHeight: '80vh', display: 'flex', flexDirection: 'column', padding: 16 } },
            React.createElement('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 10, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 8 } }, '选择智能体（周期总结）'),
            React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } }, '勾选后点「确认」，只做这些智能体的周期总结；不勾选任何 = 全部智能体（当前选择的默认勾选，可取消）。每个智能体各生成自己的周期总结文件。'),
            React.createElement('div', { style: { flex: 1, overflowY: 'auto', marginBottom: 12 } },
              isoAgentsList.length
                ? isoAgentsList.map(function (a) {
                    var key = a && a.key
                    var checked = !!periodPickSel[key]
                    return React.createElement('label', { key: key, style: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 2px', fontSize: 12, cursor: 'pointer' } },
                      Check({ checked: checked, onChange: function (e) {
                        setPeriodPickSel(function (prev) {
                          var m = Object.assign({}, prev || {})
                          if (e.target.checked) m[key] = true
                          else delete m[key]
                          return m
                        })
                      } }),
                      React.createElement('span', {}, a.label || key),
                    )
                  })
                : React.createElement('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, '（加载智能体列表…）'),
            ),
            React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
              React.createElement('button', { style: btnStyle, onClick: function () { setPeriodPickOpen(false) } }, '取消'),
              React.createElement('button', { style: btnStyle, onClick: function () {
                var sel = isoAgentsList.filter(function (a) { return periodPickSel[a.key] }).map(function (a) { return a.key })
                setA('periodAgents', sel)
                setPeriodPickOpen(false)
                setMsg(sel.length ? ('周期总结智能体：' + sel.length + ' 个') : '周期总结智能体：全部')
              } }, '确认'),
            ),
          ),
        ) : null,
      )
    }

    // 调 host channel /mmsettings/<endpoint>
    function callHost(endpoint, payload) {
      return fetch('/mmsettings/' + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'mm-' + Math.random().toString(36).slice(2, 12),
          method: endpoint,
          payload: payload || {},
        }),
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      }).then(function (full) {
        if (full && full.result && full.result.value !== undefined) return full.result.value
        if (full && full.result && full.result.ok === false) throw new Error((full.result.error && (full.result.error.message || full.result.error.code)) || 'rpc error')
        return full
      })
    }


// 记忆管理面板（对话页签"记忆"）——4 页 Tab 在顶部显示
// ═══════════════════════════════════════════════════════════════════
var mmTabRow = { display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-l1)', padding: '4px 8px', position: 'sticky', top: 0, background: 'var(--dsw-alias-bg-layer-1)', zIndex: 5, flexWrap: 'wrap' }
var mmTabStyle = function (active) { return { padding: '4px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 12, border: '1px solid ' + (active ? 'var(--dsw-alias-border-l1)' : 'transparent'), background: active ? 'var(--dsw-alias-bg-layer-1)' : 'transparent', color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)', fontWeight: active ? 600 : 400 } }
var mmCard = { margin: '8px 12px', fontSize: 12, lineHeight: 1.6 }
var mmItem = { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flexWrap: 'wrap' }
var mmItemMeta = { width: 110, flexShrink: 0, color: 'var(--dsw-alias-label-secondary)' }
var mmArea = { flex: 1, minWidth: 200, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 4, padding: 6, fontSize: 12, color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit', minHeight: 40 }
var mmBtn = { padding: '3px 10px', borderRadius: 4, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontSize: 12 }
var mmEmpty = { color: 'var(--dsw-alias-label-secondary)', padding: 12, fontSize: 12 }

function MemoryView(props) {
  // 当前窗口会话 id：由 conversation.view slot 标准 props 注入（框架按 session 作用域提供）
  var sessionId = props && props.sessionId
  var tab = React.useState(mmLastTab)
  var tabV = tab[0]
  var setTabRaw = tab[1]
  function setTab(id) {
    mmLastTab = id
    try { sessionStorage.setItem('mmLastTab', id) } catch (e) {}
    // 切出"会话记忆"页签时退出会话轮次视图（focus 为临时浏览态，切页应回列表）
    if (id !== 'sessions') {
      var fs = focusSidV
      setFocusSid('')
      if (fs) setTurns(null)
    }
    // 清掉编辑/补充残留，避免切页后数据不刷新（"切换页面无效"）
    if (editState) setEditState(null)
    if (gapEdit) setGapEdit(null)
    // 切页签时关闭所有超链接弹窗（弹窗残留会遮挡/干扰新页面）
    if (popupV && popupV.length) popupClear()
    setTabRaw(id)
    // 切页签立即滚回顶部（不等 effect：快速切换时旧页可能滚在底部，新内容渲染后停在顶部）
    setScrollPos({})
    if (scrollBoxRef.current) scrollBoxRef.current.scrollTop = 0
    try { window.scrollTo(0, 0) } catch (e) {}  // 兜底外层页面滚动（DSH 布局可能由外层容器滚动）
  var turns = React.useState(null)
  var turnsV = turns[0]
  var setTurns = turns[1]
  var kws = React.useState(null)
  var kwsV = kws[0]
  var setKws = kws[1]
  var active = React.useState(null)
  var activeV = active[0]
  var setActive = active[1]
  var periods = React.useState(null)
  var periodsV = periods[0]
  var setPeriods = periods[1]
  var busy = React.useState(false)
  var busyV = busy[0]
  var setBusy = busy[1]
  var msg = React.useState('')
  var msgV = msg[0]
  var setMsg = msg[1]
  var editStateS = React.useState(null)
  var editState = editStateS[0]
  var setEditState = editStateS[1]
  // 活跃页历史记录：分类过滤（默认增量更新+遗忘更新）+ 分页加载
  var histCatS = React.useState('default')
  var histCat = histCatS[0]
  var setHistCat = histCatS[1]
  var histPageS = React.useState(1)
  var histPage = histPageS[0]
  var setHistPage = histPageS[1]
  var scrollPos = React.useState({})
  var scrollPosV = scrollPos[0]
  var setScrollPos = scrollPos[1]
  // 滚动容器 ref：切页签/进出会话时滚回顶部（跨页签恢复上次滚动位置会造成"新内容从底部出现"）
  var scrollBoxRef = React.useRef(null)
  // 请求序号：快速切换页签时多个异步查询并发，响应按序号校验——过期响应直接丢弃，避免旧数据覆盖新页/滚动跳动
  var reqSeqRef = React.useRef(0)
  // 当前页签 ref：供 EventSource 回调读取最新 tab（effect 闭包只捕获初始值）
  var tabRef = React.useRef(tabV)
  // host 数据版本号（内存缓存保持 + 版本变化才重查）：0=未初始化（首次切页不强制），会话切换时重置
  var dataVersionRef = React.useRef(0)
  // 页面内确认浮层（替代 window.confirm：嵌入环境可能被拦截导致点击无反应）
  var confirmS = React.useState(null)
  var confirmState = confirmS[0]
  var setConfirmState = confirmS[1]
  function askConfirm(text, fn) { setConfirmState({ text: text, onConfirm: fn }) }
  // 智能体列表（[{key,label}]）与关键词页智能体筛选（白名单：null=未初始化；[]=未筛选 → 显示全部）
  var agentsS = React.useState([])
  var agentsV = agentsS[0]
  var setAgents = agentsS[1]
  var curAgentS = React.useState('')
  var curAgentV = curAgentS[0]
  var setCurAgent = curAgentS[1]
  var kwFilterS = React.useState(null)
  var kwFilterV = kwFilterS[0]
  var setKwFilter = kwFilterS[1]
  // 智能体多选弹窗（+ 筛选智能体）：open / 勾选集合
  var agentPickOpenS = React.useState(false)
  var agentPickOpenV = agentPickOpenS[0]
  var setAgentPickOpen = agentPickOpenS[1]
  var agentPickSelS = React.useState({})
  var agentPickSelV = agentPickSelS[0]
  var setAgentPickSel = agentPickSelS[1]
  // 活跃页「增加关键词」弹窗：数据 / 时间范围 / 含归档 / 选中集合 / 列表滚动容器
  var kwAddOpenS = React.useState(false)
  var kwAddOpenV = kwAddOpenS[0]
  var setKwAddOpen = kwAddOpenS[1]
  var kwAddDataS = React.useState(null)
  var kwAddDataV = kwAddDataS[0]
  var setKwAddData = kwAddDataS[1]
  var kwAddFromS = React.useState('')
  var kwAddFromV = kwAddFromS[0]
  var setKwAddFrom = kwAddFromS[1]
  var kwAddToS = React.useState('')
  var kwAddToV = kwAddToS[0]
  var setKwAddTo = kwAddToS[1]
  var kwAddArchS = React.useState(false)
  var kwAddArchV = kwAddArchS[0]
  var setKwAddArch = kwAddArchS[1]
  var kwAddSelS = React.useState({})
  var kwAddSelV = kwAddSelS[0]
  var setKwAddSel = kwAddSelS[1]
  var kwAddListRef = React.useRef(null)
  // 活跃页查看的智能体（单选）：'' = 当前会话智能体；否则 preset:xxx
  var activeAgentS = React.useState('')
  var activeAgentV = activeAgentS[0]
  var setActiveAgent = activeAgentS[1]
  // 智能体显示名：优先 agentPresets 的 name，兜底去 preset: 前缀
  function agentLabel(key) {
    var k = String(key || '')
    if (k.indexOf('preset:') === 0) {
      for (var i = 0; i < agentsV.length; i++) {
        if (agentsV[i] && agentsV[i].key === k) return agentsV[i].label || k.slice(7)
      }
      return k.slice(7)
    }
    return k
  }
  // 按当前窗口会话解析其智能体（ownerKey），回调返回 agent；失败兜底 preset:cordis
  function resolveCurrentAgent(cb) {
    callHost('mm-agent-of-session', { session: sessionId || '' }).then(function (r) {
      var a = (r && r.agent) || 'preset:cordis'
      if (cb) cb(a)
    }).catch(function () { if (cb) cb('preset:cordis') })
  }
  // 加载智能体列表 + 当前智能体（按当前窗口会话解析）；初始化筛选 = 仅当前智能体
  function ensureAgentsLoaded() {
    if (agentsV.length) return
    callHost('mm-agent-list', {}).then(function (r) {
      var list = (r && r.items) || []
      setAgents(list)
      resolveCurrentAgent(function (cur) {
        setCurAgent(cur)
        setKwFilter([cur])
      })
    }).catch(function (e) { setMsg(String((e && e.message) || e)) })
  }
  // 会话变化（当前窗口绑定会话切换/智能体变动）→ 智能体筛选跟随
  React.useEffect(function () {
    if (!sessionId) return
    resolveCurrentAgent(function (cur) {
      if (cur !== curAgentV) {
        setCurAgent(cur)
        setKwFilter([cur])
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])
  // 时间范围（界面"从/到"可任选方向）：查询时自动取 min/max，避免 from>to 导致空结果
  function rangeSwap(f, t) {
    var fMs = f ? new Date(f + 'T00:00:00').getTime() : 0
    var tMs = t ? new Date(t + 'T23:59:59').getTime() : 0
    if (fMs && tMs && fMs > tMs) { var tmp = fMs; fMs = tMs; tMs = tmp }
    return { from: fMs, to: tMs }
  }
  // 智能体白名单过滤：筛选列表非空且关键词与筛选无交集 → 隐藏；无归属（agents 空）或筛选空 → 显示
  function kwHiddenByAgent(it) {
    if (!kwFilterV || !kwFilterV.length) return false
    if (!it || !it.agents || !it.agents.length) return false
    for (var i = 0; i < it.agents.length; i++) {
      if (kwFilterV.indexOf(it.agents[i]) >= 0) return false
    }
    return true
  }
  // 会话归属过滤：筛选非空且会话归属不在筛选内 → 隐藏；无归属（子会话）已由 host 过滤，兜底隐藏
  function sessionHiddenByAgent(it) {
    if (!kwFilterV || !kwFilterV.length) return false
    var a = it && it.agent
    if (!a) return true
    return kwFilterV.indexOf(a) < 0
  }
  // 周期归属过滤：筛选非空且周期与筛选无交集 → 隐藏；无归属（共享）始终显示
  function periodHiddenByAgent(it) {
    if (!kwFilterV || !kwFilterV.length) return false
    if (!it || !it.agents || !it.agents.length) return false
    for (var i = 0; i < it.agents.length; i++) {
      if (kwFilterV.indexOf(it.agents[i]) >= 0) return false
    }
    return true
  }
  // 共享智能体筛选行（关键词/会话记忆/周期总结页共用）：默认当前会话智能体；× 移除；+ 弹窗多选；空=全部
  function renderAgentFilterRow() {
    return React.createElement('div', { key: '__agent', style: Object.assign({}, mmItem, { alignItems: 'center', flexWrap: 'wrap' }) },
      React.createElement('div', { style: { width: 130, flexShrink: 0, fontWeight: 600 } }, '智能体筛选'),
      React.createElement('div', { style: { flex: 1, display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', minWidth: 200 } },
        (kwFilterV && kwFilterV.length)
          ? kwFilterV.map(function (a) {
              return React.createElement('span', { key: a, style: { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 4, fontSize: 11, background: 'var(--dsw-alias-bg-layer-1)' } },
                React.createElement('span', {}, agentLabel(a) + (a === curAgentV ? '（当前）' : '')),
                React.createElement('a', { href: 'javascript:void(0)', title: '移除该智能体', style: { color: 'var(--dsw-alias-label-secondary)', textDecoration: 'none', cursor: 'pointer', fontWeight: 700 }, onClick: function (e) { e.stopPropagation(); setKwFilter(kwFilterV.filter(function (x) { return x !== a })) } }, '×'),
              )
            })
          : React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 } }, '未筛选，显示全部'),
        React.createElement('button', { style: mmBtn, title: '多选智能体（只显示这些智能体的记录）', onClick: openAgentPick }, '+'),
      ),
      React.createElement('div', { style: { width: '100%', color: 'var(--dsw-alias-label-secondary)', fontSize: 11 } },
        '默认只显示当前智能体（' + agentLabel(curAgentV || 'preset:cordis') + '）的记录；点 × 移除 → 该智能体记录不再显示；空白=全部显示；无归属记录始终显示。'),
    )
  }
  // 保存当前智能体活跃记忆（MemoryView 层，供 renderActive 与增加弹窗共用）
  function saveActivePayload(payload) {
    var agentFile = (activeV && activeV.agent) || 'preset_cordis'
    setBusy(true)
    callHost('mm-active-save', Object.assign({ session: sessionId || '', agent: agentFile }, payload)).then(function (r) { setMsg((r && r.text) || '已保存'); setEditState(null); refreshTab('active', true) }).catch(function (e) { setMsg(String((e && e.message) || e)) }).finally(function () { setBusy(false) })
  }
  // 移除活跃记忆中的一个关键词（直接生效，可随时再加回）
  function removeActiveKeyword(word) {
    var w = String(word || '').trim()
    var next = (activeV.keywords || []).filter(function (x) {
      var cur = typeof x === 'string' ? x : String((x && x.word) || '')
      return cur.trim() !== w
    })
    saveActivePayload({ keywords: next })
  }
  // 活跃页「增加关键词」弹窗：加载候选列表（时间范围/含归档/智能体排除与关键词页一致）
  // arch/from/to 显式传入（onChange 里 setState 后 state 未更新，读当前值会滞后）
  function loadKwAddData(arch, from, to) {
    var archOn = arch !== undefined ? arch : kwAddArchV
    var fromV = from !== undefined ? from : kwAddFromV
    var toV = to !== undefined ? to : kwAddToV
    setBusy(true)
    var rng = rangeSwap(fromV, toV)
    var p = archOn
      ? callHost('mm-keyword-archive', { from: rng.from, to: rng.to })
      : callHost('mm-keyword-list', {})
    p.then(function (r) { setKwAddData((r && r.items) || []) })
      .catch(function (e) { setMsg(String((e && e.message) || e)) })
      .finally(function () { setBusy(false) })
  }
  function openKwAdd() {
    ensureAgentsLoaded()
    setKwAddSel({})
    setKwAddData(null)
    setKwAddOpen(true)
    // 常规范围：从 = 最旧压缩时间，到 = 今天（覆盖全部补充区内容）
    callHost('mm-keyword-archive', { from: 0, to: 0 }).then(function (r) {
      var oldest = (r && r.oldestArchiveAt) || 0
      setKwArchMeta({ oldest: oldest, newest: (r && r.newestArchiveAt) || 0 })
      if (oldest) setKwOldest(new Date(oldest).toISOString().slice(0, 10))
      var f = oldest ? new Date(oldest).toISOString().slice(0, 10) : ''
      setKwAddFrom(f)
      setKwAddTo(todayStr())
      loadKwAddData(kwAddArchV, f, todayStr())
    }).catch(function () {
      setKwAddFrom('')
      setKwAddTo(todayStr())
      loadKwAddData(kwAddArchV, '', todayStr())
    })
  }
  // 点击切换选中：- 变 +（选中）→ 自动置顶；恢复滚动位置（列表重排不跳动）
  function toggleKwAddSel(path) {
    var keep = kwAddListRef.current ? kwAddListRef.current.scrollTop : 0
    setKwAddSel(function (prev) {
      var m = Object.assign({}, prev || {})
      if (m[path]) delete m[path]
      else m[path] = true
      return m
    })
    setTimeout(function () { if (kwAddListRef.current) kwAddListRef.current.scrollTop = keep }, 0)
  }
  // 确认增加：选中词去重合并进当前活跃 keywords
  function confirmKwAdd() {
    var picked = (kwAddDataV || []).filter(function (it) { return kwAddSelV[it.path] }).map(function (it) { return String(it.title || '') }).filter(Boolean)
    if (!picked.length) { setMsg('请先选择要增加的关键词'); return }
    var existing = (activeV.keywords || []).map(function (x) { return typeof x === 'string' ? x : String((x && x.word) || '') })
    var next = existing.slice()
    for (var i = 0; i < picked.length; i++) {
      if (next.indexOf(picked[i]) < 0) next.push(picked[i])
    }
    setKwAddOpen(false)
    saveActivePayload({ keywords: next })
  }
  // 打开智能体多选弹窗：预勾选当前筛选的智能体（确认=替换筛选集合）
  function openAgentPick() {
    var init = {}
    if (kwFilterV) { for (var i = 0; i < kwFilterV.length; i++) init[kwFilterV[i]] = true }
    setAgentPickSel(init)
    setAgentPickOpen(true)
  }
  var newKw = React.useState('')
  var newKwV = newKw[0]
  var setNewKw = newKw[1]
  var newKwContent = React.useState('')
  var newKwContentV = newKwContent[0]
  var setNewKwContent = newKwContent[1]
  // 关键词搜索词（空格分隔多词，全部匹配 title/content）
  var kwSearch = React.useState('')
  var kwSearchV = kwSearch[0]
  var setKwSearch = kwSearch[1]
  // 关键词页：含归档查询（勾选后走补充区时间范围查询）+ 展开折叠（标题/摘要→全文）
  var kwArch = React.useState(false)
  var kwArchV = kwArch[0]
  var setKwArch = kwArch[1]
  var kwFrom = React.useState('')
  var kwFromV = kwFrom[0]
  var setKwFrom = kwFrom[1]
  var kwTo = React.useState('')
  var kwToV = kwTo[0]
  var setKwTo = kwTo[1]
  var kwArchMeta = React.useState(null) // {oldest, newest} 归档时间范围
  var kwArchMetaV = kwArchMeta[0]
  var setKwArchMeta = kwArchMeta[1]
  // 重要区列表缓存：勾选「含归档」时保留，取消后恢复（不闪加载、不重新查询）
  var kwImpCacheS = React.useState(null)
  var kwImpCacheV = kwImpCacheS[0]
  var setKwImpCache = kwImpCacheS[1]
  // 最旧压缩时间（补充区最早年月包）：时间选择器 min 限制 = 该值，max = 今天（"今天 ~ 最旧"范围）
  var kwOldestS = React.useState('')
  var kwOldestV = kwOldestS[0]
  var setKwOldest = kwOldestS[1]
  // 关键词页时间选择是否已做过首次填充（避免每次刷新覆盖用户手改）
  var kwTimeInitRef = React.useRef(false)
  // 从列表项计算日期范围（updatedAt 最早/最晚）
  function itemsDateRange(items) {
    var mn = '', mx = ''
    for (var i = 0; i < (items || []).length; i++) {
      var d = String((items[i] && items[i].updatedAt) || '').slice(0, 10)
      if (!d) continue
      if (!mn || d < mn) mn = d
      if (!mx || d > mx) mx = d
    }
    return mn ? { min: mn, max: mx } : null
  }
  // 今天日期（本地）
  function todayStr() {
    var d = new Date()
    var p = function (n) { return (n < 10 ? '0' : '') + n }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }
  var expandedMap = React.useState({}) // path -> true（通用展开状态：关键词/周期内容折叠）
  var expandedV = expandedMap[0]
  var setExpanded = expandedMap[1]
  function toggleExpanded(path) { setExpanded(function (prev) { var m = Object.assign({}, prev || {}); if (m[path]) delete m[path]; else m[path] = true; return m }) }
  var popup = React.useState([])
  var popupV = popup[0]
  var setPopup = popup[1]
  function popupPush(item) { setPopup(function (prev) { return (prev || []).concat([item]) }) }
  function popupPop() { setPopup(function (prev) { return (prev && prev.length > 1) ? prev.slice(0, -1) : [] }) }
  function popupClear() { setPopup([]) }
  // 轮次页会话范围：false=仅当前窗口会话（默认），true=全部会话
  var scopeAll = React.useState(false)
  var scopeAllV = scopeAll[0]
  var setScopeAll = scopeAll[1]
  // 会话轮次页：未归档会话列表
  var sessions = React.useState(null)
  var sessionsV = sessions[0]
  var setSessions = sessions[1]
  // 时间段 + 归档搜索
  var timeFrom = React.useState('')
  var timeFromV = timeFrom[0]
  var setTimeFrom = timeFrom[1]
  var timeTo = React.useState('')
  var timeToV = timeTo[0]
  var setTimeTo = timeTo[1]
  var searchArch = React.useState(false)
  var searchArchV = searchArch[0]
  var setSearchArch = searchArch[1]
  // 会话标题搜索（会话记忆页）
  var sessionSearch = React.useState('')
  var sessionSearchV = sessionSearch[0]
  var setSessionSearch = sessionSearch[1]
  // 点击会话 → 进入该会话轮次列表
  var focusSid = React.useState('')
  var focusSidV = focusSid[0]
  var setFocusSid = focusSid[1]
  // 周期方案升级目标
  var upgradeTargetS = React.useState(null)
  var upgradeTarget = upgradeTargetS[0]
  var setUpgradeTarget = upgradeTargetS[1]
  // 周期重新总结（双模式重审）目标
  var rereviewTargetS = React.useState(null)
  var rereviewTarget = rereviewTargetS[0]
  var setRereviewTarget = rereviewTargetS[1]
  // 轮次「重新总结」双模式目标（{sid, turn}）
  var rereviewTurnS = React.useState(null)
  var rereviewTurn = rereviewTurnS[0]
  var setRereviewTurn = rereviewTurnS[1]


  // 当前会话轮次范围（host mm-turn-list 返回 min/max，用于缺失检测）
  var turnRangeS = React.useState(null)
  var turnRange = turnRangeS[0]
  var setTurnRange = turnRangeS[1]
  // 会话跟踪配置映射（sid → {startTurn, interval}），来自聚合文件 trackMeta，用于"跟踪设定内未总结"判断
  var trackMetaMapS = React.useState({})
  var trackMetaMap = trackMetaMapS[0]
  var setTrackMetaMap = trackMetaMapS[1]
  // 缺失区间补充编辑态：{ key:'4-7', turn:7, value:'' }（turn=当前编辑的轮次，默认区间最大值）
  var gapEditS = React.useState(null)
  var gapEdit = gapEditS[0]
  var setGapEdit = gapEditS[1]
  // 配置（host config RPC 扁平结构；用于轮次页展示触发间隔等）
  var cfgState = React.useState(null)
  var cfgV = cfgState[0]
  var setCfgV = cfgState[1]
  // 会话记忆页时间范围是否已按"全局最新~最旧"初始化（避免用户手动清空后被反复填充）
  var rangeInitRef = React.useRef(false)
  // 周期页时间范围是否已按"文件最早~最晚"初始化
  var periodRangeInitRef = React.useRef(false)

  function refreshTab(t, force, opts) {
    // 前端缓存：非强制刷新且该页已有数据 → 直接显示缓存，不重拉、不闪"加载中"
    var has = t === 'turns' ? !!turnsV
      : t === 'sessions' ? (focusSidV ? !!turnsV : !!sessionsV)
      : t === 'kws' ? !!kwsV
      : t === 'active' ? !!activeV
      : !!periodsV
    if (!force && has) return
    // 请求序号：本次请求的标识；响应回来时若序号已过期（期间又切换/刷新了页）则丢弃
    var mySeq = ++reqSeqRef.current
    setBusy(true)
    var p = Promise.resolve()
    // 时间范围：'YYYY-MM-DD' → 毫秒（from=当天0点，to=当天23:59:59）；opts 可显式传（onChange 里 state 未更新）
    var fMs = opts && opts.fromMs !== undefined ? opts.fromMs : (timeFromV ? new Date(timeFromV + 'T00:00:00').getTime() : 0)
    var tMs = opts && opts.toMs !== undefined ? opts.toMs : (timeToV ? new Date(timeToV + 'T23:59:59').getTime() : 0)
    // 强制刷新时先清空对应页数据 → 显示"加载中"；缓存命中（非 force）不动现有数据
    if (t === 'turns') setTurns(force ? null : turnsV)
    if (t === 'sessions') { if (focusSidV) setTurns(force ? null : turnsV); else setSessions(force ? null : sessionsV) }
    if (t === 'kws') setKws(force ? null : kwsV)
    if (t === 'active') setActive(force ? null : activeV)
    if (t === 'periods') setPeriods(force ? null : periodsV)
    if (t === 'turns') p = callHost('mm-turn-list', { sid: focusSidV || (scopeAllV ? '' : (sessionId || '')), from: 0, to: 0, includeArchive: searchArchV, force: force }).then(function (r) { if (mySeq !== reqSeqRef.current) return; setTurns((r && r.items) || []); setTurnRange((r && r.turnRange) || null); setTrackMetaMap((r && r.trackMetaMap) || {}) })
    // 会话记忆页：列表态加载会话列表；进入某会话（focusSidV 非空）时加载该会话轮次
    if (t === 'sessions') {
      if (focusSidV) p = callHost('mm-turn-list', { sid: focusSidV, from: fMs || 0, to: tMs || 0, includeArchive: searchArchV, force: force }).then(function (r) { if (mySeq !== reqSeqRef.current) return; setTurns((r && r.items) || []) })
      else p = callHost('mm-session-list', { force: force }).then(function (r) {
        if (mySeq !== reqSeqRef.current) return
        setSessions((r && r.items) || [])
        // 首次打开会话记忆页时，时间选择范围 = 记忆文件最新 ~ 最旧
        var gr = r && r.globalRange
        if (!rangeInitRef.current && gr && gr.from && gr.to) {
          rangeInitRef.current = true
          setTimeFrom(new Date(gr.from).toISOString().slice(0, 10))
          setTimeTo(new Date(gr.to).toISOString().slice(0, 10))
        }
      })
    }
    if (t === 'kws') {
      if (kwArchV) {
        var ra = rangeSwap(kwFromV, kwToV)
        p = callHost('mm-keyword-archive', { from: ra.from, to: ra.to }).then(function (r) {
          if (mySeq !== reqSeqRef.current) return
          setKws((r && r.items) || [])
          setKwArchMeta({ oldest: (r && r.oldestArchiveAt) || 0, newest: (r && r.newestArchiveAt) || 0 })
        })
      } else {
        p = callHost('mm-keyword-list', {}).then(function (r) {
          if (mySeq !== reqSeqRef.current) return
          var items = (r && r.items) || []
          setKws(items); setKwArchMeta(null); setKwImpCache(items)
          // 首次加载：默认填充时间选择 = 重要区记忆最旧 ~ 最新（常规方向；不空；之后用户手改不覆盖）
          if (!kwTimeInitRef.current) {
            kwTimeInitRef.current = true
            var rg0 = itemsDateRange(items)
            if (rg0) { setKwFrom(rg0.min); setKwTo(rg0.max) }
          }
        }).then(function () {
          // 顺带取最旧压缩时间（未勾选归档时时间选择器同样限制"今天 ~ 最旧"）
          return callHost('mm-keyword-archive', { from: 0, to: 0 }).then(function (r2) {
            if (r2 && r2.oldestArchiveAt) setKwOldest(new Date(r2.oldestArchiveAt).toISOString().slice(0, 10))
          }).catch(function () {})
        })
      }
    }
    if (t === 'active') p = callHost('mm-active-read', { session: sessionId || '', agent: activeAgentV || undefined }).then(function (r) { if (mySeq !== reqSeqRef.current) return; setActive((r && r.data) || null) })
    if (t === 'periods') p = callHost('period-history', { from: fMs || 0, to: tMs || 0 }).then(function (r) {
      if (mySeq !== reqSeqRef.current) return
      var items = (r && r.items) || []
      setPeriods(items)
      // 首次打开：默认填充时间 = 周期文件最早 ~ 最晚（不空）
      if (!periodRangeInitRef.current && items.length) {
        periodRangeInitRef.current = true
        var pmn = '', pmx = ''
        for (var pi = 0; pi < items.length; pi++) {
          var pd = String((items[pi] && items[pi].createdAt) || '').slice(0, 10)
          if (!pd) continue
          if (!pmn || pd < pmn) pmn = pd
          if (!pmx || pd > pmx) pmx = pd
        }
        if (pmn) { setTimeFrom(pmn); setTimeTo(pmx) }
      }
    })
    p.catch(function (e) { if (mySeq === reqSeqRef.current) setMsg('加载失败: ' + String((e && e.message) || e)) }).finally(function () { if (mySeq === reqSeqRef.current) setBusy(false) })
  }
  // 保存轮次总结编辑（编辑已有或新增缺失轮次）；失焦自动保存与保存按钮共用
  function saveTurnEdit() {
    var es = editState
    if (!es) return
    var savePayload = es.path && String(es.path).indexOf('__new_turn_') !== 0
      ? { rel: es.path, content: es.value }
      : { ref: (es.ref || (sessionId + '@' + (es.turn || 0))), content: es.value }
    setBusy(true)
    callHost('mm-turn-save', savePayload).then(function (r) {
      setMsg((r && r.text) || '已保存')
      setEditState(null)
      refreshTab(focusSidV ? 'sessions' : 'turns')
    }).catch(function (e) { setMsg(String((e && e.message) || e)) }).finally(function () { setBusy(false) })
  }
  // 退出会话轮次视图：清空 focus/编辑/补充态，回到会话列表（防止"返回后卡住"）
  function leaveFocus() {
    setEditState(null)
    setGapEdit(null)
    setFocusSid('')
    setTurns(null)
    setSessions(null)
  }
  // 会话切换（新窗口/换会话）或范围切换时按当前 sessionId 重载；tab 变化时刷新对应页
  // 编辑中不自动刷新（仅放弃/确认/模型更新后手动 refreshTab 触发）
  // 切页签：数据内存常驻（不清缓存）。切换时查 host 数据版本——版本变了才强制重查该页，
  // 没变直接显示内存数据（秒切、零查询）。版本号由 host 在任意记忆写盘后递增。
  React.useEffect(function () {
    tabRef.current = tabV
    if (editState) return
    callHost('mm-data-version', {}).then(function (r) {
      var v = r && r.version !== undefined ? Number(r.version) : -1
      var changed = dataVersionRef.current !== 0 && v !== dataVersionRef.current
      dataVersionRef.current = v
      refreshTab(tabV, changed)
    }).catch(function () { refreshTab(tabV, false) })
  }, [tabV])
  // 会话/范围/焦点变化：数据源变了，强制重新查询（新会话/新筛选 = 全新数据，版本重置）
  React.useEffect(function () { dataVersionRef.current = 0 }, [sessionId])
  React.useEffect(function () { if (!editState) refreshTab(tabV, true) }, [sessionId, scopeAllV, timeFromV, timeToV, searchArchV, focusSidV, editState])
  // 切页签/进出会话：滚动回顶部并清空跨页签滚动记忆（避免恢复上次底部位置，新内容从下方出现）
  React.useEffect(function () {
    setScrollPos({})
    if (scrollBoxRef.current) scrollBoxRef.current.scrollTop = 0
    try { window.scrollTo(0, 0) } catch (e) {}  // 兜底外层滚动
  }, [tabV, focusSidV])
  // 加载配置（轮次页展示触发间隔等）
  React.useEffect(function () {
    callHost('config').then(function (r) {
      setCfgV((r && r.config) || null)
    }).catch(function () {})
  }, [])
  // 挂载时加载智能体列表（关键词页/活跃页增加弹窗共用）
  React.useEffect(function () { ensureAgentsLoaded() }, [])

  // 自适应高度 textarea：内容变化时自动撑高（min 40，max 60vh）
  // autoSave：可选，失焦时自动保存（记忆面板编辑改完点别处即保存，无需找保存按钮）
  function autoTextArea(value, onChange, extraStyle, keyHint, autoSave) {
    return React.createElement('textarea', {
      key: keyHint || undefined,
      style: Object.assign({}, mmArea, { width: '100%', boxSizing: 'border-box', resize: 'vertical', overflowY: 'auto' }, extraStyle || {}),
      value: value || '',
      onChange: function (e) {
        var el = e.target
        el.style.height = 'auto'
        el.style.height = Math.min(el.scrollHeight, Math.max(40, Math.floor(window.innerHeight * 0.6))) + 'px'
        onChange(e)
      },
      onBlur: function () { if (autoSave) autoSave() },
      ref: function (el) { if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, Math.max(40, Math.floor(window.innerHeight * 0.6))) + 'px' } },
    })
  }
  // md 链接渲染与跳转：
  // - [文字](记忆累积/重要/xxx.json) → 跳关键词页
  // - [文字](记忆累积/周期记忆/...) → 跳周期页
  // - [文字](会话id@轮次) → 弹窗显示该会话轮次内容
  // - 其他路径 → 弹窗显示（读文件内容）
  function linkClick(linkText, href) {
    var h = String(href || '').replace(/\\/g, '/')
    // 关键词/引用 → 弹窗（浮窗）打开对应记忆内容（与引用转跳一致的浮窗体验）
    if (h.indexOf('/重要/') >= 0 || /^重要\//.test(h)) {
      var kw = String(linkText || '').trim()
      popupPush({ title: kw, text: '加载中…' })
      callHost('mm-ref-read', { path: h }).then(function (r) {
        setPopup(function (prev) {
          if (!prev || !prev.length) return prev
          return prev.slice(0, -1).concat([{ title: kw, text: (r && (r.content || r.text)) || (r && r.ok === false ? r.text : '（无内容）') }])
        })
      }).catch(function (e) {
        setPopup(function (prev) {
          if (!prev || !prev.length) return prev
          return prev.slice(0, -1).concat([{ title: kw, text: '读取失败：' + String((e && e.message) || e) }])
        })
      })
      return
    }
    // 周期
    if (h.indexOf('/周期记忆/') >= 0) {
      setTab('periods')
      setPeriods(null)
      setMsg('已切换到周期总结页')
      return
    }
    // 会话@轮次 或 其他路径 → 弹窗：先占位（加载中）立即出现，数据回来刷新栈顶（点击转跳即反馈，可继续翻页）
    popupPush({ title: linkText, text: '加载中…' })
    // ref 必须传链接地址（会话id@轮次），不能传显示文字——否则后端解析不了中文要点短名
    callHost('mm-ref-read', { ref: h, path: h }).then(function (r) {
      setPopup(function (prev) {
        if (!prev || !prev.length) return prev
        var body = (r && (r.content || r.text))
          ? (r.content || r.text)
          : (r && r.ok === false ? ('⚠ ' + r.text + '\n（该引用未找到对应内容，可能是模型生成的无效指向）') : '（无内容）')
        return prev.slice(0, -1).concat([{ title: linkText, text: body }])
      })
    }).catch(function (e) {
      setPopup(function (prev) {
        if (!prev || !prev.length) return prev
        return prev.slice(0, -1).concat([{ title: linkText, text: '读取失败：' + String((e && e.message) || e) }])
      })
    })
  }
  // 行内样式渲染：**粗体** `代码` [链接](路径) *斜体*
  function inlineMd(text, keyBase) {
    var s = String(text || '')
    var parts = []
    var re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*\n]+\*)/g
    var last = 0
    var match = re.exec(s)
    var k = 0
    while (match !== null) {
      if (match.index > last) parts.push(s.slice(last, match.index))
      var tok = match[0]
      if (tok.indexOf('**') === 0) {
        parts.push(React.createElement('strong', { key: (keyBase || 'm') + '-' + k }, tok.slice(2, -2)))
      } else if (tok.indexOf('`') === 0) {
        parts.push(React.createElement('code', { key: (keyBase || 'm') + '-' + k, style: { background: 'var(--dsw-alias-bg-layer-1)', padding: '1px 4px', borderRadius: 3, fontSize: '0.95em' } }, tok.slice(1, -1)))
      } else if (tok.indexOf('[') === 0) {
        var lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
        var lbl = lm ? lm[1] : tok
        var hr = lm ? lm[2] : ''
        var ca = { linkText: lbl, href: hr }
        // IIFE 捕获：var 是函数级作用域，直接引用 ca 会让所有链接点击都指向最后一个链接
        parts.push(React.createElement('a', { key: (keyBase || 'm') + '-' + k, href: 'javascript:void(0)', style: { color: 'var(--dsw-alias-label-primary)', textDecoration: 'underline', cursor: 'pointer' }, onClick: (function (c) { return function () { linkClick(c.linkText, c.href) } })(ca) }, lbl))
      } else {
        parts.push(React.createElement('em', { key: (keyBase || 'm') + '-' + k }, tok.slice(1, -1)))
      }
      last = match.index + tok.length
      k++
      match = re.exec(s)
    }
    if (last < s.length) parts.push(s.slice(last))
    return parts.length ? parts : s
  }
  // 简单 markdown 渲染：标题/列表/引用/分隔线/代码块 + 行内样式
  // （已移除）省略显示 ellipsis：页面显示改用全文（用户确认不需要中间省略）
  function mdText(t) {
    var s = String(t || '')
    var lines = s.split('\n')
    var out = []
    var inCode = false
    var codeBuf = []
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      var trimmed = line.trim()
      // 代码块
      if (trimmed.indexOf('```') === 0) {
        if (inCode) { out.push(React.createElement('pre', { key: 'l' + i, style: { background: 'var(--dsw-alias-bg-layer-1)', padding: '10px 12px', borderRadius: 6, overflowX: 'auto', fontSize: '0.92em', lineHeight: 1.6, margin: '8px 0' } }, React.createElement('code', null, codeBuf.join('\n')))); codeBuf = [] }
        inCode = !inCode
        continue
      }
      if (inCode) { codeBuf.push(line); continue }
      if (!trimmed) { out.push(React.createElement('div', { key: 'l' + i, style: { height: 10 } })); continue }
      // 标题
      var h = trimmed.match(/^(#{1,4})\s+(.*)$/)
      if (h) {
        var level = h[1].length
        var hStyle = { fontWeight: 700, margin: '12px 0 6px', fontSize: level === 1 ? 17 : level === 2 ? 16 : level === 3 ? 15 : 14, lineHeight: 1.4 }
        out.push(React.createElement('div', { key: 'l' + i, style: hStyle }, inlineMd(h[2], 'h' + i)))
        continue
      }
      // 分隔线
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        out.push(React.createElement('div', { key: 'l' + i, style: { borderTop: '1px solid var(--dsw-alias-border-l1)', margin: '10px 0' } }))
        continue
      }
      // 引用
      if (trimmed.indexOf('>') === 0) {
        out.push(React.createElement('div', { key: 'l' + i, style: { borderLeft: '3px solid var(--dsw-alias-border-l1)', padding: '4px 10px', margin: '6px 0', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.7, background: 'var(--dsw-alias-bg-layer-1)', borderRadius: '0 4px 4px 0' } }, inlineMd(trimmed.replace(/^>\s?/, ''), 'q' + i)))
        continue
      }
      // 列表项（- / * / 数字.）
      var li = trimmed.match(/^([-*+]|\d+[.)])\s+(.*)$/)
      if (li) {
        out.push(React.createElement('div', { key: 'l' + i, style: { display: 'flex', gap: 8, paddingLeft: 14, margin: '4px 0', lineHeight: 1.7 } },
          React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', flexShrink: 0 } }, li[1].replace(/\d+[.)]/, '•')),
          React.createElement('span', { style: { flex: 1 } }, inlineMd(li[2], 'li' + i)),
        ))
        continue
      }
      // 普通行
      out.push(React.createElement('div', { key: 'l' + i, style: { margin: '4px 0', lineHeight: 1.7 } }, inlineMd(line, 'p' + i)))
    }
    if (inCode && codeBuf.length) out.push(React.createElement('pre', { key: 'lend', style: { background: 'var(--dsw-alias-bg-layer-1)', padding: '10px 12px', borderRadius: 6, overflowX: 'auto', fontSize: '0.92em', lineHeight: 1.6, margin: '8px 0' } }, React.createElement('code', null, codeBuf.join('\n'))))
    return out.length ? out : s
  }
  // 轮次页：倒序（最新在前）+ 直接显示轮次号 + 编辑
  // 默认仅显示当前窗口会话（sessionId 由 slot 标准 props 注入）的轮次总结；可切换查看全部会话
  // 模型重新总结（方案B 同步直调）：提交 → 等 motionMemoryApi.turnRereview 返回 → 显示成功/失败
  function doResummarize(sid, tno, mode) {
    setBusy(true)
    callHost('mm-turn-resummarize', { sid: sid, turn: tno, mode: mode || 'current' }).then(function (r) {
      setBusy(false)
      if (r && r.ok) {
        setMsg((r && r.text) || ('重新总结完成：轮次 ' + tno))
        setTurns(null)
        refreshTab('turns', true)
      } else {
        setMsg((r && r.text) || '重新总结失败：未知错误')
      }
    }).catch(function (e) { setBusy(false); setMsg(String((e && e.message) || e)) })
  }
  function renderTurns() {
    if (!turnsV) return React.createElement('div', { style: mmEmpty }, busyV ? '加载中…' : '（无轮次总结）')
    var items = turnsV.slice().sort(function (a, b) {
      var ha = (a.ref || '').lastIndexOf('@'), hb = (b.ref || '').lastIndexOf('@')
      var sa = ha >= 0 ? a.ref.slice(0, ha) : (a.ref || '')
      var sb = hb >= 0 ? b.ref.slice(0, hb) : (b.ref || '')
      if (sa !== sb) return sa < sb ? -1 : 1
      var ta = ha >= 0 ? Number(a.ref.slice(ha + 1)) || 0 : 0
      var tb = hb >= 0 ? Number(b.ref.slice(hb + 1)) || 0 : 0
      return tb - ta
    })
    // 间隔信息：跟踪关闭 → "未跟踪"；跟踪开启 → 优先该会话事件记忆的 trackMeta 实际间隔，回退全局配置
    var trackOn = !!(cfgV && cfgV.admin && cfgV.admin.track)
    var curSid = focusSidV || sessionId || ''
    var curMeta = trackMetaMap && trackMetaMap[curSid]
    var trackInterval = (cfgV && cfgV.admin && cfgV.admin.trackInterval !== undefined && cfgV.admin.trackInterval !== null) ? cfgV.admin.trackInterval : 0
    var effInterval = curMeta ? (Number(curMeta.interval) || 0) : trackInterval
    var intervalLabel = !trackOn
      ? '未跟踪'
      : (effInterval === 0 ? '每轮' : ('每 ' + effInterval + ' 轮')) + (curMeta ? '（会话记录）' : '')
    var failedList = items.filter(function (x) { return x && x.noModel && x.fail })
    var retryBtn = failedList.length ? React.createElement('button', { style: mmBtn, onClick: function () {
        askConfirm('重试 ' + failedList.length + ' 个失败总结（当前活跃记忆总结）？', function () {
          failedList.forEach(function (x) {
            var tno2 = Number((x.ref.match(/@(\d+)/) || [])[1]) || 0
            if (tno2) doResummarize((x.ref.split('@')[0] || ''), tno2, 'current')
          })
        })
      } }, '重试所有失败总结（' + failedList.length + '）') : null
    var scopeLabel = scopeAllV
      ? ('全部会话 · ' + items.length + ' 条' + (focusSidV ? '（聚焦 ' + focusSidV.slice(0, 8) + '…）' : ''))
      : ('当前会话：' + (sessionId || '（未注入）') + ' · ' + items.length + ' 条 · 间隔：' + intervalLabel)
    var scopeBar = React.createElement('div', { key: '__scope', style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: '1px dashed var(--dsw-alias-border-l1)', fontSize: 12 } },
      React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all', flex: 1 } }, scopeLabel),
      React.createElement('button', { style: mmBtn, title: scopeAllV ? '切回仅显示当前窗口会话的轮次总结' : '查看所有会话的轮次总结', onClick: function () { setScopeAll(!scopeAllV) } }, scopeAllV ? '仅当前会话' : '全部会话'),
      retryBtn,
    )
    // 缺失/未设置轮次：第一轮(1) 到当前轮(turnRange.max 或已有最大轮) 全覆盖，连续缺失合并为区间
    var existingTurns = items.map(function (it) { return Number((it.ref.match(/@(\d+)/) || [])[1]) || 0 }).filter(function (n) { return n > 0 })
    var rangeMax = turnRange ? turnRange.max : (existingTurns.length ? Math.max.apply(null, existingTurns) : 0)
    var present = {}
    for (var mi = 0; mi < existingTurns.length; mi++) present[existingTurns[mi]] = true
    var missingGaps = []
    if (rangeMax >= 1) {
      var curStart = 0
      for (var tn = 1; tn <= rangeMax; tn++) {
        if (present[tn]) { if (curStart) { missingGaps.push({ start: curStart, end: tn - 1 }); curStart = 0 } }
        else if (!curStart) curStart = tn
      }
      if (curStart) missingGaps.push({ start: curStart, end: rangeMax })
    }
    function gapKey(g) { return g.start + '-' + g.end }
    function gapOfTurn(t) { for (var i = 0; i < missingGaps.length; i++) { if (t >= missingGaps[i].start && t <= missingGaps[i].end) return missingGaps[i] } return null }
    // 补充编辑态动作
    function startGapEdit(g) {
      setGapEdit({ key: gapKey(g), start: g.start, end: g.end, turn: g.end, value: '' })
    }
    function updateGapEdit(patch) {
      setGapEdit(Object.assign({}, gapEdit, patch))
    }
    function saveGapEdit() {
      var ge = gapEdit
      if (!ge) return
      if (!(ge.value || '').trim()) { setMsg('请输入总结内容'); return }
      setBusy(true)
      callHost('mm-turn-save', { ref: (sessionId || '') + '@' + ge.turn, content: ge.value }).then(function (r) {
        setMsg((r && r.text) || '已创建'); setGapEdit(null); refreshTab('turns', true)
      }).catch(function (e) { setMsg(String((e && e.message) || e)) }).finally(function () { setBusy(false) })
    }
    function gapResummarize(ge, mode) {
      setGapEdit(null)
      askConfirm('用模型总结轮次 ' + ge.turn + '（' + (mode === 'at-time' ? '当时活跃' : '当前活跃') + '记忆总结）？', function () {
        doResummarize((sessionId || ''), ge.turn, mode)
      })
    }
    // 渲染单条缺失区间行（正常态或编辑态）
    function renderGapRow(g) {
      var single = g.start === g.end
      var editing = gapEdit && gapEdit.key === gapKey(g)
      if (editing) {
              var ge = gapEdit
              return React.createElement('div', { key: '__gap_' + gapKey(g), style: Object.assign({}, mmItem, { background: 'var(--dsw-alias-bg-layer-1)' }) },
                // 第一行：轮次号输入框 + 数值范围提示（换行显示范围）
                React.createElement('div', { style: { width: '100%', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' } },
                  React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '轮次'),
                  React.createElement('input', {
                    style: Object.assign({}, inputStyle, { width: 64 }),
                    type: 'number', min: g.start, max: g.end,
                    value: ge.turn,
                    onChange: function (e) { var v = Math.max(g.start, Math.min(g.end, Number(e.target.value) || g.end)); updateGapEdit({ turn: v }) },
                  }),
                  React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, '范围 ' + g.start + ' - ' + g.end),
                ),
                // 第二行：文本框独占一行横向填满（失焦自动保存）
                React.createElement('div', { style: { width: '100%', marginBottom: 8 } },
                  autoTextArea(ge.value || '', function (e) { updateGapEdit({ value: e.target.value }) }, null, null, saveGapEdit),
                ),
                // 第三行：按钮独立一行靠右下角
                React.createElement('div', { style: { width: '100%', display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' } },
                  React.createElement('button', { style: mmBtn, onClick: function () { setGapEdit(null) } }, '取消'),
                  React.createElement('button', { style: mmBtn, onClick: saveGapEdit }, '保存'),
                  React.createElement('button', { style: mmBtn, onClick: function () { gapResummarize(ge, 'at-time') } }, '当时活跃总结'),
                  React.createElement('button', { style: mmBtn, onClick: function () { gapResummarize(ge, 'current') } }, '现在记忆总结'),
                ),
              )
      }
      // 正常态：判断该区间是否在跟踪设定内（track 启用 且 该会话已有跟踪基准 且 区间起点 >= 基准起始轮次）
      // trackOn/curMeta 已由 renderTurns 顶层计算（同一函数作用域）
      // curMeta（trackMeta 最后一条）不存在 = 该会话从未建立跟踪基准（还没总结过）→ 一律"未设置轮次总结"，
      // 避免"启用跟踪后所有缺失轮次（含启用前的老轮次）都被标成跟踪设定内未总结"
      var trackStart = curMeta ? (Number(curMeta.startTurn) || 0) : -1
      var inTrack = !!curMeta && trackOn && g.start >= trackStart
      var statusText = inTrack
        ? '跟踪设定内未总结'
        : '未设置轮次总结'
      return React.createElement('div', { key: '__gap_' + gapKey(g), style: Object.assign({}, mmItem, { background: 'var(--dsw-alias-bg-layer-1)' }) },
        React.createElement('div', { style: mmItemMeta }, single ? '轮次 ' + g.start : ('轮次 ' + g.start + '-' + g.end)),
        React.createElement('div', { style: { flex: 1, minWidth: 200, color: 'var(--dsw-alias-state-warn-primary)' } }, statusText),
        React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
        React.createElement('button', { style: mmBtn, onClick: function () { startGapEdit(g) } }, '补充'),
        ),
      )
    }
    // 已总结条目也按轮次号参与排序
    var allRows = []
    for (var ri = 0; ri < items.length; ri++) {
      var it = items[ri]
      var tno = Number((it.ref.match(/@(\d+)/) || [])[1]) || 0
      allRows.push({ kind: 'item', turn: tno, it: it })
    }
    for (var gi = 0; gi < missingGaps.length; gi++) {
      allRows.push({ kind: 'gap', turn: missingGaps[gi].start, g: missingGaps[gi] })
    }
    allRows.sort(function (a, b) { return b.turn - a.turn })
    var rowEls = []
    for (var di = 0; di < allRows.length; di++) {
      var d = allRows[di]
      if (d.kind === 'gap') rowEls.push(renderGapRow(d.g))
      else rowEls.push(renderTurnItem(d.it))
    }
    return [scopeBar].concat(rowEls)
  }
  // 单个已总结轮次条目渲染（renderTurns 内联拆分，供排序后渲染）
  function renderTurnItem(it) {
    var isEditing = editState && editState.path === it.path
    var turnNo = (it.ref.match(/@(\d+)/) || [])[1] || it.ref
    var itemTime = (it.createdAt || '').slice(0, 16).replace('T', ' ')
    var btnRow = { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', width: '100%', justifyContent: 'flex-end', marginTop: 4 }
          var noModel = !!it.noModel
          var rowStyle2 = noModel ? Object.assign({}, mmItem, { borderLeft: '3px solid var(--dsw-alias-state-warn-primary)', background: 'var(--dsw-alias-bg-layer-1)' }) : mmItem
          return React.createElement('div', { key: it.path, style: rowStyle2 },
            React.createElement('div', { style: mmItemMeta },
              ['轮次 ' + turnNo
              + (noModel ? (it.fail ? ' ⚠ 无模型记忆（模型总结失败）' : ' ⚠ 无模型记忆') : '')
              + (it.archived ? '（归档）' : '')
              + (itemTime ? '\n' + itemTime : '')]
              .concat(it.editHistory && it.editHistory.length ? [' · ',
                React.createElement('a', { key: 'h', href: 'javascript:void(0)', style: { textDecoration: 'underline', cursor: 'pointer' }, onClick: function () { popupPush({ title: '轮次 ' + turnNo + ' 修改历史', text: it.editHistory.map(function (h) { return (h.at || '').slice(0, 16).replace('T', ' ') + ' · ' + h.note }).join('\n') }) } }, '修改 ' + it.editHistory.length + ' 次'),
              ] : []),
            ),
            React.createElement('div', { style: { flex: 1, minWidth: 200 } },
              noModel ? React.createElement('div', { style: { marginBottom: 6, fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)' } },
                '⚠ 无模型记忆：仅记录用户消息' + (it.failNote ? '（模型总结失败：' + it.failNote + '）' : ''),
              ) : null,
              !isEditing
            ? React.createElement('div', { style: { whiteSpace: 'pre-wrap' } }, mdText(it.content))
            : autoTextArea(editState.value || '', function (e) { setEditState({ path: it.path, value: e.target.value }) }, null, null, saveTurnEdit),
          React.createElement('div', { style: btnRow },
            !isEditing
              ? React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' } },
                  React.createElement('button', { style: mmBtn, onClick: function () {
                      // 查看原始会话记录（会话日志 zstd 帧全文弹窗）
                      popupPush({ title: '轮次 ' + turnNo + ' 原始记录', text: '加载中…' })
                      callHost('mm-turn-raw', { ref: it.ref }).then(function (r) {
                        setPopup(function (prev) {
                          if (!prev || !prev.length) return prev
                          return prev.slice(0, -1).concat([{ title: '轮次 ' + turnNo + ' 原始记录', text: (r && (r.content || r.text)) || '（无内容）' }])
                        })
                      }).catch(function (e) {
                        setPopup(function (prev) {
                          if (!prev || !prev.length) return prev
                          return prev.slice(0, -1).concat([{ title: '轮次 ' + turnNo + ' 原始记录', text: '读取失败：' + String((e && e.message) || e) }])
                        })
                      })
                    } }, '原文'),
                  React.createElement('button', { style: mmBtn, onClick: function () {
                      // 归档条目：点修改时时间范围联动到该归档月
                      if (it.archived && it.month) { setTimeFrom(it.month + '-01'); setTimeTo(it.month + '-31') }
                      setEditState({ path: it.path, value: it.content || '' })
                    } }, '修改'),
                        noModel
                          ? React.createElement('button', { style: mmBtn, onClick: function () {
                              // 无模型记录转正：弹窗选「当前活跃记忆总结 / 当时活跃记忆总结」后执行（与重新总结一致）
                              var tno2 = Number((it.ref.match(/@(\d+)/) || [])[1]) || 0
                              if (!tno2) { setMsg('无法解析轮次'); return }
                              setRereviewTurn({ sid: (it.ref.split('@')[0] || ''), turn: tno2 })
                            } }, '模型总结')
                          : React.createElement('button', { style: mmBtn, onClick: function () {
                              // 重新总结：弹窗选「当前活跃记忆总结 / 当时活跃记忆总结」后执行
                              var tno = Number((it.ref.match(/@(\d+)/) || [])[1]) || 0
                              if (!tno) { setMsg('无法解析轮次'); return }
                              setRereviewTurn({ sid: (it.ref.split('@')[0] || ''), turn: tno })
                            } }, '重新总结'),
                )
              : React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
                  React.createElement('button', { style: mmBtn, onClick: saveTurnEdit }, '保存'),
                  React.createElement('button', { style: mmBtn, onClick: function () { setEditState(null) } }, '取消'),
                ),
          ),
        ),
      )
  }
  // 关键词页归档查询（显式 from/to：onChange 里 state 未更新，直接传值查询；自动刷新不再依赖"搜索"按钮）
  function searchKwArch(from, to) {
    setBusy(true)
    var rng = rangeSwap(from, to)
    callHost('mm-keyword-archive', { from: rng.from, to: rng.to }).then(function (r) {
      var meta = { oldest: (r && r.oldestArchiveAt) || 0, newest: (r && r.newestArchiveAt) || 0 }
      setKwArchMeta(meta)
      if (meta.oldest) setKwOldest(new Date(meta.oldest).toISOString().slice(0, 10))
      setKws((r && r.items) || [])
    }).catch(function (e) { setMsg(String((e && e.message) || e)) }).finally(function () { setBusy(false) })
  }
  // 关键词页：首行搜索 + 新增（标题+内容）+ 列表编辑/移补充/加回；按分数排序（host 已算 score）
  // 含归档（补充区）时间范围查询：默认近 7 天；取消勾选恢复重要区列表缓存
  function onKwArchChange(on) {
    setKwArch(on)
    if (on) {
      setBusy(true)
      callHost('mm-keyword-archive', { from: 0, to: 0 }).then(function (r) {
        var meta = { oldest: (r && r.oldestArchiveAt) || 0, newest: (r && r.newestArchiveAt) || 0 }
        setKwArchMeta(meta)
        if (meta.oldest) setKwOldest(new Date(meta.oldest).toISOString().slice(0, 10))
        setKws((r && r.items) || [])
        // 常规范围：从 = 最旧压缩时间，到 = 今天（覆盖全部补充区内容）
        if (meta.oldest) setKwFrom(new Date(meta.oldest).toISOString().slice(0, 10))
        setKwTo(todayStr())
      }).catch(function (e) { setMsg(String((e && e.message) || e)) }).finally(function () { setBusy(false) })
    } else {
      setKwArchMeta(null)
      setKwFrom(''); setKwTo('')
      // 恢复重要区列表缓存（不闪加载）；无缓存则手动拉取（不走 refreshTab 避免读到旧 kwArch 状态）
      if (kwImpCacheV && kwImpCacheV.length) {
        setKws(kwImpCacheV)
        setKwImpRange(itemsDateRange(kwImpCacheV))
      } else {
        setKws(null)
        setBusy(true)
        callHost('mm-keyword-list', {}).then(function (r) {
          var items = (r && r.items) || []
          setKws(items)
          setKwImpCache(items)
          setKwImpRange(itemsDateRange(items))
        }).catch(function (e) { setMsg(String((e && e.message) || e)) }).finally(function () { setBusy(false) })
      }
    }
  }
  function renderKws() {
    var archRow = React.createElement('div', { key: '__arch', style: Object.assign({}, mmItem, { alignItems: 'center', flexWrap: 'wrap' }) },
      React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
        Check({ checked: kwArchV, onChange: function (e) { onKwArchChange(e.target.checked) } }),
        React.createElement('span', {}, '含归档（补充区）'),
      ),
      React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 } }, '从'),
      React.createElement('input', { type: 'date', style: inputStyle, min: kwOldestV || undefined, max: kwToV || todayStr(), value: kwFromV, onChange: function (e) { var v = e.target.value; setKwFrom(v); if (kwArchV) { setKws(null); searchKwArch(v, kwToV) } } }),
      React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 } }, '到'),
      React.createElement('input', { type: 'date', style: inputStyle, min: kwFromV || kwOldestV || undefined, max: todayStr(), value: kwToV, onChange: function (e) { var v = e.target.value; setKwTo(v); if (kwArchV) { setKws(null); searchKwArch(kwFromV, v) } } }),
      React.createElement('button', { style: mmBtn, onClick: function () { setKwFrom(''); setKwTo(''); if (kwArchV) { setKws(null); searchKwArch('', '') } else { setKws(null); refreshTab('kws', true) } } }, '全部'),
      (kwArchV && kwArchMetaV && kwArchMetaV.newest) ? React.createElement('div', { key: '__hint', style: { width: '100%', color: 'var(--dsw-alias-label-secondary)', fontSize: 11, whiteSpace: 'pre-wrap' } },
        '默认窗口：从当前时间（' + new Date().toISOString().slice(0, 10) + '）到最旧归档 ' + (kwArchMetaV.oldest ? new Date(kwArchMetaV.oldest).toISOString().slice(0, 10) : '?') + '\n（"全部"可查全部归档；"从/到"可任选方向，自动取区间）') : null,
    )
    var searchRow = React.createElement('div', { key: '__search', style: Object.assign({}, mmItem, { alignItems: 'center' }) },
      React.createElement('div', { style: { width: 130, flexShrink: 0, fontWeight: 600 } }, '搜索关键词'),
      React.createElement('input', { style: Object.assign({}, mmArea, { minHeight: 24, flex: 1 }), placeholder: '输入文本，空格分隔多词（按分数排序）', value: kwSearchV, onChange: function (e) { setKwSearch(e.target.value) } }),
    )
    var addRow = React.createElement('div', { key: '__add', style: Object.assign({}, mmItem, { alignItems: 'center' }) },
      React.createElement('div', { style: { width: 130, flexShrink: 0, fontWeight: 600 } }, '新增关键词'),
      React.createElement('input', { style: Object.assign({}, mmArea, { minHeight: 24, flex: 1 }), placeholder: '标题', value: newKwV, onChange: function (e) { setNewKw(e.target.value) } }),
      React.createElement('textarea', { style: Object.assign({}, mmArea, { minHeight: 24, flex: 2, resize: 'vertical' }), placeholder: '内容（可空，稍后补充）', value: newKwContentV, onChange: function (e) { setNewKwContent(e.target.value) } }),
      React.createElement('button', { style: mmBtn, onClick: function () {
        var title = newKwV.trim()
        if (!title) { setMsg('请输入关键词标题'); return }
        setBusy(true)
        callHost('mm-keyword-add', { title: title, content: newKwContentV.trim() }).then(function (r) {
          setMsg((r && r.text) || '已新增'); setNewKw(''); setNewKwContent(''); refreshTab('kws', true)
        }).catch(function (e) { setMsg(String((e && e.message) || e)) }).finally(function () { setBusy(false) })
      } }, '+ 新增')
    )
    if (!kwsV) return React.createElement('div', { style: mmEmpty }, busyV ? '加载中…' : [renderAgentFilterRow(), archRow, searchRow, addRow])
    // 多词过滤：每个词都需命中 标题 或 内容（host 已按分数降序）
    var terms = kwSearchV.trim().split(/\s+/).filter(Boolean)
    var list = kwsV
    if (terms.length) {
      list = kwsV.filter(function (it) {
        var hay = ((it.title || '') + '\n' + (it.content || '')).toLowerCase()
        for (var i = 0; i < terms.length; i++) { if (hay.indexOf(terms[i].toLowerCase()) < 0) return false }
        return true
      })
    }
    // 时间范围过滤（关键词 + 周期总结都生效；按 updatedAt / at 判断；从/到自动取区间）
    if (kwFromV || kwToV) {
      var rg = rangeSwap(kwFromV, kwToV)
      list = list.filter(function (it) {
        var t = it.updatedAt ? new Date(it.updatedAt).getTime() : (it.at || 0)
        if (rg.from && (!t || t < rg.from)) return false
        if (rg.to && (!t || t > rg.to)) return false
        return true
      })
    }
    // 智能体排除过滤（无归属 / 排除列表空 → 显示）
    list = list.filter(function (it) { return !kwHiddenByAgent(it) })
    var rows = [renderAgentFilterRow(), archRow, searchRow, addRow].concat(list.map(function (it) {
      var isEditing = editState && editState.path === it.path
      var isOpen = !!expandedV[it.path]
      var zoneTag = it.zone === 'period' ? '（周期）' : it.zone === 'archive' ? '（归档）' : ''
      var linkTitles = []
      if (it.links) {
        var allL = (it.links.children || []).concat(it.links.parents || [])
        for (var li = 0; li < allL.length; li++) { if (allL[li] && allL[li].title && linkTitles.indexOf(allL[li].title) < 0) linkTitles.push(allL[li].title) }
      }
      var fullContent = String(it.content || '')
      var preview = fullContent.slice(0, 80)
      return React.createElement('div', { key: it.path, style: mmItem },
        React.createElement('div', { style: { width: 150, flexShrink: 0, fontWeight: 600, wordBreak: 'break-all' } },
          it.title + zoneTag,
          (typeof it.score === 'number') ? React.createElement('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)', fontWeight: 400, marginTop: 2 } }, '得分 ' + (it.score > 0 ? it.score.toFixed(1) : it.score)) : null,
          (it.agents && it.agents.length) ? React.createElement('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)', fontWeight: 400, marginTop: 2 } }, '归属 ' + it.agents.map(agentLabel).join('、')) : null,
        ),
        !isEditing
          ? React.createElement('div', { style: { flex: 1, minWidth: 200, whiteSpace: 'pre-wrap', cursor: 'pointer' }, title: isOpen ? '收起' : '展开', onClick: function () { toggleExpanded(it.path) } },
              isOpen ? mdText(fullContent) : (preview + (fullContent.length > preview.length ? ' …（点内容展开）' : '')),
              isOpen && linkTitles.length ? React.createElement('div', { key: '__links', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 4 } }, '关联（指向它/它指向）：' + linkTitles.join('；')) : null,
            )
          : autoTextArea(editState.value || '', function (e) { setEditState({ path: it.path, value: e.target.value }) }, null, null, function () {
              setBusy(true)
              callHost('mm-keyword-save', { title: it.title, content: editState.value }).then(function (r) { setMsg((r && r.text) || '已保存'); setEditState(null); refreshTab('kws', true) }).catch(function (e) { setMsg(String((e && e.message) || e)) }).finally(function () { setBusy(false) })
            }),
        React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' } },
          !isEditing
            ? React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' } },
                it.zone === 'archive'
                  ? React.createElement('button', { style: mmBtn, onClick: function () {
                      askConfirm('确认加回关键词记忆：' + it.title + '？（补充区 → 重要区）', function () {
                        setBusy(true)
                        callHost('mm-keyword-restore', { title: it.title }).then(function (r) { setMsg((r && r.text) || '已加回'); refreshTab('kws', true) }).catch(function (e) { setMsg(String((e && e.message) || e)) }).finally(function () { setBusy(false) })
                      })
                    } }, '加回')
                  : React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
                      React.createElement('button', { style: mmBtn, onClick: function () { setEditState({ path: it.path, value: it.content || '' }) } }, '修改'),
                      React.createElement('button', { style: Object.assign({}, mmBtn, { color: 'var(--dsw-alias-state-error-primary)' }), onClick: function () {
                        askConfirm('确认移补充关键词记忆：' + it.title + '？（重要区 → 补充区归档，可随时加回）', function () {
                          setBusy(true)
                          callHost('mm-keyword-del', { title: it.title }).then(function (r) { setMsg((r && r.text) || '已移补充'); refreshTab('kws', true) }).catch(function (e) { setMsg(String((e && e.message) || e)) }).finally(function () { setBusy(false) })
                        })
                      } }, '移补充'),
                    ),
              )
            : React.createElement('div', { style: { display: 'flex', gap: 4 } },
                React.createElement('button', { style: mmBtn, onClick: function () { setBusy(true); callHost('mm-keyword-save', { title: it.title, content: editState.value }).then(function (r) { setMsg((r && r.text) || '已保存'); setEditState(null); refreshTab('kws', true) }).catch(function (e) { setMsg(String((e && e.message) || e)) }).finally(function () { setBusy(false) }) } }, '保存'),
                React.createElement('button', { style: mmBtn, onClick: function () { setEditState(null) } }, '取消'),
              ),
        ),
      )
    }))
    return rows
  }
  // 活跃页（v4 三块：自定义设定 / 关键词 / 会话工作每会话一段）
  function renderActive() {
    if (!activeV) return React.createElement('div', { style: mmEmpty }, busyV ? '加载中…' : '（无活跃记忆）')
    var agentFile = activeV.agent || 'preset_cordis'
    // 编辑态：__active_custom / __active_keywords / __active_works:<sid>（按块编辑）
    var isCustomEdit = editState && editState.path === '__active_custom'
    var isKwEdit = editState && editState.path === '__active_keywords'
    var isWorksEdit = editState && editState.path && String(editState.path).indexOf('__active_works:') === 0
    var worksEditSid = isWorksEdit ? String(editState.path).slice('__active_works:'.length) : ''
    function saveActive(payload) { saveActivePayload(payload) }
    return React.createElement('div', { style: mmCard },
      // 智能体单选：默认当前会话智能体（标"当前"）；切换后只显示该智能体的活跃记忆
      React.createElement('div', { style: { fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        React.createElement('span', {}, '智能体活跃：'),
        React.createElement('select', { style: Object.assign({}, inputStyle, { width: 220 }), value: activeAgentV || '', onChange: function (e) { setActiveAgent(e.target.value); refreshTab('active', true) } },
          React.createElement('option', { value: '' }, agentLabel(curAgentV || 'preset:cordis') + '（当前）'),
          agentsV.map(function (a) { return React.createElement('option', { key: a.key, value: a.key }, (a.label || a.key) + (a.key === curAgentV ? '（当前）' : '')) }),
        ),
        React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, activeV.agent || ''),
      ),
      // ① 自定义设定
      React.createElement('div', { style: { marginBottom: 8 } },
        React.createElement('div', { style: { fontWeight: 600, fontSize: 12, marginBottom: 4 } }, '自定义设定（手动维护，对话跟踪不覆盖）'),
        isCustomEdit
          ? autoTextArea(editState.value || '', function (e) { setEditState({ path: '__active_custom', value: e.target.value }) }, null, null, function () { saveActive({ custom: editState.value }) })
          : React.createElement('div', { style: { whiteSpace: 'pre-wrap', fontSize: 12 } }, mdText(activeV.custom || '（空）')),
        React.createElement('div', { style: { display: 'flex', gap: 4, marginTop: 4 } },
          !isCustomEdit
            ? React.createElement('button', { style: mmBtn, onClick: function () { setEditState({ path: '__active_custom', value: activeV.custom || '' }) } }, '编辑')
            : React.createElement('div', { style: { display: 'flex', gap: 4 } },
                React.createElement('button', { style: mmBtn, onClick: function () { saveActive({ custom: editState.value }) } }, '保存'),
                React.createElement('button', { style: mmBtn, onClick: function () { setEditState(null) } }, '取消'),
              ),
        ),
      ),
      // ② 关键词（每个词独立 div：点击跳转 + × 移除；+ 弹窗从关键词库挑选增加；编辑保留批量输入）
      React.createElement('div', { style: { marginBottom: 8 } },
        React.createElement('div', { style: { fontWeight: 600, fontSize: 12, marginBottom: 4 } }, '关键词（' + ((activeV.keywords || []).length) + ' 个）'),
        isKwEdit
          ? React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
              React.createElement('input', { style: Object.assign({}, mmArea, { minHeight: 24, flex: 1 }), value: editState.value || '', placeholder: '逗号/顿号/空格分隔', onChange: function (e) { setEditState({ path: '__active_keywords', value: e.target.value }) } }),
              React.createElement('button', { style: mmBtn, onClick: function () {
                var words = String(editState.value || '').split(/[，,、\s]+/).map(function (s) { return s.trim() }).filter(Boolean)
                saveActive({ keywords: words })
              } }, '保存'),
              React.createElement('button', { style: mmBtn, onClick: function () { setEditState(null) } }, '取消'),
            )
          : (function () {
              // 引用检查：关键词只有对应记忆文件存在才渲染超链接；无文件词显示纯文本（避免点击 404）
              var kwList = (activeV.keywords || []).map(function (w) { return typeof w === 'string' ? { word: w, exists: false } : { word: String(w.word || ''), exists: !!w.exists } })
              return React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', fontSize: 12 } },
                kwList.length
                  ? kwList.slice(0, 40).map(function (w, wi) {
                      var kwLink = w.exists ? React.createElement('a', { href: 'javascript:void(0)', style: { color: 'var(--dsw-alias-label-primary)', textDecoration: 'underline', cursor: 'pointer' }, onClick: function (e) { e.stopPropagation(); linkClick(w.word, '记忆累积/重要/' + String(w.word).replace(/[\\/:*?"<>|]/g, '_') + '.json') } }, w.word) : React.createElement('span', {}, w.word)
                      return React.createElement('div', { key: wi, style: { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 4, background: 'var(--dsw-alias-bg-layer-1)' } },
                        kwLink,
                        React.createElement('a', { href: 'javascript:void(0)', title: '移除关键词（可随时再加回）', style: { color: 'var(--dsw-alias-label-secondary)', textDecoration: 'none', cursor: 'pointer', fontWeight: 700 }, onClick: function (e) { e.stopPropagation(); removeActiveKeyword(w.word) } }, '×'),
                      )
                    })
                  : React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, '（空）'),
                React.createElement('button', { style: mmBtn, title: '从关键词库挑选增加（时间范围/含归档/多智能体筛选）', onClick: function () { openKwAdd() } }, '+ 增加'),
              )
            })(),
      ),
      // ③ 会话工作（每会话一段）
      React.createElement('div', { style: { marginBottom: 8 } },
        React.createElement('div', { style: { fontWeight: 600, fontSize: 12, marginBottom: 4 } }, '会话工作（' + ((activeV.works || []).length) + ' 段）'),
        (activeV.works || []).length
          ? activeV.works.map(function (w, i) {
              var editing = isWorksEdit && worksEditSid === w.sid
              return React.createElement('div', { key: w.sid || i, style: Object.assign({}, mmItem, { padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)' }) },
                React.createElement('div', { style: { width: 130, flexShrink: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 11, wordBreak: 'break-all' } }, (w.sid || '（无会话）').slice(0, 22) + '\n' + ((w.updatedAt || '').slice(0, 10))),
                editing
                  ? React.createElement('div', { style: { flex: 1, minWidth: 200 } }, autoTextArea(editState.value || '', function (e) { setEditState({ path: '__active_works:' + w.sid, value: e.target.value }) }, null, null, function () {
                      saveActive({ works: (activeV.works || []).map(function (x) { return x.sid === w.sid ? Object.assign({}, x, { text: editState.value }) : x }) })
                    }))
                  : React.createElement('div', { style: { flex: 1, minWidth: 200, whiteSpace: 'pre-wrap', fontSize: 12 } }, mdText(w.text || '（空）')),
                React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
                  !editing
                    ? React.createElement('button', { style: mmBtn, onClick: function () { setEditState({ path: '__active_works:' + w.sid, value: w.text || '' }) } }, '编辑')
                    : React.createElement('div', { style: { display: 'flex', gap: 4 } },
                        React.createElement('button', { style: mmBtn, onClick: function () { saveActive({ works: (activeV.works || []).map(function (x) { return x.sid === w.sid ? Object.assign({}, x, { text: editState.value }) : x }) }) } }, '保存'),
                        React.createElement('button', { style: mmBtn, onClick: function () { setEditState(null) } }, '取消'),
                      ),
                ),
              )
            })
          : React.createElement('div', { style: mmEmpty }, '（暂无会话工作信息）'),
      ),
      // ④ 历史记录（分类过滤默认"增量更新+遗忘更新"；按设置条数分页，加载更多直到创建位置）
      React.createElement('div', { style: { marginBottom: 8 } },
        React.createElement('div', { style: { fontWeight: 600, fontSize: 12, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          '历史记录（' + ((activeV.history || []).length) + ' 条）',
          React.createElement('select', { style: Object.assign({}, inputStyle, { width: 180, fontSize: 12 }), value: histCat, onChange: function (e) { setHistCat(e.target.value); setHistPage(1) } },
            React.createElement('option', { value: 'default' }, '增量更新+遗忘更新'),
            React.createElement('option', { value: 'update' }, '仅增量更新'),
            React.createElement('option', { value: 'forget' }, '仅遗忘更新'),
            React.createElement('option', { value: 'necessary' }, '必要记忆'),
            React.createElement('option', { value: 'move' }, '移动/归档'),
            React.createElement('option', { value: 'all' }, '全部'),
          ),
        ),
        (function () {
          // 时间倒序：最新在前（history 数组本身为追加序）
          var histAll = (activeV.history || []).slice().reverse()
          var histInCat = function (h) {
            if (histCat === 'all') return true
            if (histCat === 'default') return h.op === 'update' || h.op === 'forget-update' || h.op === 'forget' || h.op === 'necessary'
            if (histCat === 'update') return h.op === 'update'
            if (histCat === 'forget') return h.op === 'forget-update' || h.op === 'forget'
            if (histCat === 'necessary') return h.op === 'necessary'
            if (histCat === 'move') return h.op === 'move'
            return true
          }
          var histFiltered = histAll.filter(histInCat)
          var histPer = Math.max(5, Number(cfgV && cfgV.historyPageSize) || 20)
          var histShown = histFiltered.slice(0, Math.max(histPer, histPage * histPer))
          var opName = function (op) { return ({ update: '增量更新', 'forget-update': '遗忘更新', forget: '遗忘', necessary: '必要记忆', move: '移动', restore: '恢复', create: '创建', query: '查询' })[op] || (op || '记录') }
          return React.createElement('div', {},
            histShown.length
              ? histShown.map(function (h, hi) {
                  return React.createElement('div', { key: hi, style: { display: 'flex', gap: 6, padding: '2px 0', borderBottom: '1px dashed var(--dsw-alias-border-l1)', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                    React.createElement('span', { style: { flexShrink: 0 } }, String(h.at || '').slice(0, 16).replace('T', ' ')),
                    React.createElement('span', { style: { flexShrink: 0, color: 'var(--dsw-alias-label-primary)' } }, opName(h.op)),
                    React.createElement('span', { style: { flex: 1, wordBreak: 'break-all' } }, String(h.note || '')),
                    React.createElement('span', { style: { flexShrink: 0 } }, String(h.agent || '').slice(-16)),
                  )
                })
              : React.createElement('div', { style: mmEmpty }, '（该分类无历史记录）'),
            histFiltered.length > histShown.length
              ? React.createElement('button', { style: mmBtn, onClick: function () { setHistPage(histPage + 1) } }, '加载更早历史（' + (histFiltered.length - histShown.length) + ' 条）')
              : null,
            histPage > 1
              ? React.createElement('button', { style: Object.assign({}, mmBtn, { marginLeft: 4 }), onClick: function () { setHistPage(1) } }, '收起')
              : null,
          )
        })(),
      ),
      React.createElement('div', { style: mmEmpty }, '最近动作：' + (activeV.lastAction || '（无）') + ' · 更新于 ' + (activeV.updatedAt || '') + (activeV.migrated ? ' · 已从旧版迁移' : '')),
      (activeV.migrateReport && activeV.migrateReport.items && activeV.migrateReport.items.length) ? React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)', whiteSpace: 'pre-wrap' } }, '迁移报告：' + activeV.migrateReport.items.join('；')) : null,
    )
  }
  // 周期页：内容可编辑 + 重审（用户选改后提示模型重总结）；按钮靠右换行
  function renderPeriods() {
    if (!periodsV) return React.createElement('div', { style: mmEmpty }, busyV ? '加载中…' : '（无周期总结）')
    return [renderAgentFilterRow()].concat(periodsV.filter(function (it) { return !periodHiddenByAgent(it) }).map(function (it) {
      var isEditing = editState && editState.path === it.path
      var btnRow = { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', width: '100%', justifyContent: 'flex-end', marginTop: 4 }
            return React.createElement('div', { key: it.path, style: mmItem },
              React.createElement('div', { style: mmItemMeta }, (it.createdAt || '').slice(0, 16).replace('T', ' ')),
              isEditing
                ? React.createElement('div', { style: { flex: 1, minWidth: 200 } },
                    // 编辑态：文本框占一行横向填满（失焦自动保存），按钮独立一行靠右（两行布局）
                    React.createElement('div', { style: { marginBottom: 8 } },
                      autoTextArea(editState.value || '', function (e) { setEditState({ path: it.path, value: e.target.value }) }, null, null, function () {
                        setBusy(true)
                        callHost('mm-period-save', { rel: it.path, content: editState.value }).then(function (r) { setMsg((r && r.text) || '已保存'); setEditState(null); refreshTab('periods', true) }).catch(function (e) { setMsg(String((e && e.message) || e)) }).finally(function () { setBusy(false) })
                      }),
                    ),
                    React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' } },
                      React.createElement('button', { style: mmBtn, onClick: function () { setBusy(true); callHost('mm-period-save', { rel: it.path, content: editState.value }).then(function (r) { setMsg((r && r.text) || '已保存'); setEditState(null); refreshTab('periods', true) }).catch(function (e) { setMsg(String((e && e.message) || e)) }).finally(function () { setBusy(false) }) } }, '保存'),
                      React.createElement('button', { style: mmBtn, onClick: function () { setEditState(null) } }, '取消'),
                    ),
                  )
                : React.createElement('div', { style: { flex: 1, minWidth: 200, whiteSpace: 'pre-wrap', cursor: 'pointer' }, onClick: function () { toggleExpanded(it.path) } },
                    (function () {
                      var fc = String(it.content || '')
                      return !!expandedV[it.path] ? mdText(fc) : (fc.slice(0, 120) + (fc.length > 120 ? ' …（点击展开）' : ''))
                    })(),
                    React.createElement('div', { style: btnRow },
                      React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', marginRight: 'auto' } }, it.scopeLabel || ('方案' + (it.scope || 1))),
                      React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' } },
                        React.createElement('button', { style: mmBtn, onClick: function () { setEditState({ path: it.path, value: it.content || '' }) } }, '修改'),
                        React.createElement('button', { style: mmBtn, onClick: function () { setUpgradeTarget(it) } }, '升级方案'),
                        React.createElement('button', { style: mmBtn, onClick: function () { setRereviewTarget(it) } }, '重新总结'),
                      ),
                    ),
                  ),
            )
    }))
  }

  // 会话记忆页：列出未归档的所有会话（标题+id）→ 点击进入该会话轮次总结
  // 时间范围默认 = 当前会话最旧记忆 → 最新；归档点击后更新时间范围到归档最旧包内最旧文件
  function renderSessions() {
    if (focusSidV) {
      // 已进入某会话：显示其轮次（复用 turns 数据，按 sid 过滤）
      var focusItems = (turnsV || []).filter(function (it) { return it.ref && it.ref.startsWith(focusSidV + '@') })
      var focusTitle = ''
      for (var fi = 0; fi < (sessionsV || []).length; fi++) { if (sessionsV[fi].sid === focusSidV) { focusTitle = sessionsV[fi].title || ''; break } }
      var head = React.createElement('div', { key: '__back', style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: '1px dashed var(--dsw-alias-border-l1)' } },
        React.createElement('button', { style: mmBtn, onClick: leaveFocus }, '← 返回会话列表'),
        React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all', flex: 1 } },
          (focusTitle ? focusTitle + ' · ' : '') + '会话 ' + focusSidV + ' · ' + focusItems.length + ' 条轮次'),
      )
      return [head].concat(focusItems.length ? focusItems.map(function (it) {
        var isEditing = editState && editState.path === it.path
        var turnNo = (it.ref.match(/@(\d+)/) || [])[1] || it.ref
        var itemTime = (it.createdAt || '').slice(0, 16).replace('T', ' ')
        var btnRow = { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', width: '100%', justifyContent: 'flex-end', marginTop: 4 }
        return React.createElement('div', { key: it.path, style: mmItem },
          React.createElement('div', { style: mmItemMeta },
            ['轮次 ' + turnNo + (it.noModel ? (it.fail ? '（模型总结失败）' : '（无模型记录）') : '') + (it.archived ? '（归档）' : '') + (itemTime ? '\n' + itemTime : '')]
            .concat(it.editHistory && it.editHistory.length ? [' · ',
              React.createElement('a', { key: 'h', href: 'javascript:void(0)', style: { textDecoration: 'underline', cursor: 'pointer' }, onClick: function () { popupPush({ title: '轮次 ' + turnNo + ' 修改历史', text: it.editHistory.map(function (h) { return (h.at || '').slice(0, 16).replace('T', ' ') + ' · ' + h.note }).join('\n') }) } }, '修改 ' + it.editHistory.length + ' 次'),
            ] : [])),
          React.createElement('div', { style: { flex: 1, minWidth: 200 } },
            !isEditing
              ? React.createElement('div', { style: { whiteSpace: 'pre-wrap' } }, mdText(it.content))
              : autoTextArea(editState.value || '', function (e) { setEditState({ path: it.path, value: e.target.value }) }, null, null, saveTurnEdit),
            React.createElement('div', { style: btnRow },
              !isEditing
                ? React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' } },
                    React.createElement('button', { style: mmBtn, onClick: function () {
                      // 查看原始会话记录（会话日志 zstd 帧全文弹窗）
                      popupPush({ title: '轮次 ' + turnNo + ' 原始记录', text: '加载中…' })
                      callHost('mm-turn-raw', { ref: it.ref }).then(function (r) {
                        setPopup(function (prev) {
                          if (!prev || !prev.length) return prev
                          return prev.slice(0, -1).concat([{ title: '轮次 ' + turnNo + ' 原始记录', text: (r && (r.content || r.text)) || '（无内容）' }])
                        })
                      }).catch(function (e) {
                        setPopup(function (prev) {
                          if (!prev || !prev.length) return prev
                          return prev.slice(0, -1).concat([{ title: '轮次 ' + turnNo + ' 原始记录', text: '读取失败：' + String((e && e.message) || e) }])
                        })
                      })
                    } }, '原文'),
                    React.createElement('button', { style: mmBtn, onClick: function () {
                      // 归档条目：点修改时时间范围联动到该归档月（含最旧包查询语义）
                      if (it.archived && it.month) { setTimeFrom(it.month + '-01'); setTimeTo(it.month + '-31') }
                      setEditState({ path: it.path, value: it.content || '' })
                    } }, '修改'),
                    React.createElement('button', { style: mmBtn, onClick: function () {
                      // 重新总结：弹窗选「当前活跃记忆总结 / 当时活跃记忆总结」后执行
                      var tno = Number((it.ref.match(/@(\d+)/) || [])[1]) || 0
                      if (!tno) { setMsg('无法解析轮次'); return }
                      setRereviewTurn({ sid: focusSidV, turn: tno })
                    } }, '重新总结'),
                  )
                  : React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
                    React.createElement('button', { style: mmBtn, onClick: saveTurnEdit }, '保存'),
                    React.createElement('button', { style: mmBtn, onClick: function () { setEditState(null) } }, '取消'),
                  ),
            ),
          ),
        )
      }) : [React.createElement('div', { key: '__empty', style: mmEmpty }, '（该会话暂无轮次总结）')])
    }
    if (!sessionsV) return React.createElement('div', { style: mmEmpty }, busyV ? '加载中…' : '（无会话记录）')
    // 会话标题搜索：按 标题 / 会话id / 摘要 过滤
    var sTerm = String(sessionSearchV || '').trim().toLowerCase()
    var sList = sessionsV.filter(function (s) { return !sessionHiddenByAgent(s) })
    if (sTerm) {
      sList = sList.filter(function (s) {
        return (String(s.title || '').toLowerCase().indexOf(sTerm) >= 0)
          || (String(s.sid || '').toLowerCase().indexOf(sTerm) >= 0)
          || (String(s.summary || '').toLowerCase().indexOf(sTerm) >= 0)
      })
    }
    return [
      renderAgentFilterRow(),
      React.createElement('div', { key: '__ssearch', style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderBottom: '1px dashed var(--dsw-alias-border-l1)', fontSize: 12 } },
        React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '搜索会话'),
        React.createElement('input', { style: Object.assign({}, mmArea, { minHeight: 24, flex: 1 }), placeholder: '按标题 / 会话id / 摘要搜索', value: sessionSearchV, onChange: function (e) { setSessionSearch(e.target.value) } }),
        React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, sList.length + ' 个'),
      ),
    ].concat(sList.map(function (s) {
      // 进入会话：按 sid 加载该会话轮次（不改时间范围；范围仅作列表过滤用）
      function enter() {
        setFocusSid(s.sid); setTurns(null)
      }
      return React.createElement('div', { key: s.sid, style: Object.assign({}, mmItem, { cursor: 'pointer' }), onClick: enter },
        React.createElement('div', { style: { width: 200, flexShrink: 0, fontWeight: 600, wordBreak: 'break-all' } },
          s.title || ('会话 ' + String(s.sid).slice(-8)),
          s.agent ? React.createElement('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)', fontWeight: 400, marginTop: 2 } }, agentLabel(s.agent) + (s.agent === curAgentV ? '（当前）' : '')) : null,
        ),
        React.createElement('div', { style: { flex: 1, minWidth: 160, color: 'var(--dsw-alias-label-secondary)', fontSize: 11 } },
          s.summary ? React.createElement('div', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 12, marginBottom: 2, wordBreak: 'break-all' } }, s.summary) : null,
          React.createElement('span', { style: { wordBreak: 'break-all' } }, s.sid + ' · ' + s.turns + ' 条轮次 · ' + (s.firstAt || '').slice(0, 10) + ' ~ ' + (s.lastAt || '').slice(0, 10)),
          React.createElement('button', { style: mmBtn, title: '复制会话 id', onClick: function (e) { e.stopPropagation(); try { navigator.clipboard.writeText(s.sid); setMsg('已复制会话 id：' + s.sid) } catch (err) { setMsg(s.sid) } } }, '复制 id'),
        ),
        React.createElement('button', { style: mmBtn, onClick: function (e) { e.stopPropagation(); enter() } }, '查看轮次'),
      )
    }))
  }

  var tabs = [
    { id: 'turns', label: '轮次总结' },
    { id: 'sessions', label: '会话记忆' },
    { id: 'active', label: '活跃记忆' },
    { id: 'kws', label: '关键词' },
    { id: 'periods', label: '周期总结' },
  ]
  var body = tabV === 'turns' ? renderTurns() : tabV === 'sessions' ? renderSessions() : tabV === 'active' ? renderActive() : tabV === 'kws' ? renderKws() : renderPeriods()
  // 时间段搜索栏（会话记忆/周期总结页显示；轮次总结页固定当前会话不带时间）
  // 常规时间范围：从 ≤ 到；联动（从≤到、到≥从）；min=页面记忆最早、max=今天；时间变化自动刷新（无"搜索/清空"按钮）
  var tbMin = ''
  if (tabV === 'sessions' && sessionsV) {
    for (var tbi = 0; tbi < sessionsV.length; tbi++) {
      var tbd = String((sessionsV[tbi] && sessionsV[tbi].firstAt) || '').slice(0, 10)
      if (tbd && (!tbMin || tbd < tbMin)) tbMin = tbd
    }
  } else if (tabV === 'periods' && periodsV) {
    for (var tbi2 = 0; tbi2 < periodsV.length; tbi2++) {
      var tbd2 = String((periodsV[tbi2] && periodsV[tbi2].createdAt) || '').slice(0, 10)
      if (tbd2 && (!tbMin || tbd2 < tbMin)) tbMin = tbd2
    }
  }
  var timeBar = (tabV === 'sessions' || tabV === 'periods') ? React.createElement('div', { key: '__time', style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderBottom: '1px dashed var(--dsw-alias-border-l1)', fontSize: 12, flexWrap: 'wrap' } },
    React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '从'),
    React.createElement('input', { type: 'date', style: inputStyle, min: tbMin || undefined, max: timeToV || todayStr(), value: timeFromV, onChange: function (e) { var v = e.target.value; setTimeFrom(v); setTurns(null); setSessions(null); setPeriods(null); refreshTab(tabV, true, { fromMs: v ? new Date(v + 'T00:00:00').getTime() : 0 }) } }),
    React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '到'),
    React.createElement('input', { type: 'date', style: inputStyle, min: timeFromV || tbMin || undefined, max: todayStr(), value: timeToV, onChange: function (e) { var v = e.target.value; setTimeTo(v); setTurns(null); setSessions(null); setPeriods(null); refreshTab(tabV, true, { toMs: v ? new Date(v + 'T23:59:59').getTime() : 0 }) } }),
    tabV === 'sessions' ? React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
      Check({ checked: searchArchV, onChange: function (e) {
        var on = e.target.checked
        setSearchArch(on); setTurns(null)
        // 含归档：时间范围限制同步扩展到归档搜索范围（清空时间限制，搜全部含归档）
        if (on) { setTimeFrom(''); setTimeTo('') }
      } }),
      React.createElement('span', {}, '含归档'),
    ) : null,
    React.createElement('button', { style: mmBtn, onClick: function () { setTimeFrom(''); setTimeTo(''); setSearchArch(false); setTurns(null); setSessions(null); setPeriods(null); refreshTab(tabV, true) } }, '全部'),
  ) : null
  var rendered
  try {
    rendered = React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' }, 'data-conversation-composer-overlay': '' },
      React.createElement('div', { style: mmTabRow },
        tabs.map(function (t) { return React.createElement('span', { key: t.id, style: mmTabStyle(t.id === tabV), onClick: function () { setTab(t.id) } }, t.label) }),
        React.createElement('button', { style: Object.assign({}, mmBtn, { marginLeft: 'auto', padding: '2px 8px' }), title: '强制重新加载当前页', onClick: function () { refreshTab(tabV, true) } }, busyV ? '处理中…' : '刷新'),
      ),
      timeBar,
      React.createElement('div', {
        // 底部留空：DSH 聊天输入框（composer seat）会覆盖 overlay 底部一截，内容区加 paddingBottom 避免信息被遮挡
        style: { flex: 1, overflowY: 'auto', paddingBottom: 90 },
        ref: scrollBoxRef,
        onScroll: function (e) { var st = e.target.scrollTop; var m = Object.assign({}, scrollPosV); m[tabV] = st; setScrollPos(m) },
      }, body),
      msgV ? React.createElement('div', { style: { padding: '4px 12px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)', borderTop: '1px solid var(--dsw-alias-border-l1)' } }, msgV) : null,
      (popupV && popupV.length) ? (function () {
        var popupTop = popupV[popupV.length - 1]
        return React.createElement('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }, onClick: function (e) { if (e.target === e.currentTarget) popupClear() } },
          React.createElement('div', { style: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, maxWidth: 560, width: '90%', maxHeight: '80vh', display: 'flex', flexDirection: 'column', padding: 16 } },
            React.createElement('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 10, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 8, display: 'flex', alignItems: 'center', gap: 8 } },
              popupV.length > 1 ? React.createElement('button', { style: mmBtn, onClick: popupPop, title: '返回上一引用' }, '← 返回') : null,
              React.createElement('span', { style: { flex: 1, wordBreak: 'break-all' } }, popupTop.title || '内容'),
            ),
            React.createElement('div', { style: { fontSize: 12, lineHeight: 1.7, overflowY: 'auto', color: 'var(--dsw-alias-label-primary)', flex: 1 } }, mdText(popupTop.text || '（无内容）')),
            React.createElement('div', { style: { marginTop: 12, display: 'flex', justifyContent: 'flex-end' } },
              React.createElement('button', { style: mmBtn, onClick: popupClear }, '关闭'),
            ),
          ),
        )
      })() : null,
      // 周期方案升级弹窗：选择新方案（1/2/3），确认后提交升级请求
      upgradeTarget ? React.createElement('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }, onClick: function (e) { if (e.target === e.currentTarget) setUpgradeTarget(null) } },
        React.createElement('div', { style: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, maxWidth: 460, width: '90%', padding: 16 } },
          React.createElement('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 10, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 8 } }, '确认升级方案'),
          React.createElement('div', { style: { fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)', marginBottom: 10 } },
            '原方案：' + (upgradeTarget.scopeLabel || ('方案' + (upgradeTarget.scope || 1))) + '（' + (upgradeTarget.createdAt || '').slice(0, 16).replace('T', ' ') + '）\n按原周期时间范围用新方案重跑，旧文件保留为只读。'),
          [1, 2, 3].map(function (s) {
            var labels = { 1: '方案1 · 仅事件记忆', 2: '方案2 · +会话首尾轮', 3: '方案3 · +全量会话轮次' }
            return React.createElement('div', { key: s, style: { marginBottom: 6 } },
              React.createElement('button', { style: Object.assign({}, mmBtn, { width: '100%', textAlign: 'left', padding: '8px 12px' }), onClick: function () {
                setBusy(true)
                callHost('mm-period-upgrade', { rel: upgradeTarget.path, scope: s }).then(function (r) {
                  setMsg((r && r.text) || '升级请求已提交'); setUpgradeTarget(null)
                }).catch(function (e) { setMsg(String((e && e.message) || e)) }).finally(function () { setBusy(false) })
              } }, labels[s] || ('方案' + s))
            )
          }),
          React.createElement('div', { style: { marginTop: 8, display: 'flex', justifyContent: 'flex-end' } },
            React.createElement('button', { style: mmBtn, onClick: function () { setUpgradeTarget(null) } }, '取消'),
          ),
        ),
      ) : null,
      // 周期重新总结（双模式重审）弹窗：选择「当前活跃」或「当时活跃」，确认后提交重审请求
      rereviewTarget ? React.createElement('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }, onClick: function (e) { if (e.target === e.currentTarget) setRereviewTarget(null) } },
        React.createElement('div', { style: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, maxWidth: 460, width: '90%', padding: 16 } },
          React.createElement('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 10, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 8 } }, '重新总结（选择模式）'),
          React.createElement('div', { style: { fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)', marginBottom: 10 } },
            '周期：' + (rereviewTarget.createdAt || '').slice(0, 16).replace('T', ' ') + '\n以哪种活跃记忆的态度重新审视？'),
          React.createElement('button', { style: Object.assign({}, mmBtn, { width: '100%', textAlign: 'left', padding: '8px 12px', marginBottom: 6 }), onClick: function () {
            setBusy(true)
            callHost('mm-period-rereview', { rel: rereviewTarget.path, mode: 'current' }).then(function (r) { setMsg((r && r.text) || '重审已提交'); setRereviewTarget(null) }).catch(function (e) { setMsg(String((e && e.message) || e)) }).finally(function () { setBusy(false) })
          } }, '当前活跃记忆总结'),
          React.createElement('button', { style: Object.assign({}, mmBtn, { width: '100%', textAlign: 'left', padding: '8px 12px' }), onClick: function () {
            setBusy(true)
            callHost('mm-period-rereview', { rel: rereviewTarget.path, mode: 'at-time' }).then(function (r) { setMsg((r && r.text) || '重审已提交'); setRereviewTarget(null) }).catch(function (e) { setMsg(String((e && e.message) || e)) }).finally(function () { setBusy(false) })
          } }, '当时活跃记忆总结'),
          React.createElement('div', { style: { marginTop: 8, display: 'flex', justifyContent: 'flex-end' } },
            React.createElement('button', { style: mmBtn, onClick: function () { setRereviewTarget(null) } }, '取消'),
          ),
        ),
      ) : null,
      // 轮次「重新总结」双模式弹窗：选「当前活跃记忆总结 / 当时活跃记忆总结」后执行
      rereviewTurn ? React.createElement('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }, onClick: function (e) { if (e.target === e.currentTarget) setRereviewTurn(null) } },
        React.createElement('div', { style: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, maxWidth: 460, width: '90%', padding: 16 } },
          React.createElement('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 10, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 8 } }, '重新总结（选择模式）'),
          React.createElement('div', { style: { fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)', marginBottom: 10 } },
            '轮次 ' + (rereviewTurn.turn || '') + '\n以哪种活跃记忆的态度重新总结？'),
          React.createElement('button', { style: Object.assign({}, mmBtn, { width: '100%', textAlign: 'left', padding: '8px 12px', marginBottom: 6 }), onClick: function () {
            var t = rereviewTurn
            setRereviewTurn(null)
            doResummarize(t.sid, t.turn, 'current')
          } }, '当前活跃记忆总结'),
          React.createElement('button', { style: Object.assign({}, mmBtn, { width: '100%', textAlign: 'left', padding: '8px 12px' }), onClick: function () {
            var t = rereviewTurn
            setRereviewTurn(null)
            doResummarize(t.sid, t.turn, 'at-time')
          } }, '当时活跃记忆总结'),
          React.createElement('div', { style: { marginTop: 8, display: 'flex', justifyContent: 'flex-end' } },
            React.createElement('button', { style: mmBtn, onClick: function () { setRereviewTurn(null) } }, '取消'),
          ),
        ),
      ) : null,
      // 页面内确认浮层（替代 window.confirm）
      confirmState ? React.createElement('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000 }, onClick: function (e) { if (e.target === e.currentTarget) setConfirmState(null) } },
        React.createElement('div', { style: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, maxWidth: 420, width: '90%', padding: 16 } },
          React.createElement('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 10, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 8 } }, '确认操作'),
          React.createElement('div', { style: { fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap', marginBottom: 12 } }, confirmState.text),
          React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            React.createElement('button', { style: mmBtn, onClick: function () { setConfirmState(null) } }, '取消'),
            React.createElement('button', { style: Object.assign({}, mmBtn, { background: 'var(--dsw-alias-state-error-primary)', color: '#fff', borderColor: 'transparent', fontWeight: 600 }), onClick: function () { var fn = confirmState.onConfirm; setConfirmState(null); if (fn) fn() } }, '确认'),
          ),
        ),
      ) : null,
      // 智能体多选弹窗（关键词页/增加弹窗共用：勾选 = 只显示这些智能体的关键词）
      agentPickOpenV ? React.createElement('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10003 }, onClick: function (e) { if (e.target === e.currentTarget) setAgentPickOpen(false) } },
        React.createElement('div', { style: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, maxWidth: 420, width: '90%', maxHeight: '80vh', display: 'flex', flexDirection: 'column', padding: 16 } },
          React.createElement('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 10, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 8 } }, '选择智能体（筛选显示）'),
          React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } }, '勾选后点「确认」，只显示这些智能体的关键词；不勾选任何 = 显示全部（当前筛选的默认勾选，可取消）。'),
          React.createElement('div', { style: { flex: 1, overflowY: 'auto', marginBottom: 12 } },
            (agentsV && agentsV.length)
              ? agentsV.map(function (a) {
                  var key = a && a.key
                  var checked = !!agentPickSelV[key]
                  return React.createElement('label', { key: key, style: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 2px', fontSize: 12, cursor: 'pointer' } },
                    Check({ checked: checked, onChange: function (e) {
                      setAgentPickSel(function (prev) {
                        var m = Object.assign({}, prev || {})
                        if (e.target.checked) m[key] = true
                        else delete m[key]
                        return m
                      })
                    } }),
                    React.createElement('span', {}, agentLabel(key) + (key === curAgentV ? '（当前）' : '')),
                  )
                })
              : React.createElement('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, '（加载智能体列表…）'),
          ),
          React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            React.createElement('button', { style: mmBtn, onClick: function () { setAgentPickOpen(false) } }, '取消'),
            React.createElement('button', { style: mmBtn, onClick: function () {
              var sel = Object.keys(agentPickSelV || {}).filter(function (k) { return agentPickSelV[k] })
              setKwFilter(sel)
              setAgentPickOpen(false)
              setMsg(sel.length ? ('已筛选 ' + sel.length + ' 个智能体的关键词') : '未筛选，显示所有智能体的关键词')
            } }, '确认'),
          ),
        ),
      ) : null,
      // 活跃页「增加关键词」弹窗：时间范围 + 含归档 + 多智能体筛选；- 未选 / + 选中置顶、滚动保持、可多选
      kwAddOpenV ? React.createElement('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10002 }, onClick: function (e) { if (e.target === e.currentTarget) setKwAddOpen(false) } },
        React.createElement('div', { style: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, maxWidth: 640, width: '92%', maxHeight: '85vh', display: 'flex', flexDirection: 'column', padding: 16 } },
          React.createElement('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 10, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 8 } }, '增加关键词（从关键词库挑选）'),
          React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6, fontSize: 12 } },
            React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
              Check({ checked: kwAddArchV, onChange: function (e) { var on = e.target.checked; setKwAddArch(on); setKwAddData(null); loadKwAddData(on, kwAddFromV, kwAddToV) } }),
              React.createElement('span', {}, '含归档（补充区）'),
            ),
            React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '从'),
            React.createElement('input', { type: 'date', style: Object.assign({}, inputStyle, { flex: 1, minWidth: 90 }), min: kwOldestV || undefined, max: kwAddToV || todayStr(), value: kwAddFromV, onChange: function (e) { var v = e.target.value; setKwAddFrom(v); setKwAddData(null); loadKwAddData(kwAddArchV, v, kwAddToV) } }),
            React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '到'),
            React.createElement('input', { type: 'date', style: Object.assign({}, inputStyle, { flex: 1, minWidth: 90 }), min: kwAddFromV || kwOldestV || undefined, max: todayStr(), value: kwAddToV, onChange: function (e) { var v = e.target.value; setKwAddTo(v); setKwAddData(null); loadKwAddData(kwAddArchV, kwAddFromV, v) } }),
            React.createElement('button', { style: mmBtn, onClick: function () { setKwAddFrom(''); setKwAddTo(''); setKwAddArch(false); setKwAddData(null); loadKwAddData(false, '', '') } }, '全部'),
          ),
          React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8, fontSize: 12 } },
            React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '筛选：'),
            (kwFilterV && kwFilterV.length)
              ? kwFilterV.map(function (a) {
                  return React.createElement('span', { key: a, style: { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 4, fontSize: 11, background: 'var(--dsw-alias-bg-layer-1)' } },
                    React.createElement('span', {}, agentLabel(a)),
                    React.createElement('a', { href: 'javascript:void(0)', title: '移除该智能体', style: { color: 'var(--dsw-alias-label-secondary)', textDecoration: 'none', cursor: 'pointer', fontWeight: 700 }, onClick: function (e) { e.stopPropagation(); setKwFilter(kwFilterV.filter(function (x) { return x !== a })) } }, '×'),
                  )
                })
              : React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '（全部）'),
            React.createElement('button', { style: mmBtn, onClick: openAgentPick }, '+'),
          ),
          React.createElement('div', { ref: kwAddListRef, style: { flex: 1, overflowY: 'auto', borderTop: '1px solid var(--dsw-alias-border-l1)', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
            !kwAddDataV
              ? React.createElement('div', { style: mmEmpty }, busyV ? '加载中…' : '（无数据）')
              : (function () {
                  var items = kwAddDataV.filter(function (it) { return !kwHiddenByAgent(it) })
                  var sorted = items.slice().sort(function (a, b) {
                    var sa = !!kwAddSelV[a.path] ? 1 : 0
                    var sb = !!kwAddSelV[b.path] ? 1 : 0
                    return sb - sa
                  })
                  if (!sorted.length) return React.createElement('div', { style: mmEmpty }, '（当前筛选下没有可增加的关键词）')
                  return sorted.map(function (it) {
                    var sel = !!kwAddSelV[it.path]
                    var isOpen = !!expandedV[it.path]
                    var zoneTag = it.zone === 'archive' ? '（归档）' : it.zone === 'period' ? '（周期）' : ''
                    var agTag = (it.agents && it.agents.length) ? it.agents.map(agentLabel).join('、') : ''
                    var fullContent = String(it.content || '')
                    var preview = fullContent.slice(0, 80)
                    return React.createElement('div', { key: it.path, style: { display: 'flex', alignItems: 'flex-start', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flexWrap: 'wrap', background: sel ? 'var(--dsw-alias-bg-layer-1)' : 'transparent' } },
                      React.createElement('button', { style: Object.assign({}, mmBtn, { flexShrink: 0, minWidth: 26, textAlign: 'center', fontWeight: 700, color: sel ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)' }), title: sel ? '取消选择' : '选择（自动置顶）', onClick: function (e) { e.stopPropagation(); toggleKwAddSel(it.path) } }, sel ? '+' : '-'),
                      React.createElement('div', { style: { flex: 1, minWidth: 200, cursor: 'pointer' }, onClick: function () { toggleExpanded(it.path) } },
                        React.createElement('div', { style: { fontWeight: 600, fontSize: 12, wordBreak: 'break-all', marginBottom: 2 } }, it.title + zoneTag + (agTag ? ' · ' + agTag : '')),
                        React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap' } }, isOpen ? mdText(fullContent) : (fullContent ? (preview + (fullContent.length > preview.length ? ' …（点内容展开）' : '')) : '（无内容）')),
                      ),
                    )
                  })
                })(),
          ),
          React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10, alignItems: 'center' } },
            React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginRight: 'auto' } }, '已选 ' + (Object.keys(kwAddSelV || {}).filter(function (k) { return kwAddSelV[k] }).length) + ' 个'),
            React.createElement('button', { style: mmBtn, onClick: function () { setKwAddOpen(false) } }, '取消'),
            React.createElement('button', { style: mmBtn, onClick: confirmKwAdd }, '确认增加'),
          ),
        ),
      ) : null,
    )
  } catch (renderErr) {
    rendered = React.createElement('div', { style: { padding: 16, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, '记忆面板渲染错误：' + String((renderErr && renderErr.message) || renderErr))
  }
  return rendered
}
    return {
      name: 'mm-settings',
      inject: ['slots'],
      apply: function (ctx) {
        var slots = ctx.get('slots')
        if (!slots) return
        slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'motion-memory', order: 300, label: '运动记忆' },
            function () { return React.createElement(Page) },
          )
        })
        // 记忆管理面板：会话视图页签（对话/轨迹/记忆 之后）
        // 透传 slot 标准 props（sessionId = 当前窗口会话 id），轮次页按当前会话过滤
        slots.inject('conversation.view', function () {
          return slots.register(
            { name: 'conversation.view', id: 'memory', order: 20, label: '记忆' },
            function (props) { return React.createElement(MemoryView, props) },
          )
        })
      },
    }
  },
})
