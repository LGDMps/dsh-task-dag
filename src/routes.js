/**
 * HTTP + SSE surface of the `dsh-task-dag` plugin.
 *
 * The browser half is a same-origin panel served by the DSH web server, so this
 * module is the only way the panel reads or mutates the graph. Every route is
 * registered as an exact `node:http` handler; every failure is rendered as
 * `{ok:false, code, message}` so the client has one error shape to handle.
 *
 * Security model: the routes are reachable from any local process, therefore
 * each request must prove it comes from a browser page served by this host —
 * loopback socket + loopback Host header + a browser same-origin signal.
 * This is a tripwire, not authentication: a local process can forge the
 * signal. It exists to stop drive-by web pages and blind `curl` usage.
 */
import { CODES, TaskDagError, isTaskDagError } from './errors.js'
import { getWorkspace, listWorkspaces } from './workspaces.js'
import { derive } from './model.js'
import { applyAction } from './ops.js'
// Namespace import: the catalog helpers are optional in a host without a session
// gateway, so a missing export must degrade to an empty catalog, never a 500.
import * as sessionApi from './sessions.js'

/** Every route lives under this prefix. */
export const API_PREFIX = '/api/task-dag'

/** Largest accepted POST /action body. */
export const MAX_ACTION_BODY_BYTES = 256 * 1024

/** SSE keep-alive cadence. */
export const SSE_HEARTBEAT_MS = 15_000

/** How long `GET /catalog` reuses one Agent-preset/model listing. */
export const CATALOG_CACHE_MS = 30_000

/** Identity reported by the liveness probe. */
export const PLUGIN_NAME = 'dsh-task-dag'

const JSON_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
})

const SSE_HEADERS = Object.freeze({
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
})

const EMPTY_PROGRESS = Object.freeze({
  done: 0,
  total: 0,
  ready: 0,
  blocked: 0,
  doing: 0,
  failed: 0,
  planned: 0,
})

// ---------------------------------------------------------------------------
// small request/response helpers
// ---------------------------------------------------------------------------

function headerValue(value) {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : ''
  return value === undefined || value === null ? '' : String(value)
}

function requestUrl(req) {
  try {
    return new URL(typeof req?.url === 'string' ? req.url : '/', 'http://localhost')
  } catch {
    return new URL('/', 'http://localhost')
  }
}

function methodOf(req) {
  return String(req?.method ?? 'GET').toUpperCase()
}

function writeJson(res, status, payload, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded) return
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    ...JSON_HEADERS,
    ...extraHeaders,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function writeMethodNotAllowed(res, allow) {
  writeJson(res, 405, {
    ok: false,
    code: CODES.methodNotAllowed,
    message: `只支持 ${allow} 请求。`,
  }, { allow })
}

function requireMethod(req, res, method) {
  if (methodOf(req) === method) return true
  writeMethodNotAllowed(res, method)
  return false
}

function writeForbidden(res, reason) {
  writeJson(res, 403, {
    ok: false,
    code: CODES.forbidden,
    message: reason === undefined
      ? '请求来源不受信任。'
      : `请求来源不受信任：${reason}。`,
  })
}

function mapFailure(error) {
  if (isTaskDagError(error)) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
      ? error.status
      : 400
    const code = typeof error.code === 'string' && error.code !== '' ? error.code : CODES.invalidRequest
    const message = typeof error.message === 'string' && error.message !== '' ? error.message : '请求失败。'
    return { status, code, message }
  }

  // An unexpected error still has to reach the person who clicked: the route is
  // loopback-guarded, so its own message is safe to surface and turns a dead-end
  // "internal error" into something diagnosable from the panel.
  const detail = error instanceof Error && typeof error.message === 'string' && error.message !== ''
    ? `${error.name}: ${error.message}`
    : String(error)
  return { status: 500, code: 'internal', message: `服务器内部错误：${detail}` }
}

function writeFailure(res, error) {
  const mapped = mapFailure(error)
  if (mapped.status >= 500) {
    console.error('[dsh-task-dag] 请求处理失败', error)
  }

  if (res.headersSent) {
    try {
      res.end()
    } catch {
      // The socket already went away; nothing left to report.
    }
    return
  }

  writeJson(res, mapped.status, { ok: false, code: mapped.code, message: mapped.message })
}

