/**
 * Real render test for the browser half.
 *
 * `client.js` is a classic script that calls
 * `window.__ModuleLoader__.load({id, factory})`. This test loads the real bundle
 * into a jsdom document with React 18, mounts the panel the sidebar row opens,
 * feeds it fixture responses through stubbed `fetch` / `EventSource`, and
 * asserts the three-column UI renders the project, its nodes and their status.
 *
 * It exists because the panel only mounts when a user clicks the sidebar row:
 * a render-time defect would otherwise stay invisible until after a DSH restart.
 *
 * Run: node test/client.mount.test.js
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
const WORKSPACE_ID = 'ws_render'
const NOW = '2026-10-30T12:00:00.000Z'

/** A v2 graph: five statuses, conditions, a milestone, a schedule. */
function fixtureState() {
  const nodes = [
    {
      id: 'n_alpha', title: '确定数据模型', status: 'done',
      notes: '**字段**已经定稿\n\n- 约束一\n- 约束二',
      conditions: [{ id: 'c_alpha', title: '需求评审通过', createdAt: NOW }],
      agentPreset: 'preset_a', model: 'prov_a/model_a',
      schedule: {
        enabled: true, cron: '0 9 * * 1-5', nextRunAt: '2026-11-02T01:00:00.000Z',
        lastTriggeredAt: '2026-10-30T01:00:00.000Z', lastFinishedAt: '2026-10-30T01:05:00.000Z',
        lastResult: 'succeeded', lastError: null, lastSkippedReason: null, lastSessionId: 'scheduled-1',
      },
      sessions: [
        {
          sessionId: 'session-old-1', slot: 1, titleSnapshot: '确定数据模型',
          attachedAt: NOW, retiredAt: NOW, handoff: { from: null, mode: 'manual' },
        },
        {
          sessionId: 'session-new-1', slot: 2, titleSnapshot: '确定数据模型 · 续',
          attachedAt: NOW, retiredAt: null, handoff: { from: 'session-old-1', mode: 'brief' },
        },
      ],
      position: { x: 40, y: 40 }, createdAt: NOW, updatedAt: NOW, completedAt: NOW, failedAt: null,
    },
    {
      id: 'n_beta', title: '写接口层', status: 'todo', notes: '',
      conditions: [
        { id: 'c_beta_1', title: '接口评审通过', createdAt: NOW },
        { id: 'c_beta_2', title: '数据模型定稿', createdAt: NOW },
      ],
      agentPreset: null, model: null, schedule: null,
      sessions: [], position: { x: 320, y: 40 }, createdAt: NOW, updatedAt: NOW,
      completedAt: null, failedAt: null,
    },
    {
      id: 'n_gamma', title: '接入前端', status: 'doing', notes: '',
      conditions: [{ id: 'c_gamma', title: '接口联调通过', createdAt: NOW }],
      agentPreset: null, model: null, schedule: null,
      sessions: [], position: { x: 600, y: 40 }, createdAt: NOW, updatedAt: NOW,
      completedAt: null, failedAt: null,
    },
    {
      id: 'n_delta', title: '性能压测', status: 'planned', notes: '',
      conditions: [], agentPreset: null, model: null, schedule: null,
      sessions: [], position: { x: 40, y: 180 }, createdAt: NOW, updatedAt: NOW,
      completedAt: null, failedAt: null,
    },
    {
      id: 'n_epsilon', title: '旧版兼容', status: 'failed', notes: '',
      conditions: [{ id: 'c_epsilon', title: '兼容测试通过', createdAt: NOW }],
      agentPreset: null, model: null, schedule: null,
      sessions: [], position: { x: 320, y: 180 }, createdAt: NOW, updatedAt: NOW,
      completedAt: null, failedAt: NOW,
    },
    {
      id: 'n_zeta', title: '项目发布', status: 'todo', notes: '',
      conditions: [{ id: 'c_zeta', title: '发布检查', createdAt: NOW }],
      agentPreset: null, model: null, schedule: null,
      sessions: [], position: { x: 600, y: 180 }, createdAt: NOW, updatedAt: NOW,
      completedAt: null, failedAt: null,
    },
  ]
  const edges = [
    { id: 'e_1', from: 'n_alpha', to: 'n_beta', conditionId: 'c_beta_2' },
    { id: 'e_2', from: 'n_beta', to: 'n_gamma', conditionId: 'c_gamma' },
    { id: 'e_3', from: 'n_alpha', to: 'n_beta', conditionId: 'c_beta_1' },
    { id: 'e_4', from: 'n_gamma', to: 'n_zeta', conditionId: 'c_zeta' },
    { id: 'e_5', from: 'n_delta', to: 'n_alpha', conditionId: 'c_alpha' },
    // v1-style edge without a conditionId: the client must still render it and
    // synthesise a "<source> 完成" condition locally.
    { id: 'e_6', from: 'n_delta', to: 'n_alpha' },
  ]
  return {
    ok: true,
    snapshot: {
      workspace: { workspaceId: WORKSPACE_ID, path: 'C:\\演示项目', title: '演示项目' },
      graph: {
        schemaVersion: 2, workspaceId: WORKSPACE_ID, workspacePath: 'C:\\演示项目',
        title: '演示项目', revision: 7, milestoneNodeId: 'n_zeta', nodes, edges,
      },
      derived: {
        ready: ['n_beta', 'n_zeta'], blocked: [], doing: ['n_gamma'], done: ['n_alpha'],
        failed: ['n_epsilon'], planned: ['n_delta'],
        levels: { n_alpha: 0, n_beta: 2, n_gamma: 3, n_delta: 0, n_epsilon: 0, n_zeta: 4 },
        order: ['n_alpha', 'n_delta', 'n_epsilon', 'n_beta', 'n_gamma', 'n_zeta'],
        conditions: {
          n_alpha: [{ id: 'c_alpha', title: '需求评审通过', satisfied: false, linked: [], waiting: [] }],
          n_beta: [
            { id: 'c_beta_1', title: '接口评审通过', satisfied: true, linked: [], waiting: [] },
            { id: 'c_beta_2', title: '数据模型定稿', satisfied: true, linked: [], waiting: [] },
          ],
        },
        progress: {
          done: 1, total: 6, ready: 2, blocked: 0, doing: 1, failed: 1, planned: 1,
        },
        milestone: { id: 'n_zeta', title: '项目发布', status: 'todo', done: false },
      },
      sessions: {
        byId: {
          'session-new-1': {
            sessionId: 'session-new-1', title: '确定数据模型 · 续', running: false, blank: false,
            updatedAt: 1, cwd: 'C:\\演示项目', available: true,
            contextPressure: {
              contextWindow: 100000, pressureTokens: 42000, projectedTokens: 45000, ratio: 0.45,
            },
          },
        },
        archived: [], warnings: [],
      },
      notes: [],
    },
  }
}

