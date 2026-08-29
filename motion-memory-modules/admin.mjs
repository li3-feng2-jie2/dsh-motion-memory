/**
 * motion-memory 记忆管理员域模块（拆分自 motion-memory.js，C 档第五刀）
 *
 * 统一模型工作调度器（scheduleWork 队列 + 溢出落盘）+ 模型配置解析
 * （resolveModelConfig）+ LLM 调用（adminLlm/adminLlmDirect）+ 分块压缩引擎
 * （chunkCompress/summarizeChunk）+ memory_admin_view/summarize 命令。
 * 依赖经 createAdmin(core, deps) 注入：core 为共享运行时；deps 提供
 * { autoLink, withActiveParents, buildSessionRef, touchActive, activeIndexPath,
 *   hasTrackSummary, trackCfg, runTurnSummaryTask, readStepRange, stepsToText }。
 */

import { estimateTokens, batchDigest, blockBudget, chunkItemsByBudget, splitItemBySentences, mergeTailSmallChunk } from './chunker.mjs'
import { newKeywordObj, sanitizeFile, eventFileName, histEntry } from './memory-objects.mjs'
import { uid, nowIso, ymPath } from './time-utils.mjs'

export function createAdmin(core, deps) {
  const {
    state, ctx, p, root, relOf, nowIso, uid,
      readJson, writeJson, listFiles, isTombstone, tombstone, cfg, adminCfg, dshHome,
    activeDir, dailyBaseDir, importantDir, uniquePath,
  } = core
  const {
    autoLink, withActiveParents, buildSessionRef, touchActive, activeIndexPath,
    readStepRange, stepsToText,
  } = deps || {}
  // track 溢出重建函数后置注入（C 档：track 域拆出后经 setTrackFns 提供，避免工厂创建期循环依赖）
  let trackFns = null
  function setTrackFns(fns) { trackFns = fns }

  // ═════════════════════════════════════════════════════════════════════
  // 阶段0：记忆管理员 — token 估算 / prompt / LLM 调用 / 分块压缩引擎 / 查看
  // ═════════════════════════════════════════════════════════════════════

  // ── admin 配置（并入 config.json 的 admin 字段，缺省值在此）───────────

  // ── 模型配置结构体（UE 结构体继承语义）：全局 admin.model(provider/model) +
  // admin 顶层参数(contextTokens/summaryPercent/outputTokens/concurrency/extraJson)
  // 构成「默认实例」；子功能（track/enhance/period）的 model 是子实例：
  // 字段未定义 → 继承全局；已定义 → 覆盖（extraJson/concurrency 激活即整体覆盖）。
  function resolveModelConfig(sub) {
    const g = adminCfg()
    const gModel = g.model || {}
    const s = (sub && typeof sub === 'object') ? sub : {}
    const pick = (key, conv) => {
      const v = s[key] !== undefined && s[key] !== null ? s[key] : g[key]
      return (v === undefined || v === null) ? undefined : (conv ? conv(v) : v)
    }
    // extraJson 规范化：字符串 JSON → 对象（兼容历史配置存字符串）；非法/空 → undefined
    const pickExtraJson = () => {
      let v = pick('extraJson')
      if (v === undefined || v === null) return undefined
      if (typeof v === 'string') { try { v = JSON.parse(v) } catch (e) { return undefined } }
      return (v && typeof v === 'object') ? v : undefined
    }
    return {
      provider: (s.provider === '__none__') ? '' : ((s.provider !== undefined && s.provider !== '') ? String(s.provider) : (gModel.provider || '')),
      model: (s.provider === '__none__') ? '' : ((s.model !== undefined && s.model !== '') ? String(s.model) : (gModel.model || '')),
      contextTokens: pick('contextTokens', Number),
      summaryPercent: pick('summaryPercent', Number),
      outputTokens: pick('outputTokens', Number),
      concurrency: pick('concurrency', Number),
      allowThinking: pick('allowThinking') === undefined ? false : !!pick('allowThinking'),
      extraJson: pickExtraJson(),
    }
  }
  // ═════════════════════════════════════════════════════════════════════
  // 统一模型工作调度器：按工作类型独立 FIFO 排队 + 并发池。
  //   track  = 对话跟踪   period = 周期总结   enhance = 强化搜索   admin = 整理/重审/手动压缩
  // 各队列并发统一 1（任务级串行，防本地小模型排队乱序）；并行交给块级委派。
  // 队列不设硬上限：超出高水位（SUMMARY_WATERMARK，默认 50）的任务不丢弃：
  //   ① 记忆管理员已配模型 → 直接移交给管理员队列处理（不占 track 并发位）；
  //   ② 管理员没配模型 → 溢出落盘缓存 _admin/pending/<type>/，队列空闲时拾起续跑。
  // 拾起时统一回到内存队列，受并发控制；同进程等待方会收到结果，跨重启可恢复。
  // 去重/间隔检查在入队前完成（不占队）。
  // ═════════════════════════════════════════════════════════════════════
  const SUMMARY_WATERMARK = 50
  const SUMMARY_TIMEOUT_MS = 180000
  const typeStates = {}   // type -> { wait: [], workers: 0 }
  const spilledWaiters = {} // type -> [ { resolve, file } ]（同进程等待缓存任务结果的调用方）
  const drainLocks = {}   // type -> boolean（防并发扫描同一缓存目录）
  // 并发数：所有队列统一 1（任务级串行执行，防本地小模型排队乱序）；
  // 并行能力交给块级委派（工具模型 concurrency + 管理员协作接单）
  function queueConcurrencyOf(type) {
    return 1
  }
  function adminHasModel() {
    const a = adminCfg().model || {}
    return !!(a && a.provider && a.model)
  }
  function pendingDirOf(type) { return p(root(), '_admin', 'pending', type) }
  function scheduleWork(type, taskFn, label, spill) {
    const st = typeStates[type] || (typeStates[type] = { wait: [], workers: 0 })
    // 超过高水位 → 溢出（spill 提供可序列化重建参数；仅 track 等高频类型提供）
    if (spill && st.wait.length + st.workers >= SUMMARY_WATERMARK) {
      return spillTask(type, taskFn, spill, label)
    }
    return new Promise((resolve) => {
      st.wait.push({ taskFn, label, resolve })
      pumpWork(type)
    })
  }
  function pumpWork(type) {
    const st = typeStates[type]
    if (!st) return
    const concurrency = queueConcurrencyOf(type)
    while (st.wait.length && st.workers < concurrency) {
      const job = st.wait.shift()
      st.workers++
      runWorkJob(type, job).finally(() => { st.workers--; pumpWork(type) })
    }
    // 队列空闲时拾起溢出缓存任务（回到内存队列，受并发控制）
    if (!st.wait.length && st.workers < concurrency) drainSpilled(type)
  }
  async function runWorkJob(type, job) {
    try {
      const result = await Promise.race([
        job.taskFn(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('模型任务超时（' + Math.round(SUMMARY_TIMEOUT_MS / 1000) + 's）')), SUMMARY_TIMEOUT_MS)),
      ])
      job.resolve(result)
      return result
    } catch (e) {
      console.error('[motion-memory] ' + (job.label || type) + ' 任务异常: ' + (e && e.message))
      const r = { ok: false, text: '任务异常：' + ((e && e.message) || e) }
      job.resolve(r)
      return r
    }
  }
  // ── 溢出处理：优先移交给记忆管理员；无管理员模型则落盘缓存 ──
  async function spillTask(type, taskFn, spill, label) {
    try {
      const obj = Object.assign({ type, label, at: nowIso() }, spill)
      const dir = pendingDirOf(type)
      const file = p(dir, 'pending-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.json')
      // ① 记忆管理员已配模型 → 立即移交管理员队列（先落盘兜底、重建后删除缓存防重复拾起）
      if (type === 'track' && adminHasModel()) {
        await writeJson(file, obj)
        const rebuilt = await rebuildSpilledTask(type, obj)
        if (!rebuilt) { await tombstone(file, file); return { ok: false, text: '溢出任务重建失败（' + label + '）' } }
        await tombstone(file, file) // 已移交，删除缓存凭证
        return scheduleWork('admin', rebuilt, label + '（移交管理员）', null)
      }
      // ② 管理员没配模型 → 正常落盘缓存，等队列空闲拾起
      await writeJson(file, obj)
      if (!spilledWaiters[type]) spilledWaiters[type] = []
      return new Promise((resolve) => {
        spilledWaiters[type].push({ resolve, file, label })
        pumpWork(type)
      })
    } catch (e) {
      // 落盘失败（磁盘/沙箱异常）→ 退回内存排队，保证任务不丢
      console.error('[motion-memory] 溢出落盘失败（退回内存排队）：' + (e && e.message))
      return scheduleWork(type, taskFn, label, null)
    }
  }
  // 扫描 _admin/pending/<type>/：拾起缓存 → claim（删除缓存）→ 重新入队受并发控制
  async function drainSpilled(type) {
    if (drainLocks[type]) return
    drainLocks[type] = true
    try {
      const files = await listFiles(pendingDirOf(type), false)
      const st = typeStates[type] || (typeStates[type] = { wait: [], workers: 0 })
      for (const f of files) {
        if (!String(f.name).endsWith('.json')) continue
        const o = await readJson(f.path)
        if (!o || isTombstone(o) || o.type !== type) continue
        const rebuilt = await rebuildSpilledTask(type, o)
        if (!rebuilt) { await tombstone(f.path, f.path); continue } // 幂等已满足/无法重建 → 丢弃缓存
        // 匹配同进程等待方（按文件路径）
        const waiters = spilledWaiters[type] || []
        let waiter = null
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].file === f.path) { waiter = waiters.splice(i, 1)[0]; break }
        }
        await tombstone(f.path, f.path) // claim：缓存凭证移交内存队列，防重复拾起
        st.wait.push({
          taskFn: rebuilt,
          label: o.label || ('溢出任务·' + type),
          resolve: function (r) { if (waiter) { try { waiter.resolve(r) } catch (e) {} } },
        })
      }
      if (files.length) pumpWork(type)
    } catch (e) {
      console.error('[motion-memory] 溢出缓存拾起失败：' + (e && e.message))
    } finally { drainLocks[type] = false }
  }
  // 各类型溢出任务重建：返回可执行任务函数；无法重建（幂等已满足等）返回 null
  async function rebuildSpilledTask(type, o) {
    const { hasTrackSummary, trackCfg, runTurnSummaryTask } = trackFns || {}
    if (type === 'track') {
      const sid = o.sid, turn = Number(o.turn) || 0
      if (!sid || !turn) return null
      // 拾起时幂等复查：该轮已被总结则丢弃缓存
      if (await hasTrackSummary(sid, turn)) return null
      const tc = trackCfg()
      const gap = Math.max(0, Number(tc.interval) || 0)
      const meta = o.meta || { agent: 'memory-admin', session: sid, turn }
      return () => runTurnSummaryTask(sid, turn, meta, gap)
    }
    return null
  }
  // 定时安全兜底：周期检查时把遗留的溢出缓存也拾起执行（跨重启恢复）
  async function sweepSpilledQueues() {
    for (const type of ['track', 'period', 'enhance', 'admin']) {
      const st = typeStates[type]
      if (st && st.wait.length) continue
      await drainSpilled(type).catch(() => {})
    }
  }

  // ── 管理员工作上下文（v4 #3）：装在上下文最前面，占用 summaryPercent 预算 ──
  // 读 active.json（全局）+ 各智能体活跃文件摘要，供记忆管理员（周期总结等）理解全局
  async function adminContextText(capTokens) {
    try {
      const cap = Math.max(256, Number(capTokens) || 1024)
      const idx = await readJson(activeIndexPath())
      const lines = ['【记忆管理员全局上下文】']
      if (idx && (idx.recentPeriods || []).length) lines.push('最近周期：' + idx.recentPeriods.map(r => r.split('/').pop()).join('、'))
      if (idx && (idx.agents || []).length) {
        lines.push('智能体活跃：' + idx.agents.slice(0, 10).map(a => a.agent + (a.summary ? '：' + a.summary.slice(0, 60) : '')).join('；'))
      }
      if (idx && (idx.refs || []).length) {
        const kw = (idx.refs || []).filter(r => r.kind === 'keyword').slice(0, 15)
        if (kw.length) lines.push('关键词：' + kw.map(r => r.title).join('、'))
      }
      const text = lines.join('\n')
      return text.length > cap * 2 ? text.slice(0, cap * 2) : text  // 粗略按字符上限
    } catch (e) { return '' }
  }

  // v5 周期总结联动①：压缩当前活跃（各智能体记录链/works）→ 状态素材
  // 读取 当前活跃/ 下所有 v3/v4 活跃文件，取记录链每条文本前 80 字 + 指向，拼成"当前状态"段落
  async function activeRecordsContextText(ownerKey) {
    try {
      const lines = ['【当前活跃记录链】']
      const acts = []
      for (const f of await listFiles(activeDir(), false)) {
        if (f.name === 'active.json' || !f.name.endsWith('.json')) continue
        const o = await readJson(f.path)
        if (!o || isTombstone(o) || !o.agent) continue
        // 按智能体分类：只压缩目标智能体的活跃（ownerKey 空 = 全部）
        if (ownerKey && o.agent !== ownerKey) continue
        // v4=works / v3=records 统一取"每条记录文本"
        const items = Array.isArray(o.works) ? o.works : (Array.isArray(o.records) ? o.records : [])
        acts.push({ agent: o.agent, items })
      }
      if (!acts.length) return ''
      for (const a of acts) {
        const recs = a.items.slice(0, 5)
        if (!recs.length) continue
        lines.push(a.agent + '：' + recs.map(r => String(r.text || '').slice(0, 80)).join('；'))
      }
      return lines.join('\n')
    } catch (e) { return '' }
  }

  // ── token 估算（estimateTokens 已拆至 ../motion-memory-modules/chunker.mjs）──

  // ── 管理员 LLM 调用（单次文本生成，带容错降级 + 工具格式降级通道）─────
  // 读 DSH settings.yaml 里 llm-pi-ai.providers.<provider>.baseURL（正则提取，免完整 YAML 解析）
  function piAiBaseUrlOf(provider) {
    try {
      const home = dshHome()
      if (!home) return ''
      const f = p(home, 'settings.yaml')
      if (!existsSync(f)) return ''
      const text = readFileSync(f, 'utf8')
      const m = text.match(new RegExp('llm-pi-ai:[\\s\\S]*?' + provider + ':[\\s\\S]*?baseURL:\\s*([^,\\s]+)'))
      return m ? String(m[1]).replace(/['"]/g, '') : ''
    } catch (e) { return '' }
  }
  // 思考型小模型直连：LM Studio 冷启动思考默认开，pi-ai 无法发 enable_thinking:false。
  // 对 lmstudio + 非思考场景，直接用原生 fetch 调 /chat/completions。
  // extraJson 作为请求体附加字段透传给 LM Studio——高级设置 JSON 里写 {"enable_thinking": false} 即可组装进请求。
  async function adminLlmDirect(provider, model, messages, outCap, apiKey, extraJson) {
    const base = piAiBaseUrlOf(provider)
    if (!base) return null
    const wire = messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: (m.content && m.content.map ? m.content.map(c => c.text || '').join('\n') : String(m.content || '')) }))
    const body = {
      model,
      messages: wire,
      max_tokens: outCap,
      stream: false,
      enable_thinking: false,   // 默认显式关思考；extraJson 可覆盖（如 {"enable_thinking": true}）
    }
    // extraJson 透传：高级设置 JSON 的字段直接进 LM Studio 请求体
    if (extraJson && typeof extraJson === 'object') {
      try { Object.assign(body, JSON.parse(JSON.stringify(extraJson))) } catch (e) {}
    }
    const headers = { 'content-type': 'application/json' }
    if (apiKey) headers.authorization = 'Bearer ' + apiKey
    const res = await fetch(base.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error('lmstudio HTTP ' + res.status + (errText ? ': ' + errText.slice(0, 200) : ''))
    }
    const data = await res.json()
    const choice = data && data.choices && data.choices[0]
    const content = choice && choice.message && choice.message.content
    // 思考失控检测：text 空且 finish=length（思考烧满 token）→ 报错提示（不空等）
    if (!String(content || '').trim() && choice && choice.finish_reason === 'length') {
      const reasoning = (choice.message && (choice.message.reasoning_content || choice.message.reasoning)) || ''
      throw new Error('思考失控：模型只输出思考未产出答案（' + (data.usage ? data.usage.completion_tokens + ' tokens' : '') + (reasoning ? '，思考 ' + reasoning.length + ' 字' : '') + '）。请在 LM Studio 关闭该模型思考，或换非思考模型')
    }
    return String(content || '').trim()
  }
  // opts: { provider, model, contextTokens, percent, outputTokens, extraJson }
  // 返回 { ok, text, attempt }；上下文超限按 90%→80%→70% 递减重试
  // 批2：模型能力差时（输出非 JSON），追加"工具格式"指令重试——模型可输出
  //       {"tool":"memory_noop"} 表示无更新，或 {"tool":"memory_add","args":{...}}
  //       等工具调用格式，下一回应作为工具输入执行。
  async function adminLlm(promptText, opts, maxRetries) {
    const retries = Math.max(0, maxRetries === undefined ? 3 : maxRetries)
    const ctxCap = Math.max(1024, Number(opts.contextTokens) || 128000)
    const pct = Math.min(90, Math.max(5, Number(opts.percent) || 50))
    const baseBudget = Math.floor(ctxCap * pct / 100)
    // 输出上限：显式 outputTokens 优先；未配置则用剩余预算（100% − summaryPercent），但 cap 4096（小模型 max output 有限，过大报错）
    const outCap = Math.max(256, Number(opts.outputTokens) || Math.min(4096, Math.floor(ctxCap * (100 - pct) / 100)))
    const promptTokens = estimateTokens(promptText, (opts.langTokens))
    let attempt = 0
    let lastErr = ''
    // 尝试序列：目标 100% → 90% → 80% → 70% → 失败
    const ratios = [1, 0.9, 0.8, 0.7]
    const maxAttempts = Math.min(1 + retries, ratios.length)
    for (let i = 0; i < maxAttempts; i++) {
      const budget = Math.floor(baseBudget * ratios[i])
      if (promptTokens + outCap > budget) {
        attempt = i + 1
        lastErr = '上下文预算不足：输入约 ' + promptTokens + ' tokens，预算 ' + budget + '（' + (pct * ratios[i]).toFixed(0) + '%）'
        continue
      }
      try {
        // 批2：最后一次尝试追加工具格式降级指令（模型能力差时的兜底）
        let finalPrompt = promptText
        if (i === maxAttempts - 1) {
          finalPrompt = promptText + '\n\n【降级指令】如果无法按上述 JSON 格式总结，改为只输出一个工具调用：\n' +
            '- 判定无更新 → 输出 {"tool":"memory_noop"}\n' +
            '- 有记忆要写 → 输出 {"tool":"memory_add","args":{"title":"...","content":"...","reason":"..."}} 或 {"tool":"memory_event_add","args":{...}}\n' +
            '只输出这个 JSON 工具调用对象，不要任何其他文字。'
        }
        const messages = [{ id: 'mm-admin-' + uid(), role: 'user', content: [{ type: 'text', text: finalPrompt }], source: { kind: 'plugin', plugin: 'motion-memory' } }]
        let text = ''
        // 批4：extraJson 合并进模型调用参数（temperature/top_p 等自定义配置）
        const streamOpts = { provider: opts.provider, model: opts.model, messages, maxTokens: outCap }
        // 思考控制：LM Studio 冷启动思考默认开且 pi-ai 无法发 enable_thinking:false（qwen 分支只发 true；
        // thinking.type disabled 不被 LM Studio 接受；extraJson 不透传）。对 lmstudio + 非思考场景直连。
        const useDirect = opts.provider === 'lmstudio' && !opts.allowThinking
        if (opts.extraJson && typeof opts.extraJson === 'object') {
          try { Object.assign(streamOpts, JSON.parse(JSON.stringify(opts.extraJson))) } catch (e) {}
        }
        // 只收 text-delta（最终答案）。思考型模型（qwen3.5-9b）经通用通道会把思考草稿
        // 混进 text——记忆总结应换非思考模型；text 空视为失败，绝不用 reasoning 草稿当结果
        if (useDirect) {
          const direct = await adminLlmDirect(opts.provider, opts.model, messages, outCap, undefined, opts.extraJson)
          if (direct) text = direct
          else lastErr = 'lmstudio 直连失败'
        } else {
          for await (const chunk of llm.stream(streamOpts)) {
            if (chunk.type === 'text-delta') text += chunk.text
            else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') text += chunk.block.text
          }
        }
        const trimmed = text.trim()
        if (!trimmed) { lastErr = '模型输出为空'; continue }
        return { ok: true, text: trimmed, attempt: i + 1 }
      } catch (e) {
        attempt = i + 1
        lastErr = (e && e.message) || String(e)
        // 若错误明显与上下文无关（如鉴权失败），不降级直接失败
        const msg = String(lastErr)
        if (!/context|token|length|limit|max|预算/i.test(msg)) break
      }
    }
    return { ok: false, text: '', attempt, error: lastErr }
  }

  // 批2：解析"工具格式"降级输出——{tool: memory_noop | memory_add | memory_event_add | ..., args: {...}}
  // 返回 { tool, args } 或 null（非工具格式）
  function parseToolFormatOutput(text) {
    if (!text) return null
    let t = String(text).trim()
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    try {
      const o = JSON.parse(t)
      if (o && typeof o === 'object' && typeof o.tool === 'string') {
        const args = (o.args && typeof o.args === 'object') ? o.args : {}
        if (o.tool === 'memory_noop' || o.tool === 'memory_add' || o.tool === 'memory_event_add' || o.tool === 'memory_necessary' || o.tool === 'memory_update') {
          return { tool: o.tool, args }
        }
      }
    } catch (e) {}
    // 宽松匹配：文本里含 "tool":"memory_noop" 等
    const m = t.match(/"tool"\s*:\s*"(memory_\w+)"/)
    if (m) return { tool: m[1], args: {} }
    return null
  }

  // ── 管理员 prompt 模板（身份 + 价值判断 + 分块压缩指令 + JSON 输出契约）──
  function adminPrompt(refPrecision) {
    const stepNote = refPrecision === 'step'
      ? '必须准确到步：每条 sourceChain 用 会话id@轮次:stepN 或 stepN-M（如 session-abc@12:step3-5）'
      : '用 会话id@轮次（整轮指向即可，不需要细分到步）'
    return [
      '你是「记忆管理员」，负责判断对话/素材是否有长期记忆价值，并把值得的压缩成高质量、可溯源的运动记忆。',
      '输出必须严格是单个 JSON 对象，不要输出任何其他文字：',
      '{"compress": true|false, "reason": "一句话说明", "content": "压缩后的记忆正文", "op": "prepend|append|merge|replace", "lessons": [{"title": "标题", "content": "教训内容"}], "sourceChain": ["溯源引用"]}',
      '规则：',
      '1. 先判断价值：可复用的结论/用户偏好/项目约束/流程方法/踩坑教训 → compress=true；临时性、重复性、无信息量、纯寒暄 → compress=false（reason 说明理由，content 可为空）。',
      '2. compress=true 时压缩保留：结论、关键事实、流程、数字、教训；丢弃修辞和重复展开。',
      '3. content 要求 2k token 内完成，简洁为主，不要过长信息描述。',
      '4. lessons 是总结中发现的最有价值的工具使用教训或经验（踩坑/高效做法），没有则为空数组——这对用户最有用，务必认真提取。',
      '5. sourceChain 逐条记录内容来源（' + stepNote + '）。',
      '5.5 content 正文每个要点段落末尾附 [该要点的真实短标题](会话id@轮次[:stepN]) md 链接引用（不是 sourceChain 语法），保证正文可点击溯源。链接文字必须是能直接说明要点内容的短标题（3~12 字，如 [周期总结新增方案3]、[会话工作按会话分段]），界面显示的就是链接文字——禁止使用"要点短名""工作要点""新进展"等无信息量占位文字，否则读者看不出每个链接指向什么。更新"会话工作"记录链时尤其要带指向：首次 [首条工作要点](触发轮次)，增量追加 [新进展要点](触发轮次) 且保留旧指向，完成整理 [整合后的要点](触发轮次)。',
      '6. 总结要简明高效，直接给出要点，不需要过长冗余的展开。',
      '7. op 决定本轮进展如何更新当前活跃记忆的"会话工作"段落（若输入中提供了【本会话现有工作信息】则必须参考它判断）：',
      '   - 全新工作/新窗口 → "prepend"（插到最前，旧的往后顶）；',
      '   - 同一件事继续做、补充新进展 → "append"（整合：基于【本会话现有工作信息】+ 本轮新进展输出**完整整合后的新段落**，多个指向按时间顺序保留；不要无限制拼接堆叠）；',
      '   - **增量是信息整合不是累加**：同主题始终整合成一条——首轮 [xx更新a内容](轮次N)，后续 [xx更新a]、[b内容](轮次N+1)，再后续 [xx更新a]、[b]、[c内容，修复a](轮次N+2)；内容优化整合时 [xx更新且优化a、b、c](轮次N+3)，旧内容中**重要教训/关键决策的指向保留在末尾**，不重要的移除；',
      '   - 同一件事收束、需整合 → "merge"（合并旧内容与进展，保留仍有效的部分）；',
      '   - 需求变更、旧内容已过时 → "replace"（用新内容覆盖，旧版自动进 history）；',
      '   - 仅当内容未变或无需更新时省略 op。',
      '   - 无无缘无故的指向：每条记录必须带真实溯源（事件/会话@轮次[:step]/关键词）；用户手动操作豁免；',
      '   - 重要内容先落关键词记忆，当前活跃里再指向它。',
      '8. 字数限制：注入的【本会话现有工作信息】受"总结摘要字数"（k token）限制，**md 格式的引用指向超链接不计入字数**；若注入内容注明"仅注入前 Nk token"，以链接指向的原文为准。你的输出受输出上限（outputTokens）约束——这是硬上限，到达即截断；在限制内应完整表达，不要为凑字数堆叠。',
    ].join('\n')
  }

  // 解析管理员输出 JSON（容错：剥离围栏 / 前后杂文 / 重复输出 / 字符串内未转义括号）
  // 策略：1) 整段严格解析；2) 提取所有 {...} 候选（括号深度归零点）逐个尝试；
  //       3) 尝试移除重复输出后的拼接。模型可能输出两遍 JSON 或含未转义字符。
