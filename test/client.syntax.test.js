/**
 * Structural checks for the browser half of `dsh-task-dag`.
 *
 * `node --check client.js` proves the file parses; this suite additionally
 * pins the platform invariants that are easy to break during an edit:
 * exactly one module load, the slot options from the client contract, the
 * documented Host endpoints and action names, the localStorage hand-off,
 * theme-token-only styling, and no Harness package imports. The final test
 * loads the module against stubbed platform services, so a broken `apply`
 * fails here instead of breaking the whole GUI boot.
 *
 * Everything runs in-process: `vm.Script` parses client.js the same way
 * `node --check` does, and no child process is spawned (the sandbox cannot
 * open the piped stdio that `execFileSync` would need).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(HERE, '..', 'client.js')
const source = readFileSync(CLIENT_PATH, 'utf8')

/** Action names the UI is allowed to post to /api/task-dag/action (v2). */
const CONTRACT_ACTIONS = [
  'add-node',
  'update-node',
  'set-positions',
  'delete-node',
  'link',
  'unlink',
  'set-milestone',
  'add-condition',
  'update-condition',
  'delete-condition',
  'set-schedule',
  'attach-session',
  'switch-session',
  'detach-session',
  'handoff',
  'archive-sessions',
  'create-group',
  'rename-group',
  'delete-group',
]

/** v2 five-state labels and the task-board status tokens they must use. */
const STATUS_TOKENS = {
  planned: { label: '待规划', token: '--dsw-alias-label-tertiary' },
  todo: { label: '待开始', token: '--dsw-alias-state-business-primary' },
  doing: { label: '进行中', token: '--dsw-alias-state-warn-primary' },
  done: { label: '已完成', token: '--dsw-alias-state-success-primary' },
  failed: { label: '已失败', token: '--dsw-alias-state-error-primary' },
}

function occurrences(pattern) {
  return (source.match(pattern) || []).length
}

test('client.js parses as JavaScript (node --check equivalent)', () => {
  assert.doesNotThrow(() => {
    new vm.Script(source, { filename: 'client.js' })
  })
})

