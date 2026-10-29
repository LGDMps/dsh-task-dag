/**
 * Edge-routing render test for the browser half.
 *
 * A straight/curved edge between two nodes must not cut through an unrelated
 * node that happens to sit between them. The graph below puts A and B on one
 * row and an unconnected C exactly on the line between their handles: the
 * ordinary cubic curve would run through C, so the canvas must re-route the
 * edge around it. Two parallel A -> B edges also prove that the detour keeps
 * the per-condition separation.
 *
 * Run: node test/client.routing.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

import React from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8')
const WORKSPACE_ID = 'ws_routing'
const NOW = '2026-10-30T12:00:00.000Z'
const NODE_W = 208
const NODE_H = 84

/** A and B connected by two edges; C sits between them and joins nothing. */
function fixtureState() {
  const nodes = [
    { id: 'n_a', title: '起点', status: 'todo', notes: '', conditions: [], sessions: [], position: { x: 40, y: 40 } },
    { id: 'n_b', title: '终点', status: 'todo', notes: '', conditions: [], sessions: [], position: { x: 600, y: 40 } },
    { id: 'n_c', title: '无关节点', status: 'todo', notes: '', conditions: [], sessions: [], position: { x: 320, y: 40 } },
  ].map((node) => ({
    ...node,
    agentPreset: null,
    model: null,
    reasoningEffort: null,
    schedule: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    failedAt: null,
  }))
  return {
    ok: true,
    snapshot: {
      workspace: { workspaceId: WORKSPACE_ID, path: 'C:\\routing', title: '路由测试' },
      graph: {
        schemaVersion: 2,
        workspaceId: WORKSPACE_ID,
        workspacePath: 'C:\\routing',
        title: '路由测试',
        revision: 1,
        milestoneNodeId: null,
        nodes,
        edges: [
          { id: 'e_one', from: 'n_a', to: 'n_b', conditionId: 'c_b_one' },
          { id: 'e_two', from: 'n_a', to: 'n_b', conditionId: 'c_b_two' },
        ],
      },
      derived: {
        ready: ['n_a', 'n_c'],
        blocked: [],
        doing: [],
        done: [],
        failed: [],
        planned: [],
        levels: { n_a: 0, n_b: 1, n_c: 0 },
        order: ['n_a', 'n_c', 'n_b'],
        conditions: {},
        progress: { done: 0, total: 3, ready: 2, blocked: 0, doing: 0, failed: 0, planned: 0 },
        milestone: null,
      },
      sessions: { byId: {}, archived: [], warnings: [] },
      notes: [],
    },
  }
}

const WORKSPACES_FIXTURE = {
  ok: true,
  workspaces: [{
    workspaceId: WORKSPACE_ID,
    path: 'C:\\routing',
    title: '路由测试',
    revision: 1,
    progress: { done: 0, total: 3, ready: 2, blocked: 0, doing: 0, failed: 0, planned: 0 },
    readyCount: 2,
  }],
}

const CATALOG_FIXTURE = { ok: true, catalog: { presets: [], models: [], warnings: [] } }

/** Sample every M/L/Q/C command of an SVG path into points on the curve. */
function samplePath(d, perCurve = 32) {
  const commands = typeof d === 'string' ? d.match(/[MLQC][^MLQC]*/g) || [] : []
  const points = []
  let current = { x: 0, y: 0 }
  for (const command of commands) {
    const type = command[0]
    const nums = command.slice(1).trim().split(/[\s,]+/).filter(Boolean).map(Number)
    if (type === 'M' || type === 'L') {
      current = { x: nums[0], y: nums[1] }
      points.push(current)
      continue
    }
    if (type === 'Q') {
      const control = { x: nums[0], y: nums[1] }
      const end = { x: nums[2], y: nums[3] }
      for (let step = 1; step <= perCurve; step += 1) {
        const t = step / perCurve
        const mt = 1 - t
        points.push({
          x: mt * mt * current.x + 2 * mt * t * control.x + t * t * end.x,
          y: mt * mt * current.y + 2 * mt * t * control.y + t * t * end.y,
        })
      }
      current = end
      continue
    }
    if (type === 'C') {
      const c1 = { x: nums[0], y: nums[1] }
      const c2 = { x: nums[2], y: nums[3] }
      const end = { x: nums[4], y: nums[5] }
      for (let step = 1; step <= perCurve; step += 1) {
        const t = step / perCurve
        const mt = 1 - t
        points.push({
          x: mt * mt * mt * current.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * end.x,
          y: mt * mt * mt * current.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * end.y,
        })
      }
      current = end
    }
  }
  return points
}

