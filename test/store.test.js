import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { GraphStore } from '../src/store.js'
import { CODES } from '../src/errors.js'

const T0 = '2026-10-28T11:00:00.000Z'

function makeWorkspace(t) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-task-dag-store-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  return {
    base,
    workspace: { workspaceId: 'ws_main', path: join(base, 'project'), title: '测试项目' },
  }
}

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

function withNode(current, nodeId) {
  const next = structuredClone(current)
  next.nodes.push(makeNode(nodeId))
  return next
}

function addNode(store, workspace, expectedRevision, nodeId) {
  return store.commit(workspace, expectedRevision, (current) => ({
    next: withNode(current, nodeId),
    event: { type: 'add-node', data: { nodeId } },
  }))
}

function graphDir(store, workspace) {
  return dirname(store.pathFor(workspace))
}

function tmpFiles(store, workspace) {
  return readdirSync(graphDir(store, workspace)).filter((name) => name.includes('.tmp-'))
}

function readEvents(store, workspace) {
  const snapshot = store.read(workspace)
  return readFileSync(snapshot.eventsPath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

test('read treats a missing document as an empty graph and creates nothing', (t) => {
  const { workspace } = makeWorkspace(t)
  const store = new GraphStore()

  const snapshot = store.read(workspace)
  assert.equal(snapshot.missing, true)
  assert.equal(snapshot.graph.revision, 0)
  assert.equal(snapshot.graph.workspaceId, workspace.workspaceId)
  assert.deepEqual(snapshot.graph.nodes, [])
  assert.deepEqual(snapshot.graph.edges, [])
  assert.deepEqual(snapshot.warnings, [])
  assert.equal(snapshot.path, join(workspace.path, '.dsh-task-graph', 'graph.json'))
  assert.equal(snapshot.eventsPath, join(workspace.path, '.dsh-task-graph', 'events.jsonl'))
  assert.equal(existsSync(workspace.path), false, 'a read must not create directories')
})

test('commit creates the directory, persists and round-trips through disk', async (t) => {
  const { workspace } = makeWorkspace(t)
  const store = new GraphStore()

  const committed = await store.commit(workspace, 0, (current) => ({
    next: withNode(current, 'n_1'),
    event: { type: 'add-node', data: { nodeId: 'n_1' } },
  }))
  assert.equal(committed.revision, 1)
  assert.equal(committed.workspaceId, workspace.workspaceId)
  assert.equal(committed.workspacePath, workspace.path)
  assert.equal(committed.nodes.length, 1)
  assert.equal(typeof committed.updatedAt, 'string')
  assert.equal(existsSync(store.pathFor(workspace)), true)

  const reloaded = store.read(workspace)
  assert.equal(reloaded.missing, false)
  assert.deepEqual(reloaded.graph, committed, 'normalization must be lossless for committed data')

  const freshStore = new GraphStore()
  assert.deepEqual(freshStore.read(workspace).graph, committed, 'a new process reads the same graph')
  assert.deepEqual(tmpFiles(store, workspace), [], 'the tmp file is renamed away')

  const events = readEvents(store, workspace)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'add-node')
  assert.equal(events[0].revision, 1)
  assert.equal(events[0].workspaceId, workspace.workspaceId)
  assert.deepEqual(events[0].data, { nodeId: 'n_1' })
  assert.equal(typeof events[0].at, 'string')
})

test('the document round-trips sessions, milestone and manual positions', async (t) => {
  const { workspace } = makeWorkspace(t)
  const store = new GraphStore()
  const nodeA = makeNode('n_a', {
    sessions: [makeSession('session-1', 1, { retiredAt: T0 }), makeSession('session-2', 2)],
    position: { x: 120, y: 80 },
  })
  const nodeB = makeNode('n_b', {
    conditions: [{ id: 'c_1', title: 'A 完成', createdAt: T0 }],
    agentPreset: 'build',
    model: 'deepseek/deepseek-chat',
    reasoningEffort: 'high',
    schedule: {
      enabled: true,
      cron: '0 9 * * 1-5',
      nextRunAt: T0,
      lastTriggeredAt: null,
      lastFinishedAt: null,
      lastResult: null,
      lastError: null,
      lastSkippedReason: null,
      lastSessionId: null,
    },
  })

  const committed = await store.commit(workspace, 0, (current) => {
    const next = structuredClone(current)
    next.nodes = [nodeA, nodeB]
    next.edges = [{ id: 'e_1', from: 'n_a', to: 'n_b', conditionId: 'c_1' }]
    next.milestoneNodeId = 'n_b'
    return { next }
  })

  const persisted = new GraphStore().read(workspace).graph
  assert.deepEqual(persisted, committed)
  assert.deepEqual(persisted.nodes[0].position, { x: 120, y: 80 })
  assert.equal(persisted.milestoneNodeId, 'n_b')
  assert.equal(persisted.nodes[0].sessions[0].retiredAt, T0)
  assert.equal(persisted.nodes[0].sessions[1].retiredAt, null)
  assert.equal(persisted.nodes[0].sessions[1].slot, 2)
  assert.equal(persisted.nodes[1].conditions[0].title, 'A 完成')
  assert.equal(persisted.nodes[1].agentPreset, 'build')
  assert.equal(persisted.nodes[1].model, 'deepseek/deepseek-chat')
  assert.equal(persisted.nodes[1].reasoningEffort, 'high')
  assert.equal(persisted.nodes[1].schedule.cron, '0 9 * * 1-5')
})

test('a stale expectedRevision is rejected with a 409 conflict', async (t) => {
  const { workspace } = makeWorkspace(t)
  const store = new GraphStore()
  await addNode(store, workspace, 0, 'n_1')

  await assert.rejects(
    addNode(store, workspace, 0, 'n_2'),
    (error) => {
      assert.equal(error.name, 'TaskDagError')
      assert.equal(error.code, CODES.revisionConflict)
      assert.equal(error.status, 409)
      assert.deepEqual(error.details, { current: 1, expected: 0 })
      return true
    },
  )

  // A write without a base revision is refused the same way.
  await assert.rejects(
    store.commit(workspace, undefined, (current) => ({ next: withNode(current, 'n_3') })),
    (error) => {
      assert.equal(error.code, CODES.revisionConflict)
      assert.equal(error.details.current, 1)
      return true
    },
  )

  const snapshot = store.read(workspace)
  assert.equal(snapshot.graph.revision, 1)
  assert.deepEqual(snapshot.graph.nodes.map((node) => node.id), ['n_1'])
  assert.equal(readEvents(store, workspace).length, 1, 'a lost conflict writes no audit line')
})

test('concurrent commits are serialized in arrival order', async (t) => {
  const { workspace } = makeWorkspace(t)
  const store = new GraphStore()

  let release
  const gate = new Promise((resolveGate) => {
    release = resolveGate
  })
  const first = store.commit(workspace, 0, async (current) => {
    await gate
    return { next: withNode(current, 'n_1') }
  })
  // Queue a commit that is based on the revision the first commit will produce.
  // Without serialization it would read revision 0 and conflict.
  const second = addNode(store, workspace, 1, 'n_2')
  release()

  const [firstGraph, secondGraph] = await Promise.all([first, second])
  assert.equal(firstGraph.revision, 1)
  assert.equal(secondGraph.revision, 2)

  const snapshot = store.read(workspace)
  assert.equal(snapshot.graph.revision, 2)
  assert.deepEqual(snapshot.graph.nodes.map((node) => node.id), ['n_1', 'n_2'])
  assert.deepEqual(readEvents(store, workspace).map((event) => event.revision), [1, 2])
})

test('two commits racing on the same revision: exactly one wins', async (t) => {
  const { workspace } = makeWorkspace(t)
  const store = new GraphStore()

  const results = await Promise.allSettled([
    addNode(store, workspace, 0, 'n_a'),
    addNode(store, workspace, 0, 'n_b'),
  ])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[0].value.revision, 1)
  assert.equal(results[1].status, 'rejected')
  assert.equal(results[1].reason.code, CODES.revisionConflict)

  const snapshot = store.read(workspace)
  assert.equal(snapshot.graph.revision, 1)
  assert.deepEqual(snapshot.graph.nodes.map((node) => node.id), ['n_a'])
})

