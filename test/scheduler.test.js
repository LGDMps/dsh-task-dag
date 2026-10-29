/**
 * Unit tests for cron parsing, the execution brief and the per-node scheduler.
 *
 * Everything is fake: an in-memory store that mimics the graph store's
 * compare-and-swap commit, a fake Cordis context with a fake gateway, and fake
 * live session logs. No timers are awaited — `tick(now)` / `pollExecutions(now)`
 * are called directly with a fixed clock.
 *
 * Run: node test/scheduler.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isValidCron, nextRunAtMs, parseCron } from '../src/cron.js'
import { emptyGraph } from '../src/model.js'
import { GraphStore } from '../src/store.js'
import { TaskDagScheduler, buildExecutionBrief } from '../src/scheduler.js'

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const WORKSPACE = Object.freeze({
  id: 'ws_1',
  path: 'C:\\projects\\proj',
  title: 'proj',
  sessionIds: [],
})

/** Oct 29 2026 08:00 local — the fixed clock every test uses. */
const NOW = new Date(2026, 9, 29, 8, 0, 0, 0).getTime()
const FUTURE = new Date(2026, 9, 30, 9, 0, 0, 0).toISOString()

function makeSchedule(overrides = {}) {
  return {
    enabled: true,
    cron: '0 9 * * *',
    nextRunAt: '2000-01-01T00:00:00.000Z',
    lastTriggeredAt: null,
    lastFinishedAt: null,
    lastResult: null,
    lastError: null,
    lastSkippedReason: null,
    lastSessionId: null,
    ...overrides,
  }
}