// ---------------------------------------------------------------------------
// same-origin guard
// ---------------------------------------------------------------------------

function isLoopbackAddress(address) {
  // A unix-domain socket has no remote address; it can only be reached locally.
  if (typeof address !== 'string' || address === '') return true
  const normalized = address.toLowerCase()
  return normalized === '::1'
    || normalized === '127.0.0.1'
    || normalized.startsWith('127.')
    || normalized.startsWith('::ffff:127.')
}

function parseHostHeader(value) {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const url = new URL(`http://${value}`)
    if (url.username !== '' || url.password !== '') return undefined
    return url
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false
  const name = hostname.toLowerCase()
  return name === 'localhost'
    || name === '127.0.0.1'
    || name === '::1'
    || name === '[::1]'
    || name.startsWith('127.')
}

/** `host:port` with the protocol default port made explicit. */
function endpointOf(url, protocol) {
  const port = url.port !== '' ? url.port : (protocol === 'https:' ? '443' : '80')
  return `${url.hostname.toLowerCase()}:${port}`
}

/**
 * Header the plugin's own browser half sets on every request. A cross-origin
 * page cannot set a custom header without a CORS preflight, and this plugin
 * never grants one, so its presence is a positive same-origin signal.
 */
const CLIENT_HEADER = 'x-dsh-task-dag-client'

/**
 * Decide whether a request may touch the graph, and explain the verdict.
 *
 * The real boundary is that the request arrived on a loopback socket addressed
 * by a loopback `Host`. Browser metadata is a tripwire, not the boundary:
 * browsers attach `Origin` (or `Sec-Fetch-Site: cross-site`) to a genuinely
 * cross-site request, so an *explicit contradiction* is rejected while
 * **missing** metadata is accepted. That distinction matters in practice: the
 * official desktop shell re-issues the page's requests through its own WebView
 * plumbing, which drops `Sec-Fetch-*` and `Origin`; treating "no metadata" as
 * hostile locks the plugin out of its own UI without ever stopping a real
 * cross-site caller. Writes stay protected regardless, because the action route
 * requires `content-type: application/json`, which a plain cross-site form post
 * cannot produce without the preflight this plugin refuses.
 *
 * @param {object} req node:http request
 * @returns {{ok: boolean, reason: string}}
 */
export function inspectBrowserRequest(req) {
  const address = req?.socket?.remoteAddress
  if (!isLoopbackAddress(address)) {
    return { ok: false, reason: `连接不是本机（${String(address ?? '未知')}）` }
  }

  const host = parseHostHeader(headerValue(req?.headers?.host))
  if (host === undefined) return { ok: false, reason: '缺少有效的 Host 头' }
  if (!isLoopbackHostname(host.hostname)) {
    return { ok: false, reason: `Host 不是本机地址（${host.hostname}）` }
  }
  const expected = endpointOf(host, 'http:')

  if (headerValue(req?.headers?.[CLIENT_HEADER]) !== '') {
    return { ok: true, reason: '插件自身请求头' }
  }

  const site = headerValue(req?.headers?.['sec-fetch-site']).toLowerCase()
  if (site === 'cross-site') {
    return { ok: false, reason: 'Sec-Fetch-Site: cross-site' }
  }

  const origin = headerValue(req?.headers?.origin)
  if (origin !== '' && origin !== 'null') {
    let originUrl
    try {
      originUrl = new URL(origin)
    } catch {
      return { ok: false, reason: `Origin 无法解析（${origin}）` }
    }
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
      return { ok: false, reason: `Origin 协议不支持（${originUrl.protocol}）` }
    }
    if (endpointOf(originUrl, originUrl.protocol) !== expected) {
      return { ok: false, reason: `Origin 与 Host 不一致（${origin}）` }
    }
  }

  return { ok: true, reason: site === '' ? '无浏览器元数据，按本机请求处理' : site }
}

/**
 * True when the request may touch the graph. Exported so the unit tests can pin
 * the individual signal rules.
 */
export function isTrustedBrowserRequest(req) {
  return inspectBrowserRequest(req).ok
}

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------

function revisionOf(graph) {
  return Number.isInteger(graph?.revision) && graph.revision >= 0 ? graph.revision : 0
}

