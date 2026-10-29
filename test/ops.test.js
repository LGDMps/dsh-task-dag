/**
 * Tests for the v2 mutation layer.
 *
 * A real `GraphStore` writes into a real temporary directory; only the DSH
 * services (`typertGateway`, `sessions`, `workspaceRegistry`) are fake. That
 * keeps the CAS / invariant path honest while the session RPCs stay observable.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GraphStore } from '../src/store.js'
import { applyAction, applyExecutionOutcome } from '../src/ops.js'
import { derive, findNode } from '../src/model.js'
import { TaskDagError } from '../src/errors.js'

/* ------------------------------------------------------------------ */
/* harness                                                            */
/* ------------------------------------------------------------------ */

async function makeWorkspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'task-dag-ops-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return { workspaceId: 'ws_ops', path: dir, title: 'ops' }
}

function fakeHost(options = {}) {
  const calls = {
    invoke: [],
    stream: [],
    order: [],
    created: [],
    prompted: [],
    archived: [],
    unarchived: [],
    models: [],
    createRequests: [],
    renamed: 0,
  }
  const followEvents = options.followEvents ?? [
    { type: 'user/message', seq: 1, time: 1, data: { text: '先做数据模型' } },
    { type: 'assistant/message', seq: 2, time: 2, data: { text: '数据模型已经完成，下一步做接口。' } },
  ]
  const liveLogs = options.liveLogs ?? new Map()

  const gateway = {
    async invoke(request) {
      calls.invoke.push(request)
      const { namespace, method, args } = request
      if (namespace === 'session' && method === 'create') {
        calls.order.push('create')
        calls.createRequests.push(args?.request)
        const sessionId = options.createSessionId ?? `session-new-${calls.created.length + 1}`
        calls.created.push(sessionId)
        return { sessionId }
      }
      if (namespace === 'session' && method === 'rename') {
        calls.renamed += 1
        return { title: args?.request?.title }
      }
      if (namespace === 'session' && method === 'selectModel') {
        calls.models.push(args?.request)
        return { ok: true }
      }
      if (namespace === 'session' && method === 'prompt') {
        calls.order.push('prompt')
        if (options.failPrompt === true) throw new Error('prompt rejected')
        calls.prompted.push(args?.request)
        return { accepted: true }
      }
      if (namespace === 'session' && method === 'list') {
        return { items: options.listItems ?? [] }
      }
      if (namespace === 'workspace' && method === 'archiveSession') {
        if (options.failArchive === true) throw new Error('archive rejected')
        calls.archived.push(args?.request)
        return { archivedSessionIds: [] }
      }
      if (namespace === 'workspace' && method === 'unarchiveSession') {
        calls.unarchived.push(args?.request)
        return {}
      }
      return {}
    },
    async stream(request) {
      calls.stream.push(request)
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'snapshot',
            cursor: followEvents.length,
            records: followEvents.map((event) => ({ event })),
            hasMore: false,
            projections: {},
          }
        },
      }
    },
  }

  const registry = options.registryArchive === false
    ? { list: () => [], archivedSessionIds: [] }
    : {
        list: () => [],
        archivedSessionIds: options.archivedSessionIds ?? [],
        async archiveSession(sessionId, archiveOptions) {
          if (options.failArchive === true) throw new Error('archive rejected')
          calls.archived.push({ sessionId, options: archiveOptions })
        },
        async unarchiveSession(sessionId) {
          calls.unarchived.push({ sessionId })
        },
      }

  const ctx = {
    typertGateway: gateway,
    sessions: { get: (sessionId) => liveLogs.get(sessionId) },
    workspaceRegistry: registry,
  }

  return { ctx, calls, followEvents }
}

async function act(host, store, workspace, action, payload = {}) {
  const revision = store.read(workspace).graph.revision
  return applyAction(host.ctx, store, workspace, {
    action,
    expectedRevision: revision,
    payload,
  })
}

async function addNode(host, store, workspace, payload) {
  const applied = await act(host, store, workspace, 'add-node', payload)
  return { graph: applied.graph, node: findNode(applied.graph, applied.result.nodeId) }
}

function nodeWithTitle(graph, title) {
  return graph.nodes.find((node) => node.title === title)
}

function codeOf(error) {
  assert.equal(error instanceof TaskDagError, true, `expected TaskDagError, got ${error}`)
  return error.code
}

