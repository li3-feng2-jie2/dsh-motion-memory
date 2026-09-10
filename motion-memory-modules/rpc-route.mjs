/**
 * 在 webServer 上注册一个「connection 兼容」的 RPC channel。
 *
 * 背景（DSH 0.1.5-rc.1）：`ctx.get('connection').rpc.handle(channel, handler)` 内部会执行
 *   owner.effect(() => owner.webServer.register(route))
 * 其中 owner 是 connection 服务经 Cordis 上下文追踪得到的「访问者上下文」，它解析不到
 * 插件自身声明的 webServer 注入，于是抛
 *   cannot get property "webServer" without inject
 * 实测：直接调用、把 webServer 加进 `export const inject`、用 ctx.inject([...]) 包裹，
 * 三种写法都会抛（ctx.inject 只保证回调执行，回调里再调 handle 依旧抛）。
 *
 * 因此改为插件自己注册路由，并逐字复刻 connection 的线上协议：
 *   POST <channel>/<endpoint>，content-type: application/json
 *   请求体 { type:'client-request', rpcId, method, payload }
 *   响应体 { type:'server-response', rpcId, result }
 * 同时复用 DSH 的信任栅栏 `connection.requestRejection(req)`（Host 白名单 + 浏览器认证），
 * 保持与走 connection channel 时同样的 401/403 行为。
 *
 * @param ctx     插件上下文（需已 inject 'connection'；webServer 用 ctx.get 取，拿不到则跳过）
 * @param channel channel 前缀，如 '/mmsettings'（不要带结尾斜杠）
 * @param handler async (endpoint, payload) => result
 * @returns 是否注册成功
 */
export function registerRpcChannel(ctx, channel, handler) {
  let webServer
  try { webServer = ctx.get('webServer') } catch (e) { webServer = undefined }
  if (!webServer || typeof webServer.register !== 'function') return false
  let connection
  try { connection = ctx.get('connection') } catch (e) { connection = undefined }

  const sendJson = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(text)
  }
  const readBody = async req => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
  }

  const route = {
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      // 与 connection channel 同一道栅栏：Host 白名单（403）+ 浏览器认证（401）
      if (connection && typeof connection.requestRejection === 'function') {
        let rejection
        try { rejection = connection.requestRejection(req) } catch (e) { rejection = undefined }
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
      }
      const pathname = new URL(req.url || '/', 'http://x').pathname
      const endpoint = pathname.startsWith(channel + '/') ? pathname.slice(channel.length + 1) : undefined
      if (req.method !== 'POST' || endpoint === undefined || endpoint === '') {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        res.writeHead(415)
        res.end('content type must be application/json')
        return
      }
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) {
        res.writeHead(400)
        res.end('body is not JSON')
        return
      }
      const rpcId = body && typeof body.rpcId === 'string' ? body.rpcId : 'invalid-request'
      if (!body || body.type !== 'client-request' || typeof body.rpcId !== 'string' || typeof body.method !== 'string') {
        sendJson(res, 200, { type: 'server-response', rpcId, result: { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } } } })
        return
      }
      if (body.method !== endpoint) {
        sendJson(res, 200, { type: 'server-response', rpcId, result: { ok: false, error: { code: 'gateway/bad-request', message: 'method ' + JSON.stringify(body.method) + ' does not match endpoint ' + JSON.stringify(endpoint), details: { issues: [] } } } })
        return
      }
      try {
        const result = await handler(endpoint, body.payload, req)
        sendJson(res, 200, { type: 'server-response', rpcId, result })
      } catch (error) {
        res.writeHead(500)
        res.end('handler failure: ' + String(error))
      }
    },
  }

  ctx.effect(() => webServer.register(route), 'motion-memory: ' + channel + ' rpc channel')
  return true
}
