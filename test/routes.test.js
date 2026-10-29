/**
 * Transport-surface tests for the `dsh-task-dag` Host half (v2 contract).
 *
 * The HTTP routes are exercised through a real `node:http` server on port 0 and
 * driven with `fetch`, exactly like the browser half does. The Agent tools and
 * the prompt section are driven through fake service objects that capture what
 * the plugin registers, so the compiled schemas and the three-line prompt are
 * asserted without a live DSH host.
 *
 * Run: node test/routes.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { derive } from '../src/model.js'
import { GraphStore } from '../src/store.js'
import {
  API_PREFIX,
  CATALOG_CACHE_MS,
  invalidateCatalogCache,
  registerRoutes,
  snapshotFor,
} from '../src/routes.js'
import {
  TOOL_NAMES,
  buildGraphMap,
  pickNextNode,
  registerTools,
} from '../src/tools.js'
import {
  PROMPT_SECTION_ORDER,
  registerPromptSection,
  renderNodeSection,
  scopeSessionCandidates,
} from '../src/prompt.js'

const WORKSPACE_ID = 'ws_routes'
const CREATED = '2026-10-28T11:00:00.000Z'

// ---------------------------------------------------------------------------
// fixtures (v2 document shape)
// ---------------------------------------------------------------------------

function makeSession(sessionId, slot, retiredAt = null) {
  return {
    sessionId,
    slot,
    titleSnapshot: sessionId,
    attachedAt: CREATED,
    retiredAt,
    handoff: { from: null, mode: 'attach' },
  }
}

function makeCondition(id, title) {
  return { id, title, createdAt: CREATED }
}

function makeNode(id, title, status = 'todo', options = {}) {
  const {
    sessions = [],
    conditions = [],
    agentPreset = null,
    model = null,
    schedule = null,
  } = options
  return {
    id,
    title,
    status,
    notes: '',
    conditions,
    sessions,
    position: null,
    agentPreset,
    model,
    schedule,
    createdAt: CREATED,
    updatedAt: CREATED,
    completedAt: status === 'done' ? CREATED : null,
    failedAt: status === 'failed' ? CREATED : null,
  }
}

function makeEdge(id, from, to, conditionId) {
  return { id, from, to, conditionId }
}

function graphDocument(root, { revision = 3, nodes = [], edges = [], milestoneNodeId = null } = {}) {
  return {
    schemaVersion: 2,
    workspaceId: WORKSPACE_ID,
    workspacePath: root,
    title: '测试项目',
    revision,
    updatedAt: CREATED,
    milestoneNodeId,
    nodes,
    edges,
  }
}

/**
 * A -> B -> C plus one failed and one planned node:
 * - A 完成 (session-a)
 * - B 待开始，条件「需求评审通过」由 A 满足 → ready
 * - C 待开始，条件「接口完成」由 B 满足 → blocked
 * - D 已失败，E 待规划
 * The milestone is C; it is only a marker, so it must not add any
 * project-completion flag to progress.
 */
function chainGraph(root, revision = 3) {
  return graphDocument(root, {
    revision,
    nodes: [
      makeNode('n_aaaa1111', '确定数据模型', 'done', { sessions: [makeSession('session-a', 1)] }),
      makeNode('n_bbbb2222', '实现接口', 'todo', {
        sessions: [makeSession('session-b', 1)],
        conditions: [makeCondition('c_bbbb0001', '需求评审通过')],
        agentPreset: 'preset-coder',
        model: 'deepseek/deepseek-chat',
        schedule: {
          enabled: true,
          cron: '0 9 * * 1-5',
          nextRunAt: '2026-10-29T01:00:00.000Z',
          lastTriggeredAt: null,
          lastFinishedAt: null,
          lastResult: null,
          lastError: null,
          lastSkippedReason: null,
          lastSessionId: null,
        },
      }),
      makeNode('n_cccc3333', '写文档', 'todo', {
        sessions: [makeSession('session-c', 1)],
        conditions: [makeCondition('c_cccc0001', '接口完成')],
      }),
      makeNode('n_dddd4444', '失败任务', 'failed', { sessions: [makeSession('session-d', 1)] }),
      makeNode('n_eeee5555', '待规划任务', 'planned', { sessions: [makeSession('session-e', 1)] }),
    ],
    edges: [
      makeEdge('e_11112222', 'n_aaaa1111', 'n_bbbb2222', 'c_bbbb0001'),
      makeEdge('e_33334444', 'n_bbbb2222', 'n_cccc3333', 'c_cccc0001'),
    ],
    milestoneNodeId: 'n_cccc3333',
  })
}

/** Two nodes and no edges: a clean slate for tool mutations. */
function simpleGraph(root, revision = 1) {
  return graphDocument(root, {
    revision,
    nodes: [
      makeNode('n_aaaa1111', '完成需求', 'done', { sessions: [makeSession('session-a', 1)] }),
      makeNode('n_bbbb2222', '实现功能', 'todo'),
    ],
    edges: [],
  })
}

async function writeGraph(root, document) {
  const dir = join(root, '.dsh-task-graph')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'graph.json'), JSON.stringify(document, null, 2), 'utf8')
}

function originHeaders(base, extra = {}) {
  return { origin: base, ...extra }
}

function assertErrorBody(body) {
  assert.equal(body.ok, false)
  assert.deepEqual(Object.keys(body).sort(), ['code', 'message', 'ok'])
  assert.equal(typeof body.code, 'string')
  assert.equal(typeof body.message, 'string')
  assert.ok(body.message.length > 0)
  assert.match(body.message, /[\u4e00-\u9fff]/, '错误信息应当是可读的中文')
  assert.ok(!body.message.includes('\n    at '), '错误体不能包含堆栈')
}

// ---------------------------------------------------------------------------
// output-schema validator
// ---------------------------------------------------------------------------

function typeMatches(value, type) {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'integer': return Number.isInteger(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true
  }
}

/**
 * Validate a value against the JSON-Schema subset tool definitions use
 * (type unions, required, properties, additionalProperties, items, enum).
 * Throws an assertion with the failing path, so a drifted tool output names
 * exactly which field disagrees with its compiled schema.
 */
function assertSchema(value, schema, path = '$') {
  if (schema === undefined || schema === null) return
  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type]
  if (types.length > 0) {
    assert.ok(
      types.some((type) => typeMatches(value, type)),
      `${path} 类型应为 ${types.join('|')}，实际是 ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`,
    )
  }
  if (Array.isArray(schema.enum)) {
    assert.ok(schema.enum.includes(value), `${path} 的值 ${JSON.stringify(value)} 不在 ${JSON.stringify(schema.enum)} 内`)
  }
  if (value === null) return
  if (Array.isArray(value)) {
    if (schema.items !== undefined) {
      value.forEach((item, index) => assertSchema(item, schema.items, `${path}[${index}]`))
    }
    return
  }
  if (typeof value !== 'object') return
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    assert.ok(Object.hasOwn(value, key), `${path} 缺少必填字段 ${key}`)
  }
  const properties = schema.properties !== null && typeof schema.properties === 'object' ? schema.properties : {}
  for (const [key, child] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key)) continue
    assertSchema(value[key], child, `${path}.${key}`)
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      assert.ok(Object.hasOwn(properties, key), `${path} 多出 schema 未声明的字段 ${key}`)
    }
  }
}

// ---------------------------------------------------------------------------
// fake session gateway
// ---------------------------------------------------------------------------