/* ------------------------------------------------------------------ */
/* add / update nodes                                                  */
/* ------------------------------------------------------------------ */

test('add-node creates a todo node and one condition per `after` predecessor', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()

  const a = await addNode(host, store, workspace, { title: 'A' })
  const b = await addNode(host, store, workspace, { title: 'B' })
  const c = await addNode(host, store, workspace, { title: 'C', after: [a.node.id, b.node.id] })

  assert.equal(c.node.status, 'todo')
  assert.equal(c.node.conditions.length, 2)
  assert.deepEqual(c.node.conditions.map((condition) => condition.title), ['A 完成', 'B 完成'])
  assert.equal(c.graph.edges.length, 2)
  assert.ok(c.graph.edges.every((edge) => edge.to === c.node.id))
  assert.deepEqual(derive(c.graph).blocked, [c.node.id])
})

test('add-node accepts explicit conditions, presets and models', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })

  const b = await addNode(host, store, workspace, {
    title: 'B',
    notes: '备注',
    agentPreset: 'build',
    model: 'deepseek/deepseek-chat',
    conditions: [
      { title: '需求评审通过', after: [a.node.id] },
      { title: '外部审批' },
    ],
  })

  assert.equal(b.node.agentPreset, 'build')
  assert.equal(b.node.model, 'deepseek/deepseek-chat')
  assert.deepEqual(b.node.conditions.map((condition) => condition.title), ['需求评审通过', '外部审批'])
  assert.equal(b.graph.edges.length, 1)
  assert.equal(b.graph.edges[0].conditionId, b.node.conditions[0].id)
  assert.deepEqual(derive(b.graph).blocked, [b.node.id], 'the manual condition is still unmet')
})

test('add-node refuses a failed predecessor and validates payloads', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })
  await act(host, store, workspace, 'update-node', { nodeId: a.node.id, status: 'failed' })

  await assert.rejects(
    addNode(host, store, workspace, { title: 'B', after: [a.node.id] }),
    (error) => codeOf(error) === 'invalid-request',
  )
  await assert.rejects(
    addNode(host, store, workspace, { title: '' }),
    (error) => codeOf(error) === 'invalid-request',
  )
  await assert.rejects(
    addNode(host, store, workspace, { title: 'B', conditions: [{ title: '  ' }] }),
    (error) => codeOf(error) === 'invalid-request',
  )
})

test('update-node drives all five statuses and their timestamps', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })

  let applied = await act(host, store, workspace, 'update-node', { nodeId: a.node.id, status: 'planned' })
  assert.equal(applied.result.node.status, 'planned')
  assert.equal(applied.result.node.completedAt, null)
  assert.equal(applied.result.node.failedAt, null)

  applied = await act(host, store, workspace, 'update-node', { nodeId: a.node.id, status: 'doing' })
  assert.equal(applied.result.node.status, 'doing')

  applied = await act(host, store, workspace, 'update-node', { nodeId: a.node.id, status: 'done' })
  assert.equal(applied.result.node.status, 'done')
  assert.equal(typeof applied.result.node.completedAt, 'string')
  assert.equal(applied.result.node.failedAt, null)

  applied = await act(host, store, workspace, 'update-node', { nodeId: a.node.id, status: 'failed' })
  assert.equal(applied.result.node.status, 'failed')
  assert.equal(typeof applied.result.node.failedAt, 'string')
  assert.equal(applied.result.node.completedAt, null)

  applied = await act(host, store, workspace, 'update-node', { nodeId: a.node.id, status: 'todo' })
  assert.equal(applied.result.node.status, 'todo')
  assert.equal(applied.result.node.completedAt, null)
  assert.equal(applied.result.node.failedAt, null)

  await assert.rejects(
    act(host, store, workspace, 'update-node', { nodeId: a.node.id, status: 'archived' }),
    (error) => codeOf(error) === 'invalid-request',
  )
})

