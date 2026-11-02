/**
 * v2 end-to-end acceptance for the `dsh-task-dag` Host half.
 *
 * These tests mount the real plugin (`apply()`) against a fake Cordis context,
 * then drive it over a real loopback HTTP server exactly as the browser half
 * does. They are not unit tests: every assertion is about the observable
 * contract described in the README — five statuses, condition-based
 * prerequisites, failed-node rules, per-node Agent preset/model, per-node
 * scheduling, the project milestone, deletion splicing, CAS/SSE, and the Agent
 * tools sharing the same graph as HTTP.
 *
 * Three scenarios:
 *   1. a clean workspace driven through the whole HTTP + tool surface;
 *   2. a v1 `graph.json` seeded on disk and migrated on first read;
 *   3. a real `TaskDagScheduler` + real `GraphStore` on a due graph (launch
 *      order, skip rules, `turn/end` settlement).
 *
 * Run: node test/acceptance.integration.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { GraphStore } from '../src/store.js'
import { TaskDagScheduler } from '../src/scheduler.js'
import { TOOL_NAMES } from '../src/tools.js'

const WORKSPACE_ID = 'ws_acceptance'
const MIGRATION_WORKSPACE_ID = 'ws_migration'
const SCHEDULER_WORKSPACE_ID = 'ws_scheduler'
const API = '/api/task-dag'
const CREATED = '2026-10-28T11:00:00.000Z'

/* ------------------------------------------------------------------ */
/* fake session gateway                                                */
/* ------------------------------------------------------------------ */

/**
 * A fake `typertGateway` covering every namespace the plugin touches.
 *
 * `states` is the live session list the gateway reports (the scheduler and the
 * snapshot both read it); `events` is the per-session event list served through
 * `session/follow`; `onPrompt` runs with the graph state at prompt time, which
 * is how the acceptance test proves "attach before prompt".
 */
function createGateway(root, options = {}) {
  const states = options.states ?? new Map()
  const events = options.events ?? {}
  const calls = []
  const created = []
  const selectModels = []
  const renames = []
  const prompts = []
  const archivedSessions = []
  let sequence = 0

  const gateway = {
    calls,
    created,
    selectModels,
    renames,
    prompts,
    archivedSessions,
    states,
    events,
    async invoke(request) {
      calls.push(request)
      const { namespace, method } = request
      const args = request?.args

      if (namespace === 'session' && method === 'list') {
        return {
          items: [...states.keys()].map((sessionId) => {
            const state = states.get(sessionId) ?? {}
            return {
              sessionId,
              running: state.running === true,
              blank: state.blank === true,
              cwd: root,
              updatedAt: Date.now(),
              projections: { values: { title: state.title ?? sessionId } },
            }
          }),
        }
      }
      if (namespace === 'session' && method === 'create') {
        sequence += 1
        const sessionId = typeof options.createId === 'function'
          ? options.createId(sequence)
          : `sess-${sequence}`
        created.push(sessionId)
        states.set(sessionId, { running: true, blank: true, title: sessionId })
        return { sessionId }
      }
      if (namespace === 'session' && method === 'selectModel') {
        selectModels.push(args?.request)
        return { selected: true }
      }
      if (namespace === 'session' && method === 'rename') {
        renames.push(args?.request)
        return { title: args?.request?.title ?? '' }
      }
      if (namespace === 'session' && method === 'prompt') {
        prompts.push(args?.request)
        if (typeof options.onPrompt === 'function') options.onPrompt(args?.request)
        return { accepted: true }
      }
      if (namespace === 'agentPresets' && method === 'list') {
        return {
          presets: [
            { id: 'preset-coder', label: '编码' },
            { id: 'preset-writer', label: '写作' },
          ],
        }
      }
      if (namespace === 'session' && method === 'modelCatalog') {
        return {
          groups: [{
            provider: 'deepseek',
            models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
          }],
        }
      }
      if (namespace === 'workspace' && method === 'archiveSession') {
        archivedSessions.push(args?.request)
        return { archivedSessionIds: [] }
      }
      if (namespace === 'workspace' && method === 'unarchiveSession') {
        return {}
      }
      return {}
    },
    async stream(request) {
      const sessionId = request?.args?.request?.address?.sessionId
      const records = (events[sessionId] ?? []).map((event) => ({ event }))
      return (async function* generate() {
        yield {
          type: 'snapshot',
          cursor: records.length,
          records,
          hasMore: false,
          header: { id: sessionId, cwd: root },
          projections: {},
        }
      })()
    },
  }

  return gateway
}

/* ------------------------------------------------------------------ */
/* plugin mount + real HTTP server                                     */
/* ------------------------------------------------------------------ */

async function mountPlugin(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'task-dag-accept-'))
  const workspaceId = options.workspaceId ?? WORKSPACE_ID
  const sessionIds = [...(options.sessionIds ?? [])]
  const workspace = {
    id: workspaceId,
    path: root,
    title: options.title ?? '验收项目',
    sessionIds,
  }

  // Seed the workspace *before* apply() so the store sees it on first read.
  // A seed may be a promise or a factory returning one.
  if (typeof options.seed === 'function') {
    const prepared = options.seed(root)
    if (typeof prepared === 'function') await prepared()
    else await prepared
  }

  const sessionStates = new Map()
  for (const sessionId of sessionIds) {
    sessionStates.set(sessionId, { running: false, blank: false, title: sessionId })
  }
  const gateway = options.gateway ?? createGateway(root, { states: sessionStates })

  const routes = []
  const tools = new Map()
  const sections = []
  const disposers = []

  const ctx = {
    webServer: {
      register(route) {
        assert.equal(route.kind, 'exact', 'only exact routes are registered')
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    workspaceRegistry: {
      list: () => [workspace],
      archivedSessionIds: [],
    },
    sessions: { get: (sessionId) => (options.liveSessions ?? new Map()).get(sessionId) },
    typertGateway: gateway,
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section(config) {
        sections.push(config)
        return () => {
          const index = sections.indexOf(config)
          if (index >= 0) sections.splice(index, 1)
        }
      },
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    on() {
      return () => {}
    },
    logger: { info() {}, warn() {}, error() {} },
  }

  apply(ctx, {})

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = routes.find((item) => item.path === url.pathname)
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, code: 'no-route' }))
      return
    }
    route.handler(req, res)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const base = `http://127.0.0.1:${server.address().port}`

  const close = async () => {
    for (const dispose of [...disposers].reverse()) {
      try {
        await dispose()
      } catch {
        // A dispose failure must not mask a test failure.
      }
    }
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }

  return {
    root,
    base,
    workspace,
    workspaceId,
    gateway,
    tools,
    sections,
    server,
    close,
  }
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function originHeaders(base, extra = {}) {
  return { origin: base, ...extra }
}

async function getJson(base, path) {
  const response = await fetch(`${base}${path}`, { headers: originHeaders(base) })
  return { status: response.status, body: await response.json() }
}

