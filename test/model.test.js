import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STATUSES,
  STATUS_LABELS,
  activeSession,
  assertInvariants,
  autoLayout,
  cloneGraph,
  conditionOf,
  conditionsOf,
  derive,
  emptyGraph,
  findNode,
  layoutLevels,
  newId,
  nextSlot,
  normalizeGraph,
  nowIso,
  prereqsOf,
  satisfiersOf,
  sessionOwner,
  spliceIncoming,
  successorsOf,
  unlinkIncoming,
  wouldCreateCycle,
} from '../src/model.js'
import { CODES } from '../src/errors.js'

const T0 = '2026-10-28T11:00:00.000Z'

function makeNode(id, extra = {}) {
  return {
    id,
    title: `任务 ${id}`,
    status: 'todo',
    notes: '',
    conditions: [],
    sessions: [],
    position: null,
    agentPreset: null,
    model: null,
    reasoningEffort: null,
    schedule: null,
    createdAt: T0,
    updatedAt: T0,
    completedAt: null,
    failedAt: null,
    ...extra,
  }
}

function makeSession(sessionId, slot, extra = {}) {
  return {
    sessionId,
    slot,
    titleSnapshot: '任务',
    attachedAt: T0,
    retiredAt: null,
    handoff: { from: null, mode: 'manual' },
    ...extra,
  }
}

/** Build a graph; `edges` is either [from,to] pairs (auto condition) or explicit records. */
function makeGraph(nodes, edges = [], extra = {}) {
  const graph = emptyGraph({ workspaceId: 'ws_test', workspacePath: 'C:\\tmp\\proj', title: 'Proj' })
  graph.nodes = nodes
  graph.edges = edges.map((entry, index) => {
    if (Array.isArray(entry)) {
      const [from, to] = entry
      const target = nodes.find((node) => node.id === to)
      const condition = { id: `c_${index}`, title: `条件 ${index}`, createdAt: T0 }
      target.conditions.push(condition)
      return { id: `e_${index}`, from, to, conditionId: condition.id }
    }
    return entry
  })
  return { ...graph, ...extra }
}

function throwsCode(fn, code, message) {
  assert.throws(
    fn,
    (error) => {
      assert.equal(error?.name, 'TaskDagError', message)
      assert.equal(error?.code, code, message)
      return true
    },
    message,
  )
}

test('emptyGraph() is a v2 document and derive() tolerates it', () => {
  const graph = emptyGraph({ workspaceId: 'ws_1', workspacePath: 'C:\\p', title: 'P' })
  assert.equal(graph.schemaVersion, 2)
  assert.equal(graph.revision, 0)
  assert.equal(graph.milestoneNodeId, null)
  assert.deepEqual(graph.nodes, [])
  assert.deepEqual(graph.edges, [])

  const derived = derive(graph)
  assert.deepEqual(derived.ready, [])
  assert.deepEqual(derived.blocked, [])
  assert.deepEqual(derived.planned, [])
  assert.deepEqual(derived.failed, [])
  assert.deepEqual(derived.conditions, {})
  assert.deepEqual(derived.progress, {
    done: 0,
    total: 0,
    ready: 0,
    blocked: 0,
    doing: 0,
    failed: 0,
    planned: 0,
  })
  assert.equal(derived.milestone, null)
})

test('the five statuses are the task-board columns with Chinese labels', () => {
  assert.deepEqual([...STATUSES], ['planned', 'todo', 'doing', 'done', 'failed'])
  assert.equal(STATUS_LABELS.planned, '待规划')
  assert.equal(STATUS_LABELS.todo, '待开始')
  assert.equal(STATUS_LABELS.doing, '进行中')
  assert.equal(STATUS_LABELS.done, '已完成')
  assert.equal(STATUS_LABELS.failed, '已失败')
})