test('update-node to failed refuses while successors exist unless detaching them', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })
  const b = await addNode(host, store, workspace, { title: 'B', after: [a.node.id] })

  await assert.rejects(
    act(host, store, workspace, 'update-node', { nodeId: a.node.id, status: 'failed' }),
    (error) => {
      assert.equal(codeOf(error), 'invalid-request')
      assert.equal(error.details.successorCount, 1)
      return true
    },
  )

  const applied = await act(host, store, workspace, 'update-node', {
    nodeId: a.node.id,
    status: 'failed',
    detachSuccessors: true,
  })
  assert.equal(applied.result.node.status, 'failed')
  assert.equal(applied.result.detachedEdges.length, 1)
  assert.equal(applied.graph.edges.length, 0)
  assert.equal(applied.graph.nodes.find((node) => node.id === b.node.id).conditions.length, 1)
  assert.equal(derive(applied.graph).blocked.includes(b.node.id), true)
})

test('update-node sets and clears the per-node execution target', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })

  let applied = await act(host, store, workspace, 'update-node', {
    nodeId: a.node.id,
    agentPreset: 'build',
    model: 'provider/model-1',
    reasoningEffort: 'high',
  })
  assert.equal(applied.result.node.agentPreset, 'build')
  assert.equal(applied.result.node.model, 'provider/model-1')
  assert.equal(applied.result.node.reasoningEffort, 'high')

  applied = await act(host, store, workspace, 'update-node', {
    nodeId: a.node.id,
    agentPreset: '',
    model: null,
  })
  assert.equal(applied.result.node.agentPreset, null)
  assert.equal(applied.result.node.model, null)
  assert.equal(applied.result.node.reasoningEffort, null, 'clearing the model clears its effort')

  await assert.rejects(
    act(host, store, workspace, 'update-node', { nodeId: a.node.id, agentPreset: 42 }),
    (error) => codeOf(error) === 'invalid-request',
  )
})

test('changing the model or effort reaches the node current session', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })
  const handoff = await act(host, store, workspace, 'handoff', { nodeId: a.node.id, mode: 'blank' })
  assert.equal(handoff.result.sessionId, 'session-new-1')
  assert.equal(host.calls.models.length, 0, 'a node without a model applies nothing on create')

  const applied = await act(host, store, workspace, 'update-node', {
    nodeId: a.node.id,
    model: 'provider/model-2',
    reasoningEffort: 'high',
  })
  assert.equal(applied.result.node.model, 'provider/model-2')
  assert.equal(applied.result.node.reasoningEffort, 'high')
  assert.deepEqual(applied.warnings, [])
  assert.deepEqual(host.calls.models.at(-1), {
    sessionId: 'session-new-1',
    provider: 'provider',
    model: 'model-2',
    reasoningEffort: 'high',
  })
})

test('set-position stores and clears coordinates', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })

  let applied = await act(host, store, workspace, 'set-position', {
    nodeId: a.node.id,
    position: { x: 120, y: 80 },
  })
  assert.deepEqual(applied.result.position, { x: 120, y: 80 })

  applied = await act(host, store, workspace, 'set-position', { nodeId: a.node.id, position: null })
  assert.equal(applied.result.position, null)
})

test('set-positions updates a whole batch in one commit', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })
  const b = await addNode(host, store, workspace, { title: 'B' })
  const revisionBefore = store.read(workspace).graph.revision

  const applied = await act(host, store, workspace, 'set-positions', {
    positions: [
      { nodeId: a.node.id, position: { x: 120, y: 80 } },
      { nodeId: b.node.id, position: { x: 380, y: 80 } },
    ],
  })
  assert.deepEqual(applied.result.positions, [
    { nodeId: a.node.id, position: { x: 120, y: 80 } },
    { nodeId: b.node.id, position: { x: 380, y: 80 } },
  ])
  assert.equal(applied.graph.revision, revisionBefore + 1, 'the batch burns exactly one revision')
  const graph = store.read(workspace).graph
  assert.deepEqual(findNode(graph, a.node.id).position, { x: 120, y: 80 })
  assert.deepEqual(findNode(graph, b.node.id).position, { x: 380, y: 80 })

  await assert.rejects(
    act(host, store, workspace, 'set-positions', { positions: [] }),
    (error) => codeOf(error) === 'invalid-request',
  )
  await assert.rejects(
    act(host, store, workspace, 'set-positions', {
      positions: [
        { nodeId: a.node.id, position: { x: 1, y: 1 } },
        { nodeId: a.node.id, position: { x: 2, y: 2 } },
      ],
    }),
    (error) => codeOf(error) === 'invalid-request',
  )
})

/* ------------------------------------------------------------------ */
/* conditions + links                                                  */
/* ------------------------------------------------------------------ */