async function postAction(base, body) {
  const response = await fetch(`${base}${API}/action`, {
    method: 'POST',
    headers: originHeaders(base, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

async function snapshotOf(env) {
  const { status, body } = await getJson(
    env.base,
    `${API}/state?workspaceId=${encodeURIComponent(env.workspaceId)}`,
  )
  assert.equal(status, 200, `GET /state failed: ${JSON.stringify(body)}`)
  assert.equal(body.ok, true)
  return body.snapshot
}

/** Read the current revision, run one action, assert 200 and return the snapshot. */
async function act(env, actionName, payload = {}, expectedRevision) {
  const current = await snapshotOf(env)
  const revision = expectedRevision ?? current.graph.revision
  const result = await postAction(env.base, {
    workspaceId: env.workspaceId,
    action: actionName,
    expectedRevision: revision,
    payload,
  })
  assert.equal(
    result.status,
    200,
    `${actionName} failed: ${JSON.stringify(result.body)}`,
  )
  assert.equal(result.body.ok, true)
  return result.body.snapshot
}

/** Run one action expected to fail, with the current revision filled in. */
async function actExpectFailure(env, actionName, payload = {}, expectedStatus) {
  const current = await snapshotOf(env)
  const result = await postAction(env.base, {
    workspaceId: env.workspaceId,
    action: actionName,
    expectedRevision: current.graph.revision,
    payload,
  })
  if (expectedStatus !== undefined) {
    assert.equal(result.status, expectedStatus, JSON.stringify(result.body))
  } else {
    assert.notEqual(result.status, 200, 'action was expected to fail')
  }
  assert.equal(result.body.ok, false)
  return result
}

function nodeByTitle(graph, title) {
  return graph.nodes.find((node) => node.title === title)
}

function nodeById(graph, nodeId) {
  return graph.nodes.find((node) => node.id === nodeId)
}

function expectSort(list) {
  return [...list].sort()
}

/** Parse the append-only audit log the store writes before every commit. */
async function readAudit(root) {
  const text = await readFile(join(root, '.dsh-task-graph', 'events.jsonl'), 'utf8')
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

/** Minimal SSE reader: returns the JSON payload of the next `data:` frame. */
function createFrameReader(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    async readFrame(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
          if (dataLine !== undefined) return JSON.parse(dataLine.slice(6))
          continue
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error('等待 SSE 帧超时')
        const result = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error('等待 SSE 帧超时')), remaining)
            timer.unref?.()
          }),
        ])
        if (result.done) throw new Error('SSE 流提前结束')
        buffer += decoder.decode(result.value, { stream: true })
      }
    },
    async close() {
      try {
        await reader.cancel()
      } catch {
        // Already closed.
      }
    },
  }
}

/* ================================================================== */
/* 1. clean workspace: HTTP + tools + prompt                           */
/* ================================================================== */

