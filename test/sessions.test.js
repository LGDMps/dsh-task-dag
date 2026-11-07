/**
 * Unit tests for the session adapters.
 *
 * Everything is a fake `ctx`: no DSH process, no session files on disk. The
 * gateway shapes mirror the verified calls (DSH 0.2.1-rc.3).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applySessionTarget,
  archiveSession,
  buildBrief,
  createBlankSession,
  invalidateProjectionsCache,
  listAgentPresets,
  listModelCatalog,
  PROJECTIONS_CACHE_MS,
  PROJECTIONS_CONCURRENCY,
  promptSession,
  readSessionEvents,
  readTail,
  renameSession,
  selectModel,
  sessionFacts,
  unarchiveSession,
} from '../src/sessions.js'
import { TaskDagError } from '../src/errors.js'

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function gatewayStub({ invoke, stream } = {}) {
  const calls = []
  const gateway = {
    async invoke(request) {
      calls.push(request)
      if (invoke !== undefined) return invoke(request, calls)
      return {}
    },
    async stream(request) {
      calls.push(request)
      if (stream !== undefined) return stream(request, calls)
      return (async function* empty() {})()
    },
  }
  return { gateway, calls }
}

/** An async iterable that yields one `session/follow` snapshot. */
function snapshotStream(records, state = {}) {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        yield {
          type: 'snapshot',
          cursor: records.length,
          records: records.map((event) => ({ event })),
          hasMore: false,
          projections: {},
        }
      } finally {
        state.closed = true
      }
    },
  }
}

function rejectsCode(factory, code, status) {
  return assert.rejects(factory, (error) => {
    assert.ok(error instanceof TaskDagError, `expected TaskDagError, got ${error?.constructor?.name}`)
    assert.equal(error.code, code)
    if (status !== undefined) assert.equal(error.status, status)
    return true
  })
}

/* ------------------------------------------------------------------ */
/* sessionFacts                                                        */
/* ------------------------------------------------------------------ */

test('sessionFacts projects summaries, pressure ratio and archived ids', async () => {
  const { gateway, calls } = gatewayStub({
    invoke: () => ({
      items: [
        {
          sessionId: 's1',
          running: true,
          blank: false,
          updatedAt: 1700000000000,
          cwd: 'C:\\projects\\a',
          projections: {
            values: {
              title: '会话一',
              contextPressure: { contextWindow: 100000, pressureTokens: 20000, projectedTokens: 60000 },
            },
          },
        },
        {
          sessionId: 's2',
          running: false,
          blank: true,
          updatedAt: 1700000001000,
          cwd: 'C:\\projects\\a',
          projections: { values: { title: '会话二' } },
        },
      ],
    }),
  })
  const ctx = { typertGateway: gateway, workspaceRegistry: { archivedSessionIds: ['s2'] } }

  const facts = await sessionFacts(ctx, ['s1', 's2', 'missing', 's1'])

  // `s1` already has a usable pressure in the summary, so only `s2` needs the
  // projection read; `missing` is never asked for.
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], { namespace: 'session', method: 'list', args: { _request: {} } })
  assert.deepEqual(calls[1], {
    namespace: 'session',
    method: 'projections',
    args: { request: { sessionId: 's2' } },
  })
  assert.deepEqual(Object.keys(facts.byId).sort(), ['missing', 's1', 's2'])
  assert.equal(facts.byId.s1.title, '会话一')
  assert.equal(facts.byId.s1.running, true)
  assert.equal(facts.byId.s1.blank, false)
  assert.equal(facts.byId.s1.updatedAt, 1700000000000)
  assert.equal(facts.byId.s1.available, true)
  assert.deepEqual(facts.byId.s1.contextPressure, {
    contextWindow: 100000,
    pressureTokens: 20000,
    projectedTokens: 60000,
    ratio: 0.6,
  })
  assert.equal(facts.byId.s2.blank, true)
  assert.deepEqual(facts.byId.s2.contextPressure, {})
  assert.deepEqual(facts.archived, ['s2'])
  assert.equal(facts.byId.missing.available, false)
  assert.equal(facts.byId.missing.title, '')
  assert.ok(facts.warnings.some((line) => line.includes('missing')))
})

test('sessionFacts with no ids does not touch the gateway', async () => {
  const { gateway, calls } = gatewayStub()
  const facts = await sessionFacts({ typertGateway: gateway }, [])
  assert.deepEqual(facts, { byId: {}, archived: [], warnings: [] })
  assert.equal(calls.length, 0)
})

test('sessionFacts throws host-unavailable without a gateway, and wraps invoke errors', async () => {
  await rejectsCode(() => sessionFacts({}, ['s1']), 'host-unavailable', 503)
  await rejectsCode(
    () => sessionFacts({ typertGateway: { async invoke() { throw new Error('boom') } } }, ['s1']),
    'host-unavailable',
    503,
  )
})