test('conditions gate readiness; only done satisfiers count; ANY semantics', () => {
  // A and B both satisfy c1 of C (an OR), c2 of C is satisfied by D.
  const graph = makeGraph(
    [makeNode('n_a'), makeNode('n_b'), makeNode('n_c'), makeNode('n_d')],
    [['n_a', 'n_c'], ['n_b', 'n_c'], ['n_d', 'n_c']],
  )
  // Put A and B edges on the same condition to exercise OR.
  graph.nodes.find((node) => node.id === 'n_c').conditions = [
    { id: 'c_shared', title: '任一上游完成', createdAt: T0 },
    { id: 'c_d', title: 'D 完成', createdAt: T0 },
  ]
  graph.edges = [
    { id: 'e_a', from: 'n_a', to: 'n_c', conditionId: 'c_shared' },
    { id: 'e_b', from: 'n_b', to: 'n_c', conditionId: 'c_shared' },
    { id: 'e_d', from: 'n_d', to: 'n_c', conditionId: 'c_d' },
  ]

  let derived = derive(graph)
  assert.deepEqual(derived.blocked, ['n_c'])
  assert.equal(derived.conditions.n_c[0].satisfied, false)
  assert.equal(derived.conditions.n_c[0].linked.length, 2)

  graph.nodes.find((node) => node.id === 'n_a').status = 'done'
  derived = derive(graph)
  assert.equal(derived.conditions.n_c[0].satisfied, true, 'one done satisfier is enough')
  assert.deepEqual(derived.conditions.n_c[0].waiting.map((item) => item.id), ['n_b'])
  assert.deepEqual(derived.blocked, ['n_c'], 'the second condition is still unmet')

  graph.nodes.find((node) => node.id === 'n_d').status = 'done'
  derived = derive(graph)
  assert.deepEqual(derived.ready, ['n_b', 'n_c'])
  assert.deepEqual(derived.blocked, [])
  assert.equal(derived.progress.ready, 2)
})

test('a node with no conditions is ready; planned nodes are not startable', () => {
  const graph = makeGraph([
    makeNode('n_a'),
    makeNode('n_b', { status: 'planned' }),
    makeNode('n_c', { status: 'doing' }),
    makeNode('n_d', { status: 'failed', failedAt: T0 }),
    makeNode('n_e', { status: 'done', completedAt: T0 }),
  ])
  const derived = derive(graph)
  assert.deepEqual(derived.ready, ['n_a'])
  assert.deepEqual(derived.planned, ['n_b'])
  assert.deepEqual(derived.doing, ['n_c'])
  assert.deepEqual(derived.failed, ['n_d'])
  assert.deepEqual(derived.done, ['n_e'])
  assert.deepEqual(derived.blocked, [])
})

test('an unsatisfied condition with no satisfiers blocks the node on purpose', () => {
  const graph = makeGraph([
    makeNode('n_a', { conditions: [{ id: 'c_1', title: '外部审批通过', createdAt: T0 }] }),
  ])
  const derived = derive(graph)
  assert.deepEqual(derived.blocked, ['n_a'])
  assert.deepEqual(derived.conditions.n_a[0].linked, [])
  assert.equal(derived.conditions.n_a[0].satisfied, false)
})

test('a milestone is a marker: it may be a prerequisite but never ends the project', () => {
  const graph = makeGraph(
    [makeNode('n_a'), makeNode('n_m', { status: 'done', completedAt: T0 }), makeNode('n_z')],
    [['n_m', 'n_z']],
  )
  graph.milestoneNodeId = 'n_m'
  const derived = derive(graph)
  assert.deepEqual(derived.progress, {
    done: 1,
    total: 3,
    ready: 2,
    blocked: 0,
    doing: 0,
    failed: 0,
    planned: 0,
  })
  assert.equal('milestoneDone' in derived.progress, false, 'progress has no project-completion flag')
  assert.deepEqual(derived.milestone, { id: 'n_m', title: '任务 n_m', status: 'done', done: true })
  assert.deepEqual(derived.ready, ['n_a', 'n_z'], 'milestone may satisfy a downstream condition')

  graph.nodes.find((node) => node.id === 'n_m').status = 'todo'
  graph.nodes.find((node) => node.id === 'n_m').completedAt = null
  const reopened = derive(graph)
  assert.deepEqual(reopened.milestone, {
    id: 'n_m', title: '任务 n_m', status: 'todo', done: false,
  }, 'milestone.done is only the node status fact')
  assert.equal('milestoneDone' in reopened.progress, false, 'no completion flag appears either way')
})