function parseAdminJson(text) {
    if (!text) return null
    let t = String(text).trim()
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    // 1) 整段尝试
    const tryParse = (s) => {
      try {
        const o = JSON.parse(s)
        if (o && typeof o === 'object') return o
      } catch (e) {}
      return null
    }
    const whole = tryParse(t)
    if (whole) return whole
    // 2) 提取所有可能的 JSON 对象
    const start = t.indexOf('{')
    if (start < 0) return null
    const candidates = []
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < t.length; i++) {
      const ch = t[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) candidates.push(t.slice(start, i + 1))
      }
    }
    // 3) 逐个尝试
    for (const cand of candidates) {
      const o = tryParse(cand)
      if (o) return o
    }
    // 4) 字段级容错提取
    const grab = (key) => {
      const re = new RegExp('"' + key + '"\\s*:\\s*"([\\s\\S]*?)"(?=,|})')
      const m = t.match(re)
      return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : undefined
    }
    const compressRaw = t.match(/"compress"\s*:\s*(true|false)/)
    const out = {}
    if (compressRaw) out.compress = compressRaw[1] === 'true'
    const reason = grab('reason')
    if (reason !== undefined) out.reason = reason
    const content = grab('content')
    if (content !== undefined) out.content = content
    const lessonsM = t.match(/"lessons"\s*:\s*(\[[\s\S]*?\])/)
    if (lessonsM) {
      try {
        const arr = JSON.parse(lessonsM[1].replace(/,\s*\]/g, ']'))
        if (Array.isArray(arr)) out.lessons = arr
      } catch (e) {}
    }
    const chainM = t.match(/"sourceChain"\s*:\s*(\[[\s\S]*?\])/)
    if (chainM) {
      try {
        const arr = JSON.parse(chainM[1].replace(/,\s*\]/g, ']'))
        if (Array.isArray(arr)) out.sourceChain = arr
      } catch (e) {}
    }
    if (compressRaw || content !== undefined || reason !== undefined) return out
    return null
  }

  // ── 批次/分块工具（batchDigest/blockBudget/chunkItemsByBudget/splitItemBySentences
  //     已拆至 ../motion-memory-modules/chunker.mjs）──────────────────────
  function adminFailDir() { return p(root(), '_admin', '_failures') }
  // 单块压缩（调用管理员模型）
  async function summarizeChunk(chunkItems, opts, meta, sourceLabel) {
    const inputText = chunkItems.map(it => '【' + (it.id || '') + '】\n' + (it.text || '')).join('\n\n')
    const refPrecision = (meta && meta.refPrecision) || ''
    const prompt = adminPrompt(refPrecision) + '\n\n来源标注：' + (sourceLabel || '') + '\n\n待压缩内容：\n' + inputText
    const res = await adminLlm(prompt, opts, 3)
    if (!res.ok) return { ok: false, error: res.error }
    const parsed = parseAdminJson(res.text)
    if (!parsed) {
      // 批2：管理员输出无法解析 → 尝试工具格式降级（memory_noop / memory_add 等）
      const toolOut = parseToolFormatOutput(res.text)
      if (toolOut && toolOut.tool === 'memory_noop') {
        // 无更新：返回 compress=false 语义，调用方判定无需总结
        return { ok: true, parsed: { compress: false, reason: 'memory_noop：判定无更新', content: '', lessons: [], sourceChain: [] }, text: res.text, attempt: res.attempt, itemIds: chunkItems.map(it => it.id), degraded: true, toolOut }
      }
      if (toolOut && toolOut.args && (toolOut.tool === 'memory_add' || toolOut.tool === 'memory_event_add' || toolOut.tool === 'memory_necessary' || toolOut.tool === 'memory_update')) {
        // 工具格式：尝试执行（降级通道）——用当前会话上下文执行该工具
        return { ok: true, parsed: { compress: true, content: '', lessons: [], sourceChain: [] }, text: res.text, attempt: res.attempt, itemIds: chunkItems.map(it => it.id), degraded: true, toolOut }
      }
      return { ok: false, error: '管理员输出无法解析为 JSON：' + res.text.slice(0, 200) }
    }
    return {
      ok: true,
      parsed,
      text: res.text,
      attempt: res.attempt,
      itemIds: chunkItems.map(it => it.id),
    }
  }
  // 中间结果落盘：_partial/{batchId}_L{layer}_{index}.json
  // ── 分块压缩引擎（通用归并管道）────────────────────────────────────────
  // 输入 items: [{id, text}]；输出最终压缩（含 sourceChain 完整溯源）
  // 流程：预算分块 → 每块独立总结(并发受 opts.concurrency) → 中间落盘
  //       → 中间结果超限再归并 → 最终单块总结 → 返回 { ok, content, chain, parts }
  // 分块压缩引擎：内存中分块总结 → 归并 → 最终单文件（不落盘 _partial 中间产物）。
  // 幂等由各调用方的事件级去重保证（对话跟踪=会话@轮次引用、周期=summarizedAt/coveredEvents）；
  // sourceChain 完整保留各块「会话+轮次:step」指向，不丢失溯源末端。
  async function chunkCompress(items, opts, meta, sourceLabel) {
    const budget = blockBudget(opts)
    let expanded = []
    for (const it of items) {
      const s = splitItemBySentences(it, budget, opts.langTokens)
      expanded.push(...s)
    }
    const chunks = chunkItemsByBudget(expanded, budget, opts.langTokens)
    if (!chunks.length) return { ok: false, error: '无内容可分块' }
    // 末尾小段自适应（阶段4）：末尾块过小单独派发信息不足 → 并入前块 / 拆半派发 / 下限保护
    mergeTailSmallChunk(chunks, budget, opts.langTokens)
    // 最终块的 parsed（lessons/op 等模型输出）随 final 透传：
    // 调用方（对话跟踪 lessons/op、周期总结）依赖 res.final.parsed，此前从未被填充。
    let lastParsed = null
    // 并发执行各块总结（concurrency: 0=串行，N>0=同时最多 N 个）
    const concurrency = Math.max(0, Number(opts.concurrency) || 0)
    const results = []
    const runOne = async (chunk, idx) => {
      const label = (sourceLabel || '') + '（块' + (idx + 1) + '/' + chunks.length + '）'
      // 失败重派：块总结失败移除标记重新派单（重试 1 次，仍失败才记失败）
      let res = await summarizeChunk(chunk, opts, meta, label)
      if (!res.ok) {
        const label2 = label + '（重试）'
        res = await summarizeChunk(chunk, opts, meta, label2)
        if (!res.ok) return res
      }
      // 批2：工具格式降级——模型输出的工具调用在这里真实执行
      if (res.degraded && res.toolOut && res.toolOut.tool && res.toolOut.tool !== 'memory_noop') {
        const toolName = res.toolOut.tool
        const tArgs = res.toolOut.args || {}
        const execMeta = { session: (meta && meta.session) || '', turn: (meta && meta.turn) || 0, agent: (meta && meta.agent) || 'memory-admin' }
        try {
          if (toolName === 'memory_add') {
            const obj = newKeywordObj(String(tArgs.title || '降级记忆'), String(tArgs.content || chunk.map(it => it.text).join('\n').slice(0, 2000)), String(tArgs.reason || '模型降级工具调用'), execMeta, null)
            const p2 = await uniquePath(importantDir(), sanitizeFile(obj.title) + '.json')
            await writeJson(p2, obj)
            await autoLink(obj, execMeta)
            await touchActive(execMeta, relOf(p2), 'memory_add_degraded')
            return { ok: true, parsed: { compress: true, reason: '降级 memory_add 已执行', content: obj.content.slice(0, 200), lessons: [], sourceChain: chunk.map(it => it.id) }, sourceChain: chunk.map(it => it.id), content: obj.content.slice(0, 200), itemIds: chunk.map(it => it.id), degraded: true }
          }
          if (toolName === 'memory_event_add' || toolName === 'memory_necessary') {
            const isEvent = toolName === 'memory_event_add'
            const d = new Date()
            const dir = ymPath(d)
            const existing = await listFiles(p(dailyBaseDir(), dir), false)
            const seq = existing.length + 1
            const path = await uniquePath(p(dailyBaseDir(), dir), eventFileName(execMeta, d, seq))
            const me = { agent: execMeta.agent, session: execMeta.session, turn: execMeta.turn }
            const obj = {
              schemaVersion: 1, id: uid(), kind: 'event', location: 'daily', readonly: true,
              title: String(tArgs.title || '降级事件'), reason: String(tArgs.reason || '模型降级工具调用'),
              content: String(tArgs.content || chunk.map(it => it.text).join('\n').slice(0, 2000)),
              links: withActiveParents({ parents: [], children: [{ kind: 'turn', ref: (execMeta.session || '') + '@' + (execMeta.turn || 0), location: 'session' }] }, execMeta),
              sessionRef: buildSessionRef(execMeta.session, execMeta.turn),
              createdAt: nowIso(), updatedAt: nowIso(), lastAccessedAt: nowIso(),
              createdBy: me, lastModifiedBy: me, originalId: null,
              history: [histEntry('create', { ...execMeta, note: '模型降级工具调用' })],
            }
            await writeJson(path, obj)
            await autoLink(obj, execMeta)
            await touchActive(execMeta, relOf(path), 'memory_' + (isEvent ? 'event_add' : 'necessary') + '_degraded')
            return { ok: true, parsed: { compress: true, reason: '降级 ' + toolName + ' 已执行', content: obj.content.slice(0, 200), lessons: [], sourceChain: chunk.map(it => it.id) }, sourceChain: chunk.map(it => it.id), content: obj.content.slice(0, 200), itemIds: chunk.map(it => it.id), degraded: true }
          }
        } catch (e) {
          console.error('[motion-memory] 降级工具执行失败: ' + (e && e.message))
          return { ok: false, error: '降级工具 ' + toolName + ' 执行失败：' + (e && e.message) }
        }
      }
      const chain = res.parsed.sourceChain && res.parsed.sourceChain.length ? res.parsed.sourceChain : res.itemIds
      const content = res.parsed.compress === false ? '' : (res.parsed.content || res.text)
      return { ok: true, parsed: res.parsed, sourceChain: chain, content, itemIds: res.itemIds, model: (opts && (opts.provider + '/' + opts.model)) || 'main' }
    }
    // 块级委派（阶段3）：工具模型主池 worker 全忙 + 仍有剩余块 + 管理员有模型 + 开关允许 → 启动管理员委派池。
    // 委派块用管理员模型（同一 adminPrompt 契约，仅模型实例不同），块预算取 min(工具, 管理员) 保证两模型都能处理。
    // 开关在工具模型高级设置（track/enhance/period 各自 delegateBlocks），默认关（仅工具模型，不外派）。
    const delegateOn = !!(meta && meta.delegateBlocks) && adminHasModel()
    let adminOpts = null
    let adminConcurrency = 0
    if (delegateOn) {
      const admC = adminCfg()
      adminOpts = {
        provider: admC.model && admC.model.provider,
        model: admC.model && admC.model.model,
        contextTokens: admC.contextTokens,
        percent: admC.summaryPercent,
        outputTokens: admC.outputTokens,
        concurrency: Math.max(1, Number(admC.concurrency) || 1),
        langTokens: admC.langTokens,
        extraJson: admC.extraJson,
      }
      if (adminOpts.provider && adminOpts.model) {
        // 工具模型 == 管理员模型时委派无意义（同一个模型），直接不委派
        const toolKey = String((opts && (opts.provider + '/' + opts.model)) || '')
        const adminKey = String((adminOpts.provider + '/' + adminOpts.model) || '')
        if (toolKey === adminKey) { adminOpts = null; adminConcurrency = 0 }
        else adminConcurrency = Math.max(1, Number(adminOpts.concurrency) || 1)
      } else {
        adminOpts = null
        adminConcurrency = 0
      }
    }
    if (concurrency <= 0 && adminConcurrency <= 0) {
      for (let i = 0; i < chunks.length; i++) results.push(await runOne(chunks[i], i))
    } else {
      let next = 0
      const workers = []
      // 主池（工具模型，concurrency 个）
      const mainWorkers = Math.max(0, concurrency)
      for (let w = 0; w < mainWorkers; w++) {
        workers.push((async () => {
          while (next < chunks.length) {
            const i = next++
            results[i] = await runOne(chunks[i], i)
          }
        })())
      }
      // 委派池（管理员模型）：仅在主池 worker 全忙（mainWorkers>0 且已有等待）或主池为 0 时生效。
      // 实现：主池 worker 数量固定；委派池与主池共享 next 计数器（工作窃取），块按各自模型预算领走。
      if (adminConcurrency > 0 && (concurrency > 0 || chunks.length > 0)) {
        // 只有开启委派且工具并发不足（块数 > 主池并发）才真正启动委派池，避免正常场景外派
        if (chunks.length > Math.max(1, mainWorkers)) {
          for (let w = 0; w < adminConcurrency; w++) {
            workers.push((async () => {
              while (next < chunks.length) {
                const i = next++
                // 委派池领块：若该块超管理员预算，交给主池（next 已抢占则重试——简单起见直接跳过超大块）
                const chunk = chunks[i]
                const chunkTokens = chunk.reduce((n, it) => n + estimateTokens(it.text || '', opts.langTokens), 0)
                const adminBudget = adminOpts ? blockBudget(adminOpts) : 0
                if (chunkTokens > adminBudget) { results[i] = await runOne(chunk, i); continue }
                const label = (sourceLabel || '') + '（块' + (i + 1) + '/' + chunks.length + '·管理员委派）'
                const res = await summarizeChunk(chunk, adminOpts, meta, label)
                if (!res.ok) { results[i] = res; continue }
                const chain2 = res.parsed.sourceChain && res.parsed.sourceChain.length ? res.parsed.sourceChain : res.itemIds
                const content2 = res.parsed.compress === false ? '' : (res.parsed.content || res.text)
                results[i] = { ok: true, parsed: res.parsed, sourceChain: chain2, content: content2, itemIds: res.itemIds, model: (adminOpts && (adminOpts.provider + '/' + adminOpts.model)) || 'admin' }
              }
            })())
          }
        }
      }
      await Promise.all(workers)
    }
    // 各块结果检查
    const failed = results.filter(r => !r.ok)
    if (failed.length) return { ok: false, error: '块总结失败：' + failed.map(f => f.error).join('；') }
    // 单块（无需归并）时直接以该块 parsed 作为最终 parsed
    if (results.length === 1 && results[0].parsed) lastParsed = results[0].parsed
    // 中间结果拼接 → 归并层：每层总结输出尽量到达目标（默认 2k，受输出上限约束），
    // 聚合后仍超目标 → 再拆再派（层数由内容量自然收敛：每层压缩约 5:1，50k→10k→2k 两层即可）
    let mids = results.map((r, i) => ({ id: 'm' + (i + 1), text: r.parsed.compress === false ? '' : (r.content || '') }))
    mids = mids.filter(m => m.text)
    let chain = []
    for (const r of results) {
      if (r.sourceChain && r.sourceChain.length) chain.push(...r.sourceChain)
    }
    if (!mids.length) {
      return { ok: true, content: '', chain, final: { content: '', sourceChain: chain, compress: false, parsed: lastParsed }, allSkipped: true }
    }
    // 总结压缩目标：每层输出尽量到达 2k（目标 token），上限受输出限制（outCap）兜底
    const outCapTok = Math.max(1024, Number(opts.outputTokens) || Number(adminCfg().outputTokens) || 2048)
    const targetTokens = Math.min(2048, outCapTok)  // 目标 2k；输出上限小于 2k 时以上限为准
    let layer = 1
    const maxLayer = 12  // 安全上限（正常 3-4 层收敛；仅防极端情况死循环）
    while (layer < maxLayer) {
      const single = mids.length === 1
      const curTokens = estimateTokens(mids[0].text, opts.langTokens)
      // 已满足目标：单块且 ≤ 目标 token → 收敛停止
      if (single && curTokens <= targetTokens) break
      // 拆不动：单块但已 ≤ 预算（无法再拆）→ 若仍超目标则本层直接压缩该块一次
      if (single) {
        layer++
        const label = (sourceLabel || '') + '（归并层' + layer + ' 单块压缩）'
        const res = await summarizeChunk(mids, opts, meta, label)
        if (!res.ok) return res
        lastParsed = res.parsed
        const c = res.parsed.compress === false ? '' : (res.parsed.content || res.text)
        const ch = res.parsed.sourceChain && res.parsed.sourceChain.length ? res.parsed.sourceChain : res.itemIds
        mids = c ? [{ id: 'm1', text: c }] : []
        if (ch && ch.length) chain = ch
        if (!mids.length) break
        continue
      }
      // 多块：本层聚合压缩（每块输出尽量到达 2k，超目标则拆组继续）
      const groups = chunkItemsByBudget(mids, budget, opts.langTokens)
      layer++
      const groupResults = []
      for (let g = 0; g < groups.length; g++) {
        const label = (sourceLabel || '') + '（归并层' + layer + ' 组' + (g + 1) + '）'
        const res = await summarizeChunk(groups[g], opts, meta, label)
        if (!res.ok) return res
        lastParsed = res.parsed
        const c = res.parsed.compress === false ? '' : (res.parsed.content || res.text)
        const ch = res.parsed.sourceChain && res.parsed.sourceChain.length ? res.parsed.sourceChain : res.itemIds
        groupResults.push({ ok: true, parsed: res.parsed, sourceChain: ch, content: c, itemIds: res.itemIds })
      }
      const gf = groupResults.filter(r => !r.ok)
      if (gf.length) return { ok: false, error: '归并层' + layer + '失败：' + gf.map(f => f.error).join('；') }
      mids = groupResults.map((r, i) => ({ id: 'm' + (i + 1), text: r.parsed.compress === false ? '' : (r.content || '') })).filter(m => m.text)
      chain = []
      for (const r of groupResults) if (r.sourceChain && r.sourceChain.length) chain.push(...r.sourceChain)
    }
    const finalContent = mids.length ? mids[0].text : ''
    return { ok: true, content: finalContent, chain, final: { content: finalContent, sourceChain: chain, layer, parsed: lastParsed } }
  }
  // ── 15. memory_admin_view（只读查看：失败记录；_partial 中间产物已移除）───
  async function memCmdAdminView(args, meta) {
    const lines = ['【记忆管理员·只读查看】']
    if (args.batchId) {
      lines.push('（_partial 中间产物已移除：不再保留批次中间文件；压缩幂等由对话跟踪「会话@轮次引用」与周期「summarizedAt/coveredEvents」保证）')
    } else {
      const failFiles = await listFiles(adminFailDir(), false)
      if (!failFiles.length) lines.push('（无失败记录）')
      else {
        lines.push('失败记录：' + failFiles.length + ' 条')
        for (const f of failFiles) {
          const o = await readJson(f.path)
          if (o) lines.push('  ' + f.name + '：' + (o.error || '') + '（' + (o.at || '') + '）')
        }
      }
    }
    return { ok: true, text: lines.join('\n'), data: { count: lines.length } }
  }
  // ── 16. memory_admin_summarize（手动触发：素材/事件/轮次压缩入口）──────
  async function memCmdAdminSummarize(args, meta) {
    const sid = String(args.sessionId || meta.session || '')
    let items = args.items
    if (!items || !items.length) {
      if (args.turn === undefined) return { ok: false, text: '需要 items 或 turn（+sessionId）' }
      const turn = Number(args.turn)
      const steps = await readStepRange(sid, turn, args.stepFrom, args.stepTo)
      if (!steps.length) return { ok: false, text: '轮次 ' + turn + ' 的步骤段无内容（会话 ' + sid + '）' }
      items = steps.map(s => ({ id: sid + '@' + turn + ':step' + s.step, text: stepsToText([s], true) }))
    }
    if (!items || !items.length) return { ok: false, text: '无内容可压缩' }
    const opts = {
      provider: adminCfg().model && adminCfg().model.provider,
      model: adminCfg().model && adminCfg().model.model,
      contextTokens: adminCfg().contextTokens,
      percent: adminCfg().summaryPercent,
      outputTokens: adminCfg().outputTokens,
      concurrency: adminCfg().concurrency,
      langTokens: adminCfg().langTokens,
      extraJson: adminCfg().extraJson,
    }
    if (!opts.provider || !opts.model) return { ok: false, text: '未配置管理员模型（memory_config 设置 admin.model）' }
    const label = '会话 ' + sid + ' 轮次 ' + (args.turn !== undefined ? args.turn : '手动素材')
    const res = await scheduleWork('admin', () => chunkCompress(items, opts, meta, label), '管理员压缩 ' + label)
    if (!res.ok) return { ok: false, text: '压缩失败：' + res.error + '（可 memory_admin_view 查看，配置后重跑自动续传）' }
    return {
      ok: true,
      text: '压缩完成' + (res.cached ? '（命中缓存）' : '') + (res.allSkipped ? '（全部判定无需压缩）' : '') + '：\n' + (res.content || '（空）') + '\n\n溯源：' + (res.chain.length ? res.chain.join(' → ') : '（无）'),
      data: { batchId: batchDigest(items), content: res.content, chain: res.chain, cached: !!res.cached },
    }
  }

  return {
    adminCfg, resolveModelConfig, adminHasModel, scheduleWork, sweepSpilledQueues,
    adminContextText, activeRecordsContextText, adminLlm, parseAdminJson,
    summarizeChunk, chunkCompress, memCmdAdminView, memCmdAdminSummarize,
    setTrackFns,
  }
}