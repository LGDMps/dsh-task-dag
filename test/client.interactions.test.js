/**
 * Interaction tests for the third UI round of the browser half.
 *
 * Covers the four behaviours that are not visible from a static render:
 *   1. long node titles are fitted to the card and clipped at its border;
 *   2. a manual node drag can be undone back to the pre-drag positions;
 *   3. an auto layout can be undone back to the pre-layout positions;
 *   4. Alt + left drag draws a lasso, selects only fully enclosed nodes, opens
 *      the group-name dialog, posts `create-group`, and renders one dashed
 *      contour whose corners use the card radius and whose corridor follows the
 *      routed edges.
 *
 * The panel is mounted against a mutable in-memory graph, so action responses
 * behave like the Host's snapshots (positions/groups applied, revision bumped).
 *
 * Run: node test/client.interactions.test.js
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

const WORKSPACE_ID = 'ws_interactions'
const NOW = '2026-10-31T12:00:00.000Z'
const NODE_W = 208
const NODE_H = 84
const GRID_W = 320
const GRID_H = 198
const GRID_X0 = 40
const GRID_Y0 = 40

class FakeEventSource {
  constructor(url) {
    this.url = url
    this.readyState = 1
  }

  addEventListener() {}

  removeEventListener() {}

  close() {
    this.readyState = 2
  }
}

function node(id, title, x, y, status = 'todo') {
  return {
    id,
    title,
    status,
    notes: '',
    conditions: [],
    sessions: [],
    position: { x, y },
    agentPreset: null,
    model: null,
    reasoningEffort: null,
    schedule: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: status === 'done' ? NOW : null,
    failedAt: null,
  }
}

function intervalGraph() {
  return {
    schemaVersion: 2,
    workspaceId: WORKSPACE_ID,
    workspacePath: 'C:\\interaction',
    title: '交互测试',
    revision: 4,
    milestoneNodeId: null,
    nodes: [
      node('n_a', '起点任务', 40, 40),
      node('n_b', '终点任务', 400, 40),
      node('n_c', '远处的任务', 40, 300),
    ],
    edges: [
      { id: 'e_ab', from: 'n_a', to: 'n_b', conditionId: 'c_b' },
    ],
    groups: [],
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function derivedFor(graph) {
  const ready = graph.nodes.filter((item) => item.status === 'todo').map((item) => item.id)
  return {
    ready,
    blocked: [],
    doing: [],
    done: [],
    failed: [],
    planned: [],
    levels: {},
    order: graph.nodes.map((item) => item.id),
    conditions: {},
    progress: {
      done: 0,
      total: graph.nodes.length,
      ready: ready.length,
      blocked: 0,
      doing: 0,
      failed: 0,
      planned: 0,
    },
    milestone: null,
  }
}

function snapshotOf(graph) {
  return {
    ok: true,
    snapshot: {
      workspace: { workspaceId: WORKSPACE_ID, path: 'C:\\interaction', title: '交互测试' },
      graph: clone(graph),
      derived: derivedFor(graph),
      sessions: { byId: {}, archived: [], warnings: [] },
      notes: [],
    },
  }
}

function applyAction(graph, action, payload) {
  if (action === 'set-positions') {
    for (const entry of Array.isArray(payload.positions) ? payload.positions : []) {
      const target = graph.nodes.find((item) => item.id === entry.nodeId)
      if (target === undefined) continue
      target.position = entry.position === null || entry.position === undefined
        ? null
        : { x: entry.position.x, y: entry.position.y }
    }
  } else if (action === 'create-group') {
    graph.groups.push({
      id: 'g_' + String(graph.groups.length + 1).padStart(8, '0'),
      name: payload.name,
      nodeIds: payload.nodeIds.slice(),
      createdAt: NOW,
      updatedAt: NOW,
    })
  } else if (action === 'rename-group') {
    const group = graph.groups.find((item) => item.id === payload.groupId)
    if (group !== undefined) group.name = payload.name
  } else if (action === 'delete-group') {
    graph.groups = graph.groups.filter((item) => item.id !== payload.groupId)
  }
  graph.revision += 1
}

/** Width of a title line in em units (CJK = 1em, everything else = 0.55em). */
function titleWidthEm(text) {
  let width = 0
  for (const char of String(text)) {
    if (char === '…') {
      width += 1
      continue
    }
    const code = char.codePointAt(0)
    width += code >= 0x2e80 ? 1 : 0.55
  }
  return width
}