test('loads as exactly one self-contained module with the plugin id', () => {
  assert.equal(occurrences(/window\.__ModuleLoader__\.load\(/g), 1)
  assert.equal(occurrences(/\bid:\s*'dsh-task-dag'/g), 1)
  assert.equal(occurrences(/\brequire\(/g), 1, 'react must be the only required module')
  assert.ok(source.includes("require('react')"))
  assert.equal(occurrences(/^\s*import\s/gm), 0, 'a browser module must not use import')
  assert.equal(occurrences(/^\s*export\s/gm), 0, 'a browser module must not use export')
  assert.equal(source.includes("require('@deepseek-ai/"), false, 'Harness packages do not resolve from the plugin')
  assert.equal(source.includes('jsx-runtime'), false, 'no JSX transform')
})

test('apply is wrapped in try/catch that only logs, and never throws', () => {
  const applyAt = source.indexOf('apply(ctx)')
  assert.ok(applyAt > 0, 'apply(ctx) is declared')
  const applyBody = source.slice(applyAt)
  assert.match(applyBody, /try\s*\{/)
  assert.match(applyBody, /catch\s*\(\s*error\s*\)\s*\{[\s\S]{0,400}?console\.error/)
  assert.ok(applyBody.indexOf('injectStyles()') > 0, 'the stylesheet is injected inside apply')
  assert.equal(occurrences(/\bthrow\b/g), 0, 'the browser half must never throw')
})

test('registers the main panel and the sidebar entry with the contract options', () => {
  assert.match(source, /ctx\.slots\.inject\('main'/)
  assert.match(source, /name:\s*'main'/)
  assert.match(source, /key:\s*PANEL_ID/)
  assert.match(source, /ctx\.slots\.inject\('sidebar\.panellist'/)
  assert.match(source, /name:\s*'sidebar\.panellist'/)
  assert.match(source, /id:\s*PANEL_ID/)
  assert.match(source, /order:\s*25/)
  assert.match(source, /label:\s*PANEL_LABEL,/)
  assert.match(source, /const PANEL_ID = 'task-dag'/)
  assert.match(source, /const PANEL_LABEL = '任务图谱'/)
  assert.match(source, /inject:\s*\[\s*'slots',\s*'workspaces',\s*'sessions',\s*'uiWorkspace',\s*'layout'\s*\]/)
})

test('uses only the documented Host endpoints and posts the contract actions', () => {
  assert.match(source, /const API = '\/api\/task-dag'/)
  assert.ok(source.includes("API + '/workspaces'"), 'workspaces endpoint')
  assert.ok(source.includes("API + '/state'"), 'state endpoint')
  assert.ok(source.includes("API + '/action'"), 'action endpoint')
  assert.ok(source.includes("API + '/events'"), 'SSE endpoint')
  assert.ok(source.includes("API + '/catalog'"), 'catalog endpoint')
  assert.match(source, /credentials:\s*'same-origin'/)
  assert.match(source, /new EventSource\(/)
  assert.match(source, /\?workspaceId=/)
  assert.match(source, /expectedRevision/)
  assert.match(source, /requestId/)
  for (const action of CONTRACT_ACTIONS) {
    assert.ok(source.includes("'" + action + "'"), 'missing action: ' + action)
  }
  assert.equal(source.includes("'set-closeout'"), false, 'the v2 client uses set-milestone')
  for (const field of ['conditionId', 'conditionTitle', 'detachSuccessors', 'agentPreset', 'model', 'nextRunAt']) {
    assert.ok(source.includes(field), 'missing v2 payload field: ' + field)
  }
  assert.match(source, /onmessage/)
  assert.match(source, /ctx\.uiWorkspace/)
  assert.match(source, /openSession/)
})

test('models five statuses with the task-board status colours', () => {
  assert.match(source, /const STATUSES = \['planned', 'todo', 'doing', 'done', 'failed'\]/)
  for (const [status, spec] of Object.entries(STATUS_TOKENS)) {
    assert.ok(source.includes(spec.label), 'missing status label: ' + status)
    assert.ok(
      source.includes('.dsh-td-node-bar-' + status + '{fill:var(' + spec.token + ')}'),
      'node colour bar for ' + status + ' must use ' + spec.token,
    )
    assert.ok(
      source.includes('.dsh-td-dot-' + status + '{background:var(' + spec.token + ')}'),
      'status dot for ' + status + ' must use ' + spec.token,
    )
  }
  assert.equal(source.includes('state-idle-primary'), false, 'todo no longer uses the idle token')
  assert.match(source, /const STATUS_HINTS = \{/)
  // failed nodes are visually distinct and may not become a predecessor.
  assert.ok(source.includes('.dsh-td-node-failed .dsh-td-node-bg'))
  assert.match(source, /dsh-td-node-failed/)
  assert.ok(source.includes('不能作为其他节点的前序'))
})

test('renders the v2 surface: conditions, link chooser, settings, schedule, milestone', () => {
  // condition CRUD and the link flow
  assert.match(source, /function LinkConditionDialog\(props\)/)
  assert.match(source, /选择前置条件/)
  assert.match(source, /确认添加前置条件/)
  assert.ok(source.includes('conditionTitle'), 'new conditions are posted by title')
  assert.ok(source.includes('conditionId'), 'existing conditions are posted by id')
  assert.ok(source.includes('默认标题'), 'the new condition title is prefilled')
  assert.match(source, /条件 ' \+ String\(satisfiedCount\)/)
  // Parallel edges between one pair keep separate lanes via the group offset.
  assert.match(source, /groupOffsets/)
  assert.match(source, /\(index - \(list\.length - 1\) \/ 2\) \* 18/)

  // execution settings
  assert.match(source, /Agent 预设/)
  assert.match(source, /模型与推理强度/)
  assert.ok(source.includes('默认（跟随宿主）'))
  assert.ok(source.includes("act('update-node', { nodeId: node.id, agentPreset:"))
  assert.ok(source.includes("act('update-node', {"))
  assert.ok(source.includes('reasoningEffort: nextEffort'))
  assert.ok(source.includes('已保存模型与推理强度'))

  // schedule
  assert.match(source, /定时执行/)
  assert.match(source, /const CRON_PRESETS = \[/)
  assert.ok(source.includes("'0 9 * * 1-5'"), 'the weekday cron preset')
  assert.ok(source.includes("act('set-schedule'"))
  assert.match(source, /下次执行/)
  assert.match(source, /上次结果/)
  assert.match(source, /lastError/)
  assert.match(source, /lastSkippedReason/)

  // milestone
  assert.ok(source.includes("act('set-milestone'"))
  assert.match(source, /设为项目里程碑/)
  assert.ok(source.includes('项目里程碑'))

  // server-side Chinese errors go through the existing notice bar
  assert.match(source, /showNotice\('error', message\)/)
})

test('milestone is a marker, drafts are flushed, edges avoid unrelated nodes', () => {
  // The milestone no longer claims to finish the project (Host contract v2+).
  assert.equal(source.includes('里程碑达成'), false)
  assert.equal(source.includes('完成后视为项目达成'), false)
  assert.equal(source.includes('milestoneDone'), false)

  // The canvas marker sits above the card's right edge, outside its rectangle.
  assert.match(source, /dsh-td-node-milestone-flag/)
  assert.match(source, /x:\s*NODE_W,\s*y:\s*-7,\s*textAnchor:\s*'end'/)

  // Text fields autosave and expose a page-level flush before switching nodes.
  assert.match(source, /const DRAFT_SAVE_DELAY =/)
  assert.match(source, /function setDraftValue\(kind, value, extra\)/)
  assert.match(source, /function flushDraft\(kind, final\)/)
  assert.match(source, /function flushAllDrafts\(final\)/)
  assert.match(source, /onDraftFlush/)
  assert.match(source, /flushDrafts\(\)/)
  // A background save must not disable the focused textarea: disabled controls
  // lose focus in the browser, interrupting a user who is still typing.
  const notesFieldAt = source.indexOf("className: 'dsh-td-textarea dsh-td-notes-textarea'")
  assert.ok(notesFieldAt > 0, 'the notes textarea is declared')
  assert.equal(
    source.slice(notesFieldAt, notesFieldAt + 420).includes('disabled:'),
    false,
    'the notes textarea is never disabled while an action is pending',
  )

  // Edges are smooth cubic chains only: a blocked direct curve becomes a
  // smoothed detour (the orthogonal solver is an internal guide), and routed
  // edges steer clear of each other instead of overlapping.
  assert.match(source, /function smoothCubicChain\(/)
  assert.match(source, /function solveOrthogonalRoute\(/)
  assert.match(source, /function detourGuide\(/)
  assert.match(source, /function routeEdgeSet\(/)
  assert.match(source, /function chaikinSmooth\(/)
  assert.match(source, /const EDGE_CLEARANCE =/)
  assert.match(source, /const EDGE_SEPARATION =/)
})

test('keeps the UI polish invariants: DSH font scale, resizable columns, markdown notes, docked notice', () => {
  // One typographic scale derived from the DSH global font-size preference.
  assert.ok(
    source.includes('--dsh-td-fs:var(--dsh-content-font-size,14px)'),
    'the plugin base font size follows the DSH content font-size variable',
  )
  assert.equal(source.includes('font-size:13px'), false, 'no hard-coded 13px overrides the DSH base size')
  assert.match(source, /font-family:var\(--dsw-font-family,inherit\)/)

  // Two draggable separators and persisted widths.
  assert.match(source, /function ColumnSplitter\(props\)/)
  assert.equal(occurrences(/role:\s*'separator'/g), 2, 'one separator for each side column plus one for the notes editor')
  assert.match(source, /function startColumnResize\(side, event\)/)
  assert.match(source, /columnWidths/)
  assert.match(source, /MIN_MAIN_WIDTH/)
  assert.match(source, /writePersisted\(\{\s*columnWidths:/)

  // Markdown notes with an edit/preview switch and a resizable body.
  assert.match(source, /function renderMarkdown\(text\)/)
  assert.match(source, /function renderInlineMarkdown\(text, keyPrefix\)/)
  assert.equal(occurrences(/dangerouslySetInnerHTML\s*[:=]/g), 0, 'notes are rendered as React nodes, never raw HTML')
  assert.match(source, /function safeLinkTarget/)
  assert.match(source, /dsh-td-notes-preview/)
  assert.match(source, /dsh-td-notes-resizer/)
  assert.match(source, /notesHeight/)

  // Action feedback floats in the middle column instead of pushing the view.
  assert.match(source, /dsh-td-notice-dock/)
  assert.match(source, /dsh-td-main-notice/)
  const noticeAt = source.indexOf("className: 'dsh-td-notice-dock'")
  const bodyAt = source.indexOf("className: 'dsh-td-body'")
  assert.ok(noticeAt > bodyAt, 'the notice dock renders inside the three-column body, not in the header')

  // Free / golden-ratio grid layout switch in the canvas toolbar.
  assert.match(source, /GRID_GOLDEN_RATIO/)
  assert.match(source, /const GRID_W = 320/)
  assert.ok(source.includes("'布局模式：网格'"), 'grid mode is labelled')
  assert.ok(source.includes("'布局模式：自由'"), 'free mode is labelled')
  assert.match(source, /function gridAssignments/)
  assert.match(source, /function snapDraggedNodeToGrid/)
  assert.match(source, /dsh-td-grid-pattern/)
  assert.match(source, /layoutMode/)

  // Token counts use the same compact K/M style as the DSH context meter.
  assert.match(source, /function formatTokenCount/)
  assert.ok(source.includes("+ 'K'"))
  assert.ok(source.includes("+ 'M'"))
  assert.ok(source.includes("'~' + formatTokenCount"))
})

test('handles revision conflicts and persists panel state in localStorage', () => {
  assert.match(source, /revision-conflict/)
  assert.ok(source.includes('图已被其他窗口修改，已刷新'))
  assert.match(source, /const STORAGE_KEY = 'dsh\.task-dag'/)
  assert.equal(occurrences(/'dsh\.task-dag'/g), 1)
  assert.match(source, /window\.localStorage\.getItem\(STORAGE_KEY\)/)
  assert.match(source, /window\.localStorage\.setItem\(STORAGE_KEY/)
  for (const field of ['workspaceId', 'selectedNodeId', 'viewport', 'layoutMode']) {
    assert.ok(source.includes(field), 'persisted field missing: ' + field)
  }
  assert.match(source, /writePersisted\(\{\s*viewport:/)
})

test('styles only with theme tokens and keeps the injected stylesheet guarded', () => {
  assert.ok(occurrences(/--dsw-alias-/g) >= 20, 'theme tokens carry the colours')
  assert.equal(occurrences(/#[0-9a-fA-F]{3,8}\b/g), 0, 'no literal hex colours')
  assert.equal(occurrences(/\brgba?\(/g), 0, 'no literal rgb colours')
  assert.equal(occurrences(/\bhsla?\(/g), 0, 'no literal hsl colours')
  assert.equal(source.includes('--dsw-alias-text-primary'), false, 'that token does not exist in the runtime theme')
  assert.equal(source.includes('--dsw-alias-border-subtle'), false, 'that token does not exist in the runtime theme')
  assert.match(source, /data-plugin-css/)
  assert.match(source, /document\.querySelector/)
  assert.match(source, /tag\.dataset\.pluginCss = STYLE_TAG/)
  assert.match(source, /const STYLE_TAG = 'dsh-task-dag'/)
})

test('renders the M1 surface: canvas, node detail, session chain, icon props', () => {
  assert.match(source, /const NODE_W = 208/)
  assert.match(source, /markerEnd/)
  assert.match(source, /onWheel/)
  assert.match(source, /onDoubleClick/)
  assert.match(source, /MIN_SCALE = 0\.3/)
  assert.match(source, /MAX_SCALE = 2\.2/)
  assert.match(source, /function TaskDagIcon\(props\)/)
  assert.match(source, /props\.size/)
  assert.match(source, /props\.active/)
  const visibleText = [
    '交接新会话',
    '交接新会话（空会话）',
    '挂接已有会话',
    '摘除',
    '切回',
    '删除节点',
    '同时归档整条会话链',
    '建议交接',
    '只看可做',
    '自动布局',
    '上下文水位',
    '前置条件',
    '添加条件',
    '重命名',
    '已满足',
    '未满足',
    '执行设置',
    '定时执行',
    '保存定时',
    '下次执行',
    '上次结果',
    '项目里程碑',
  ]
  for (const text of visibleText) {
    assert.ok(source.includes(text), 'missing Chinese UI text: ' + text)
  }
})

test('the module factory and apply register both slots against stub services', () => {
  let exported = null
  const fakeReact = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    Component: class Component {
      constructor(props) {
        this.props = props === undefined ? {} : props
      }
    },
    useCallback: (callback) => callback,
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (initial) => ({ current: initial }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  }
  const fakeWindow = {
    __ModuleLoader__: {
      load(definition) {
        exported = definition.factory((spec) => {
          if (spec === 'react') return fakeReact
          throw new Error('unexpected require: ' + spec)
        })
      },
    },
  }
  const loggedErrors = []
  const fakeConsole = {
    error(...args) { loggedErrors.push(args) },
    log() {},
    warn() {},
  }
  const context = vm.createContext({ window: fakeWindow, console: fakeConsole, document: undefined })
  vm.runInContext(source, context, { filename: 'client.js' })

  assert.ok(exported !== null, 'the module loader captured an export')
  assert.equal(exported.inject.join(','), 'slots,workspaces,sessions,uiWorkspace,layout')

  const makeContext = (injected, registered, disposers) => ({
    slots: {
      inject(name, callback) {
        injected.push(name)
        return callback()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  })

  const injected = []
  const registered = []
  const disposers = []
  assert.doesNotThrow(() => exported.apply(makeContext(injected, registered, disposers)))
  assert.equal(injected.join(','), 'main,sidebar.panellist')
  assert.equal(registered.length, 2)

  const main = registered.find((entry) => entry.options.name === 'main')
  const sidebar = registered.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.ok(main !== undefined && typeof main.component === 'function')
  assert.equal(main.options.key, 'task-dag')
  assert.equal(sidebar.options.id, 'task-dag')
  assert.equal(sidebar.options.order, 25)
  // A plain string label (not a per-apply closure) keeps the sidebar row's
  // resolved label stable across slot re-syncs.
  assert.equal(sidebar.options.label, '任务图谱')
  assert.equal(typeof sidebar.options.label, 'string')

  const active = sidebar.component({ size: 16, active: true })
  assert.equal(active.type, 'svg')
  assert.equal(active.props.width, 16)
  assert.equal(sidebar.component({}).props.width, 18)

  // A second apply in the same page must be a no-op. Duplicate `main` entries
  // churn the layout registry, and that churn is what bounces the user back to
  // the conversation and briefly empties the sidebar label.
  const injectedAgain = []
  const registeredAgain = []
  const disposersAgain = []
  assert.doesNotThrow(() => exported.apply(makeContext(injectedAgain, registeredAgain, disposersAgain)))
  assert.equal(injectedAgain.length, 0, 'a duplicate apply must not inject slots again')
  assert.equal(registeredAgain.length, 0, 'a duplicate apply must not register again')
  assert.equal(disposersAgain.length, 0, 'a duplicate apply must not add cleanup effects')
  assert.equal(registered.length, 2, 'the panel list still has exactly one entry per slot')

  // Fiber cleanup (hot reload) releases the claim so the rebuilt bundle can
  // register again instead of being silently dropped.
  for (const dispose of disposers) dispose()
  const injectedAfterReload = []
  const registeredAfterReload = []
  const disposersAfterReload = []
  assert.doesNotThrow(() => exported.apply(makeContext(injectedAfterReload, registeredAfterReload, disposersAfterReload)))
  assert.equal(registeredAfterReload.length, 2, 'a rebuilt bundle registers after the old fiber unloads')
  assert.equal(registeredAfterReload[1].options.label, '任务图谱')

  // A failed apply releases its claim and is logged instead of thrown.
  for (const dispose of disposersAfterReload) dispose()
  assert.doesNotThrow(() => exported.apply({ slots: { inject() { throw new Error('slots unavailable') } } }))
  assert.ok(loggedErrors.length > 0, 'apply failures are logged instead of thrown')
})

test('restores the panel after a client bundle re-register without stealing navigation', () => {
  let exported = null
  const fakeReact = {
    createElement: () => ({}),
    Component: class Component {},
    useCallback: (callback) => callback,
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (initial) => ({ current: initial }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  }
  const fakeWindow = {
    __ModuleLoader__: {
      load(definition) {
        exported = definition.factory((specifier) => {
          if (specifier === 'react') return fakeReact
          throw new Error('unexpected require: ' + specifier)
        })
      },
    },
  }
  const context = vm.createContext({
    window: fakeWindow,
    console: { error() {}, log() {}, warn() {} },
    document: undefined,
  })
  vm.runInContext(source, context, { filename: 'client.js' })

  // A minimal layout whose panels can be selected and observed.
  const selected = []
  const listeners = new Set()
  const panelInfo = {
    activePanelId: 'task-dag',
    getSnapshot() {
      return { activePanelId: this.activePanelId }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(panelId) {
      this.activePanelId = panelId
      for (const listener of listeners) listener()
    },
  }
  const layout = {
    panelInfo,
    selectPanel(panelId) {
      selected.push(panelId)
      panelInfo.set(panelId)
    },
  }

  const mainEntries = []
  const disposers = []
  const makeContext = () => ({
    layout,
    slots: {
      inject(_name, callback) {
        return callback()
      },
      register(options, component) {
        const entry = { options, component }
        if (options.name === 'main') mainEntries.push(entry)
        return () => {
          const at = mainEntries.indexOf(entry)
          if (at >= 0) mainEntries.splice(at, 1)
        }
      },
      entries(name) {
        return name === 'main' ? [...mainEntries] : []
      },
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  })

  assert.doesNotThrow(() => exported.apply(makeContext()))
  assert.equal(selected.length, 0, 'a normal first apply never changes the active panel')
  assert.equal(fakeWindow[Symbol.for('dsh-task-dag.client.panel-active')], true)

  // Simulate the bundle being unloaded while the panel is active: effects are
  // disposed and the main entry disappears, which is exactly what makes the
  // layout fall back to the conversation.
  for (const dispose of disposers.splice(0)) dispose()
  mainEntries.splice(0)
  panelInfo.set(null)
  assert.equal(selected.length, 0, 'the unload itself does not navigate anywhere')

  // The rebuilt bundle registers again and restores the user's panel once.
  assert.doesNotThrow(() => exported.apply(makeContext()))
  assert.deepEqual(selected, ['task-dag'], 'the rebuilt bundle restores the panel the user was on')

  // After a deliberate navigation back to the conversation, a later reload must
  // not drag the user back to the plugin panel.
  panelInfo.set(null)
  assert.equal(fakeWindow[Symbol.for('dsh-task-dag.client.panel-active')], false)
  for (const dispose of disposers.splice(0)) dispose()
  mainEntries.splice(0)
  panelInfo.set('conversation')
  panelInfo.set(null)
  exported.apply(makeContext())
  assert.deepEqual(selected, ['task-dag'], 'no restore after the user left the panel on purpose')

  for (const dispose of disposers.splice(0)) dispose()
  delete fakeWindow[Symbol.for('dsh-task-dag.client.panel-active')]
})

test('restores only its own panel after a bundle reload and opens sessions only from user actions', () => {
  // ui-layout falls back to the conversation whenever the main registry changes,
  // and a client-bundle reload is one. The plugin remembers that the user was on
  // its panel and re-selects it after re-registering; it never navigates panels
  // for any other reason. `retainMainPanels` remains off-limits.
  assert.equal(occurrences(/\.selectPanel\(/g), 1, 'exactly one guarded panel restore call site')
  assert.match(source, /function restorePanelAfterReload\(ctx\)/)
  assert.match(source, /if \(!readPanelActive\(\)\) return/)
  assert.ok(source.includes('ctx.layout.selectPanel(PANEL_ID)'))
  assert.equal(source.includes('retainMainPanels'), false, 'the client must not touch the layout registry directly')
  assert.equal(occurrences(/ui\.openSession\(/g), 1, 'exactly one openSession call site')
  assert.match(source, /onOpen: \(sessionId\) => props\.onOpenSession\(sessionId\)/)
  assert.match(source, /onClick: \(\) => props\.onOpen\(session\.sessionId\)/)
})