function makeNode(overrides = {}) {
  return {
    id: 'n1',
    title: '任务一',
    status: 'todo',
    notes: '',
    conditions: [],
    sessions: [],
    position: null,
    agentPreset: null,
    model: null,
    schedule: makeSchedule(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    failedAt: null,
    ...overrides,
  }
}

function makeGraph(nodes, edges = []) {
  return {
    schemaVersion: 2,
    workspaceId: 'ws_1',
    workspacePath: WORKSPACE.path,
    title: 'proj',
    revision: 0,
    updatedAt: null,
    milestoneNodeId: null,
    nodes,
    edges,
  }
}

function condition(id, title) {
  return { id, title, createdAt: '2026-01-01T00:00:00.000Z' }
}

function activeSessionRecord(sessionId, slot = 1) {
  return {
    sessionId,
    slot,
    titleSnapshot: '任务一',
    attachedAt: '2026-01-01T00:00:00.000Z',
    retiredAt: null,
    handoff: { from: null, mode: 'manual' },
  }
}

/** In-memory GraphStore double with real CAS semantics. */
class FakeStore {
  constructor(graph) {
    this.graph = structuredClone(graph)
    this.commits = []
    this.onCommit = undefined
  }

  read() {
    return {
      graph: structuredClone(this.graph),
      path: `${WORKSPACE.path}\\.dsh-task-graph\\graph.json`,
      eventsPath: '',
      missing: false,
      warnings: [],
    }
  }

  async commit(_workspace, expectedRevision, produce) {
    const current = structuredClone(this.graph)
    if (expectedRevision !== current.revision) {
      const error = new Error('revision conflict')
      error.code = 'revision-conflict'
      throw error
    }
    const outcome = await produce(current)
    const next = outcome?.next ?? current
    next.revision = current.revision + 1
    this.graph = structuredClone(next)
    this.commits.push(outcome?.event)
    if (typeof this.onCommit === 'function') this.onCommit(outcome?.event)
    return structuredClone(next)
  }
}

function gatewayFixture({ log, failures = {}, running = [], sessions = {} }) {
  const calls = []
  let created = 0
  return {
    calls,
    async invoke(request) {
      calls.push(request)
      const { namespace, method } = request
      if (typeof log !== 'undefined') log.push(`invoke:${namespace}/${method}`)
      if (typeof failures[method] === 'string') throw new Error(failures[method])
      if (namespace === 'session' && method === 'create') {
        created += 1
        return { sessionId: `sess-${created}` }
      }
      if (namespace === 'session' && method === 'list') {
        return {
          items: Object.keys(sessions).map((sessionId) => ({
            sessionId,
            running: running.includes(sessionId),
            cwd: WORKSPACE.path,
            projections: { values: { title: sessionId } },
          })),
        }
      }
      return {}
    },
    async stream() {
      return (async function* empty() {})()
    },
  }
}

function makeScheduler(graph, { gateway, sessions = {}, log, running = [], failures = {} } = {}) {
  const store = new FakeStore(graph)
  const gatewayInstance = gateway ?? gatewayFixture({ log, failures, running, sessions })
  if (log !== undefined) {
    store.onCommit = (event) => log.push(`commit:${event?.type ?? 'none'}`)
  }
  const ctx = {
    typertGateway: gatewayInstance,
    sessions: { get: (sessionId) => sessions[sessionId] },
    workspaceRegistry: { list: () => [WORKSPACE], archivedSessionIds: [] },
  }
  const scheduler = new TaskDagScheduler(ctx, store, {
    now: () => NOW,
    tickMs: 10 * 60 * 1000,
    pollMs: 10 * 60 * 1000,
  })
  return { store, ctx, gateway: gatewayInstance, scheduler }
}

function graphOf(store) {
  return store.read().graph
}

function nodeOf(store, nodeId = 'n1') {
  return graphOf(store).nodes.find((node) => node.id === nodeId)
}

/* ------------------------------------------------------------------ */
/* cron                                                                */
/* ------------------------------------------------------------------ */

test('parseCron understands wildcards, lists, ranges and steps', () => {
  const schedule = parseCron('*/15 9-17 1,15 * 1-5')
  assert.ok(schedule !== null)
  assert.deepEqual([...schedule.minutes].sort((a, b) => a - b), [0, 15, 30, 45])
  assert.equal(schedule.hours.size, 9)
  assert.equal(schedule.hours.has(9), true)
  assert.equal(schedule.hours.has(17), true)
  assert.deepEqual([...schedule.days].sort((a, b) => a - b), [1, 15])
  assert.equal(schedule.months.size, 12)
  assert.deepEqual([...schedule.weekdays].sort((a, b) => a - b), [1, 2, 3, 4, 5])
  assert.equal(schedule.dayWildcard, false)
  assert.equal(schedule.weekdayWildcard, false)

  const weekly = parseCron('0 0 * * 7')
  assert.ok(weekly !== null)
  assert.deepEqual([...weekly.weekdays], [0], 'weekday 7 is normalized to Sunday 0')
  assert.equal(weekly.dayWildcard, true)
  assert.equal(weekly.weekdayWildcard, false)
})

test('parseCron rejects malformed expressions and isValidCron mirrors it', () => {
  const invalid = [
    '',
    '0 0 * *',
    '0 0 * * * *',
    '60 * * * *',
    '* 24 * * *',
    '0 0 0 * *',
    '0 0 32 * *',
    '0 0 * 13 *',
    '0 0 * * 8',
    '*/0 * * * *',
    '5-1 * * * *',
    'a * * * *',
    null,
    42,
  ]
  for (const expression of invalid) {
    assert.equal(parseCron(expression), null, `should reject ${JSON.stringify(expression)}`)
    assert.equal(isValidCron(expression), false)
  }
  assert.equal(isValidCron('0 9 * * 1-5'), true)
})

test('nextRunAtMs is strictly after the input and honours local wall time', () => {
  const nineAm = new Date(2026, 9, 29, 9, 0, 0, 0).getTime()
  // Exactly on the boundary: "strictly greater" means tomorrow, not today.
  assert.equal(nextRunAtMs('0 9 * * *', nineAm), new Date(2026, 9, 30, 9, 0, 0, 0).getTime())

  const tenOhFive = new Date(2026, 9, 29, 10, 5, 0, 0).getTime()
  assert.equal(nextRunAtMs('*/30 * * * *', tenOhFive), new Date(2026, 9, 29, 10, 30, 0, 0).getTime())
})

test('nextRunAtMs combines restricted day-of-month and weekday with OR', () => {
  // Sep 29 2026 is a Wednesday; the next "day 1 OR Monday" hit is Oct 1.
  const from = new Date(2026, 8, 29, 12, 0, 0, 0).getTime()
  assert.equal(nextRunAtMs('0 0 1 * 1', from), new Date(2026, 9, 1, 0, 0, 0, 0).getTime())
})

test('nextRunAtMs reaches leap day inside the five-year horizon', () => {
  const from = new Date(2026, 2, 1, 0, 0, 0, 0).getTime()
  assert.equal(nextRunAtMs('0 0 29 2 *', from), new Date(2028, 1, 29, 0, 0, 0, 0).getTime())
  assert.equal(nextRunAtMs('0 0 30 2 *', from), undefined)
  assert.equal(nextRunAtMs('not a cron', from), undefined)
})

/* ------------------------------------------------------------------ */
/* buildExecutionBrief                                                 */
/* ------------------------------------------------------------------ */

test('buildExecutionBrief renders the deterministic template with conditions', () => {
  const graph = makeGraph([
    makeNode({ id: 'pre-done', title: '需求评审', status: 'done' }),
    makeNode({ id: 'pre-open', title: '接口设计', status: 'doing' }),
    makeNode({
      id: 'n1',
      title: '当前任务',
      notes: '注意兼容旧格式',
      conditions: [condition('c1', '评审通过'), condition('c2', '设计完成')],
    }),
  ], [
    { id: 'e1', from: 'pre-done', to: 'n1', conditionId: 'c1' },
    { id: 'e2', from: 'pre-open', to: 'n1', conditionId: 'c2' },
  ])
  const node = graph.nodes[2]

  const first = buildExecutionBrief({ graph, node })
  const second = buildExecutionBrief({ graph, node })
  assert.equal(first, second, 'the brief must be deterministic')
  assert.match(first, /^# 定时执行：当前任务/)
  assert.match(first, /## 任务\n- 状态：待开始\n- 任务描述：注意兼容旧格式/)
  assert.match(first, /## 前置条件（全部满足才会触发）/)
  assert.match(first, /- 评审通过：已满足/)
  assert.match(first, /- 设计完成：等待 接口设计/)
  assert.match(first, /1\. 直接开始执行这个任务，不要只做计划。/)
  assert.match(first, /2\. 完成后调用 graph_update_node 把本节点状态改为 done/)
  assert.match(first, /3\. 需要人工决定时停下来提问。/)
})

test('buildExecutionBrief says a condition-free node can start directly', () => {
  const graph = makeGraph([makeNode({ id: 'n1', title: '独立任务' })])
  const text = buildExecutionBrief({ graph, node: graph.nodes[0] })
  assert.match(text, /- 任务描述：无/)
  assert.match(text, /- 无（无条件，可直接开始）/)
})

/* ------------------------------------------------------------------ */
/* tick: start path                                                    */
/* ------------------------------------------------------------------ */

test('tick starts a due node in the contract order and attaches the session', async () => {
  const log = []
  const previous = activeSessionRecord('sess-old')
  const graph = makeGraph([
    makeNode({
      id: 'n1',
      agentPreset: 'preset-a',
      model: 'openai/gpt-x',
      sessions: [previous],
    }),
  ])
  const { store, gateway, scheduler } = makeScheduler(graph, { log })

  await scheduler.tick(NOW)

  assert.deepEqual(log, [
    'invoke:session/list',
    'commit:schedule/trigger',
    'invoke:session/create',
    'invoke:session/selectModel',
    'commit:session/scheduled-attach',
    'invoke:session/rename',
    'invoke:session/prompt',
  ])

  const createCall = gateway.calls.find((call) => call.method === 'create')
  assert.deepEqual(createCall.args.request, { workspaceId: 'ws_1', agentPreset: 'preset-a' })
  const modelCall = gateway.calls.find((call) => call.method === 'selectModel')
  assert.deepEqual(modelCall.args.request, { sessionId: 'sess-1', provider: 'openai', model: 'gpt-x' })
  const promptCall = gateway.calls.find((call) => call.method === 'prompt')
  const promptText = promptCall.args.request.content[0].text
  assert.match(promptText, /^# 定时执行：任务一/)
  assert.match(promptText, /- 状态：待开始/)

  const node = nodeOf(store)
  assert.equal(node.status, 'doing')
  assert.equal(node.completedAt, null)
  assert.equal(node.failedAt, null)
  assert.equal(node.schedule.lastTriggeredAt, new Date(NOW).toISOString())
  assert.equal(node.schedule.nextRunAt, new Date(2026, 9, 29, 9, 0, 0, 0).toISOString())
  assert.equal(node.schedule.lastSessionId, 'sess-1')
  assert.equal(node.schedule.lastResult, null)

  assert.equal(node.sessions.length, 2)
  assert.notEqual(node.sessions[0].retiredAt, null)
  const currentRecord = node.sessions[1]
  assert.equal(currentRecord.sessionId, 'sess-1')
  assert.equal(currentRecord.retiredAt, null)
  assert.equal(currentRecord.slot, 2)
  assert.deepEqual(currentRecord.handoff, { from: 'sess-old', mode: 'scheduled' })

  const pending = scheduler.pendingExecutions()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].nodeId, 'n1')
  assert.equal(pending[0].sessionId, 'sess-1')
})

test('tick does nothing when the next run is still in the future', async () => {
  const graph = makeGraph([makeNode({ schedule: makeSchedule({ nextRunAt: FUTURE }) })])
  const { store, gateway, scheduler } = makeScheduler(graph, { log: [] })

  await scheduler.tick(NOW)

  assert.equal(store.commits.length, 0)
  assert.equal(gateway.calls.length, 0)
  assert.equal(nodeOf(store).status, 'todo')
})

/* ------------------------------------------------------------------ */
/* tick: skip rules                                                    */
/* ------------------------------------------------------------------ */

test('tick skips and records why when a prerequisite condition is waiting', async () => {
  const graph = makeGraph([
    makeNode({ id: 'pre', title: '前置任务', status: 'doing' }),
    makeNode({ id: 'n1', conditions: [condition('c1', '前置完成')] }),
  ], [{ id: 'e1', from: 'pre', to: 'n1', conditionId: 'c1' }])
  const { store, gateway, scheduler } = makeScheduler(graph, { log: [] })

  await scheduler.tick(NOW)

  assert.equal(gateway.calls.length, 0, 'no session is created for a skipped node')
  const node = nodeOf(store)
  assert.equal(node.status, 'todo')
  assert.equal(node.schedule.lastResult, 'skipped')
  assert.match(node.schedule.lastSkippedReason, /前置条件未满足：前置完成/)
  assert.equal(node.schedule.nextRunAt, new Date(2026, 9, 29, 9, 0, 0, 0).toISOString())
})

test('tick skips any node that is not todo', async () => {
  for (const status of ['planned', 'doing', 'done', 'failed']) {
    const graph = makeGraph([
      makeNode({
        status,
        completedAt: status === 'done' ? '2026-01-02T00:00:00.000Z' : null,
        failedAt: status === 'failed' ? '2026-01-02T00:00:00.000Z' : null,
      }),
    ])
    const { store, gateway, scheduler } = makeScheduler(graph, { log: [] })

    await scheduler.tick(NOW)

    assert.equal(gateway.calls.length, 0, `${status} must not auto-run`)
    const node = nodeOf(store)
    assert.equal(node.status, status)
    assert.equal(node.schedule.lastResult, 'skipped')
    assert.match(node.schedule.lastSkippedReason, /待开始/)
  }
})

test('tick skips when the node already has a running current session', async () => {
  const graph = makeGraph([
    makeNode({ sessions: [activeSessionRecord('sess-live')] }),
  ])
  const { store, gateway, scheduler } = makeScheduler(graph, {
    log: [],
    sessions: { 'sess-live': { log: [] } },
    running: ['sess-live'],
  })

  await scheduler.tick(NOW)

  assert.equal(gateway.calls.filter((call) => call.method === 'create').length, 0)
  const node = nodeOf(store)
  assert.equal(node.schedule.lastResult, 'skipped')
  assert.match(node.schedule.lastSkippedReason, /已有会话正在运行/)
})

test('tick skips with a readable reason when the host has no gateway', async () => {
  const graph = makeGraph([makeNode()])
  const store = new FakeStore(graph)
  const ctx = { workspaceRegistry: { list: () => [WORKSPACE] }, sessions: { get: () => undefined } }
  const scheduler = new TaskDagScheduler(ctx, store, { now: () => NOW })

  await assert.doesNotReject(() => scheduler.tick(NOW))

  const node = nodeOf(store)
  assert.equal(node.schedule.lastResult, 'skipped')
  assert.match(node.schedule.lastSkippedReason, /会话网关/)
})

/* ------------------------------------------------------------------ */
/* tick: launch failures roll back                                     */
/* ------------------------------------------------------------------ */

test('a failed session creation rolls the node back and records lastError', async () => {
  const graph = makeGraph([makeNode()])
  const { store, scheduler } = makeScheduler(graph, { log: [], failures: { create: 'create failed' } })

  await scheduler.tick(NOW)

  const node = nodeOf(store)
  assert.equal(node.status, 'todo')
  assert.equal(node.sessions.length, 0)
  assert.equal(node.schedule.lastResult, 'failed')
  assert.match(node.schedule.lastError, /create failed/)
  assert.equal(node.schedule.lastSessionId, null)
  assert.equal(scheduler.pendingExecutions().length, 0)
  assert.ok(store.commits.some((event) => event?.type === 'schedule/launch-failed'))
})

test('a failed prompt keeps the attached session retired and returns the node to todo', async () => {
  const graph = makeGraph([
    makeNode({ sessions: [activeSessionRecord('sess-old')] }),
  ])
  const { store, scheduler } = makeScheduler(graph, { log: [], failures: { prompt: 'prompt failed' } })

  await scheduler.tick(NOW)

  const node = nodeOf(store)
  assert.equal(node.status, 'todo')
  assert.equal(node.schedule.lastResult, 'failed')
  assert.match(node.schedule.lastError, /prompt failed/)
  assert.equal(node.schedule.lastSessionId, null)
  const attached = node.sessions.find((record) => record.sessionId === 'sess-1')
  assert.ok(attached !== undefined, 'the created session stays in the chain')
  assert.notEqual(attached.retiredAt, null, 'but it is retired, not current')
  assert.equal(scheduler.pendingExecutions().length, 0)
})

/* ------------------------------------------------------------------ */
/* settlement                                                          */
/* ------------------------------------------------------------------ */

function doingGraph({ edges = [], sessions, nextRunAt = FUTURE } = {}) {
  return makeGraph([
    makeNode({
      id: 'n1',
      status: 'doing',
      schedule: makeSchedule({ nextRunAt, lastSessionId: 'sess-run', lastTriggeredAt: new Date(NOW).toISOString() }),
      sessions: sessions ?? [activeSessionRecord('sess-run')],
    }),
    makeNode({ id: 'n2', title: '后继任务', conditions: [condition('c2', '任务一完成')] }),
  ].slice(0, edges.length > 0 ? 2 : 1), edges)
}

const TURN_END_OK = {
  type: 'turn/end',
  seq: 5,
  time: 1,
  data: { reason: { kind: 'completed' } },
}

test('turn/end success settles the node as done and records the schedule result', async () => {
  const logs = {
    'sess-run': {
      log: [
        { type: 'turn/start', seq: 1, time: 1, data: {} },
        { type: 'user/message', seq: 2, time: 2, data: { text: '开始' } },
        { type: 'assistant/message', seq: 3, time: 3, data: { text: '做完了' } },
        TURN_END_OK,
      ],
    },
  }
  const graph = doingGraph()
  const { store, scheduler } = makeScheduler(graph, { log: [], sessions: logs, running: [] })

  await scheduler.tick(NOW)
  assert.equal(scheduler.pendingExecutions().length, 1, 'restart recovery adopts the doing node')

  const settledAt = NOW + 5_000
  await scheduler.pollExecutions(settledAt)

  const node = nodeOf(store)
  assert.equal(node.status, 'done')
  assert.equal(node.completedAt, new Date(settledAt).toISOString())
  assert.equal(node.failedAt, null)
  assert.equal(node.schedule.lastResult, 'succeeded')
  assert.equal(node.schedule.lastFinishedAt, new Date(settledAt).toISOString())
  assert.equal(node.schedule.lastError, null)
  assert.equal(scheduler.pendingExecutions().length, 0)
  assert.ok(store.commits.some((event) => event?.type === 'node/execution'))
})

test('turn/end error settles the node as failed and detaches its outgoing edges', async () => {
  const logs = {
    'sess-run': {
      log: [
        { type: 'turn/start', seq: 1, time: 1, data: {} },
        { type: 'turn/end', seq: 2, time: 2, data: { reason: { kind: 'error', message: '模型调用失败' } } },
      ],
    },
  }
  const graph = makeGraph([
    makeNode({
      id: 'n1',
      status: 'doing',
      schedule: makeSchedule({ nextRunAt: FUTURE, lastSessionId: 'sess-run' }),
      sessions: [activeSessionRecord('sess-run')],
    }),
    makeNode({ id: 'n2', title: '后继任务', conditions: [condition('c2', '任务一完成')] }),
  ], [{ id: 'e1', from: 'n1', to: 'n2', conditionId: 'c2' }])
  const { store, scheduler } = makeScheduler(graph, { log: [], sessions: logs, running: [] })

  await scheduler.tick(NOW)
  await scheduler.pollExecutions(NOW + 5_000)

  const graphAfter = graphOf(store)
  const node = graphAfter.nodes.find((item) => item.id === 'n1')
  assert.equal(node.status, 'failed')
  assert.equal(node.failedAt, new Date(NOW + 5_000).toISOString())
  assert.equal(node.completedAt, null)
  assert.equal(node.schedule.lastResult, 'failed')
  assert.match(node.schedule.lastError, /模型调用失败/)
  assert.deepEqual(graphAfter.edges, [], 'a failed node may not keep outgoing edges')
  assert.equal(scheduler.pendingExecutions().length, 0)
})

test('a running execution stays pending and is not settled early', async () => {
  const logs = { 'sess-run': { log: [TURN_END_OK] } }
  const graph = doingGraph()
  const { store, scheduler } = makeScheduler(graph, {
    log: [],
    sessions: logs,
    running: ['sess-run'],
  })

  await scheduler.tick(NOW)
  const before = nodeOf(store).status
  await scheduler.pollExecutions(NOW + 5_000)

  assert.equal(nodeOf(store).status, before)
  assert.equal(scheduler.pendingExecutions().length, 1)
})

test('startup re-adopts a doing node from schedule.lastSessionId', () => {
  const graph = doingGraph()
  const store = new FakeStore(graph)
  const ctx = {
    typertGateway: gatewayFixture({ log: [] }),
    sessions: { get: () => undefined },
    workspaceRegistry: { list: () => [WORKSPACE] },
  }
  const scheduler = new TaskDagScheduler(ctx, store, { now: () => NOW })

  scheduler.start()
  const pending = scheduler.pendingExecutions()
  assert.equal(pending.length, 1)
  assert.deepEqual(
    { nodeId: pending[0].nodeId, sessionId: pending[0].sessionId },
    { nodeId: 'n1', sessionId: 'sess-run' },
  )
  scheduler.dispose()
  assert.equal(scheduler.pendingExecutions().length, 0)
})

test('a second start returns a disposer and dispose clears timers', () => {
  const graph = makeGraph([makeNode()])
  const store = new FakeStore(graph)
  const scheduler = new TaskDagScheduler({ workspaceRegistry: { list: () => [WORKSPACE] } }, store, {
    now: () => NOW,
  })
  const first = scheduler.start()
  const second = scheduler.start()
  assert.equal(typeof first, 'function')
  assert.equal(typeof second, 'function')
  first()
  second()
  assert.equal(scheduler.timers.length, 0)
  assert.equal(scheduler.disposed, true)
})

/* ------------------------------------------------------------------ */
/* real store integration (temp workspace on disk)                     */
/* ------------------------------------------------------------------ */

test('tick and settlement work against the real GraphStore and real ops', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-task-dag-scheduler-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))

  const workspace = { workspaceId: 'ws_real', path: base, title: 'real', sessionIds: [] }
  const store = new GraphStore()
  const graph = emptyGraph({ workspaceId: 'ws_real', workspacePath: base, title: 'real' })
  graph.nodes.push(makeNode({
    id: 'n1',
    title: '真实任务',
    schedule: makeSchedule({ cron: '0 9 * * *', nextRunAt: '2000-01-01T00:00:00.000Z' }),
  }))
  await store.commit(workspace, 0, () => ({ next: graph, event: { type: 'test/seed' } }))

  const sessions = {}
  const gateway = gatewayFixture({ log: [], sessions })
  const ctx = {
    typertGateway: gateway,
    sessions: { get: (sessionId) => sessions[sessionId] },
    workspaceRegistry: { list: () => [workspace], archivedSessionIds: [] },
  }
  const scheduler = new TaskDagScheduler(ctx, store, { now: () => NOW })

  await scheduler.tick(NOW)

  const launched = store.read(workspace).graph
  const launchedNode = launched.nodes.find((node) => node.id === 'n1')
  assert.equal(launchedNode.status, 'doing')
  assert.equal(launchedNode.schedule.lastSessionId, 'sess-1')
  assert.equal(launchedNode.sessions[0].handoff.mode, 'scheduled')
  assert.equal(scheduler.pendingExecutions().length, 1)

  sessions['sess-1'] = {
    log: [
      { type: 'turn/start', seq: 1, time: 1, data: {} },
      { type: 'turn/end', seq: 2, time: 2, data: { reason: { kind: 'completed' } } },
    ],
  }
  await scheduler.pollExecutions(NOW + 5_000)

  const settledNode = store.read(workspace).graph.nodes.find((node) => node.id === 'n1')
  assert.equal(settledNode.status, 'done')
  assert.equal(settledNode.completedAt, new Date(NOW + 5_000).toISOString())
  assert.equal(settledNode.schedule.lastResult, 'succeeded')
  assert.equal(scheduler.pendingExecutions().length, 0)
})