const WORKSPACES_FIXTURE = {
  ok: true,
  workspaces: [{
    workspaceId: WORKSPACE_ID, path: 'C:\\演示项目', title: '演示项目', revision: 7,
    progress: {
      done: 1, total: 6, ready: 2, blocked: 0, doing: 1, failed: 1, planned: 1,
    },
    readyCount: 2,
  }],
}

const CATALOG_FIXTURE = {
  ok: true,
  catalog: {
    presets: [
      { id: 'preset_a', label: '默认 Agent' },
      { id: 'preset_b', label: '代码专家', broken: true },
    ],
    // The Host catalog deliberately has no models: the client must fall back to
    // the same remote.session.modelCatalog() the DSH composer itself uses.
    models: [],
    warnings: [],
  },
}

const REMOTE_CATALOG_FIXTURE = {
  value: {
    groups: [
      {
        id: 'prov_a',
        name: '提供方 A',
        models: [
          {
            id: 'model_a',
            name: '模型 A',
            reasoning: {
              efforts: [
                { id: 'low', name: '低' },
                { id: 'medium', name: '中' },
                { id: 'high', name: '高' },
              ],
              defaultEffort: 'medium',
            },
          },
        ],
      },
      {
        id: 'prov_b',
        name: '提供方 B',
        models: [{ id: 'model_b', name: '模型 B' }],
      },
    ],
  },
}

class FakeEventSource {
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = 1
    this.listeners = new Map()
    FakeEventSource.instances.push(this)
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  removeEventListener() {}

  close() {
    this.readyState = 2
  }
}

/** Steps the fake pointer drag that opens the condition chooser. */
async function dragLink(container, fromTitle, toX, toY) {
  const { act } = React
  await act(async () => {
    const groups = [...container.querySelectorAll('g.dsh-td-node')]
    const source = groups.find((group) => {
      const titleText = [...group.querySelectorAll('text.dsh-td-node-title')]
        .map((title) => title.textContent ?? '')
        .join('')
      return titleText === fromTitle
    })
    assert.ok(source, 'source node must render: ' + fromTitle)
    const handle = source.querySelector('circle.dsh-td-handle')
    assert.ok(handle, 'every node keeps its link handle')
    handle.dispatchEvent(new window.MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 0,
      clientY: 0,
    }))
    window.dispatchEvent(new window.MouseEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: toX,
      clientY: toY,
    }))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}

/** Steps a plain node drag (pointerdown on the card, move by dx/dy, release). */
function nodeGroupByTitle(container, title) {
  return [...container.querySelectorAll('g.dsh-td-node')].find((group) => {
    const titleText = [...group.querySelectorAll('text.dsh-td-node-title')]
      .map((node) => node.textContent ?? '')
      .join('')
    return titleText === title
  })
}

/** Set a controlled React input/textarea the way a real keystroke would. */
function setReactValue(window, element, value) {
  const prototype = element.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  assert.equal(typeof setter, 'function', 'the native value setter must exist')
  setter.call(element, value)
  // jsdom's untrusted `input` event does not reach React 18's delegated change
  // plugin, so call the element's React onChange prop directly: this performs
  // exactly the state update a real keystroke performs.
  const propsKey = Object.keys(element).find((key) => key.startsWith('__reactProps$'))
  const handler = propsKey !== undefined ? element[propsKey]?.onChange : undefined
  assert.equal(typeof handler, 'function', 'the element must expose its React onChange prop')
  handler({ target: element, currentTarget: element, preventDefault() {}, stopPropagation() {} })
}

function nodeTranslate(container, title) {
  const group = nodeGroupByTitle(container, title)
  assert.ok(group, 'node must render: ' + title)
  const match = /translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(group.getAttribute('transform') ?? '')
  assert.ok(match, 'node transform must be a translate: ' + title)
  return { x: Number(match[1]), y: Number(match[2]) }
}

async function dragNode(container, fromTitle, dx, dy) {  const { act } = React
  await act(async () => {
    const groups = [...container.querySelectorAll('g.dsh-td-node')]
    const source = groups.find((group) => {
      const titleText = [...group.querySelectorAll('text.dsh-td-node-title')]
        .map((title) => title.textContent ?? '')
        .join('')
      return titleText === fromTitle
    })
    assert.ok(source, 'source node must render: ' + fromTitle)
    source.dispatchEvent(new window.MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 0,
      clientY: 0,
    }))
    window.dispatchEvent(new window.MouseEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: dx,
      clientY: dy,
    }))
    window.dispatchEvent(new window.MouseEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: dx,
      clientY: dy,
    }))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