function insideNode(point, position) {
  return point.x > position.x + 1 && point.x < position.x + NODE_W - 1
    && point.y > position.y + 1 && point.y < position.y + NODE_H - 1
}

class FakeEventSource {
  constructor() {
    this.readyState = 1
  }

  addEventListener() {}

  removeEventListener() {}

  close() {
    this.readyState = 2
  }
}

test('an edge routes around a node it does not connect', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:5484/',
    pretendToBeVisual: true,
  })
  const { window } = dom
  const globalKeys = [
    'window', 'document', 'localStorage', 'EventSource', 'fetch', 'HTMLElement',
    'Element', 'Node', 'getComputedStyle', 'requestAnimationFrame',
    'cancelAnimationFrame', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT',
  ]
  const saved = new Map(globalKeys.map((key) => [key, globalThis[key]]))

  const fetchStub = async (url) => {
    const target = String(url)
    const body = target.includes('/workspaces')
      ? WORKSPACES_FIXTURE
      : target.includes('/catalog')
        ? CATALOG_FIXTURE
        : target.includes('/state')
          ? fixtureState()
          : { ok: true }
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  }

  globalThis.window = window
  globalThis.document = window.document
  globalThis.localStorage = window.localStorage
  globalThis.EventSource = FakeEventSource
  globalThis.fetch = fetchStub
  globalThis.HTMLElement = window.HTMLElement
  globalThis.Element = window.Element
  globalThis.Node = window.Node
  globalThis.getComputedStyle = window.getComputedStyle.bind(window)
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0)
  globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle)
  globalThis.ResizeObserver = class {
    observe() {}

    unobserve() {}

    disconnect() {}
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
    window.close()
  })

  let captured
  window.__ModuleLoader__ = {
    load(definition) {
      captured = definition
    },
  }
  vm.runInThisContext(clientSource, { filename: 'client.js' })
  assert.ok(captured, 'client.js must call window.__ModuleLoader__.load')

  const registered = {}
  const ctx = {
    slots: {
      inject(_key, callback) {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(options, component) {
        registered[options.name] = { options, component }
        return () => {}
      },
    },
    workspaces: { list: { getSnapshot: () => ({ items: [], archivedSessionIds: [], pinnedSessionIds: [] }) } },
    sessions: { list: { getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready' }) } },
    get() {
      return undefined
    },
    uiWorkspace: { openSession() {} },
    layout: { selectPanel() {} },
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on() {
      return () => {}
    },
  }

  const moduleApi = captured.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require(${specifier})`)
  })
  moduleApi.apply(ctx)
  assert.ok(registered.main, 'the main panel must be registered')

  const { act } = React
  const container = window.document.getElementById('root')
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(registered.main.component, {}))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  const paths = [...container.querySelectorAll('path.dsh-td-edge')]
  assert.equal(paths.length, 2, 'both parallel edges render')

  const blocker = { x: 320, y: 40 }
  const startHandle = { x: 40 + NODE_W, y: 40 + NODE_H / 2 }
  const endHandle = { x: 600, y: 40 + NODE_H / 2 }
  for (const path of paths) {
    const d = path.getAttribute('d') ?? ''
    assert.ok(d !== '', 'the edge has path data')
    assert.match(d, /[LQ]/, 'the blocked curve is replaced by a routed polyline')
    const points = samplePath(d)
    assert.ok(points.length > 4, 'the routed path has enough samples')
    for (const point of points) {
      assert.equal(
        insideNode(point, blocker),
        false,
        'the edge must not pass through the unconnected node at ' + JSON.stringify(point),
      )
    }
    assert.ok(Math.abs(points[0].x - startHandle.x) < 0.6 && Math.abs(points[0].y - startHandle.y) < 0.6,
      'the edge still starts at the source handle')
    const last = points[points.length - 1]
    assert.ok(Math.abs(last.x - endHandle.x) < 0.6 && Math.abs(last.y - endHandle.y) < 0.6,
      'the edge still ends at the target handle')
  }

  const first = paths[0].getAttribute('d')
  const second = paths[1].getAttribute('d')
  assert.notEqual(first, second, 'parallel edges keep separate lanes after routing')

  await act(async () => {
    root.unmount()
  })
})