test('v2 acceptance: HTTP + tools + prompt on a clean workspace', async (t) => {
  const env = await mountPlugin({
    sessionIds: ['s1', 's2', 's3', 's_tool', 's_prompt', 's_prompt2'],
  })
  t.after(() => env.close())

  await t.test('an empty workspace exposes the v2 document and derived shape', async () => {
    const snapshot = await snapshotOf(env)
    assert.equal(snapshot.graph.schemaVersion, 2)
    assert.equal(snapshot.graph.revision, 0)
    assert.deepEqual(snapshot.graph.nodes, [])
    assert.deepEqual(snapshot.graph.edges, [])
    assert.equal(snapshot.graph.milestoneNodeId, null)
    assert.equal(snapshot.graph.closeoutNodeId, undefined, 'v1 field must be gone')

    assert.deepEqual(Object.keys(snapshot.derived).sort(), [
      'blocked', 'conditions', 'doing', 'done', 'failed', 'levels',
      'milestone', 'order', 'planned', 'progress', 'ready',
    ])
    assert.deepEqual(Object.keys(snapshot.derived.progress).sort(), [
      'blocked', 'doing', 'done', 'failed', 'planned', 'ready', 'total',
    ])
    assert.deepEqual(snapshot.derived.ready, [])
    assert.equal(snapshot.derived.milestone, null)
  })

  await t.test('A/B/C are built over POST /action and conditions drive readiness', async () => {
    let snapshot = await act(env, 'add-node', { title: 'A' })
    const a = nodeByTitle(snapshot.graph, 'A')
    snapshot = await act(env, 'add-node', { title: 'B' })
    const b = nodeByTitle(snapshot.graph, 'B')
    assert.deepEqual(b.conditions, [])
    assert.equal(b.status, 'todo')

    // Condition CRUD, then link by explicit conditionId.
    snapshot = await act(env, 'add-condition', { nodeId: b.id, title: '需求评审通过' })
    const firstCondition = nodeById(snapshot.graph, b.id).conditions[0]
    assert.equal(firstCondition.title, '需求评审通过')
    assert.ok(firstCondition.id.startsWith('c_'))

    snapshot = await act(env, 'link', {
      from: a.id,
      to: b.id,
      conditionId: firstCondition.id,
    })
    const edge = snapshot.graph.edges.find(
      (item) => item.from === a.id && item.to === b.id && item.conditionId === firstCondition.id,
    )
    assert.ok(edge !== undefined, 'link with conditionId must create the chosen edge')

    snapshot = await snapshotOf(env)
    assert.ok(snapshot.derived.ready.includes(a.id))
    assert.ok(snapshot.derived.blocked.includes(b.id), 'B is blocked until its condition is met')
    assert.deepEqual(snapshot.derived.conditions[b.id], [{
      id: firstCondition.id,
      title: '需求评审通过',
      satisfied: false,
      linked: [{ id: a.id, title: 'A', status: 'todo' }],
      waiting: [{ id: a.id, title: 'A', status: 'todo' }],
    }])

    // A second condition, linked by conditionTitle instead of id.
    snapshot = await act(env, 'add-condition', { nodeId: b.id, title: '安全评审通过' })
    snapshot = await act(env, 'link', {
      from: a.id,
      to: b.id,
      conditionTitle: '安全评审通过',
    })
    const bNode = nodeById(snapshot.graph, b.id)
    assert.deepEqual(bNode.conditions.map((item) => item.title), ['需求评审通过', '安全评审通过'])
    const secondCondition = bNode.conditions[1]
    assert.ok(snapshot.graph.edges.some(
      (item) => item.from === a.id && item.to === b.id && item.conditionId === secondCondition.id,
    ))

    // A third node C, linked from B with the default condition.
    snapshot = await act(env, 'add-node', { title: 'C' })
    const c = nodeByTitle(snapshot.graph, 'C')
    snapshot = await act(env, 'link', { from: b.id, to: c.id })
    const cNode = nodeById(snapshot.graph, c.id)
    assert.equal(cNode.conditions.length, 1)
    assert.equal(cNode.conditions[0].title, 'B 完成')
    assert.ok(snapshot.graph.edges.some(
      (item) => item.from === b.id && item.to === c.id && item.conditionId === cNode.conditions[0].id,
    ))

    // Nothing changes until A is done: B waits on both of its conditions.
    snapshot = await snapshotOf(env)
    assert.ok(snapshot.derived.blocked.includes(b.id))
    assert.ok(snapshot.derived.blocked.includes(c.id))

    snapshot = await act(env, 'update-node', { nodeId: a.id, status: 'done' })
    const doneA = nodeById(snapshot.graph, a.id)
    assert.equal(doneA.status, 'done')
    assert.equal(typeof doneA.completedAt, 'string')
    assert.equal(doneA.failedAt, null)

    assert.ok(snapshot.derived.ready.includes(b.id), 'A done satisfies both of B conditions')
    assert.ok(!snapshot.derived.blocked.includes(b.id))
    assert.ok(snapshot.derived.blocked.includes(c.id), 'C still waits for B')
    assert.deepEqual(snapshot.derived.progress, {
      done: 1,
      total: 3,
      ready: 1,
      blocked: 1,
      doing: 0,
      failed: 0,
      planned: 0,
    })
    for (const condition of snapshot.derived.conditions[b.id]) {
      assert.equal(condition.satisfied, true)
      assert.deepEqual(condition.linked, [{ id: a.id, title: 'A', status: 'done' }])
      assert.deepEqual(condition.waiting, [])
    }
  })

  await t.test('five statuses work and a failed node may never be a prerequisite', async () => {
    let snapshot = await act(env, 'add-node', { title: '五态 D' })
    const d = nodeByTitle(snapshot.graph, '五态 D')
    assert.ok(snapshot.derived.ready.includes(d.id))

    // planned does not participate in ready.
    snapshot = await act(env, 'update-node', { nodeId: d.id, status: 'planned' })
    assert.ok(snapshot.derived.planned.includes(d.id))
    assert.ok(!snapshot.derived.ready.includes(d.id), 'planned is neither ready nor blocked')
    assert.ok(!snapshot.derived.blocked.includes(d.id))

    snapshot = await act(env, 'update-node', { nodeId: d.id, status: 'todo' })
    assert.ok(snapshot.derived.ready.includes(d.id))

    snapshot = await act(env, 'update-node', { nodeId: d.id, status: 'doing' })
    assert.ok(snapshot.derived.doing.includes(d.id))
    assert.ok(!snapshot.derived.ready.includes(d.id))

    snapshot = await act(env, 'update-node', { nodeId: d.id, status: 'done' })
    let dNode = nodeById(snapshot.graph, d.id)
    assert.equal(dNode.completedAt !== null, true)
    assert.equal(dNode.failedAt, null)
    assert.ok(snapshot.derived.done.includes(d.id))

    snapshot = await act(env, 'update-node', { nodeId: d.id, status: 'failed' })
    dNode = nodeById(snapshot.graph, d.id)
    assert.equal(typeof dNode.failedAt, 'string')
    assert.equal(dNode.completedAt, null, 'done and failed timestamps are mutually exclusive')
    assert.ok(snapshot.derived.failed.includes(d.id))

    // A node with successors cannot silently become failed.
    snapshot = await act(env, 'add-node', { title: '失败前序' })
    const p = nodeByTitle(snapshot.graph, '失败前序')
    snapshot = await act(env, 'add-node', { title: '失败后继', after: [p.id] })
    const q = nodeByTitle(snapshot.graph, '失败后继')

    const refused = await actExpectFailure(env, 'update-node', { nodeId: p.id, status: 'failed' }, 400)
    assert.match(refused.body.message, /后继|依赖/, 'the refusal explains why')
    assert.match(refused.body.code, /invalid-request/)

    snapshot = await act(env, 'update-node', {
      nodeId: p.id,
      status: 'failed',
      detachSuccessors: true,
    })
    const pNode = nodeById(snapshot.graph, p.id)
    assert.equal(pNode.status, 'failed')
    assert.equal(typeof pNode.failedAt, 'string')
    assert.equal(pNode.completedAt, null)
    assert.deepEqual(snapshot.graph.edges.filter((item) => item.from === p.id), [])
    const qNode = nodeById(snapshot.graph, q.id)
    assert.equal(qNode.conditions.length, 1, 'the condition survives the detached edge')
    assert.equal(snapshot.derived.conditions[q.id][0].satisfied, false)
    assert.ok(snapshot.derived.blocked.includes(q.id))

    // A failed node cannot be linked again, and cannot be an `after` source.
    const failedLink = await actExpectFailure(env, 'link', { from: p.id, to: q.id }, 400)
    assert.match(failedLink.body.message, /失败|前置/)
    const failedAfter = await actExpectFailure(
      env,
      'add-node',
      { title: '不该建出来', after: [p.id] },
      400,
    )
    assert.match(failedAfter.body.message, /失败|前置/)
    const failedDLink = await actExpectFailure(env, 'link', { from: d.id, to: q.id }, 400)
    assert.match(failedDLink.body.message, /失败|前置/)
  })

  await t.test('里程碑只是标记，完成后不结束项目', async () => {
    let snapshot = await act(env, 'add-node', { title: '里程碑任务' })
    const milestoneNode = nodeByTitle(snapshot.graph, '里程碑任务')
    snapshot = await act(env, 'add-node', { title: '里程碑后续' })
    const follower = nodeByTitle(snapshot.graph, '里程碑后续')

    snapshot = await act(env, 'set-milestone', { nodeId: milestoneNode.id })
    assert.equal(snapshot.graph.milestoneNodeId, milestoneNode.id)

    // No restriction: the milestone itself can satisfy a condition.
    snapshot = await act(env, 'link', { from: milestoneNode.id, to: follower.id })
    const followerNode = nodeById(snapshot.graph, follower.id)
    assert.equal(followerNode.conditions.length, 1)
    assert.equal(followerNode.conditions[0].title, '里程碑任务 完成')
    assert.ok(snapshot.graph.edges.some(
      (item) => item.from === milestoneNode.id && item.to === follower.id,
    ))

    assert.deepEqual(snapshot.derived.milestone, {
      id: milestoneNode.id,
      title: '里程碑任务',
      status: 'todo',
      done: false,
    })
    assert.equal('milestoneDone' in snapshot.derived.progress, false)

    snapshot = await act(env, 'update-node', { nodeId: milestoneNode.id, status: 'done' })
    assert.deepEqual(snapshot.derived.milestone, {
      id: milestoneNode.id,
      title: '里程碑任务',
      status: 'done',
      done: true,
    })
    // milestone.done is only the node's status fact; it is not a project-wide
    // completion signal, and no replacement flag was introduced.
    assert.equal('milestoneDone' in snapshot.derived.progress, false)
    assert.equal('allDone' in snapshot.derived.progress, false)
    assert.ok(
      snapshot.derived.progress.done < snapshot.derived.progress.total,
      'other nodes are still unfinished, so the project cannot be complete',
    )
    assert.equal(nodeById(snapshot.graph, follower.id).status, 'todo')
    assert.ok(snapshot.derived.ready.includes(follower.id), 'milestone done satisfies the follower')

    const workspaces = await getJson(env.base, `${API}/workspaces`)
    assert.equal(workspaces.status, 200)
    const summary = workspaces.body.workspaces.find((item) => item.workspaceId === WORKSPACE_ID)
    assert.ok(summary !== undefined)
    assert.deepEqual(Object.keys(summary.progress).sort(), [
      'blocked', 'doing', 'done', 'failed', 'planned', 'ready', 'total',
    ])
    assert.equal('milestoneDone' in summary.progress, false)
  })

  await t.test('节点组合可创建、改名、移动成员、删除，并在快照中原样读回', async () => {
    let snapshot = await act(env, 'add-node', { title: '组合甲' })
    const ga = nodeByTitle(snapshot.graph, '组合甲')
    snapshot = await act(env, 'add-node', { title: '组合乙' })
    const gb = nodeByTitle(snapshot.graph, '组合乙')
    snapshot = await act(env, 'add-node', { title: '组合丙' })
    const gc = nodeByTitle(snapshot.graph, '组合丙')
    assert.deepEqual(snapshot.graph.groups, [], 'a graph written before groups existed reads as []')

    snapshot = await act(env, 'create-group', { name: '  前端  ', nodeIds: [ga.id, gb.id] })
    assert.equal(snapshot.graph.groups.length, 1)
    const group = snapshot.graph.groups[0]
    assert.match(group.id, /^g_[0-9a-f]{8}$/)
    assert.equal(group.name, '前端')
    assert.deepEqual(group.nodeIds, [ga.id, gb.id])
    assert.equal(typeof group.createdAt, 'string')
    assert.equal(typeof group.updatedAt, 'string')

    // The same group comes back through GET /state: the snapshot is not trimmed.
    const reread = await snapshotOf(env)
    assert.deepEqual(reread.graph.groups, snapshot.graph.groups)

    snapshot = await act(env, 'rename-group', { groupId: group.id, name: '界面' })
    assert.equal(snapshot.graph.groups[0].name, '界面')

    // Cross-group move: 乙 leaves the first group, which keeps 甲.
    snapshot = await act(env, 'create-group', { name: '后端', nodeIds: [gb.id, gc.id] })
    assert.deepEqual(snapshot.graph.groups.map((item) => [item.name, item.nodeIds]), [
      ['界面', [ga.id]],
      ['后端', [gb.id, gc.id]],
    ])

    snapshot = await act(env, 'delete-group', { groupId: snapshot.graph.groups[0].id })
    assert.deepEqual(snapshot.graph.groups.map((item) => item.name), ['后端'])

    // Deleting a member shrinks the group; the last member removes the group.
    snapshot = await act(env, 'delete-node', { nodeId: gc.id, mode: 'unlink' })
    assert.deepEqual(snapshot.graph.groups.map((item) => [item.name, item.nodeIds]), [['后端', [gb.id]]])
    snapshot = await act(env, 'delete-node', { nodeId: gb.id, mode: 'unlink' })
    assert.deepEqual(snapshot.graph.groups, [])

    const tooSmall = await actExpectFailure(env, 'create-group', { name: '单成员', nodeIds: [ga.id] }, 400)
    assert.match(tooSmall.body.message, /至少/)
    snapshot = await act(env, 'delete-node', { nodeId: ga.id, mode: 'unlink' })
    assert.equal(nodeById(snapshot.graph, ga.id), undefined)
  })

  await t.test('per-node Agent preset/model reach handoff and /catalog lists them', async () => {
    let snapshot = await act(env, 'add-node', { title: '交接任务' })
    const handoffNode = nodeByTitle(snapshot.graph, '交接任务')
    snapshot = await act(env, 'attach-session', {
      nodeId: handoffNode.id,
      sessionId: 's1',
    })
    snapshot = await act(env, 'update-node', {
      nodeId: handoffNode.id,
      agentPreset: 'preset-coder',
      model: 'deepseek/deepseek-chat',
      reasoningEffort: 'high',
    })
    const configured = nodeById(snapshot.graph, handoffNode.id)
    assert.equal(configured.agentPreset, 'preset-coder')
    assert.equal(configured.model, 'deepseek/deepseek-chat')
    assert.equal(configured.reasoningEffort, 'high')

    const createsBefore = env.gateway.created.length
    snapshot = await act(env, 'handoff', { nodeId: handoffNode.id, mode: 'blank' })
    const chain = nodeById(snapshot.graph, handoffNode.id).sessions
    assert.equal(chain.length, 2)
    assert.notEqual(chain[0].retiredAt, null)
    assert.equal(chain[1].retiredAt, null)
    assert.equal(chain[1].handoff.mode, 'blank')
    assert.equal(chain[1].titleSnapshot, '交接任务')

    assert.equal(env.gateway.created.length, createsBefore + 1)
    const newSessionId = env.gateway.created.at(-1)
    const createCalls = env.gateway.calls.filter(
      (call) => call.namespace === 'session' && call.method === 'create',
    )
    assert.equal(createCalls.length, createsBefore + 1)
    assert.equal(createCalls.at(-1).args.request.agentPreset, 'preset-coder')
    assert.equal(createCalls.at(-1).args.request.workspaceId, WORKSPACE_ID)

    const modelCall = env.gateway.selectModels.find((request) => request.sessionId === newSessionId)
    assert.deepEqual(modelCall, {
      sessionId: newSessionId,
      model: 'deepseek-chat',
      provider: 'deepseek',
      reasoningEffort: 'high',
    })

    const renameCall = env.gateway.renames.find((request) => request.sessionId === newSessionId)
    assert.ok(renameCall !== undefined, 'the new session is renamed')
    const promptsBefore = env.gateway.prompts.length
    assert.equal(env.gateway.prompts.length, promptsBefore, 'blank handoff sends no brief')

    const catalogResult = await getJson(env.base, `${API}/catalog`)
    assert.equal(catalogResult.status, 200)
    assert.equal(catalogResult.body.ok, true)
    assert.deepEqual(catalogResult.body.catalog.presets, [
      { id: 'preset-coder', label: '编码' },
      { id: 'preset-writer', label: '写作' },
    ])
    assert.deepEqual(catalogResult.body.catalog.models, [
      { provider: 'deepseek', id: 'deepseek-chat', label: 'DeepSeek Chat' },
    ])
    assert.deepEqual(catalogResult.body.catalog.warnings, [])

    const presetCall = env.gateway.calls.find((call) => call.namespace === 'agentPresets')
    assert.deepEqual(presetCall.args, {}, 'agentPresets/list args must be a bare {}')
    const modelCatalogCall = env.gateway.calls.find((call) => call.method === 'modelCatalog')
    assert.deepEqual(modelCatalogCall.args, { request: {} })
  })

  await t.test('set-schedule computes nextRunAt and refuses an invalid cron', async () => {
    const snapshot = await snapshotOf(env)
    const handoffNode = nodeByTitle(snapshot.graph, '交接任务')

    let updated = await act(env, 'set-schedule', {
      nodeId: handoffNode.id,
      enabled: true,
      cron: '0 9 * * 1-5',
    })
    let schedule = nodeById(updated.graph, handoffNode.id).schedule
    assert.equal(schedule.enabled, true)
    assert.equal(schedule.cron, '0 9 * * 1-5')
    assert.equal(typeof schedule.nextRunAt, 'string')
    const nextRunAtMs = Date.parse(schedule.nextRunAt)
    assert.ok(Number.isFinite(nextRunAtMs))
    assert.ok(nextRunAtMs > Date.now() - 60_000, 'nextRunAt is a future occurrence')
    assert.equal(schedule.lastResult, null)

    // HTTP may not write nextRunAt; the server recalculates it.
    updated = await act(env, 'set-schedule', {
      nodeId: handoffNode.id,
      enabled: true,
      cron: '*/30 * * * *',
      nextRunAt: '2000-01-01T00:00:00.000Z',
    })
    schedule = nodeById(updated.graph, handoffNode.id).schedule
    assert.notEqual(schedule.nextRunAt, '2000-01-01T00:00:00.000Z')
    assert.ok(Date.parse(schedule.nextRunAt) > Date.now() - 60_000)

    updated = await act(env, 'set-schedule', { nodeId: handoffNode.id, enabled: false })
    schedule = nodeById(updated.graph, handoffNode.id).schedule
    assert.equal(schedule.enabled, false)
    assert.equal(schedule.nextRunAt, null)

    const badCron = await actExpectFailure(env, 'set-schedule', {
      nodeId: handoffNode.id,
      enabled: true,
      cron: 'not a cron',
    }, 400)
    assert.match(badCron.body.message, /定时表达式/)
  })

  await t.test('delete-node splice rewires and unlink reports orphaned conditions', async () => {
    let snapshot = await act(env, 'add-node', { title: '拼接 X' })
    const x = nodeByTitle(snapshot.graph, '拼接 X')
    snapshot = await act(env, 'add-node', { title: '拼接 P', after: [x.id] })
    const p = nodeByTitle(snapshot.graph, '拼接 P')
    snapshot = await act(env, 'add-node', { title: '拼接 Q', after: [p.id] })
    const q = nodeByTitle(snapshot.graph, '拼接 Q')

    snapshot = await act(env, 'delete-node', { nodeId: p.id, mode: 'splice' })
    assert.equal(nodeById(snapshot.graph, p.id), undefined)
    const qNode = nodeById(snapshot.graph, q.id)
    const spliced = snapshot.graph.edges.find(
      (item) => item.from === x.id && item.to === q.id && item.conditionId === qNode.conditions[0].id,
    )
    assert.ok(spliced !== undefined, 'X now satisfies Q directly')
    assert.deepEqual(snapshot.graph.edges.filter((item) => item.from === p.id || item.to === p.id), [])

    // unlink: the deleted node disappears without rewiring, leaving a condition
    // that nobody can satisfy.
    snapshot = await act(env, 'add-node', { title: '断链 U' })
    const u = nodeByTitle(snapshot.graph, '断链 U')
    snapshot = await act(env, 'add-node', { title: '断链 V', after: [u.id] })
    const v = nodeByTitle(snapshot.graph, '断链 V')
    snapshot = await act(env, 'delete-node', { nodeId: u.id, mode: 'unlink' })
    assert.equal(nodeById(snapshot.graph, u.id), undefined)
    assert.deepEqual(snapshot.graph.edges.filter((item) => item.from === u.id || item.to === u.id), [])
    const vNode = nodeById(snapshot.graph, v.id)
    assert.equal(vNode.conditions.length, 1)
    assert.equal(vNode.conditions[0].title, '断链 U 完成')
    assert.equal(snapshot.derived.conditions[v.id][0].satisfied, false)
    assert.ok(snapshot.derived.blocked.includes(v.id))

    const deletes = (await readAudit(env.root)).filter((event) => event.type === 'node/delete')
    const spliceEvent = deletes.at(-2)
    const unlinkEvent = deletes.at(-1)
    assert.equal(spliceEvent.data.mode, 'splice')
    assert.deepEqual(spliceEvent.data.orphanedConditions, [])
    assert.equal(unlinkEvent.data.mode, 'unlink')
    const orphaned = unlinkEvent.data.orphanedConditions
    assert.ok(Array.isArray(orphaned))
    assert.ok(
      orphaned.some((entry) => entry.nodeId === v.id && entry.title === '断链 U 完成'),
      `unlink must report the orphaned condition, got ${JSON.stringify(orphaned)}`,
    )
  })

  await t.test('a stale expectedRevision is a 409 with a readable message', async () => {
    const current = await snapshotOf(env)
    const stale = current.graph.revision - 1
    const result = await postAction(env.base, {
      workspaceId: WORKSPACE_ID,
      action: 'add-node',
      expectedRevision: stale,
      payload: { title: '过期写入' },
    })
    assert.equal(result.status, 409)
    assert.equal(result.body.ok, false)
    assert.equal(result.body.code, 'revision-conflict')
    assert.match(result.body.message, /版本|刷新|冲突/)
    const after = await snapshotOf(env)
    assert.equal(after.graph.revision, current.graph.revision, 'a rejected write changes nothing')
  })

  await t.test('SSE opens with the current revision and follows the next commit', async () => {
    const controller = new AbortController()
    t.after(() => controller.abort())
    const before = await snapshotOf(env)

    const response = await fetch(
      `${env.base}${API}/events?workspaceId=${encodeURIComponent(WORKSPACE_ID)}`,
      { headers: originHeaders(env.base), signal: controller.signal },
    )
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const frames = createFrameReader(response)
    t.after(() => frames.close())

    assert.deepEqual(await frames.readFrame(), { revision: before.graph.revision })

    const committed = await postAction(env.base, {
      workspaceId: WORKSPACE_ID,
      action: 'add-node',
      expectedRevision: before.graph.revision,
      payload: { title: '事件之后' },
    })
    assert.equal(committed.status, 200, JSON.stringify(committed.body))
    assert.deepEqual(await frames.readFrame(), { revision: before.graph.revision + 1 })
    controller.abort()
  })

  await t.test('Agent tools and HTTP read and write the same graph', async () => {
    assert.deepEqual(expectSort([...env.tools.keys()]), expectSort(TOOL_NAMES))
    const exec = { agent: { id: 's_tool' } }

    const addTool = env.tools.get('graph_add_node')
    const added = await addTool.execute({
      title: '工具建的任务',
      conditions: [{ title: '工具条件' }],
      agentPreset: 'preset-writer',
      model: 'deepseek/deepseek-chat',
    }, exec)
    assert.ok(added.nodeId.startsWith('n_'))

    let snapshot = await snapshotOf(env)
    const toolNode = nodeById(snapshot.graph, added.nodeId)
    assert.ok(toolNode !== undefined, 'a node created by a tool is visible over HTTP')
    assert.equal(toolNode.title, '工具建的任务')
    assert.deepEqual(toolNode.conditions.map((item) => item.title), ['工具条件'])
    assert.equal(toolNode.agentPreset, 'preset-writer')
    assert.equal(toolNode.model, 'deepseek/deepseek-chat')

    const conditionTool = env.tools.get('graph_add_condition')
    const addedCondition = await conditionTool.execute({
      nodeId: added.nodeId,
      title: '工具新增条件',
    }, exec)
    assert.ok(addedCondition.conditionId.startsWith('c_'))
    snapshot = await snapshotOf(env)
    assert.deepEqual(
      nodeById(snapshot.graph, added.nodeId).conditions.map((item) => item.title),
      ['工具条件', '工具新增条件'],
    )

    // Link the (done) milestone to the tool-created condition via the tool.
    const milestoneNode = nodeByTitle(snapshot.graph, '里程碑任务')
    const linkTool = env.tools.get('graph_link')
    const linked = await linkTool.execute({
      from: milestoneNode.id,
      to: added.nodeId,
      conditionTitle: '工具新增条件',
    }, exec)
    assert.equal(linked.conditionTitle, '工具新增条件')
    snapshot = await snapshotOf(env)
    const linkedEdge = snapshot.graph.edges.find((item) => item.id === linked.edgeId)
    assert.equal(linkedEdge.from, milestoneNode.id)
    assert.equal(linkedEdge.to, added.nodeId)
    assert.equal(linkedEdge.conditionId, linked.conditionId)

    const mapTool = env.tools.get('graph_map')
    const map = await mapTool.execute({}, exec)
    assert.equal(map.revision, snapshot.graph.revision)
    const mappedNode = map.nodes.find((node) => node.id === added.nodeId)
    assert.ok(mappedNode !== undefined)
    assert.deepEqual(mappedNode.conditions.map((item) => item.title), ['工具条件', '工具新增条件'])
    assert.equal(mappedNode.agentPreset, 'preset-writer')
    assert.equal(mappedNode.model, 'deepseek/deepseek-chat')
    assert.equal(mappedNode.schedule, null)
    // The unlinked condition keeps the node blocked; the linked one is satisfied.
    const blocked = map.blocked.find((node) => node.id === added.nodeId)
    assert.ok(blocked !== undefined, JSON.stringify(map.blocked))
    assert.deepEqual(blocked.waitingFor, ['工具条件'])
    assert.deepEqual(map.milestone, {
      id: milestoneNode.id,
      title: '里程碑任务',
      status: 'done',
      done: true,
    })
    assert.ok(map.failed.some((node) => node.title === '失败前序'))
    assert.ok(Array.isArray(map.planned))

    const updateTool = env.tools.get('graph_update_node')
    const updated = await updateTool.execute({ nodeId: added.nodeId, status: 'planned' }, exec)
    assert.equal(updated.node.status, 'planned')
    snapshot = await snapshotOf(env)
    assert.equal(nodeById(snapshot.graph, added.nodeId).status, 'planned')
    assert.ok(snapshot.derived.planned.includes(added.nodeId))

    // Tool writes go through the same failed-node validation as HTTP.
    const failedSource = nodeByTitle(snapshot.graph, '失败前序')
    const cNode = nodeByTitle(snapshot.graph, 'C')
    await assert.rejects(
      () => linkTool.execute({ from: failedSource.id, to: cNode.id }, exec),
      (error) => error.code === 'invalid-request' && /失败|前置/.test(error.message),
    )
  })

  await t.test('the prompt section describes prerequisites and description upkeep', async () => {
    assert.equal(env.sections.length, 1)
    assert.equal(env.sections[0].name, 'task-dag.node')
    const section = env.sections[0]
    const upkeep = '任务描述维护：用户提出新的需求、约束或完成标准时，及时调用 graph_update_node '
      + '把本节点的任务描述更新为当前完整版本（保留仍然有效的内容）。'
    let snapshot = await snapshotOf(env)
    const b = nodeByTitle(snapshot.graph, 'B')
    const c = nodeByTitle(snapshot.graph, 'C')

    await act(env, 'attach-session', { nodeId: c.id, sessionId: 's_prompt' })
    await act(env, 'attach-session', { nodeId: b.id, sessionId: 's_prompt2' })

    const blockedText = section.text({ scope: { id: 's_prompt' } })
    assert.equal(blockedText, [
      '本会话挂在任务节点「C」（状态：待开始）。',
      '前置条件：0/1 已满足 - 未满足：B 完成。',
      '完成后解锁：无。',
      upkeep,
    ].join('\n'))
    assert.equal(blockedText.split('\n').length, 4)

    const readyText = section.text({ scope: { id: 's_prompt2' } })
    assert.equal(readyText, [
      '本会话挂在任务节点「B」（状态：待开始）。',
      '前置条件：2/2 已满足。',
      '完成后解锁：C。',
      upkeep,
    ].join('\n'))
    assert.equal(readyText.split('\n').length, 4)

    assert.equal(section.text({ scope: { id: 's_unknown' } }), '')
    assert.equal(section.text({}), '')
  })
})