test('a throwing or invalid produce writes nothing and does not wedge the queue', async (t) => {
  const { workspace } = makeWorkspace(t)
  const store = new GraphStore()
  await addNode(store, workspace, 0, 'n_1')
  const before = readFileSync(store.pathFor(workspace), 'utf8')

  await assert.rejects(
    store.commit(workspace, 1, () => {
      throw new Error('boom')
    }),
    /boom/,
  )
  assert.equal(readFileSync(store.pathFor(workspace), 'utf8'), before)

  await assert.rejects(
    store.commit(workspace, 1, (current) => {
      const next = structuredClone(current)
      next.edges.push({ id: 'e_self', from: 'n_1', to: 'n_1' })
      return { next }
    }),
    (error) => {
      assert.equal(error.code, CODES.invariant)
      return true
    },
  )

  await assert.rejects(
    store.commit(workspace, 1, (current) => {
      const next = withNode(current, 'n_2')
      next.nodes[0].conditions = [{ id: 'c_1', title: '前置', createdAt: T0 }]
      next.nodes[1].conditions = [{ id: 'c_2', title: '前置', createdAt: T0 }]
      next.edges = [
        { id: 'e_1', from: 'n_1', to: 'n_2', conditionId: 'c_2' },
        { id: 'e_2', from: 'n_2', to: 'n_1', conditionId: 'c_1' },
      ]
      return { next }
    }),
    (error) => {
      assert.equal(error.code, CODES.cycle)
      return true
    },
  )

  assert.equal(readFileSync(store.pathFor(workspace), 'utf8'), before, 'nothing reached the file')
  assert.deepEqual(store.read(workspace).graph.nodes.map((node) => node.id), ['n_1'])
  assert.deepEqual(tmpFiles(store, workspace), [])

  const committed = await addNode(store, workspace, 1, 'n_2')
  assert.equal(committed.revision, 2, 'the per-workspace queue keeps accepting commits')
})

