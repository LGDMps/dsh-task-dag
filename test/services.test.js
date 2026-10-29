/**
 * Regression tests for optional-service access.
 *
 * The bug this pins: Cordis installs the plugin context behind a proxy whose
 * `get` trap throws `cannot get property "<name>" without inject` for a service
 * the plugin did not declare. Reaching for `ctx.typertGateway` therefore threw a
 * raw error, which surfaced as an opaque 500 on the very first handoff click
 * while every graph-only action kept working.
 *
 * Run: node test/services.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { getService } from '../src/services.js'
import { createBlankSession, sessionFacts } from '../src/sessions.js'
import { isTaskDagError } from '../src/errors.js'

/**
 * A context shaped like the real one: service lookup only through `get()`, and
 * every other property access throws the Cordis "without inject" error.
 */
function cordisLikeContext(services) {
  const target = {
    get(name) {
      return services[name]
    },
  }
  return new Proxy(target, {
    get(object, prop, receiver) {
      if (prop in object) return Reflect.get(object, prop, receiver)
      if (typeof prop === 'symbol') return undefined
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

function gateway(overrides = {}) {
  return {
    async invoke(request) {
      const method = request?.method
      if (overrides[method] !== undefined) return overrides[method](request)
      if (method === 'list') return { items: [] }
      if (method === 'create') return { sessionId: 'session-created' }
      return {}
    },
    ...overrides.gatewayMethods,
  }
}

test('getService reads through ctx.get and never trips the inject proxy', () => {
  const service = { marker: true }
  const ctx = cordisLikeContext({ demo: service })
  assert.equal(getService(ctx, 'demo'), service)
  assert.equal(getService(ctx, 'missing'), undefined)
  assert.equal(getService(undefined, 'demo'), undefined)
  assert.equal(getService(ctx, ''), undefined)
})

test('getService falls back to plain property access for simple fake contexts', () => {
  const service = { list: () => [] }
  assert.equal(getService({ workspaceRegistry: service }, 'workspaceRegistry'), service)
  assert.equal(getService({}, 'workspaceRegistry'), undefined)
})

test('getService prefers ctx.get over a property that happens to exist', () => {
  const official = { official: true }
  const ctx = { get: (name) => (name === 'demo' ? official : undefined), demo: { stale: true } }
  assert.deepEqual(getService(ctx, 'demo'), official)
})

test('creating a blank session works on an inject-guarded context', async () => {
  const ctx = cordisLikeContext({
    typertGateway: gateway(),
    workspaceRegistry: { list: () => [] },
  })

  const sessionId = await createBlankSession(ctx, {
    workspaceId: 'ws_test',
    path: 'C:\\project',
    title: 'project',
  })
  assert.equal(sessionId, 'session-created')
})

test('session facts read the list through the same guarded access', async () => {
  const ctx = cordisLikeContext({
    typertGateway: {
      async invoke(request) {
        assert.equal(request.method, 'list')
        return {
          items: [{
            sessionId: 's1',
            updatedAt: 1,
            running: true,
            blank: false,
            cwd: 'C:\\project',
            projections: { values: { title: '会话一', contextPressure: { contextWindow: 100, projectedTokens: 40 } } },
          }],
        }
      },
    },
    workspaceRegistry: { list: () => [{ id: 'ws_test', path: 'C:\\project', title: 'project', sessionIds: [] }] },
  })

  const facts = await sessionFacts(ctx, ['s1', 's2'])
  assert.equal(facts.byId.s1.running, true)
  assert.equal(facts.byId.s1.title, '会话一')
  assert.equal(facts.byId.s1.contextPressure.ratio, 0.4)
  assert.equal(facts.byId.s2.available, false)
})

test('a context without any session service yields a readable 503, not a crash', async () => {
  const ctx = cordisLikeContext({ workspaceRegistry: { list: () => [] } })
  await assert.rejects(
    () => createBlankSession(ctx, { workspaceId: 'ws_test', path: 'C:\\project', title: 'project' }),
    (error) => {
      assert.equal(isTaskDagError(error), true, 'must be a TaskDagError so the route maps it to 503')
      assert.equal(error.status, 503)
      assert.match(error.message, /会话服务/)
      return true
    },
  )
})

/**
 * A gateway that behaves like DSH 0.2.1-rc.3: an in-process call MUST carry a
 * Peer, because `prepareInvocation` runs `assertPeerLive(request.peer)` and that
 * reads `peer.signal`. Omitting the peer produces exactly the opaque TypeError
 * this regression pins.
 */
function rc3Gateway(calls) {
  return {
    async invoke(request) {
      if (request.peer === undefined) throw new TypeError("Cannot read properties of undefined (reading 'signal')")
      calls.push(request)
      if (request.method === 'list') return { items: [] }
      if (request.method === 'create') return { sessionId: 'session-created' }
      return {}
    },
    async stream(request) {
      if (request.peer === undefined) throw new TypeError("Cannot read properties of undefined (reading 'signal')")
      calls.push(request)
      return (async function* empty() {})()
    },
  }
}

function connectionStub(created) {
  return {
    createPeer(options) {
      const peer = {
        options,
        principal: options.principal,
        signal: new AbortController().signal,
      }
      created.push(peer)
      return peer
    },
  }
}

test('gateway calls carry an in-process Peer, as rc.3 requires', async () => {
  const calls = []
  const peers = []
  const ctx = cordisLikeContext({
    typertGateway: rc3Gateway(calls),
    connection: connectionStub(peers),
    workspaceRegistry: { list: () => [] },
  })

  const sessionId = await createBlankSession(ctx, { workspaceId: 'ws_1', path: 'C:\\proj' })
  assert.equal(sessionId, 'session-created')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].peer, peers[0], 'the created Peer is forwarded to the gateway')
  assert.equal(peers[0].principal.kind, 'owner')

  // The Peer is created once per context and reused, not per call.
  await sessionFacts(ctx, ['s1'])
  assert.equal(peers.length, 1)
  assert.equal(calls[1].peer, peers[0])
})

test('a context without a connection service still calls through and reports the failure verbatim', async () => {
  const calls = []
  const ctx = cordisLikeContext({ typertGateway: rc3Gateway(calls), workspaceRegistry: { list: () => [] } })

  await assert.rejects(
    () => createBlankSession(ctx, { workspaceId: 'ws_1', path: 'C:\\proj' }),
    (error) => {
      assert.equal(isTaskDagError(error), true)
      assert.equal(error.status, 503)
      // The opaque platform error is preserved as the cause so it stays diagnosable.
      assert.match(error.message, /reading 'signal'/)
      return true
    },
  )
})

test('the follow stream also carries the Peer', async () => {
  const calls = []
  const peers = []
  const ctx = cordisLikeContext({
    typertGateway: rc3Gateway(calls),
    connection: connectionStub(peers),
    workspaceRegistry: { list: () => [] },
  })
  const { readTail } = await import('../src/sessions.js')
  const tail = await readTail(ctx, 'session-cold', 8)
  assert.equal(tail.source, 'follow')
  assert.equal(calls[0].method, 'follow')
  assert.equal(calls[0].peer, peers[0])
})

test('presets, models and the catalog resolve through the guarded context', async () => {
  const calls = []
  const ctx = cordisLikeContext({
    typertGateway: {
      async invoke(request) {
        calls.push(request)
        if (request.method === 'create') return { sessionId: 'session-preset' }
        if (request.method === 'selectModel') return {}
        if (request.namespace === 'session' && request.method === 'list') return { items: [] }
        if (request.namespace === 'session' && request.method === 'modelCatalog') {
          return { groups: [{ provider: 'openai', models: [{ id: 'gpt-x', name: 'GPT-X' }] }] }
        }
        if (request.namespace === 'agentPresets' && request.method === 'list') {
          return { presets: [{ id: 'preset-a', label: '预设 A' }] }
        }
        return {}
      },
      async stream() { return (async function* empty() {})() },
    },
    workspaceRegistry: { list: () => [] },
  })

  const { createBlankSession, listAgentPresets, listModelCatalog } = await import('../src/sessions.js')
  const sessionId = await createBlankSession(ctx, { workspaceId: 'ws_1', path: 'C:\\proj' }, {
    agentPreset: 'preset-a',
    model: 'openai/gpt-x',
  })
  assert.equal(sessionId, 'session-preset')
  assert.deepEqual(calls[0].args.request, { workspaceId: 'ws_1', agentPreset: 'preset-a' })
  assert.deepEqual(calls[1].args.request, { sessionId: 'session-preset', provider: 'openai', model: 'gpt-x' })

  assert.deepEqual(await listAgentPresets(ctx), [{ id: 'preset-a', label: '预设 A' }])
  assert.deepEqual(await listModelCatalog(ctx), [{ provider: 'openai', id: 'gpt-x', label: 'GPT-X' }])
})

test('a catalog on a context without a gateway is empty, not a crash', async () => {
  const { listAgentPresets, listModelCatalog } = await import('../src/sessions.js')
  const ctx = cordisLikeContext({ workspaceRegistry: { list: () => [] } })
  assert.deepEqual(await listAgentPresets(ctx), [])
  assert.deepEqual(await listModelCatalog(ctx), [])
})