test('link creates a default condition, then attaches to an explicit one', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })
  const b = await addNode(host, store, workspace, { title: 'B' })

  let applied = await act(host, store, workspace, 'link', { from: a.node.id, to: b.node.id })
  assert.equal(applied.result.conditionCreated, true)
  assert.equal(applied.result.condition.title, 'A 完成')
  assert.equal(applied.result.edge.conditionId, applied.result.condition.id)

  await assert.rejects(
    act(host, store, workspace, 'link', { from: a.node.id, to: b.node.id }),
    (error) => codeOf(error) === 'invalid-request',
  )

  const added = await act(host, store, workspace, 'add-condition', {
    nodeId: b.node.id,
    title: '第二个条件',
  })
  applied = await act(host, store, workspace, 'link', {
    from: a.node.id,
    to: b.node.id,
    conditionId: added.result.condition.id,
  })
  assert.equal(applied.result.edge.conditionId, added.result.condition.id)
  assert.equal(applied.graph.edges.length, 2, 'the same pair may satisfy several conditions')

  applied = await act(host, store, workspace, 'link', {
    from: a.node.id,
    to: b.node.id,
    conditionTitle: '第三个条件',
  })
  assert.equal(applied.result.condition.title, '第三个条件')
  assert.equal(applied.result.conditionCreated, true)
})

test('link rejects failed sources, cycles, unknown conditions and self edges', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })
  const b = await addNode(host, store, workspace, { title: 'B' })
  const c = await addNode(host, store, workspace, { title: 'C', after: [b.node.id] })
  await act(host, store, workspace, 'link', { from: a.node.id, to: b.node.id })

  await assert.rejects(
    act(host, store, workspace, 'link', { from: b.node.id, to: a.node.id }),
    (error) => codeOf(error) === 'cycle',
  )
  await assert.rejects(
    act(host, store, workspace, 'link', { from: a.node.id, to: b.node.id, conditionId: 'c_missing' }),
    (error) => codeOf(error) === 'invalid-request',
  )
  await assert.rejects(
    act(host, store, workspace, 'link', { from: a.node.id, to: a.node.id }),
    (error) => codeOf(error) === 'invalid-request',
  )

  const failed = await addNode(host, store, workspace, { title: 'F' })
  await act(host, store, workspace, 'update-node', { nodeId: failed.node.id, status: 'failed' })
  await assert.rejects(
    act(host, store, workspace, 'link', { from: failed.node.id, to: c.node.id }),
    (error) => codeOf(error) === 'invalid-request',
  )
})

test('add / update / delete condition keeps edges consistent', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })
  const b = await addNode(host, store, workspace, { title: 'B', after: [a.node.id] })
  const conditionId = b.node.conditions[0].id

  let applied = await act(host, store, workspace, 'update-condition', {
    nodeId: b.node.id,
    conditionId,
    title: '新的条件',
  })
  assert.equal(applied.result.condition.title, '新的条件')

  applied = await act(host, store, workspace, 'delete-condition', {
    nodeId: b.node.id,
    conditionId,
  })
  assert.equal(applied.result.removedEdges.length, 1)
  assert.equal(applied.graph.edges.length, 0)
  assert.equal(applied.graph.nodes.find((node) => node.id === b.node.id).conditions.length, 0)

  await assert.rejects(
    act(host, store, workspace, 'delete-condition', { nodeId: b.node.id, conditionId }),
    (error) => codeOf(error) === 'not-found',
  )
})

test('unlink removes one edge and clears the condition satisfier', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })
  const b = await addNode(host, store, workspace, { title: 'B', after: [a.node.id] })
  const edgeId = b.graph.edges[0].id

  const applied = await act(host, store, workspace, 'unlink', { edgeId })
  assert.equal(applied.graph.edges.length, 0)
  assert.equal(derive(applied.graph).blocked.includes(b.node.id), true)
})

/* ------------------------------------------------------------------ */
/* milestone                                                           */
/* ------------------------------------------------------------------ */