test('a corrupt document is quarantined, never thrown, and the graph stays writable', async (t) => {
  const { workspace } = makeWorkspace(t)
  const store = new GraphStore()
  const graphPath = store.pathFor(workspace)
  mkdirSync(dirname(graphPath), { recursive: true })
  const broken = '{ "nodes": ['
  writeFileSync(graphPath, broken, 'utf8')

  const snapshot = store.read(workspace)
  assert.equal(snapshot.missing, true)
  assert.equal(snapshot.graph.revision, 0)
  assert.equal(snapshot.warnings.length, 1)
  assert.match(snapshot.warnings[0], /\.corrupt-/)
  assert.equal(existsSync(graphPath), false)

  const quarantined = readdirSync(dirname(graphPath)).filter((name) => name.startsWith('graph.json.corrupt-'))
  assert.equal(quarantined.length, 1)
  assert.equal(quarantined[0].includes(':'), false, 'Windows-safe quarantine name')
  assert.equal(readFileSync(join(dirname(graphPath), quarantined[0]), 'utf8'), broken)

  // The empty fallback is a normal revision 0 document, so the first commit
  // after damage simply creates a fresh graph.
  const committed = await addNode(store, workspace, 0, 'n_1')
  assert.equal(committed.revision, 1)
  assert.equal(JSON.parse(readFileSync(graphPath, 'utf8')).revision, 1)
  assert.equal(existsSync(join(dirname(graphPath), quarantined[0])), true)
})

test('a JSON document of the wrong shape is quarantined too', (t) => {
  const { workspace } = makeWorkspace(t)
  const store = new GraphStore()
  const graphPath = store.pathFor(workspace)
  mkdirSync(dirname(graphPath), { recursive: true })
  writeFileSync(graphPath, '[1, 2, 3]', 'utf8')

  const snapshot = store.read(workspace)
  assert.equal(snapshot.missing, true)
  assert.equal(snapshot.graph.revision, 0)
  assert.match(snapshot.warnings[0], /\.corrupt-/)
})

test('a newer schema version is refused instead of being overwritten', (t) => {
  const { workspace } = makeWorkspace(t)
  const store = new GraphStore()
  const graphPath = store.pathFor(workspace)
  mkdirSync(dirname(graphPath), { recursive: true })
  const newer = JSON.stringify({ schemaVersion: 3, workspaceId: 'ws_main', nodes: [], edges: [] })
  writeFileSync(graphPath, newer, 'utf8')

  assert.throws(
    () => store.read(workspace),
    (error) => {
      assert.equal(error.code, CODES.unsupportedVersion)
      return true
    },
  )
  assert.equal(readFileSync(graphPath, 'utf8'), newer, 'a document we do not understand is untouched')
  assert.deepEqual(readdirSync(dirname(graphPath)), ['graph.json'])
})