test('the browser half renders the v2 five-status graph in jsdom', async (t) => {
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

  let actionDelayMs = 0
  const restub = async (url, init) => {
    const target = String(url)
    requests.push({ url: target, method: init?.method ?? 'GET', body: init?.body })
    if (target.includes('/action') && actionDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, actionDelayMs))
    }
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

  // Install browser globals before evaluating the bundle, so its module-scope
  // code and every later callback both see the same objects.
  globalThis.window = window
  globalThis.document = window.document
  globalThis.localStorage = window.localStorage
  globalThis.EventSource = FakeEventSource
  globalThis.fetch = restub
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
  assert.equal(captured.id, 'dsh-task-dag')

  // Run apply against a fake Cordis Client context and keep both registrations.
  const registered = { main: undefined, sidebar: undefined }
  const ctx = {
    slots: {
      inject(_key, callback) {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(options, component) {
        if (options.name === 'main') registered.main = { options, component }
        else if (options.name === 'sidebar.panellist') registered.sidebar = { options, component }
        return () => {}
      },
    },
    workspaces: {
      list: {
        getSnapshot: () => ({
          items: [{ workspaceId: WORKSPACE_ID, path: 'C:\\演示项目', title: '演示项目', sessionIds: [] }],
          archivedSessionIds: [],
          pinnedSessionIds: [],
        }),
      },
    },
    sessions: { list: { getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready' }) } },
    remote: {
      session: {
        async modelCatalog() {
          return REMOTE_CATALOG_FIXTURE
        },
      },
    },
    get(name) {
      return name === 'remote' ? this.remote : undefined
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
    if (specifier === 'react/jsx-runtime') {
      return { jsx: React.createElement, jsxs: React.createElement, Fragment: React.Fragment }
    }
    throw new Error(`unexpected require(${specifier})`)
  })
  assert.equal(typeof moduleApi.apply, 'function')
  assert.equal([...moduleApi.inject].join(','), 'slots,workspaces,sessions,uiWorkspace,layout')
  moduleApi.apply(ctx)

  assert.ok(registered.main, 'the main panel must be registered')
  assert.ok(registered.sidebar, 'the sidebar row must be registered')
  assert.equal(registered.main.options.key, 'task-dag')
  assert.equal(registered.sidebar.options.id, 'task-dag')
  assert.equal(typeof registered.main.component, 'function')
  assert.equal(typeof registered.sidebar.component, 'function')

  const { act } = React
  const container = window.document.getElementById('root')
  const root = createRoot(container)

  // A returning user: the panel is remounted on every navigation, so the chosen
  // project and node must come back from localStorage alone.
  window.localStorage.setItem('dsh.task-dag', JSON.stringify({
    workspaceId: WORKSPACE_ID,
    selectedNodeId: 'n_alpha',
    viewport: { x: 0, y: 0, scale: 1 },
  }))

  await act(async () => {
    root.render(React.createElement(registered.main.component, {}))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  const text = container.textContent ?? ''
  assert.ok(requests.some((item) => item.url.includes('/api/task-dag/workspaces')), 'the panel must ask for the project list')
  assert.ok(requests.some((item) => item.url.includes('/api/task-dag/state')), 'the panel must ask for the graph state')
  assert.ok(requests.some((item) => item.url.includes('/api/task-dag/catalog')), 'the panel must ask for the preset/model catalog')
  assert.ok(FakeEventSource.instances.length >= 1, 'the panel must open a live-update stream')
  assert.match(text, /演示项目/, 'the project list must show the workspace title')

  // Every node title renders, and the five statuses are visible as labels and
  // as the left colour bar of their node card.
  for (const title of ['确定数据模型', '写接口层', '接入前端', '性能压测', '旧版兼容', '项目发布']) {
    assert.match(text, new RegExp(title), 'node title must render: ' + title)
  }
  for (const label of ['待规划', '待开始', '进行中', '已完成', '已失败']) {
    assert.ok(text.includes(label), 'the five-state label must render: ' + label)
  }
  for (const status of ['planned', 'todo', 'doing', 'done', 'failed']) {
    assert.ok(
      container.querySelector('rect.dsh-td-node-bar-' + status),
      'the node colour bar must render for ' + status,
    )
  }
  assert.ok(container.querySelector('g.dsh-td-node-failed'), 'failed nodes get their own visual class')

  // Node cards show condition progress, a schedule marker and a milestone flag.
  assert.match(text, /条件 2\/2/, 'satisfied condition progress renders on the target card')
  assert.match(text, /条件 0\/2/, 'an unsatisfied condition shows 0/2 on the source card')
  assert.ok(text.includes('⏱'), 'a scheduled node shows the timer marker')
  assert.ok(text.includes('里程碑'), 'the milestone node is flagged')
  assert.match(text, /里程碑：项目发布/, 'the header names the project milestone')

  // The injected stylesheet carries the DSH font scale and the floating notice.
  const styleTag = window.document.querySelector('style[data-plugin-css="dsh-task-dag"]')
  assert.ok(styleTag, 'the panel injects its stylesheet once')
  const cssText = styleTag.textContent ?? ''
  assert.match(cssText, /--dsh-td-fs:var\(--dsh-content-font-size,14px\)/)
  assert.match(cssText, /\.dsh-td-notice-dock\{position:absolute/)
  assert.equal(
    (cssText.match(/\{/g) || []).length,
    (cssText.match(/\}/g) || []).length,
    'the injected stylesheet has balanced blocks',
  )

  // -- UI polish: three resizable columns ---------------------------------
  const splitters = [...container.querySelectorAll('.dsh-td-splitter')]
  assert.equal(splitters.length, 2, 'the layout has one splitter on each side of the canvas')
  for (const splitter of splitters) {
    assert.equal(splitter.getAttribute('role'), 'separator')
    assert.equal(splitter.getAttribute('aria-orientation'), 'vertical')
    assert.equal(splitter.getAttribute('tabindex'), '0', 'splitters are keyboard reachable')
    assert.ok(splitter.querySelector('.dsh-td-splitter-line'))
  }
  const leftColumn = container.querySelector('aside.dsh-td-col-left')
  const rightColumn = container.querySelector('aside.dsh-td-col-right')
  assert.equal(leftColumn.style.flexBasis, '200px', 'the project column starts at its default width')
  assert.equal(rightColumn.style.flexBasis, '322px', 'the detail column starts at its default width')

  // Parallel edges between the same pair of nodes (alpha -> beta, two
  // conditions) must not overlap: their path data differs.
  const edgePaths = [...container.querySelectorAll('path.dsh-td-edge')]
  assert.equal(edgePaths.length, 6, 'every edge is drawn')
  const distinctPaths = new Set(edgePaths.map((path) => path.getAttribute('d')))
  assert.equal(distinctPaths.size, 6, 'each edge has its own arc')
  const parallel = edgePaths.filter((path) => (path.getAttribute('d') ?? '').startsWith('M 248 82'))
  assert.equal(parallel.length, 2, 'both alpha -> beta edges start at the same handle')
  assert.notEqual(
    parallel[0].getAttribute('d'),
    parallel[1].getAttribute('d'),
    'parallel edges bow apart by condition',
  )

  // -- dragging a node pushes an overlapping peer out of the way -----------
  // n_alpha sits at (40,40), n_beta at (320,40). Dropping n_alpha on n_beta
  // must move n_beta, not leave two cards stacked.
  await dragNode(container, '确定数据模型', 280, 0)
  const dragBodies = requests
    .filter((item) => item.url.includes('/api/task-dag/action'))
    .map((item) => JSON.parse(item.body))
    .filter((body) => body.action === 'set-positions')
  assert.ok(dragBodies.length >= 1, 'the drop posts a batched position update')
  const dragged = dragBodies.at(-1).payload.positions
  assert.deepEqual(dragged[0], { nodeId: 'n_alpha', position: { x: 320, y: 40 } })
  const pushedBeta = dragged.find((entry) => entry.nodeId === 'n_beta')
  assert.ok(pushedBeta, 'the overlapped node is moved away')
  assert.equal(pushedBeta.position.y, -64, 'the smallest-displacement push moves it above')
  const alphaRect = { x: 320, y: 40 }
  const betaRect = pushedBeta.position
  const overlap = alphaRect.x < betaRect.x + 208 && alphaRect.x + 208 > betaRect.x
    && alphaRect.y < betaRect.y + 84 && alphaRect.y + 84 > betaRect.y
  assert.equal(overlap, false, 'the final placement does not overlap the dragged node')

  // -- auto layout clears every manual position in one batched action ------
  const autoButton = [...container.querySelectorAll('button')]
    .find((button) => (button.textContent ?? '') === '自动布局')
  assert.ok(autoButton, 'the canvas keeps its auto-layout button')
  await act(async () => {
    autoButton.click()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const autoBodies = requests
    .filter((item) => item.url.includes('/api/task-dag/action'))
    .map((item) => JSON.parse(item.body))
    .filter((body) => body.action === 'set-positions')
  const autoPositions = autoBodies.at(-1).payload.positions
  assert.equal(autoPositions.length, 6, 'auto layout resets every manual node in one call')
  assert.ok(autoPositions.every((entry) => entry.position === null))

  // -- detail drawer for the restored node -------------------------------
  assert.match(text, /前置条件/, 'the prerequisite conditions area renders')
  assert.ok(text.includes('需求评审通过'), 'an existing condition title renders')
  assert.ok(text.includes('性能压测 完成'), 'a v1 edge gets a synthesised condition title')
  assert.ok(text.includes('0/2 已满足'), 'the condition satisfaction counter renders')
  assert.ok(text.includes('性能压测'), 'a linked predecessor node renders under its condition')
  assert.ok(text.includes('添加条件'), 'conditions can be added')
  assert.ok(text.includes('重命名'), 'conditions can be renamed')
  assert.ok(text.includes('已满足'), 'condition satisfaction is labelled')
  assert.ok(text.includes('未满足'), 'unsatisfied conditions are labelled')

  // Execution settings and schedule are collapsible and sit at the bottom,
  // above the (collapsed) danger zone. Expand execution to inspect it.
  const collapseHead = (title) => [...container.querySelectorAll('button.dsh-td-collapse-head')]
    .find((button) => (button.textContent ?? '').includes(title))
  const executionHead = collapseHead('执行设置')
  assert.ok(executionHead, 'the execution settings section renders')
  assert.equal(executionHead.getAttribute('aria-expanded'), 'false', 'execution settings start collapsed')
  assert.ok(text.includes('Agent 预设') === false, 'the collapsed body is not rendered yet')
  await act(async () => {
    executionHead.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  assert.ok((container.textContent ?? '').includes('Agent 预设'), 'expanding shows the execution settings')

  const selects = [...container.querySelectorAll('select.dsh-td-select')]
  assert.equal(selects.length, 1, 'the only native select left is the Agent preset')
  assert.equal(selects[0].value, 'preset_a', 'the node preset is selected')
  const presetLabels = [...selects[0].options].map((option) => option.textContent)
  assert.ok(presetLabels.includes('默认（跟随宿主）'), 'the preset dropdown has a default option')
  assert.ok(presetLabels.includes('默认 Agent'), 'the catalog preset is listed')
  assert.ok(presetLabels.includes('代码专家（不可用）'), 'broken presets are marked')

  // Model + reasoning-effort combobox, like the composer's selector.
  const modelTrigger = container.querySelector('.dsh-td-model-trigger')
  assert.ok(modelTrigger, 'the model combobox trigger renders')
  assert.match(modelTrigger.textContent ?? '', /模型 A/, 'the current model is shown on the trigger')
  assert.match(modelTrigger.textContent ?? '', /中/, 'the model default reasoning effort is shown')
  await act(async () => {
    modelTrigger.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  const modelPop = container.querySelector('.dsh-td-model-pop')
  assert.ok(modelPop, 'clicking the trigger opens the model menu')
  assert.match(modelPop.textContent ?? '', /默认（跟随宿主）/)
  assert.match(modelPop.textContent ?? '', /模型 A/)
  assert.match(modelPop.textContent ?? '', /模型 B/)
  assert.match(modelPop.textContent ?? '', /可选推理强度/)

  const modelBOption = [...modelPop.querySelectorAll('button.dsh-td-model-option')]
    .find((button) => (button.textContent ?? '').includes('模型 B'))
  assert.ok(modelBOption, 'a model without reasoning levels is listed')
  await act(async () => {
    modelBOption.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  const actionBodies = () => requests
    .filter((item) => item.url.includes('/api/task-dag/action'))
    .map((item) => JSON.parse(item.body))
  assert.deepEqual(
    actionBodies().filter((body) => body.action === 'update-node').at(-1).payload,
    { nodeId: 'n_alpha', model: 'prov_b/model_b', reasoningEffort: null },
    'choosing a model posts the model and clears the effort',
  )

  // A model with reasoning levels opens the effort pane before committing.
  await act(async () => {
    container.querySelector('.dsh-td-model-trigger').click()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  const modelAPop = container.querySelector('.dsh-td-model-pop')
  const modelAOption = [...modelAPop.querySelectorAll('button.dsh-td-model-option')]
    .find((button) => (button.textContent ?? '').includes('模型 A'))
  await act(async () => {
    modelAOption.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  const effortPop = container.querySelector('.dsh-td-model-pop')
  assert.ok(effortPop, 'the effort pane opens for a reasoning model')
  assert.match(effortPop.textContent ?? '', /推理强度/)
  const highOption = [...effortPop.querySelectorAll('button.dsh-td-model-option')]
    .find((button) => (button.textContent ?? '').includes('高'))
  assert.ok(highOption, 'the reasoning levels are listed')
  await act(async () => {
    highOption.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  assert.deepEqual(
    actionBodies().filter((body) => body.action === 'update-node').at(-1).payload,
    { nodeId: 'n_alpha', model: 'prov_a/model_a', reasoningEffort: 'high' },
    'choosing an effort posts the model and the effort',
  )

  const scheduleHead = collapseHead('定时执行')
  assert.ok(scheduleHead, 'the schedule section renders')
  assert.equal(scheduleHead.getAttribute('aria-expanded'), 'false', 'schedule starts collapsed')
  await act(async () => {
    scheduleHead.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  const scheduleText = container.textContent ?? ''
  assert.match(scheduleText, /下次执行/, 'the next run time is shown')
  assert.match(scheduleText, /上次结果/, 'the last result is shown')
  assert.ok(scheduleText.includes('成功'), 'the last result is translated')
  assert.ok(scheduleText.includes('工作日 9:00'), 'cron presets are offered')
  const cronInput = [...container.querySelectorAll('input')]
    .find((input) => input.value === '0 9 * * 1-5')
  assert.ok(cronInput, 'the stored cron expression is shown in its input')
  assert.ok((container.textContent ?? '').includes('设为项目里程碑'), 'the milestone setting renders')
  assert.equal(
    (container.textContent ?? '').includes('完成后视为项目达成'),
    false,
    'the milestone no longer claims to finish the project',
  )
  assert.equal(
    (container.textContent ?? '').includes('里程碑可以是任意状态'),
    false,
    'the parenthetical explanation after the milestone checkbox is gone',
  )
  const milestoneGroup = nodeGroupByTitle(container, '项目发布')
  assert.ok(milestoneGroup, 'the milestone node renders')
  const milestoneFlag = [...milestoneGroup.querySelectorAll('text.dsh-td-node-flag')]
    .find((label) => label.textContent === '里程碑')
  assert.ok(milestoneFlag, 'the milestone label renders')
  assert.equal(milestoneFlag.getAttribute('x'), '208', 'the label is right-aligned to the card edge')
  assert.equal(milestoneFlag.getAttribute('y'), '-7', 'the label sits outside, above the card')
  assert.equal(milestoneFlag.getAttribute('text-anchor'), 'end')
  assert.ok(Number(milestoneFlag.getAttribute('y')) < 0, 'the label is outside the node rectangle')

  // -- unsaved text fields survive a click on another node ----------------
  // The canvas calls preventDefault on pointerdown, so the focused input never
  // blurs; the page must flush the draft before switching the drawer.
  const titleInput = container.querySelector('.dsh-td-detail-scroll input.dsh-td-input')
  assert.ok(titleInput, 'the node title input renders')
  assert.equal(titleInput.value, '确定数据模型')
  await act(async () => {
    setReactValue(window, titleInput, '确定数据模型（草稿）')
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  const clickNode = async (title) => {
    await act(async () => {
      const group = nodeGroupByTitle(container, title)
      assert.ok(group, 'the node to click must render: ' + title)
      group.dispatchEvent(new window.MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 0,
        clientY: 0,
      }))
      window.dispatchEvent(new window.MouseEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 0,
        clientY: 0,
      }))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  await clickNode('写接口层')
  const titleUpdates = actionBodies().filter(
    (body) => body.action === 'update-node' && body.payload.title !== undefined,
  )
  assert.equal(
    titleUpdates.at(-1)?.payload.title,
    '确定数据模型（草稿）',
    'clicking another node saves the focused title draft',
  )
  assert.match(
    container.querySelector('.dsh-td-detail-title')?.textContent ?? '',
    /写接口层/,
    'the clicked node becomes the selected one',
  )

  await clickNode('确定数据模型')
  const notesDraft = container.querySelector('textarea.dsh-td-notes-textarea')
  assert.ok(notesDraft, 'the notes editor renders again after re-selecting the node')
  // An autosave is a background write: it must not disable the focused
  // textarea, because a disabled control drops focus and interrupts typing.
  actionDelayMs = 120
  // react-dom is imported before jsdom installs a document, so React picked its
  // IE change-event polyfill. That polyfill calls attachEvent() on focusin;
  // jsdom has no attachEvent, so provide the two no-op hooks it expects.
  notesDraft.attachEvent = () => {}
  notesDraft.detachEvent = () => {}
  notesDraft.focus()
  const autosaveRequestsBefore = requests.filter((item) => item.url.includes('/action')).length
  await act(async () => {
    setReactValue(window, notesDraft, '**字段**已经定稿\n\n- 约束一\n- 约束二\n- 自动保存中')
    await new Promise((resolve) => setTimeout(resolve, 780))
  })
  assert.ok(
    requests.filter((item) => item.url.includes('/action')).length > autosaveRequestsBefore,
    'the autosave request is in flight at this point',
  )
  assert.equal(
    [...container.querySelectorAll('.dsh-td-header button')]
      .some((button) => (button.textContent ?? '') === '处理中…'),
    false,
    'a background autosave does not flip the panel into its global busy state',
  )
  assert.equal(notesDraft.disabled, false, 'an in-flight autosave leaves the textarea enabled')
  assert.equal(window.document.activeElement, notesDraft, 'the textarea keeps focus during autosave')
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 240))
  })
  actionDelayMs = 0

  await act(async () => {
    setReactValue(window, notesDraft, '**字段**已经定稿\n\n- 约束一\n- 约束二\n- 新增约束')
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  await clickNode('接入前端')
  const notesUpdates = actionBodies().filter(
    (body) => body.action === 'update-node' && body.payload.notes !== undefined,
  )
  assert.match(
    notesUpdates.at(-1)?.payload.notes ?? '',
    /新增约束/,
    'clicking another node saves the focused Markdown description',
  )
  // Restore the node the rest of this suite inspects.
  await clickNode('确定数据模型')

  // Danger zone stays collapsed until the user opens it explicitly.
  const dangerHead = collapseHead('危险操作')
  assert.ok(dangerHead, 'the danger zone renders its header')
  assert.equal(dangerHead.getAttribute('aria-expanded'), 'false', 'the danger zone is collapsed by default')
  assert.equal(container.textContent.includes('确认归档'), false)
  await act(async () => {
    dangerHead.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  assert.ok((container.textContent ?? '').includes('删除节点'), 'expanding reveals the danger actions')

  // Session chain of the restored node (M1 behaviour must survive).
  assert.match(text, /确定数据模型 · 续/, 'the active session title must appear in the chain')
  assert.ok(text.includes('~45K / 100K'), 'context usage uses the DSH K/M compact format')
  assert.match(text, /切回|已交接/, 'a retired session must offer a way back')
  assert.match(text, /交接/, 'the handoff controls must be available')

  // -- notes: resizable Markdown editor with a live preview ---------------
  const notesEditor = container.querySelector('textarea.dsh-td-notes-textarea')
  assert.ok(notesEditor, 'the notes editor renders its textarea')
  assert.equal(notesEditor.value, '**字段**已经定稿\n\n- 约束一\n- 约束二')
  assert.equal(notesEditor.style.height, '150px', 'the notes editor starts at the persisted default height')
  assert.equal(
    container.querySelectorAll('.dsh-td-notes-tools button').length,
    6,
    'the Markdown toolbar offers its formatting shortcuts',
  )
  const notesResizer = container.querySelector('.dsh-td-notes-resizer')
  assert.ok(notesResizer, 'the notes editor exposes a drag handle')
  assert.equal(notesResizer.getAttribute('role'), 'separator')

  const previewTab = [...container.querySelectorAll('button.dsh-td-notes-tab')]
    .find((button) => (button.textContent ?? '') === '预览')
  assert.ok(previewTab, 'the notes editor offers a preview tab')
  await act(async () => {
    previewTab.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  const notesPreview = container.querySelector('.dsh-td-notes-preview')
  assert.ok(notesPreview, 'the preview replaces the textarea')
  assert.equal(notesPreview.querySelector('strong')?.textContent, '字段', 'bold Markdown renders as <strong>')
  assert.equal(notesPreview.querySelectorAll('li').length, 2, 'Markdown list items render as list items')
  assert.match(notesPreview.textContent ?? '', /字段已经定稿/, 'the preview keeps the note text')

  await act(async () => {
    notesResizer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  assert.equal(
    JSON.parse(window.localStorage.getItem('dsh.task-dag')).notesHeight,
    166,
    'arrow keys resize the notes editor and persist it',
  )

  // -- link flow: drag from a node handle opens the condition chooser -----
  // n_delta "性能压测" sits at (40,180); dragging right onto n_zeta
  // "项目发布" at (600,180) must open the chooser, not post immediately.
  const actionCountBefore = requests.filter((item) => item.url.includes('/api/task-dag/action')).length
  await dragLink(container, '性能压测', 620, 200)

  const dialog = container.querySelector('.dsh-td-link-card')
  assert.ok(dialog, 'dropping the link on a node opens the condition chooser')
  const dialogText = dialog.textContent ?? ''
  assert.match(dialogText, /选择前置条件/, 'the chooser names its purpose')
  assert.ok(dialogText.includes('发布检查'), 'existing target conditions are listed')
  assert.ok(dialogText.includes('未满足'), 'each existing condition shows its satisfaction')
  assert.ok(dialogText.includes('关联：'), 'each existing condition shows its linked nodes')
  const newTitleInput = dialog.querySelector('input')
  assert.ok(newTitleInput, 'the chooser offers a new condition title')
  assert.equal(newTitleInput.value, '性能压测 完成', 'the new condition defaults to "<source> 完成"')
  assert.equal(
    requests.filter((item) => item.url.includes('/api/task-dag/action')).length,
    actionCountBefore,
    'dragging alone must not post a link',
  )

  // Confirm the default new condition.
  const confirmButton = [...dialog.querySelectorAll('button')]
    .find((button) => (button.textContent ?? '').includes('确认添加前置条件'))
  assert.ok(confirmButton, 'the chooser has a confirm button')
  await act(async () => {
    confirmButton.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  assert.equal(container.querySelector('.dsh-td-link-card'), null, 'the chooser closes after linking')

  // Drag again and pick an existing condition instead of naming a new one.
  await dragLink(container, '性能压测', 620, 200)
  const secondDialog = container.querySelector('.dsh-td-link-card')
  assert.ok(secondDialog, 'the chooser opens again for a second edge')
  const existingOption = [...secondDialog.querySelectorAll('button.dsh-td-option')]
    .find((button) => (button.textContent ?? '').includes('发布检查'))
  assert.ok(existingOption, 'the existing condition is selectable')
  const secondConfirm = [...secondDialog.querySelectorAll('button')]
    .find((button) => (button.textContent ?? '').includes('确认添加前置条件'))
  await act(async () => {
    existingOption.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await act(async () => {
    secondConfirm.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })

  const linkBodies = requests
    .filter((item) => item.url.includes('/api/task-dag/action'))
    .map((item) => JSON.parse(item.body))
    .filter((body) => body.action === 'link')
  assert.equal(linkBodies.length, 2, 'both chooser confirmations post link actions')
  assert.deepEqual(linkBodies[0].payload, {
    from: 'n_delta',
    to: 'n_zeta',
    conditionTitle: '性能压测 完成',
  })
  assert.deepEqual(linkBodies[1].payload, {
    from: 'n_delta',
    to: 'n_zeta',
    conditionId: 'c_zeta',
  })

  // -- operation feedback is docked inside the middle column ---------------
  const mainColumn = container.querySelector('.dsh-td-main')
  const noticeDock = container.querySelector('.dsh-td-notice-dock')
  assert.ok(mainColumn, 'the canvas column renders')
  assert.ok(noticeDock, 'an action notice is shown after a successful operation')
  assert.ok(mainColumn.contains(noticeDock), 'the notice is docked in the canvas column, not above the three-column body')
  assert.match(noticeDock.textContent ?? '', /已添加前置条件/, 'the notice carries the operation result')
  assert.equal(container.querySelector('.dsh-td-header .dsh-td-notice-dock'), null)
  assert.ok(mainColumn.classList.contains('dsh-td-main-notice'), 'the canvas knows a notice is floating over it')

  // -- both widths and the notes height persist ----------------------------
  const splitter = container.querySelectorAll('.dsh-td-splitter')[0]
  await act(async () => {
    splitter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  const persisted = JSON.parse(window.localStorage.getItem('dsh.task-dag'))
  assert.equal(persisted.columnWidths.left, 216, 'arrow keys resize the project column and persist it')
  assert.equal(persisted.columnWidths.right, 322, 'the untouched detail width is persisted too')

  // -- layout mode toggle sits between 新建节点 and 自动布局 -------------------
  const toolbarButtons = [...container.querySelectorAll('.dsh-td-toolbar button')]
    .map((button) => button.textContent ?? '')
  const newAt = toolbarButtons.indexOf('新建节点')
  const modeAt = toolbarButtons.indexOf('布局模式：自由')
  const autoAt = toolbarButtons.indexOf('自动布局')
  assert.ok(newAt >= 0 && modeAt === newAt + 1 && autoAt === modeAt + 1,
    'the layout-mode button sits between 新建节点 and 自动布局')

  const gridPositionBodies = () => requests
    .filter((item) => item.url.includes('/api/task-dag/action'))
    .map((item) => JSON.parse(item.body))
    .filter((body) => body.action === 'set-positions'
      && Array.isArray(body.payload.positions)
      && body.payload.positions.every((entry) => entry.position !== null))
  await act(async () => {
    const modeButton = [...container.querySelectorAll('.dsh-td-toolbar button')]
      .find((button) => (button.textContent ?? '') === '布局模式：自由')
    assert.ok(modeButton, 'the free-layout mode button renders')
    modeButton.click()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  assert.ok(container.querySelector('.dsh-td-grid-bg'), 'grid mode paints the golden-ratio grid')
  assert.ok(container.querySelector('#dsh-td-grid-pattern'), 'the grid pattern is defined')
  const gridPayload = gridPositionBodies().at(-1).payload.positions
  assert.equal(gridPayload.length, 6, 'switching to grid snaps every node')
  const gridCells = new Set()
  for (const entry of gridPayload) {
    const centerX = entry.position.x + 104
    const centerY = entry.position.y + 42
    assert.equal(Math.abs((centerX - 40 - 160) % 320), 0, 'node centres align to grid columns')
    assert.equal(Math.abs((centerY - 40 - 99) % 198), 0, 'node centres align to golden-ratio rows')
    gridCells.add(`${Math.round((centerX - 40 - 160) / 320)},${Math.round((centerY - 40 - 99) / 198)}`)
  }
  assert.equal(gridCells.size, 6, 'each node occupies a different grid cell')
  assert.equal(
    JSON.parse(window.localStorage.getItem('dsh.task-dag')).layoutMode,
    'grid',
    'the layout mode is persisted',
  )

  // Auto layout inside grid mode still produces grid-aligned, distinct cells.
  await act(async () => {
    const autoButton = [...container.querySelectorAll('.dsh-td-toolbar button')]
      .find((button) => (button.textContent ?? '') === '自动布局')
    assert.ok(autoButton, 'the auto-layout button is still available in grid mode')
    autoButton.click()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const autoGridPayload = gridPositionBodies().at(-1).payload.positions
  assert.equal(autoGridPayload.length, 6, 'grid auto layout covers every node')
  const autoGridCells = new Set()
  for (const entry of autoGridPayload) {
    const centerX = entry.position.x + 104
    const centerY = entry.position.y + 42
    assert.equal(Math.abs((centerX - 40 - 160) % 320), 0)
    assert.equal(Math.abs((centerY - 40 - 99) % 198), 0)
    autoGridCells.add(`${Math.round((centerX - 40 - 160) / 320)},${Math.round((centerY - 40 - 99) / 198)}`)
  }
  assert.equal(autoGridCells.size, 6, 'grid auto layout keeps cells unique')

  // Dragging in grid mode snaps to a free cell and persists the whole grid.
  await dragNode(container, '确定数据模型', 320, 0)
  const gridDragPayload = gridPositionBodies().at(-1).payload.positions
  assert.equal(gridDragPayload.length, 6, 'a grid drag persists every node to keep the grid stable')
  const gridDragCells = new Set()
  for (const entry of gridDragPayload) {
    const centerX = entry.position.x + 104
    const centerY = entry.position.y + 42
    assert.equal(Math.abs((centerX - 40 - 160) % 320), 0)
    assert.equal(Math.abs((centerY - 40 - 99) % 198), 0)
    gridDragCells.add(`${Math.round((centerX - 40 - 160) / 320)},${Math.round((centerY - 40 - 99) / 198)}`)
  }
  assert.equal(gridDragCells.size, 6, 'grid drag keeps distinct cells')

  // While the pointer is down the card follows it continuously; only the drop
  // frame is snapped to a cell.
  const beforeLive = nodeTranslate(container, '确定数据模型')
  await act(async () => {
    const group = nodeGroupByTitle(container, '确定数据模型')
    assert.ok(group, 'the live-drag node must render')
    group.dispatchEvent(new window.MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 0,
      clientY: 0,
    }))
    window.dispatchEvent(new window.MouseEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 37,
      clientY: 23,
    }))
  })
  const live = nodeTranslate(container, '确定数据模型')
  assert.equal(live.x, beforeLive.x + 37, 'grid dragging follows the pointer horizontally')
  assert.equal(live.y, beforeLive.y + 23, 'grid dragging follows the pointer vertically')
  await act(async () => {
    window.dispatchEvent(new window.MouseEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 37,
      clientY: 23,
    }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  await act(async () => {
    const modeButton = [...container.querySelectorAll('.dsh-td-toolbar button')]
      .find((button) => (button.textContent ?? '') === '布局模式：网格')
    assert.ok(modeButton, 'the active mode is reflected on the button')
    modeButton.click()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  assert.equal(container.querySelector('.dsh-td-grid-bg'), null, 'free mode hides the grid')
  assert.equal(
    JSON.parse(window.localStorage.getItem('dsh.task-dag')).layoutMode,
    'free',
    'switching back is persisted too',
  )

  assert.equal(
    window.localStorage.getItem('dsh.task-dag') !== null,
    true,
    'the panel must keep its persisted view state',
  )

  // -- no flash-back between pointer-up and the Host snapshot ---------------
  actionDelayMs = 60
  const beforeDrop = nodeTranslate(container, '确定数据模型')
  await act(async () => {
    const group = nodeGroupByTitle(container, '确定数据模型')
    assert.ok(group, 'the drop node must render')
    group.dispatchEvent(new window.MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 0,
      clientY: 0,
    }))
    window.dispatchEvent(new window.MouseEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 45,
      clientY: 20,
    }))
    window.dispatchEvent(new window.MouseEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 45,
      clientY: 20,
    }))
  })
  const afterDrop = nodeTranslate(container, '确定数据模型')
  assert.equal(afterDrop.x, beforeDrop.x + 45, 'the dropped node keeps its new x while the action is in flight')
  assert.equal(afterDrop.y, beforeDrop.y + 20, 'the dropped node keeps its new y while the action is in flight')
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 90))
  })
  actionDelayMs = 0

  // The sidebar icon must render an SVG for both presentation states.
  const iconHost = window.document.createElement('div')
  const iconRoot = createRoot(iconHost)
  await act(async () => {
    iconRoot.render(React.createElement(registered.sidebar.component, { size: 16, active: true }))
  })
  assert.ok(iconHost.querySelector('svg'), 'the sidebar icon must render an svg')
  await act(async () => {
    iconRoot.render(React.createElement(registered.sidebar.component, { size: 18, active: false }))
  })
  assert.ok(iconHost.querySelector('svg'))
  await act(async () => {
    iconRoot.unmount()
  })

  await act(async () => {
    root.unmount()
  })
})