test('progress has no project-completion flag even when every node is done', () => {
  const graph = makeGraph([makeNode('n_a'), makeNode('n_b')])
  assert.equal('milestoneDone' in derive(graph).progress, false)
  for (const node of graph.nodes) {
    node.status = 'done'
    node.completedAt = T0
  }
  const derived = derive(graph)
  assert.deepEqual(derived.progress, {
    done: 2,
    total: 2,
    ready: 0,
    blocked: 0,
    doing: 0,
    failed: 0,
    planned: 0,
  })
  assert.equal('milestoneDone' in derived.progress, false, 'all-done is a count, not a completion flag')
  assert.equal('allDone' in derived.progress, false, 'no replacement flag is introduced')
})

test('two edges may connect the same pair through different conditions', () => {
  const graph = makeGraph([makeNode('n_a'), makeNode('n_b')], [
    { id: 'e_1', from: 'n_a', to: 'n_b', conditionId: 'c_1' },
    { id: 'e_2', from: 'n_a', to: 'n_b', conditionId: 'c_2' },
  ])
  graph.nodes[1].conditions = [
    { id: 'c_1', title: '条件一', createdAt: T0 },
    { id: 'c_2', title: '条件二', createdAt: T0 },
  ]
  assertInvariants(graph)
  assert.deepEqual(prereqsOf(graph, 'n_b').map((edge) => edge.conditionId), ['c_1', 'c_2'])
  assert.deepEqual(satisfiersOf(graph, 'n_b', 'c_2').map((edge) => edge.from), ['n_a'])
  assert.deepEqual(derive(graph).levels, { n_a: 0, n_b: 1 })
})

test('wouldCreateCycle sees direct, indirect and self cycles', () => {
  const graph = makeGraph([makeNode('n_a'), makeNode('n_b'), makeNode('n_c')], [
    ['n_a', 'n_b'],
    ['n_b', 'n_c'],
  ])
  assert.equal(wouldCreateCycle(graph, 'n_c', 'n_a'), true)
  assert.equal(wouldCreateCycle(graph, 'n_b', 'n_a'), true)
  assert.equal(wouldCreateCycle(graph, 'n_a', 'n_a'), true)
  assert.equal(wouldCreateCycle(graph, 'n_a', 'n_c'), false)
})

test('assertInvariants rejects a failed prerequisite, duplicate triples and bad conditions', () => {
  const healthy = makeGraph([makeNode('n_a'), makeNode('n_b')], [['n_a', 'n_b']])
  assert.equal(assertInvariants(healthy), true)

  const failedSource = structuredClone(healthy)
  failedSource.nodes[0].status = 'failed'
  failedSource.nodes[0].failedAt = T0
  throwsCode(() => assertInvariants(failedSource), CODES.invariant, 'failed source rejected')

  const duplicate = structuredClone(healthy)
  duplicate.edges.push({ ...duplicate.edges[0], id: 'e_extra' })
  throwsCode(() => assertInvariants(duplicate), CODES.invariant, 'duplicate triple rejected')

  const missingCondition = structuredClone(healthy)
  missingCondition.edges[0].conditionId = 'c_missing'
  throwsCode(() => assertInvariants(missingCondition), CODES.invariant, 'unknown condition rejected')

  const selfEdge = structuredClone(healthy)
  selfEdge.edges.push({ id: 'e_self', from: 'n_b', to: 'n_b', conditionId: 'c_x' })
  throwsCode(() => assertInvariants(selfEdge), CODES.invariant, 'self edge rejected')

  const badStatus = structuredClone(healthy)
  badStatus.nodes[0].status = 'archived'
  throwsCode(() => assertInvariants(badStatus), CODES.invariant, 'unknown status rejected')

  const bothTerminal = structuredClone(healthy)
  bothTerminal.nodes[0].status = 'failed'
  bothTerminal.nodes[0].failedAt = T0
  bothTerminal.nodes[0].completedAt = T0
  throwsCode(() => assertInvariants(bothTerminal), CODES.invariant, 'both terminal timestamps rejected')

  const badSchedule = structuredClone(healthy)
  badSchedule.nodes[0].schedule = {
    enabled: true,
    cron: '* * * * *',
    nextRunAt: T0,
    lastTriggeredAt: null,
    lastFinishedAt: null,
    lastResult: 'exploded',
    lastError: null,
    lastSkippedReason: null,
    lastSessionId: null,
  }
  throwsCode(() => assertInvariants(badSchedule), CODES.invariant, 'unknown schedule result rejected')
})