function makeGateway({ presets = [{ id: 'preset-coder', label: '编码' }], models = [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] } = {}) {
  const calls = []
  return {
    calls,
    async invoke(request) {
      calls.push(request)
      if (request.namespace === 'agentPresets' && request.method === 'list') {
        return { presets }
      }
      if (request.namespace === 'session' && request.method === 'modelCatalog') {
        return { groups: [{ provider: 'deepseek', models }] }
      }
      throw new Error(`unexpected gateway call ${request.namespace}/${request.method}`)
    },
  }
}

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------

/**
 * Ports undici (global fetch) refuses to connect to as "bad port". An OS-assigned
 * ephemeral port can fall inside this list on a machine with a custom dynamic
 * port range; retrying the listen keeps the suite deterministic without giving
 * up the ephemeral-port safety.
 */
const BLOCKED_FETCH_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
])

/** Listen on an ephemeral loopback port that global fetch will accept. */
async function listenOnSafePort(server) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const onError = (error) => reject(error)
      server.once('error', onError)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', onError)
        resolve(server.address().port)
      })
    })
    if (!BLOCKED_FETCH_PORTS.has(port)) return port
    await new Promise((resolve) => server.close(resolve))
  }
  throw new Error('could not bind a fetch-safe ephemeral port')
}

/**
 * Mount the plugin's routes on a fake ctx whose `webServer.register` feeds a
 * real node:http server. Returns the base URL and a `close()` that removes the
 * routes, drops connections and deletes the temp workspace.
 */
async function createHarness(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'task-dag-routes-'))
  const workspace = { workspaceId: WORKSPACE_ID, path: root, title: '测试项目' }
  const entity = {
    id: WORKSPACE_ID,
    path: root,
    title: '测试项目',
    sessionIds: options.sessionIds ?? [],
  }
  const store = options.store ?? new GraphStore()
  const routes = new Map()
  const ctx = {
    webServer: {
      register(route) {
        assert.equal(route.kind, 'exact')
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    workspaceRegistry: { list: () => [entity] },
    sessions: { get: () => undefined },
  }
  if (options.gateway !== undefined) ctx.typertGateway = options.gateway
  if (options.llm !== undefined) ctx.llm = options.llm

  const dispose = registerRoutes(ctx, { store, handoffThreshold: 0.6 })

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const handler = routes.get(url.pathname)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, code: 'not-found' }))
      return
    }
    handler(req, res)
  })
  const port = await listenOnSafePort(server)

  const base = `http://127.0.0.1:${port}`

  return {
    root,
    workspace,
    store,
    ctx,
    routes,
    base,
    server,
    dispose,
    writeGraph: (document) => writeGraph(root, document),
    async getJson(route) {
      const response = await fetch(`${base}${route}`, { headers: originHeaders(base) })
      return { response, body: await response.json() }
    },
    async postAction(body, { headers = {} } = {}) {
      const response = await fetch(`${base}${API_PREFIX}/action`, {
        method: 'POST',
        headers: originHeaders(base, { 'content-type': 'application/json', ...headers }),
        body: JSON.stringify(body),
      })
      return { response, body: await response.json() }
    },
    async close() {
      dispose()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function createFixture({ graph, sessionIds = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'task-dag-fixture-'))
  const workspace = { workspaceId: WORKSPACE_ID, path: root, title: '测试项目' }
  if (graph !== undefined) await writeGraph(root, typeof graph === 'function' ? graph(root) : graph)
  const store = new GraphStore()
  const entity = {
    id: WORKSPACE_ID,
    path: root,
    title: '测试项目',
    sessionIds,
  }
  const ctx = {
    workspaceRegistry: { list: () => [entity] },
    sessions: { get: () => undefined },
  }
  return {
    root,
    workspace,
    store,
    ctx,
    async close() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

function findNodeByTitle(graph, title) {
  return (Array.isArray(graph?.nodes) ? graph.nodes : []).find((node) => node.title === title)
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

test('ping answers with the plugin identity', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.close())

  const { response, body } = await harness.getJson(`${API_PREFIX}/ping`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /application\/json; charset=utf-8/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'pid', 'plugin'])
  assert.equal(body.ok, true)
  assert.equal(body.plugin, 'dsh-task-dag')
  assert.equal(body.pid, process.pid)
})

test('workspaces lists v2 progress with doing/failed/planned and no completion flag', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.close())
  await harness.writeGraph(chainGraph(harness.root))

  const { response, body } = await harness.getJson(`${API_PREFIX}/workspaces`)
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.workspaces.length, 1)
  const [workspace] = body.workspaces
  assert.deepEqual(Object.keys(workspace).sort(), [
    'path', 'progress', 'readyCount', 'revision', 'title', 'workspaceId',
  ])
  assert.equal(workspace.workspaceId, WORKSPACE_ID)
  assert.equal(workspace.revision, 3)
  assert.deepEqual(workspace.progress, {
    done: 1,
    total: 5,
    ready: 1,
    blocked: 1,
    doing: 0,
    failed: 1,
    planned: 1,
  })
  assert.equal('milestoneDone' in workspace.progress, false, 'progress carries counts only')
  assert.equal(workspace.readyCount, 1)
})

test('state returns the full v2 snapshot with condition derivation', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.close())
  await harness.writeGraph(chainGraph(harness.root))

  const { response, body } = await harness.getJson(`${API_PREFIX}/state?workspaceId=${WORKSPACE_ID}`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-type'), /application\/json; charset=utf-8/)
  assert.equal(body.ok, true)

  const snapshot = body.snapshot
  assert.deepEqual(Object.keys(snapshot).sort(), ['derived', 'graph', 'notes', 'sessions', 'workspace'])
  assert.deepEqual(snapshot.workspace, {
    workspaceId: WORKSPACE_ID,
    path: harness.root,
    title: '测试项目',
  })
  assert.equal(snapshot.graph.schemaVersion, 2)
  assert.equal(snapshot.graph.revision, 3)
  assert.equal(snapshot.graph.milestoneNodeId, 'n_cccc3333')
  assert.equal(snapshot.graph.nodes.length, 5)

  assert.deepEqual(snapshot.derived.ready, ['n_bbbb2222'])
  assert.deepEqual(snapshot.derived.blocked, ['n_cccc3333'])
  assert.deepEqual(snapshot.derived.failed, ['n_dddd4444'])
  assert.deepEqual(snapshot.derived.planned, ['n_eeee5555'])
  assert.deepEqual(snapshot.derived.progress, {
    done: 1,
    total: 5,
    ready: 1,
    blocked: 1,
    doing: 0,
    failed: 1,
    planned: 1,
  })
  assert.deepEqual(snapshot.derived.conditions.n_bbbb2222, [{
    id: 'c_bbbb0001',
    title: '需求评审通过',
    satisfied: true,
    linked: [{ id: 'n_aaaa1111', title: '确定数据模型', status: 'done' }],
    waiting: [],
  }])
  assert.deepEqual(snapshot.derived.conditions.n_cccc3333, [{
    id: 'c_cccc0001',
    title: '接口完成',
    satisfied: false,
    linked: [{ id: 'n_bbbb2222', title: '实现接口', status: 'todo' }],
    waiting: [{ id: 'n_bbbb2222', title: '实现接口', status: 'todo' }],
  }])
  assert.deepEqual(snapshot.derived.milestone, {
    id: 'n_cccc3333',
    title: '写文档',
    status: 'todo',
    done: false,
  })
  assert.ok(Array.isArray(snapshot.notes))
  assert.deepEqual(snapshot.sessions.byId, {})
})