function setReactValue(window, element, value) {
  const prototype = element.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  assert.equal(typeof setter, 'function', 'the native value setter must exist')
  setter.call(element, value)
  const propsKey = Object.keys(element).find((key) => key.startsWith('__reactProps$'))
  const handler = propsKey !== undefined ? element[propsKey]?.onChange : undefined
  assert.equal(typeof handler, 'function', 'the input must expose its React onChange prop')
  handler({ target: element, currentTarget: element, preventDefault() {}, stopPropagation() {} })
}

function pointer(window, type, options) {
  return new window.MouseEvent(type, Object.assign({
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
  }, options))
}

/** Sample an SVG path made of M/L/Q/C commands into points on the curve. */
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

/**
 * Mount the panel with a mutable graph.
 *
 * `mutateGraph` runs before the first snapshot, so a test can adjust titles or
 * positions without touching the fixture defaults.
 */
async function mountPanel(t, mutateGraph) {
  const graph = intervalGraph()
  if (typeof mutateGraph === 'function') mutateGraph(graph)

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:5484/',
    pretendToBeVisual: true,
  })
  const { window } = dom
  const requests = []
  const globalKeys = [
    'window', 'document', 'localStorage', 'EventSource', 'fetch', 'HTMLElement',
    'Element', 'Node', 'getComputedStyle', 'requestAnimationFrame',
    'cancelAnimationFrame', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT',
  ]
  const saved = new Map(globalKeys.map((key) => [key, globalThis[key]]))

  const fetchStub = async (url, init) => {
    const target = String(url)
    const method = init?.method ?? 'GET'
    const requestBody = typeof init?.body === 'string' ? init.body : null
    requests.push({ url: target, method, body: requestBody })
    let body
    if (target.includes('/workspaces')) {
      body = {
        ok: true,
        workspaces: [{
          workspaceId: WORKSPACE_ID,
          path: 'C:\\interaction',
          title: '交互测试',
          revision: graph.revision,
          progress: { done: 0, total: graph.nodes.length, ready: 0, blocked: 0, doing: 0, failed: 0, planned: 0 },
          readyCount: 0,
        }],
      }
    } else if (target.includes('/catalog')) {
      body = { ok: true, catalog: { presets: [], models: [], warnings: [] } }
    } else if (target.includes('/action')) {
      const parsed = JSON.parse(requestBody ?? '{}')
      applyAction(graph, parsed.action, parsed.payload ?? {})
      body = snapshotOf(graph)
    } else {
      body = snapshotOf(graph)
    }
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

  // A persisted viewport keeps the world coordinates equal to client
  // coordinates (scale 1, origin 0), which makes pointer maths exact.
  window.localStorage.setItem('dsh.task-dag', JSON.stringify({
    workspaceId: WORKSPACE_ID,
    viewport: { x: 0, y: 0, scale: 1 },
  }))

  await act(async () => {
    root.render(React.createElement(registered.main.component, {}))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60))
  })

  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    for (const [key, value] of saved) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
    window.close()
  })

  const settle = async (ms = 30) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms))
    })
  }

  const nodeCard = (title) => [...container.querySelectorAll('g.dsh-td-node')].find((group) => {
    const tooltip = group.querySelector('title')
    return (tooltip?.textContent ?? '').startsWith(title)
  })

  const nodeTransform = (title) => {
    const card = nodeCard(title)
    assert.ok(card, 'node must render: ' + title)
    const match = /translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(card.getAttribute('transform') ?? '')
    assert.ok(match, 'node transform must be a translate: ' + title)
    return { x: Number(match[1]), y: Number(match[2]) }
  }

  const actionRequests = () => requests
    .filter((request) => request.url.includes('/action') && request.body !== null)
    .map((request) => JSON.parse(request.body))

  return { window, container, graph, requests, settle, act, nodeCard, nodeTransform, actionRequests }
}