test('normalizeGraph migrates a v1 document to conditions and a milestone', () => {
  const v1 = {
    schemaVersion: 1,
    workspaceId: 'ws_test',
    workspacePath: 'C:\\tmp\\proj',
    title: 'Proj',
    revision: 7,
    updatedAt: T0,
    closeoutNodeId: 'n_c',
    nodes: [
      {
        id: 'n_a',
        title: 'A',
        status: 'done',
        notes: '',
        sessions: [],
        position: null,
        createdAt: T0,
        updatedAt: T0,
        completedAt: T0,
      },
      {
        id: 'n_b',
        title: 'B',
        status: 'todo',
        notes: '',
        sessions: [],
        position: null,
        createdAt: T0,
        updatedAt: T0,
        completedAt: null,
      },
      {
        id: 'n_c',
        title: 'C',
        status: 'todo',
        notes: '',
        sessions: [],
        position: null,
        createdAt: T0,
        updatedAt: T0,
        completedAt: null,
      },
    ],
    edges: [
      { id: 'e_1', from: 'n_a', to: 'n_b' },
      { id: 'e_2', from: 'n_b', to: 'n_c' },
    ],
  }

  const graph = normalizeGraph(v1)
  assert.equal(graph.schemaVersion, 2)
  assert.equal(graph.revision, 7)
  assert.equal(graph.milestoneNodeId, 'n_c')
  assert.equal(graph.nodes[1].conditions.length, 1)
  assert.equal(graph.nodes[1].conditions[0].title, 'A 完成')
  assert.equal(graph.edges[0].conditionId, graph.nodes[1].conditions[0].id)
  assert.equal(graph.nodes[0].agentPreset, null)
  assert.equal(graph.nodes[0].model, null)
  assert.equal(graph.nodes[0].reasoningEffort, null)
  assert.equal(graph.nodes[0].schedule, null)
  assert.equal(graph.nodes[0].failedAt, null)

  // The migration preserves the old AND semantics: B is blocked until A is done.
  graph.nodes[0].status = 'todo'
  graph.nodes[0].completedAt = null
  assert.deepEqual(derive(graph).blocked, ['n_b', 'n_c'])
  assert.equal(normalizeGraph(graph).nodes[1].conditions.length, 1, 'v2 is idempotent')
})

test('normalizeGraph repairs bad conditions, edges and statuses without throwing', () => {
  const raw = {
    schemaVersion: 2,
    nodes: [
      makeNode('n_a', { status: 'weird' }),
      makeNode('n_b', {
        status: 'failed',
        failedAt: T0,
        conditions: [
          { id: 'c_same', title: '有标题' },
          { id: 'c_same', title: '   ' },
          { title: '没有 id' },
        ],
      }),
      makeNode('n_c', { conditions: [] }),
    ],
    edges: [
      { id: 'e_1', from: 'n_a', to: 'n_b', conditionId: 'c_same' },
      { id: 'e_2', from: 'n_b', to: 'n_c' },
      { id: 'e_3', from: 'n_a', to: 'n_a' },
      { id: 'e_4', from: 'n_a', to: 'n_c', conditionId: 'c_unknown' },
    ],
  }
  const graph = normalizeGraph(raw)
  assert.equal(graph.nodes[0].status, 'todo', 'unknown status falls back')
  const conditions = graph.nodes[1].conditions
  assert.equal(conditions.length, 3)
  assert.equal(new Set(conditions.map((condition) => condition.id)).size, 3, 'ids de-duplicated')
  assert.ok(conditions.every((condition) => condition.title.trim() !== ''), 'titles repaired')
  // Edge from the failed node is dropped; the unknown condition is minted on C.
  assert.deepEqual(graph.edges.map((edge) => edge.id).sort(), ['e_1', 'e_4'])
  assert.ok(graph.nodes[2].conditions.some((condition) => condition.id === 'c_unknown'))
})

