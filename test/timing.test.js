/**
 * Timing-window tests: the task's own earliest start, per-run limit and
 * absolute deadline. There is deliberately no cron/auto-launch test any more:
 * the plugin does not schedule work, it only pauses a run that outlives its
 * window.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GraphStore } from '../src/store.js'
import { emptyGraph, findNode } from '../src/model.js'
import {
  effectiveTimingDeadline,
  eventTimeMs,
  runStartedAtFromEvents,
  TaskTimingWatcher,
} from '../src/timing.js'

const NOW = Date.parse('2026-11-11T12:00:00.000Z')
const T0 = new Date(NOW - 3 * 60 * 60 * 1000).toISOString()

async function makeWorkspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'task-dag-timing-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return { workspaceId: 'ws_timing', path: dir, title: 'timing' }
}

function makeGraph(workspace, options = {}) {
  const graph = emptyGraph({
    workspaceId: workspace.workspaceId,
    workspacePath: workspace.path,
    title: workspace.title,
  })
  graph.nodes.push({
    id: 'n_a',
    title: '长任务',
    status: options.status ?? 'doing',
    notes: '',
    conditions: [],
    sessions: [{
      sessionId: 's1',
      slot: 1,
      titleSnapshot: '长任务',
      attachedAt: T0,
      retiredAt: null,
      handoff: { from: null, mode: 'manual' },
    }],
    position: null,
    agentPreset: null,
    model: null,
    reasoningEffort: null,
    timing: options.timing ?? null,
    createdAt: T0,
    updatedAt: T0,
    completedAt: options.status === 'done' ? T0 : null,
    failedAt: options.status === 'failed' ? T0 : null,
  })
  return graph
}

function fakeContext(workspace, options = {}) {
  const calls = { canceled: [], list: 0 }
  const summary = {
    sessionId: 's1',
    running: options.running !== false,
    updatedAt: options.updatedAt ?? NOW - 5 * 60 * 1000,
    projections: {
      values: {
        title: '长任务',
        contextPressure: { ratio: 0.2, contextWindow: 100000, projectedTokens: 20000 },
      },
    },
  }
  const gateway = {
    async invoke(request) {
      const { namespace, method, args } = request
      if (namespace === 'session' && method === 'list') {
        calls.list += 1
        return { items: [summary] }
      }
      if (namespace === 'session' && method === 'cancel') {
        if (options.failCancel === true) throw new Error('cancel unavailable')
        calls.canceled.push(args?.request?.sessionId)
        return { accepted: true }
      }
      return {}
    },
  }
  const logs = options.logs ?? {}
  const ctx = {
    typertGateway: gateway,
    workspaceRegistry: { list: () => [workspace] },
    sessions: {
      get(sessionId) {
        const log = logs[sessionId]
        return log === undefined ? undefined : { log }
      },
    },
  }
  return { ctx, calls }
}

async function seed(store, workspace, graph) {
  await store.commit(workspace, 0, () => ({ next: graph }))
}

test('event timing and run-start extraction are robust to seconds and ISO strings', () => {
  assert.equal(eventTimeMs(1_700_000_000_000), 1_700_000_000_000)
  assert.equal(eventTimeMs(1_700_000_000), 1_700_000_000_000)
  assert.equal(eventTimeMs('2026-11-11T12:00:00.000Z'), Date.parse('2026-11-11T12:00:00.000Z'))
  assert.equal(eventTimeMs(1), null)

  assert.equal(runStartedAtFromEvents([
    { type: 'turn/start', time: 1_700_000_000_000 },
    { type: 'turn/end', time: 1_700_000_100_000 },
  ]), null)
  assert.equal(runStartedAtFromEvents([
    { type: 'turn/start', time: 1_700_000_000_000 },
    { type: 'turn/end', time: 1_700_000_100_000 },
    { type: 'turn/start', time: 1_700_000_200_000 },
  ]), 1_700_000_200_000)
  assert.equal(runStartedAtFromEvents([]), null)

  const timing = { maxRunMinutes: 60, deadlineAt: '2026-11-11T13:30:00.000Z' }
  assert.deepEqual(effectiveTimingDeadline(timing, Date.parse('2026-11-11T12:00:00.000Z')), {
    reason: 'run-limit',
    at: Date.parse('2026-11-11T13:00:00.000Z'),
  })
  assert.deepEqual(effectiveTimingDeadline(timing, Date.parse('2026-11-11T12:45:00.000Z')), {
    reason: 'deadline',
    at: Date.parse('2026-11-11T13:30:00.000Z'),
  })
  assert.equal(effectiveTimingDeadline(null, NOW), null)
})

test('a run that exceeds its per-run limit is cancelled and returned to todo', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const runStart = NOW - 61 * 60 * 1000
  await seed(store, workspace, makeGraph(workspace, {
    timing: { startAt: null, deadlineAt: null, maxRunMinutes: 60, lastTimeoutAt: null, lastTimeoutReason: null },
  }))
  const { ctx, calls } = fakeContext(workspace, {
    updatedAt: runStart,
    logs: { s1: [{ type: 'turn/start', time: runStart, seq: 1, data: {} }] },
  })
  const watcher = new TaskTimingWatcher(ctx, store, { now: () => NOW, tickMs: 60_000 })
  await watcher.tick(NOW)

  assert.deepEqual(calls.canceled, ['s1'], 'the active turn is cancelled')
  const node = findNode(store.read(workspace).graph, 'n_a')
  assert.equal(node.status, 'todo', 'the node is paused, not failed')
  assert.equal(node.sessions.length, 1, 'the session chain is preserved')
  assert.equal(node.sessions[0].retiredAt, null, 'the session remains current')
  assert.equal(node.timing.lastTimeoutReason, 'run-limit')
  assert.equal(node.timing.lastTimeoutAt, new Date(NOW).toISOString())
})

test('an absolute deadline cancels even when the run limit is not set', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const deadlineAt = new Date(NOW - 60_000).toISOString()
  await seed(store, workspace, makeGraph(workspace, {
    timing: { startAt: null, deadlineAt, maxRunMinutes: null, lastTimeoutAt: null, lastTimeoutReason: null },
  }))
  const { ctx, calls } = fakeContext(workspace)
  const watcher = new TaskTimingWatcher(ctx, store, { now: () => NOW })
  await watcher.tick(NOW)

  assert.deepEqual(calls.canceled, ['s1'])
  const node = findNode(store.read(workspace).graph, 'n_a')
  assert.equal(node.status, 'todo')
  assert.equal(node.timing.lastTimeoutReason, 'deadline')
})

test('nothing happens before the cutoff or when the session is idle', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const runStart = NOW - 30 * 60 * 1000
  await seed(store, workspace, makeGraph(workspace, {
    timing: { startAt: null, deadlineAt: null, maxRunMinutes: 60, lastTimeoutAt: null, lastTimeoutReason: null },
  }))
  const running = fakeContext(workspace, {
    updatedAt: runStart,
    logs: { s1: [{ type: 'turn/start', time: runStart, seq: 1, data: {} }] },
  })
  await new TaskTimingWatcher(running.ctx, store, { now: () => NOW }).tick(NOW)
  assert.deepEqual(running.calls.canceled, [], '30 minutes into a 60 minute run is still allowed')

  const idle = fakeContext(workspace, { running: false })
  await new TaskTimingWatcher(idle.ctx, store, { now: () => NOW + 2 * 60 * 60 * 1000 }).tick(NOW + 2 * 60 * 60 * 1000)
  assert.deepEqual(idle.calls.canceled, [], 'an idle session has no turn to cancel')
  assert.equal(findNode(store.read(workspace).graph, 'n_a').status, 'doing')
})

test('the session updatedAt is a fallback when no turn/start is in the window', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const runStart = NOW - 90 * 60 * 1000
  await seed(store, workspace, makeGraph(workspace, {
    timing: { startAt: null, deadlineAt: null, maxRunMinutes: 60, lastTimeoutAt: null, lastTimeoutReason: null },
  }))
  const { ctx, calls } = fakeContext(workspace, { updatedAt: runStart })
  await new TaskTimingWatcher(ctx, store, { now: () => NOW }).tick(NOW)
  assert.deepEqual(calls.canceled, ['s1'])
})

test('a failed cancel leaves the node doing so the next scan can retry', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  const deadlineAt = new Date(NOW - 60_000).toISOString()
  await seed(store, workspace, makeGraph(workspace, {
    timing: { startAt: null, deadlineAt, maxRunMinutes: null, lastTimeoutAt: null, lastTimeoutReason: null },
  }))
  const { ctx, calls } = fakeContext(workspace, { failCancel: true })
  await new TaskTimingWatcher(ctx, store, { now: () => NOW }).tick(NOW)
  assert.deepEqual(calls.canceled, [])
  const node = findNode(store.read(workspace).graph, 'n_a')
  assert.equal(node.status, 'doing')
  assert.equal(node.timing.lastTimeoutReason, null)
})

test('a node with no timing window is never touched', async (t) => {
  const workspace = await makeWorkspace(t)
  const store = new GraphStore()
  await seed(store, workspace, makeGraph(workspace, { timing: null }))
  const { ctx, calls } = fakeContext(workspace)
  await new TaskTimingWatcher(ctx, store, { now: () => NOW }).tick(NOW)
  assert.deepEqual(calls.canceled, [])
  assert.equal(findNode(store.read(workspace).graph, 'n_a').status, 'doing')
})