test('long node titles are fitted to the card width and clipped at its border', async (t) => {
  const longTitle = '这是一个非常非常长的任务标题会溢出节点边框还有更多更多更多文字'
  const harness = await mountPanel(t, (graph) => {
    graph.nodes[0].title = longTitle
  })
  const card = harness.nodeCard('这是一个非常非常长')
  assert.ok(card, 'the long-title card must render')

  const content = card.querySelector('g.dsh-td-node-content')
  assert.ok(content, 'card content is wrapped for clipping')
  const clipReference = content.getAttribute('clip-path') ?? ''
  assert.match(clipReference, /^url\(#dsh-td-node-clip-/, 'card content is clipped to a rounded rectangle')
  const clipId = clipReference.replace(/^url\(#/, '').replace(/\)$/, '')
  const clipPath = harness.container.querySelector('clipPath[id="' + clipId + '"]')
  assert.ok(clipPath, 'the clip path is defined next to the card')

  const lines = [...card.querySelectorAll('text.dsh-td-node-title')].map((element) => element.textContent ?? '')
  assert.equal(lines.length, 2, 'a long title uses at most two lines')
  assert.ok(lines[1].endsWith('…'), 'the fitted title ends with an ellipsis')
  for (const line of lines) {
    assert.ok(titleWidthEm(line) <= 12.5, 'line fits the card width: ' + line + ' (' + titleWidthEm(line) + 'em)')
  }
  assert.equal(lines[0].startsWith('这是一个非常非常长'), true, 'the first line keeps the beginning')
  // The full title survives in the tooltip, where there is room for it.
  assert.ok((card.querySelector('title')?.textContent ?? '').includes(longTitle))
})

test('a manual node drag can be undone back to the pre-drag positions', async (t) => {
  const harness = await mountPanel(t)
  const before = harness.nodeTransform('起点任务')
  assert.deepEqual(before, { x: 40, y: 40 })

  await harness.act(async () => {
    const card = harness.nodeCard('起点任务')
    card.dispatchEvent(pointer(harness.window, 'pointerdown', { clientX: 0, clientY: 0 }))
    harness.window.dispatchEvent(pointer(harness.window, 'pointermove', { clientX: 120, clientY: 60 }))
    harness.window.dispatchEvent(pointer(harness.window, 'pointerup', { clientX: 120, clientY: 60 }))
  })
  await harness.settle()

  const dragRequests = harness.actionRequests().filter((request) => request.action === 'set-positions')
  assert.ok(dragRequests.length >= 1, 'the drop is written to the Host')
  const dragged = dragRequests[dragRequests.length - 1].payload.positions
    .find((entry) => entry.nodeId === 'n_a')
  assert.deepEqual(dragged.position, { x: 160, y: 100 }, 'the node lands at the dragged position')

  const undoButton = [...harness.container.querySelectorAll('button')]
    .find((button) => (button.textContent ?? '') === '撤销')
  assert.ok(undoButton, 'the canvas toolbar has an undo button')
  assert.equal(undoButton.disabled, false, 'undo becomes available after a drag')

  await harness.act(async () => {
    undoButton.click()
  })
  await harness.settle()

  const requestsAfterUndo = harness.actionRequests().filter((request) => request.action === 'set-positions')
  assert.ok(requestsAfterUndo.length >= 2, 'undo posts the restored positions')
  const restored = requestsAfterUndo[requestsAfterUndo.length - 1].payload.positions
  const restoredA = restored.find((entry) => entry.nodeId === 'n_a')
  assert.deepEqual(restoredA.position, { x: 40, y: 40 }, 'undo restores the node to its original spot')
  assert.deepEqual(harness.nodeTransform('起点任务'), { x: 40, y: 40 }, 'the card is back at the original spot')
})

test('an auto layout can be undone back to the pre-layout positions', async (t) => {
  const harness = await mountPanel(t, (graph) => {
    // Manual, deliberately irregular positions: auto layout must move them.
    graph.nodes[0].position = { x: 40, y: 40 }
    graph.nodes[1].position = { x: 40, y: 260 }
    graph.nodes[2].position = { x: 600, y: 120 }
  })
  const original = {
    a: harness.nodeTransform('起点任务'),
    b: harness.nodeTransform('终点任务'),
    c: harness.nodeTransform('远处的任务'),
  }

  const layoutButton = [...harness.container.querySelectorAll('button')]
    .find((button) => (button.textContent ?? '') === '自动布局')
  assert.ok(layoutButton, 'the canvas toolbar has the auto-layout button')
  await harness.act(async () => {
    layoutButton.click()
  })
  await harness.settle()

  const layoutRequests = harness.actionRequests().filter((request) => request.action === 'set-positions')
  assert.ok(layoutRequests.length >= 1, 'auto layout writes positions')
  assert.ok(
    layoutRequests[layoutRequests.length - 1].payload.positions.every((entry) => entry.position === null),
    'the free-layout action clears manual positions',
  )
  const moved = harness.nodeTransform('终点任务')
  assert.notDeepEqual(moved, original.b, 'the auto layout actually moved a card')

  const undoButton = [...harness.container.querySelectorAll('button')]
    .find((button) => (button.textContent ?? '') === '撤销')
  await harness.act(async () => {
    undoButton.click()
  })
  await harness.settle()

  const restoreRequest = harness.actionRequests()
    .filter((request) => request.action === 'set-positions')
  const restored = restoreRequest[restoreRequest.length - 1].payload.positions
  const byId = Object.fromEntries(restored.map((entry) => [entry.nodeId, entry.position]))
  assert.deepEqual(byId.n_a, original.a)
  assert.deepEqual(byId.n_b, original.b)
  assert.deepEqual(byId.n_c, original.c)
  assert.deepEqual(harness.nodeTransform('终点任务'), original.b, 'the card returns to its pre-layout spot')
})

test('Alt lasso creates a group with a dashed rounded contour', async (t) => {
  const harness = await mountPanel(t)

  // A hand-drawn path that fully contains n_a and n_b but only approaches n_c.
  const path = [
    { x: 20, y: 20 },
    { x: 660, y: 20 },
    { x: 660, y: 150 },
    { x: 20, y: 150 },
    { x: 20, y: 20 },
  ]
  await harness.act(async () => {
    const background = harness.container.querySelector('rect.dsh-td-canvas-bg')
    assert.ok(background, 'the canvas background must render')
    background.dispatchEvent(pointer(harness.window, 'pointerdown', {
      clientX: path[0].x,
      clientY: path[0].y,
      altKey: true,
    }))
    for (const point of path.slice(1)) {
      harness.window.dispatchEvent(pointer(harness.window, 'pointermove', {
        clientX: point.x,
        clientY: point.y,
        altKey: true,
      }))
    }
    harness.window.dispatchEvent(pointer(harness.window, 'pointerup', {
      clientX: path[path.length - 1].x,
      clientY: path[path.length - 1].y,
      altKey: true,
    }))
  })
  await harness.settle()

  const dialog = harness.container.querySelector('.dsh-td-link-card')
  assert.ok(dialog, 'the lasso opens the group-name dialog')
  assert.match(dialog.textContent ?? '', /完全包含 2 个节点/, 'only fully enclosed nodes are counted')
  // The enclosed cards stay highlighted until the dialog is confirmed or
  // cancelled, so the user can check the selection before naming it.
  assert.equal(
    harness.container.querySelectorAll('g.dsh-td-node-group-target').length,
    2,
    'the enclosed nodes are highlighted before the group is confirmed',
  )
  assert.equal(
    harness.container.querySelectorAll('rect.dsh-td-node-group-halo').length,
    2,
    'each candidate node draws its halo',
  )
  const input = dialog.querySelector('input.dsh-td-input')
  assert.ok(input, 'the dialog has a name input')
  assert.equal(input.value, '组合 1')

  await harness.act(async () => {
    setReactValue(harness.window, input, '前端改造')
  })
  await harness.settle()
  await harness.act(async () => {
    const confirm = [...dialog.querySelectorAll('button')]
      .find((button) => (button.textContent ?? '') === '创建组合')
    assert.ok(confirm, 'the dialog confirms with 创建组合')
    confirm.click()
  })
  await harness.settle()

  const create = harness.actionRequests().find((request) => request.action === 'create-group')
  assert.ok(create, 'the name is posted as create-group')
  assert.equal(create.payload.name, '前端改造')
  assert.deepEqual(create.payload.nodeIds.slice().sort(), ['n_a', 'n_b'], 'exactly the enclosed nodes join the group')

  const outlines = [...harness.container.querySelectorAll('path.dsh-td-group-outline')]
  assert.equal(outlines.length, 1, 'one dashed contour is rendered')
  assert.equal(
    harness.container.querySelectorAll('g.dsh-td-node-group-target').length,
    0,
    'the highlight is dropped once the group exists',
  )
  const d = outlines[0].getAttribute('d') ?? ''
  assert.match(d, /^M /, 'the contour has path data')
  assert.match(d, /A 10 10 0 0 [01] /, 'every corner uses the card radius (10)')

  // The contour edges sit on the layout grid even though the layout is free.
  const points = []
  for (const segment of d.match(/[MLAZ][^MLAZ]*/g) ?? []) {
    const numbers = segment.slice(1).trim().split(/[\s,]+/).filter(Boolean).map(Number)
    if (segment[0] === 'M' || segment[0] === 'L') points.push({ x: numbers[0], y: numbers[1] })
    else if (segment[0] === 'A') points.push({ x: numbers[5], y: numbers[6] })
  }
  assert.ok(points.length >= 4, 'the contour has corners')
  const minX = Math.min(...points.map((point) => point.x))
  const maxX = Math.max(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y))
  const maxY = Math.max(...points.map((point) => point.y))
  assert.equal((minX - GRID_X0) % GRID_W, 0, 'the left contour edge sits on a grid line')
  assert.equal((maxX - GRID_X0) % GRID_W, 0, 'the right contour edge sits on a grid line')
  assert.equal((minY - GRID_Y0) % GRID_H, 0, 'the top contour edge sits on a grid line')
  assert.equal((maxY - GRID_Y0) % GRID_H, 0, 'the bottom contour edge sits on a grid line')
  assert.ok(harness.container.textContent.includes('前端改造'), 'the contour is labelled with the group name')

  // Clicking the contour selects the group and offers dissolve.
  await harness.act(async () => {
    outlines[0].parentElement.querySelector('path.dsh-td-group-hit')
      ?.dispatchEvent(pointer(harness.window, 'pointerdown', { clientX: 0, clientY: 0 }))
  })
  await harness.settle()
  const dissolve = [...harness.container.querySelectorAll('button')]
    .find((button) => (button.textContent ?? '') === '解散组合')
  assert.ok(dissolve, 'selecting the contour shows its group bar')
  await harness.act(async () => {
    dissolve.click()
  })
  await harness.settle()
  assert.ok(
    harness.actionRequests().some((request) => request.action === 'delete-group'),
    'dissolving posts delete-group',
  )
  assert.equal(harness.container.querySelectorAll('path.dsh-td-group-outline').length, 0)
})

test('a lasso with no fully enclosed nodes does not open the dialog', async (t) => {
  const harness = await mountPanel(t)
  await harness.act(async () => {
    const background = harness.container.querySelector('rect.dsh-td-canvas-bg')
    // A path that only grazes the first card's left edge.
    const path = [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 60 },
      { x: 0, y: 60 },
      { x: 0, y: 0 },
    ]
    background.dispatchEvent(pointer(harness.window, 'pointerdown', {
      clientX: path[0].x, clientY: path[0].y, altKey: true,
    }))
    for (const point of path.slice(1)) {
      harness.window.dispatchEvent(pointer(harness.window, 'pointermove', {
        clientX: point.x, clientY: point.y, altKey: true,
      }))
    }
    harness.window.dispatchEvent(pointer(harness.window, 'pointerup', {
      clientX: 0, clientY: 0, altKey: true,
    }))
  })
  await harness.settle()
  assert.equal(harness.container.querySelector('.dsh-td-link-card'), null, 'no dialog for a grazing lasso')
  assert.match(harness.container.textContent ?? '', /没有完全包含的节点/, 'the user gets a warning instead')
  assert.equal(harness.container.querySelectorAll('path.dsh-td-group-outline').length, 0)
})

/** Bounds of a rounded-rectilinear contour path (M/L and arc endpoints). */
function contourBounds(d) {
  const points = []
  for (const segment of (typeof d === 'string' ? d : '').match(/[MLAZ][^MLAZ]*/g) ?? []) {
    const numbers = segment.slice(1).trim().split(/[\s,]+/).filter(Boolean).map(Number)
    if (segment[0] === 'M' || segment[0] === 'L') points.push({ x: numbers[0], y: numbers[1] })
    else if (segment[0] === 'A') points.push({ x: numbers[5], y: numbers[6] })
  }
  return {
    points,
    subpaths: ((typeof d === 'string' ? d : '').match(/\bM\b/g) ?? []).length,
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  }
}

/** Point-in-polygon for a contour sampled into its corner points. */
function polygonContains(points, x, y) {
  let inside = false
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const current = points[index]
    const before = points[previous]
    if ((current.y > y) === (before.y > y)) continue
    const xAtY = ((before.x - current.x) * (y - current.y)) / (before.y - current.y) + current.x
    if (x < xAtY) inside = !inside
  }
  return inside
}

/**
 * Mount the panel with one group whose members are passed in, then return the
 * rendered contour path. Positions are deliberately grid-cell positions so the
 * expected cells are exact.
 */
async function mountWithGroup(t, nodeSpecs, groupNodeIds, edges) {
  const harness = await mountPanel(t, (graph) => {
    graph.nodes = nodeSpecs
    graph.edges = edges
    graph.groups = [{
      id: 'g_00000001',
      name: '跨格组合',
      nodeIds: groupNodeIds,
      createdAt: NOW,
      updatedAt: NOW,
    }]
  })
  const outline = harness.container.querySelector('path.dsh-td-group-outline')
  assert.ok(outline, 'the group contour renders')
  return { harness, outline, bounds: contourBounds(outline.getAttribute('d') ?? '') }
}

test('a group whose cards are in non-adjacent cells is one connected contour', async (t) => {
  const { bounds } = await mountWithGroup(
    t,
    [
      node('n_left', '左侧节点', 96, 97),
      node('n_right', '右侧节点', 736, 97),
    ],
    ['n_left', 'n_right'],
    [{ id: 'e_link', from: 'n_left', to: 'n_right', conditionId: 'c_right' }],
  )
  // The internal edge corridor joins the two card-cell blocks: one subpath
  // instead of two separate boxes around each card.
  assert.equal(bounds.subpaths, 1, 'the contour is a single connected outline')
  assert.equal(bounds.minX, 40)
  assert.equal(bounds.maxX, 1000)
  assert.equal(bounds.minY, 40)
  assert.equal(bounds.maxY, 238)
})

test('a member without any internal edge is still joined into the contour', async (t) => {
  const { bounds } = await mountWithGroup(
    t,
    [
      node('n_top_left', '上左节点', 96, 97),
      node('n_top_right', '上右节点', 736, 97),
      node('n_far_below', '下方孤立节点', 96, 691),
    ],
    ['n_top_left', 'n_top_right', 'n_far_below'],
    // Only the top pair is connected: the far-below node has no edge at all and
    // must be joined by a simulated link to its nearest member.
    [{ id: 'e_top', from: 'n_top_left', to: 'n_top_right', conditionId: 'c_right' }],
  )
  assert.equal(bounds.subpaths, 1, 'the isolated member does not get a second contour')
  assert.equal(bounds.minX, 40)
  assert.equal(bounds.maxX, 1000)
  // Cells rows 0..3 (the far-below card occupies row 3).
  assert.equal(bounds.minY, 40)
  assert.equal(bounds.maxY, 832)
})

test('a connection corridor follows the routed edge and skips unrelated cards', async (t) => {
  // The reported example: the edge from 新任务2 to 新任务3 is blocked by
  // 新任务1, and 新任务4 sits near the straight line. The narrow corridor must
  // follow the routed (bowed) edge, not claim whole grid cells.
  const start = node('n_start', '新任务2', 416, 493)
  const goal = node('n_goal', '新任务3', 1056, 691)
  const blocker = node('n_blocker', '新任务 1', 736, 493)
  const other = node('n_other', '新任务 4', 416, 691)
  const { bounds } = await mountWithGroup(
    t,
    [start, goal, blocker, other],
    ['n_start', 'n_goal'],
    [{ id: 'e_link', from: 'n_start', to: 'n_goal', conditionId: 'c_goal' }],
  )
  assert.equal(bounds.subpaths, 1, 'the contour stays a single connected outline')
  const centerOf = (spec) => ({
    x: spec.position.x + NODE_W / 2,
    y: spec.position.y + NODE_H / 2,
  })
  const contains = (spec) => polygonContains(bounds.points, centerOf(spec).x, centerOf(spec).y)
  assert.equal(contains(start), true, 'the source member is inside the contour')
  assert.equal(contains(goal), true, 'the target member is inside the contour')
  assert.equal(contains(blocker), false, 'the blocking card is not swallowed by the corridor')
  assert.equal(contains(other), false, 'a card next to the corridor is not swallowed either')
})

test('a horizontal edge stays flat when another edge shares its target', async (t) => {
  // Regression from the ssr workspace: an edge between two cards on the same
  // row must not arc high above the row just because another edge arrives at
  // the same target card.
  const harness = await mountPanel(t, (graph) => {
    graph.nodes = [
      node('n_gui', '形态学 GUI 对照工具', 736, 295),
      node('n_os', 'O/S 双轨算法实现', 1376, 295),
      node('n_tree', '双轨实验工作树整理与集成基线', 1056, 97),
    ]
    graph.edges = [
      { id: 'e_gui', from: 'n_gui', to: 'n_os', conditionId: 'c_os' },
      { id: 'e_tree', from: 'n_tree', to: 'n_os', conditionId: 'c_os_2' },
    ]
    graph.groups = []
  })
  const path = harness.container.querySelector('path[data-edge-id="e_gui"]')
  assert.ok(path, 'the horizontal edge renders')
  const d = path.getAttribute('d') ?? ''
  assert.match(d, /^M [-\d.]+ [-\d.]+ C /, 'it is still a cubic curve')
  const points = samplePath(d)
  const ys = points.map((point) => point.y)
  const verticalRange = Math.max(...ys) - Math.min(...ys)
  assert.ok(
    verticalRange <= 14,
    'the horizontal edge does not arc away from its row (range ' + verticalRange.toFixed(1) + 'px)',
  )
  const last = points[points.length - 1]
  assert.ok(Math.abs(last.x - 1376) < 1, 'it ends at the target card edge')
  assert.ok(Math.abs(last.y - 337) <= 8, 'it ends near the target handle')
})