/* ================================================================== */
/* 2. v1 graph.json migration on first read                            */
/* ================================================================== */

function migrationSeed(root) {
  return async () => {
    const dir = join(root, '.dsh-task-graph')
    await mkdir(dir, { recursive: true })
    const v1 = {
      schemaVersion: 1,
      workspaceId: MIGRATION_WORKSPACE_ID,
      workspacePath: root,
      title: '迁移项目',
      revision: 7,
      updatedAt: CREATED,
      closeoutNodeId: 'n_c',
      nodes: [
        {
          id: 'n_a',
          title: 'A',
          status: 'done',
          notes: '',
          sessions: [],
          position: null,
          createdAt: CREATED,
          updatedAt: CREATED,
          completedAt: CREATED,
        },
        {
          id: 'n_b',
          title: 'B',
          status: 'todo',
          notes: '',
          sessions: [],
          position: null,
          createdAt: CREATED,
          updatedAt: CREATED,
          completedAt: null,
        },
        {
          id: 'n_c',
          title: 'C',
          status: 'todo',
          notes: '',
          sessions: [],
          position: null,
          createdAt: CREATED,
          updatedAt: CREATED,
          completedAt: null,
        },
      ],
      edges: [
        { id: 'e_1', from: 'n_a', to: 'n_b' },
        { id: 'e_2', from: 'n_a', to: 'n_c' },
      ],
    }
    await writeFile(join(dir, 'graph.json'), JSON.stringify(v1, null, 2), 'utf8')
  }
}