test('state explains a missing or unknown workspace', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.close())

  const missing = await harness.getJson(`${API_PREFIX}/state`)
  assert.equal(missing.response.status, 400)
  assert.equal(missing.body.code, 'invalid-request')

  const unknown = await harness.getJson(`${API_PREFIX}/state?workspaceId=ws_nope`)
  assert.equal(unknown.response.status, 404)
  assert.equal(unknown.body.code, 'not-found')
  assertErrorBody(unknown.body)
})

test('catalog exposes Agent presets and models from the session gateway', async (t) => {
  const gateway = makeGateway()
  const harness = await createHarness({ gateway })
  t.after(() => harness.close())

  const { response, body } = await harness.getJson(`${API_PREFIX}/catalog`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(body.ok, true)
  assert.deepEqual(Object.keys(body).sort(), ['catalog', 'ok'])
  assert.deepEqual(Object.keys(body.catalog).sort(), ['models', 'presets', 'warnings'])
  assert.deepEqual(body.catalog.presets, [{ id: 'preset-coder', label: '编码' }])
  assert.deepEqual(body.catalog.models, [{ provider: 'deepseek', id: 'deepseek-chat', label: 'DeepSeek Chat' }])
  assert.deepEqual(body.catalog.warnings, [])

  const presetCall = gateway.calls.find((call) => call.namespace === 'agentPresets')
  assert.deepEqual(presetCall.args, {}, 'agentPresets/list 的 args 必须是裸 {}')
  const modelCall = gateway.calls.find((call) => call.method === 'modelCatalog')
  assert.deepEqual(modelCall.args, { request: {} })
})

test('catalog uses the live LLM registry with reasoning levels when available', async (t) => {
  const harness = await createHarness({
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek 官方' }],
      listModels: async () => [{ id: 'reasoner', name: 'DeepSeek Reasoner' }],
      resolveModelInfo: async () => ({
        reasoning: {
          efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }],
          defaultEffort: 'high',
        },
      }),
    },
  })
  t.after(() => harness.close())

  const { body } = await harness.getJson(`${API_PREFIX}/catalog`)
  assert.equal(body.ok, true)
  assert.deepEqual(body.catalog.models, [{
    provider: 'deepseek',
    providerLabel: 'DeepSeek 官方',
    id: 'reasoner',
    label: 'DeepSeek Reasoner',
    reasoning: {
      efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }],
      defaultEffort: 'high',
    },
  }])
  assert.deepEqual(body.catalog.warnings, [])
})

test('catalog degrades to an empty catalog with a warning when no gateway exists', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.close())

  const { response, body } = await harness.getJson(`${API_PREFIX}/catalog`)
  assert.equal(response.status, 200, '没有会话网关也不能 500')
  assert.equal(body.ok, true)
  assert.deepEqual(body.catalog.presets, [])
  assert.deepEqual(body.catalog.models, [])
  assert.ok(body.catalog.warnings.length > 0)
  for (const warning of body.catalog.warnings) {
    assert.match(warning, /[\u4e00-\u9fff]/)
  }
})

test('catalog caches the gateway listing for 30 seconds', async (t) => {
  assert.equal(CATALOG_CACHE_MS, 30_000)
  const gateway = makeGateway()
  const harness = await createHarness({ gateway })
  t.after(() => harness.close())

  await harness.getJson(`${API_PREFIX}/catalog`)
  const afterFirst = gateway.calls.length
  assert.equal(afterFirst, 2, '第一次应读取预设与模型各一次')

  await harness.getJson(`${API_PREFIX}/catalog`)
  assert.equal(gateway.calls.length, afterFirst, '30 秒内应复用缓存')

  invalidateCatalogCache(harness.ctx)
  await harness.getJson(`${API_PREFIX}/catalog`)
  assert.equal(gateway.calls.length, afterFirst + 2, '清除缓存后会重新读取')
})

test('the guard accepts a loopback request that carries no browser metadata', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.close())
  await harness.writeGraph(chainGraph(harness.root))

  // The official desktop shell re-issues the page's requests, dropping
  // Sec-Fetch-* and Origin. Missing metadata must not lock the plugin out.
  const bare = await fetch(`${harness.base}${API_PREFIX}/state?workspaceId=${WORKSPACE_ID}`)
  assert.equal(bare.status, 200)
  assert.equal(bare.headers.get('cache-control'), 'no-store')
  const bareBody = await bare.json()
  assert.equal(bareBody.ok, true)

  const events = await fetch(`${harness.base}${API_PREFIX}/events?workspaceId=${WORKSPACE_ID}`)
  assert.equal(events.status, 200)
  await events.body?.cancel()
})