/** Gateway for the projection tests: `session/list` plus scripted projections. */
function pressureGateway({ summaries, projections }) {
  return gatewayStub({
    invoke: (request) => {
      if (request.namespace === 'session' && request.method === 'list') {
        return { items: summaries }
      }
      if (request.namespace === 'session' && request.method === 'projections') {
        const sessionId = request.args.request.sessionId
        return typeof projections === 'function' ? projections(sessionId) : projections[sessionId]
      }
      throw new Error(`unexpected gateway call ${request.namespace}/${request.method}`)
    },
  })
}

test('sessionFacts fills contextPressure from session/projections', async () => {
  const { gateway, calls } = pressureGateway({
    summaries: [
      { sessionId: 'seq', projections: { values: { title: '顺序投影' } } },
      { sessionId: 'mig', projections: { values: { title: '迁移投影' } } },
      { sessionId: 'bare', projections: { values: { title: '裸值投影' } } },
    ],
    projections: {
      seq: {
        kind: 'sequenced',
        asOfSeq: 42,
        values: {
          contextPressure: { contextWindow: 100000, pressureTokens: 20000, projectedTokens: 60000 },
        },
      },
      mig: {
        kind: 'migration-required',
        values: { contextPressure: { contextWindow: 80000, pressureTokens: 40000 } },
      },
      // A values map without the wrapper is tolerated too.
      bare: { contextPressure: { contextWindow: 50000, projectedTokens: 10000 } },
    },
  })
  const ctx = { typertGateway: gateway }

  const facts = await sessionFacts(ctx, ['seq', 'mig', 'bare'])

  assert.deepEqual(facts.byId.seq.contextPressure, {
    contextWindow: 100000,
    pressureTokens: 20000,
    projectedTokens: 60000,
    ratio: 0.6,
  })
  assert.deepEqual(facts.byId.mig.contextPressure, {
    contextWindow: 80000,
    pressureTokens: 40000,
    ratio: 0.5,
  })
  assert.deepEqual(facts.byId.bare.contextPressure, {
    contextWindow: 50000,
    projectedTokens: 10000,
    ratio: 0.2,
  })
  // Identity still comes from session/list.
  assert.equal(facts.byId.seq.title, '顺序投影')
  assert.equal(facts.byId.mig.available, true)

  const pressureCalls = calls.filter((call) => call.method === 'projections')
  assert.deepEqual(
    pressureCalls.map((call) => call.args.request.sessionId).sort(),
    ['bare', 'mig', 'seq'],
  )
  for (const call of pressureCalls) {
    assert.equal(call.namespace, 'session')
    assert.deepEqual(Object.keys(call.args), ['request'])
  }
})

test('sessionFacts keeps every fact when projections are null, unknown or fail', async () => {
  const { gateway } = pressureGateway({
    summaries: [
      { sessionId: 'null-proj', projections: { values: { title: '空投影' } } },
      { sessionId: 'throwing', projections: { values: { title: '失败投影' } } },
      { sessionId: 'weird', projections: { values: { title: '未知投影' } } },
    ],
    projections: (sessionId) => {
      if (sessionId === 'null-proj') return null
      if (sessionId === 'throwing') throw new Error('projections unavailable')
      return { kind: 'sequenced', values: { contextPressure: { contextWindow: 'wide' } } }
    },
  })
  const ctx = { typertGateway: gateway }

  const facts = await sessionFacts(ctx, ['null-proj', 'throwing', 'weird', 'gone'])

  assert.deepEqual(Object.keys(facts.byId).sort(), ['gone', 'null-proj', 'throwing', 'weird'])
  for (const id of ['null-proj', 'throwing', 'weird']) {
    assert.deepEqual(facts.byId[id].contextPressure, {}, `${id} must degrade to an empty water level`)
    assert.equal(facts.byId[id].available, true)
  }
  assert.equal(facts.byId.throwing.title, '失败投影')
  // The missing session keeps its existing warning behaviour.
  assert.equal(facts.byId.gone.available, false)
  assert.ok(facts.warnings.some((line) => line.includes('gone')))
})