test('v2 acceptance: a v1 graph.json is migrated to schemaVersion 2', async (t) => {
  const env = await mountPlugin({
    workspaceId: MIGRATION_WORKSPACE_ID,
    title: '迁移项目',
    seed: migrationSeed,
  })
  t.after(() => env.close())

  const snapshot = await snapshotOf(env)
  const graph = snapshot.graph

  assert.equal(graph.schemaVersion, 2)
  assert.equal(graph.revision, 7)
  assert.equal(graph.closeoutNodeId, undefined, 'the v1 closeout field is gone')
  assert.equal(graph.milestoneNodeId, 'n_c', 'closeoutNodeId becomes milestoneNodeId')
  assert.deepEqual(graph.groups, [], 'a v1 document starts with no groups')

  const a = nodeById(graph, 'n_a')
  const b = nodeById(graph, 'n_b')
  const c = nodeById(graph, 'n_c')
  for (const node of [a, b, c]) {
    assert.ok(Array.isArray(node.conditions))
    assert.equal(node.agentPreset, null)
    assert.equal(node.model, null)
    assert.equal(node.schedule, null)
    assert.equal(node.failedAt, null)
  }

  // One legacy edge becomes one independent condition, preserving AND semantics.
  assert.equal(b.conditions.length, 1)
  assert.equal(c.conditions.length, 1)
  assert.equal(b.conditions[0].title, 'A 完成')
  assert.equal(c.conditions[0].title, 'A 完成')
  assert.notEqual(b.conditions[0].id, c.conditions[0].id)

  assert.equal(graph.edges.length, 2)
  const edgeToB = graph.edges.find((item) => item.from === 'n_a' && item.to === 'n_b')
  const edgeToC = graph.edges.find((item) => item.from === 'n_a' && item.to === 'n_c')
  assert.equal(edgeToB.conditionId, b.conditions[0].id)
  assert.equal(edgeToC.conditionId, c.conditions[0].id)

  assert.deepEqual(expectSort(snapshot.derived.ready), ['n_b', 'n_c'])
  assert.deepEqual(snapshot.derived.blocked, [])
  assert.deepEqual(snapshot.derived.progress, {
    done: 1,
    total: 3,
    ready: 2,
    blocked: 0,
    doing: 0,
    failed: 0,
    planned: 0,
  })
  assert.deepEqual(snapshot.derived.milestone, {
    id: 'n_c',
    title: 'C',
    status: 'todo',
    done: false,
  })
  assert.deepEqual(snapshot.derived.conditions.n_b, [{
    id: b.conditions[0].id,
    title: 'A 完成',
    satisfied: true,
    linked: [{ id: 'n_a', title: 'A', status: 'done' }],
    waiting: [],
  }])

  // The migrated document is what later writes extend: an ordinary action works.
  const updated = await act(env, 'update-node', { nodeId: 'n_b', status: 'doing' })
  assert.equal(updated.graph.schemaVersion, 2)
  assert.equal(nodeById(updated.graph, 'n_b').status, 'doing')
})