test('normalizeGraph rejects a future schema and non-object documents', () => {
  throwsCode(() => normalizeGraph({ schemaVersion: 3 }), CODES.unsupportedVersion, 'future version')
  throwsCode(() => normalizeGraph({ schemaVersion: 99 }), CODES.unsupportedVersion, 'unknown version')
  throwsCode(() => normalizeGraph([1, 2, 3]), CODES.invalidGraph, 'array document')
  throwsCode(() => normalizeGraph(null), CODES.invalidGraph, 'null document')
})

test('normalizeGraph repairs a hand-edited session chain', () => {
  const raw = {
    schemaVersion: 2,
    nodes: [
      makeNode('n_a', {
        sessions: [
          makeSession('session-1', 1),
          makeSession('session-2', 1),
          makeSession('session-1', 3),
        ],
      }),
    ],
    edges: [],
  }
  const graph = normalizeGraph(raw)
  const sessions = graph.nodes[0].sessions
  assert.equal(sessions.length, 2, 'duplicate session record dropped')
  assert.deepEqual(sessions.map((session) => session.slot), [1, 2], 'slots renumbered forward')
  assert.equal(sessions[0].retiredAt !== null, true, 'only the newest stays current')
  assert.equal(sessions[1].retiredAt, null)
})

test('spliceIncoming rewires upstream nodes onto successor conditions', () => {
  const graph = makeGraph(
    [makeNode('n_a'), makeNode('n_b'), makeNode('n_c')],
    [
      { id: 'e_ab', from: 'n_a', to: 'n_b', conditionId: 'c_b1' },
      { id: 'e_bc', from: 'n_b', to: 'n_c', conditionId: 'c_c1' },
    ],
  )
  graph.nodes[1].conditions = [{ id: 'c_b1', title: 'A 完成', createdAt: T0 }]
  graph.nodes[2].conditions = [{ id: 'c_c1', title: 'B 完成', createdAt: T0 }]

  const result = spliceIncoming(graph, 'n_b')
  assert.equal(result.added.length, 1)
  assert.deepEqual(
    { from: result.added[0].from, to: result.added[0].to, conditionId: result.added[0].conditionId },
    { from: 'n_a', to: 'n_c', conditionId: 'c_c1' },
  )
  assert.equal(result.edges.some((edge) => edge.from === 'n_b' || edge.to === 'n_b'), false)

  const failedUpstream = structuredClone(graph)
  failedUpstream.nodes[0].status = 'failed'
  failedUpstream.nodes[0].failedAt = T0
  const skipped = spliceIncoming(failedUpstream, 'n_b')
  assert.equal(skipped.added.length, 0)
  assert.equal(skipped.skipped[0].reason, 'failed-source')
})

test('unlinkIncoming drops every edge that touches the node', () => {
  const graph = makeGraph(
    [makeNode('n_a'), makeNode('n_b'), makeNode('n_c')],
    [['n_a', 'n_b'], ['n_b', 'n_c']],
  )
  const edges = unlinkIncoming(graph, 'n_b')
  assert.deepEqual(edges, [])
})

test('autoLayout puts columns by depth and rows by topological order', () => {
  const graph = makeGraph(
    [makeNode('n_a'), makeNode('n_b'), makeNode('n_c')],
    [['n_a', 'n_b'], ['n_a', 'n_c']],
  )
  const positions = autoLayout(graph)
  assert.deepEqual(positions.n_a, { x: 40, y: 40 })
  assert.equal(positions.n_b.x, 300)
  assert.equal(positions.n_c.x, 300)
  assert.ok(positions.n_b.y !== positions.n_c.y)
  assert.deepEqual(layoutLevels(graph), { n_a: 0, n_b: 1, n_c: 1 })
})