test('set-milestone accepts any node and the milestone may be a prerequisite', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })
  const b = await addNode(host, store, workspace, { title: 'B' })

  let applied = await act(host, store, workspace, 'set-milestone', { nodeId: a.node.id })
  assert.equal(applied.graph.milestoneNodeId, a.node.id)

  // Requirement 6: the milestone is allowed to be a prerequisite.
  applied = await act(host, store, workspace, 'link', { from: a.node.id, to: b.node.id })
  assert.equal(applied.graph.edges.length, 1)
  assert.deepEqual(derive(applied.graph).milestone, {
    id: a.node.id,
    title: 'A',
    status: 'todo',
    done: false,
  })

  // The old action name still works and maps onto the same semantic.
  applied = await act(host, store, workspace, 'set-closeout', { nodeId: null })
  assert.equal(applied.graph.milestoneNodeId, null)

  await assert.rejects(
    act(host, store, workspace, 'set-milestone', { nodeId: 'n_missing' }),
    (error) => codeOf(error) === 'not-found',
  )
})

/* ------------------------------------------------------------------ */
/* schedule                                                            */
/* ------------------------------------------------------------------ */

test('set-schedule arms, recomputes and disarms a node schedule', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })

  let applied = await act(host, store, workspace, 'set-schedule', {
    nodeId: a.node.id,
    enabled: true,
    cron: '*/5 * * * *',
  })
  assert.equal(applied.result.schedule.enabled, true)
  assert.equal(applied.result.schedule.cron, '*/5 * * * *')
  assert.ok(Date.parse(applied.result.schedule.nextRunAt) > Date.now())
  assert.equal(applied.result.schedule.lastResult, null)

  applied = await act(host, store, workspace, 'set-schedule', {
    nodeId: a.node.id,
    cron: '0 9 * * 1-5',
  })
  assert.equal(applied.result.schedule.cron, '0 9 * * 1-5')
  assert.ok(Date.parse(applied.result.schedule.nextRunAt) > Date.now())

  applied = await act(host, store, workspace, 'set-schedule', {
    nodeId: a.node.id,
    enabled: false,
  })
  assert.equal(applied.result.schedule.enabled, false)
  assert.equal(applied.result.schedule.nextRunAt, null)

  await assert.rejects(
    act(host, store, workspace, 'set-schedule', {
      nodeId: a.node.id,
      enabled: true,
      cron: 'not a cron',
    }),
    (error) => codeOf(error) === 'invalid-request',
  )
  await assert.rejects(
    act(host, store, workspace, 'set-schedule', {
      nodeId: a.node.id,
      enabled: true,
      cron: '0 0 30 2 *',
    }),
    (error) => codeOf(error) === 'invalid-request',
  )
  const fresh = await addNode(host, store, workspace, { title: '没有定时表达式' })
  await assert.rejects(
    act(host, store, workspace, 'set-schedule', { nodeId: fresh.node.id, enabled: true }),
    (error) => codeOf(error) === 'invalid-request',
  )
})

/* ------------------------------------------------------------------ */
/* delete-node                                                         */
/* ------------------------------------------------------------------ */

test('delete-node with unlink reports conditions that lost every satisfier', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })
  const b = await addNode(host, store, workspace, { title: 'B', after: [a.node.id] })

  const applied = await act(host, store, workspace, 'delete-node', {
    nodeId: a.node.id,
    mode: 'unlink',
  })
  assert.equal(applied.graph.nodes.length, 1)
  assert.equal(applied.graph.edges.length, 0)
  assert.equal(applied.result.orphanedConditions.length, 1)
  assert.equal(applied.result.orphanedConditions[0].nodeId, b.node.id)
  assert.deepEqual(derive(applied.graph).blocked, [b.node.id])
})

test('delete-node with splice wires upstream nodes onto successor conditions', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })
  const b = await addNode(host, store, workspace, { title: 'B', after: [a.node.id] })
  const c = await addNode(host, store, workspace, { title: 'C', after: [b.node.id] })

  const applied = await act(host, store, workspace, 'delete-node', {
    nodeId: b.node.id,
    mode: 'splice',
  })
  assert.equal(applied.graph.nodes.length, 2)
  assert.equal(applied.result.added.length, 1)
  assert.equal(applied.result.added[0].from, a.node.id)
  assert.equal(applied.result.added[0].to, c.node.id)
  assert.equal(applied.graph.edges.length, 1)
})

test('delete-node clears a milestone that points at the removed node', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })
  await act(host, store, workspace, 'set-milestone', { nodeId: a.node.id })

  const applied = await act(host, store, workspace, 'delete-node', {
    nodeId: a.node.id,
    mode: 'unlink',
  })
  assert.equal(applied.graph.milestoneNodeId, null)
})