test('the guard rejects an explicit cross-site caller', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.close())

  const crossSite = await fetch(`${harness.base}${API_PREFIX}/state?workspaceId=${WORKSPACE_ID}`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(crossSite.status, 403)
  const crossBody = await crossSite.json()
  assert.equal(crossBody.code, 'forbidden')
  assertErrorBody(crossBody)
  assert.match(crossBody.message, /cross-site/)

  const foreign = await fetch(`${harness.base}${API_PREFIX}/state?workspaceId=${WORKSPACE_ID}`, {
    headers: { origin: 'http://evil.example.com' },
  })
  assert.equal(foreign.status, 403)
  assert.match((await foreign.json()).message, /Origin 与 Host 不一致/)

  // A forged Host header is not loopback, so the request is refused even though
  // the socket itself is local. fetch() cannot set Host, so use node:http.
  const forgedHost = await new Promise((resolve, reject) => {
    const target = new URL(`${harness.base}${API_PREFIX}/state?workspaceId=${WORKSPACE_ID}`)
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { host: 'evil.example.com' },
    }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body: text }))
    })
    request.on('error', reject)
    request.end()
  })
  assert.equal(forgedHost.status, 403)

  const action = await fetch(`${harness.base}${API_PREFIX}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ workspaceId: WORKSPACE_ID, action: 'add-node', expectedRevision: 0, payload: { title: '偷偷加' } }),
  })
  assert.equal(action.status, 403)
  assert.equal((await action.json()).code, 'forbidden')
})

test('the guard accepts same-origin signals and the plugin client header', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.close())

  const bySite = await fetch(`${harness.base}${API_PREFIX}/ping`, {
    headers: { 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(bySite.status, 200)

  const byOrigin = await fetch(`${harness.base}${API_PREFIX}/ping`, {
    headers: { origin: harness.base },
  })
  assert.equal(byOrigin.status, 200)

  const byClientHeader = await fetch(`${harness.base}${API_PREFIX}/ping`, {
    headers: { 'x-dsh-task-dag-client': '1' },
  })
  assert.equal(byClientHeader.status, 200)

  const nullOrigin = await fetch(`${harness.base}${API_PREFIX}/ping`, {
    headers: { origin: 'null' },
  })
  assert.equal(nullOrigin.status, 200)
})

test('GET-only routes answer 405 for other methods', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.close())

  for (const route of ['/state', '/catalog']) {
    const response = await fetch(`${harness.base}${API_PREFIX}${route}?workspaceId=${WORKSPACE_ID}`, {
      method: 'POST',
      headers: originHeaders(harness.base, { 'content-type': 'application/json' }),
      body: '{}',
    })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET')
    const body = await response.json()
    assert.equal(body.code, 'method-not-allowed')
    assertErrorBody(body)
  }

  const action = await fetch(`${harness.base}${API_PREFIX}/action`, {
    headers: originHeaders(harness.base),
  })
  assert.equal(action.status, 405)
  assert.equal(action.headers.get('allow'), 'POST')
  assert.equal((await action.json()).code, 'method-not-allowed')
})

test('action requires a JSON content type', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.close())

  const response = await fetch(`${harness.base}${API_PREFIX}/action`, {
    method: 'POST',
    headers: originHeaders(harness.base, { 'content-type': 'text/plain' }),
    body: '{}',
  })
  assert.equal(response.status, 415)
  assertErrorBody(await response.json())
})

test('action rejects an oversized body', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.close())

  const response = await fetch(`${harness.base}${API_PREFIX}/action`, {
    method: 'POST',
    headers: originHeaders(harness.base, { 'content-type': 'application/json' }),
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      action: 'add-node',
      expectedRevision: 0,
      payload: { title: 'x', notes: 'x'.repeat(300 * 1024) },
    }),
  })
  assert.equal(response.status, 413)
  assertErrorBody(await response.json())
})

test('action rejects malformed requests with 400', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.close())

  const request = (body) => fetch(`${harness.base}${API_PREFIX}/action`, {
    method: 'POST',
    headers: originHeaders(harness.base, { 'content-type': 'application/json' }),
    body,
  })

  const notJson = await request('{not json')
  assert.equal(notJson.status, 400)
  assert.equal((await notJson.json()).code, 'invalid-request')

  const notObject = await request('[1,2,3]')
  assert.equal(notObject.status, 400)
  assert.equal((await notObject.json()).code, 'invalid-request')

  for (const body of [
    { action: 'add-node', expectedRevision: 0, payload: { title: 'x' } },
    { workspaceId: WORKSPACE_ID, expectedRevision: 0, payload: { title: 'x' } },
    { workspaceId: WORKSPACE_ID, action: 'add-node', payload: { title: 'x' } },
    { workspaceId: WORKSPACE_ID, action: 'add-node', expectedRevision: 0, payload: 'nope' },
  ]) {
    const response = await request(JSON.stringify(body))
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal((await response.json()).code, 'invalid-request')
  }
})

test('action rejects an unknown action with 400', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.close())

  const { response, body } = await harness.postAction({
    workspaceId: WORKSPACE_ID,
    action: 'make-coffee',
    expectedRevision: 0,
    payload: {},
  })
  assert.equal(response.status, 400)
  assert.equal(body.code, 'invalid-request')
  assertErrorBody(body)
})

test('action maps a stale revision to 409', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.close())
  await harness.writeGraph(chainGraph(harness.root))

  const { response, body } = await harness.postAction({
    workspaceId: WORKSPACE_ID,
    action: 'add-node',
    expectedRevision: 1,
    payload: { title: '过期写入' },
  })
  assert.equal(response.status, 409)
  assert.equal(body.code, 'revision-conflict')
  assertErrorBody(body)
})

test('action adds a v2 node and returns the fresh snapshot', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.close())

  const { response, body } = await harness.postAction({
    workspaceId: WORKSPACE_ID,
    action: 'add-node',
    expectedRevision: 0,
    payload: { title: '第一个任务' },
  })
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.snapshot.graph.schemaVersion, 2)
  assert.equal(body.snapshot.graph.nodes.length, 1)
  const [node] = body.snapshot.graph.nodes
  assert.equal(node.title, '第一个任务')
  assert.deepEqual(node.conditions, [])
  assert.equal(node.agentPreset, null)
  assert.equal(node.model, null)
  assert.equal(node.schedule, null)
  assert.equal(body.snapshot.graph.revision, 1)
  assert.deepEqual(body.snapshot.derived.ready, [node.id])

  const reread = harness.store.read(harness.workspace)
  assert.equal(reread.graph.revision, 1)
})

test('action supports add-node conditions/after, link by condition title, and condition CRUD', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.close())
  await harness.writeGraph(chainGraph(harness.root))

  let revision = 3
  const post = async (action, payload) => {
    const result = await harness.postAction({
      workspaceId: WORKSPACE_ID,
      action,
      expectedRevision: revision,
      payload,
    })
    assert.equal(result.response.status, 200, `${action}: ${JSON.stringify(result.body)}`)
    revision = result.body.snapshot.graph.revision
    return result.body.snapshot
  }

  // after 简写 + 一个未关联的条件
  const added = await post('add-node', {
    title: '联调',
    after: ['n_aaaa1111'],
    conditions: [{ title: '设计稿' }],
  })
  const addedNode = findNodeByTitle(added.graph, '联调')
  assert.ok(addedNode !== undefined)
  // Explicit conditions are created first; the `after` shorthand appends one per
  // predecessor after them.
  assert.deepEqual(addedNode.conditions.map((condition) => condition.title), ['设计稿', '确定数据模型 完成'])
  const addedEdges = added.graph.edges.filter((edge) => edge.to === addedNode.id)
  assert.equal(addedEdges.length, 1)
  assert.equal(addedEdges[0].from, 'n_aaaa1111')
  assert.equal(addedEdges[0].conditionId, addedNode.conditions[1].id)
  // `blocked` follows topological order, not id order; a random `n_` id can
  // sort either side of the fixture ids, so compare both sides sorted.
  assert.deepEqual(expectSort(added.derived.blocked), expectSort([addedNode.id, 'n_cccc3333']))

  // 用 conditionTitle 把 B 连到「设计稿」
  const linked = await post('link', {
    from: 'n_bbbb2222',
    to: addedNode.id,
    conditionTitle: '设计稿',
  })
  const linkedEdge = linked.graph.edges.find(
    (edge) => edge.from === 'n_bbbb2222' && edge.to === addedNode.id,
  )
  assert.ok(linkedEdge !== undefined)
  assert.equal(
    linkedEdge.conditionId,
    linked.graph.nodes.find((node) => node.id === addedNode.id).conditions[0].id,
  )

  // 执行设置
  const preset = await post('update-node', {
    nodeId: addedNode.id,
    agentPreset: 'preset-writer',
    model: 'deepseek/deepseek-chat',
  })
  const presetNode = preset.graph.nodes.find((node) => node.id === addedNode.id)
  assert.equal(presetNode.agentPreset, 'preset-writer')
  assert.equal(presetNode.model, 'deepseek/deepseek-chat')

  const cleared = await post('update-node', { nodeId: addedNode.id, agentPreset: '', model: '' })
  const clearedNode = cleared.graph.nodes.find((node) => node.id === addedNode.id)
  assert.equal(clearedNode.agentPreset, null)
  assert.equal(clearedNode.model, null)

  // 条件增改删
  const withCondition = await post('add-condition', { nodeId: 'n_cccc3333', title: '人工验收' })
  const cNode = withCondition.graph.nodes.find((node) => node.id === 'n_cccc3333')
  assert.deepEqual(cNode.conditions.map((condition) => condition.title), ['接口完成', '人工验收'])

  const renamed = await post('update-condition', {
    nodeId: 'n_cccc3333',
    conditionId: 'c_cccc0001',
    title: '接口交付',
  })
  assert.deepEqual(
    renamed.graph.nodes.find((node) => node.id === 'n_cccc3333').conditions.map((condition) => condition.title),
    ['接口交付', '人工验收'],
  )

  const deleted = await post('delete-condition', { nodeId: 'n_cccc3333', conditionId: 'c_cccc0001' })
  assert.deepEqual(
    deleted.graph.nodes.find((node) => node.id === 'n_cccc3333').conditions.map((condition) => condition.title),
    ['人工验收'],
  )
  assert.ok(!deleted.graph.edges.some((edge) => edge.conditionId === 'c_cccc0001'))
})

test('action enforces failed-node rules and supports milestone and schedule', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.close())
  await harness.writeGraph(chainGraph(harness.root))

  let revision = 3
  const post = async (action, payload) => {
    const result = await harness.postAction({
      workspaceId: WORKSPACE_ID,
      action,
      expectedRevision: revision,
      payload,
    })
    assert.equal(result.response.status, 200, `${action}: ${JSON.stringify(result.body)}`)
    revision = result.body.snapshot.graph.revision
    return result.body.snapshot
  }

  // B has an outgoing edge, so failing it without detachSuccessors must 400.
  const refused = await harness.postAction({
    workspaceId: WORKSPACE_ID,
    action: 'update-node',
    expectedRevision: revision,
    payload: { nodeId: 'n_bbbb2222', status: 'failed' },
  })
  assert.equal(refused.response.status, 400)
  assert.equal(refused.body.ok, false)
  assert.match(refused.body.message, /后继|完成|依赖/)

  const failed = await post('update-node', {
    nodeId: 'n_bbbb2222',
    status: 'failed',
    detachSuccessors: true,
  })
  const failedNode = failed.graph.nodes.find((node) => node.id === 'n_bbbb2222')
  assert.equal(failedNode.status, 'failed')
  assert.equal(typeof failedNode.failedAt, 'string')
  assert.equal(failedNode.completedAt, null)
  assert.ok(!failed.graph.edges.some((edge) => edge.from === 'n_bbbb2222'))
  assert.ok(failed.derived.failed.includes('n_bbbb2222'))

  // A failed node cannot become a predecessor again.
  const badLink = await harness.postAction({
    workspaceId: WORKSPACE_ID,
    action: 'link',
    expectedRevision: revision,
    payload: { from: 'n_bbbb2222', to: 'n_eeee5555' },
  })
  assert.equal(badLink.response.status, 400)
  assertErrorBody(badLink.body)

  // Milestone: set, then clear.
  const milestone = await post('set-milestone', { nodeId: 'n_dddd4444' })
  assert.equal(milestone.graph.milestoneNodeId, 'n_dddd4444')
  assert.deepEqual(milestone.derived.milestone, {
    id: 'n_dddd4444',
    title: '失败任务',
    status: 'failed',
    done: false,
  })
  const clearedMilestone = await post('set-milestone', { nodeId: null })
  assert.equal(clearedMilestone.graph.milestoneNodeId, null)
  assert.equal(clearedMilestone.derived.milestone, null)

  // `set-closeout` stays accepted as the legacy alias.
  const alias = await post('set-closeout', { nodeId: 'n_eeee5555' })
  assert.equal(alias.graph.milestoneNodeId, 'n_eeee5555')

  // Per-node schedule.
  const scheduled = await post('set-schedule', {
    nodeId: 'n_cccc3333',
    enabled: true,
    cron: '0 9 * * 1-5',
  })
  const scheduledNode = scheduled.graph.nodes.find((node) => node.id === 'n_cccc3333')
  assert.equal(scheduledNode.schedule.enabled, true)
  assert.equal(scheduledNode.schedule.cron, '0 9 * * 1-5')
  assert.equal(typeof scheduledNode.schedule.nextRunAt, 'string')

  const disabled = await post('set-schedule', { nodeId: 'n_cccc3333', enabled: false })
  const disabledNode = disabled.graph.nodes.find((node) => node.id === 'n_cccc3333')
  assert.equal(disabledNode.schedule.enabled, false)
  assert.equal(disabledNode.schedule.nextRunAt, null)

  const badCron = await harness.postAction({
    workspaceId: WORKSPACE_ID,
    action: 'set-schedule',
    expectedRevision: revision,
    payload: { nodeId: 'n_cccc3333', enabled: true, cron: 'not a cron' },
  })
  assert.equal(badCron.response.status, 400)
  assertErrorBody(badCron.body)
})

test('events streams the opening revision and the revision after a commit', async (t) => {
  const harness = await createHarness()
  const controller = new AbortController()
  t.after(async () => {
    controller.abort()
    await harness.close()
  })

  const response = await fetch(`${harness.base}${API_PREFIX}/events?workspaceId=${WORKSPACE_ID}`, {
    headers: originHeaders(harness.base),
    signal: controller.signal,
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream; charset=utf-8/)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const readFrame = (timeoutMs = 5_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 SSE 帧超时')), timeoutMs)
    timer.unref?.()
    const pump = async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) throw new Error('SSE 流提前结束')
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
            if (dataLine !== undefined) {
              clearTimeout(timer)
              resolve(JSON.parse(dataLine.slice(6)))
              return
            }
            boundary = buffer.indexOf('\n\n')
          }
        }
      } catch (error) {
        clearTimeout(timer)
        reject(error)
      }
    }
    pump()
  })

  assert.deepEqual(await readFrame(), { revision: 0 })

  const committed = await harness.postAction({
    workspaceId: WORKSPACE_ID,
    action: 'add-node',
    expectedRevision: 0,
    payload: { title: '事件之后' },
  })
  assert.equal(committed.response.status, 200)
  assert.deepEqual(await readFrame(), { revision: 1 })

  controller.abort()
})

test('events returns 404 for an unknown workspace', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.close())

  const response = await fetch(`${harness.base}${API_PREFIX}/events?workspaceId=ws_nope`, {
    headers: originHeaders(harness.base),
  })
  assert.equal(response.status, 404)
  assertErrorBody(await response.json())
})

test('the combined disposer unregisters every route', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.close())

  const before = await fetch(`${harness.base}${API_PREFIX}/ping`, {
    headers: originHeaders(harness.base),
  })
  assert.equal(before.status, 200)

  harness.dispose()
  const after = await fetch(`${harness.base}${API_PREFIX}/ping`, {
    headers: originHeaders(harness.base),
  })
  assert.equal(after.status, 404)
  assert.equal(harness.routes.size, 0)
})

test('snapshotFor degrades to empty session facts when the gateway is missing', async (t) => {
  const fixture = await createFixture({
    graph: (root) => chainGraph(root, 2),
  })
  t.after(() => fixture.close())

  const snapshot = await snapshotFor(fixture.ctx, fixture.store, fixture.workspace)
  assert.deepEqual(snapshot.sessions, { byId: {}, archived: [], warnings: [] })
  assert.ok(snapshot.notes.some((note) => note.includes('会话')))
  assert.deepEqual(snapshot.derived.ready, ['n_bbbb2222'])
  assert.equal('milestoneDone' in snapshot.derived.progress, false)
})

// ---------------------------------------------------------------------------
// prompt section
// ---------------------------------------------------------------------------

test('the prompt section describes prerequisite conditions in exactly four lines', async (t) => {
  const fixture = await createFixture({
    graph: (root) => chainGraph(root),
    sessionIds: ['session-a', 'session-b', 'session-c', 'session-d', 'session-e'],
  })
  t.after(() => fixture.close())

  const sections = []
  const ctx = {
    ...fixture.ctx,
    systemPrompt: {
      section(config) {
        sections.push(config)
        return () => {}
      },
    },
  }
  const dispose = registerPromptSection(ctx, { store: fixture.store })
  t.after(dispose)

  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'task-dag.node')
  assert.equal(sections[0].order, PROMPT_SECTION_ORDER)
  assert.equal(typeof sections[0].text, 'function')

  const doneNode = sections[0].text({ scope: { id: 'session-a' } })
  assert.equal(doneNode, [
    '本会话挂在任务节点「确定数据模型」（状态：已完成）。',
    '前置条件：0/0 已满足。',
    '完成后解锁：实现接口。',
    '任务描述维护：用户提出新的需求、约束或完成标准时，及时调用 graph_update_node 把本节点的任务描述更新为当前完整版本（保留仍然有效的内容）。',
  ].join('\n'))
  assert.equal(doneNode.split('\n').length, 4)

  const blockedNode = sections[0].text({ scope: { sessionId: 'session-c' } })
  assert.equal(blockedNode, [
    '本会话挂在任务节点「写文档」（状态：待开始）。',
    '前置条件：0/1 已满足 - 未满足：接口完成。',
    '完成后解锁：无。',
    '任务描述维护：用户提出新的需求、约束或完成标准时，及时调用 graph_update_node 把本节点的任务描述更新为当前完整版本（保留仍然有效的内容）。',
  ].join('\n'))

  const failedNode = sections[0].text({ scope: { id: 'session-d' } })
  assert.equal(failedNode, [
    '本会话挂在任务节点「失败任务」（状态：已失败）。',
    '前置条件：0/0 已满足。',
    '完成后解锁：无。',
    '任务描述维护：用户提出新的需求、约束或完成标准时，及时调用 graph_update_node 把本节点的任务描述更新为当前完整版本（保留仍然有效的内容）。',
  ].join('\n'))

  const plannedNode = sections[0].text({ scope: { id: 'session-e' } })
  assert.match(plannedNode, /状态：待规划/)

  assert.equal(sections[0].text({ scope: { id: 'session-unknown' } }), '')
  assert.equal(sections[0].text({}), '')
  assert.equal(sections[0].text(undefined), '')
  assert.equal(sections[0].text({ scope: { id: 'session-a' }, agent: { id: 'x' } }).split('\n').length, 4)
})

test('the prompt section resolves the scope defensively', async (t) => {
  const fixture = await createFixture({
    graph: (root) => chainGraph(root),
    sessionIds: ['session-a'],
  })
  t.after(() => fixture.close())

  assert.deepEqual(scopeSessionCandidates({ scope: 'session-a' }), ['session-a'])
  assert.deepEqual(scopeSessionCandidates({ scope: { id: 'session-a' } }), ['session-a'])
  assert.deepEqual(scopeSessionCandidates({ scope: { sessionId: 'session-b' }, agent: { id: 'agent-1' } }), [
    'session-b',
    'agent-1',
  ])
  assert.deepEqual(scopeSessionCandidates(null), [])
  assert.deepEqual(scopeSessionCandidates({}), [])

  assert.match(renderNodeSection(fixture.ctx, fixture.store, 'session-a'), /确定数据模型/)
  assert.equal(renderNodeSection(fixture.ctx, fixture.store, 'session-nope'), '')
  assert.equal(renderNodeSection(fixture.ctx, fixture.store, ''), '')
})

// ---------------------------------------------------------------------------
// agent tools
// ---------------------------------------------------------------------------

function toolContext(fixture, sessionIds) {
  const definitions = new Map()
  const ctx = {
    ...fixture.ctx,
    workspaceRegistry: {
      list: () => [{
        id: WORKSPACE_ID,
        path: fixture.root,
        title: '测试项目',
        sessionIds,
      }],
    },
    tools: {
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
  }
  return { ctx, definitions }
}

test('registerTools registers seven compiled-schema definitions and disposes them', async (t) => {
  const fixture = await createFixture({ graph: (root) => chainGraph(root) })
  t.after(() => fixture.close())

  assert.deepEqual(TOOL_NAMES.slice().sort(), [
    'graph_add_condition',
    'graph_add_node',
    'graph_attach_session',
    'graph_link',
    'graph_map',
    'graph_next',
    'graph_update_node',
  ])

  const { ctx, definitions } = toolContext(fixture, ['s1'])
  const dispose = registerTools(ctx, { store: fixture.store })
  t.after(dispose)

  assert.deepEqual([...definitions.keys()].sort(), [...TOOL_NAMES].sort())
  for (const definition of definitions.values()) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 0)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.parameters.properties, 'object')
    assert.ok(Array.isArray(definition.parameters.required))
    assert.equal(definition.output.schema.type, 'object')
    assert.equal(typeof definition.output.render, 'function')
    const rendered = definition.output.render({}, {})
    assert.equal(Array.isArray(rendered), true)
    assert.equal(rendered[0].type, 'text')
    assert.equal(typeof rendered[0].text, 'string')
    assert.equal(typeof definition.execute, 'function')
  }

  dispose()
  assert.equal(definitions.size, 0)
})

test('graph_map exposes conditions, execution settings and the milestone', async (t) => {
  const fixture = await createFixture({
    graph: (root) => chainGraph(root),
    sessionIds: ['s1'],
  })
  t.after(() => fixture.close())

  const { ctx, definitions } = toolContext(fixture, ['s1'])
  registerTools(ctx, { store: fixture.store })
  const exec = { agent: { id: 's1' } }

  const mapTool = definitions.get('graph_map')
  const map = await mapTool.execute({}, exec)
  assertSchema(map, mapTool.output.schema)

  assert.equal(map.workspace.workspaceId, WORKSPACE_ID)
  assert.equal(map.revision, 3)
  assert.equal(map.nodes.length, 5)
  const interfaceNode = map.nodes.find((node) => node.id === 'n_bbbb2222')
  assert.deepEqual(interfaceNode.conditions, [{
    id: 'c_bbbb0001',
    title: '需求评审通过',
    satisfied: true,
    linked: [{ id: 'n_aaaa1111', title: '确定数据模型', status: 'done' }],
  }])
  assert.equal(interfaceNode.agentPreset, 'preset-coder')
  assert.equal(interfaceNode.model, 'deepseek/deepseek-chat')
  assert.deepEqual(interfaceNode.schedule, {
    enabled: true,
    cron: '0 9 * * 1-5',
    nextRunAt: '2026-10-29T01:00:00.000Z',
    lastResult: null,
    lastError: null,
  })

  assert.deepEqual(map.ready, [{ id: 'n_bbbb2222', title: '实现接口' }])
  assert.deepEqual(map.blocked, [{
    id: 'n_cccc3333',
    title: '写文档',
    waitingFor: ['接口完成'],
  }])
  assert.deepEqual(map.failed, [{ id: 'n_dddd4444', title: '失败任务' }])
  assert.deepEqual(map.planned, [{ id: 'n_eeee5555', title: '待规划任务' }])
  assert.deepEqual(map.milestone, {
    id: 'n_cccc3333',
    title: '写文档',
    status: 'todo',
    done: false,
  })

  const mapText = mapTool.output.render({}, map)[0].text
  assert.match(mapText, /前置条件：需求评审通过（已满足）/)
  assert.match(mapText, /等待前置条件：写文档（等 接口完成）/)
  assert.match(mapText, /已失败：失败任务/)
  assert.match(mapText, /待规划：待规划任务/)
  assert.match(mapText, /里程碑：写文档/)

  const nextTool = definitions.get('graph_next')
  const next = await nextTool.execute({}, exec)
  assertSchema(next, nextTool.output.schema)
  assert.equal(next.node.id, 'n_bbbb2222')
  assert.deepEqual(next.node.unlocks, [{ id: 'n_cccc3333', title: '写文档', status: 'todo' }])
  assert.match(nextTool.output.render({}, next)[0].text, /建议下一个任务：实现接口/)
})

test('graph_add_node supports conditions, presets and models; graph_add_condition adds one', async (t) => {
  const fixture = await createFixture({
    graph: (root) => chainGraph(root),
    sessionIds: ['s1'],
  })
  t.after(() => fixture.close())

  const { ctx, definitions } = toolContext(fixture, ['s1'])
  registerTools(ctx, { store: fixture.store })
  const exec = { agent: { id: 's1' } }

  const addTool = definitions.get('graph_add_node')
  const added = await addTool.execute({
    title: '联调',
    after: ['n_aaaa1111'],
    conditions: [{ title: '设计稿' }, { title: '测试就绪', after: ['n_bbbb2222'] }],
    agentPreset: 'preset-writer',
    model: 'deepseek/deepseek-chat',
  }, exec)
  assertSchema(added, addTool.output.schema)
  assert.ok(added.nodeId.startsWith('n_'))
  assert.equal(added.node.title, '联调')

  const stored = fixture.store.read(fixture.workspace).graph
  const node = stored.nodes.find((item) => item.id === added.nodeId)
  assert.deepEqual(node.conditions.map((condition) => condition.title), [
    '设计稿',
    '测试就绪',
    '确定数据模型 完成',
  ])
  assert.equal(node.agentPreset, 'preset-writer')
  assert.equal(node.model, 'deepseek/deepseek-chat')
  const sources = stored.edges.filter((edge) => edge.to === added.nodeId).map((edge) => edge.from)
  assert.deepEqual(expectSort(sources), expectSort(['n_aaaa1111', 'n_bbbb2222']))

  const conditionTool = definitions.get('graph_add_condition')
  const condition = await conditionTool.execute({ nodeId: added.nodeId, title: '上线审批' }, exec)
  assertSchema(condition, conditionTool.output.schema)
  assert.equal(condition.nodeTitle, '联调')
  assert.equal(condition.condition.title, '上线审批')
  assert.ok(condition.conditionId.startsWith('c_'))
  assert.match(conditionTool.output.render({}, condition)[0].text, /上线审批/)
})

test('graph_link can choose or create a condition', async (t) => {
  const fixture = await createFixture({
    graph: (root) => chainGraph(root),
    sessionIds: ['s1'],
  })
  t.after(() => fixture.close())

  const { ctx, definitions } = toolContext(fixture, ['s1'])
  registerTools(ctx, { store: fixture.store })
  const exec = { agent: { id: 's1' } }

  const linkTool = definitions.get('graph_link')
  const created = await linkTool.execute({
    from: 'n_aaaa1111',
    to: 'n_eeee5555',
    conditionTitle: '需求评审通过',
  }, exec)
  assertSchema(created, linkTool.output.schema)
  assert.equal(created.conditionTitle, '需求评审通过')
  assert.ok(created.conditionId.startsWith('c_'))
  assert.match(linkTool.output.render({}, created)[0].text, /需求评审通过/)

  const stored = fixture.store.read(fixture.workspace).graph
  const planned = stored.nodes.find((node) => node.id === 'n_eeee5555')
  assert.equal(planned.conditions[0].title, '需求评审通过')
  const edge = stored.edges.find((item) => item.id === created.edgeId)
  assert.equal(edge.from, 'n_aaaa1111')
  assert.equal(edge.to, 'n_eeee5555')
  assert.equal(edge.conditionId, created.conditionId)

  // Picking an existing condition by id is also supported.
  const existing = await linkTool.execute({
    from: 'n_bbbb2222',
    to: 'n_eeee5555',
    conditionId: created.conditionId,
  }, exec)
  assert.equal(existing.conditionId, created.conditionId)
})

test('graph_update_node covers five states, execution settings and detachSuccessors', async (t) => {
  const fixture = await createFixture({
    graph: (root) => chainGraph(root),
    sessionIds: ['s1'],
  })
  t.after(() => fixture.close())

  const { ctx, definitions } = toolContext(fixture, ['s1'])
  registerTools(ctx, { store: fixture.store })
  const exec = { agent: { id: 's1' } }
  const updateTool = definitions.get('graph_update_node')

  const cleared = await updateTool.execute({
    nodeId: 'n_bbbb2222',
    agentPreset: '',
    model: '',
    status: 'planned',
  }, exec)
  assertSchema(cleared, updateTool.output.schema)
  assert.equal(cleared.node.status, 'planned')
  assert.equal(cleared.node.agentPreset, null)
  assert.equal(cleared.node.model, null)

  await assert.rejects(
    () => updateTool.execute({ nodeId: 'n_aaaa1111', status: 'failed' }, exec),
    (error) => error.code === 'invalid-request' && /后继|出边|依赖/.test(error.message),
  )

  const failed = await updateTool.execute({
    nodeId: 'n_aaaa1111',
    status: 'failed',
    detachSuccessors: true,
  }, exec)
  assertSchema(failed, updateTool.output.schema)
  assert.equal(failed.node.status, 'failed')
  assert.equal(typeof failed.node.failedAt, 'string')
  assert.equal(failed.node.completedAt, null)

  const stored = fixture.store.read(fixture.workspace).graph
  assert.ok(!stored.edges.some((edge) => edge.from === 'n_aaaa1111'))
  assert.equal(stored.nodes.find((node) => node.id === 'n_aaaa1111').failedAt !== null, true)
})

test('graph_attach_session attaches the current session once', async (t) => {
  const fixture = await createFixture({
    graph: (root) => simpleGraph(root),
    sessionIds: ['s1', 's-attach'],
  })
  t.after(() => fixture.close())

  const { ctx, definitions } = toolContext(fixture, ['s1', 's-attach'])
  registerTools(ctx, { store: fixture.store })

  const attachTool = definitions.get('graph_attach_session')
  const attached = await attachTool.execute(
    { nodeId: 'n_bbbb2222' },
    { agent: { id: 's-attach' } },
  )
  assertSchema(attached, attachTool.output.schema)
  assert.equal(attached.attached, true)
  assert.equal(attached.slot, 1)
  assert.equal(attached.node.id, 'n_bbbb2222')
})

test('graph_attach_session refuses when the node already has another active session', async (t) => {
  const fixture = await createFixture({
    graph: (root) => chainGraph(root),
    sessionIds: ['session-b', 's1'],
  })
  t.after(() => fixture.close())

  const { ctx, definitions } = toolContext(fixture, ['session-b', 's1'])
  registerTools(ctx, { store: fixture.store })

  const attach = definitions.get('graph_attach_session')
  await assert.rejects(
    () => attach.execute({ nodeId: 'n_bbbb2222' }, { agent: { id: 's1' } }),
    (error) => {
      assert.equal(error.name, 'TaskDagError')
      assert.equal(error.code, 'session-claimed')
      assert.match(error.message, /交接/)
      return true
    },
  )

  // The node id is validated before anything else.
  await assert.rejects(
    () => attach.execute({ nodeId: 'n_missing' }, { agent: { id: 's1' } }),
    (error) => error.code === 'not-found',
  )
})

test('every tool output matches its compiled schema', async (t) => {
  const fixture = await createFixture({
    graph: (root) => simpleGraph(root),
    sessionIds: ['s1', 's-attach'],
  })
  t.after(() => fixture.close())

  const { ctx, definitions } = toolContext(fixture, ['s1', 's-attach'])
  registerTools(ctx, { store: fixture.store })

  const calls = [
    ['graph_map', {}, 's1'],
    ['graph_next', {}, 's1'],
    ['graph_add_node', { title: '新任务', conditions: [{ title: '条件一' }, { title: '条件二', after: ['n_aaaa1111'] }] }, 's1'],
    ['graph_link', { from: 'n_aaaa1111', to: 'n_bbbb2222', conditionTitle: '需求评审' }, 's1'],
    ['graph_update_node', { nodeId: 'n_bbbb2222', status: 'doing' }, 's1'],
    ['graph_add_condition', { nodeId: 'n_bbbb2222', title: '额外条件' }, 's1'],
    ['graph_attach_session', { nodeId: 'n_bbbb2222' }, 's-attach'],
  ]

  for (const [name, args, sessionId] of calls) {
    const definition = definitions.get(name)
    assert.ok(definition !== undefined, `缺少工具 ${name}`)
    const value = await definition.execute(args, { agent: { id: sessionId } })
    assertSchema(value, definition.output.schema, name)
  }
})

test('graph tools validate their arguments with readable Chinese messages', async (t) => {
  const fixture = await createFixture({
    graph: (root) => chainGraph(root),
    sessionIds: ['s1'],
  })
  t.after(() => fixture.close())

  const { ctx, definitions } = toolContext(fixture, ['s1'])
  registerTools(ctx, { store: fixture.store })
  const exec = { agent: { id: 's1' } }

  await assert.rejects(
    () => definitions.get('graph_add_node').execute({}, exec),
    (error) => error.code === 'invalid-request' && /标题/.test(error.message),
  )
  await assert.rejects(
    () => definitions.get('graph_add_node').execute({ title: 'x', conditions: 'nope' }, exec),
    (error) => error.code === 'invalid-request' && /conditions/.test(error.message),
  )
  await assert.rejects(
    () => definitions.get('graph_add_node').execute({ title: 'x', conditions: [{}] }, exec),
    (error) => error.code === 'invalid-request' && /条件标题/.test(error.message),
  )
  await assert.rejects(
    () => definitions.get('graph_update_node').execute({ nodeId: 'n_bbbb2222' }, exec),
    (error) => error.code === 'invalid-request',
  )
  await assert.rejects(
    () => definitions.get('graph_update_node').execute({ nodeId: 'n_bbbb2222', status: 'nope' }, exec),
    (error) => error.code === 'invalid-request' && /status/.test(error.message),
  )
  await assert.rejects(
    () => definitions.get('graph_link').execute({ from: 'n_aaaa1111' }, exec),
    (error) => error.code === 'invalid-request',
  )
  await assert.rejects(
    () => definitions.get('graph_add_condition').execute({ nodeId: 'n_bbbb2222' }, exec),
    (error) => error.code === 'invalid-request' && /条件/.test(error.message),
  )
  await assert.rejects(
    () => definitions.get('graph_attach_session').execute({ nodeId: 'n_bbbb2222' }, {}),
    (error) => error.code === 'invalid-request' && /会话/.test(error.message),
  )
})

test('graph_add_node commits through the same action layer as the HTTP route', async (t) => {
  const fixture = await createFixture({
    graph: (root) => graphDocument(root, { revision: 0 }),
    sessionIds: ['s1'],
  })
  t.after(() => fixture.close())

  const { ctx, definitions } = toolContext(fixture, ['s1'])
  registerTools(ctx, { store: fixture.store })

  const added = await definitions.get('graph_add_node')
    .execute({ title: '由工具新建' }, { agent: { id: 's1' } })
  assert.ok(added.nodeId.startsWith('n_'))
  assert.equal(added.node.title, '由工具新建')
  assert.equal(added.graph.revision, 1)
  assert.equal(added.graph.total, 1)
  assert.equal(added.graph.progress.total, 1)

  const stored = fixture.store.read(fixture.workspace)
  assert.equal(stored.graph.revision, 1)
  assert.equal(stored.graph.nodes.length, 1)
  assert.equal(stored.graph.nodes[0].id, added.nodeId)
})

test('pickNextNode prefers the ready node that unlocks the most followers', () => {
  const graph = graphDocument('C:/tmp/dag', {
    nodes: [
      makeNode('n_11111111', '独立任务'),
      makeNode('n_22222222', '关键任务'),
      makeNode('n_33333333', '后续任务', 'todo', {
        conditions: [makeCondition('c_33330000', '关键任务 完成')],
      }),
      makeNode('n_44444444', '待规划任务', 'planned'),
    ],
    edges: [makeEdge('e_aaaaaaaa', 'n_22222222', 'n_33333333', 'c_33330000')],
    milestoneNodeId: 'n_33333333',
  })
  const derived = derive(graph)
  assert.deepEqual(derived.ready, ['n_11111111', 'n_22222222'])
  assert.equal(pickNextNode(graph, derived).id, 'n_22222222')

  const map = buildGraphMap({ workspaceId: 'ws', path: 'C:/tmp/dag', title: 'x' }, graph, derived)
  assert.equal(map.progress.total, 4)
  assert.equal(map.progress.ready, 2)
  assert.equal(map.progress.blocked, 1)
  assert.equal(map.progress.planned, 1)
  assert.deepEqual(map.milestone, {
    id: 'n_33333333',
    title: '后续任务',
    status: 'todo',
    done: false,
  })
})

test('a blocked node waits on unsatisfied condition titles, not node titles', () => {
  const graph = graphDocument('C:/tmp/dag', {
    nodes: [
      makeNode('n_aaaa0001', '上游', 'todo'),
      makeNode('n_bbbb0002', '下游', 'todo', {
        conditions: [makeCondition('c_0001', '第一条件'), makeCondition('c_0002', '第二条件')],
      }),
    ],
    edges: [makeEdge('e_0001', 'n_aaaa0001', 'n_bbbb0002', 'c_0001')],
  })
  const derived = derive(graph)
  const map = buildGraphMap({ workspaceId: 'ws', path: 'C:/tmp/dag', title: 'x' }, graph, derived)
  assert.deepEqual(map.blocked, [{
    id: 'n_bbbb0002',
    title: '下游',
    waitingFor: ['第一条件', '第二条件'],
  }])
})

test('an unexpected failure reports its reason instead of an opaque 500', async (t) => {
  // A raw (non-TaskDagError) failure must still tell the clicking user what broke;
  // the route is loopback-guarded, so surfacing the message is safe.
  const brokenStore = {
    read() { throw new TypeError('boom-from-store') },
    commit() { throw new TypeError('boom-from-store') },
    subscribe() { return () => {} },
  }
  const harness = await createHarness({ store: brokenStore })
  t.after(() => harness.close())

  const { response, body } = await harness.getJson(`${API_PREFIX}/state?workspaceId=${WORKSPACE_ID}`)
  assert.equal(response.status, 500)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'internal')
  assert.match(body.message, /boom-from-store/)
})

function expectSort(list) {
  return [...list].sort()
}