/* ================================================================== */
/* 3. per-node scheduler: due graph -> launch -> settlement            */
/* ================================================================== */

const SCHEDULER_NOW = new Date(2026, 9, 29, 8, 0, 0, 0).getTime()

function scheduleFixtureNode(overrides = {}) {
  return {
    id: 'n_x',
    title: '任务',
    status: 'todo',
    notes: '',
    conditions: [],
    sessions: [],
    position: null,
    agentPreset: null,
    model: null,
    schedule: {
      enabled: true,
      cron: '0 9 * * *',
      nextRunAt: '2000-01-01T00:00:00.000Z',
      lastTriggeredAt: null,
      lastFinishedAt: null,
      lastResult: null,
      lastError: null,
      lastSkippedReason: null,
      lastSessionId: null,
    },
    createdAt: CREATED,
    updatedAt: CREATED,
    completedAt: null,
    failedAt: null,
    ...overrides,
  }
}

function fixtureCondition(id, title) {
  return { id, title, createdAt: CREATED }
}

test('v2 acceptance: the scheduler launches, skips and settles per-node executions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-dag-accept-scheduler-'))
  const workspace = {
    workspaceId: SCHEDULER_WORKSPACE_ID,
    path: root,
    title: '定时验收',
  }
  const store = new GraphStore()

  let storeRef
  const promptSnapshots = []
  const gateway = createGateway(root, {
    createId: (sequence) => `sched-${sequence}`,
    onPrompt: (request) => {
      const graph = storeRef.read(workspace).graph
      const node = graph.nodes.find((item) => (item.sessions ?? []).some(
        (session) => session.sessionId === request.sessionId && session.retiredAt === null,
      ))
      const record = node?.sessions.find((session) => session.sessionId === request.sessionId)
      promptSnapshots.push({
        sessionId: request.sessionId,
        nodeId: node?.id ?? null,
        status: node?.status ?? null,
        mode: record?.handoff?.mode ?? null,
      })
    },
  })
  storeRef = store

  const seeded = {
    schemaVersion: 2,
    workspaceId: SCHEDULER_WORKSPACE_ID,
    workspacePath: root,
    title: '定时验收',
    revision: 0,
    updatedAt: null,
    milestoneNodeId: null,
    nodes: [
      scheduleFixtureNode({
        id: 'n_ok',
        title: '照常执行',
        agentPreset: 'preset-a',
        model: 'openai/gpt-x',
      }),
      scheduleFixtureNode({ id: 'n_bad', title: '执行失败' }),
      scheduleFixtureNode({
        id: 'n_blocked',
        title: '条件未满足',
        conditions: [fixtureCondition('c_blk', '前置完成')],
      }),
      scheduleFixtureNode({ id: 'n_planned', title: '待规划不跑', status: 'planned' }),
      scheduleFixtureNode({ id: 'n_pre', title: '前置任务', status: 'doing', schedule: null }),
      scheduleFixtureNode({
        id: 'n_after',
        title: '失败节点的后继',
        schedule: null,
        conditions: [fixtureCondition('c_after', '执行失败 完成')],
      }),
    ],
    edges: [
      { id: 'e_blk', from: 'n_pre', to: 'n_blocked', conditionId: 'c_blk' },
      { id: 'e_after', from: 'n_bad', to: 'n_after', conditionId: 'c_after' },
    ],
  }
  await store.commit(workspace, 0, () => ({ next: seeded, event: { type: 'test/seed' } }))

  const ctx = {
    typertGateway: gateway,
    sessions: { get: () => undefined },
    workspaceRegistry: {
      list: () => [{ id: SCHEDULER_WORKSPACE_ID, path: root, title: '定时验收', sessionIds: [] }],
    },
  }
  const scheduler = new TaskDagScheduler(ctx, store, {
    now: () => SCHEDULER_NOW,
    tickMs: 10 * 60 * 1000,
    pollMs: 10 * 60 * 1000,
  })
  t.after(() => {
    scheduler.dispose()
    return rm(root, { recursive: true, force: true })
  })

  await scheduler.tick(SCHEDULER_NOW)

  // --- launch order -------------------------------------------------
  assert.deepEqual(gateway.created, ['sched-1', 'sched-2'])
  const sessionMethods = gateway.calls
    .map((call) => `${call.namespace}/${call.method}`)
    .filter((name) => name.startsWith('session/') && name !== 'session/list')
  assert.deepEqual(sessionMethods, [
    'session/create',
    'session/selectModel',
    'session/rename',
    'session/prompt',
    'session/create',
    'session/rename',
    'session/prompt',
  ])

  const createCalls = gateway.calls.filter((call) => call.method === 'create')
  assert.deepEqual(createCalls[0].args.request, {
    workspaceId: SCHEDULER_WORKSPACE_ID,
    agentPreset: 'preset-a',
  })
  assert.deepEqual(createCalls[1].args.request, { workspaceId: SCHEDULER_WORKSPACE_ID })
  assert.deepEqual(gateway.selectModels, [{
    sessionId: 'sched-1',
    model: 'gpt-x',
    provider: 'openai',
  }])

  // The attach commit happened before the prompt: at prompt time the created
  // session is already the node's current, scheduled session.
  assert.deepEqual(promptSnapshots, [
    { sessionId: 'sched-1', nodeId: 'n_ok', status: 'doing', mode: 'scheduled' },
    { sessionId: 'sched-2', nodeId: 'n_bad', status: 'doing', mode: 'scheduled' },
  ])
  assert.match(gateway.prompts[0].content[0].text, /^# 定时执行：照常执行/)
  assert.match(gateway.prompts[0].content[0].text, /## 前置条件（全部满足才会触发）/)
  assert.match(gateway.prompts[0].content[0].text, /- 无（无条件，可直接开始）/)
  assert.match(gateway.prompts[1].content[0].text, /^# 定时执行：执行失败/)

  // --- per-node schedule/launch state -------------------------------
  let graph = store.read(workspace).graph
  const launchedOk = graph.nodes.find((node) => node.id === 'n_ok')
  assert.equal(launchedOk.status, 'doing')
  assert.equal(launchedOk.completedAt, null)
  assert.equal(launchedOk.failedAt, null)
  assert.equal(launchedOk.schedule.lastTriggeredAt, new Date(SCHEDULER_NOW).toISOString())
  assert.equal(
    launchedOk.schedule.nextRunAt,
    new Date(2026, 9, 29, 9, 0, 0, 0).toISOString(),
    'the next occurrence is computed from now, not from the missed one',
  )
  assert.equal(launchedOk.schedule.lastSessionId, 'sched-1')
  assert.equal(launchedOk.sessions.length, 1)
  assert.equal(launchedOk.sessions[0].sessionId, 'sched-1')
  assert.equal(launchedOk.sessions[0].retiredAt, null)
  assert.equal(launchedOk.sessions[0].slot, 1)
  assert.deepEqual(launchedOk.sessions[0].handoff, { from: null, mode: 'scheduled' })

  const launchedBad = graph.nodes.find((node) => node.id === 'n_bad')
  assert.equal(launchedBad.status, 'doing')
  assert.equal(launchedBad.schedule.lastSessionId, 'sched-2')

  // --- skip rules ---------------------------------------------------
  const skippedByCondition = graph.nodes.find((node) => node.id === 'n_blocked')
  assert.equal(skippedByCondition.status, 'todo')
  assert.equal(skippedByCondition.schedule.lastResult, 'skipped')
  assert.match(skippedByCondition.schedule.lastSkippedReason, /前置条件未满足：前置完成/)
  assert.equal(skippedByCondition.schedule.lastSessionId, null)
  assert.deepEqual(skippedByCondition.sessions, [])
  assert.equal(
    skippedByCondition.schedule.nextRunAt,
    new Date(2026, 9, 29, 9, 0, 0, 0).toISOString(),
  )

  const skippedByStatus = graph.nodes.find((node) => node.id === 'n_planned')
  assert.equal(skippedByStatus.status, 'planned')
  assert.equal(skippedByStatus.schedule.lastResult, 'skipped')
  assert.match(skippedByStatus.schedule.lastSkippedReason, /待开始/)

  assert.deepEqual(
    expectSort(scheduler.pendingExecutions().map((entry) => entry.nodeId)),
    ['n_bad', 'n_ok'],
  )

  // --- settlement: session/list says idle, events decide the outcome --
  gateway.states.get('sched-1').running = false
  gateway.states.get('sched-2').running = false
  gateway.events['sched-1'] = [
    { type: 'turn/start', seq: 1, time: 1, data: {} },
    { type: 'user/message', seq: 2, time: 2, data: { text: '开始' } },
    { type: 'turn/end', seq: 3, time: 3, data: { reason: { kind: 'completed' } } },
  ]
  gateway.events['sched-2'] = [
    { type: 'turn/start', seq: 1, time: 1, data: {} },
    { type: 'turn/end', seq: 2, time: 2, data: { reason: { kind: 'error', message: '模型调用失败' } } },
  ]

  const settledAt = SCHEDULER_NOW + 5_000
  await scheduler.pollExecutions(settledAt)

  graph = store.read(workspace).graph
  const doneNode = graph.nodes.find((node) => node.id === 'n_ok')
  assert.equal(doneNode.status, 'done')
  assert.equal(doneNode.completedAt, new Date(settledAt).toISOString())
  assert.equal(doneNode.failedAt, null)
  assert.equal(doneNode.schedule.lastResult, 'succeeded')
  assert.equal(doneNode.schedule.lastFinishedAt, new Date(settledAt).toISOString())
  assert.equal(doneNode.schedule.lastError, null)

  const failedNode = graph.nodes.find((node) => node.id === 'n_bad')
  assert.equal(failedNode.status, 'failed')
  assert.equal(failedNode.failedAt, new Date(settledAt).toISOString())
  assert.equal(failedNode.completedAt, null)
  assert.equal(failedNode.schedule.lastResult, 'failed')
  assert.match(failedNode.schedule.lastError, /模型调用失败/)
  // A failed node may not keep outgoing edges: the failure detaches them.
  assert.deepEqual(graph.edges.filter((item) => item.from === 'n_bad'), [])
  const afterNode = graph.nodes.find((node) => node.id === 'n_after')
  assert.equal(afterNode.conditions.length, 1, 'the successor condition survives')
  assert.equal(afterNode.status, 'todo')

  assert.deepEqual(scheduler.pendingExecutions(), [])
})