/* ------------------------------------------------------------------ */
/* sessions                                                            */
/* ------------------------------------------------------------------ */

test('attach-session retires the previous session and is idempotent', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })

  let applied = await act(host, store, workspace, 'attach-session', {
    nodeId: a.node.id,
    sessionId: 'session-1',
  })
  assert.equal(applied.result.slot, 1)

  applied = await act(host, store, workspace, 'attach-session', {
    nodeId: a.node.id,
    sessionId: 'session-2',
  })
  assert.equal(applied.result.slot, 2)
  assert.equal(applied.result.retiredSessionId, 'session-1')

  applied = await act(host, store, workspace, 'attach-session', {
    nodeId: a.node.id,
    sessionId: 'session-2',
  })
  assert.equal(applied.result.idempotent, true)

  applied = await act(host, store, workspace, 'switch-session', {
    nodeId: a.node.id,
    sessionId: 'session-1',
  })
  assert.equal(applied.graph.nodes[0].sessions.find((session) => session.sessionId === 'session-1').retiredAt, null)
  assert.notEqual(applied.graph.nodes[0].sessions.find((session) => session.sessionId === 'session-2').retiredAt, null)

  applied = await act(host, store, workspace, 'detach-session', {
    nodeId: a.node.id,
    sessionId: 'session-1',
  })
  assert.equal(applied.graph.nodes[0].sessions.length, 1)
})

test('a session belongs to exactly one node (session-claimed, 409)', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })
  const b = await addNode(host, store, workspace, { title: 'B' })
  await act(host, store, workspace, 'attach-session', { nodeId: a.node.id, sessionId: 'session-1' })

  await assert.rejects(
    act(host, store, workspace, 'attach-session', { nodeId: b.node.id, sessionId: 'session-1' }),
    (error) => codeOf(error) === 'session-claimed' && error.status === 409,
  )
})

test('handoff uses the node agent preset and model', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, {
    title: 'A',
    agentPreset: 'build',
    model: 'provider/model-1',
  })

  const applied = await act(host, store, workspace, 'handoff', { nodeId: a.node.id, mode: 'blank' })
  assert.equal(applied.result.mode, 'blank')
  assert.equal(applied.result.agentPreset, 'build')
  assert.equal(applied.result.model, 'provider/model-1')
  assert.deepEqual(host.calls.createRequests[0], { workspaceId: workspace.workspaceId, agentPreset: 'build' })
  assert.deepEqual(host.calls.models[0], {
    sessionId: 'session-new-1',
    provider: 'provider',
    model: 'model-1',
  })
  assert.equal(host.calls.prompted.length, 0, 'blank handoff sends nothing')
  const node = findNode(applied.graph, a.node.id)
  assert.equal(node.sessions.length, 1)
  assert.equal(node.sessions[0].handoff.mode, 'blank')
})

test('handoff sends a deterministic brief after committing the chain', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const liveLogs = new Map([
    ['session-old', {
      log: [
        { type: 'user/message', seq: 1, time: 1, data: { text: '继续做 B' } },
        { type: 'assistant/message', seq: 2, time: 2, data: { text: 'B 已经做到一半。' } },
      ],
    }],
  ])
  const host = fakeHost({ liveLogs })
  const a = await addNode(host, store, workspace, { title: 'A' })
  await act(host, store, workspace, 'attach-session', { nodeId: a.node.id, sessionId: 'session-old' })

  const applied = await act(host, store, workspace, 'handoff', { nodeId: a.node.id, mode: 'brief' })
  assert.equal(applied.result.mode, 'brief')
  assert.match(applied.result.brief, /# 交接简报：A/)
  assert.equal(host.calls.prompted.length, 1)
  assert.equal(host.calls.prompted[0].content[0].text, applied.result.brief)
  assert.deepEqual(host.calls.order, ['create', 'prompt'])
  const node = findNode(applied.graph, a.node.id)
  assert.equal(node.sessions.length, 2)
  assert.equal(node.sessions[0].retiredAt !== null, true)
  assert.equal(node.sessions[1].handoff.mode, 'brief')
})