test('sessionFacts caches one projection per session and refreshes it after the TTL', async () => {
  let pressureReads = 0
  const { gateway } = pressureGateway({
    summaries: [{ sessionId: 'cached', projections: { values: { title: '缓存会话' } } }],
    projections: () => {
      pressureReads += 1
      return {
        kind: 'sequenced',
        values: { contextPressure: { contextWindow: 1000, projectedTokens: pressureReads * 100 } },
      }
    },
  })
  const ctx = { typertGateway: gateway }
  const start = 1_000_000

  const first = await sessionFacts(ctx, ['cached'], start)
  assert.equal(pressureReads, 1)
  assert.equal(first.byId.cached.contextPressure.ratio, 0.1)

  const cached = await sessionFacts(ctx, ['cached'], start + PROJECTIONS_CACHE_MS - 1)
  assert.equal(pressureReads, 1, 'a refresh inside the TTL reuses the cached projection')
  assert.equal(cached.byId.cached.contextPressure.ratio, 0.1)

  const refreshed = await sessionFacts(ctx, ['cached'], start + PROJECTIONS_CACHE_MS)
  assert.equal(pressureReads, 2, 'the first read after the TTL hits the gateway again')
  assert.equal(refreshed.byId.cached.contextPressure.ratio, 0.2)

  invalidateProjectionsCache(ctx)
  await sessionFacts(ctx, ['cached'], start + PROJECTIONS_CACHE_MS)
  assert.equal(pressureReads, 3, 'invalidating the context cache forces a fresh read')
})

test('sessionFacts reads many projections in parallel with a bounded pool', async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `par-${index}`)
  let inFlight = 0
  let maxInFlight = 0
  const { gateway } = pressureGateway({
    summaries: ids.map((sessionId) => ({ sessionId, projections: { values: { title: sessionId } } })),
    projections: async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return {
        kind: 'sequenced',
        values: { contextPressure: { contextWindow: 1000, pressureTokens: 250 } },
      }
    },
  })

  const facts = await sessionFacts({ typertGateway: gateway }, ids)

  assert.equal(maxInFlight, PROJECTIONS_CONCURRENCY, 'the pool must respect its concurrency limit')
  assert.equal(Object.keys(facts.byId).length, ids.length)
  for (const id of ids) assert.equal(facts.byId[id].contextPressure.ratio, 0.25)
})

/* ------------------------------------------------------------------ */
/* readTail                                                            */
/* ------------------------------------------------------------------ */

test('readTail prefers the live session log and keeps only chat messages', async () => {
  const log = [
    { type: 'turn/start', seq: 1, time: 1, data: {} },
    { type: 'user/message', seq: 2, time: 2, data: { text: '第一条请求' } },
    { type: 'tool/call', seq: 3, time: 3, data: {} },
    { type: 'assistant/message', seq: 4, time: 4, data: { text: '第一条回复' } },
    { type: 'turn/end', seq: 5, time: 5, data: {} },
    { type: 'user/message', seq: 6, time: 6, data: { text: '第二条请求' } },
    { type: 'assistant/message', seq: 7, time: 7, data: { text: '第二条回复' } },
  ]
  const { gateway, calls } = gatewayStub()
  const ctx = { sessions: { get: (id) => (id === 's1' ? { id, log } : undefined) }, typertGateway: gateway }

  const tail = await readTail(ctx, 's1', 3)

  assert.equal(tail.source, 'log')
  // The last three chat messages, in chronological order (tool/turn events are skipped).
  assert.deepEqual(tail.events.map((event) => event.type), [
    'assistant/message',
    'user/message',
    'assistant/message',
  ])
  assert.deepEqual(tail.events.map((event) => event.data.text), ['第一条回复', '第二条请求', '第二条回复'])
  assert.equal(calls.length, 0)
})

test('readTail falls back to the session/follow opening snapshot and closes it', async () => {
  const state = {}
  const { gateway, calls } = gatewayStub({
    stream: () => snapshotStream([
      { type: 'user/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: '请做接口' }] } } },
      { type: 'assistant/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '接口已完成一半' }] } },
    ], state),
  })
  const ctx = { sessions: { get: () => ({ id: 'cold', header: {} }) }, typertGateway: gateway }

  const tail = await readTail(ctx, 'session-cold')

  assert.equal(tail.source, 'follow')
  assert.deepEqual(tail.events.map((event) => event.data), [
    { message: { content: [{ type: 'text', text: '请做接口' }] } },
    { content: [{ type: 'text', text: '接口已完成一半' }] },
  ])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    namespace: 'session',
    method: 'follow',
    args: { request: { address: { kind: 'session', sessionId: 'session-cold' }, maxMessages: 12 } },
  })
  assert.equal(state.closed, true)
})

test('readTail degrades to unavailable instead of throwing', async () => {
  const withoutGateway = await readTail({}, 's1')
  assert.equal(withoutGateway.source, 'unavailable')
  assert.deepEqual(withoutGateway.events, [])
  assert.ok(withoutGateway.warnings.length >= 1)

  const failing = await readTail({
    sessions: { get: () => { throw new Error('broken store') } },
    typertGateway: { async stream() { throw new Error('stream failed') } },
  }, 's1')
  assert.equal(failing.source, 'unavailable')
  assert.ok(failing.warnings.length >= 2)

  const emptyId = await readTail({}, '')
  assert.equal(emptyId.source, 'unavailable')
})