function progressStatusCount(nodes, status) {
  return nodes.filter((node) => node?.status === status).length
}

function fallbackProgress(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  return {
    done: progressStatusCount(nodes, 'done'),
    total: nodes.length,
    ready: 0,
    blocked: 0,
    doing: progressStatusCount(nodes, 'doing'),
    failed: progressStatusCount(nodes, 'failed'),
    planned: progressStatusCount(nodes, 'planned'),
  }
}

function normalizeProgress(progress, graph) {
  const fallback = fallbackProgress(graph)
  if (progress === null || typeof progress !== 'object' || Array.isArray(progress)) return fallback
  return {
    done: Number.isInteger(progress.done) ? progress.done : fallback.done,
    total: Number.isInteger(progress.total) ? progress.total : fallback.total,
    ready: Number.isInteger(progress.ready) ? progress.ready : fallback.ready,
    blocked: Number.isInteger(progress.blocked) ? progress.blocked : fallback.blocked,
    doing: Number.isInteger(progress.doing) ? progress.doing : fallback.doing,
    failed: Number.isInteger(progress.failed) ? progress.failed : fallback.failed,
    planned: Number.isInteger(progress.planned) ? progress.planned : fallback.planned,
  }
}

function collectSessionIds(graph) {
  const seen = new Set()
  const ids = []
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    for (const session of Array.isArray(node?.sessions) ? node.sessions : []) {
      const id = typeof session?.sessionId === 'string' ? session.sessionId : ''
      if (id !== '' && !seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
  }
  return ids
}

function safeDerive(graph, notes) {
  try {
    const derived = derive(graph)
    if (derived !== null && typeof derived === 'object') {
      return { ...derived, progress: normalizeProgress(derived.progress, graph) }
    }
    notes.push('无法计算任务排序，已按空图处理。')
  } catch (error) {
    console.error('[dsh-task-dag] derive 失败', error)
    notes.push('无法计算任务排序，已按空图处理。')
  }
  return {
    ready: [],
    blocked: [],
    doing: [],
    done: [],
    failed: [],
    planned: [],
    levels: {},
    order: [],
    conditions: {},
    milestone: null,
    progress: fallbackProgress(graph),
  }
}

/**
 * Build the full state the panel renders: the stored graph, its derived task
 * order, the live facts for every attached session, and non-fatal notes.
 *
 * @param {object} ctx host context
 * @param {{read: Function}} store graph store
 * @param {{workspaceId: string, path: string, title: string}} workspace
 */
export async function snapshotFor(ctx, store, workspace) {
  const read = store.read(workspace)
  const graph = read?.graph
  const notes = []

  for (const warning of Array.isArray(read?.warnings) ? read.warnings : []) {
    if (typeof warning === 'string' && warning !== '') notes.push(warning)
  }
  if (read?.missing) notes.push('还没有任务图谱文件，已按空图处理。')

  const derived = safeDerive(graph, notes)

  let sessions = { byId: {}, archived: [], warnings: [] }
  try {
    const facts = await sessionApi.sessionFacts(ctx, collectSessionIds(graph))
    if (facts !== null && typeof facts === 'object') {
      sessions = {
        byId: facts.byId !== null && typeof facts.byId === 'object' ? facts.byId : {},
        archived: Array.isArray(facts.archived) ? facts.archived.filter((id) => typeof id === 'string') : [],
        warnings: Array.isArray(facts.warnings) ? facts.warnings.filter((item) => typeof item === 'string') : [],
      }
      for (const warning of sessions.warnings) notes.push(warning)
    }
  } catch (error) {
    // The graph is still worth showing when the session gateway is absent.
    if (!isTaskDagError(error) || error.code !== CODES.hostUnavailable) {
      console.error('[dsh-task-dag] 读取会话状态失败', error)
    }
    notes.push('暂时读不到会话状态。')
  }

  return {
    workspace: {
      workspaceId: workspace.workspaceId,
      path: workspace.path,
      title: workspace.title,
    },
    graph,
    derived,
    sessions,
    notes: [...new Set(notes)],
  }
}

function summarizeWorkspace(store, workspace) {
  const summary = {
    workspaceId: workspace.workspaceId,
    path: workspace.path,
    title: workspace.title,
    revision: 0,
    progress: { ...EMPTY_PROGRESS },
    readyCount: 0,
  }

  try {
    const { graph } = store.read(workspace)
    const derived = derive(graph)
    summary.revision = revisionOf(graph)
    summary.progress = normalizeProgress(derived?.progress, graph)
    summary.readyCount = Array.isArray(derived?.ready) ? derived.ready.length : 0
  } catch (error) {
    console.error(`[dsh-task-dag] 读取工作区 ${workspace?.workspaceId ?? ''} 的图谱失败`, error)
  }

  return summary
}

// ---------------------------------------------------------------------------
// agent preset / model catalog
// ---------------------------------------------------------------------------

/** Per-context cache: one host lookup serves every panel refresh for 30s. */
const CATALOG_CACHE = new WeakMap()

function catalogWarning(warnings, message) {
  if (!warnings.includes(message)) warnings.push(message)
}

/**
 * Read the host's Agent presets and model catalog, cached per context for
 * `CATALOG_CACHE_MS`.
 *
 * The catalog is an optional convenience: a host without a session gateway must
 * still render the panel, so every failure collapses into an empty directory
 * plus a human-readable warning instead of a 500.
 *
 * @param {object} ctx host context
 * @param {number} [nowMs] clock injection point for tests
 * @returns {Promise<{presets: object[], models: object[], warnings: string[]}>}
 */
export async function loadCatalog(ctx, nowMs = Date.now()) {
  const cacheable = ctx !== null && typeof ctx === 'object'
  if (cacheable) {
    const cached = CATALOG_CACHE.get(ctx)
    if (cached !== undefined && nowMs - cached.at < CATALOG_CACHE_MS) return cached.value
  }

  const warnings = []
  let presets = []
  let models = []

  const listPresets = typeof sessionApi.listAgentPresets === 'function'
    ? sessionApi.listAgentPresets
    : undefined
  const listModels = typeof sessionApi.listModelCatalog === 'function'
    ? sessionApi.listModelCatalog
    : undefined

  if (listPresets === undefined || listModels === undefined) {
    catalogWarning(warnings, '当前环境没有会话网关，读不到 Agent 预设与模型目录。')
  } else {
    try {
      const value = await listPresets(ctx)
      if (Array.isArray(value)) {
        presets = value.filter((item) => item !== null && typeof item === 'object')
      } else {
        catalogWarning(warnings, 'Agent 预设目录格式不可用。')
      }
    } catch (error) {
      console.error('[dsh-task-dag] 读取 Agent 预设目录失败', error)
      catalogWarning(warnings, '读取 Agent 预设目录失败，可能没有会话网关。')
    }

    try {
      const value = await listModels(ctx)
      if (Array.isArray(value)) {
        models = value.filter((item) => item !== null && typeof item === 'object')
      } else {
        catalogWarning(warnings, '模型目录格式不可用。')
      }
    } catch (error) {
      console.error('[dsh-task-dag] 读取模型目录失败', error)
      catalogWarning(warnings, '模型目录不可用。')
    }

    if (warnings.length === 0) {
      if (presets.length === 0 && models.length === 0) {
        catalogWarning(warnings, 'Agent 预设与模型目录为空，可能没有会话网关。')
      } else if (models.length === 0) {
        catalogWarning(warnings, '模型目录不可用。')
      }
    }
  }

  const value = { presets, models, warnings }
  if (cacheable) CATALOG_CACHE.set(ctx, { at: nowMs, value })
  return value
}

/** Forget the cached catalog for one context (tests / reconnect flows). */
export function invalidateCatalogCache(ctx) {
  CATALOG_CACHE.delete(ctx)
}

// ---------------------------------------------------------------------------
// action body reading
// ---------------------------------------------------------------------------

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(headerValue(req?.headers?.['content-length']))
    if (Number.isFinite(declared) && declared > limit) {
      reject(new TaskDagError(CODES.invalidRequest, '请求体过大。', { status: 413 }))
      return
    }

    const chunks = []
    let total = 0
    let oversized = false
    let settled = false

    const finish = (settle, value) => {
      if (settled) return
      settled = true
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      req.removeListener('aborted', onAborted)
      settle(value)
    }

    const onData = (chunk) => {
      total += chunk.length
      if (total > limit) {
        oversized = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      if (oversized) {
        finish(reject, new TaskDagError(CODES.invalidRequest, '请求体过大。', { status: 413 }))
        return
      }
      finish(resolve, Buffer.concat(chunks).toString('utf8'))
    }
    const onError = (error) => finish(reject, error)
    const onAborted = () => finish(reject, new TaskDagError(CODES.invalidRequest, '请求已中断。'))

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

function invalidBody(message) {
  return new TaskDagError(CODES.invalidRequest, message)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------

function handlePing(req, res) {
  if (!requireMethod(req, res, 'GET')) return
  writeJson(res, 200, { ok: true, plugin: PLUGIN_NAME, pid: process.pid })
}

function handleWorkspaces(ctx, store, req, res) {
  if (!requireMethod(req, res, 'GET')) return
  const workspaces = listWorkspaces(ctx).map((workspace) => summarizeWorkspace(store, workspace))
  writeJson(res, 200, { ok: true, workspaces })
}

async function handleState(ctx, store, req, res) {
  if (!requireMethod(req, res, 'GET')) return
  const workspaceId = requestUrl(req).searchParams.get('workspaceId') ?? ''
  const workspace = getWorkspace(ctx, workspaceId)
  const snapshot = await snapshotFor(ctx, store, workspace)
  writeJson(res, 200, { ok: true, snapshot })
}

async function handleCatalog(ctx, req, res) {
  if (!requireMethod(req, res, 'GET')) return
  const catalog = await loadCatalog(ctx)
  writeJson(res, 200, { ok: true, catalog })
}

async function handleAction(ctx, store, req, res) {
  if (!requireMethod(req, res, 'POST')) return

  const contentType = headerValue(req?.headers?.['content-type']).toLowerCase()
  if (!contentType.startsWith('application/json')) {
    writeJson(res, 415, {
      ok: false,
      code: CODES.invalidRequest,
      message: '请用 JSON 提交操作。',
    })
    return
  }

  const text = await readBody(req, MAX_ACTION_BODY_BYTES)

  let body
  try {
    body = JSON.parse(text)
  } catch {
    writeJson(res, 400, {
      ok: false,
      code: CODES.invalidRequest,
      message: '请求体不是有效的 JSON。',
    })
    return
  }

  if (!isPlainObject(body)) throw invalidBody('请求体必须是一个 JSON 对象。')

  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : ''
  if (workspaceId === '') throw invalidBody('缺少 workspaceId。')

  const action = typeof body.action === 'string' ? body.action.trim() : ''
  if (action === '') throw invalidBody('缺少 action。')

  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
    throw invalidBody('缺少有效的 expectedRevision。')
  }

  let payload = {}
  if (body.payload !== undefined && body.payload !== null) {
    if (!isPlainObject(body.payload)) throw invalidBody('payload 必须是一个对象。')
    payload = body.payload
  }

  const requestId = typeof body.requestId === 'string' && body.requestId !== ''
    ? body.requestId
    : undefined

  const workspace = getWorkspace(ctx, workspaceId)
  const applied = await applyAction(ctx, store, workspace, {
    action,
    expectedRevision: body.expectedRevision,
    payload,
    requestId,
  })

  const snapshot = await snapshotFor(ctx, store, workspace)
  const warnings = applied !== null && applied !== undefined && Array.isArray(applied.warnings)
    ? applied.warnings.filter((warning) => typeof warning === 'string' && warning !== '')
    : []
  writeJson(res, 200, { ok: true, snapshot, ...(warnings.length > 0 ? { warnings } : {}) })
}

function handleEvents(ctx, store, req, res) {
  if (!requireMethod(req, res, 'GET')) return

  const workspace = getWorkspace(ctx, requestUrl(req).searchParams.get('workspaceId') ?? '')

  res.writeHead(200, SSE_HEADERS)
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  let closed = false
  let heartbeat
  let unsubscribe = () => {}

  const cleanup = () => {
    if (closed) return
    closed = true
    if (heartbeat !== undefined) clearInterval(heartbeat)
    heartbeat = undefined
    try {
      unsubscribe()
    } catch (error) {
      console.error('[dsh-task-dag] 取消事件订阅失败', error)
    }
  }

  const push = (revision) => {
    if (closed || res.writableEnded || res.destroyed) return
    try {
      res.write(`data: ${JSON.stringify({ revision })}\n\n`)
    } catch (error) {
      console.error('[dsh-task-dag] 写入事件帧失败', error)
      cleanup()
    }
  }

  const pushEventRevision = (event) => {
    if (closed) return
    if (Number.isInteger(event?.revision)) {
      push(event.revision)
      return
    }
    try {
      push(revisionOf(store.read(workspace)?.graph))
    } catch (error) {
      console.error('[dsh-task-dag] 读取图谱版本失败', error)
    }
  }

  res.on('close', cleanup)
  res.on('error', cleanup)
  req.on('close', cleanup)
  req.on('aborted', cleanup)

  try {
    // Subscribe before the opening snapshot so no commit can slip in between.
    unsubscribe = store.subscribe(workspace, pushEventRevision)
    push(revisionOf(store.read(workspace)?.graph))
    heartbeat = setInterval(() => {
      if (closed) return
      try {
        res.write(': ping\n\n')
      } catch (error) {
        console.error('[dsh-task-dag] 发送心跳失败', error)
        cleanup()
      }
    }, SSE_HEARTBEAT_MS)
    heartbeat.unref?.()
  } catch (error) {
    console.error('[dsh-task-dag] 建立事件流失败', error)
    cleanup()
    try {
      res.end()
    } catch {
      // nothing else to close
    }
  }
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

/** Wrap a handler: apply the guard, then render any failure as JSON. */
function guarded(handler) {
  return (req, res) => {
    try {
      const trust = inspectBrowserRequest(req)
      if (!trust.ok) {
        writeForbidden(res, trust.reason)
        return
      }
      const result = handler(req, res)
      if (result !== undefined && typeof result.then === 'function') {
        result.catch((error) => writeFailure(res, error))
      }
    } catch (error) {
      writeFailure(res, error)
    }
  }
}

function collectDisposers(registration, disposers) {
  if (typeof registration === 'function') {
    disposers.push(registration)
  } else if (registration !== null && typeof registration === 'object'
    && typeof registration.dispose === 'function') {
    disposers.push(() => registration.dispose())
  }
}

function disposeAll(disposers, message) {
  for (let index = disposers.length - 1; index >= 0; index -= 1) {
    try {
      disposers[index]()
    } catch (error) {
      console.error(message, error)
    }
  }
}

/**
 * Register every HTTP/SSE route. Returns one disposer that unregisters them all.
 *
 * @param {object} ctx host context (needs `webServer`, `workspaceRegistry`)
 * @param {{store: object, handoffThreshold?: number}} options
 *   `handoffThreshold` is accepted for symmetry with the plugin config; the
 *   client applies it to the context-pressure bar in M1.
 */
export function registerRoutes(ctx, options = {}) {
  const store = options?.store
  if (store === null || typeof store !== 'object'
    || typeof store.read !== 'function' || typeof store.subscribe !== 'function') {
    throw new TaskDagError(CODES.hostUnavailable, '图存储不可用，HTTP 接口没有注册。')
  }

  const webServer = ctx?.webServer
  if (webServer === null || typeof webServer !== 'object' || typeof webServer.register !== 'function') {
    console.error('[dsh-task-dag] webServer 不可用，HTTP 接口没有注册')
    return () => {}
  }

  const routes = [
    ['/ping', (req, res) => handlePing(req, res)],
    ['/workspaces', (req, res) => handleWorkspaces(ctx, store, req, res)],
    ['/catalog', (req, res) => handleCatalog(ctx, req, res)],
    ['/state', (req, res) => handleState(ctx, store, req, res)],
    ['/action', (req, res) => handleAction(ctx, store, req, res)],
    ['/events', (req, res) => handleEvents(ctx, store, req, res)],
  ]

  const disposers = []
  try {
    for (const [suffix, handler] of routes) {
      const path = `${API_PREFIX}${suffix}`
      collectDisposers(webServer.register({ kind: 'exact', path, handler: guarded(handler) }), disposers)
    }
  } catch (error) {
    disposeAll(disposers, '[dsh-task-dag] 回滚 HTTP 路由注册失败')
    throw error
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    disposeAll(disposers, '[dsh-task-dag] 注销 HTTP 路由失败')
  }
}