test('archive-sessions archives the whole chain and reports failures', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })
  await act(host, store, workspace, 'attach-session', { nodeId: a.node.id, sessionId: 'session-1' })
  await act(host, store, workspace, 'attach-session', { nodeId: a.node.id, sessionId: 'session-2' })

  const applied = await act(host, store, workspace, 'archive-sessions', { nodeId: a.node.id })
  assert.deepEqual(applied.result.archived, ['session-1', 'session-2'])
  assert.deepEqual(applied.result.failed, [])
  assert.equal(host.calls.archived.length, 2)
})

test('unarchive-session delegates to the host', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const applied = await act(host, store, workspace, 'unarchive-session', { sessionId: 'session-1' })
  assert.equal(applied.result.sessionId, 'session-1')
  assert.deepEqual(host.calls.unarchived[0], { sessionId: 'session-1' })
})

/* ------------------------------------------------------------------ */
/* execution settlement                                                */
/* ------------------------------------------------------------------ */

test('applyExecutionOutcome settles a doing node and detaches a failed one', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  const a = await addNode(host, store, workspace, { title: 'A' })
  const b = await addNode(host, store, workspace, { title: 'B', after: [a.node.id] })
  let graph = store.read(workspace).graph

  // Not doing yet: nothing applies.
  let settled = applyExecutionOutcome(graph, { nodeId: a.node.id, outcome: 'succeeded' })
  assert.equal(settled.result.applied, false)
  assert.equal(settled.result.reason, 'not-doing')

  await act(host, store, workspace, 'update-node', { nodeId: a.node.id, status: 'doing' })
  await act(host, store, workspace, 'attach-session', { nodeId: a.node.id, sessionId: 'session-run' })
  graph = store.read(workspace).graph

  // A human switched the session mid-run: the result must not settle the node.
  settled = applyExecutionOutcome(graph, {
    nodeId: a.node.id,
    outcome: 'succeeded',
    sessionId: 'session-other',
  })
  assert.equal(settled.result.applied, false)
  assert.equal(settled.result.reason, 'session-changed')

  settled = applyExecutionOutcome(graph, {
    nodeId: a.node.id,
    outcome: 'succeeded',
    sessionId: 'session-run',
  })
  assert.equal(settled.result.applied, true)
  assert.equal(findNode(settled.next, a.node.id).status, 'done')
  assert.equal(typeof findNode(settled.next, a.node.id).completedAt, 'string')
  assert.equal(settled.event.type, 'node/execution')

  // Reset to doing and fail: the failed node must not remain a prerequisite.
  let current = structuredClone(settled.next)
  current.nodes.find((node) => node.id === a.node.id).status = 'doing'
  current.nodes.find((node) => node.id === a.node.id).completedAt = null
  settled = applyExecutionOutcome(current, {
    nodeId: a.node.id,
    outcome: 'failed',
    sessionId: 'session-run',
  })
  assert.equal(settled.result.applied, true)
  assert.equal(findNode(settled.next, a.node.id).status, 'failed')
  assert.equal(settled.next.edges.length, 0)
  assert.equal(settled.result.detachedEdges[0].to, b.node.id)
  assert.equal(findNode(settled.next, b.node.id).conditions.length, 1)
})

/* ------------------------------------------------------------------ */
/* request plumbing                                                    */
/* ------------------------------------------------------------------ */

test('a stale revision is rejected with revision-conflict (409)', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()
  await addNode(host, store, workspace, { title: 'A' })

  await assert.rejects(
    applyAction(host.ctx, store, workspace, {
      action: 'add-node',
      expectedRevision: 0,
      payload: { title: 'B' },
    }),
    (error) => codeOf(error) === 'revision-conflict' && error.status === 409,
  )
})

test('unknown actions and malformed requests are invalid-request', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const host = fakeHost()

  await assert.rejects(
    applyAction(host.ctx, store, workspace, { action: 'nope', expectedRevision: 0, payload: {} }),
    (error) => codeOf(error) === 'invalid-request',
  )
  await assert.rejects(
    applyAction(host.ctx, store, workspace, { action: 'add-node', expectedRevision: -1, payload: { title: 'A' } }),
    (error) => codeOf(error) === 'invalid-request',
  )
  await assert.rejects(
    applyAction(host.ctx, store, workspace, { action: 'add-node', expectedRevision: 0, payload: [] }),
    (error) => codeOf(error) === 'invalid-request',
  )
  assert.equal(nodeWithTitle(store.read(workspace).graph, 'A'), undefined)
})