/* ------------------------------------------------------------------ */
/* buildBrief                                                          */
/* ------------------------------------------------------------------ */

test('buildBrief degrades to a valid brief without history', () => {
  const graph = {
    nodes: [
      { id: 'n1', title: '设计数据模型', status: 'done' },
      { id: 'n2', title: '实现接口', status: 'todo', notes: '' },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
    closeoutNodeId: null,
  }
  const node = graph.nodes[1]

  const brief = buildBrief({ graph, node, events: [], derived: {} })

  assert.match(brief.text, /^# 交接简报：实现接口/)
  assert.match(brief.text, /## 任务\n- 状态：待开始/)
  assert.match(brief.text, /## 任务描述\n\n以下是[^\n]*\n\n（暂无任务描述）\n\n## 前置/)
  assert.doesNotMatch(brief.text, /- 任务描述：/)
  assert.match(brief.text, /## 前置\n- 设计数据模型（已完成）/)
  assert.match(brief.text, /## 完成后解锁\n- 无/)
  assert.match(brief.text, /## 上一段会话的最后回复\n（没有可用的历史回复）/)
  assert.match(brief.text, /## 最近的用户请求\n（没有可用的历史请求）/)
  assert.match(brief.text, /请先复述你对任务目标和当前进度的理解，再从上次中断处继续。/)
  assert.deepEqual(brief.tokens, { assistant: 0, users: 0 })
})

test('buildBrief includes notes, flagged prereqs, successors and truncated history', () => {
  const graph = {
    nodes: [
      { id: 'pre-done', title: '已完成前置', status: 'done' },
      { id: 'pre-open', title: '未完成前置', status: 'doing' },
      { id: 'mid', title: '当前任务', status: 'doing', notes: '注意兼容旧格式' },
      { id: 'next', title: '后续任务', status: 'todo' },
    ],
    edges: [
      { id: 'e1', from: 'pre-done', to: 'mid' },
      { id: 'e2', from: 'pre-open', to: 'mid' },
      { id: 'e3', from: 'mid', to: 'next' },
    ],
    closeoutNodeId: 'next',
  }
  const node = graph.nodes[2]
  const longAssistant = '甲'.repeat(5000)
  const longUser = '乙'.repeat(1000)
  const events = [
    { type: 'user/message', seq: 1, time: 1, data: { text: '第一个请求' } },
    { type: 'assistant/message', seq: 2, time: 2, data: { text: '第一条回复' } },
    { type: 'user/message', seq: 3, time: 3, data: { message: { content: [{ type: 'text', text: '第二个请求' }] } } },
    { type: 'user/message', seq: 4, time: 4, data: { text: '第三个请求' } },
    { type: 'user/message', seq: 5, time: 5, data: { content: [{ type: 'text', text: longUser }] } },
    { type: 'assistant/message', seq: 6, time: 6, data: { message: { content: [{ type: 'text', text: longAssistant }] } } },
  ]

  const brief = buildBrief({ graph, node, events, derived: {} })

  assert.match(brief.text, /## 任务描述\n\n以下是[^\n]*\n\n注意兼容旧格式\n\n## 前置/)
  assert.doesNotMatch(brief.text, /- 任务描述：/)
  assert.match(brief.text, /- 已完成前置（已完成）/)
  assert.match(brief.text, /- 未完成前置（未完成）/)
  assert.match(brief.text, /## 完成后解锁\n- 后续任务/)
  assert.match(brief.text, /（已截断）/)
  assert.ok(brief.tokens.assistant > 3200)
  assert.ok(brief.tokens.assistant < 3400)
  assert.ok(brief.tokens.users <= 3 * 800 + 100)
  // Only the three most recent user requests survive; the oldest is gone.
  assert.ok(!brief.text.includes('第一个请求'))
  assert.ok(brief.text.includes('第二个请求'))
  assert.ok(brief.text.includes('第三个请求'))
})

test('buildBrief isolates multi-line Markdown notes from the brief structure', () => {
  const notes = [
    '## 目标',
    '',
    '- 支持旧格式',
    '- 保持确定性',
    '',
    '```js',
    "const label = '```'",
    '```',
    '',
    '### 验收',
    '1. 简报结构完整',
  ].join('\n')
  const graph = {
    nodes: [{ id: 'n1', title: '实现接口', status: 'doing', notes }],
    edges: [],
    closeoutNodeId: null,
  }
  const brief = buildBrief({ graph, node: graph.nodes[0], events: [] })
  const lines = brief.text.split('\n')

  assert.ok(brief.text.includes(notes))
  const notesIndex = lines.indexOf('## 任务描述')
  const prereqIndex = lines.indexOf('## 前置')
  assert.ok(notesIndex > 0)
  assert.ok(prereqIndex > notesIndex)
  // `## 前置` is a real section after the notes, not list item or code content.
  assert.match(brief.text, /1\. 简报结构完整\n\n## 前置\n- 无/)
  // Balanced fences in the notes stay balanced; the brief adds none.
  assert.equal(lines.filter((line) => line.trimStart().startsWith('```')).length % 2, 0)
})

test('buildBrief pads an unterminated code fence from the notes', () => {
  const notes = '## 步骤\n\n```sh\nnode test/sessions.test.js'
  const node = { id: 'n1', title: '未闭合围栏', status: 'todo', notes }
  const brief = buildBrief({ node, events: [] })

  assert.match(brief.text, /node test\/sessions\.test\.js\n```\n\n## 前置\n- 无/)
  const fenceLines = brief.text.split('\n').filter((line) => line.trimStart().startsWith('```'))
  assert.equal(fenceLines.length, 2)
  assert.equal(fenceLines.length % 2, 0)
})

test('buildBrief uses a placeholder for a blank task description', () => {
  const node = { id: 'n1', title: '空描述', status: 'todo', notes: '  \n\t ' }
  const brief = buildBrief({ node, events: [] })

  assert.match(brief.text, /## 任务描述\n\n以下是[^\n]*\n\n（暂无任务描述）\n\n## 前置\n- 无/)
  assert.doesNotMatch(brief.text, /- 任务描述：/)
})

test('buildBrief truncates long notes at a line boundary without breaking characters', () => {
  const rows = Array.from({ length: 200 }, (_, index) => `- 第${index + 1}行 ${'字'.repeat(12)}`)
  const node = { id: 'n1', title: '长描述', status: 'todo', notes: rows.join('\n') }
  const brief = buildBrief({ node, events: [] })

  const notesPart = brief.text.split('## 任务描述\n\n')[1].split('\n\n## 前置')[0]
  assert.ok(notesPart.length < 2000 + 200)
  const bodyLines = notesPart.split('\n\n')[1].split('\n')
  const marker = bodyLines.indexOf('…（已截断）')
  assert.ok(marker > 1)
  const keptLines = bodyLines.slice(0, marker)
  assert.ok(keptLines.length < rows.length)
  // Every kept line is whole: the cut landed on a line boundary.
  for (const line of keptLines) assert.match(line, /^- 第\d+行 字{12}$/)

  // A surrogate pair on the cut boundary must not be torn in half.
  const emojiNode = { ...node, notes: `a${'😀'.repeat(1500)}` }
  const emojiBrief = buildBrief({ node: emojiNode, events: [] })
  assert.ok(emojiBrief.text.includes('…（已截断）'))
  for (let index = 0; index < emojiBrief.text.length; index += 1) {
    const code = emojiBrief.text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = emojiBrief.text.charCodeAt(index + 1)
      assert.ok(next >= 0xdc00 && next <= 0xdfff, 'brief must not contain a lone high surrogate')
      index += 1
    } else {
      assert.ok(code < 0xdc00 || code > 0xdfff, 'brief must not contain a lone low surrogate')
    }
  }

  // Same input, same output: the brief involves no model call or hidden state.
  assert.equal(buildBrief({ node, events: [] }).text, brief.text)
})

test('buildBrief tolerates a missing graph and node', () => {
  const brief = buildBrief({})
  assert.match(brief.text, /^# 交接简报：/)
  assert.match(brief.text, /## 前置\n- 无/)
  assert.deepEqual(brief.tokens, { assistant: 0, users: 0 })
})

/* ------------------------------------------------------------------ */
/* write-side helpers                                                  */
/* ------------------------------------------------------------------ */

test('createBlankSession binds the workspace and returns the new id', async () => {
  const { gateway, calls } = gatewayStub({ invoke: () => ({ sessionId: 'session-1' }) })
  const id = await createBlankSession({ typertGateway: gateway }, { workspaceId: 'ws_1', path: 'C:\\p' })

  assert.equal(id, 'session-1')
  assert.deepEqual(calls[0], {
    namespace: 'session',
    method: 'create',
    args: { request: { workspaceId: 'ws_1' } },
  })
})

test('createBlankSession validates workspace and gateway responses', async () => {
  await rejectsCode(() => createBlankSession({}, {}), 'invalid-request', 400)

  const { gateway } = gatewayStub({ invoke: () => ({}) })
  await rejectsCode(() => createBlankSession({ typertGateway: gateway }, { workspaceId: 'ws_1', path: 'p' }), 'host-unavailable', 503)
})

test('createBlankSession falls back to cwd when workspaceId binding is refused', async () => {
  const calls = []
  const gateway = {
    async invoke(request) {
      calls.push(request.args.request)
      if (request.args.request.workspaceId !== undefined) throw new Error('workspace path mismatch')
      return { sessionId: 'session-by-cwd' }
    },
  }
  const ctx = { get: (name) => (name === 'typertGateway' ? gateway : undefined) }
  const sessionId = await createBlankSession(ctx, { workspaceId: 'ws_1', path: 'C:\\proj' })
  assert.equal(sessionId, 'session-by-cwd')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], { workspaceId: 'ws_1' })
  assert.deepEqual(calls[1], { cwd: 'C:\\proj' })
})

test('promptSession sends one queued text message', async () => {
  const { gateway, calls } = gatewayStub({ invoke: () => ({ accepted: true }) })
  await promptSession({ typertGateway: gateway }, 'session-1', '请继续')

  const request = calls[0].args.request
  assert.equal(calls[0].namespace, 'session')
  assert.equal(calls[0].method, 'prompt')
  assert.equal(request.sessionId, 'session-1')
  assert.equal(request.mode, 'queue')
  assert.match(request.requestId, /^task-dag-/)
  assert.deepEqual(request.content, [{ type: 'text', text: '请继续' }])
})

test('promptSession rejects empty text and wraps host failures', async () => {
  await rejectsCode(() => promptSession({}, 'session-1', '   '), 'invalid-request', 400)
  const { gateway } = gatewayStub({ invoke: () => { throw new Error('denied') } })
  await rejectsCode(() => promptSession({ typertGateway: gateway }, 'session-1', 'hi'), 'host-unavailable', 503)
})

test('renameSession is best effort', async () => {
  const { gateway, calls } = gatewayStub({ invoke: () => ({}) })
  assert.equal(await renameSession({ typertGateway: gateway }, 'session-1', '任务 · 续'), true)
  assert.deepEqual(calls[0].args.request, { sessionId: 'session-1', title: '任务 · 续' })

  assert.equal(await renameSession({ typertGateway: gatewayStub({ invoke: () => { throw new Error('no') } }).gateway }, 'session-1', 'x'), false)
  assert.equal(await renameSession({}, 'session-1', 'x'), false)
  assert.equal(await renameSession({ typertGateway: gateway }, 'session-1', '   '), false)
})

test('archiveSession uses the workspace registry when present', async () => {
  const calls = []
  const ctx = {
    workspaceRegistry: {
      async archiveSession(sessionId, options) {
        calls.push({ sessionId, options })
      },
    },
  }
  assert.equal(await archiveSession(ctx, 's1'), true)
  assert.deepEqual(calls, [{ sessionId: 's1', options: { stopActivity: true } }])
  assert.equal(await archiveSession(ctx, 's1', false), true)
  assert.deepEqual(calls[1], { sessionId: 's1', options: { stopActivity: false } })
})

test('archiveSession falls back to the gateway and reports failures as TaskDagError', async () => {
  const { gateway, calls } = gatewayStub({ invoke: () => ({ archivedSessionIds: ['s1'] }) })
  assert.equal(await archiveSession({ typertGateway: gateway, workspaceRegistry: {} }, 's1'), true)
  assert.deepEqual(calls[0], {
    namespace: 'workspace',
    method: 'archiveSession',
    args: { request: { sessionId: 's1', stopActivity: true } },
  })

  await rejectsCode(() => archiveSession({}, 's1'), 'host-unavailable', 503)

  const failingRegistry = {
    workspaceRegistry: { async archiveSession() { throw new Error('session is active') } },
  }
  await rejectsCode(() => archiveSession(failingRegistry, 's1'), 'host-unavailable', 503)
})

test('unarchiveSession uses the registry, then the gateway', async () => {
  const registryCalls = []
  await unarchiveSession({
    workspaceRegistry: { async unarchiveSession(sessionId) { registryCalls.push(sessionId) } },
  }, 's1')
  assert.deepEqual(registryCalls, ['s1'])

  const { gateway, calls } = gatewayStub({ invoke: () => ({}) })
  await unarchiveSession({ typertGateway: gateway, workspaceRegistry: {} }, 's2')
  assert.deepEqual(calls[0], {
    namespace: 'workspace',
    method: 'unarchiveSession',
    args: { request: { sessionId: 's2' } },
  })

  await rejectsCode(() => unarchiveSession({}, 's1'), 'host-unavailable', 503)
})

/* ------------------------------------------------------------------ */
/* presets, models and control events (v2)                             */
/* ------------------------------------------------------------------ */

/** Run `fn` while capturing console.warn lines. */
async function withWarnings(fn) {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  try {
    await fn()
  } finally {
    console.warn = original
  }
  return warnings
}

test('createBlankSession sends agentPreset on every attempt and pins the model', async () => {
  const { gateway, calls } = gatewayStub({
    invoke: (request) => {
      if (request.method === 'create') {
        if (request.args.request.workspaceId !== undefined) throw new Error('workspace path mismatch')
        return { sessionId: 'session-2' }
      }
      return {}
    },
  })
  const ctx = { typertGateway: gateway }

  const id = await createBlankSession(ctx, { workspaceId: 'ws_1', path: 'C:\\proj' }, {
    agentPreset: 'preset-a',
    model: 'openai/gpt-x',
  })

  assert.equal(id, 'session-2')
  assert.deepEqual(calls.filter((call) => call.method === 'create').map((call) => call.args.request), [
    { workspaceId: 'ws_1', agentPreset: 'preset-a' },
    { cwd: 'C:\\proj', agentPreset: 'preset-a' },
  ])
  const select = calls.find((call) => call.method === 'selectModel')
  assert.deepEqual(select.args.request, { sessionId: 'session-2', provider: 'openai', model: 'gpt-x' })
})

test('createBlankSession keeps the session when model selection fails', async () => {
  const { gateway } = gatewayStub({
    invoke: (request) => {
      if (request.method === 'create') return { sessionId: 'session-3' }
      if (request.method === 'selectModel') throw new Error('unknown model')
      return {}
    },
  })

  let sessionId
  const warnings = await withWarnings(async () => {
    sessionId = await createBlankSession({ typertGateway: gateway }, { workspaceId: 'ws_1' }, {
      model: 'gone/model',
    })
  })

  assert.equal(sessionId, 'session-3')
  assert.ok(warnings.some((line) => line.includes('选择模型')), 'the failure is reported as a warning')
})

test('selectModel accepts provider/model and bare model ids, and never throws', async () => {
  const { gateway, calls } = gatewayStub()
  const ctx = { typertGateway: gateway }

  assert.equal(await selectModel(ctx, 's1', 'deepseek/chat'), true)
  assert.deepEqual(calls[0].args.request, { sessionId: 's1', provider: 'deepseek', model: 'chat' })

  assert.equal(await selectModel(ctx, 's1', 'gpt-x'), true)
  assert.deepEqual(calls[1].args.request, { sessionId: 's1', model: 'gpt-x' })

  assert.equal(await selectModel(ctx, '', 'gpt-x'), false)
  assert.equal(await selectModel(ctx, 's1', '   '), false)

  const failing = gatewayStub({ invoke: () => { throw new Error('no provider') } })
  let result
  const warnings = await withWarnings(async () => {
    result = await selectModel({ typertGateway: failing.gateway }, 's1', 'gone/model')
  })
  assert.equal(result, false)
  assert.ok(warnings.some((line) => line.includes('no provider')))
})

test('listAgentPresets normalizes the catalog and uses bare {} args', async () => {
  const { gateway, calls } = gatewayStub({
    invoke: () => ({
      presets: [
        { id: 'p1', label: '预设一' },
        { id: 'p2', broken: '依赖缺失' },
        { id: 'p3', broken: true },
        { id: '   ' },
        null,
      ],
    }),
  })

  const presets = await listAgentPresets({ typertGateway: gateway })

  assert.deepEqual(presets, [
    { id: 'p1', label: '预设一' },
    { id: 'p2', broken: '依赖缺失' },
    { id: 'p3', broken: '不可用' },
  ])
  assert.deepEqual(calls[0], { namespace: 'agentPresets', method: 'list', args: {} })
})

test('listAgentPresets degrades to an empty catalog', async () => {
  assert.deepEqual(await listAgentPresets({}), [])
  const failing = gatewayStub({ invoke: () => { throw new Error('denied') } })
  let presets
  await withWarnings(async () => {
    presets = await listAgentPresets({ typertGateway: failing.gateway })
  })
  assert.deepEqual(presets, [])
})

test('listModelCatalog accepts grouped, item and flat model shapes', async () => {
  const grouped = gatewayStub({
    invoke: () => ({
      groups: [
        { provider: 'openai', models: [{ id: 'gpt-x', name: 'GPT-X' }, { id: 'gpt-y' }] },
        { provider: 'deepseek', models: [{ id: 'chat', label: 'Chat' }] },
      ],
    }),
  })
  const groupedCatalog = await listModelCatalog({ typertGateway: grouped.gateway })
  assert.deepEqual(groupedCatalog, [
    { provider: 'openai', id: 'gpt-x', label: 'GPT-X' },
    { provider: 'openai', id: 'gpt-y', label: 'gpt-y' },
    { provider: 'deepseek', id: 'chat', label: 'Chat' },
  ])
  assert.deepEqual(grouped.calls[0], {
    namespace: 'session',
    method: 'modelCatalog',
    args: { request: {} },
  })

  const items = gatewayStub({
    invoke: () => ({ items: [{ provider: 'openai', id: 'gpt-z', name: 'GPT-Z' }, 'bare-model'] }),
  })
  assert.deepEqual(await listModelCatalog({ typertGateway: items.gateway }), [
    { provider: 'openai', id: 'gpt-z', label: 'GPT-Z' },
    { provider: '', id: 'bare-model', label: 'bare-model' },
  ])

  const flat = gatewayStub({ invoke: () => ({ models: [{ id: 'm1' }] }) })
  assert.deepEqual(await listModelCatalog({ typertGateway: flat.gateway }), [
    { provider: '', id: 'm1', label: 'm1' },
  ])
})

test('listModelCatalog prefers the live LLM registry and keeps reasoning levels', async () => {
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek 官方' }],
      listModels: async () => [
        { id: 'chat', name: 'DeepSeek Chat' },
        { id: 'reasoner', name: 'DeepSeek Reasoner' },
      ],
      resolveModelInfo: async (provider, model) => (model === 'reasoner'
        ? {
            reasoning: {
              efforts: [
                { id: 'low', name: '低' },
                { id: 'high', name: '高', description: '更长的思考' },
              ],
              defaultEffort: 'high',
            },
          }
        : {}),
    },
  }
  const catalog = await listModelCatalog(ctx)
  assert.deepEqual(catalog, [
    { provider: 'deepseek', providerLabel: 'DeepSeek 官方', id: 'chat', label: 'DeepSeek Chat' },
    {
      provider: 'deepseek',
      providerLabel: 'DeepSeek 官方',
      id: 'reasoner',
      label: 'DeepSeek Reasoner',
      reasoning: {
        efforts: [
          { id: 'low', name: '低' },
          { id: 'high', name: '高', description: '更长的思考' },
        ],
        defaultEffort: 'high',
      },
    },
  ])
})

test('applySessionTarget pins the model and reasoning effort on an existing session', async () => {
  const { gateway, calls } = gatewayStub()
  const applied = await applySessionTarget({ typertGateway: gateway }, 's1', {
    model: 'prov/m1',
    reasoningEffort: 'high',
  })
  assert.deepEqual(applied, { applied: true, warning: null })
  assert.equal(calls.at(-1).method, 'selectModel')
  assert.deepEqual(calls.at(-1).args, {
    request: { sessionId: 's1', model: 'm1', provider: 'prov', reasoningEffort: 'high' },
  })
})

test('listModelCatalog degrades to an empty catalog', async () => {
  assert.deepEqual(await listModelCatalog({}), [])
  const failing = gatewayStub({ invoke: () => { throw new Error('no catalog') } })
  let catalog
  await withWarnings(async () => {
    catalog = await listModelCatalog({ typertGateway: failing.gateway })
  })
  assert.deepEqual(catalog, [])
})

test('readSessionEvents keeps control events from the live log without filtering', async () => {
  const log = [
    { type: 'turn/start', seq: 1, time: 1, data: {} },
    { type: 'user/message', seq: 2, time: 2, data: { text: '开始' } },
    { type: 'assistant/message', seq: 3, time: 3, data: { text: '做完了' } },
    { type: 'turn/end', seq: 4, time: 4, data: { reason: { kind: 'completed' } } },
  ]
  const { gateway, calls } = gatewayStub()
  const ctx = { sessions: { get: () => ({ log }) }, typertGateway: gateway }

  const result = await readSessionEvents(ctx, 's1')

  assert.equal(result.source, 'log')
  assert.deepEqual(result.events.map((event) => event.type), [
    'turn/start',
    'user/message',
    'assistant/message',
    'turn/end',
  ])
  assert.equal(result.events.at(-1).data.reason.kind, 'completed')
  assert.equal(calls.length, 0)

  const limited = await readSessionEvents(ctx, 's1', 2)
  assert.deepEqual(limited.events.map((event) => event.type), ['assistant/message', 'turn/end'])
})

test('readSessionEvents falls back to the follow snapshot and degrades safely', async () => {
  const state = {}
  const { gateway } = gatewayStub({
    stream: () => snapshotStream([
      { type: 'turn/start', seq: 1, time: 1, data: {} },
      { type: 'turn/end', seq: 2, time: 2, data: { reason: { kind: 'error', message: 'boom' } } },
    ], state),
  })
  const ctx = { sessions: { get: () => ({ header: {} }) }, typertGateway: gateway }

  const result = await readSessionEvents(ctx, 'cold', 10)
  assert.equal(result.source, 'follow')
  assert.deepEqual(result.events.map((event) => event.type), ['turn/start', 'turn/end'])
  assert.equal(state.closed, true)

  const unavailable = await readSessionEvents({}, 's1')
  assert.equal(unavailable.source, 'unavailable')
  assert.deepEqual(unavailable.events, [])

  const emptyId = await readSessionEvents({}, '')
  assert.equal(emptyId.source, 'unavailable')
})