test('autoLayout separates disconnected components and removes avoidable crossings', () => {
  const graph = makeGraph(
    [
      makeNode('n_a'), makeNode('n_b'), makeNode('n_d'), makeNode('n_c'),
      makeNode('n_m1'), makeNode('n_m2'), makeNode('n_x'),
    ],
    [['n_a', 'n_c'], ['n_b', 'n_d'], ['n_m1', 'n_m2']],
  )
  const positions = autoLayout(graph)

  // Without the barycenter pass n_d/n_c would stay in insertion order and the
  // two edges would cross. The layout puts n_c before n_d.
  assert.ok(positions.n_c.y < positions.n_d.y, 'the edge order is barycenter-sorted')

  // The second connected component starts below the first one, so the two
  // subgraphs cannot overlap.
  const firstBottom = Math.max(
    positions.n_a.y, positions.n_b.y, positions.n_c.y, positions.n_d.y,
  ) + 84
  const secondTop = Math.min(positions.n_m1.y, positions.n_m2.y)
  assert.ok(secondTop >= firstBottom, 'disconnected components are stacked without overlap')

  // The isolated node is packed after the components and overlaps nothing.
  for (const id of ['n_a', 'n_b', 'n_c', 'n_d', 'n_m1', 'n_m2']) {
    const left = positions[id]
    const right = positions.n_x
    const overlaps = left.x < right.x + 208 && left.x + 208 > right.x
      && left.y < right.y + 84 && left.y + 84 > right.y
    assert.equal(overlaps, false, `isolated node must not overlap ${id}`)
  }
})

test('session helpers read the ordered chain', () => {
  const graph = makeGraph([
    makeNode('n_a', {
      sessions: [
        makeSession('session-1', 1, { retiredAt: T0 }),
        makeSession('session-2', 2),
      ],
    }),
    makeNode('n_b'),
  ])
  const node = findNode(graph, 'n_a')
  assert.equal(activeSession(node).sessionId, 'session-2')
  assert.equal(sessionOwner(graph, 'session-1'), 'n_a')
  assert.equal(sessionOwner(graph, 'session-2'), 'n_a')
  assert.equal(sessionOwner(graph, 'session-3'), null)
  assert.equal(nextSlot(node), 3)
})

test('condition helpers expose conditions and satisfiers', () => {
  const graph = makeGraph([makeNode('n_a'), makeNode('n_b')], [['n_a', 'n_b']])
  assert.equal(conditionsOf(graph, 'n_b').length, 1)
  assert.equal(conditionOf(graph, 'n_b', 'c_missing'), undefined)
  assert.equal(conditionsOf(graph, 'n_missing').length, 0)
  assert.equal(satisfiersOf(graph, 'n_b', 'c_0')[0].from, 'n_a')
})

test('derive tolerates duplicate edges and dangling references', () => {
  const graph = makeGraph([makeNode('n_a'), makeNode('n_b')], [
    { id: 'e_1', from: 'n_a', to: 'n_b', conditionId: 'c_0' },
    { id: 'e_2', from: 'n_a', to: 'n_b', conditionId: 'c_0' },
    { id: 'e_3', from: 'n_missing', to: 'n_b', conditionId: 'c_0' },
  ])
  graph.nodes[1].conditions = [{ id: 'c_0', title: '条件', createdAt: T0 }]
  const derived = derive(graph)
  assert.deepEqual(derived.order, ['n_a', 'n_b'])
  assert.equal(derived.conditions.n_b[0].linked.length, 1)
})

test('newId and nowIso produce the documented formats', () => {
  assert.match(newId('n'), /^n_[0-9a-f]{8}$/)
  assert.match(newId('c_'), /^c_[0-9a-f]{8}$/)
  assert.match(newId('e'), /^e_[0-9a-f]{8}$/)
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T/)
})

test('cloneGraph is a deep, independent copy', () => {
  const graph = makeGraph([makeNode('n_a')])
  const copy = cloneGraph(graph)
  copy.nodes[0].title = 'changed'
  copy.nodes.push(makeNode('n_b'))
  assert.notEqual(graph.nodes[0].title, 'changed')
  assert.equal(graph.nodes.length, 1)
})

test('successorsOf reports the satisfied condition of each edge', () => {
  const graph = makeGraph([makeNode('n_a'), makeNode('n_b')], [['n_a', 'n_b']])
  const successors = successorsOf(graph, 'n_a')
  assert.equal(successors.length, 1)
  assert.equal(successors[0].to, 'n_b')
  assert.equal(successors[0].conditionId, 'c_0')
})