test('a failed events append is a warning, not a commit failure', async (t) => {
  const { workspace } = makeWorkspace(t)
  const store = new GraphStore({
    fs: {
      appendFileSync() {
        const error = new Error('disk full')
        error.code = 'ENOSPC'
        throw error
      },
    },
  })

  const committed = await addNode(store, workspace, 0, 'n_1')
  assert.equal(committed.revision, 1)
  assert.equal(existsSync(store.pathFor(workspace)), true)

  const snapshot = store.read(workspace)
  assert.equal(snapshot.graph.revision, 1)
  assert.equal(snapshot.warnings.length, 1)
  assert.match(snapshot.warnings[0], /events\.jsonl/)
  assert.equal(existsSync(snapshot.eventsPath), false)

  const second = await addNode(store, workspace, 1, 'n_2')
  assert.equal(second.revision, 2, 'the store keeps working without an audit log')
})

test('commit re-reads disk, so an external edit causes a conflict', async (t) => {
  const { workspace } = makeWorkspace(t)
  const store = new GraphStore()
  await addNode(store, workspace, 0, 'n_1')

  const graphPath = store.pathFor(workspace)
  const edited = JSON.parse(readFileSync(graphPath, 'utf8'))
  edited.revision = 5
  writeFileSync(graphPath, JSON.stringify(edited, null, 2), 'utf8')

  await assert.rejects(
    addNode(store, workspace, 1, 'n_2'),
    (error) => {
      assert.equal(error.code, CODES.revisionConflict)
      assert.equal(error.details.current, 5)
      return true
    },
  )
  assert.equal(JSON.parse(readFileSync(graphPath, 'utf8')).revision, 5)
})

test('subscribers hear every commit and cannot break one', async (t) => {
  const { workspace } = makeWorkspace(t)
  const store = new GraphStore()
  const originalConsoleError = console.error
  console.error = () => {}
  t.after(() => {
    console.error = originalConsoleError
  })

  const seen = []
  const unsubscribe = store.subscribe(workspace, (payload) => seen.push(payload))
  store.subscribe(workspace, () => {
    throw new Error('sse client is gone')
  })

  await addNode(store, workspace, 0, 'n_1')
  assert.deepEqual(seen, [{ workspaceId: workspace.workspaceId, revision: 1 }])

  unsubscribe()
  await addNode(store, workspace, 1, 'n_2')
  assert.equal(seen.length, 1, 'unsubscribe stops notifications')
  assert.equal(store.read(workspace).graph.revision, 2)
})

test('read hands out defensive copies of the cache', async (t) => {
  const { workspace } = makeWorkspace(t)
  const store = new GraphStore()
  await addNode(store, workspace, 0, 'n_1')

  const first = store.read(workspace).graph
  first.workspaceId = 'hacked'
  first.nodes.push(makeNode('n_ghost'))

  const second = store.read(workspace).graph
  assert.equal(second.workspaceId, workspace.workspaceId)
  assert.deepEqual(second.nodes.map((node) => node.id), ['n_1'])
})

test('a failed atomic replace keeps the old document and cleans the tmp file', async (t) => {
  const { workspace } = makeWorkspace(t)
  const healthy = new GraphStore()
  await addNode(healthy, workspace, 0, 'n_1')
  const before = readFileSync(healthy.pathFor(workspace), 'utf8')

  const failing = new GraphStore({
    fs: {
      renameSync() {
        const error = new Error('locked by another process')
        error.code = 'EPERM'
        throw error
      },
    },
  })
  await assert.rejects(addNode(failing, workspace, 1, 'n_2'), /locked by another process/)

  assert.equal(readFileSync(healthy.pathFor(workspace), 'utf8'), before)
  assert.deepEqual(tmpFiles(healthy, workspace), [], 'the tmp file is removed on failure')
  assert.equal(healthy.read(workspace).graph.revision, 1)
})

test('dirFor can relocate the graph and pathFor stays absolute', async (t) => {
  const { base, workspace } = makeWorkspace(t)
  const store = new GraphStore({ dirFor: (target) => join(base, 'custom', target.workspaceId) })

  const expected = resolve(join(base, 'custom', workspace.workspaceId), 'graph.json')
  assert.equal(store.pathFor(workspace), expected)
  await addNode(store, workspace, 0, 'n_1')
  assert.equal(existsSync(expected), true)
})

test('the store rejects a workspace without a path', async (t) => {
  const store = new GraphStore()
  assert.throws(
    () => store.read({ workspaceId: 'ws_broken' }),
    (error) => {
      assert.equal(error.code, CODES.invalidRequest)
      return true
    },
  )
  await assert.rejects(
    store.commit({ workspaceId: 'ws_broken' }, 0, (current) => ({ next: current })),
    (error) => {
      assert.equal(error.code, CODES.invalidRequest)
      return true
    },
  )
})
