/**
 * Client half of the `dsh-task-dag` bundle.
 *
 * One project workspace is shown as an editable task DAG (v2): five-state
 * nodes, prerequisite conditions (edges satisfy one condition each), per-node
 * agent preset/model, per-node cron schedule, and one project milestone (a
 * marker only: a done milestone never finishes the project). Each node owns an
 * ordered chain of chat sessions with exactly one current session.
 *
 * The canvas draws every edge as a smooth cubic chain that steers around
 * unrelated cards and away from the other edges (no orthogonal segments), fits
 * a long node title to the card width and clips whatever still overflows, can
 * undo a node drag or an auto layout, and turns an Alt + left-drag lasso of
 * fully enclosed nodes into a named group with a dashed, grid-aligned contour.
 * The detail drawer autosaves its text drafts before the selection moves. The
 * Host half owns the graph file (including groups); this file only renders the
 * snapshot and posts actions back to it.
 *
 * Platform facts this file depends on (verified against DSH 0.2.1-rc.3):
 *   - loaded as one self-contained module by `window.__ModuleLoader__.load`;
 *   - only `react` is required (no JSX, no bundler, no Harness packages);
 *   - the whole `apply` body is wrapped in try/catch: a throwing client apply
 *     breaks the entire GUI boot;
 *   - `apply` may run more than once in a page lifetime (stale + rebuilt
 *     bundle); a cross-instance guard keeps extra runs from re-registering the
 *     slots, because every `main` registry change can reset the layout's
 *     active panel and bounce the user back to the conversation;
 *   - the `main` slot unmounts on navigation, so workspace selection, node
 *     selection and the canvas viewport are restored from localStorage;
 *   - colours come only from `--dsw-alias-*` theme tokens.
 *
 * Sections:
 *   0. imports            5. HTTP transport      10. SVG canvas
 *   1. constants          6. graph model         11. detail drawer
 *   2. stylesheet         7. platform bridges    12. panel page
 *   3. local storage      8. small atoms         13. icon / apply
 *   4. pure helpers       9. workspace column
 */
window.__ModuleLoader__.load({
  id: 'dsh-task-dag',
  factory(require) {
    'use strict'

    // =======================================================================
    // 0. Imports — `react` is the only seed module this bundle needs.
    // =======================================================================
    const React = require('react')
    const h = React.createElement
    const useCallback = React.useCallback
    const useEffect = React.useEffect
    const useMemo = React.useMemo
    const useRef = React.useRef
    const useState = React.useState

    // =======================================================================
    // 1. Constants
    // =======================================================================
    const PANEL_ID = 'task-dag'
    const PANEL_LABEL = '任务图谱'
    const API = '/api/task-dag'
    const ENDPOINTS = {
      workspaces: API + '/workspaces',
      state: API + '/state',
      action: API + '/action',
      events: API + '/events',
      catalog: API + '/catalog',
    }
    const STORAGE_KEY = 'dsh.task-dag'
    const STYLE_TAG = 'dsh-task-dag'
    const CONFLICT_TEXT = '图已被其他窗口修改，已刷新'
    const HANDOFF_THRESHOLD = 0.6

    // Cross-module-instance apply guard. The bundle factory can run more than
    // once in one page lifetime (a rebuilt bundle next to a stale one, or a
    // hot reload). Every extra `apply` would register another `main` key and
    // another sidebar row; the layout prunes its active panel whenever the
    // `main` entry list changes, which bounces the user back to the
    // conversation. The first claim wins; the fiber cleanup (or a failed
    // apply) releases it so a rebuilt bundle can register again.
    const APPLY_GUARD = Symbol.for('dsh-task-dag.client.mount')

    // Set while this plugin's main panel is the active layout panel. ui-layout
    // drops the active panel whenever the `main` registry changes, and a client
    // bundle reload is such a change: the old fiber unregisters, the layout
    // falls back to the conversation, and the rebuilt bundle registers again.
    // The rebuilt bundle reads this flag and puts the user back where they were.
    const PANEL_ACTIVE_FLAG = Symbol.for('dsh-task-dag.client.panel-active')

    function guardHost() {
      if (typeof window !== 'undefined' && window !== null) return window
      if (typeof globalThis !== 'undefined' && globalThis !== null) return globalThis
      return null
    }

    function claimMount() {
      const host = guardHost()
      if (host === null) return true
      try {
        if (host[APPLY_GUARD] === true) return false
        host[APPLY_GUARD] = true
        return true
      } catch (error) {
        return true
      }
    }

    function releaseMount() {
      const host = guardHost()
      if (host === null) return
      try {
        delete host[APPLY_GUARD]
      } catch (error) {
        try {
          host[APPLY_GUARD] = false
        } catch (ignored) {
          // A non-configurable host cannot be cleaned; the next page reload
          // starts from a fresh global anyway.
        }
      }
    }

    function readPanelActive() {
      const host = guardHost()
      if (host === null) return false
      try {
        return host[PANEL_ACTIVE_FLAG] === true
      } catch (error) {
        return false
      }
    }

    function writePanelActive(value) {
      const host = guardHost()
      if (host === null) return
      try {
        host[PANEL_ACTIVE_FLAG] = value === true
      } catch (error) {
        // A frozen host just loses the restore hint; the panel still works.
      }
    }

    /** Whether this plugin's `main` entry is currently in the slot registry. */
    function mainPanelRegistered(ctx) {
      try {
        if (ctx === null || typeof ctx !== 'object') return true
        if (ctx.slots === null || typeof ctx.slots !== 'object') return true
        if (typeof ctx.slots.entries !== 'function') return true
        const entries = ctx.slots.entries('main')
        if (!Array.isArray(entries)) return true
        return entries.some((entry) => entry !== null && entry !== undefined
          && entry.options !== null && entry.options !== undefined
          && entry.options.key === PANEL_ID)
      } catch (error) {
        return true
      }
    }

    function layoutPanelInfo(ctx) {
      try {
        if (ctx === null || typeof ctx !== 'object') return null
        const layout = ctx.layout
        if (layout === null || typeof layout !== 'object') return null
        const info = layout.panelInfo
        return info !== null && typeof info === 'object' ? info : null
      } catch (error) {
        return null
      }
    }

    function currentActivePanel(ctx) {
      const info = layoutPanelInfo(ctx)
      if (info === null || typeof info.getSnapshot !== 'function') return null
      try {
        const snapshot = info.getSnapshot()
        return snapshot !== null && typeof snapshot === 'object' && typeof snapshot.activePanelId === 'string'
          ? snapshot.activePanelId
          : null
      } catch (error) {
        return null
      }
    }

    /**
     * Track whether the user is looking at this panel. A null active panel while
     * our main entry is still registered is a normal navigation back to the
     * conversation; a null while the entry has disappeared is the bundle being
     * torn down for a reload, so the flag survives and the rebuilt bundle can
     * restore it.
     */
    function watchPanelActivity(ctx) {
      const info = layoutPanelInfo(ctx)
      if (info === null || typeof info.subscribe !== 'function' || typeof info.getSnapshot !== 'function') {
        return () => {}
      }
      const update = () => {
        const active = currentActivePanel(ctx)
        if (active === PANEL_ID) {
          writePanelActive(true)
          return
        }
        if (active === null) {
          if (mainPanelRegistered(ctx)) writePanelActive(false)
          return
        }
        writePanelActive(false)
      }
      let dispose = null
      try {
        dispose = info.subscribe(update)
      } catch (error) {
        console.error('[dsh-task-dag] cannot watch the active panel', error)
      }
      update()
      return typeof dispose === 'function' ? dispose : () => {}
    }

    /** After a bundle reload, re-select this panel if it was the active one. */
    function restorePanelAfterReload(ctx) {
      if (!readPanelActive()) return
      if (currentActivePanel(ctx) === PANEL_ID) return
      try {
        if (ctx !== null && typeof ctx === 'object' && ctx.layout !== null && typeof ctx.layout === 'object'
          && typeof ctx.layout.selectPanel === 'function') {
          ctx.layout.selectPanel(PANEL_ID)
        }
      } catch (error) {
        console.error('[dsh-task-dag] cannot restore the active panel after a reload', error)
      }
    }

    // Canvas geometry. Mirrors src/model.js autoLayout (column = topological
    // level, row = index within the level) so an untouched graph looks the
    // same on both halves.
    const NODE_W = 208
    const NODE_H = 84
    const AUTO_X0 = 40
    const AUTO_Y0 = 40
    const AUTO_DX = 260
    const AUTO_DY = 130
    const AUTO_COMPONENT_GAP = 80
    const AUTO_ISOLATED_COLUMNS = 3
    const LAYOUT_PAD = 20

    // Edge routing. Every edge is a smooth cubic chain: the direct curve when it
    // is clean, otherwise a smoothed detour around the cards in between.
    // `CLEARANCE` is added to every obstacle rectangle so a curve never grazes a
    // card, and `SEPARATION` is the distance two unrelated edges try to keep so
    // they do not lie on top of each other. Orthogonal routes are only used as
    // an internal waypoint guide; no right-angle segment ever reaches the SVG.
    const EDGE_CLEARANCE = 10
    const EDGE_STUB = 14
    const EDGE_TURN_COST = 22
    const EDGE_CURVE_STEPS = 32
    const EDGE_ROUTE_PAD = 160
    const EDGE_SEPARATION = 8
    const EDGE_ANCHOR_STEP = 10
    const EDGE_ANCHOR_LIMIT = 24
    const EDGE_GUIDE_PAD = 20
    const EDGE_BOWS = [0, 44, -44, 86, -86]

    // Text fields save themselves: a quiet delay after typing, on blur, and
    // before the panel switches nodes or unmounts.
    const DRAFT_SAVE_DELAY = 700

    // Position undo: drags and auto layouts are the only position-changing
    // gestures, so a small stack of pre-gesture position maps covers them.
    const UNDO_LIMIT = 20

    // Grid mode: cells are golden-ratio rectangles; a node's centre snaps to
    // the cell centre. 320 x 198 is ~1.616:1, close to φ and roomy enough for
    // the 208 x 84 card.
    const GRID_GOLDEN_RATIO = 1.618033988749895
    const GRID_W = 320
    const GRID_H = Math.round(GRID_W / GRID_GOLDEN_RATIO)
    const GRID_X0 = AUTO_X0
    const GRID_Y0 = AUTO_Y0
    const MIN_SCALE = 0.3
    const MAX_SCALE = 2.2

    // Three-column layout. The side columns are drag-resizable; the widths are
    // persisted with the rest of the panel state and clamped so the canvas can
    // never collapse to nothing.
    const DEFAULT_LEFT_WIDTH = 200
    const DEFAULT_RIGHT_WIDTH = 322
    const MIN_LEFT_WIDTH = 150
    const MAX_LEFT_WIDTH = 480
    const MIN_RIGHT_WIDTH = 240
    const MAX_RIGHT_WIDTH = 680
    const MIN_MAIN_WIDTH = 320
    const SPLITTER_WIDTH = 7
    const COLUMN_STEP = 16

    // Notes editor: user-resizable height, persisted across remounts.
    const DEFAULT_NOTES_HEIGHT = 150
    const MIN_NOTES_HEIGHT = 80
    const MAX_NOTES_HEIGHT = 520

    // v2: five statuses. planned nodes stay on the graph as future work and do
    // not take part in the ready/blocked computation; only `done` satisfies a
    // prerequisite condition, and a failed node may not be a predecessor.
    const STATUSES = ['planned', 'todo', 'doing', 'done', 'failed']
    const STATUS_LABELS = {
      planned: '待规划',
      todo: '待开始',
      doing: '进行中',
      done: '已完成',
      failed: '已失败',
    }
    const STATUS_HINTS = {
      planned: '未拆解，不参与可开始计算',
      todo: '前置条件满足后可开始',
      doing: '正在执行',
      done: '可满足后续前置条件',
      failed: '不能作为其他节点的前序',
    }
    const HANDOFF_LABELS = {
      manual: '手动挂接',
      brief: '简报交接',
      blank: '空会话交接',
      attach: '挂接已有会话',
      scheduled: '定时执行',
    }
    const SCHEDULE_RESULT_LABELS = {
      succeeded: '成功',
      failed: '失败',
      skipped: '已跳过',
    }
    // Common 5-field cron expressions; the Host computes the next run in its
    // own local time zone (same convention as the task-board scheduler).
    const CRON_PRESETS = [
      { cron: '0 9 * * *', label: '每天 9:00' },
      { cron: '0 9 * * 1-5', label: '工作日 9:00' },
      { cron: '0 9 * * 1', label: '每周一 9:00' },
      { cron: '0 * * * *', label: '每小时' },
      { cron: '*/30 * * * *', label: '每 30 分钟' },
    ]
    const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'

    // =======================================================================
    // 2. Stylesheet — injected once inside `apply`, guarded by a style tag.
    //    Every colour is a `--dsw-alias-*` theme token: no literal colours.
    // =======================================================================
    const CSS = [
      // Typography follows the DSH global content font size so the plugin never
      // looks smaller than the rest of the GUI. Everything below is expressed on
      // one four-step scale derived from that variable.
      '.dsh-td-root{--dsh-td-fs:var(--dsh-content-font-size,14px);--dsh-td-fs-lg:calc(var(--dsh-td-fs) + 1px);',
      '--dsh-td-fs-sm:max(10px, calc(var(--dsh-td-fs) - 1px));--dsh-td-fs-xs:max(9px, calc(var(--dsh-td-fs) - 2px));',
      '--dsh-td-fs-xxs:max(8px, calc(var(--dsh-td-fs) - 3px));',
      'position:relative;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;',
      'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherit);',
      'font-size:var(--dsh-td-fs);line-height:1.5;text-align:left}',
      '.dsh-td-root *,.dsh-td-root *::before,.dsh-td-root *::after{box-sizing:border-box}',

      // header
      '.dsh-td-header{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:8px 14px;min-height:46px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dsh-td-heading{margin:0;font-size:var(--dsh-td-fs-lg);font-weight:600;white-space:nowrap}',
      '.dsh-td-heading-sub{font-size:var(--dsh-td-fs-sm);color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px}',
      '.dsh-td-summary{display:flex;align-items:center;gap:8px;font-size:var(--dsh-td-fs-sm);color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden}',
      '.dsh-td-summary-strong{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.dsh-td-spacer{flex:1 1 auto;min-width:8px}',
      '.dsh-td-live{display:inline-flex;align-items:center;gap:5px;font-size:var(--dsh-td-fs-xs);color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.dsh-td-live-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-caption)}',
      '.dsh-td-live-dot-on{background:var(--dsw-alias-state-success-primary)}',
      // operation notice: a floating bar docked to the bottom of the canvas
      // column. It is absolutely positioned, so showing it never reflows the
      // graph or moves the user's viewport.
      '.dsh-td-notice-dock{position:absolute;left:10px;right:10px;bottom:10px;z-index:9;display:flex;justify-content:center;pointer-events:none}',
      '.dsh-td-notice{pointer-events:auto;display:flex;align-items:center;gap:10px;max-width:100%;padding:7px 12px;',
      'font-size:var(--dsh-td-fs-sm);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);',
      'background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv2);animation:dsh-td-notice-in .16s ease-out}',
      '.dsh-td-notice-info{color:var(--dsw-alias-label-secondary);border-left:3px solid var(--dsw-alias-state-business-primary)}',
      '.dsh-td-notice-warn{color:var(--dsw-alias-state-warn-primary);border-left:3px solid var(--dsw-alias-state-warn-primary)}',
      '.dsh-td-notice-error{color:var(--dsw-alias-state-error-primary);border-left:3px solid var(--dsw-alias-state-error-primary)}',
      '.dsh-td-notice-text{flex:1 1 auto;min-width:0;word-break:break-word}',
      '@keyframes dsh-td-notice-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',

      // generic buttons / chips / form controls
      '.dsh-td-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-height:26px;padding:3px 10px;',
      'border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);',
      'color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--dsh-td-fs-sm);line-height:1.4;cursor:pointer;white-space:nowrap}',
      '.dsh-td-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-td-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
      '.dsh-td-btn:disabled{opacity:.5;cursor:default}',
      '.dsh-td-btn-sm{min-height:22px;padding:1px 8px;font-size:var(--dsh-td-fs-xs)}',
      '.dsh-td-btn-text{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.dsh-td-btn-text:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-td-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}',
      '.dsh-td-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dsh-td-btn-danger{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-td-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.dsh-td-btn-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dsh-td-close{min-width:22px;padding:1px 6px}',
      '.dsh-td-chip{display:inline-flex;align-items:center;gap:3px;padding:0 5px;border:.5px solid var(--dsw-alias-border-l3);',
      'border-radius:999px;font-size:var(--dsh-td-fs-xxs);line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dsh-td-chip-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
      '.dsh-td-chip-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.dsh-td-chip-success{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.dsh-td-chip-brand{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dsh-td-chip-muted{border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary)}',
      '.dsh-td-input,.dsh-td-textarea{width:100%;font:inherit;font-size:var(--dsh-td-fs-sm);padding:5px 7px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);',
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);outline:none}',
      '.dsh-td-input:focus,.dsh-td-textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dsh-td-textarea{min-height:66px;line-height:1.6;resize:vertical}',
      '.dsh-td-label{font-size:var(--dsh-td-fs-xs);color:var(--dsw-alias-label-tertiary)}',
      '.dsh-td-hintline{font-size:var(--dsh-td-fs-xxs);color:var(--dsw-alias-label-tertiary);line-height:1.6}',
      '.dsh-td-check{display:flex;align-items:center;gap:6px;font-size:var(--dsh-td-fs-xs);color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dsh-td-check input{accent-color:var(--dsw-alias-brand-primary)}',
      '.dsh-td-radio{display:flex;align-items:flex-start;gap:6px;font-size:var(--dsh-td-fs-xs);line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dsh-td-radio input{margin-top:2px;accent-color:var(--dsw-alias-brand-primary)}',

      // three columns; side widths are driven by inline flex-basis from state
      '.dsh-td-body{flex:1 1 auto;min-height:0;display:flex;align-items:stretch;overflow:hidden}',
      '.dsh-td-col-left{flex:0 0 200px;min-width:0;min-height:0;display:flex;flex-direction:column}',
      '.dsh-td-splitter{position:relative;flex:0 0 7px;align-self:stretch;padding:0;border:0;background:transparent;',
      'cursor:col-resize;touch-action:none;outline:none;z-index:3}',
      '.dsh-td-splitter-line{position:absolute;top:0;bottom:0;left:3px;width:1px;border-radius:1px;background:var(--dsw-alias-border-l2);transition:background-color .12s,width .12s}',
      '.dsh-td-splitter:hover .dsh-td-splitter-line,.dsh-td-splitter:focus-visible .dsh-td-splitter-line,',
      '.dsh-td-splitter-active .dsh-td-splitter-line{left:2px;width:3px;background:var(--dsw-alias-brand-primary)}',
      '.dsh-td-splitter:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}',
      '.dsh-td-col-head{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:10px 12px 6px;font-size:var(--dsh-td-fs-xs);letter-spacing:.06em;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-td-col-scroll{flex:1 1 auto;min-height:0;overflow:auto;padding:0 8px 10px;display:flex;flex-direction:column;gap:4px}',
      '.dsh-td-col-foot{flex:0 0 auto;padding:8px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dsh-td-ws{display:flex;flex-direction:column;gap:2px;width:100%;padding:7px 9px;text-align:left;font:inherit;cursor:pointer;',
      'border:.5px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary)}',
      '.dsh-td-ws:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-td-ws-active{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l3)}',
      '.dsh-td-ws-name{font-size:var(--dsh-td-fs);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-td-ws-meta{font-size:var(--dsh-td-fs-xs);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.dsh-td-main{position:relative;flex:1 1 auto;min-width:0;min-height:0;display:flex}',

      // canvas
      '.dsh-td-canvas{position:relative;flex:1 1 auto;min-width:0;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base)}',
      '.dsh-td-svg{display:block;width:100%;height:100%;cursor:grab;touch-action:none;user-select:none}',
      '.dsh-td-svg-panning{cursor:grabbing}',
      '.dsh-td-canvas-bg{fill:var(--dsw-alias-bg-base)}',
      '.dsh-td-grid-bg{pointer-events:none}',
      '.dsh-td-grid-cell{fill:none;stroke:var(--dsw-alias-border-l2);stroke-width:1}',
      '.dsh-td-toolbar{position:absolute;left:10px;top:10px;display:flex;align-items:center;gap:6px;padding:5px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-td-zoom{min-width:40px;text-align:center;font-size:var(--dsh-td-fs-xs);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.dsh-td-canvas-hint{position:absolute;left:12px;bottom:10px;font-size:var(--dsh-td-fs-xs);line-height:1.5;color:var(--dsw-alias-label-tertiary);pointer-events:none;max-width:calc(100% - 24px)}',
      '.dsh-td-main-notice .dsh-td-canvas-hint{bottom:66px}',
      '.dsh-td-edgebar{position:absolute;left:50%;bottom:34px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;',
      'max-width:calc(100% - 32px);padding:5px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-td-main-notice .dsh-td-edgebar{bottom:86px}',
      '.dsh-td-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:none}',
      '.dsh-td-overlay-card{pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;',
      'max-width:440px;padding:20px 22px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-td-overlay-title{font-size:var(--dsh-td-fs-lg);font-weight:600}',
      '.dsh-td-overlay-text{font-size:var(--dsh-td-fs-sm);line-height:1.7;color:var(--dsw-alias-label-secondary)}',
      '.dsh-td-empty{padding:18px 12px;font-size:var(--dsh-td-fs-sm);line-height:1.7;text-align:center;color:var(--dsw-alias-label-tertiary)}',

      // svg graph
      '.dsh-td-arrowhead{fill:var(--dsw-alias-label-caption)}',
      '.dsh-td-arrowhead-active{fill:var(--dsw-alias-brand-primary)}',
      '.dsh-td-edge{fill:none;stroke:var(--dsw-alias-label-caption);stroke-width:1.4}',
      '.dsh-td-edge-active{stroke:var(--dsw-alias-brand-primary);stroke-width:2}',
      '.dsh-td-edge-hit{fill:none;stroke:transparent;stroke-width:14;cursor:pointer}',
      '.dsh-td-edge-hit:hover + .dsh-td-edge{stroke:var(--dsw-alias-brand-primary);stroke-width:2}',
      '.dsh-td-ghost-edge{fill:none;stroke:var(--dsw-alias-brand-primary);stroke-width:1.6;stroke-dasharray:6 4}',
      '.dsh-td-node{cursor:pointer}',
      '.dsh-td-node-bg{fill:var(--dsw-alias-bg-layer-1);stroke:var(--dsw-alias-border-l2);stroke-width:1}',
      '.dsh-td-node:hover .dsh-td-node-bg{fill:var(--dsw-alias-bg-layer-2);stroke:var(--dsw-alias-border-l4)}',
      '.dsh-td-node-selected .dsh-td-node-bg{stroke:var(--dsw-alias-brand-primary);stroke-width:2;stroke-dasharray:none}',
      '.dsh-td-node-blocked .dsh-td-node-bg{stroke-dasharray:5 3}',
      '.dsh-td-node-emphasis .dsh-td-node-bg{stroke:var(--dsw-alias-state-success-primary);stroke-width:1.6}',
      '.dsh-td-node-dim{opacity:.3}',
      '.dsh-td-node-dragging{cursor:grabbing}',
      // status colours mirror the task board's `.statusDot` tokens exactly;
      // planned/todo/doing/done/failed each get one theme token.
      '.dsh-td-node-bar-planned{fill:var(--dsw-alias-label-tertiary)}',
      '.dsh-td-node-bar-todo{fill:var(--dsw-alias-state-business-primary)}',
      '.dsh-td-node-bar-doing{fill:var(--dsw-alias-state-warn-primary)}',
      '.dsh-td-node-bar-done{fill:var(--dsw-alias-state-success-primary)}',
      '.dsh-td-node-bar-failed{fill:var(--dsw-alias-state-error-primary)}',
      '.dsh-td-node-failed .dsh-td-node-bg{stroke:var(--dsw-alias-state-error-primary);stroke-width:1.6}',
      '.dsh-td-node-failed .dsh-td-node-title{fill:var(--dsw-alias-label-tertiary)}',
      '.dsh-td-node-failed .dsh-td-node-meta{fill:var(--dsw-alias-state-error-primary)}',
      '.dsh-td-node-scheduled .dsh-td-node-flag{fill:var(--dsw-alias-state-warn-primary)}',
      '.dsh-td-node-milestone .dsh-td-node-flag{fill:var(--dsw-alias-state-success-primary);paint-order:stroke;stroke:var(--dsw-alias-bg-base);stroke-width:3px}',
      '.dsh-td-node-title{fill:var(--dsw-alias-label-primary);font-size:var(--dsh-td-fs);font-weight:500;font-family:inherit}',
      '.dsh-td-node-meta{fill:var(--dsw-alias-label-tertiary);font-size:var(--dsh-td-fs-xs);font-family:inherit}',
      '.dsh-td-node-chain{fill:var(--dsw-alias-label-secondary);font-size:var(--dsh-td-fs-sm);font-family:inherit}',
      '.dsh-td-node-flag{fill:var(--dsw-alias-brand-primary);font-size:var(--dsh-td-fs-xxs);font-family:inherit}',
      '.dsh-td-breathe{fill:var(--dsw-alias-state-success-primary);animation:dsh-td-breathe 1.6s ease-in-out infinite}',
      '.dsh-td-handle-line{stroke:var(--dsw-alias-border-l3);stroke-width:1}',
      '.dsh-td-handle{fill:var(--dsw-alias-bg-layer-1);stroke:var(--dsw-alias-brand-primary);stroke-width:1.4;cursor:crosshair}',
      '.dsh-td-handle:hover{fill:var(--dsw-alias-brand-primary)}',
      // groups: a dashed contour whose edges sit on the layout grid
      '.dsh-td-group-outline{fill:none;stroke:var(--dsw-alias-brand-primary);stroke-width:1.4;stroke-dasharray:7 5;opacity:.75;pointer-events:none}',
      '.dsh-td-group-selected .dsh-td-group-outline{stroke-width:2;opacity:1}',
      '.dsh-td-group-hit{fill:none;stroke:transparent;stroke-width:12;cursor:pointer}',
      '.dsh-td-group-label{fill:var(--dsw-alias-brand-primary);font-size:var(--dsh-td-fs-xs);font-family:inherit;',
      'paint-order:stroke;stroke:var(--dsw-alias-bg-base);stroke-width:3px;pointer-events:none}',
      '.dsh-td-group-selected .dsh-td-group-label{fill:var(--dsw-alias-label-primary)}',
      // hand-drawn lasso preview (Alt + left drag)
      '.dsh-td-lasso{fill:var(--dsw-alias-brand-primary);fill-opacity:.07;stroke:var(--dsw-alias-brand-primary);',
      'stroke-width:1.2;stroke-dasharray:6 4;pointer-events:none}',
      '.dsh-td-lasso-count{fill:var(--dsw-alias-brand-primary);font-size:var(--dsh-td-fs-xs);font-family:inherit;',
      'paint-order:stroke;stroke:var(--dsw-alias-bg-base);stroke-width:3px;pointer-events:none}',
      '@keyframes dsh-td-breathe{0%,100%{opacity:.25}50%{opacity:1}}',

      // detail drawer
      '.dsh-td-col-right{flex:0 0 322px;min-width:0;min-height:0;display:flex;flex-direction:column}',
      '.dsh-td-detail-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;min-height:42px;padding:9px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dsh-td-detail-title{flex:1 1 auto;min-width:0;font-size:var(--dsh-td-fs-sm);font-weight:600;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-td-detail-scroll{flex:1 1 auto;min-height:0;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:14px}',
      '.dsh-td-field{display:flex;flex-direction:column;gap:4px}',
      '.dsh-td-seg{display:flex;gap:4px}',
      '.dsh-td-seg-btn{flex:1 1 0;min-height:26px;padding:3px 4px;font-family:inherit;font-size:var(--dsh-td-fs-sm);cursor:pointer;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}',
      '.dsh-td-seg-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-td-seg-btn-on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsh-td-section{display:flex;flex-direction:column;gap:6px}',
      '.dsh-td-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.dsh-td-section-title{font-size:var(--dsh-td-fs-sm);font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.dsh-td-section-note{font-size:var(--dsh-td-fs-xxs);color:var(--dsw-alias-label-tertiary)}',
      '.dsh-td-row{display:flex;align-items:center;gap:8px;padding:6px 8px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-td-row-active{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-td-row-muted{border-color:var(--dsw-alias-border-l1);background:transparent}',
      '.dsh-td-row-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.dsh-td-row-title{display:flex;align-items:center;gap:6px;font-size:var(--dsh-td-fs-sm);color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-td-row-title-muted{color:var(--dsw-alias-label-tertiary)}',
      '.dsh-td-row-meta{font-size:var(--dsh-td-fs-xxs);color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-td-row-actions{flex:0 0 auto;display:flex;align-items:center;gap:2px}',
      '.dsh-td-dot{display:inline-block;flex:0 0 auto;width:6px;height:6px;border-radius:50%}',
      '.dsh-td-dot-planned{background:var(--dsw-alias-label-tertiary)}',
      '.dsh-td-dot-todo{background:var(--dsw-alias-state-business-primary)}',
      '.dsh-td-dot-doing{background:var(--dsw-alias-state-warn-primary)}',
      '.dsh-td-dot-done{background:var(--dsw-alias-state-success-primary)}',
      '.dsh-td-dot-failed{background:var(--dsw-alias-state-error-primary)}',
      '.dsh-td-presence{display:inline-block;flex:0 0 auto;width:7px;height:7px;border-radius:50%;',
      'background:var(--dsw-alias-state-success-primary);animation:dsh-td-breathe 1.6s ease-in-out infinite}',
      '.dsh-td-meter{height:5px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-layer-3)}',
      '.dsh-td-meter-fill{height:100%;border-radius:999px;background:var(--dsw-alias-state-success-primary)}',
      '.dsh-td-meter-warn{background:var(--dsw-alias-state-warn-primary)}',
      '.dsh-td-meter-danger{background:var(--dsw-alias-state-error-primary)}',
      '.dsh-td-toolbar-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
      '.dsh-td-danger-zone{display:flex;flex-direction:column;gap:8px;padding:10px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}',
      '.dsh-td-danger-title{font-size:var(--dsh-td-fs-xs);font-weight:600;color:var(--dsw-alias-state-error-primary)}',
      '.dsh-td-candidates{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto;padding:6px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-td-candidate{display:flex;align-items:center;gap:6px}',
      '.dsh-td-candidate-title{flex:1 1 auto;min-width:0;font-size:var(--dsh-td-fs-xs);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

      // notes editor: edit/preview tabs, a Markdown toolbar, and a dedicated
      // drag handle in addition to the browser's native vertical resize.
      '.dsh-td-notes-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.dsh-td-notes-tabs{display:inline-flex;flex:0 0 auto;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);overflow:hidden}',
      '.dsh-td-notes-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;',
      'font-size:var(--dsh-td-fs-xs);padding:2px 9px;line-height:18px;cursor:pointer}',
      '.dsh-td-notes-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-td-notes-tab-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dsh-td-notes-tools{display:flex;align-items:center;gap:4px;flex-wrap:wrap}',
      '.dsh-td-notes-tool{min-width:26px;font-family:var(--ds-font-family-code,monospace);font-size:var(--dsh-td-fs-xs);padding:1px 6px}',
      '.dsh-td-notes-textarea{font-size:var(--dsh-td-fs-sm);line-height:1.65;resize:none}',
      '.dsh-td-notes-preview{overflow:auto;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);',
      'border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);font-size:var(--dsh-td-fs-sm);line-height:1.65}',
      '.dsh-td-notes-empty{color:var(--dsw-alias-label-tertiary)}',
      '.dsh-td-notes-resizer{display:flex;align-items:center;justify-content:center;height:12px;cursor:ns-resize;touch-action:none;outline:none}',
      '.dsh-td-notes-resizer::before{content:"";width:34px;height:3px;border-radius:2px;background:var(--dsw-alias-border-l4)}',
      '.dsh-td-notes-resizer:hover::before,.dsh-td-notes-resizer:focus-visible::before,.dsh-td-notes-resizer-active::before{background:var(--dsw-alias-brand-primary)}',
      '.dsh-td-notes-resizer:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}',
      // rendered Markdown in the notes preview
      '.dsh-td-md>*:first-child{margin-top:0}',
      '.dsh-td-md>*:last-child{margin-bottom:0}',
      '.dsh-td-md p{margin:0 0 .55em}',
      '.dsh-td-md h1,.dsh-td-md h2,.dsh-td-md h3,.dsh-td-md h4,.dsh-td-md h5,.dsh-td-md h6{margin:.65em 0 .35em;font-weight:600;line-height:1.35}',
      '.dsh-td-md h1{font-size:1.4em}',
      '.dsh-td-md h2{font-size:1.24em}',
      '.dsh-td-md h3{font-size:1.1em}',
      '.dsh-td-md h4,.dsh-td-md h5,.dsh-td-md h6{font-size:1em}',
      '.dsh-td-md ul,.dsh-td-md ol{margin:.2em 0 .6em;padding-left:1.5em}',
      '.dsh-td-md li{margin:.1em 0}',
      '.dsh-td-md code{font-family:var(--ds-font-family-code,monospace);font-size:.92em;padding:1px 4px;border-radius:4px;',
      'background:var(--dsw-alias-markdown-inline-code);color:var(--dsw-alias-label-primary)}',
      '.dsh-td-md pre{margin:.3em 0 .7em;padding:8px 10px;border-radius:var(--dsw-radius-sm);overflow:auto;background:var(--dsw-alias-markdown-code-block)}',
      '.dsh-td-md pre code{padding:0;background:transparent;font-size:var(--dsh-td-fs-xs);line-height:1.55;white-space:pre}',
      '.dsh-td-md blockquote{margin:.3em 0 .7em;padding:2px 0 2px 10px;border-left:3px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary)}',
      '.dsh-td-md a{color:var(--dsw-alias-link);text-decoration:none}',
      '.dsh-td-md a:hover{text-decoration:underline}',
      '.dsh-td-md hr{margin:.85em 0;border:0;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dsh-td-md strong{font-weight:600}',
      '.dsh-td-md del{color:var(--dsw-alias-label-tertiary)}',
      '.dsh-td-fatal{padding:24px}',
      '.dsh-td-inline{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
      '.dsh-td-grow{flex:1 1 120px;min-width:80px}',
      '.dsh-td-meta{font-size:var(--dsh-td-fs-xxs);color:var(--dsw-alias-label-tertiary);line-height:1.6}',
      '.dsh-td-errorline{font-size:var(--dsh-td-fs-xxs);color:var(--dsw-alias-state-error-primary);line-height:1.6;word-break:break-word}',
      '.dsh-td-select{width:100%;font:inherit;font-size:var(--dsh-td-fs-sm);padding:4px 6px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);',
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);outline:none}',
      '.dsh-td-select:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dsh-td-cond{display:flex;flex-direction:column;gap:4px;padding:7px 8px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-td-cond-off{border-style:dashed}',
      '.dsh-td-cond-head{display:flex;align-items:center;gap:6px}',
      '.dsh-td-cond-title{flex:1 1 auto;min-width:0;font-size:var(--dsh-td-fs-sm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-td-cond-links{display:flex;flex-direction:column;gap:2px;padding-left:12px}',
      '.dsh-td-cond-link{display:flex;align-items:center;gap:5px;font-size:var(--dsh-td-fs-xxs);color:var(--dsw-alias-label-secondary)}',
      '.dsh-td-link-layer{position:absolute;inset:0;z-index:5;display:flex;align-items:center;justify-content:center;padding:20px;pointer-events:none}',
      '.dsh-td-link-card{pointer-events:auto;display:flex;flex-direction:column;gap:10px;width:min(460px,100%);max-height:calc(100% - 32px);',
      'padding:14px 16px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-td-link-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}',
      '.dsh-td-link-title{font-size:var(--dsh-td-fs);font-weight:600}',
      '.dsh-td-link-sub{font-size:var(--dsh-td-fs-xs);line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-td-link-list{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto;padding:4px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base)}',
      '.dsh-td-option{display:flex;flex-direction:column;gap:2px;width:100%;padding:6px 8px;text-align:left;font:inherit;font-size:var(--dsh-td-fs-sm);cursor:pointer;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.dsh-td-option:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-td-option-on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-td-option-main{display:flex;align-items:center;gap:6px;min-width:0}',
      '.dsh-td-option-meta{font-size:var(--dsh-td-fs-xxs);line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-td-link-foot{display:flex;align-items:center;justify-content:flex-end;gap:6px}',
      '.dsh-td-presets{display:flex;flex-wrap:wrap;gap:4px}',
      '.dsh-td-sched-line{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:var(--dsh-td-fs-xs);color:var(--dsw-alias-label-secondary)}',
      '.dsh-td-sched-value{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      // collapsible sections (execution settings, schedule, danger zone)
      '.dsh-td-collapse{display:flex;flex-direction:column;gap:6px}',
      '.dsh-td-collapse-head{display:flex;align-items:center;gap:6px;width:100%;padding:4px 2px;border:0;background:transparent;',
      'font:inherit;cursor:pointer;text-align:left;color:inherit;border-radius:var(--dsw-radius-sm)}',
      '.dsh-td-collapse-head:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-td-collapse-head:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.dsh-td-collapse-caret{flex:0 0 auto;width:14px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-td-fs-xs)}',
      '.dsh-td-collapse-head .dsh-td-section-title{flex:0 0 auto}',
      '.dsh-td-collapse-head .dsh-td-section-note{flex:1 1 auto;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-td-collapse-body{display:flex;flex-direction:column;gap:8px;padding:0 0 2px 20px}',
      // model + reasoning-effort combobox
      '.dsh-td-model-picker{position:relative;display:flex;flex-direction:column;width:100%}',
      '.dsh-td-model-trigger{display:flex;align-items:center;gap:6px;width:100%;min-height:30px;padding:4px 8px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);',
      'color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--dsh-td-fs-sm);text-align:left;cursor:pointer}',
      '.dsh-td-model-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}',
      '.dsh-td-model-trigger:disabled{opacity:.5;cursor:default}',
      '.dsh-td-model-trigger-main{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-td-model-effort-chip{flex:0 0 auto;padding:0 6px;border-radius:999px;font-size:var(--dsh-td-fs-xxs);line-height:16px;',
      'background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}',
      '.dsh-td-model-chevron{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-td-fs-xxs)}',
      '.dsh-td-model-pop{position:absolute;left:0;right:0;bottom:calc(100% + 4px);z-index:40;display:flex;flex-direction:column;',
      'max-height:320px;overflow:auto;padding:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);',
      'background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv3)}',
      '.dsh-td-model-pane{display:flex;flex-direction:column;gap:2px}',
      '.dsh-td-model-pop-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 4px 6px}',
      '.dsh-td-model-pop-title{flex:1 1 auto;min-width:0;font-size:var(--dsh-td-fs-sm);font-weight:600;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-td-model-group{display:flex;flex-direction:column;gap:2px;padding-top:2px}',
      '.dsh-td-model-group-label{padding:4px 6px 2px;font-size:var(--dsh-td-fs-xxs);letter-spacing:.04em;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-td-model-option{display:flex;flex-direction:column;gap:1px;width:100%;padding:5px 7px;border:0;border-radius:var(--dsw-radius-sm);',
      'background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--dsh-td-fs-sm);text-align:left;cursor:pointer}',
      '.dsh-td-model-option:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-td-model-option-on{background:var(--dsw-alias-bg-layer-3);box-shadow:inset 0 0 0 .5px var(--dsw-alias-brand-primary)}',
      '.dsh-td-model-option:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}',
      '.dsh-td-model-option-main{display:flex;align-items:center;gap:6px;min-width:0}',
      '.dsh-td-model-option-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-td-model-check{flex:0 0 auto;color:var(--dsw-alias-state-success-primary);font-size:var(--dsh-td-fs-xs)}',
      '.dsh-td-model-option-meta{font-size:var(--dsh-td-fs-xxs);color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '@media (max-width:1080px){.dsh-td-splitter{flex-basis:5px}}',
    ].join('')

    function injectStyles() {
      try {
        if (typeof document === 'undefined' || document === null) return
        const selector = 'style[data-plugin-css="' + STYLE_TAG + '"]'
        if (document.querySelector(selector) !== null) return
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-task-dag'
        tag.dataset.pluginCss = STYLE_TAG
        tag.textContent = CSS
        const target = document.head || document.documentElement
        if (target !== null && target !== undefined) target.appendChild(tag)
      } catch (error) {
        console.error('[dsh-task-dag] style injection failed', error)
      }
    }

    // =======================================================================
    // 3. Local storage — the `main` slot unmounts on navigation, so the panel
    //    state must survive a remount.
    // =======================================================================
    function readPersisted() {
      try {
        if (typeof window === 'undefined' || window.localStorage === undefined) return {}
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (typeof raw !== 'string' || raw === '') return {}
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
        return parsed
      } catch (error) {
        console.error('[dsh-task-dag] cannot read local state', error)
        return {}
      }
    }

    function writePersisted(patch) {
      try {
        if (typeof window === 'undefined' || window.localStorage === undefined) return
        const next = Object.assign({}, readPersisted(), patch)
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch (error) {
        console.error('[dsh-task-dag] cannot write local state', error)
      }
    }

    function readViewport(persisted) {
      const viewport = persisted !== null && typeof persisted === 'object' ? persisted.viewport : null
      if (viewport === null || typeof viewport !== 'object') return null
      const x = Number(viewport.x)
      const y = Number(viewport.y)
      const scale = Number(viewport.scale)
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return null
      return { x, y, scale: clamp(scale, MIN_SCALE, MAX_SCALE) }
    }

    function readWidth(value, fallback, low, high) {
      const number = Number(value)
      if (!Number.isFinite(number)) return fallback
      return clamp(Math.round(number), low, high)
    }

    function readColumnWidths(persisted) {
      const widths = persisted !== null && typeof persisted === 'object' ? persisted.columnWidths : null
      const source = widths !== null && typeof widths === 'object' ? widths : {}
      return {
        left: readWidth(source.left, DEFAULT_LEFT_WIDTH, MIN_LEFT_WIDTH, MAX_LEFT_WIDTH),
        right: readWidth(source.right, DEFAULT_RIGHT_WIDTH, MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH),
      }
    }

    function readNotesHeight(persisted) {
      const value = persisted !== null && typeof persisted === 'object' ? persisted.notesHeight : null
      return readWidth(value, DEFAULT_NOTES_HEIGHT, MIN_NOTES_HEIGHT, MAX_NOTES_HEIGHT)
    }

    /** `free` lets nodes sit anywhere; `grid` snaps every node centre. */
    function readLayoutMode(persisted) {
      return persisted !== null && typeof persisted === 'object' && persisted.layoutMode === 'grid'
        ? 'grid'
        : 'free'
    }

    // =======================================================================
    // 4. Pure helpers
    // =======================================================================
    function clamp(value, low, high) {
      if (!Number.isFinite(value)) return low
      if (value < low) return low
      if (value > high) return high
      return value
    }

    function errText(error) {
      if (error === null || error === undefined) return '未知错误'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message !== '') return error.message
      return String(error)
    }

    function toCount(value) {
      const number = Number(value)
      return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
    }

    function newRequestId() {
      return 'rq_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10)
    }

    function statusLabel(status) {
      return STATUS_LABELS[status] === undefined ? '未知状态' : STATUS_LABELS[status]
    }

    function modeLabel(mode) {
      return HANDOFF_LABELS[mode] === undefined ? '' : HANDOFF_LABELS[mode]
    }

    function circled(slot) {
      const index = Math.floor(Number(slot)) - 1
      if (!Number.isFinite(index) || index < 0 || index >= CIRCLED.length) return '(' + String(slot) + ')'
      return CIRCLED.charAt(index)
    }

    function formatTime(value) {
      if (typeof value !== 'string' || value === '') return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (number) => (number < 10 ? '0' + String(number) : String(number))
      return String(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    function shortSessionId(sessionId) {
      const text = String(sessionId === undefined || sessionId === null ? '' : sessionId)
      if (text === '') return '未知会话'
      return text.length <= 14 ? text : '…' + text.slice(text.length - 12)
    }

    function normalizePathForCompare(value) {
      if (typeof value !== 'string' || value === '') return ''
      return value.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
    }

    function samePath(left, right) {
      return normalizePathForCompare(left) === normalizePathForCompare(right)
    }

    // -- node title fitting --------------------------------------------------
    // The card is 208px wide with 16px padding on each side, so a title line
    // has ~176px. CJK glyphs are ~1em wide and Latin glyphs ~0.55em, so a fixed
    // character count is wrong for mixed titles: it lets wide CJK strings over-
    // flow the border and wastes space on Latin ones. Widths are measured in em
    // units (relative to the inherited font size) and the drawing side clips
    // whatever still does not fit.
    const TITLE_LINE_EM = 12.4

    function glyphWidthEm(char) {
      const code = char.codePointAt(0)
      if (code === undefined) return 0
      if (code < 32) return 0
      // Combining marks and zero-width joiners do not advance the pen.
      if ((code >= 0x0300 && code <= 0x036f) || code === 0x200b || code === 0x200d
        || (code >= 0xfe00 && code <= 0xfe0f)) return 0
      const wide = code >= 0x1100 && (
        code <= 0x115f
        || code === 0x2329 || code === 0x232a
        || code === 0x303f
        || (code >= 0x2e80 && code <= 0xa4cf)
        || (code >= 0xac00 && code <= 0xd7a3)
        || (code >= 0xf900 && code <= 0xfaff)
        || (code >= 0xfe10 && code <= 0xfe19)
        || (code >= 0xfe30 && code <= 0xfe6f)
        || (code >= 0xff00 && code <= 0xff60)
        || (code >= 0xffe0 && code <= 0xffe6)
        || (code >= 0x1f300 && code <= 0x1faff)
        || (code >= 0x20000 && code <= 0x3fffd)
      )
      return wide ? 1 : 0.55
    }

    function textWidthEm(chars) {
      let width = 0
      for (const char of chars) width += glyphWidthEm(char)
      return width
    }

    /** Split `chars` into the longest prefix that fits `limit` em units. */
    function takeFitting(chars, limit) {
      const taken = []
      let width = 0
      for (const char of chars) {
        const next = width + glyphWidthEm(char)
        if (next > limit) break
        taken.push(char)
        width = next
      }
      return { taken, rest: chars.slice(taken.length), width }
    }

    function titleLines(title) {
      const raw = title === undefined || title === null ? '' : String(title)
      const text = raw.replace(/\s+/g, ' ').trim() || '未命名任务'
      const chars = Array.from(text)
      if (textWidthEm(chars) <= TITLE_LINE_EM) return [chars.join('')]
      const first = takeFitting(chars, TITLE_LINE_EM)
      if (first.rest.length === 0) return [first.taken.join('')]
      // Reserve the ellipsis width on the last line so it does not stick out.
      const second = takeFitting(first.rest, TITLE_LINE_EM - glyphWidthEm('…'))
      const secondText = second.rest.length === 0
        ? second.taken.join('')
        : second.taken.join('') + '…'
      return [first.taken.join(''), secondText]
    }

    /** A safe, unique-enough fragment for an SVG `id`. */
    function idFragment(value) {
      return String(value === undefined || value === null ? '' : value).replace(/[^a-zA-Z0-9_-]/g, '_')
    }

    function round1(value) {
      return Math.round(value * 10) / 10
    }

    /**
     * Token counts the way the DSH composer's context meter shows them:
     * exact below 1K, one decimal (or integer at >=100) with K, then M.
     */
    function formatTokenCount(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return ''
      const scaled = (candidate) => (candidate >= 100
        ? String(Math.round(candidate))
        : String(Math.round(candidate * 10) / 10))
      if (number < 1000) return String(Math.round(number))
      if (number < 1e6) return scaled(number / 1e3) + 'K'
      return scaled(number / 1e6) + 'M'
    }

    // -- Markdown notes preview ----------------------------------------------
    // A deliberately small CommonMark subset rendered to React elements. Notes
    // are user text, so building nodes (never `dangerouslySetInnerHTML`) is both
    // the safe and the simplest option. Unsupported syntax degrades to plain
    // text instead of disappearing.
    const MD_INLINE = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|~~[^~]+~~|\[[^\]]+\]\([^)]+\))/

    function safeLinkTarget(raw) {
      const url = String(raw === undefined || raw === null ? '' : raw).trim()
      if (url === '') return null
      return /^(https?:\/\/|mailto:)/i.test(url) ? url : null
    }

    function renderInlineMarkdown(text, keyPrefix) {
      const source = typeof text === 'string' ? text : ''
      const nodes = []
      let rest = source
      let index = 0
      while (rest !== '') {
        const match = MD_INLINE.exec(rest)
        if (match === null) {
          nodes.push(rest)
          break
        }
        if (match.index > 0) nodes.push(rest.slice(0, match.index))
        const token = match[0]
        const key = keyPrefix + '-' + String(index)
        index += 1
        if (token.charAt(0) === '`') {
          nodes.push(h('code', { key }, token.slice(1, -1)))
        } else if (token.slice(0, 2) === '**' || token.slice(0, 2) === '__') {
          nodes.push(h('strong', { key }, renderInlineMarkdown(token.slice(2, -2), key)))
        } else if (token.slice(0, 2) === '~~') {
          nodes.push(h('del', { key }, renderInlineMarkdown(token.slice(2, -2), key)))
        } else if (token.charAt(0) === '*' || token.charAt(0) === '_') {
          nodes.push(h('em', { key }, renderInlineMarkdown(token.slice(1, -1), key)))
        } else {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
          const target = link !== null ? safeLinkTarget(link[2]) : null
          if (link !== null && target !== null) {
            nodes.push(h('a', { key, href: target, target: '_blank', rel: 'noopener noreferrer' },
              renderInlineMarkdown(link[1], key + '-a')))
          } else {
            nodes.push(link !== null ? link[1] : token)
          }
        }
        rest = rest.slice(match.index + token.length)
      }
      return nodes
    }

    function mdStartsBlock(line) {
      return /^\s*```/.test(line)
        || /^\s{0,3}#{1,6}\s+/.test(line)
        || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)
        || /^\s*>/.test(line)
        || /^\s*[-*+]\s+/.test(line)
        || /^\s*\d+[.)]\s+/.test(line)
    }

    function renderMarkdown(text) {
      const source = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : ''
      if (source.trim() === '') return []
      const lines = source.split('\n')
      const blocks = []
      let cursor = 0
      let seq = 0
      const nextKey = (prefix) => {
        seq += 1
        return 'md-' + prefix + '-' + String(seq)
      }

      while (cursor < lines.length) {
        const line = lines[cursor]
        if (/^\s*$/.test(line)) {
          cursor += 1
          continue
        }

        const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line)
        if (fence !== null) {
          const body = []
          cursor += 1
          while (cursor < lines.length && !/^\s*```\s*$/.test(lines[cursor])) {
            body.push(lines[cursor])
            cursor += 1
          }
          if (cursor < lines.length) cursor += 1
          const codeKey = nextKey('code')
          blocks.push(h('pre', { key: codeKey },
            h('code', {
              className: fence[1] === '' ? undefined : 'language-' + fence[1],
            }, body.join('\n'))))
          continue
        }

        const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
          const level = heading[1].length
          const headingKey = nextKey('h')
          blocks.push(h('h' + String(level), { key: headingKey },
            renderInlineMarkdown(heading[2].trim(), headingKey)))
          cursor += 1
          continue
        }

        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
          blocks.push(h('hr', { key: nextKey('hr') }))
          cursor += 1
          continue
        }

        if (/^\s*>/.test(line)) {
          const quote = []
          while (cursor < lines.length && /^\s*>/.test(lines[cursor])) {
            quote.push(lines[cursor].replace(/^\s*>\s?/, ''))
            cursor += 1
          }
          blocks.push(h('blockquote', { key: nextKey('quote') },
            renderMarkdown(quote.join('\n'))))
          continue
        }

        const unordered = /^\s*[-*+]\s+(.*)$/.exec(line)
        if (unordered !== null) {
          const items = []
          while (cursor < lines.length) {
            const item = /^\s*[-*+]\s+(.*)$/.exec(lines[cursor])
            if (item === null) break
            const itemKey = nextKey('li')
            items.push(h('li', { key: itemKey }, renderInlineMarkdown(item[1], itemKey)))
            cursor += 1
          }
          blocks.push(h('ul', { key: nextKey('ul') }, items))
          continue
        }

        if (/^\s*\d+[.)]\s+/.test(line)) {
          const items = []
          while (cursor < lines.length) {
            const item = /^\s*\d+[.)]\s+(.*)$/.exec(lines[cursor])
            if (item === null) break
            const itemKey = nextKey('li')
            items.push(h('li', { key: itemKey }, renderInlineMarkdown(item[1], itemKey)))
            cursor += 1
          }
          blocks.push(h('ol', { key: nextKey('ol') }, items))
          continue
        }

        const paragraph = []
        while (cursor < lines.length) {
          const text = lines[cursor]
          if (text.trim() === '' || mdStartsBlock(text)) break
          paragraph.push(text)
          cursor += 1
        }
        if (paragraph.length === 0) {
          paragraph.push(line)
          cursor += 1
        }
        const paragraphKey = nextKey('p')
        const children = []
        for (let index = 0; index < paragraph.length; index += 1) {
          if (index > 0) children.push(h('br', { key: paragraphKey + '-br-' + String(index) }))
          const inline = renderInlineMarkdown(paragraph[index], paragraphKey + '-l' + String(index))
          for (const node of inline) children.push(node)
        }
        blocks.push(h('p', { key: paragraphKey }, children))
      }
      return blocks
    }

    // =======================================================================
    // 5. HTTP transport — same-origin fetch, contract error envelope.
    // =======================================================================
    async function requestJson(method, url, body) {
      const init = {
        method,
        credentials: 'same-origin',
        headers: { accept: 'application/json', 'x-dsh-task-dag-client': '1' },
      }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      let response
      try {
        response = await fetch(url, init)
      } catch (error) {
        return { ok: false, code: 'network-error', message: '无法连接 Host 接口：' + errText(error) }
      }
      let data = null
      try {
        const text = await response.text()
        data = text === '' ? null : JSON.parse(text)
      } catch (error) {
        data = null
      }
      if (data !== null && typeof data === 'object' && typeof data.ok === 'boolean') {
        if (data.ok === true) return { ok: true, data }
        return {
          ok: false,
          code: typeof data.code === 'string' ? data.code : 'unknown',
          message: typeof data.message === 'string' && data.message !== ''
            ? data.message
            : '操作失败（' + String(data.code) + '）',
        }
      }
      if (response.ok !== true) {
        return {
          ok: false,
          code: 'http-' + String(response.status),
          message: 'Host 返回 ' + String(response.status) + '：' + (response.statusText || '请求失败'),
        }
      }
      return { ok: false, code: 'invalid-response', message: 'Host 返回了无法识别的内容' }
    }

    // =======================================================================
    // 6. Graph model — everything the UI needs, derived from one snapshot.
    // =======================================================================
    function computeLevels(nodes, edges) {
      const level = new Map()
      const outgoing = new Map()
      const indegree = new Map()
      for (const node of nodes) {
        outgoing.set(node.id, [])
        indegree.set(node.id, 0)
      }
      for (const edge of edges) {
        const list = outgoing.get(edge.from)
        if (list === undefined) continue
        list.push(edge.to)
        indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1)
      }
      const queue = []
      for (const node of nodes) {
        if ((indegree.get(node.id) || 0) === 0) {
          level.set(node.id, 0)
          queue.push(node.id)
        }
      }
      let head = 0
      while (head < queue.length) {
        const id = queue[head]
        head += 1
        const base = level.get(id) || 0
        const targets = outgoing.get(id) || []
        for (const target of targets) {
          const candidate = base + 1
          if (!level.has(target) || (level.get(target) || 0) < candidate) level.set(target, candidate)
          const remaining = (indegree.get(target) || 0) - 1
          indegree.set(target, remaining)
          if (remaining === 0) queue.push(target)
        }
      }
      let maxLevel = 0
      level.forEach((value) => {
        if (value > maxLevel) maxLevel = value
      })
      for (const node of nodes) {
        // A cycle would leave nodes unvisited; the Host rejects cycles, but a
        // corrupted document must still render somewhere instead of vanishing.
        if (!level.has(node.id)) level.set(node.id, maxLevel + 1)
      }
      return level
    }

    /* -------------------------------------------------------------------- */
    /* automatic layout                                                       */
    /*                                                                        */
    /* Components are laid out independently and stacked, so disconnected     */
    /* subgraphs never share columns or overlap. Inside a component, layered  */
    /* barycenter ordering plus adjacent-swap hill climbing removes most      */
    /* avoidable edge crossings; layers are vertically centred to keep edges  */
    /* short.                                                                 */
    /* -------------------------------------------------------------------- */

    function layoutComponents(nodes, edges) {
      const ids = nodes.map((node) => node.id)
      const idSet = new Set(ids)
      const adjacency = new Map(ids.map((id) => [id, []]))
      const validEdges = []
      for (const edge of edges) {
        if (edge === null || typeof edge !== 'object') continue
        if (!idSet.has(edge.from) || !idSet.has(edge.to) || edge.from === edge.to) continue
        adjacency.get(edge.from).push(edge.to)
        adjacency.get(edge.to).push(edge.from)
        validEdges.push(edge)
      }
      const seen = new Set()
      const components = []
      for (const id of ids) {
        if (seen.has(id)) continue
        const stack = [id]
        seen.add(id)
        const component = []
        while (stack.length > 0) {
          const current = stack.pop()
          component.push(current)
          for (const next of adjacency.get(current) || []) {
            if (seen.has(next)) continue
            seen.add(next)
            stack.push(next)
          }
        }
        components.push(component)
      }
      return { components, validEdges }
    }

    function sortLayerByBarycenter(ids, neighbors, neighborRows, indexOf) {
      return ids
        .map((id, index) => {
          const rows = (neighbors.get(id) || [])
            .map((neighbor) => neighborRows.get(neighbor))
            .filter((row) => Number.isFinite(row))
          const barycenter = rows.length > 0
            ? rows.reduce((sum, row) => sum + row, 0) / rows.length
            : index
          return { id, barycenter, index }
        })
        .sort((left, right) => (left.barycenter - right.barycenter)
          || (left.index - right.index)
          || ((indexOf.get(left.id) || 0) - (indexOf.get(right.id) || 0)))
        .map((entry) => entry.id)
    }

    function linesCross(a, b, c, d) {
      const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
      const o1 = cross(a, b, c)
      const o2 = cross(a, b, d)
      const o3 = cross(c, d, a)
      const o4 = cross(c, d, b)
      return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0))
        && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))
    }

    function countLayerCrossings(layers, nodeLevelIndex, edges, componentSet) {
      const rows = new Map()
      for (const ids of layers) {
        ids.forEach((id, row) => rows.set(id, row))
      }
      const points = new Map()
      for (const id of rows.keys()) {
        const level = nodeLevelIndex.get(id)
        if (level === undefined) continue
        points.set(id, { x: level * AUTO_DX, y: rows.get(id) * AUTO_DY })
      }
      const inComponent = []
      for (const edge of edges) {
        if (!componentSet.has(edge.from) || !componentSet.has(edge.to)) continue
        if (!points.has(edge.from) || !points.has(edge.to)) continue
        inComponent.push(edge)
      }
      let crossings = 0
      for (let i = 0; i < inComponent.length; i += 1) {
        for (let j = i + 1; j < inComponent.length; j += 1) {
          const first = inComponent[i]
          const second = inComponent[j]
          if (first.from === second.from || first.to === second.to
            || first.from === second.to || first.to === second.from) continue
          if (linesCross(points.get(first.from), points.get(first.to),
            points.get(second.from), points.get(second.to))) crossings += 1
        }
      }
      return crossings
    }

    function improveLayerOrder(layers, nodeLevelIndex, edges, componentSet) {
      if (edges.length > 240 || layers.length < 2) return
      let best = countLayerCrossings(layers, nodeLevelIndex, edges, componentSet)
      for (let pass = 0; pass < 4 && best > 0; pass += 1) {
        let improved = false
        for (const ids of layers) {
          for (let index = 0; index + 1 < ids.length; index += 1) {
            const first = ids[index]
            ids[index] = ids[index + 1]
            ids[index + 1] = first
            const crossings = countLayerCrossings(layers, nodeLevelIndex, edges, componentSet)
            if (crossings < best) {
              best = crossings
              improved = true
            } else {
              ids[index + 1] = ids[index]
              ids[index] = first
            }
          }
        }
        if (!improved) break
      }
    }

    function orderComponentLayers(componentIds, levels, edges, indexOf) {
      const componentSet = new Set(componentIds)
      const byLevel = new Map()
      for (const id of componentIds) {
        const level = levels.get(id) || 0
        if (!byLevel.has(level)) byLevel.set(level, [])
        byLevel.get(level).push(id)
      }
      const levelKeys = [...byLevel.keys()].sort((left, right) => left - right)
      const layers = levelKeys.map((level) => byLevel.get(level)
        .slice()
        .sort((left, right) => (indexOf.get(left) || 0) - (indexOf.get(right) || 0)))
      const nodeLevelIndex = new Map()
      layers.forEach((ids, levelIndex) => {
        for (const id of ids) nodeLevelIndex.set(id, levelIndex)
      })

      const incoming = new Map(componentIds.map((id) => [id, []]))
      const outgoing = new Map(componentIds.map((id) => [id, []]))
      const inComponent = []
      for (const edge of edges) {
        if (!componentSet.has(edge.from) || !componentSet.has(edge.to)) continue
        incoming.get(edge.to).push(edge.from)
        outgoing.get(edge.from).push(edge.to)
        inComponent.push(edge)
      }

      const rowMapOf = (levelIndex) => {
        const map = new Map()
        layers[levelIndex].forEach((id, row) => map.set(id, row))
        return map
      }
      for (let pass = 0; pass < 6; pass += 1) {
        if (pass % 2 === 0) {
          for (let levelIndex = 1; levelIndex < layers.length; levelIndex += 1) {
            layers[levelIndex] = sortLayerByBarycenter(
              layers[levelIndex], incoming, rowMapOf(levelIndex - 1), indexOf,
            )
          }
        } else {
          for (let levelIndex = layers.length - 2; levelIndex >= 0; levelIndex -= 1) {
            layers[levelIndex] = sortLayerByBarycenter(
              layers[levelIndex], outgoing, rowMapOf(levelIndex + 1), indexOf,
            )
          }
        }
      }
      improveLayerOrder(layers, nodeLevelIndex, inComponent, componentSet)
      return { layers, nodeLevelIndex }
    }

    /** Deterministic auto-layout used whenever a node has no manual position. */
    function autoGraphPositions(nodes, edges, knownLevels) {
      const positions = {}
      if (nodes.length === 0) return positions
      const levels = knownLevels !== undefined ? knownLevels : computeLevels(nodes, edges)
      const indexOf = new Map(nodes.map((node, index) => [node.id, index]))
      const { components, validEdges } = layoutComponents(nodes, edges)
      const connected = []
      const isolated = []
      for (const component of components) {
        if (component.length === 1) isolated.push(component[0])
        else connected.push(component)
      }
      connected.sort((left, right) => Math.min(...left.map((id) => indexOf.get(id) || 0))
        - Math.min(...right.map((id) => indexOf.get(id) || 0)))

      let cursorY = AUTO_Y0
      for (const component of connected) {
        const { layers } = orderComponentLayers(component, levels, validEdges, indexOf)
        const maxRows = Math.max(...layers.map((ids) => ids.length))
        const height = (maxRows - 1) * AUTO_DY + NODE_H
        layers.forEach((ids, levelIndex) => {
          const offset = Math.floor((maxRows - ids.length) / 2)
          ids.forEach((id, row) => {
            positions[id] = {
              x: AUTO_X0 + levelIndex * AUTO_DX,
              y: cursorY + (offset + row) * AUTO_DY,
            }
          })
        })
        cursorY += height + AUTO_COMPONENT_GAP
      }

      if (isolated.length > 0) {
        const columns = Math.min(AUTO_ISOLATED_COLUMNS, isolated.length)
        isolated.forEach((id, index) => {
          const column = index % columns
          const row = Math.floor(index / columns)
          positions[id] = {
            x: AUTO_X0 + column * (NODE_W + 60),
            y: cursorY + row * (NODE_H + 40),
          }
        })
      }
      return positions
    }

    /* -------------------------------------------------------------------- */
    /* drag collision avoidance                                               */
    /*                                                                        */
    /* When a node is dropped on top of its peers, every other node is pushed */
    /* out along the axis with the smallest displacement, then the same check */
    /* is repeated against all already-settled nodes. Edges follow their      */
    /* endpoints, so they reroute automatically.                              */
    /* -------------------------------------------------------------------- */

    function rectsOverlap(ax, ay, bx, by, gap) {
      return ax < bx + NODE_W + gap && ax + NODE_W + gap > bx
        && ay < by + NODE_H + gap && ay + NODE_H + gap > by
    }

    function pushOutOf(x, y, obstacleX, obstacleY, gap) {
      const candidates = [
        { x: obstacleX - NODE_W - gap, y },
        { x: obstacleX + NODE_W + gap, y },
        { x, y: obstacleY - NODE_H - gap },
        { x, y: obstacleY + NODE_H + gap },
      ]
      let best = candidates[0]
      let bestDistance = Infinity
      for (const candidate of candidates) {
        const distance = Math.abs(candidate.x - x) + Math.abs(candidate.y - y)
        if (distance < bestDistance) {
          bestDistance = distance
          best = candidate
        }
      }
      return { x: Math.round(best.x), y: Math.round(best.y) }
    }

    function resolveNodeLayout(positions, nodeIds, draggedId, draggedPosition, gap = LAYOUT_PAD) {
      const result = Object.assign({}, positions)
      if (result[draggedId] === undefined) return { positions: result, moved: {} }
      result[draggedId] = {
        x: Math.round(Number(draggedPosition.x) || 0),
        y: Math.round(Number(draggedPosition.y) || 0),
      }
      const settled = [{ id: draggedId, x: result[draggedId].x, y: result[draggedId].y }]
      const moved = {}
      for (const id of nodeIds) {
        if (id === draggedId) continue
        const original = positions[id]
        if (original === undefined || original === null) continue
        let x = Math.round(original.x)
        let y = Math.round(original.y)
        for (let attempt = 0; attempt < 64; attempt += 1) {
          let obstacle = null
          for (const other of settled) {
            if (rectsOverlap(x, y, other.x, other.y, gap)) {
              obstacle = other
              break
            }
          }
          if (obstacle === null) break
          const pushed = pushOutOf(x, y, obstacle.x, obstacle.y, gap)
          x = pushed.x
          y = pushed.y
        }
        result[id] = { x, y }
        if (x !== Math.round(original.x) || y !== Math.round(original.y)) moved[id] = { x, y }
        settled.push({ id, x, y })
      }
      return { positions: result, moved }
    }

    /* -------------------------------------------------------------------- */
    /* golden-ratio grid mode                                                 */
    /* -------------------------------------------------------------------- */

    function gridCellKey(col, row) {
      return String(col) + ',' + String(row)
    }

    function gridCellOf(position) {
      const centerX = Number(position?.x ?? 0) + NODE_W / 2
      const centerY = Number(position?.y ?? 0) + NODE_H / 2
      return {
        col: Math.round((centerX - (GRID_X0 + GRID_W / 2)) / GRID_W),
        row: Math.round((centerY - (GRID_Y0 + GRID_H / 2)) / GRID_H),
      }
    }

    function gridPositionOfCell(col, row) {
      return {
        x: Math.round(GRID_X0 + col * GRID_W + GRID_W / 2 - NODE_W / 2),
        y: Math.round(GRID_Y0 + row * GRID_H + GRID_H / 2 - NODE_H / 2),
      }
    }

    /** Nearest unoccupied cell, searched ring by ring from the desired cell. */
    function nearestFreeGridCell(occupied, desiredCol, desiredRow) {
      if (!occupied.has(gridCellKey(desiredCol, desiredRow))) {
        return { col: desiredCol, row: desiredRow }
      }
      for (let radius = 1; radius <= 80; radius += 1) {
        let best = null
        let bestScore = Infinity
        for (let dRow = -radius; dRow <= radius; dRow += 1) {
          for (let dCol = -radius; dCol <= radius; dCol += 1) {
            if (Math.max(Math.abs(dCol), Math.abs(dRow)) !== radius) continue
            const col = desiredCol + dCol
            const row = desiredRow + dRow
            if (occupied.has(gridCellKey(col, row))) continue
            const score = dCol * dCol + dRow * dRow
            if (score < bestScore
              || (score === bestScore && best !== null && (row < best.row || (row === best.row && col < best.col)))) {
              bestScore = score
              best = { col, row }
            }
          }
        }
        if (best !== null) return best
      }
      return { col: desiredCol, row: desiredRow }
    }

    /** Snap every node to a distinct grid cell, preserving model order. */
    function gridAssignments(positions, nodes) {
      const occupied = new Set()
      const out = {}
      for (const node of nodes) {
        const position = positions[node.id]
        const desired = position === undefined || position === null
          ? { col: 0, row: 0 }
          : gridCellOf(position)
        const cell = nearestFreeGridCell(occupied, desired.col, desired.row)
        occupied.add(gridCellKey(cell.col, cell.row))
        out[node.id] = gridPositionOfCell(cell.col, cell.row)
      }
      return out
    }

    /** Where the dragged node lands; every other node keeps its displayed cell. */
    function snapDraggedNodeToGrid(positions, nodes, draggedId, desiredPosition) {
      const occupied = new Set()
      const assigned = gridAssignments(positions, nodes)
      for (const node of nodes) {
        if (node.id === draggedId) continue
        const position = assigned[node.id]
        if (position === undefined) continue
        const cell = gridCellOf(position)
        occupied.add(gridCellKey(cell.col, cell.row))
      }
      const desired = gridCellOf(desiredPosition)
      const cell = nearestFreeGridCell(occupied, desired.col, desired.row)
      return gridPositionOfCell(cell.col, cell.row)
    }

    /** First free cell for a brand-new node, nearest to the desired position. */
    function snapNewNodeToGrid(positions, nodes, desiredPosition) {
      const assigned = gridAssignments(positions, nodes)
      const occupied = new Set()
      for (const node of nodes) {
        const position = assigned[node.id]
        if (position === undefined) continue
        const cell = gridCellOf(position)
        occupied.add(gridCellKey(cell.col, cell.row))
      }
      const desired = gridCellOf(desiredPosition)
      const cell = nearestFreeGridCell(occupied, desired.col, desired.row)
      return gridPositionOfCell(cell.col, cell.row)
    }

    // v2 prerequisite conditions are always re-derived on the client from
    // nodes + edges: the Host ships `derived`, but an old v1 snapshot (edges
    // without conditionId) or a partially filled snapshot must still render.
    function normalizeNodeConditions(node) {
      const out = []
      const raw = Array.isArray(node.conditions) ? node.conditions : []
      for (const item of raw) {
        if (item === null || typeof item !== 'object') continue
        const title = typeof item.title === 'string' && item.title.trim() !== ''
          ? item.title.trim()
          : '前置条件'
        const id = typeof item.id === 'string' && item.id !== '' ? item.id : 'c_local_' + String(out.length)
        out.push({ id, title })
      }
      return out
    }

    function computeConditions(nodes, edges, nodeById) {
      const lists = {}
      for (const node of nodes) lists[node.id] = normalizeNodeConditions(node)
      for (const edge of edges) {
        const list = lists[edge.to]
        if (list === undefined) continue
        let condition = null
        if (typeof edge.conditionId === 'string' && edge.conditionId !== '') {
          for (const candidate of list) {
            if (candidate.id === edge.conditionId) {
              condition = candidate
              break
            }
          }
        }
        if (condition === null) {
          // v1 edge (or an unknown conditionId): rebuild a condition so the
          // dependency stays visible; the Host repairs the document on write.
          const fromNode = nodeById[edge.from]
          const title = (fromNode !== undefined ? fromNode.title : edge.from) + ' 完成'
          condition = { id: 'legacy_' + edge.id, title, legacy: true }
          list.push(condition)
        }
        if (!Array.isArray(condition.links)) condition.links = []
        condition.links.push(edge)
        // Remember the resolved condition on the edge (local model only) so the
        // detail pane can group incoming edges and unlink them per condition.
        edge.conditionId = condition.id
      }
      const conditions = {}
      for (const node of nodes) {
        conditions[node.id] = lists[node.id].map((condition) => {
          const links = Array.isArray(condition.links) ? condition.links : []
          const linked = links.map((edge) => {
            const fromNode = nodeById[edge.from]
            return {
              edgeId: edge.id,
              id: edge.from,
              title: fromNode !== undefined ? fromNode.title : edge.from,
              status: fromNode !== undefined ? fromNode.status : 'todo',
            }
          })
          return {
            id: condition.id,
            title: condition.title,
            legacy: condition.legacy === true,
            satisfied: linked.some((link) => link.status === 'done'),
            linked,
          }
        })
      }
      return conditions
    }

    function conditionTitleOf(model, edge) {
      const list = model.conditions !== undefined && model.conditions[edge.to] !== undefined
        ? model.conditions[edge.to]
        : []
      for (const condition of list) {
        if (condition.id === edge.conditionId) return condition.title
      }
      return ''
    }

    function milestoneNodeIdOf(graph) {
      if (typeof graph.milestoneNodeId === 'string' && graph.milestoneNodeId !== '') return graph.milestoneNodeId
      // v1 documents named the same field closeoutNodeId; render them anyway.
      if (typeof graph.closeoutNodeId === 'string' && graph.closeoutNodeId !== '') return graph.closeoutNodeId
      return null
    }

    function normalizeSessionFacts(raw) {
      const byId = {}
      const archived = []
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        if (raw.byId !== null && typeof raw.byId === 'object' && !Array.isArray(raw.byId)) {
          Object.assign(byId, raw.byId)
        } else if (raw.archived === undefined && raw.warnings === undefined) {
          // Tolerate a bare `{[sessionId]: Fact}` map.
          Object.assign(byId, raw)
        }
        if (Array.isArray(raw.archived)) {
          for (const id of raw.archived) if (typeof id === 'string' && id !== '') archived.push(id)
        }
      }
      return { byId, archived }
    }

    // GET /api/task-dag/catalog -> {presets, models, warnings}; tolerate the
    // endpoint being unavailable or returning partial/other shapes.
    function normalizeCatalogReasoning(raw) {
      if (raw === null || typeof raw !== 'object') return null
      const efforts = []
      for (const effort of Array.isArray(raw.efforts) ? raw.efforts : []) {
        if (effort === null || typeof effort !== 'object') continue
        const id = typeof effort.id === 'string' && effort.id !== '' ? effort.id : ''
        if (id === '') continue
        efforts.push({
          id,
          name: typeof effort.name === 'string' && effort.name !== '' ? effort.name : id,
          description: typeof effort.description === 'string' ? effort.description : '',
        })
      }
      const defaultEffort = typeof raw.defaultEffort === 'string' && raw.defaultEffort !== ''
        ? raw.defaultEffort
        : null
      if (efforts.length === 0 && defaultEffort === null) return null
      return { efforts, defaultEffort }
    }

    function normalizeCatalog(raw) {
      const out = { presets: [], models: [], warnings: [] }
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      const presets = Array.isArray(source.presets) ? source.presets : []
      for (const preset of presets) {
        if (typeof preset === 'string' && preset !== '') {
          out.presets.push({ id: preset, label: preset, broken: false })
          continue
        }
        if (preset === null || typeof preset !== 'object') continue
        const id = typeof preset.id === 'string' ? preset.id : ''
        if (id === '') continue
        out.presets.push({
          id,
          label: typeof preset.label === 'string' ? preset.label : '',
          broken: preset.broken === true,
        })
      }
      const models = Array.isArray(source.models) ? source.models : []
      for (const item of models) {
        if (typeof item === 'string' && item !== '') {
          out.models.push({ provider: '', id: item, label: item, reasoning: null })
          continue
        }
        if (item === null || typeof item !== 'object') continue
        const id = typeof item.id === 'string' ? item.id : ''
        if (id === '') continue
        out.models.push({
          provider: typeof item.provider === 'string' ? item.provider : '',
          providerLabel: typeof item.providerLabel === 'string' && item.providerLabel !== ''
            ? item.providerLabel
            : (typeof item.provider === 'string' ? item.provider : ''),
          id,
          label: typeof item.label === 'string' && item.label !== '' ? item.label : id,
          reasoning: normalizeCatalogReasoning(item.reasoning),
        })
      }
      if (Array.isArray(source.warnings)) {
        for (const warning of source.warnings) {
          if (typeof warning === 'string' && warning !== '') out.warnings.push(warning)
        }
      }
      return out
    }

    /**
     * Last-resort catalog source: the same `remote.session.modelCatalog()` the
     * DSH composer's own model selector uses. It is only consulted when the
     * plugin's `/catalog` route comes back without any model (for example a
     * Host whose session gateway is unavailable), so the picker never degrades
     * to just "默认（跟随宿主）" while the GUI itself can still list models.
     */
    async function loadRemoteModelCatalog(ctx) {
      try {
        if (ctx === null || typeof ctx !== 'object') return null
        const remote = typeof ctx.get === 'function' ? ctx.get('remote') : null
        const session = remote !== null && typeof remote === 'object' ? remote.session : null
        if (session === null || typeof session !== 'object' || typeof session.modelCatalog !== 'function') return null
        const response = await session.modelCatalog()
        const value = response !== null && typeof response === 'object' ? response.value : null
        const groups = value !== null && typeof value === 'object' && Array.isArray(value.groups) ? value.groups : []
        const models = []
        for (const group of groups) {
          if (group === null || typeof group !== 'object') continue
          const provider = typeof group.id === 'string' ? group.id : ''
          const providerLabel = typeof group.name === 'string' && group.name !== '' ? group.name : provider
          for (const model of Array.isArray(group.models) ? group.models : []) {
            if (model === null || typeof model !== 'object') continue
            const id = typeof model.id === 'string' ? model.id : ''
            if (id === '') continue
            models.push({
              provider,
              providerLabel,
              id,
              label: typeof model.name === 'string' && model.name !== '' ? model.name : id,
              reasoning: normalizeCatalogReasoning(model.reasoning),
            })
          }
        }
        return models.length > 0 ? models : null
      } catch (error) {
        console.error('[dsh-task-dag] cannot read the client model catalog', error)
        return null
      }
    }

    function normalizeWorkspaces(rawList) {      const out = []
      if (!Array.isArray(rawList)) return out
      for (const raw of rawList) {
        if (raw === null || typeof raw !== 'object') continue
        const workspaceId = typeof raw.workspaceId === 'string' ? raw.workspaceId : ''
        if (workspaceId === '') continue
        const progress = raw.progress !== null && typeof raw.progress === 'object' ? raw.progress : {}
        out.push({
          workspaceId,
          title: String(raw.title || raw.path || workspaceId),
          path: String(raw.path || ''),
          revision: toCount(raw.revision),
          done: toCount(progress.done),
          total: toCount(progress.total),
          readyCount: toCount(raw.readyCount !== undefined ? raw.readyCount : progress.ready),
          doing: toCount(progress.doing),
          failed: toCount(progress.failed),
          planned: toCount(progress.planned),
        })
      }
      return out
    }

    function buildModel(snapshot) {
      const source = snapshot !== null && typeof snapshot === 'object' ? snapshot : null
      const graph = source !== null && source.graph !== null && typeof source.graph === 'object' ? source.graph : {}
      const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : []
      const rawEdges = Array.isArray(graph.edges) ? graph.edges : []

      const nodes = []
      const nodeById = {}
      const nodeIds = new Set()
      for (const node of rawNodes) {
        if (node === null || typeof node !== 'object' || typeof node.id !== 'string' || node.id === '') continue
        const copy = Object.assign({}, node)
        if (!Array.isArray(copy.sessions)) copy.sessions = []
        // Older snapshots may only know three statuses; unknown values fall
        // back to todo instead of hiding the node.
        if (typeof copy.status !== 'string' || STATUSES.indexOf(copy.status) < 0) copy.status = 'todo'
        nodes.push(copy)
        nodeById[copy.id] = copy
        nodeIds.add(copy.id)
      }

      const edges = []
      const incoming = {}
      const outgoing = {}
      for (const edge of rawEdges) {
        if (edge === null || typeof edge !== 'object') continue
        if (typeof edge.id !== 'string' || edge.id === '') continue
        if (typeof edge.from !== 'string' || typeof edge.to !== 'string') continue
        if (edge.from === edge.to) continue
        if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue
        const copy = {
          id: edge.id,
          from: edge.from,
          to: edge.to,
          conditionId: typeof edge.conditionId === 'string' && edge.conditionId !== '' ? edge.conditionId : null,
        }
        edges.push(copy)
        if (incoming[copy.to] === undefined) incoming[copy.to] = []
        incoming[copy.to].push(copy)
        if (outgoing[copy.from] === undefined) outgoing[copy.from] = []
        outgoing[copy.from].push(copy)
      }

      const conditions = computeConditions(nodes, edges, nodeById)
      const ready = new Set()
      const blocked = new Set()
      // No project-finished flag lives here: a milestone is only a marker, and
      // the graph keeps growing after it. Completion is just done/total.
      const progress = { done: 0, total: nodes.length, ready: 0, blocked: 0, doing: 0, failed: 0, planned: 0 }
      for (const node of nodes) {
        if (node.status === 'done') progress.done += 1
        else if (node.status === 'doing') progress.doing += 1
        else if (node.status === 'failed') progress.failed += 1
        else if (node.status === 'planned') progress.planned += 1
        if (node.status !== 'todo') continue
        const list = conditions[node.id] || []
        if (list.every((condition) => condition.satisfied)) {
          ready.add(node.id)
          progress.ready += 1
        } else {
          blocked.add(node.id)
          progress.blocked += 1
        }
      }

      const levels = computeLevels(nodes, edges)
      const hasManualPosition = (node) => node.position !== null && typeof node.position === 'object'
        && Number.isFinite(Number(node.position.x)) && Number.isFinite(Number(node.position.y))
      // The layered layout is only needed while at least one node is unplaced;
      // an all-manual graph renders straight from its stored positions.
      const positions = nodes.every(hasManualPosition) ? {} : autoGraphPositions(nodes, edges, levels)
      for (const node of nodes) {
        if (!hasManualPosition(node)) continue
        positions[node.id] = { x: Number(node.position.x), y: Number(node.position.y) }
      }

      // Groups are optional structural annotations. The Host already repairs
      // them; the client mirrors the same rules so an old or hand-edited
      // document cannot draw an outline with ghost members or one node in two
      // groups. A group whose members all disappeared is dropped.
      const groups = []
      const groupOfNode = {}
      const seenGroupIds = new Set()
      const rawGroups = Array.isArray(graph.groups) ? graph.groups : []
      for (const raw of rawGroups) {
        if (raw === null || typeof raw !== 'object') continue
        const id = typeof raw.id === 'string' ? raw.id : ''
        if (id === '' || seenGroupIds.has(id)) continue
        const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : '未命名组合'
        const members = []
        for (const nodeId of Array.isArray(raw.nodeIds) ? raw.nodeIds : []) {
          if (typeof nodeId !== 'string' || nodeId === '') continue
          if (!nodeIds.has(nodeId)) continue
          if (members.indexOf(nodeId) >= 0) continue
          if (groupOfNode[nodeId] !== undefined) continue
          members.push(nodeId)
        }
        if (members.length === 0) continue
        seenGroupIds.add(id)
        groups.push({ id, name, nodeIds: members })
        for (const nodeId of members) groupOfNode[nodeId] = id
      }

      const facts = normalizeSessionFacts(source !== null ? source.sessions : null)
      const attachedSessionIds = new Set()
      for (const node of nodes) {
        for (const session of node.sessions) {
          if (session !== null && typeof session === 'object' && typeof session.sessionId === 'string') {
            attachedSessionIds.add(session.sessionId)
          }
        }
      }

      const workspace = source !== null && source.workspace !== null && typeof source.workspace === 'object'
        ? source.workspace
        : {}

      const milestoneNodeId = milestoneNodeIdOf(graph)
      const milestoneNode = milestoneNodeId !== null ? nodeById[milestoneNodeId] : undefined

      return {
        graph,
        nodes,
        edges,
        nodeById,
        nodeIds,
        incoming,
        outgoing,
        conditions,
        levels,
        positions,
        groups,
        groupOfNode,
        ready,
        blocked,
        progress,
        facts: facts.byId,
        archived: facts.archived,
        attachedSessionIds,
        notes: Array.isArray(source !== null && source !== undefined ? source.notes : null)
          ? source.notes.filter((note) => typeof note === 'string' && note !== '')
          : [],
        milestoneNodeId,
        milestoneNode: milestoneNode !== undefined ? milestoneNode : null,
        summary: progress,
        revision: toCount(graph.revision),
        workspace: {
          workspaceId: typeof workspace.workspaceId === 'string' ? workspace.workspaceId : '',
          title: typeof workspace.title === 'string' ? workspace.title : String(graph.title || ''),
          path: typeof workspace.path === 'string' ? workspace.path : '',
        },
      }
    }


    function activeSessionOf(node) {
      const sessions = Array.isArray(node.sessions) ? node.sessions : []
      for (const session of sessions) {
        if (session !== null && typeof session === 'object'
          && (session.retiredAt === null || session.retiredAt === undefined)) return session
      }
      return null
    }

    function sortedSessions(node) {
      const sessions = Array.isArray(node.sessions) ? node.sessions.slice() : []
      sessions.sort((left, right) => (Number(left.slot) || 0) - (Number(right.slot) || 0))
      return sessions
    }

    // Cubic control points shared by the curve renderer and the obstacle check.
    function curveControls(from, to, offset) {
      const dx = Math.max(36, Math.abs(to.x - from.x) * 0.5)
      const shift = Number.isFinite(Number(offset)) ? Number(offset) : 0
      const straight = Math.hypot(to.x - from.x, to.y - from.y)
      const length = straight > 0 ? straight : 1
      const ox = (-(to.y - from.y) / length) * shift
      const oy = ((to.x - from.x) / length) * shift
      return {
        c1: { x: from.x + dx + ox, y: from.y + oy },
        c2: { x: to.x - dx + ox, y: to.y + oy },
      }
    }

    function cubicPoint(from, to, controls, t) {
      const mt = 1 - t
      const a = mt * mt * mt
      const b = 3 * mt * mt * t
      const c = 3 * mt * t * t
      const d = t * t * t
      return {
        x: a * from.x + b * controls.c1.x + c * controls.c2.x + d * to.x,
        y: a * from.y + b * controls.c1.y + c * controls.c2.y + d * to.y,
      }
    }

    // Parallel edges between the same pair of nodes bow apart by `offset`
    // (perpendicular to the straight line) so every condition stays legible.
    function curvePath(from, to, offset) {
      const controls = curveControls(from, to, offset)
      return 'M ' + round1(from.x) + ' ' + round1(from.y)
        + ' C ' + round1(controls.c1.x) + ' ' + round1(controls.c1.y)
        + ', ' + round1(controls.c2.x) + ' ' + round1(controls.c2.y)
        + ', ' + round1(to.x) + ' ' + round1(to.y)
    }

    function nodeRect(position) {
      return {
        left: position.x,
        top: position.y,
        right: position.x + NODE_W,
        bottom: position.y + NODE_H,
      }
    }

    function inflateRect(rect, margin) {
      return {
        left: rect.left - margin,
        top: rect.top - margin,
        right: rect.right + margin,
        bottom: rect.bottom + margin,
      }
    }

    // Strict interior test: a line that runs along an inflated boundary keeps
    // the promised clearance and still counts as free.
    function rectHoldsPoint(rect, x, y) {
      return x > rect.left && x < rect.right && y > rect.top && y < rect.bottom
    }

    // Liang-Barsky: does the segment cross the open rectangle's interior?
    function segmentHitsRect(a, b, rect) {
      let t0 = 0
      let t1 = 1
      const dx = b.x - a.x
      const dy = b.y - a.y
      const p = [-dx, dx, -dy, dy]
      const q = [a.x - rect.left, rect.right - a.x, a.y - rect.top, rect.bottom - a.y]
      for (let index = 0; index < 4; index += 1) {
        if (p[index] === 0) {
          if (q[index] <= 0) return false
          continue
        }
        const t = q[index] / p[index]
        if (p[index] < 0) {
          if (t > t1) return false
          if (t > t0) t0 = t
        } else {
          if (t < t0) return false
          if (t < t1) t1 = t
        }
      }
      return t0 < t1
    }

    function segmentClear(a, b, obstacles) {
      for (const rect of obstacles) {
        if (segmentHitsRect(a, b, rect)) return false
      }
      return true
    }

    /* ------------------------------------------------------------------ */
    /* geometry shared by edge routing, lasso selection and group outlines */
    /* ------------------------------------------------------------------ */

    function distanceBetween(a, b) {
      return Math.hypot(b.x - a.x, b.y - a.y)
    }

    function polylineLength(points) {
      let length = 0
      for (let index = 1; index < points.length; index += 1) {
        length += distanceBetween(points[index - 1], points[index])
      }
      return length
    }

    function pointsBoundingBox(points) {
      let left = Infinity
      let top = Infinity
      let right = -Infinity
      let bottom = -Infinity
      for (const point of points) {
        if (point.x < left) left = point.x
        if (point.x > right) right = point.x
        if (point.y < top) top = point.y
        if (point.y > bottom) bottom = point.y
      }
      return { left, top, right, bottom }
    }

    function boxesNear(a, b, gap) {
      return a.left - gap <= b.right && b.left - gap <= a.right
        && a.top - gap <= b.bottom && b.top - gap <= a.bottom
    }

    /** Smallest distance between two sampled polylines (0 when they touch). */
    function polylineDistance(a, b) {
      let minimum = Infinity
      for (const point of a) {
        for (const other of b) {
          const distance = distanceBetween(point, other)
          if (distance < minimum) {
            minimum = distance
            if (minimum === 0) return 0
          }
        }
      }
      return minimum
    }

    /** Ray-casting point-in-polygon; the polygon may be open (last closes to first). */
    function pointInPolygon(x, y, polygon) {
      if (polygon.length < 3) return false
      let inside = false
      for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
        const currentPoint = polygon[index]
        const previousPoint = polygon[previous]
        const crosses = (currentPoint.y > y) !== (previousPoint.y > y)
        if (!crosses) continue
        const xAtY = ((previousPoint.x - currentPoint.x) * (y - currentPoint.y))
          / (previousPoint.y - currentPoint.y) + currentPoint.x
        if (x < xAtY) inside = !inside
      }
      return inside
    }

    /** Remove consecutive duplicates and collinear middle points. */
    function simplifyPolyline(points) {
      const clean = []
      for (const point of points) {
        const last = clean[clean.length - 1]
        if (last === undefined || last.x !== point.x || last.y !== point.y) clean.push({ x: point.x, y: point.y })
      }
      if (clean.length < 3) return clean
      const out = [clean[0]]
      for (let index = 1; index < clean.length - 1; index += 1) {
        const before = out[out.length - 1]
        const current = clean[index]
        const after = clean[index + 1]
        const collinear = (before.x === current.x && current.x === after.x)
          || (before.y === current.y && current.y === after.y)
        if (!collinear) out.push(current)
      }
      out.push(clean[clean.length - 1])
      return out
    }

    /** Fully inside: every corner is inside and no polygon edge cuts the card. */
    function rectFullyInsidePolygon(rect, polygon) {
      if (polygon.length < 3) return false
      const corners = [
        { x: rect.left, y: rect.top },
        { x: rect.right, y: rect.top },
        { x: rect.right, y: rect.bottom },
        { x: rect.left, y: rect.bottom },
      ]
      for (const corner of corners) {
        if (!pointInPolygon(corner.x, corner.y, polygon)) return false
      }
      for (let index = 0; index < polygon.length; index += 1) {
        const next = polygon[(index + 1) % polygon.length]
        if (segmentHitsRect(polygon[index], next, rect)) return false
      }
      return true
    }

    /**
     * Orthogonal route between two free points. Candidate lines come from the
     * obstacle boundaries (a Hanan grid), so a shortest rectilinear path is
     * found without snapping to a coarse pixel grid.
     */
    function solveOrthogonalRoute(start, end, obstacles) {
      const xSet = new Set([start.x, end.x])
      const ySet = new Set([start.y, end.y])
      for (const rect of obstacles) {
        xSet.add(rect.left)
        xSet.add(rect.right)
        ySet.add(rect.top)
        ySet.add(rect.bottom)
      }
      const xs = Array.from(xSet).sort((left, right) => left - right)
      const ys = Array.from(ySet).sort((left, right) => left - right)
      const points = []
      const rows = []
      const columns = new Map()
      const pointAt = new Map()
      for (let yi = 0; yi < ys.length; yi += 1) {
        const row = []
        for (let xi = 0; xi < xs.length; xi += 1) {
          const x = xs[xi]
          const y = ys[yi]
          let blocked = false
          for (const rect of obstacles) {
            if (rectHoldsPoint(rect, x, y)) {
              blocked = true
              break
            }
          }
          if (blocked) continue
          const index = points.length
          points.push({ x, y })
          pointAt.set(x + '|' + y, index)
          row.push(index)
          if (!columns.has(x)) columns.set(x, [])
          columns.get(x).push(index)
        }
        rows.push(row)
      }
      const startIndex = pointAt.get(start.x + '|' + start.y)
      const endIndex = pointAt.get(end.x + '|' + end.y)
      if (startIndex === undefined || endIndex === undefined) return null
      const neighbors = points.map(() => [])
      const connect = (left, right) => {
        if (left === right) return
        if (!segmentClear(points[left], points[right], obstacles)) return
        const a = points[left]
        const b = points[right]
        const horizontal = a.y === b.y
        const dir = horizontal ? (b.x > a.x ? 0 : 1) : (b.y > a.y ? 2 : 3)
        const opposite = dir === 0 ? 1 : dir === 1 ? 0 : dir === 2 ? 3 : 2
        const cost = Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
        neighbors[left].push({ to: right, dir, cost })
        neighbors[right].push({ to: left, dir: opposite, cost })
      }
      for (const row of rows) {
        for (let index = 1; index < row.length; index += 1) connect(row[index - 1], row[index])
      }
      for (const column of columns.values()) {
        column.sort((left, right) => points[left].y - points[right].y)
        for (let index = 1; index < column.length; index += 1) connect(column[index - 1], column[index])
      }

      // A* over (point, incoming direction). Direction is part of the state so
      // a turn can be charged; the Manhattan heuristic stays admissible.
      const stateCount = points.length * 4
      const startState = stateCount
      const best = new Float64Array(stateCount + 1)
      best.fill(Infinity)
      const previous = new Int32Array(stateCount + 1)
      previous.fill(-1)
      const heap = []
      const heapPush = (state, f, g) => {
        heap.push({ state, f, g })
        let index = heap.length - 1
        while (index > 0) {
          const parent = (index - 1) >> 1
          if (heap[parent].f <= heap[index].f) break
          const swap = heap[parent]
          heap[parent] = heap[index]
          heap[index] = swap
          index = parent
        }
      }
      const heapPop = () => {
        const top = heap[0]
        const last = heap.pop()
        if (heap.length > 0) {
          heap[0] = last
          let index = 0
          for (;;) {
            const left = index * 2 + 1
            const right = left + 1
            let smallest = index
            if (left < heap.length && heap[left].f < heap[smallest].f) smallest = left
            if (right < heap.length && heap[right].f < heap[smallest].f) smallest = right
            if (smallest === index) break
            const swap = heap[smallest]
            heap[smallest] = heap[index]
            heap[index] = swap
            index = smallest
          }
        }
        return top
      }
      const heuristic = (point) => Math.abs(point.x - end.x) + Math.abs(point.y - end.y)
      best[startState] = 0
      heapPush(startState, heuristic(points[startIndex]), 0)
      let found = -1
      while (heap.length > 0) {
        const item = heapPop()
        if (item.g > best[item.state]) continue
        if (item.state === startState) {
          for (const step of neighbors[startIndex]) {
            const state = step.to * 4 + step.dir
            if (step.cost >= best[state]) continue
            best[state] = step.cost
            previous[state] = startState
            heapPush(state, step.cost + heuristic(points[step.to]), step.cost)
          }
          continue
        }
        const pointIndex = Math.floor(item.state / 4)
        if (pointIndex === endIndex) {
          found = item.state
          break
        }
        const direction = item.state % 4
        for (const step of neighbors[pointIndex]) {
          const turn = step.dir === direction ? 0 : EDGE_TURN_COST
          const g = item.g + step.cost + turn
          const state = step.to * 4 + step.dir
          if (g >= best[state]) continue
          best[state] = g
          previous[state] = item.state
          heapPush(state, g + heuristic(points[step.to]), g)
        }
      }
      if (found < 0) return null
      const route = []
      let cursor = found
      while (cursor !== startState && cursor >= 0) {
        route.push(points[Math.floor(cursor / 4)])
        cursor = previous[cursor]
      }
      route.reverse()
      return route
    }

    /**
     * Chaikin corner cutting: each pass replaces a sharp corner with two points
     * on the adjacent segments. Repeated passes converge to a quadratic
     * B-spline, so a rectilinear guide becomes a smooth curve without ever
     * leaving the guide's convex neighbourhood (unlike an interpolating spline,
     * which can overshoot a corner straight into an obstacle).
     */
    function chaikinSmooth(points, iterations) {
      let current = points.map((point) => ({ x: point.x, y: point.y }))
      for (let pass = 0; pass < iterations; pass += 1) {
        if (current.length < 3) return current
        const next = [current[0]]
        for (let index = 0; index < current.length - 1; index += 1) {
          const from = current[index]
          const to = current[index + 1]
          next.push(
            { x: from.x * 0.75 + to.x * 0.25, y: from.y * 0.75 + to.y * 0.25 },
            { x: from.x * 0.25 + to.x * 0.75, y: from.y * 0.25 + to.y * 0.75 },
          )
        }
        next.push(current[current.length - 1])
        current = next
      }
      return current
    }

    /** Keep the endpoints and a bounded number of evenly spread points. */
    function decimatePolyline(points, limit) {
      if (points.length <= limit) return points
      const out = [points[0]]
      const step = (points.length - 2) / (limit - 2)
      for (let index = 1; index < limit - 1; index += 1) {
        out.push(points[Math.min(points.length - 2, Math.round(1 + (index - 1) * step))])
      }
      out.push(points[points.length - 1])
      return out
    }

    /**
     * Drop interior points that sit almost on top of the previous kept point.
     * Chaikin leaves clusters at the original corners, and a one-pixel span with
     * a long control arm would draw a tiny backward loop.
     */
    function thinPolyline(points, minGap) {
      if (points.length < 3) return points
      const out = [points[0]]
      for (let index = 1; index < points.length - 1; index += 1) {
        const previous = out[out.length - 1]
        if (distanceBetween(previous, points[index]) >= minGap) out.push(points[index])
      }
      out.push(points[points.length - 1])
      return out
    }

    /** Evenly reduce a sampled polyline; used for cheap pairwise distance checks. */
    function downsamplePolyline(points, limit) {
      if (points.length <= limit) return points
      const out = []
      const step = (points.length - 1) / (limit - 1)
      for (let index = 0; index < limit; index += 1) out.push(points[Math.round(index * step)])
      return out
    }

    /**
     * A smooth cubic chain through `points`. Interior tangents follow the
     * Catmull-Rom construction (scaled by `tension`, so a smoothed guide does
     * not overshoot its corners); the first and last tangents are horizontal so
     * the line leaves and enters the card handles cleanly. The emitted path
     * contains cubic segments only — never a right-angle join.
     */
    function smoothCubicChain(points, options = {}) {
      const tension = Number.isFinite(Number(options.tension)) ? Number(options.tension) : 0.6
      const stepsPerSegment = Number.isFinite(Number(options.stepsPerSegment)) ? Number(options.stepsPerSegment) : 8
      const clean = []
      for (const point of points) {
        const last = clean[clean.length - 1]
        if (last === undefined || last.x !== point.x || last.y !== point.y) clean.push({ x: point.x, y: point.y })
      }
      if (clean.length === 0) return null
      if (clean.length === 1) {
        return { d: 'M ' + round1(clean[0].x) + ' ' + round1(clean[0].y), points: clean }
      }
      const segments = []
      for (let index = 0; index < clean.length - 1; index += 1) {
        const from = clean[index]
        const to = clean[index + 1]
        const before = clean[index - 1] !== undefined
          ? clean[index - 1]
          : { x: from.x - (to.x - from.x), y: from.y - (to.y - from.y) }
        const after = clean[index + 2] !== undefined
          ? clean[index + 2]
          : { x: to.x + (to.x - from.x), y: to.y + (to.y - from.y) }
        segments.push({
          from,
          to,
          c1: {
            x: from.x + (to.x - before.x) / 6 * tension,
            y: from.y + (to.y - before.y) / 6 * tension,
          },
          c2: {
            x: to.x - (after.x - from.x) / 6 * tension,
            y: to.y - (after.y - from.y) / 6 * tension,
          },
        })
      }
      const first = segments[0]
      const firstLength = clamp(Math.hypot(first.to.x - first.from.x, first.to.y - first.from.y) * 0.55, 8, 48)
      first.c1 = { x: first.from.x + firstLength, y: first.from.y }
      const last = segments[segments.length - 1]
      const lastLength = clamp(Math.hypot(last.to.x - last.from.x, last.to.y - last.from.y) * 0.55, 8, 48)
      last.c2 = { x: last.to.x - lastLength, y: last.to.y }

      let d = 'M ' + round1(clean[0].x) + ' ' + round1(clean[0].y)
      const sampled = [{ x: clean[0].x, y: clean[0].y }]
      for (const segment of segments) {
        d += ' C ' + round1(segment.c1.x) + ' ' + round1(segment.c1.y)
          + ', ' + round1(segment.c2.x) + ' ' + round1(segment.c2.y)
          + ', ' + round1(segment.to.x) + ' ' + round1(segment.to.y)
        for (let step = 1; step <= stepsPerSegment; step += 1) {
          sampled.push(cubicPoint(segment.from, segment.to, { c1: segment.c1, c2: segment.c2 }, step / stepsPerSegment))
        }
      }
      return { d, points: sampled }
    }

    /** The plain cubic between two handles (the shape used for ghost edges). */
    function cubicCandidate(from, to, offset) {
      const controls = curveControls(from, to, offset)
      const points = [from]
      for (let step = 1; step <= EDGE_CURVE_STEPS; step += 1) {
        points.push(cubicPoint(from, to, controls, step / EDGE_CURVE_STEPS))
      }
      return { d: curvePath(from, to, offset), points }
    }

    /** A cubic bowed sideways by `bow` (perpendicular to the straight line). */
    function bowCandidate(from, to, bow) {
      const dx = to.x - from.x
      const dy = to.y - from.y
      const length = Math.hypot(dx, dy) || 1
      const shift = clamp(Number(bow) || 0, -length * 0.55, length * 0.55)
      const middle = {
        x: (from.x + to.x) / 2 - (dy / length) * shift,
        y: (from.y + to.y) / 2 + (dx / length) * shift,
      }
      return smoothCubicChain([from, middle, to])
    }

    /**
     * Waypoints for a detour: the orthogonal solver only generates a guide
     * around the obstacle rectangles, and the guide is later smoothed into a
     * cubic chain, so the right angles never reach the canvas.
     */
    function detourGuide(from, to, obstacles, endpointIds, pad = EDGE_GUIDE_PAD, laneShift = 0) {
      const guideObstacles = obstacles.map((rect) => (
        rect.nodeId !== undefined && endpointIds.has(rect.nodeId)
          ? rect
          : inflateRect(rect, pad)
      ))
      const stubs = EDGE_STUB > 6 ? [EDGE_STUB, 6] : [EDGE_STUB]
      for (const stub of stubs) {
        const startStub = { x: from.x + stub, y: from.y + laneShift }
        const endStub = { x: to.x - stub, y: to.y + laneShift }
        if (!segmentClear(from, startStub, guideObstacles)) continue
        if (!segmentClear(endStub, to, guideObstacles)) continue
        const route = solveOrthogonalRoute(startStub, endStub, guideObstacles)
        if (route === null) continue
        // The solver omits its synthetic start state, so the first stub point is
        // prepended explicitly; otherwise the guide starts with a diagonal jump.
        const waypoints = [from, startStub, ...route, to]
        return simplifyPolyline(waypoints)
      }
      return null
    }

    function candidateClearsObstacles(points, obstacles) {
      for (let index = 1; index < points.length; index += 1) {
        if (!segmentClear(points[index - 1], points[index], obstacles)) return false
      }
      return true
    }

    function candidateObstacleHits(points, obstacles) {
      let hits = 0
      for (let index = 1; index < points.length; index += 1) {
        for (const rect of obstacles) {
          if (segmentHitsRect(points[index - 1], points[index], rect)) hits += 1
        }
      }
      return hits
    }

    /** Total turning of a sampled polyline; used to prefer calm curves. */
    function polylineCurvature(points) {
      let total = 0
      for (let index = 1; index < points.length - 1; index += 1) {
        const before = points[index - 1]
        const current = points[index]
        const after = points[index + 1]
        const incoming = Math.atan2(current.y - before.y, current.x - before.x)
        const outgoing = Math.atan2(after.y - current.y, after.x - current.x)
        let delta = Math.abs(outgoing - incoming)
        if (delta > Math.PI) delta = 2 * Math.PI - delta
        total += delta
      }
      return total
    }

    function scoreEdgeCandidate(candidate, routed) {
      const points = candidate.points
      const sampled = downsamplePolyline(points, 24)
      const box = pointsBoundingBox(points)
      let separationCost = 0
      for (const other of routed) {
        if (!boxesNear(box, other.box, EDGE_SEPARATION)) continue
        const gap = polylineDistance(sampled, other.points)
        if (gap >= EDGE_SEPARATION) continue
        const deficit = EDGE_SEPARATION - gap
        separationCost += 24 + deficit * deficit * 5
      }
      return polylineLength(points) + polylineCurvature(points) * 24 + separationCost
    }

    function edgeCandidates(from, to, groupOffset, obstacles, endpointIds) {
      const direct = cubicCandidate(from, to, groupOffset)
      const candidates = [direct]
      // Detours are only needed when the direct curve is blocked; otherwise the
      // sideways bows below cover edge separation without the routing cost.
      const directBlocked = !candidateClearsObstacles(direct.points, obstacles)
      const bows = []
      for (const bow of EDGE_BOWS) {
        // Same-pair edges keep their extra sideways separation instead of
        // collapsing back onto the direct curve.
        const value = bow === 0 ? groupOffset * 1.6 : bow + groupOffset
        if (bows.some((existing) => Math.abs(existing - value) < 6)) continue
        bows.push(value)
      }
      for (const bow of bows) {
        const candidate = bowCandidate(from, to, bow)
        if (candidate !== null) candidates.push(candidate)
      }
      if (!directBlocked) return candidates
      const guidePads = [EDGE_GUIDE_PAD, EDGE_GUIDE_PAD + 18]
      for (const pad of guidePads) {
        const guide = detourGuide(from, to, obstacles, endpointIds, pad, groupOffset)
        if (guide === null) continue
        const rounded = decimatePolyline(thinPolyline(chaikinSmooth(guide, 2), 12), 14)
        const smoothed = smoothCubicChain(rounded, { tension: 0.7 })
        if (smoothed !== null) candidates.push(smoothed)
      }
      return candidates
    }

    function chooseEdgeCandidate(candidates, obstacles, routed) {
      let best = null
      let bestScore = Infinity
      let leastBlocked = null
      let leastBlockedScore = Infinity
      for (const candidate of candidates) {
        const blocked = !candidateClearsObstacles(candidate.points, obstacles)
        if (blocked) {
          // Nothing clean is available: keep the least invasive curve so a line
          // is still drawn instead of dropping it.
          const blockedScore = candidateObstacleHits(candidate.points, obstacles) * 10000
            + scoreEdgeCandidate(candidate, routed)
          if (blockedScore < leastBlockedScore) {
            leastBlockedScore = blockedScore
            leastBlocked = candidate
          }
          continue
        }
        const score = scoreEdgeCandidate(candidate, routed)
        if (score < bestScore) {
          bestScore = score
          best = candidate
        }
      }
      return best !== null ? best : leastBlocked !== null ? leastBlocked : candidates[0]
    }

    /**
     * Room around a node handle so several edges leaving one card for different
     * targets (or arriving from different sources) do not all leave or arrive
     * at the same point. Edges between the same pair share the same anchor: the
     * parallel-lane offset separates them along the curve instead.
     */
    function edgeAnchorShifts(edges) {
      const outgoing = {}
      const incoming = {}
      for (const edge of edges) {
        if (outgoing[edge.from] === undefined) outgoing[edge.from] = []
        outgoing[edge.from].push(edge)
        if (incoming[edge.to] === undefined) incoming[edge.to] = []
        incoming[edge.to].push(edge)
      }
      const shifts = {}
      for (const edge of edges) shifts[edge.id] = { from: 0, to: 0 }
      const assign = (map, key, neighborOf) => {
        for (const nodeId of Object.keys(map)) {
          const list = map[nodeId]
          const neighbors = [...new Set(list.map(neighborOf))].sort()
          if (neighbors.length < 2) continue
          const shiftByNeighbor = {}
          for (let index = 0; index < neighbors.length; index += 1) {
            shiftByNeighbor[neighbors[index]] = clamp(
              (index - (neighbors.length - 1) / 2) * EDGE_ANCHOR_STEP,
              -EDGE_ANCHOR_LIMIT,
              EDGE_ANCHOR_LIMIT,
            )
          }
          for (const edge of list) shifts[edge.id][key] = shiftByNeighbor[neighborOf(edge)]
        }
      }
      assign(outgoing, 'from', (edge) => edge.to)
      assign(incoming, 'to', (edge) => edge.from)
      return shifts
    }

    /** Only obstacles near the pair can matter; the rest are cheap to skip. */
    function nearbyObstacles(obstacles, fromPosition, toPosition) {
      const left = Math.min(fromPosition.x, toPosition.x) - EDGE_ROUTE_PAD
      const top = Math.min(fromPosition.y, toPosition.y) - EDGE_ROUTE_PAD
      const right = Math.max(fromPosition.x + NODE_W, toPosition.x + NODE_W) + EDGE_ROUTE_PAD
      const bottom = Math.max(fromPosition.y + NODE_H, toPosition.y + NODE_H) + EDGE_ROUTE_PAD
      return obstacles.filter((rect) => rect.right >= left && rect.left <= right
        && rect.bottom >= top && rect.top <= bottom)
    }

    /**
     * Route every edge once per render. Edges are routed shortest-first so long
     * edges bend around the short ones, and each chosen curve is fed back as a
     * soft obstacle for the next one: that is what keeps unrelated edges from
     * overlapping. Returns `edgeId -> path`.
     */
    function routeEdgeSet(edges, positions, softRects, hardRects) {
      const shifts = edgeAnchorShifts(edges)
      const groupOffsets = {}
      const groups = {}
      for (const edge of edges) {
        const key = edge.from + '→' + edge.to
        if (groups[key] === undefined) groups[key] = []
        groups[key].push(edge)
      }
      for (const key of Object.keys(groups)) {
        const list = groups[key]
        list.sort((left, right) => String(left.conditionId || '').localeCompare(String(right.conditionId || ''))
          || left.id.localeCompare(right.id))
        for (let index = 0; index < list.length; index += 1) {
          groupOffsets[list[index].id] = list.length > 1
            ? (index - (list.length - 1) / 2) * 18
            : 0
        }
      }

      const ordered = edges.slice().sort((left, right) => {
        const leftFrom = positions[left.from]
        const leftTo = positions[left.to]
        const rightFrom = positions[right.from]
        const rightTo = positions[right.to]
        if (leftFrom === undefined || leftTo === undefined || rightFrom === undefined || rightTo === undefined) {
          return left.id.localeCompare(right.id)
        }
        const leftDistance = Math.hypot(leftTo.x - leftFrom.x, leftTo.y - leftFrom.y)
        const rightDistance = Math.hypot(rightTo.x - rightFrom.x, rightTo.y - rightFrom.y)
        return leftDistance - rightDistance || left.id.localeCompare(right.id)
      })

      const routed = []
      const paths = {}
      for (const edge of ordered) {
        const fromPosition = positions[edge.from]
        const toPosition = positions[edge.to]
        if (fromPosition === undefined || toPosition === undefined) continue
        const shift = shifts[edge.id]
        const from = { x: fromPosition.x + NODE_W, y: fromPosition.y + NODE_H / 2 + shift.from }
        const to = { x: toPosition.x, y: toPosition.y + NODE_H / 2 + shift.to }
        const edgeObstacles = []
        for (const rect of softRects) {
          if (rect.nodeId !== edge.from && rect.nodeId !== edge.to) edgeObstacles.push(rect)
        }
        for (const rect of hardRects) {
          if (rect.nodeId === edge.from || rect.nodeId === edge.to) edgeObstacles.push(rect)
        }
        const nearby = nearbyObstacles(edgeObstacles, fromPosition, toPosition)
        const candidates = edgeCandidates(from, to, groupOffsets[edge.id] || 0, nearby, new Set([edge.from, edge.to]))
        const chosen = chooseEdgeCandidate(candidates, nearby, routed)
        paths[edge.id] = chosen.d
        routed.push({ points: downsamplePolyline(chosen.points, 18), box: pointsBoundingBox(chosen.points) })
      }
      return paths
    }

    /* ------------------------------------------------------------------ */
    /* group outline                                                       */
    /*                                                                     */
    /* A group contour follows the union of the grid cells its cards touch. */
    /* That keeps every contour edge on a layout grid line even in free    */
    /* layout, and every corner is rounded with the card's own 10px radius. */
    /* ------------------------------------------------------------------ */

    const GROUP_CORNER_RADIUS = 10
    const GROUP_LABEL_PAD = 12

    function groupOutlineLoops(cells) {
      const has = (col, row) => cells.has(col + ',' + row)
      const segments = []
      for (const key of cells) {
        const parts = key.split(',')
        const col = Number(parts[0])
        const row = Number(parts[1])
        if (!has(col, row - 1)) segments.push({ a: { c: col, r: row }, b: { c: col + 1, r: row } })
        if (!has(col + 1, row)) segments.push({ a: { c: col + 1, r: row }, b: { c: col + 1, r: row + 1 } })
        if (!has(col, row + 1)) segments.push({ a: { c: col + 1, r: row + 1 }, b: { c: col, r: row + 1 } })
        if (!has(col - 1, row)) segments.push({ a: { c: col, r: row + 1 }, b: { c: col, r: row } })
      }
      const byStart = new Map()
      for (const segment of segments) {
        const key = segment.a.c + ',' + segment.a.r
        if (!byStart.has(key)) byStart.set(key, [])
        byStart.get(key).push(segment)
      }
      const directionOf = (segment) => ({
        x: Math.sign(segment.b.c - segment.a.c),
        y: Math.sign(segment.b.r - segment.a.r),
      })
      // At a pinch point two cells touch only diagonally and four segments meet.
      // Taking the sharpest right turn keeps the two loops separate (the
      // segments are oriented clockwise around their cell block).
      const pickRightTurn = (current, candidates) => {
        const incoming = directionOf(current)
        let best = candidates[0]
        let bestCross = -Infinity
        for (const candidate of candidates) {
          const outgoing = directionOf(candidate)
          const cross = incoming.x * outgoing.y - incoming.y * outgoing.x
          if (cross > bestCross) {
            bestCross = cross
            best = candidate
          }
        }
        return best
      }

      const used = new Set()
      const loops = []
      for (const segment of segments) {
        if (used.has(segment)) continue
        used.add(segment)
        const loop = [segment.a]
        const start = segment.a
        let current = segment
        for (let guard = 0; guard <= segments.length; guard += 1) {
          loop.push(current.b)
          if (current.b.c === start.c && current.b.r === start.r) break
          const key = current.b.c + ',' + current.b.r
          const candidates = (byStart.get(key) || []).filter((candidate) => !used.has(candidate))
          if (candidates.length === 0) break
          const next = candidates.length === 1 ? candidates[0] : pickRightTurn(current, candidates)
          used.add(next)
          current = next
        }
        if (loop.length > 1 && loop[0].c === loop[loop.length - 1].c && loop[0].r === loop[loop.length - 1].r) {
          loop.pop()
        }
        if (loop.length >= 4) loops.push(loop)
      }
      return loops
    }

    /** Drop duplicate and collinear vertices from a closed loop. */
    function simplifyClosedLoop(points) {
      const clean = []
      for (const point of points) {
        const last = clean[clean.length - 1]
        if (last === undefined || last.x !== point.x || last.y !== point.y) clean.push(point)
      }
      if (clean.length < 3) return clean
      const out = []
      for (let index = 0; index < clean.length; index += 1) {
        const before = clean[(index - 1 + clean.length) % clean.length]
        const current = clean[index]
        const after = clean[(index + 1) % clean.length]
        const collinear = (before.x === current.x && current.x === after.x)
          || (before.y === current.y && current.y === after.y)
        if (!collinear) out.push(current)
      }
      return out
    }

    /**
     * Closed SVG path through an axis-aligned loop with circular fillets of
     * `radius` at every corner (drawn with arc commands so the curvature is the
     * same as the node cards' rounded rectangle).
     */
    function roundedRectilinearPath(points, radius) {
      const clean = simplifyClosedLoop(points)
      const count = clean.length
      if (count < 4) return ''
      const corners = []
      for (let index = 0; index < count; index += 1) {
        const previous = clean[(index - 1 + count) % count]
        const current = clean[index]
        const next = clean[(index + 1) % count]
        const incomingLength = distanceBetween(previous, current) || 1
        const outgoingLength = distanceBetween(current, next) || 1
        const cornerRadius = Math.min(radius, incomingLength / 2, outgoingLength / 2)
        const incoming = {
          x: (current.x - previous.x) / incomingLength,
          y: (current.y - previous.y) / incomingLength,
        }
        const outgoing = {
          x: (next.x - current.x) / outgoingLength,
          y: (next.y - current.y) / outgoingLength,
        }
        corners.push({
          entry: { x: current.x - incoming.x * cornerRadius, y: current.y - incoming.y * cornerRadius },
          exit: { x: current.x + outgoing.x * cornerRadius, y: current.y + outgoing.y * cornerRadius },
          radius: cornerRadius,
          cross: incoming.x * outgoing.y - incoming.y * outgoing.x,
        })
      }
      let d = 'M ' + round1(corners[0].entry.x) + ' ' + round1(corners[0].entry.y)
      for (let index = 0; index < corners.length; index += 1) {
        const corner = corners[index]
        if (index > 0) d += ' L ' + round1(corner.entry.x) + ' ' + round1(corner.entry.y)
        if (corner.radius >= 0.5) {
          d += ' A ' + round1(corner.radius) + ' ' + round1(corner.radius) + ' 0 0 '
            + (corner.cross > 0 ? 1 : 0) + ' ' + round1(corner.exit.x) + ' ' + round1(corner.exit.y)
        } else {
          d += ' L ' + round1(corner.exit.x) + ' ' + round1(corner.exit.y)
        }
      }
      return d + ' Z'
    }

    /** One dashed contour per group, plus the bounds used for its label. */
    function groupOutlineShapes(groups, positions) {
      const shapes = []
      for (const group of groups) {
        const cells = new Set()
        let memberCount = 0
        for (const nodeId of group.nodeIds) {
          const position = positions[nodeId]
          if (position === undefined) continue
          memberCount += 1
          const rect = nodeRect(position)
          const col0 = Math.floor((rect.left - GRID_X0) / GRID_W)
          const col1 = Math.floor((rect.right - 1e-6 - GRID_X0) / GRID_W)
          const row0 = Math.floor((rect.top - GRID_Y0) / GRID_H)
          const row1 = Math.floor((rect.bottom - 1e-6 - GRID_Y0) / GRID_H)
          // A corrupt position must not make the cell loop explode.
          if (col1 - col0 > 48 || row1 - row0 > 48) continue
          for (let col = col0; col <= col1; col += 1) {
            for (let row = row0; row <= row1; row += 1) cells.add(col + ',' + row)
          }
        }
        if (memberCount === 0 || cells.size === 0) continue
        let d = ''
        let labelBounds = null
        for (const loop of groupOutlineLoops(cells)) {
          const world = loop.map((point) => ({
            x: GRID_X0 + point.c * GRID_W,
            y: GRID_Y0 + point.r * GRID_H,
          }))
          d += roundedRectilinearPath(world, GROUP_CORNER_RADIUS)
          const bounds = pointsBoundingBox(world)
          const area = (bounds.right - bounds.left) * (bounds.bottom - bounds.top)
          if (labelBounds === null || area > labelBounds.area) {
            labelBounds = Object.assign({ area }, bounds)
          }
        }
        if (d === '' || labelBounds === null) continue
        shapes.push({ group, d, bounds: labelBounds })
      }
      return shapes
    }

    /** A hand-drawn lasso path, closed for both preview and hit testing. */
    function closedPolylinePath(points) {
      if (points.length === 0) return ''
      let d = 'M ' + round1(points[0].x) + ' ' + round1(points[0].y)
      for (let index = 1; index < points.length; index += 1) {
        d += ' L ' + round1(points[index].x) + ' ' + round1(points[index].y)
      }
      return d + ' Z'
    }

    function formatNextRun(schedule) {
      if (schedule === null || typeof schedule !== 'object') return ''
      const text = formatTime(schedule.nextRunAt)
      return text
    }

    function scheduleResultText(schedule) {
      if (schedule === null || typeof schedule !== 'object') return ''
      const result = typeof schedule.lastResult === 'string' ? schedule.lastResult : ''
      if (result === '') return '暂无记录'
      return SCHEDULE_RESULT_LABELS[result] === undefined ? result : SCHEDULE_RESULT_LABELS[result]
    }

    // =======================================================================
    // 7. Platform bridges — client services are optional; every read is
    //    defensive so a missing service degrades instead of failing.
    // =======================================================================
    function contextWorkspaces(ctx) {
      const out = []
      try {
        const snapshot = ctx !== null && typeof ctx === 'object' && ctx.workspaces !== null && typeof ctx.workspaces === 'object'
          && ctx.workspaces.list !== null && typeof ctx.workspaces.list === 'object'
          && typeof ctx.workspaces.list.getSnapshot === 'function'
          ? ctx.workspaces.list.getSnapshot()
          : null
        const items = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.items) ? snapshot.items : []
        for (const item of items) {
          if (item === null || typeof item !== 'object') continue
          if (typeof item.workspaceId !== 'string' || item.workspaceId === '') continue
          out.push({
            workspaceId: item.workspaceId,
            title: String(item.title || item.path || item.workspaceId),
            path: String(item.path || ''),
            revision: 0,
            done: 0,
            total: 0,
            readyCount: 0,
          })
        }
      } catch (error) {
        console.error('[dsh-task-dag] cannot read the workspaces service', error)
      }
      return out
    }

    function listWorkspaceSessions(ctx, workspace) {
      const out = []
      try {
        const wsSnapshot = ctx !== null && typeof ctx === 'object' && ctx.workspaces !== null && typeof ctx.workspaces === 'object'
          && ctx.workspaces.list !== null && typeof ctx.workspaces.list === 'object'
          && typeof ctx.workspaces.list.getSnapshot === 'function'
          ? ctx.workspaces.list.getSnapshot()
          : null
        const wsItems = wsSnapshot !== null && typeof wsSnapshot === 'object' && Array.isArray(wsSnapshot.items) ? wsSnapshot.items : []
        const wsItem = workspace !== null && workspace !== undefined && typeof workspace === 'object'
          ? wsItems.find((item) => item !== null && typeof item === 'object' && item.workspaceId === workspace.workspaceId) || null
          : null
        const archivedIds = wsSnapshot !== null && typeof wsSnapshot === 'object' && Array.isArray(wsSnapshot.archivedSessionIds)
          ? wsSnapshot.archivedSessionIds
          : []
        const sessionSnapshot = ctx !== null && typeof ctx === 'object' && ctx.sessions !== null && typeof ctx.sessions === 'object'
          && ctx.sessions.list !== null && typeof ctx.sessions.list === 'object'
          && typeof ctx.sessions.list.getSnapshot === 'function'
          ? ctx.sessions.list.getSnapshot()
          : null
        const byId = sessionSnapshot !== null && typeof sessionSnapshot === 'object'
          && sessionSnapshot.byId !== null && typeof sessionSnapshot.byId === 'object'
          ? sessionSnapshot.byId
          : {}
        const accountIds = wsItem !== null && Array.isArray(wsItem.sessionIds) && wsItem.sessionIds.length > 0
          ? wsItem.sessionIds
          : sessionSnapshot !== null && typeof sessionSnapshot === 'object' && Array.isArray(sessionSnapshot.ids)
            ? sessionSnapshot.ids
            : []
        const lookedUpFromAccount = wsItem !== null && Array.isArray(wsItem.sessionIds) && wsItem.sessionIds.length > 0
        const workspacePath = workspace !== null && workspace !== undefined && typeof workspace === 'object' ? workspace.path : ''
        for (const id of accountIds) {
          if (typeof id !== 'string' || id === '') continue
          const row = byId[id] !== null && typeof byId[id] === 'object' ? byId[id] : null
          if (!lookedUpFromAccount && typeof workspacePath === 'string' && workspacePath !== ''
            && row !== null && typeof row.cwd === 'string' && row.cwd !== ''
            && !samePath(row.cwd, workspacePath)) continue
          if (archivedIds.indexOf(id) >= 0) continue
          const title = row !== null && typeof row.displayTitle === 'string' && row.displayTitle !== ''
            ? row.displayTitle
            : row !== null && typeof row.title === 'string' && row.title !== ''
              ? row.title
              : id
          out.push({
            sessionId: id,
            title,
            running: row !== null && row.running === true,
            updatedAt: row !== null && typeof row.updatedAt === 'string' ? row.updatedAt : '',
          })
        }
      } catch (error) {
        console.error('[dsh-task-dag] cannot read the sessions service', error)
      }
      return out.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    }

    // =======================================================================
    // 8. Small atoms
    // =======================================================================
    function Chip(props) {
      const kind = props.kind === undefined || props.kind === null ? '' : ' dsh-td-chip-' + props.kind
      return h('span', { className: 'dsh-td-chip' + kind, title: props.title || undefined }, props.children)
    }

    function StatusDot(props) {
      const status = STATUSES.indexOf(props.status) >= 0 ? props.status : 'todo'
      return h('span', { className: 'dsh-td-dot dsh-td-dot-' + status, title: statusLabel(status) })
    }

    /** A section header that toggles its body. Collapsed by default. */
    function CollapsibleSection(props) {
      const [open, setOpen] = useState(props.defaultOpen === true)
      return h('section', { className: 'dsh-td-section dsh-td-collapse' },
        h('button', {
          type: 'button',
          className: 'dsh-td-collapse-head',
          'aria-expanded': open,
          onClick: () => setOpen((value) => !value),
        },
          h('span', { className: 'dsh-td-collapse-caret', 'aria-hidden': true }, open ? '▾' : '▸'),
          h('span', { className: 'dsh-td-section-title' }, props.title),
          typeof props.note === 'string' && props.note !== ''
            ? h('span', { className: 'dsh-td-section-note', title: props.note }, props.note)
            : null,
        ),
        open ? h('div', { className: 'dsh-td-collapse-body' }, props.children) : null,
      )
    }

    /**
     * One drag handle between two columns. It is a focusable separator so the
     * widths can also be changed with the arrow keys and reset with a double
     * click; the actual clamping lives in the panel, which knows both widths.
     */
    function ColumnSplitter(props) {
      return h('div', {
        className: 'dsh-td-splitter' + (props.active === true ? ' dsh-td-splitter-active' : ''),
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-label': props.label,
        'aria-valuenow': props.width,
        'aria-valuemin': props.min,
        'aria-valuemax': props.max,
        tabIndex: 0,
        title: '拖动调整宽度，双击恢复默认，方向键微调',
        onPointerDown: props.onStart,
        onDoubleClick: props.onReset,
        onKeyDown: (event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          props.onStep(event.key === 'ArrowRight' ? COLUMN_STEP : -COLUMN_STEP)
        },
      }, h('span', { className: 'dsh-td-splitter-line', 'aria-hidden': true }))
    }

    function modelValueOf(model) {
      const provider = typeof model.provider === 'string' ? model.provider : ''
      const id = typeof model.id === 'string' ? model.id : ''
      return provider !== '' ? provider + '/' + id : id
    }

    function effortNameOf(reasoning, effortId) {
      if (reasoning === null || reasoning === undefined) return ''
      const wanted = typeof effortId === 'string' && effortId !== '' ? effortId : null
      if (wanted !== null) {
        const found = reasoning.efforts.find((effort) => effort.id === wanted)
        return found !== undefined ? found.name : wanted
      }
      if (reasoning.defaultEffort === null) return '提供方默认'
      const found = reasoning.efforts.find((effort) => effort.id === reasoning.defaultEffort)
      return found !== undefined ? found.name : reasoning.defaultEffort
    }

    /**
     * Project-level model + reasoning-effort picker, modelled on the DSH composer
     * combobox: pick a model, then (when the model advertises levels) pick one of
     * its reasoning efforts. "跟随宿主" clears the node override.
     */
    function ModelPicker(props) {
      const models = Array.isArray(props.models) ? props.models : []
      const [open, setOpen] = useState(false)
      const [pane, setPane] = useState('model')
      const [pending, setPending] = useState(null)
      const rootRef = useRef(null)

      const currentValue = typeof props.model === 'string' ? props.model : ''
      const currentEffort = typeof props.reasoningEffort === 'string' && props.reasoningEffort !== ''
        ? props.reasoningEffort
        : null
      const current = models.find((model) => modelValueOf(model) === currentValue) || null
      const reasoning = current !== null && current.reasoning !== null && typeof current.reasoning === 'object'
        ? current.reasoning
        : null
      const effectiveEffort = currentEffort !== null
        ? currentEffort
        : reasoning !== null && typeof reasoning.defaultEffort === 'string' && reasoning.defaultEffort !== ''
          ? reasoning.defaultEffort
          : null
      const currentEffortLabel = reasoning === null ? '' : effortNameOf(reasoning, currentEffort)
      const triggerLabel = current !== null
        ? current.label
        : currentValue !== ''
          ? currentValue + '（目录未列出）'
          : '默认（跟随宿主）'

      const groups = []
      for (const model of models) {
        const provider = typeof model.provider === 'string' ? model.provider : ''
        let group = groups.find((item) => item.provider === provider)
        if (group === undefined) {
          group = {
            provider,
            label: typeof model.providerLabel === 'string' && model.providerLabel !== ''
              ? model.providerLabel
              : provider,
            models: [],
          }
          groups.push(group)
        }
        group.models.push(model)
      }

      useEffect(() => {
        if (open !== true) return undefined
        if (typeof document === 'undefined' || document === null) return undefined
        function onDocumentMouseDown(event) {
          const root = rootRef.current
          if (root !== null && root !== undefined && typeof root.contains === 'function'
            && root.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('mousedown', onDocumentMouseDown)
        return () => document.removeEventListener('mousedown', onDocumentMouseDown)
      }, [open])

      function close() {
        setOpen(false)
        setPane('model')
        setPending(null)
      }

      function chooseDefault() {
        close()
        if (currentValue === '' && currentEffort === null) return
        props.onChange({ model: null, reasoningEffort: null })
      }

      function chooseModel(model) {
        const reasoning = model.reasoning !== null && typeof model.reasoning === 'object'
          ? model.reasoning
          : null
        if (reasoning !== null && Array.isArray(reasoning.efforts) && reasoning.efforts.length > 0) {
          setPending(model)
          setPane('effort')
          return
        }
        close()
        const value = modelValueOf(model)
        const effort = reasoning !== null && typeof reasoning.defaultEffort === 'string'
          && reasoning.defaultEffort !== ''
          ? reasoning.defaultEffort
          : null
        if (value === currentValue && effort === currentEffort) return
        props.onChange({ model: value, reasoningEffort: effort })
      }

      function chooseEffort(effortId) {
        const model = pending
        if (model === null) return
        const value = modelValueOf(model)
        close()
        if (value === currentValue && (effortId === null ? null : effortId) === effectiveEffort) return
        props.onChange({ model: value, reasoningEffort: effortId })
      }

      function renderModelPane() {
        const rows = []
        rows.push(h('button', {
          key: 'host-default',
          type: 'button',
          role: 'option',
          'aria-selected': currentValue === '' && currentEffort === null,
          className: 'dsh-td-model-option' + (currentValue === '' && currentEffort === null ? ' dsh-td-model-option-on' : ''),
          onClick: chooseDefault,
        },
          h('span', { className: 'dsh-td-model-option-main' },
            h('span', { className: 'dsh-td-model-option-name' }, '默认（跟随宿主）'),
            currentValue === '' && currentEffort === null
              ? h('span', { className: 'dsh-td-model-check', 'aria-hidden': true }, '✓')
              : null),
          h('span', { className: 'dsh-td-model-option-meta' }, '新建会话沿用宿主默认模型；已有会话保持原模型'),
        ))
        for (const group of groups) {
          rows.push(h('div', { key: 'group:' + group.provider, className: 'dsh-td-model-group' },
            h('div', { className: 'dsh-td-model-group-label', title: group.provider }, group.label),
            group.models.map((model) => {
              const selected = modelValueOf(model) === currentValue
              return h('button', {
                key: modelValueOf(model),
                type: 'button',
                role: 'option',
                'aria-selected': selected,
                className: 'dsh-td-model-option' + (selected ? ' dsh-td-model-option-on' : ''),
                onClick: () => chooseModel(model),
              },
                h('span', { className: 'dsh-td-model-option-main' },
                  h('span', { className: 'dsh-td-model-option-name' }, model.label),
                  selected ? h('span', { className: 'dsh-td-model-check', 'aria-hidden': true }, '✓') : null),
                h('span', { className: 'dsh-td-model-option-meta' },
                  (model.provider !== '' ? model.provider + ' · ' : '')
                  + (model.reasoning !== null && typeof model.reasoning === 'object'
                    ? '可选推理强度'
                    : '无推理强度选项')),
              )
            }),
          ))
        }
        if (models.length === 0) {
          rows.push(h('div', { key: 'empty', className: 'dsh-td-hintline' },
            '模型目录为空：Host 没有返回可选模型。'))
        }
        return h('div', { className: 'dsh-td-model-pane' },
          h('div', { className: 'dsh-td-model-pop-head' },
            h('span', { className: 'dsh-td-model-pop-title' }, '模型'),
            h('span', { className: 'dsh-td-section-note' }, String(models.length) + ' 个')),
          rows,
        )
      }

      function renderEffortPane() {
        const model = pending
        if (model === null) return null
        const info = model.reasoning !== null && typeof model.reasoning === 'object' ? model.reasoning : null
        const rows = []
        const sameModel = modelValueOf(model) === currentValue
        if (info !== null) {
          if (info.defaultEffort === null) {
            rows.push(h('button', {
              key: 'effort-default',
              type: 'button',
              role: 'option',
              'aria-selected': sameModel && effectiveEffort === null,
              className: 'dsh-td-model-option' + (sameModel && effectiveEffort === null ? ' dsh-td-model-option-on' : ''),
              onClick: () => chooseEffort(null),
            },
              h('span', { className: 'dsh-td-model-option-main' },
                h('span', { className: 'dsh-td-model-option-name' }, '提供方默认'),
                sameModel && effectiveEffort === null
                  ? h('span', { className: 'dsh-td-model-check', 'aria-hidden': true }, '✓')
                  : null),
              h('span', { className: 'dsh-td-model-option-meta' }, '不显式指定推理强度'),
            ))
          }
          for (const effort of info.efforts) {
            const selected = sameModel && effectiveEffort === effort.id
            rows.push(h('button', {
              key: 'effort:' + effort.id,
              type: 'button',
              role: 'option',
              'aria-selected': selected,
              className: 'dsh-td-model-option' + (selected ? ' dsh-td-model-option-on' : ''),
              title: effort.description,
              onClick: () => chooseEffort(effort.id),
            },
              h('span', { className: 'dsh-td-model-option-main' },
                h('span', { className: 'dsh-td-model-option-name' }, effort.name),
                selected ? h('span', { className: 'dsh-td-model-check', 'aria-hidden': true }, '✓') : null),
              effort.description !== ''
                ? h('span', { className: 'dsh-td-model-option-meta' }, effort.description)
                : h('span', { className: 'dsh-td-model-option-meta' }, effort.id),
            ))
          }
        }
        return h('div', { className: 'dsh-td-model-pane' },
          h('div', { className: 'dsh-td-model-pop-head' },
            h('button', {
              type: 'button',
              className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text',
              onClick: () => { setPane('model'); setPending(null) },
            }, '← 模型'),
            h('span', { className: 'dsh-td-model-pop-title' }, model.label),
          ),
          h('div', { className: 'dsh-td-model-group-label' }, '推理强度'),
          rows.length > 0 ? rows : h('div', { className: 'dsh-td-hintline' }, '这个模型没有提供可选的推理强度。'),
        )
      }

      return h('div', {
        ref: rootRef,
        className: 'dsh-td-model-picker' + (open ? ' dsh-td-model-picker-open' : ''),
        onKeyDown: (event) => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation()
            close()
          }
        },
      },
        h('button', {
          type: 'button',
          className: 'dsh-td-model-trigger',
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          disabled: props.busy,
          title: triggerLabel + (currentEffortLabel !== '' ? ' · ' + currentEffortLabel : ''),
          onClick: () => {
            if (open) close()
            else {
              setPane('model')
              setPending(null)
              setOpen(true)
            }
          },
        },
          h('span', { className: 'dsh-td-model-trigger-main' }, triggerLabel),
          currentEffortLabel !== '' ? h('span', { className: 'dsh-td-model-effort-chip' }, currentEffortLabel) : null,
          h('span', { className: 'dsh-td-model-chevron', 'aria-hidden': true }, open ? '▴' : '▾'),
        ),
        open
          ? h('div', {
            className: 'dsh-td-model-pop',
            role: 'listbox',
            'aria-label': '选择模型与推理强度',
          }, pane === 'effort' ? renderEffortPane() : renderModelPane())
          : null,
      )
    }

    // =======================================================================
    // 9. Workspace column — cross-project progress from /workspaces.
    // =======================================================================
    function WorkspaceColumn(props) {
      const width = readWidth(props.width, DEFAULT_LEFT_WIDTH, MIN_LEFT_WIDTH, MAX_LEFT_WIDTH)
      const rows = []
      for (const item of props.items) {
        let progress = item.total > 0
          ? '已完成 ' + String(item.done) + '/' + String(item.total) + ' · 可开始 ' + String(item.readyCount)
          : '空图谱'
        if (item.failed > 0) progress += ' · 失败 ' + String(item.failed)
        if (item.doing > 0) progress += ' · 进行中 ' + String(item.doing)
        if (item.total > 0 && item.done === item.total) progress += ' · 全部完成'
        rows.push(h('button', {
          key: item.workspaceId,
          type: 'button',
          className: 'dsh-td-ws' + (item.workspaceId === props.currentId ? ' dsh-td-ws-active' : ''),
          title: item.path || item.workspaceId,
          onClick: () => props.onSelect(item.workspaceId),
        },
          h('span', { className: 'dsh-td-ws-name' }, item.title),
          h('span', { className: 'dsh-td-ws-meta' }, progress),
        ))
      }
      return h('aside', { className: 'dsh-td-col-left', style: { flexBasis: width + 'px' } },
        h('div', { className: 'dsh-td-col-head' },
          h('span', null, '项目'),
          props.fallback ? h(Chip, { kind: 'muted', title: 'Host 项目接口不可用，进度数据暂不可用' }, '本地模式') : null,
        ),
        h('div', { className: 'dsh-td-col-scroll' },
          props.phase === 'loading' && props.items.length === 0 ? h('div', { className: 'dsh-td-empty' }, '正在加载项目…') : null,
          props.phase === 'error' ? h('div', { className: 'dsh-td-empty' }, '项目列表加载失败') : null,
          rows.length > 0 ? rows : (props.phase === 'loading' ? null : h('div', { className: 'dsh-td-empty' }, '没有可用工作区')),
        ),
        h('div', { className: 'dsh-td-col-foot' },
          h('button', {
            type: 'button',
            className: 'dsh-td-btn dsh-td-btn-sm',
            onClick: props.onReload,
            disabled: props.phase === 'loading',
          }, props.phase === 'loading' ? '加载中…' : '刷新项目'),
        ),
      )
    }

    // =======================================================================
    // 10. SVG canvas — pan/zoom, node drag, edge drag, edge selection.
    // =======================================================================
    function NodeCard(props) {
      const node = props.node
      const position = props.position
      const model = props.model
      const facts = model.facts
      const sessions = node.sessions
      const active = activeSessionOf(node)
      const activeFact = active !== null && facts[active.sessionId] !== null && typeof facts[active.sessionId] === 'object'
        ? facts[active.sessionId]
        : null
      const running = activeFact !== null && activeFact.running === true
      const lines = titleLines(node.title)
      const status = STATUSES.indexOf(node.status) >= 0 ? node.status : 'todo'
      const isMilestone = model.milestoneNodeId === node.id
      const schedule = node.schedule !== null && typeof node.schedule === 'object' ? node.schedule : null
      const scheduled = schedule !== null && schedule.enabled === true
      const conditionList = model.conditions[node.id] || []
      const satisfiedCount = conditionList.filter((condition) => condition.satisfied).length
      const showReady = node.status === 'todo' && model.ready.has(node.id)
      const showBlocked = node.status === 'todo' && model.blocked.has(node.id)
      const badgeSlot = active !== null ? Number(active.slot) : sessions.length > 0 ? Number(sessions[sessions.length - 1].slot) : 0
      const classes = ['dsh-td-node']
      if (props.selected) classes.push('dsh-td-node-selected')
      if (showBlocked) classes.push('dsh-td-node-blocked')
      if (props.dimmed) classes.push('dsh-td-node-dim')
      if (props.emphasized) classes.push('dsh-td-node-emphasis')
      if (props.dragging) classes.push('dsh-td-node-dragging')
      if (status === 'failed') classes.push('dsh-td-node-failed')
      if (scheduled) classes.push('dsh-td-node-scheduled')
      if (isMilestone) classes.push('dsh-td-node-milestone')

      let meta = statusLabel(status)
      if (showReady) meta += ' · 可开始'
      else if (showBlocked) meta += ' · 受阻'
      if (conditionList.length > 0) meta += ' · 条件 ' + String(satisfiedCount) + '/' + String(conditionList.length)

      const tooltip = String(node.title || '未命名任务') + ' · ' + meta
        + (conditionList.length > 0
          ? ' · 前置条件 ' + conditionList.map((condition) => condition.title + (condition.satisfied ? '(已满足)' : '(未满足)')).join('、')
          : '')
        + (scheduled ? ' · 定时执行' : '')
        + (isMilestone ? ' · 项目里程碑' : '')
        + (sessions.length === 0
          ? ' · 无会话'
          : ' · 会话链 ' + String(sessions.length) + ' 段'
            + (active !== null ? '（当前第 ' + String(active.slot) + ' 段）' : '（无当前会话）'))

      const titleElements = []
      let titleY = lines.length === 1 ? 40 : 32
      for (let index = 0; index < lines.length; index += 1) {
        titleElements.push(h('text', {
          key: 'line' + String(index),
          className: 'dsh-td-node-title',
          x: 16,
          y: titleY,
        }, lines[index]))
        titleY += 20
      }

      const titleClipId = 'dsh-td-node-clip-' + idFragment(node.id)

      return h('g', {
        className: classes.join(' '),
        transform: 'translate(' + round1(position.x) + ' ' + round1(position.y) + ')',
        onPointerDown: (event) => props.onNodePointerDown(event, node),
        onDoubleClick: (event) => event.stopPropagation(),
      },
        h('title', null, tooltip),
        // Anything drawn inside this rounded rectangle is clipped to the card:
        // a title that still exceeds the fitted width (unusual fonts, zoomed
        // text) is cut off at the border instead of spilling over it.
        h('defs', null,
          h('clipPath', { id: titleClipId },
            h('rect', { x: 1, y: 1, width: NODE_W - 2, height: NODE_H - 2, rx: 9, ry: 9 })),
        ),
        h('rect', { className: 'dsh-td-node-bg', x: 0, y: 0, width: NODE_W, height: NODE_H, rx: 10, ry: 10 }),
        h('rect', {
          className: 'dsh-td-node-bar dsh-td-node-bar-' + status,
          x: 2,
          y: 14,
          width: 3.5,
          height: NODE_H - 28,
          rx: 1.75,
          ry: 1.75,
        }),
        h('g', { className: 'dsh-td-node-content', clipPath: 'url(#' + titleClipId + ')' },
          titleElements,
          h('text', { className: 'dsh-td-node-meta', x: 16, y: 68 }, meta),
          badgeSlot > 0
            ? h('text', { className: 'dsh-td-node-chain', x: NODE_W - 12, y: 68, textAnchor: 'end' }, circled(badgeSlot))
            : null,
          scheduled
            ? h('text', {
              className: 'dsh-td-node-flag',
              x: NODE_W - 12,
              y: 22,
              textAnchor: 'end',
            }, '⏱')
            : null,
        ),
        // The milestone marker lives just above the card and right-aligned with
        // it, so the card itself stays free for title/status content.
        isMilestone
          ? h('text', {
            className: 'dsh-td-node-flag dsh-td-node-milestone-flag',
            x: NODE_W,
            y: -7,
            textAnchor: 'end',
          }, '里程碑')
          : null,
        running ? h('circle', { className: 'dsh-td-breathe', cx: NODE_W - 12, cy: 45, r: 4.5 }) : null,
        h('line', { className: 'dsh-td-handle-line', x1: NODE_W - 4, y1: NODE_H / 2, x2: NODE_W + 1, y2: NODE_H / 2 }),
        h('circle', {
          className: 'dsh-td-handle',
          cx: NODE_W,
          cy: NODE_H / 2,
          r: 5,
          onPointerDown: (event) => props.onStartLink(event, node.id),
        }),
      )
    }

    function GraphCanvas(props) {
      const model = props.model
      const svgRef = useRef(null)
      const interactionRef = useRef(null)
      const latest = useRef({})
      const positionsRef = useRef({})
      const initialViewportRef = useRef(null)
      if (initialViewportRef.current === null) {
        const persistedViewport = readViewport(readPersisted())
        initialViewportRef.current = { viewport: persistedViewport, hadViewport: persistedViewport !== null }
      }
      const [viewport, setViewport] = useState(() => initialViewportRef.current.viewport || { x: 0, y: 0, scale: 1 })
      const [panning, setPanning] = useState(false)
      const [dragPos, setDragPos] = useState(null)
      const [linkCursor, setLinkCursor] = useState(null)
      const [lasso, setLasso] = useState(null)
      const [onlyReady, setOnlyReady] = useState(false)
      const fittedRef = useRef(false)
      const viewportRef = useRef(viewport)
      viewportRef.current = viewport

      latest.current = {
        model,
        viewport,
        layoutMode: props.layoutMode,
        selectedEdgeId: props.selectedEdgeId,
        onSelectNode: props.onSelectNode,
        onSelectEdge: props.onSelectEdge,
        onMoveNode: props.onMoveNode,
        onRequestLink: props.onRequestLink,
        onDeleteEdge: props.onDeleteEdge,
        onUndo: props.onUndo,
        onLasso: props.onLasso,
      }

      // Keep the optimistic drop frame until the Host snapshot confirms it.
      // Without this the node renders at its old model position for one frame
      // between pointer-up and the action response.
      useEffect(() => {
        if (dragPos === null || dragPos.phase !== 'drop') return undefined
        if (model.nodeById[dragPos.nodeId] === undefined) {
          setDragPos(null)
          return undefined
        }
        const confirmed = model.positions[dragPos.nodeId]
        if (confirmed !== undefined
          && Math.abs(confirmed.x - dragPos.x) <= 1
          && Math.abs(confirmed.y - dragPos.y) <= 1) {
          setDragPos(null)
          return undefined
        }
        const timer = setTimeout(() => setDragPos(null), 2500)
        return () => clearTimeout(timer)
      }, [dragPos, model])

      // -- viewport persistence (debounced; the object is tiny) -------------
      useEffect(() => {
        const timer = setTimeout(() => {
          writePersisted({
            viewport: {
              x: Math.round(viewport.x),
              y: Math.round(viewport.y),
              scale: Number(viewport.scale.toFixed(3)),
            },
          })
        }, 250)
        return () => clearTimeout(timer)
      }, [viewport])

      // Flush the newest viewport when the panel unmounts: navigating away
      // destroys the `main` slot, and the debounce timer alone would lose it.
      useEffect(() => () => {
        const current = viewportRef.current
        writePersisted({
          viewport: {
            x: Math.round(current.x),
            y: Math.round(current.y),
            scale: Number(current.scale.toFixed(3)),
          },
        })
      }, [])

      function toWorld(clientX, clientY, view) {
        const element = svgRef.current
        const rect = element !== null && element !== undefined ? element.getBoundingClientRect() : { left: 0, top: 0 }
        const scale = view !== null && view !== undefined && Number.isFinite(view.scale) && view.scale > 0 ? view.scale : 1
        return {
          x: (clientX - rect.left - (view !== null && view !== undefined ? view.x : 0)) / scale,
          y: (clientY - rect.top - (view !== null && view !== undefined ? view.y : 0)) / scale,
        }
      }

      function nodeAt(point) {
        const positions = positionsRef.current
        const nodes = latest.current.model.nodes
        for (let index = nodes.length - 1; index >= 0; index -= 1) {
          const node = nodes[index]
          const position = positions[node.id]
          if (position === undefined) continue
          if (point.x >= position.x && point.x <= position.x + NODE_W
            && point.y >= position.y && point.y <= position.y + NODE_H) return node.id
        }
        return null
      }

      function fitView() {
        const element = svgRef.current
        const rect = element !== null && element !== undefined ? element.getBoundingClientRect() : null
        const width = rect !== null && rect.width > 40 ? rect.width : 900
        const height = rect !== null && rect.height > 40 ? rect.height : 600
        const nodes = latest.current.model.nodes
        const positions = positionsRef.current
        if (nodes.length === 0) {
          setViewport({ x: 0, y: 0, scale: 1 })
          return
        }
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const node of nodes) {
          const position = positions[node.id]
          if (position === undefined) continue
          minX = Math.min(minX, position.x)
          minY = Math.min(minY, position.y)
          maxX = Math.max(maxX, position.x + NODE_W)
          maxY = Math.max(maxY, position.y + NODE_H)
        }
        if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
          setViewport({ x: 0, y: 0, scale: 1 })
          return
        }
        const pad = 44
        const contentWidth = maxX - minX + pad * 2
        const contentHeight = maxY - minY + pad * 2
        const scale = clamp(Math.min(width / contentWidth, height / contentHeight), MIN_SCALE, MAX_SCALE)
        setViewport({
          x: Math.round((width - contentWidth * scale) / 2 - (minX - pad) * scale),
          y: Math.round((height - contentHeight * scale) / 2 - (minY - pad) * scale),
          scale,
        })
      }

      function zoomAt(factor, originX, originY) {
        const element = svgRef.current
        const rect = element !== null && element !== undefined ? element.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 }
        const px = originX === undefined ? (rect.width || 800) / 2 : originX - rect.left
        const py = originY === undefined ? (rect.height || 600) / 2 : originY - rect.top
        setViewport((previous) => {
          const nextScale = clamp(previous.scale * factor, MIN_SCALE, MAX_SCALE)
          const ratio = nextScale / previous.scale
          return {
            scale: nextScale,
            x: px - (px - previous.x) * ratio,
            y: py - (py - previous.y) * ratio,
          }
        })
      }

      // -- first mount fit (only when no viewport was persisted) ------------
      useEffect(() => {
        if (fittedRef.current) return
        if (initialViewportRef.current.hadViewport) {
          fittedRef.current = true
          return
        }
        if (model.nodes.length === 0) return
        fittedRef.current = true
        fitView()
      }, [model])

      // -- global pointer handlers (drag / pan / link) ----------------------
      useEffect(() => {
        function onMove(event) {
          const interaction = interactionRef.current
          if (interaction === null) return
          if (interaction.kind === 'pan') {
            const dx = event.clientX - interaction.clientX
            const dy = event.clientY - interaction.clientY
            if (Math.abs(dx) + Math.abs(dy) > 2) interaction.moved = true
            setViewport({ x: interaction.viewport.x + dx, y: interaction.viewport.y + dy, scale: interaction.viewport.scale })
            return
          }
          if (interaction.kind === 'node') {
            const screenDelta = Math.abs(event.clientX - interaction.clientX)
              + Math.abs(event.clientY - interaction.clientY)
            if (screenDelta > 3) interaction.moved = true
            if (!interaction.moved) return
            const scale = interaction.viewport.scale || 1
            const dx = (event.clientX - interaction.clientX) / scale
            const dy = (event.clientY - interaction.clientY) / scale
            setDragPos({ nodeId: interaction.nodeId, x: interaction.origin.x + dx, y: interaction.origin.y + dy, phase: 'drag' })
            return
          }
          if (interaction.kind === 'link') {
            const point = toWorld(event.clientX, event.clientY, interaction.viewport)
            setLinkCursor({ from: interaction.from, x: point.x, y: point.y })
            return
          }
          if (interaction.kind === 'lasso') {
            const point = toWorld(event.clientX, event.clientY, latest.current.viewport)
            if (distanceBetween(point, interaction.last) < 2.5) return
            interaction.points.push(point)
            interaction.last = point
            setLasso(interaction.points.slice())
          }
        }

        function onUp(event) {
          const interaction = interactionRef.current
          interactionRef.current = null
          if (interaction === null) return
          const handlers = latest.current
          if (interaction.kind === 'pan') {
            setPanning(false)
            if (!interaction.moved) {
              handlers.onSelectNode(null)
              handlers.onSelectEdge(null)
            }
            return
          }
          if (interaction.kind === 'node') {
            if (!interaction.moved) {
              setDragPos(null)
              handlers.onSelectNode(interaction.nodeId)
              handlers.onSelectEdge(null)
              return
            }
            const scale = interaction.viewport.scale || 1
            const dx = (event.clientX - interaction.clientX) / scale
            const dy = (event.clientY - interaction.clientY) / scale
            const position = {
              x: Math.round(interaction.origin.x + dx),
              y: Math.round(interaction.origin.y + dy),
            }
            const model = handlers.model
            // Clear the optimistic final frame only once the Host snapshot has
            // arrived (or the action failed). Clearing it on pointer-up made the
            // node flash back to its old position for one render.
            const settlePending = (result) => {
              if (result === null || result === undefined || typeof result.then !== 'function') return
              const clearIfStillPending = () => {
                setDragPos((current) => (
                  current !== null
                    && current.nodeId === interaction.nodeId
                    && current.phase === 'drop'
                    ? null
                    : current
                ))
              }
              result.then((outcome) => {
                if (outcome === null || outcome === undefined || outcome.ok !== true
                  || outcome.snapshot === null || outcome.snapshot === undefined) {
                  clearIfStillPending()
                }
              }).catch(clearIfStillPending)
            }
            if (handlers.layoutMode === 'grid') {
              const snapped = snapDraggedNodeToGrid(
                model.positions,
                model.nodes,
                interaction.nodeId,
                position,
              )
              const assigned = gridAssignments(model.positions, model.nodes)
              assigned[interaction.nodeId] = snapped
              const displaced = model.nodes
                .filter((node) => node.id !== interaction.nodeId)
                .map((node) => ({ nodeId: node.id, position: assigned[node.id] }))
              setDragPos({ nodeId: interaction.nodeId, x: snapped.x, y: snapped.y, phase: 'drop' })
              settlePending(handlers.onMoveNode(interaction.nodeId, snapped, displaced, interaction.beforePositions))
              return
            }
            const resolution = resolveNodeLayout(
              model.positions,
              model.nodes.map((node) => node.id),
              interaction.nodeId,
              position,
            )
            const displaced = Object.keys(resolution.moved)
              .map((nodeId) => ({ nodeId, position: resolution.moved[nodeId] }))
            setDragPos({ nodeId: interaction.nodeId, x: position.x, y: position.y, phase: 'drop' })
            settlePending(handlers.onMoveNode(interaction.nodeId, position, displaced, interaction.beforePositions))
            return
          }
          if (interaction.kind === 'lasso') {
            const points = interaction.points
            setLasso(null)
            if (points.length < 3) {
              handlers.onLasso([])
              return
            }
            handlers.onLasso(nodesFullyInside(points))
            return
          }
          if (interaction.kind === 'link') {
            const point = toWorld(event.clientX, event.clientY, interaction.viewport)
            const target = nodeAt(point)
            setLinkCursor(null)
            // The condition chooser opens next; the POST happens only after the
            // user picks (or names) the condition to satisfy.
            if (target !== null && target !== interaction.from) handlers.onRequestLink(interaction.from, target)
          }
        }

        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
        return () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
        }
      }, [])

      // -- wheel zoom (native listener: React wheel handlers are passive) --
      useEffect(() => {
        const element = svgRef.current
        if (element === null || element === undefined) return undefined
        function onWheel(event) {
          event.preventDefault()
          const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
          const factor = Math.exp(-event.deltaY * unit * 0.0015)
          zoomAt(factor, event.clientX, event.clientY)
        }
        element.addEventListener('wheel', onWheel, { passive: false })
        return () => element.removeEventListener('wheel', onWheel)
      }, [])

      // -- keyboard: Escape clears, Delete removes the selected edge --------
      useEffect(() => {
        function onKeyDown(event) {
          const target = event.target
          const tagName = target !== null && target !== undefined && typeof target.tagName === 'string'
            ? target.tagName.toLowerCase()
            : ''
          if (tagName === 'input' || tagName === 'textarea'
            || (target !== null && target !== undefined && target.isContentEditable === true)) return
          const handlers = latest.current
          if (event.key === 'Escape') {
            if (interactionRef.current !== null && interactionRef.current.kind === 'lasso') {
              interactionRef.current = null
              setLasso(null)
              return
            }
            handlers.onSelectEdge(null)
            handlers.onSelectNode(null)
            if (typeof handlers.onSelectGroup === 'function') handlers.onSelectGroup(null)
            return
          }
          if ((event.ctrlKey || event.metaKey) && event.shiftKey !== true
            && (event.key === 'z' || event.key === 'Z')) {
            event.preventDefault()
            if (typeof handlers.onUndo === 'function') handlers.onUndo()
            return
          }
          if ((event.key === 'Delete' || event.key === 'Backspace') && typeof handlers.selectedEdgeId === 'string') {
            event.preventDefault()
            handlers.onDeleteEdge(handlers.selectedEdgeId)
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [])

      function startPan(event) {
        if (event.button !== 0) return
        // Alt + left drag draws a lasso instead of panning: the released shape
        // selects every node it fully encloses.
        if (event.altKey) {
          startLasso(event)
          return
        }
        const view = latest.current.viewport
        interactionRef.current = {
          kind: 'pan',
          clientX: event.clientX,
          clientY: event.clientY,
          viewport: { x: view.x, y: view.y, scale: view.scale },
          moved: false,
        }
        setPanning(true)
      }

      function startLasso(event) {
        event.preventDefault()
        const point = toWorld(event.clientX, event.clientY, latest.current.viewport)
        interactionRef.current = {
          kind: 'lasso',
          points: [point],
          last: point,
        }
        setLasso([point])
      }

      /** Nodes whose whole card is inside the closed hand-drawn polygon. */
      function nodesFullyInside(polygon) {
        const positions = positionsRef.current
        const nodes = latest.current.model.nodes
        const selected = []
        for (const node of nodes) {
          const position = positions[node.id]
          if (position === undefined) continue
          if (rectFullyInsidePolygon(nodeRect(position), polygon)) selected.push(node.id)
        }
        return selected
      }

      function startNodeDrag(event, node) {
        if (event.button !== 0) return
        if (event.altKey) {
          // The lasso may start on top of a card as well as on empty canvas.
          event.stopPropagation()
          startLasso(event)
          return
        }
        event.stopPropagation()
        event.preventDefault()
        const origin = positionsRef.current[node.id]
        if (origin === undefined) return
        const view = latest.current.viewport
        // Snapshot what the user sees now, so undoing the drop restores this
        // exact arrangement (including the nodes the drag displaced).
        const beforePositions = {}
        for (const nodeId of Object.keys(positionsRef.current)) {
          const point = positionsRef.current[nodeId]
          beforePositions[nodeId] = { x: point.x, y: point.y }
        }
        interactionRef.current = {
          kind: 'node',
          nodeId: node.id,
          clientX: event.clientX,
          clientY: event.clientY,
          origin: { x: origin.x, y: origin.y },
          viewport: { x: view.x, y: view.y, scale: view.scale },
          moved: false,
          beforePositions,
        }
      }

      function startLinkDrag(event, nodeId) {
        if (event.button !== 0) return
        if (event.altKey) {
          event.stopPropagation()
          startLasso(event)
          return
        }
        event.stopPropagation()
        event.preventDefault()
        const view = latest.current.viewport
        const origin = positionsRef.current[nodeId]
        interactionRef.current = {
          kind: 'link',
          from: nodeId,
          viewport: { x: view.x, y: view.y, scale: view.scale },
        }
        const point = toWorld(event.clientX, event.clientY, view)
        setLinkCursor({
          from: nodeId,
          x: origin === undefined ? point.x : origin.x + NODE_W,
          y: origin === undefined ? point.y : origin.y + NODE_H / 2,
        })
      }

      function handleDoubleClick(event) {
        const point = toWorld(event.clientX, event.clientY, latest.current.viewport)
        props.onCreateNode({ x: Math.round(point.x - NODE_W / 2), y: Math.round(point.y - NODE_H / 2) })
      }

      function createAtCenter() {
        const element = svgRef.current
        const rect = element !== null && element !== undefined ? element.getBoundingClientRect() : null
        const centre = rect !== null && rect.width > 0 && rect.height > 0
          ? toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2, latest.current.viewport)
          : { x: 160, y: 120 }
        props.onCreateNode({ x: Math.round(centre.x - NODE_W / 2), y: Math.round(centre.y - NODE_H / 2) })
      }

      // -- derived rendering data -------------------------------------------
      let positions
      if (props.layoutMode === 'grid') {
        positions = gridAssignments(model.positions, model.nodes)
        if (dragPos !== null) {
          // While the pointer is down the card must follow it continuously; the
          // grid snap happens on pointer-up (the drop frame is already snapped).
          positions[dragPos.nodeId] = { x: dragPos.x, y: dragPos.y }
        }
      } else {
        positions = Object.assign({}, model.positions)
        if (dragPos !== null) {
          const resolution = resolveNodeLayout(
            model.positions,
            model.nodes.map((node) => node.id),
            dragPos.nodeId,
            dragPos,
          )
          positions = Object.assign(positions, resolution.positions)
        }
      }
      positionsRef.current = positions

      const groupShapes = groupOutlineShapes(model.groups, positions)
      const lassoHits = lasso !== null ? nodesFullyInside(lasso) : []
      const lassoPath = lasso !== null ? closedPolylinePath(lasso) : ''

      // Node rectangles padded by the routing clearance. Other nodes use the
      // padded rectangle; the edge's own two endpoints use the exact rectangle
      // so the line may touch the handles but may never cut through its own
      // cards (important when the target sits to the left of the source).
      const softObstacleRects = []
      const hardObstacleRects = []
      for (const node of model.nodes) {
        const position = positions[node.id]
        if (position === undefined) continue
        const exact = nodeRect(position)
        hardObstacleRects.push(Object.assign({ nodeId: node.id }, exact))
        softObstacleRects.push(Object.assign(
          { nodeId: node.id },
          inflateRect(exact, EDGE_CLEARANCE),
        ))
      }

      // Every edge is routed together so each curve can steer clear of the
      // previously routed ones; the result is a pure cubic chain, never an
      // orthogonal segment.
      const edgePaths = routeEdgeSet(model.edges, positions, softObstacleRects, hardObstacleRects)
      const edgeElements = []
      for (const edge of model.edges) {
        const fromPos = positions[edge.from]
        const toPos = positions[edge.to]
        if (fromPos === undefined || toPos === undefined) continue
        const path = edgePaths[edge.id]
        if (typeof path !== 'string' || path === '') continue
        const active = props.selectedEdgeId === edge.id
        const dimmed = onlyReady && !model.ready.has(edge.from) && !model.ready.has(edge.to)
        edgeElements.push(h('g', { key: 'edge:' + edge.id, className: 'dsh-td-edge-group' },
          h('path', {
            className: 'dsh-td-edge-hit',
            d: path,
            onPointerDown: (event) => {
              event.stopPropagation()
              if (event.altKey) {
                startLasso(event)
                return
              }
              props.onSelectEdge(edge.id)
            },
          }),
          h('path', {
            className: 'dsh-td-edge' + (active ? ' dsh-td-edge-active' : ''),
            d: path,
            markerEnd: active ? 'url(#dsh-td-arrow-active)' : 'url(#dsh-td-arrow)',
            opacity: dimmed ? 0.15 : 1,
            'data-edge-id': edge.id,
          }),
        ))
      }

      const nodeElements = []
      for (const node of model.nodes) {
        const position = positions[node.id]
        if (position === undefined) continue
        nodeElements.push(h(NodeCard, {
          key: 'node:' + node.id,
          node,
          position,
          model,
          selected: props.selectedNodeId === node.id,
          dimmed: onlyReady && !model.ready.has(node.id),
          emphasized: onlyReady && model.ready.has(node.id),
          dragging: dragPos !== null && dragPos.nodeId === node.id,
          onNodePointerDown: startNodeDrag,
          onStartLink: startLinkDrag,
        }))
      }

      // Group contours sit behind edges and cards: they are a container, not a
      // hit target on top of the graph. The wide transparent stroke picks the
      // group up when the dashed contour itself is clicked.
      const groupElements = []
      for (const shape of groupShapes) {
        const selected = props.selectedGroupId === shape.group.id
        groupElements.push(h('g', {
          key: 'group:' + shape.group.id,
          className: 'dsh-td-group' + (selected ? ' dsh-td-group-selected' : ''),
        },
          h('path', { className: 'dsh-td-group-outline', d: shape.d, fillRule: 'evenodd' }),
          h('path', {
            className: 'dsh-td-group-hit',
            d: shape.d,
            onPointerDown: (event) => {
              event.stopPropagation()
              if (event.altKey) {
                startLasso(event)
                return
              }
              if (typeof props.onSelectGroup === 'function') props.onSelectGroup(shape.group.id)
            },
          }),
          h('text', {
            className: 'dsh-td-group-label',
            x: round1(shape.bounds.left + GROUP_LABEL_PAD),
            y: round1(shape.bounds.top + 16),
          }, shape.group.name),
        ))
      }

      const lassoElement = lassoPath === ''
        ? null
        : h('g', { className: 'dsh-td-lasso-layer' },
          h('path', { className: 'dsh-td-lasso', d: lassoPath }),
          h('text', {
            className: 'dsh-td-lasso-count',
            x: round1(lasso[0].x + 12),
            y: round1(lasso[0].y - 10),
          }, '完全包含 ' + String(lassoHits.length) + ' 个节点'))

      let ghostEdge = null
      if (linkCursor !== null) {
        const fromPos = positions[linkCursor.from]
        if (fromPos !== undefined) {
          ghostEdge = h('path', {
            className: 'dsh-td-ghost-edge',
            d: curvePath(
              { x: fromPos.x + NODE_W, y: fromPos.y + NODE_H / 2 },
              { x: linkCursor.x, y: linkCursor.y },
            ),
          })
        }
      }

      const selectedEdge = props.selectedEdgeId === null
        ? null
        : model.edges.find((edge) => edge.id === props.selectedEdgeId) || null
      let edgeBar = null
      if (selectedEdge !== null) {
        const fromNode = model.nodeById[selectedEdge.from]
        const toNode = model.nodeById[selectedEdge.to]
        const conditionTitle = conditionTitleOf(model, selectedEdge)
        edgeBar = h('div', { className: 'dsh-td-edgebar' },
          h('span', { className: 'dsh-td-hintline' },
            '前置条件：' + (conditionTitle !== '' ? conditionTitle : '（未命名条件）')
            + ' · ' + (fromNode !== undefined ? fromNode.title : selectedEdge.from)
            + ' → ' + (toNode !== undefined ? toNode.title : selectedEdge.to)),
          h('button', {
            type: 'button',
            className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-danger',
            onClick: () => props.onDeleteEdge(selectedEdge.id),
          }, '解除关联'),
          h('button', {
            type: 'button',
            className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text',
            onClick: () => props.onSelectEdge(null),
          }, '取消'),
        )
      }

      const selectedGroup = props.selectedGroupId === null || props.selectedGroupId === undefined
        ? null
        : model.groups.find((group) => group.id === props.selectedGroupId) || null
      let groupBar = null
      if (selectedGroup !== null) {
        groupBar = h('div', { className: 'dsh-td-edgebar' },
          h('span', { className: 'dsh-td-hintline' },
            '组合：' + selectedGroup.name + ' · ' + String(selectedGroup.nodeIds.length) + ' 个节点'),
          h('button', {
            type: 'button',
            className: 'dsh-td-btn dsh-td-btn-sm',
            onClick: () => props.onRenameGroup(selectedGroup.id),
          }, '重命名'),
          h('button', {
            type: 'button',
            className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-danger',
            onClick: () => props.onDeleteGroup(selectedGroup.id),
          }, '解散组合'),
          h('button', {
            type: 'button',
            className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text',
            onClick: () => props.onSelectGroup(null),
          }, '取消'),
        )
      }

      const zoomText = String(Math.round(viewport.scale * 100)) + '%'
      const gridLayer = props.layoutMode === 'grid'
        ? h('rect', {
          className: 'dsh-td-grid-bg',
          x: -20000,
          y: -20000,
          width: 40000,
          height: 40000,
          fill: 'url(#dsh-td-grid-pattern)',
        })
        : null

      return h('div', { className: 'dsh-td-canvas' },
        h('svg', {
          ref: svgRef,
          className: 'dsh-td-svg' + (panning ? ' dsh-td-svg-panning' : ''),
          onPointerDown: startPan,
        },
          h('defs', null,
            h('marker', {
              id: 'dsh-td-arrow',
              viewBox: '0 0 8 8',
              refX: 7,
              refY: 4,
              markerWidth: 8,
              markerHeight: 8,
              markerUnits: 'userSpaceOnUse',
              orient: 'auto',
            }, h('path', { className: 'dsh-td-arrowhead', d: 'M0 0 L8 4 L0 8 Z' })),
            h('marker', {
              id: 'dsh-td-arrow-active',
              viewBox: '0 0 8 8',
              refX: 7,
              refY: 4,
              markerWidth: 8,
              markerHeight: 8,
              markerUnits: 'userSpaceOnUse',
              orient: 'auto',
            }, h('path', { className: 'dsh-td-arrowhead-active', d: 'M0 0 L8 4 L0 8 Z' })),
            props.layoutMode === 'grid'
              ? h('pattern', {
                id: 'dsh-td-grid-pattern',
                x: GRID_X0,
                y: GRID_Y0,
                width: GRID_W,
                height: GRID_H,
                patternUnits: 'userSpaceOnUse',
              }, h('rect', {
                className: 'dsh-td-grid-cell',
                x: 0,
                y: 0,
                width: GRID_W,
                height: GRID_H,
              }))
              : null,
          ),
          h('rect', {
            className: 'dsh-td-canvas-bg',
            x: 0,
            y: 0,
            width: '100%',
            height: '100%',
            onDoubleClick: handleDoubleClick,
          }),
          h('g', { transform: 'translate(' + round1(viewport.x) + ' ' + round1(viewport.y) + ') scale(' + viewport.scale + ')' },
            gridLayer,
            groupElements,
            edgeElements,
            ghostEdge,
            nodeElements,
            lassoElement,
          ),
        ),
        h('div', { className: 'dsh-td-toolbar' },
          h('button', { type: 'button', className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-primary', onClick: createAtCenter }, '新建节点'),
          h('button', {
            type: 'button',
            className: 'dsh-td-btn dsh-td-btn-sm' + (props.layoutMode === 'grid' ? ' dsh-td-btn-on' : ''),
            title: props.layoutMode === 'grid'
              ? '布局模式：网格布局（黄金比例网格，节点中心吸附）。点击切换到自由布局'
              : '布局模式：自由布局。点击切换到网格布局（黄金比例网格，节点中心吸附）',
            onClick: props.onToggleLayoutMode,
          }, props.layoutMode === 'grid' ? '布局模式：网格' : '布局模式：自由'),
          h('button', { type: 'button', className: 'dsh-td-btn dsh-td-btn-sm', onClick: props.onAutoLayout }, '自动布局'),
          h('button', {
            type: 'button',
            className: 'dsh-td-btn dsh-td-btn-sm',
            disabled: props.canUndo !== true,
            title: props.canUndo === true
              ? '撤销上一次拖动或自动布局（Ctrl+Z）'
              : '没有可撤销的拖动或自动布局',
            onClick: () => {
              if (typeof props.onUndo === 'function') props.onUndo()
            },
          }, '撤销'),
          h('button', { type: 'button', className: 'dsh-td-btn dsh-td-btn-sm', onClick: fitView }, '适配'),
          h('button', {
            type: 'button',
            className: 'dsh-td-btn dsh-td-btn-sm' + (onlyReady ? ' dsh-td-btn-on' : ''),
            title: '只突出当前可以开始的节点',
            onClick: () => setOnlyReady((value) => !value),
          }, '只看可做'),
          h('button', { type: 'button', className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text', onClick: () => zoomAt(1 / 1.2) }, '−'),
          h('span', { className: 'dsh-td-zoom' }, zoomText),
          h('button', { type: 'button', className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text', onClick: () => zoomAt(1.2) }, '＋'),
        ),
        h('div', { className: 'dsh-td-canvas-hint' },
          '滚轮缩放 · 拖背景平移 · 拖节点移动 · 双击空白新建 · 从节点右侧圆点拖到另一个节点选择前置条件'
          + ' · Alt+左键圈选节点成组 · Ctrl+Z 撤销拖动/自动布局'),
        edgeBar,
        groupBar,
      )
    }

    // =======================================================================
    // 11. Detail drawer — node editing, prerequisites, settings, session chain.
    // =======================================================================
    // The condition chooser appears after a drag from a node's right handle to
    // another node: the user picks which prerequisite of the target the source
    // satisfies (or names a new one). Only then is `link` posted.
    function LinkConditionDialog(props) {
      const model = props.model
      const fromNode = model.nodeById[props.from]
      const toNode = model.nodeById[props.to]
      const conditions = model.conditions[props.to] || []
      const defaultTitle = (fromNode !== undefined ? fromNode.title : props.from) + ' 完成'
      const [selectedId, setSelectedId] = useState('')
      const [newTitle, setNewTitle] = useState(defaultTitle)
      const [submitting, setSubmitting] = useState(false)

      useEffect(() => {
        function onKeyDown(event) {
          if (event.key === 'Escape') props.onCancel()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [props.onCancel])

      async function confirm() {
        if (submitting) return
        const payload = { from: props.from, to: props.to }
        if (selectedId !== '') {
          payload.conditionId = selectedId
        } else {
          const title = newTitle.trim()
          if (title === '') return
          payload.conditionTitle = title
        }
        setSubmitting(true)
        try {
          const result = await props.onConfirm(payload)
          if (result !== null && result !== undefined && result.ok === true) props.onDone()
        } finally {
          setSubmitting(false)
        }
      }

      const conditionOptions = conditions.map((condition) => h('button', {
        key: condition.id,
        type: 'button',
        className: 'dsh-td-option' + (selectedId === condition.id ? ' dsh-td-option-on' : ''),
        onClick: () => setSelectedId(condition.id),
      },
        h('div', { className: 'dsh-td-option-main' },
          h(StatusDot, { status: condition.satisfied ? 'done' : 'todo' }),
          h('span', { className: 'dsh-td-cond-title' }, condition.title),
          h(Chip, { kind: condition.satisfied ? 'success' : 'warn' }, condition.satisfied ? '已满足' : '未满足'),
        ),
        h('div', { className: 'dsh-td-option-meta' },
          condition.linked.length === 0
            ? '还没有关联节点'
            : '关联：' + condition.linked.map((link) => link.title + '（' + statusLabel(link.status) + '）').join('、')),
      ))

      return h('div', { className: 'dsh-td-link-layer' },
        h('div', {
          className: 'dsh-td-link-card',
          role: 'dialog',
          'aria-label': '选择前置条件',
        },
          h('div', { className: 'dsh-td-link-head' },
            h('div', null,
              h('div', { className: 'dsh-td-link-title' }, '选择前置条件'),
              h('div', { className: 'dsh-td-link-sub' },
                (fromNode !== undefined ? fromNode.title : props.from) + ' 完成后，满足 '
                + (toNode !== undefined ? toNode.title : props.to) + ' 的哪个前置条件？')),
            h('button', {
              type: 'button',
              className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text dsh-td-close',
              title: '取消',
              onClick: props.onCancel,
            }, '×'),
          ),
          h('div', { className: 'dsh-td-link-sub' },
            '同一个目标节点可以有多条不同条件的入边；同一条件只能连一次。'),
          h('div', { className: 'dsh-td-link-list' },
            conditionOptions.length > 0
              ? conditionOptions
              : h('div', { className: 'dsh-td-hintline' }, '目标节点还没有前置条件，直接在下面新建一个。'),
          ),
          h('div', { className: 'dsh-td-option' + (selectedId === '' ? ' dsh-td-option-on' : '') },
            h('div', { className: 'dsh-td-option-main' },
              h('span', { className: 'dsh-td-label' }, '新建条件'),
              h('input', {
                className: 'dsh-td-input dsh-td-grow',
                type: 'text',
                value: newTitle,
                disabled: submitting,
                onFocus: () => setSelectedId(''),
                onChange: (event) => {
                  setSelectedId('')
                  setNewTitle(event.target.value)
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    confirm()
                  }
                },
              }),
            ),
            h('div', { className: 'dsh-td-option-meta' }, '默认标题是「来源节点 完成」，可以改成更具体的验收条件。'),
          ),
          h('div', { className: 'dsh-td-link-foot' },
            h('button', {
              type: 'button',
              className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text',
              onClick: props.onCancel,
            }, '取消'),
            h('button', {
              type: 'button',
              className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-primary',
              disabled: submitting || (selectedId === '' && newTitle.trim() === ''),
              onClick: confirm,
            }, submitting ? '添加中…' : '确认添加前置条件'),
          ),
        ),
      )
    }

    /**
     * Group naming dialog: opens after a lasso encloses at least two nodes, and
     * again when the selected group is renamed. Confirming is the only way a
     * group is created or renamed, so the dashed contour never appears with an
     * empty name.
     */
    function GroupNameDialog(props) {
      const creating = props.mode !== 'rename'
      const [name, setName] = useState(typeof props.initialName === 'string' ? props.initialName : '')
      const [submitting, setSubmitting] = useState(false)

      useEffect(() => {
        function onKeyDown(event) {
          if (event.key === 'Escape') props.onCancel()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [props.onCancel])

      async function confirm() {
        if (submitting) return
        const trimmed = name.trim()
        if (trimmed === '') return
        setSubmitting(true)
        try {
          const result = await props.onConfirm(trimmed)
          if (result !== null && result !== undefined && result.ok === true) props.onDone()
        } finally {
          setSubmitting(false)
        }
      }

      return h('div', { className: 'dsh-td-link-layer' },
        h('div', {
          className: 'dsh-td-link-card',
          role: 'dialog',
          'aria-label': creating ? '给组合命名' : '重命名组合',
        },
          h('div', { className: 'dsh-td-link-head' },
            h('div', null,
              h('div', { className: 'dsh-td-link-title' }, creating ? '给选中的节点组合命名' : '重命名组合'),
              h('div', { className: 'dsh-td-link-sub' }, creating
                ? '已完全包含 ' + String(props.nodeCount) + ' 个节点（仅相交的不计入）。确认后在它们外围画一圈对齐布局网格的虚线轮廓。'
                : '新名称会显示在虚线轮廓的左上角。')),
            h('button', {
              type: 'button',
              className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text dsh-td-close',
              title: '取消',
              onClick: props.onCancel,
            }, '×'),
          ),
          h('input', {
            className: 'dsh-td-input',
            type: 'text',
            value: name,
            disabled: submitting,
            maxLength: 60,
            placeholder: '例如：前端改造',
            onChange: (event) => setName(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                confirm()
              }
            },
          }),
          creating && props.hasExistingMembers === true
            ? h('div', { className: 'dsh-td-hintline' },
              '部分节点已在别的组合里：确认后它们会从原组合移出，原组合空了自动消失。')
            : null,
          h('div', { className: 'dsh-td-link-foot' },
            h('button', {
              type: 'button',
              className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text',
              onClick: props.onCancel,
            }, '取消'),
            h('button', {
              type: 'button',
              className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-primary',
              disabled: submitting || name.trim() === '',
              onClick: confirm,
            }, submitting ? '保存中…' : creating ? '创建组合' : '保存名称'),
          ),
        ),
      )
    }

    /** First free「组合 N」suggestion, so the dialog opens with a usable name. */
    function nextGroupName(groups) {
      const used = new Set((Array.isArray(groups) ? groups : []).map((group) => group.name))
      let index = (Array.isArray(groups) ? groups.length : 0) + 1
      while (used.has('组合 ' + String(index))) index += 1
      return '组合 ' + String(index)
    }

    function SessionRow(props) {
      const session = props.session
      const active = props.active
      const fact = props.fact
      const archived = props.archived
      const title = fact !== null && typeof fact.title === 'string' && fact.title !== ''
        ? fact.title
        : typeof session.titleSnapshot === 'string' && session.titleSnapshot !== ''
          ? session.titleSnapshot
          : shortSessionId(session.sessionId)
      const running = fact !== null && fact.running === true
      const unavailable = fact !== null && fact.available === false
      const blank = fact !== null && fact.blank === true
      const handoffMode = session.handoff !== null && typeof session.handoff === 'object' ? session.handoff.mode : null
      const when = active
        ? '挂接于 ' + (formatTime(session.attachedAt) || '未知时间')
        : (formatTime(session.retiredAt) || '退休时间未知')

      const metaParts = [
        active ? '当前会话' : '已交接，可切回',
        '第 ' + String(session.slot) + ' 段',
        when,
      ]
      if (blank) metaParts.push('空会话')
      const modeText = modeLabel(handoffMode)
      if (modeText !== '') metaParts.push(modeText)

      return h('div', { className: 'dsh-td-row' + (active ? ' dsh-td-row-active' : ' dsh-td-row-muted') },
        h('div', { className: 'dsh-td-row-main' },
          h('div', { className: 'dsh-td-row-title' + (active ? '' : ' dsh-td-row-title-muted') },
            h('span', null, circled(session.slot) + ' ' + title),
            running ? h('span', { className: 'dsh-td-presence', title: '会话正在运行' }) : null,
            archived ? h(Chip, { kind: 'muted' }, '已归档') : null,
            unavailable ? h(Chip, { kind: 'muted', title: '网关里找不到这个会话' }, '不可用') : null,
          ),
          h('div', { className: 'dsh-td-row-meta', title: metaParts.join(' · ') }, metaParts.join(' · ')),
        ),
        h('div', { className: 'dsh-td-row-actions' },
          active ? null : h('button', {
            type: 'button',
            className: 'dsh-td-btn dsh-td-btn-sm',
            disabled: props.busy,
            title: '把这个会话恢复为当前会话，当前会话自动退休',
            onClick: () => props.onSwitch(session.sessionId),
          }, '切回'),
          h('button', {
            type: 'button',
            className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text',
            disabled: unavailable,
            title: unavailable ? '会话不可用' : '在对话面板里打开这个会话',
            onClick: () => props.onOpen(session.sessionId),
          }, '打开'),
          h('button', {
            type: 'button',
            className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text',
            disabled: props.busy,
            title: '只从会话链里移除记录，不归档会话',
            onClick: () => props.onDetach(session.sessionId),
          }, '摘除'),
        ),
      )
    }

    function ContextMeter(props) {
      const fact = props.fact
      const pressure = fact !== null && fact.contextPressure !== null && typeof fact.contextPressure === 'object'
        ? fact.contextPressure
        : null
      let ratio = null
      let projected = null
      let windowSize = null
      if (pressure !== null) {
        const projectedRaw = Number(pressure.projectedTokens)
        const pressureRaw = Number(pressure.pressureTokens)
        projected = Number.isFinite(projectedRaw)
          ? projectedRaw
          : Number.isFinite(pressureRaw)
            ? pressureRaw
            : null
        windowSize = Number.isFinite(Number(pressure.contextWindow)) ? Number(pressure.contextWindow) : null
        if (Number.isFinite(Number(pressure.ratio))) ratio = Number(pressure.ratio)
        else if (projected !== null && windowSize !== null && windowSize > 0) ratio = projected / windowSize
      }
      if (ratio === null) {
        return h('div', { className: 'dsh-td-field' },
          h('span', { className: 'dsh-td-label' }, '上下文水位'),
          h('div', { className: 'dsh-td-hintline' }, '暂无上下文数据。'),
        )
      }
      const percent = Math.round(clamp(ratio, 0, 1) * 100)
      const fillClass = ratio >= 0.85
        ? 'dsh-td-meter-fill dsh-td-meter-danger'
        : ratio >= HANDOFF_THRESHOLD
          ? 'dsh-td-meter-fill dsh-td-meter-warn'
          : 'dsh-td-meter-fill'
      const tokens = projected !== null && windowSize !== null
        ? '~' + formatTokenCount(projected) + ' / ' + formatTokenCount(windowSize)
        : ''
      return h('div', { className: 'dsh-td-field' },
        h('div', { className: 'dsh-td-section-head' },
          h('span', { className: 'dsh-td-label' }, '上下文水位'),
          h('span', { className: 'dsh-td-section-note' }, String(percent) + '%'),
          ratio >= HANDOFF_THRESHOLD ? h(Chip, { kind: 'warn' }, '建议交接') : null,
        ),
        h('div', { className: 'dsh-td-meter' },
          h('div', { className: fillClass, style: { width: Math.max(2, Math.min(100, percent)) + '%' } }),
        ),
        tokens !== '' ? h('div', { className: 'dsh-td-hintline' }, tokens) : null,
        ratio >= HANDOFF_THRESHOLD
          ? h('div', { className: 'dsh-td-hintline' }, '接近上限，建议交接新会话。')
          : null,
      )
    }

    function NodePane(props) {
      const node = props.node
      const model = props.model
      const facts = model.facts
      const sessions = sortedSessions(node)
      const active = activeSessionOf(node)
      const activeFact = active !== null && facts[active.sessionId] !== null && typeof facts[active.sessionId] === 'object'
        ? facts[active.sessionId]
        : null
      const prerequisites = model.incoming[node.id] || []
      const successors = model.outgoing[node.id] || []
      const conditions = model.conditions[node.id] || []
      const satisfiedConditionCount = conditions.filter((condition) => condition.satisfied).length
      const catalog = props.catalog !== null && typeof props.catalog === 'object'
        ? props.catalog
        : { phase: 'idle', presets: [], models: [], warnings: [] }
      const presets = Array.isArray(catalog.presets) ? catalog.presets : []
      const models = Array.isArray(catalog.models) ? catalog.models : []
      const catalogWarnings = Array.isArray(catalog.warnings) ? catalog.warnings : []
      const schedule = node.schedule !== null && typeof node.schedule === 'object' ? node.schedule : null
      const scheduleEnabled = schedule !== null && schedule.enabled === true
      const isMilestone = model.milestoneNodeId === node.id
      const titleRef = useRef(null)

      const [title, setTitle] = useState(node.title)
      const [notes, setNotes] = useState(typeof node.notes === 'string' ? node.notes : '')
      const [attachOpen, setAttachOpen] = useState(false)
      const [attachCandidates, setAttachCandidates] = useState(null)
      const [manualId, setManualId] = useState('')
      const [deleteOpen, setDeleteOpen] = useState(false)
      const [archiveOnDelete, setArchiveOnDelete] = useState(false)
      const [deleteMode, setDeleteMode] = useState('splice')
      const [archiveOpen, setArchiveOpen] = useState(false)
      const [conditionTitle, setConditionTitle] = useState('')
      const [editingConditionId, setEditingConditionId] = useState(null)
      const [editingConditionTitle, setEditingConditionTitle] = useState('')
      const [cronDraft, setCronDraft] = useState(
        schedule !== null && typeof schedule.cron === 'string' ? schedule.cron : '',
      )
      const [failPrompt, setFailPrompt] = useState(false)
      const [notesMode, setNotesMode] = useState('edit')
      const [notesHeight, setNotesHeight] = useState(() => readNotesHeight(readPersisted()))
      const notesRef = useRef(null)
      const notesDragRef = useRef(null)
      const notesHeightRef = useRef(notesHeight)
      notesHeightRef.current = notesHeight

      // -- draft saving -----------------------------------------------------
      // Every editable text field keeps its newest typed value in a ref and
      // saves after a short pause, on blur, and before the drawer switches to
      // another node. Clicking another node cancels the browser's focus change
      // (the canvas calls preventDefault on pointerdown), so only the explicit
      // flush is able to save the edit in that path.
      const nodeRef = useRef(node)
      nodeRef.current = node
      const deletedRef = useRef(false)
      const draftsRef = useRef(null)
      if (draftsRef.current === null) {
        draftsRef.current = {
          title: {
            value: typeof node.title === 'string' ? node.title : '',
            dirty: false,
            pending: false,
            timer: null,
            version: 0,
          },
          notes: {
            value: typeof node.notes === 'string' ? node.notes : '',
            dirty: false,
            pending: false,
            timer: null,
            version: 0,
          },
          cron: {
            value: schedule !== null && typeof schedule.cron === 'string' ? schedule.cron : '',
            dirty: false,
            pending: false,
            timer: null,
            version: 0,
          },
          condition: { value: '', dirty: false, pending: false, timer: null, version: 0, id: null },
        }
      }
      const flushAllDraftsRef = useRef(null)
      flushAllDraftsRef.current = () => flushAllDrafts(true)

      useEffect(() => {
        const drafts = draftsRef.current
        const hostTitle = typeof node.title === 'string' ? node.title : ''
        // A save in flight keeps the local draft authoritative too: a snapshot
        // arriving from an unrelated update (or from the conflict refresh) must
        // not roll back what the user just typed.
        if (drafts.title.dirty !== true && drafts.title.pending !== true) {
          drafts.title.value = hostTitle
          setTitle(hostTitle)
        }
        const hostNotes = typeof node.notes === 'string' ? node.notes : ''
        if (drafts.notes.dirty !== true && drafts.notes.pending !== true) {
          drafts.notes.value = hostNotes
          setNotes(hostNotes)
        }
        const hostCron = schedule !== null && typeof schedule.cron === 'string' ? schedule.cron : ''
        if (drafts.cron.dirty !== true && drafts.cron.pending !== true) {
          drafts.cron.value = hostCron
          setCronDraft(hostCron)
        }
        if (drafts.condition.dirty !== true && drafts.condition.pending !== true) setEditingConditionId(null)
        setFailPrompt(false)
      }, [node.updatedAt])

      // The page registers this flush so a click on another node, an edge, the
      // close button or a workspace switch saves the focused fields first.
      useEffect(() => {
        if (typeof props.onDraftFlush !== 'function') return undefined
        props.onDraftFlush(() => {
          const flush = flushAllDraftsRef.current
          if (typeof flush === 'function') flush()
        })
        return () => props.onDraftFlush(null)
      }, [])

      // Unmount is the last line of defence (panel navigation, node deletion).
      useEffect(() => () => {
        const drafts = draftsRef.current
        for (const draft of Object.values(drafts)) {
          if (draft.timer !== null) {
            clearTimeout(draft.timer)
            draft.timer = null
          }
        }
        const flush = flushAllDraftsRef.current
        if (typeof flush === 'function') flush()
      }, [])

      useEffect(() => {
        if (props.focusTitle !== true) return
        const element = titleRef.current
        if (element !== null && element !== undefined && typeof element.focus === 'function') {
          element.focus()
          if (typeof element.select === 'function') element.select()
        }
        props.onTitleFocused()
      }, [props.focusTitle, props.onTitleFocused])

      // Notes height drag. The listener is installed once and reads the drag
      // origin from a ref, so it stays correct across re-renders.
      useEffect(() => {
        if (typeof window === 'undefined' || window === null) return undefined
        if (typeof window.addEventListener !== 'function') return undefined
        function onPointerMove(event) {
          const drag = notesDragRef.current
          if (drag === null) return
          const next = Math.round(clamp(
            drag.startHeight + (Number(event.clientY) - drag.startY),
            MIN_NOTES_HEIGHT,
            MAX_NOTES_HEIGHT,
          ))
          drag.height = next
          setNotesHeight(next)
        }
        function onPointerUp() {
          const drag = notesDragRef.current
          if (drag === null) return
          notesDragRef.current = null
          writePersisted({ notesHeight: drag.height })
          try {
            if (typeof document !== 'undefined' && document !== null && document.body !== null) {
              document.body.style.userSelect = ''
            }
          } catch (error) {
            console.error('[dsh-task-dag] cannot restore text selection', error)
          }
        }
        window.addEventListener('pointermove', onPointerMove)
        window.addEventListener('pointerup', onPointerUp)
        window.addEventListener('pointercancel', onPointerUp)
        return () => {
          window.removeEventListener('pointermove', onPointerMove)
          window.removeEventListener('pointerup', onPointerUp)
          window.removeEventListener('pointercancel', onPointerUp)
          notesDragRef.current = null
          try {
            if (typeof document !== 'undefined' && document !== null && document.body !== null) {
              document.body.style.userSelect = ''
            }
          } catch (error) {
            console.error('[dsh-task-dag] cannot restore text selection', error)
          }
        }
      }, [])

      async function act(action, payload, successText) {
        const result = await props.act(action, payload)
        if (result !== null && result !== undefined && result.ok === true) {
          if (Array.isArray(result.warnings) && result.warnings.length > 0) {
            props.notify('warn', result.warnings.join('；'))
          } else if (typeof successText === 'string') {
            props.notify('info', successText)
          }
        }
        return result
      }

      function setDraftValue(kind, value, extra) {
        const draft = draftsRef.current[kind]
        if (draft === null || draft === undefined) return
        draft.value = value
        draft.dirty = true
        draft.version += 1
        if (extra !== null && extra !== undefined && extra.conditionId !== undefined) {
          draft.id = extra.conditionId
        }
        if (draft.timer !== null) clearTimeout(draft.timer)
        draft.timer = setTimeout(() => {
          draft.timer = null
          flushDraft(kind, false)
        }, DRAFT_SAVE_DELAY)
      }

      function submitDraft(draft, version, action, payload) {
        draft.dirty = false
        draft.pending = true
        const settle = (result) => {
          draft.pending = false
          if (result === null || result === undefined || result.ok !== true) {
            if (draft.version === version) draft.dirty = true
            return false
          }
          if (draft.version === version) draft.dirty = false
          return true
        }
        try {
          const pending = props.act(action, payload, { quiet: true })
          if (pending !== null && pending !== undefined && typeof pending.then === 'function') {
            pending.then(settle)
          }
          return pending
        } catch (error) {
          draft.pending = false
          draft.dirty = true
          console.error('[dsh-task-dag] draft save failed', error)
          return null
        }
      }

      /**
       * Save one draft. `final` flushes are triggered by blur, a node switch or
       * unmount; background flushes are triggered by the typing pause and keep
       * an empty/invalid draft dirty instead of resetting it mid-edit.
       */
      function flushDraft(kind, final) {
        const draft = draftsRef.current[kind]
        if (draft === null || draft === undefined || draft.dirty !== true) return
        if (draft.timer !== null) {
          clearTimeout(draft.timer)
          draft.timer = null
        }
        if (deletedRef.current) {
          draft.dirty = false
          return
        }
        const current = nodeRef.current
        if (current === null || current === undefined || typeof current.id !== 'string') return
        const version = draft.version

        if (kind === 'title') {
          const next = draft.value.trim()
          if (next === '') {
            if (final !== true) return
            draft.dirty = false
            draft.value = typeof current.title === 'string' ? current.title : ''
            setTitle(draft.value)
            return
          }
          if (next === current.title) {
            draft.dirty = false
            return
          }
          submitDraft(draft, version, 'update-node', { nodeId: current.id, title: next })
          return
        }

        if (kind === 'notes') {
          const next = typeof draft.value === 'string' ? draft.value : ''
          const previous = typeof current.notes === 'string' ? current.notes : ''
          if (next === previous) {
            draft.dirty = false
            return
          }
          submitDraft(draft, version, 'update-node', { nodeId: current.id, notes: next })
          return
        }

        if (kind === 'cron') {
          const next = draft.value.trim()
          const currentSchedule = current.schedule !== null && typeof current.schedule === 'object'
            ? current.schedule
            : null
          const previous = currentSchedule !== null && typeof currentSchedule.cron === 'string'
            ? currentSchedule.cron
            : ''
          if (next === '') {
            if (final !== true) return
            draft.dirty = false
            draft.value = previous
            setCronDraft(previous)
            return
          }
          if (next === previous) {
            draft.dirty = false
            return
          }
          submitDraft(draft, version, 'set-schedule', { nodeId: current.id, cron: next })
          return
        }

        if (kind === 'condition') {
          const conditionId = draft.id
          const conditionList = Array.isArray(current.conditions) ? current.conditions : []
          const condition = conditionList.find((item) => item.id === conditionId)
          const next = draft.value.trim()
          if (conditionId === null || condition === undefined) {
            draft.dirty = false
            setEditingConditionId(null)
            return
          }
          if (next === '') {
            if (final !== true) return
            draft.dirty = false
            draft.value = condition.title
            setEditingConditionTitle(condition.title)
            setEditingConditionId(null)
            return
          }
          if (next === condition.title) {
            draft.dirty = false
            return
          }
          const pending = submitDraft(
            draft,
            version,
            'update-condition',
            { nodeId: current.id, conditionId, title: next },
          )
          if (pending !== null && pending !== undefined && typeof pending.then === 'function') {
            pending.then((result) => {
              if (result !== null && result !== undefined && result.ok === true
                && draft.version === version) {
                setEditingConditionId(null)
              }
            })
          }
        }
      }

      function flushAllDrafts(final) {
        for (const kind of ['title', 'notes', 'cron', 'condition']) {
          flushDraft(kind, final === true)
        }
      }

      // -- notes: resize + Markdown editing ---------------------------------
      function startNotesResize(event) {
        if (event !== null && event !== undefined && event.button !== undefined && event.button !== 0) return
        if (event !== null && event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
        notesDragRef.current = {
          startY: Number(event.clientY),
          startHeight: notesHeightRef.current,
          height: notesHeightRef.current,
        }
        try {
          if (typeof document !== 'undefined' && document !== null && document.body !== null) {
            document.body.style.userSelect = 'none'
          }
        } catch (error) {
          console.error('[dsh-task-dag] cannot start the notes resize', error)
        }
      }

      function handleNotesResizeKeyDown(event) {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? COLUMN_STEP : -COLUMN_STEP
        const next = Math.round(clamp(notesHeightRef.current + delta, MIN_NOTES_HEIGHT, MAX_NOTES_HEIGHT))
        setNotesHeight(next)
        writePersisted({ notesHeight: next })
      }

      function insertMarkdown(before, after, placeholder) {
        const element = notesRef.current
        const value = typeof notes === 'string' ? notes : ''
        const rawStart = element !== null && element !== undefined ? element.selectionStart : null
        const rawEnd = element !== null && element !== undefined ? element.selectionEnd : null
        const start = Number.isInteger(rawStart) && rawStart >= 0 && rawStart <= value.length ? rawStart : value.length
        const end = Number.isInteger(rawEnd) && rawEnd >= start && rawEnd <= value.length ? rawEnd : start
        const selected = value.slice(start, end) !== '' ? value.slice(start, end) : placeholder
        const next = value.slice(0, start) + before + selected + after + value.slice(end)
        setNotes(next)
        setDraftValue('notes', next)
        if (element !== null && element !== undefined) {
          setTimeout(() => {
            try {
              if (typeof element.focus === 'function') element.focus()
              if (typeof element.setSelectionRange === 'function') {
                const cursor = start + before.length
                element.setSelectionRange(cursor, cursor + selected.length)
              }
            } catch (error) {
              // A detached textarea needs no selection restore.
            }
          }, 0)
        }
      }

      function toggleAttach() {
        if (attachOpen) {
          setAttachOpen(false)
          return
        }
        setAttachCandidates(listWorkspaceSessions(props.ctx, props.workspace))
        setAttachOpen(true)
      }

      async function attach(sessionId) {
        const result = await act('attach-session', {
          nodeId: node.id,
          sessionId,
          makeActive: true,
        }, '已挂接会话')
        if (result !== null && result !== undefined && result.ok === true) {
          setAttachOpen(false)
          setManualId('')
        }
      }

      async function confirmDelete() {
        // The draft flush on unmount must not try to update a node that is
        // about to disappear.
        deletedRef.current = true
        const result = await act('delete-node', {
          nodeId: node.id,
          mode: deleteMode,
          archiveSessions: archiveOnDelete,
        })
        if (result !== null && result !== undefined && result.ok === true) {
          props.notify('info', '已删除节点')
          props.onDeleted()
          return
        }
        // The delete failed (conflict or rejected): the node is still there, so
        // later draft flushes must keep saving it again.
        deletedRef.current = false
      }

      async function confirmArchiveChain() {
        const result = await act('archive-sessions', { nodeId: node.id })
        if (result !== null && result !== undefined && result.ok === true) {
          props.notify('info', '已归档整条会话链')
          setArchiveOpen(false)
        }
      }

      // -- status: five states; failed needs an explicit detach decision -----
      async function changeStatus(status) {
        if (status === node.status) return
        if (status === 'failed' && successors.length > 0) {
          // Let the Host explain the rule through the notice bar, and offer the
          // explicit detach path right next to the status buttons.
          setFailPrompt(true)
          const result = await act('update-node', { nodeId: node.id, status: 'failed' })
          if (result !== null && result !== undefined && result.ok === true) setFailPrompt(false)
          return
        }
        setFailPrompt(false)
        await act('update-node', { nodeId: node.id, status })
      }

      async function detachAndFail() {
        setFailPrompt(false)
        await act('update-node', { nodeId: node.id, status: 'failed', detachSuccessors: true },
          '已改为失败，并解除它的全部出边')
      }

      // -- prerequisite conditions ------------------------------------------
      async function addCondition() {
        const next = conditionTitle.trim()
        if (next === '') return
        const result = await act('add-condition', { nodeId: node.id, title: next }, '已添加前置条件')
        if (result !== null && result !== undefined && result.ok === true) setConditionTitle('')
      }

      function startRenameCondition(condition) {
        setEditingConditionId(condition.id)
        setEditingConditionTitle(condition.title)
        const draft = draftsRef.current.condition
        draft.id = condition.id
        draft.value = condition.title
        draft.dirty = false
        draft.version += 1
        if (draft.timer !== null) {
          clearTimeout(draft.timer)
          draft.timer = null
        }
      }

      function cancelConditionEdit() {
        const draft = draftsRef.current.condition
        draft.dirty = false
        if (draft.timer !== null) {
          clearTimeout(draft.timer)
          draft.timer = null
        }
        setEditingConditionId(null)
      }

      function saveConditionTitle(condition) {
        const draft = draftsRef.current.condition
        draft.id = condition.id
        draft.value = editingConditionTitle
        draft.dirty = true
        draft.version += 1
        flushDraft('condition', true)
      }

      async function removeCondition(condition) {
        await act('delete-condition', { nodeId: node.id, conditionId: condition.id }, '已删除前置条件')
      }

      async function unlinkPrerequisite(edgeId) {
        await act('unlink', { edgeId }, '已解除关联')
      }

      // -- per-node execution settings (agent preset + model) ---------------
      function saveAgentPreset(event) {
        const next = event.target.value
        act('update-node', { nodeId: node.id, agentPreset: next === '' ? null : next }, '已保存 Agent 预设')
      }

      function applyExecutionTarget(selection) {
        const nextModel = selection !== null && typeof selection === 'object' && typeof selection.model === 'string'
          ? selection.model.trim()
          : ''
        const nextEffort = selection !== null && typeof selection === 'object'
          && typeof selection.reasoningEffort === 'string'
          ? selection.reasoningEffort.trim()
          : ''
        act('update-node', {
          nodeId: node.id,
          model: nextModel === '' ? null : nextModel,
          reasoningEffort: nextEffort === '' ? null : nextEffort,
        }, '已保存模型与推理强度')
      }

      // -- schedule ----------------------------------------------------------
      function syncCronDraft(cron) {
        const draft = draftsRef.current.cron
        draft.value = cron
        draft.dirty = false
        draft.version += 1
        if (draft.timer !== null) {
          clearTimeout(draft.timer)
          draft.timer = null
        }
      }

      async function toggleSchedule() {
        if (scheduleEnabled) {
          syncCronDraft(cronDraft)
          await act('set-schedule', { nodeId: node.id, enabled: false }, '已关闭定时执行')
          return
        }
        let cron = cronDraft.trim()
        if (cron === '') {
          cron = '0 9 * * *'
          setCronDraft(cron)
        }
        syncCronDraft(cron)
        await act('set-schedule', { nodeId: node.id, enabled: true, cron }, '已启用定时执行')
      }

      async function saveCron() {
        const cron = cronDraft.trim()
        if (cron === '') {
          props.notify('warn', '请先填写 5 段 cron 表达式')
          return
        }
        syncCronDraft(cron)
        const result = await act('set-schedule', { nodeId: node.id, cron }, '已保存定时表达式')
        if (result === null || result === undefined || result.ok !== true) {
          const draft = draftsRef.current.cron
          draft.value = cron
          draft.dirty = true
        }
      }

      function applyCronPreset(cron) {
        setCronDraft(cron)
        syncCronDraft(cron)
        act('set-schedule', { nodeId: node.id, cron }, '已应用定时预设')
      }

      // -- milestone ---------------------------------------------------------
      function toggleMilestone() {
        act('set-milestone', { nodeId: isMilestone ? null : node.id },
          isMilestone ? '已取消项目里程碑' : '已设为项目里程碑')
      }

      // -- session candidates ----------------------------------------------
      const attachedIds = model.attachedSessionIds
      const candidates = (attachCandidates || []).filter((candidate) => !attachedIds.has(candidate.sessionId))
      let attachPanel = null
      if (attachOpen) {
        attachPanel = h('div', { className: 'dsh-td-field' },
          h('div', { className: 'dsh-td-hintline' }, '挂接后成为当前会话，原当前会话转为已交接。'),
          candidates.length === 0
            ? h('div', { className: 'dsh-td-hintline' }, '没有可挂接的未关联会话。')
            : h('div', { className: 'dsh-td-candidates' },
              candidates.slice(0, 20).map((candidate) => h('div', { key: candidate.sessionId, className: 'dsh-td-candidate' },
                h('span', { className: 'dsh-td-candidate-title', title: candidate.sessionId }, candidate.title),
                candidate.running ? h('span', { className: 'dsh-td-presence', title: '运行中' }) : null,
                h('button', {
                  type: 'button',
                  className: 'dsh-td-btn dsh-td-btn-sm',
                  disabled: props.busy,
                  onClick: () => attach(candidate.sessionId),
                }, '挂接'),
              )),
            ),
          h('div', { className: 'dsh-td-toolbar-row' },
            h('input', {
              className: 'dsh-td-input',
              type: 'text',
              placeholder: '或粘贴会话 ID',
              value: manualId,
              onChange: (event) => setManualId(event.target.value),
              style: { flex: '1 1 140px' },
            }),
            h('button', {
              type: 'button',
              className: 'dsh-td-btn dsh-td-btn-sm',
              disabled: props.busy || manualId.trim() === '',
              onClick: () => attach(manualId.trim()),
            }, '挂接'),
          ),
        )
      }

      // -- prerequisite condition rows --------------------------------------
      const conditionRows = conditions.map((condition) => {
        const linkedEdges = prerequisites.filter((edge) => edge.conditionId === condition.id)
        const editing = editingConditionId === condition.id
        const linkedRows = linkedEdges.map((edge) => {
          const linkedNode = model.nodeById[edge.from]
          return h('div', { key: edge.id, className: 'dsh-td-cond-link' },
            h(StatusDot, { status: linkedNode !== undefined ? linkedNode.status : 'todo' }),
            h('span', null, (linkedNode !== undefined ? linkedNode.title : edge.from)
              + ' · ' + (linkedNode !== undefined ? statusLabel(linkedNode.status) : '未知节点')),
            h('button', {
              type: 'button',
              className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text',
              disabled: props.busy,
              title: '解除这条关联边，条件保留',
              onClick: () => unlinkPrerequisite(edge.id),
            }, '解除'),
          )
        })
        return h('div', {
          key: condition.id,
          className: 'dsh-td-cond' + (condition.satisfied ? '' : ' dsh-td-cond-off'),
        },
          h('div', { className: 'dsh-td-cond-head' },
            h(StatusDot, { status: condition.satisfied ? 'done' : 'todo' }),
            editing
              ? h('input', {
                className: 'dsh-td-input dsh-td-grow',
                type: 'text',
                value: editingConditionTitle,
                onChange: (event) => {
                  setEditingConditionTitle(event.target.value)
                  setDraftValue('condition', event.target.value, { conditionId: condition.id })
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    saveConditionTitle(condition)
                  }
                  if (event.key === 'Escape') cancelConditionEdit()
                },
              })
              : h('span', { className: 'dsh-td-cond-title', title: condition.title }, condition.title),
            h(Chip, { kind: condition.satisfied ? 'success' : 'warn' },
              condition.satisfied ? '已满足' : '未满足'),
            editing
              ? h('button', {
                type: 'button',
                className: 'dsh-td-btn dsh-td-btn-sm',
                disabled: props.busy,
                onClick: () => saveConditionTitle(condition),
              }, '保存')
              : h('button', {
                type: 'button',
                className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text',
                disabled: props.busy,
                title: '重命名这个前置条件',
                onClick: () => startRenameCondition(condition),
              }, '重命名'),
            editing
              ? h('button', {
                type: 'button',
                className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text',
                onClick: cancelConditionEdit,
              }, '取消')
              : h('button', {
                type: 'button',
                className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-danger',
                disabled: props.busy,
                title: '删除这个条件，以及满足它的所有边',
                onClick: () => removeCondition(condition),
              }, '删除'),
          ),
          h('div', { className: 'dsh-td-cond-links' },
            linkedRows.length > 0
              ? linkedRows
              : h('div', { className: 'dsh-td-hintline' },
                condition.legacy === true
                  ? '旧版依赖，保存后升级为条件。'
                  : '还没有关联前序节点。'),
          ),
        )
      })

      const successorRows = successors.map((edge) => {
        const nextNode = model.nodeById[edge.to]
        const nextConditions = model.conditions[edge.to] || []
        let targetConditionTitle = ''
        for (const condition of nextConditions) {
          if (condition.id === edge.conditionId) targetConditionTitle = condition.title
        }
        return h('div', { key: edge.id, className: 'dsh-td-row dsh-td-row-muted' },
          h(StatusDot, { status: nextNode !== undefined ? nextNode.status : 'todo' }),
          h('div', { className: 'dsh-td-row-main' },
            h('span', { className: 'dsh-td-row-title dsh-td-row-title-muted' },
              nextNode !== undefined ? nextNode.title : edge.to),
            targetConditionTitle !== ''
              ? h('span', { className: 'dsh-td-row-meta' }, '满足「' + targetConditionTitle + '」')
              : null,
          ),
          h('span', { className: 'dsh-td-row-meta' }, '完成后解锁'),
        )
      })

      // -- catalog option lists (tolerate an empty / unavailable catalog) ----
      const presetOptions = [{ value: '', label: '默认（跟随宿主）' }]
      for (const preset of presets) {
        if (typeof preset === 'string' && preset !== '') {
          presetOptions.push({ value: preset, label: preset })
          continue
        }
        if (preset === null || typeof preset !== 'object') continue
        const id = typeof preset.id === 'string' ? preset.id : ''
        if (id === '') continue
        const label = typeof preset.label === 'string' && preset.label !== '' ? preset.label : id
        presetOptions.push({ value: id, label: label + (preset.broken === true ? '（不可用）' : '') })
      }
      const agentPreset = typeof node.agentPreset === 'string' ? node.agentPreset : ''
      if (agentPreset !== '' && presetOptions.every((option) => option.value !== agentPreset)) {
        presetOptions.push({ value: agentPreset, label: agentPreset + '（当前值，目录未列出）' })
      }

      const nodeModel = typeof node.model === 'string' ? node.model : ''
      const nodeReasoningEffort = typeof node.reasoningEffort === 'string' ? node.reasoningEffort : ''
      const selectedModelInfo = models.find((item) => modelValueOf(item) === nodeModel) || null
      const executionSummary = nodeModel === ''
        ? '跟随宿主'
        : (selectedModelInfo !== null ? selectedModelInfo.label : nodeModel)
          + (nodeReasoningEffort === ''
            ? ''
            : ' · ' + (selectedModelInfo !== null && selectedModelInfo.reasoning !== null
              ? effortNameOf(selectedModelInfo.reasoning, nodeReasoningEffort)
              : nodeReasoningEffort))

      // -- schedule summary --------------------------------------------------
      const scheduleNextRun = formatNextRun(schedule)
      const scheduleLastResult = scheduleResultText(schedule)
      const scheduleLastRun = schedule !== null
        && (typeof schedule.lastFinishedAt === 'string' || typeof schedule.lastTriggeredAt === 'string')
        ? formatTime(typeof schedule.lastFinishedAt === 'string' && schedule.lastFinishedAt !== ''
          ? schedule.lastFinishedAt
          : schedule.lastTriggeredAt)
        : ''
      const scheduleLastError = schedule !== null && typeof schedule.lastError === 'string' && schedule.lastError !== ''
        ? schedule.lastError
        : ''
      const scheduleSkippedReason = schedule !== null && typeof schedule.lastSkippedReason === 'string'
        && schedule.lastSkippedReason !== ''
        ? schedule.lastSkippedReason
        : ''

      const sessionRows = sessions.map((session) => {
        const activeRow = session.retiredAt === null || session.retiredAt === undefined
        const fact = facts[session.sessionId] !== null && typeof facts[session.sessionId] === 'object'
          ? facts[session.sessionId]
          : null
        return h(SessionRow, {
          key: session.sessionId,
          session,
          active: activeRow,
          fact,
          archived: model.archived.indexOf(session.sessionId) >= 0,
          busy: props.busy,
          onSwitch: (sessionId) => act('switch-session', { nodeId: node.id, sessionId }, '已切回该会话'),
          onOpen: (sessionId) => props.onOpenSession(sessionId),
          onDetach: (sessionId) => act('detach-session', { nodeId: node.id, sessionId }, '已从会话链摘除'),
        })
      })

      const statusButtons = STATUSES.map((status) => h('button', {
        key: status,
        type: 'button',
        title: STATUS_HINTS[status],
        className: 'dsh-td-seg-btn' + (node.status === status ? ' dsh-td-seg-btn-on' : ''),
        disabled: props.busy || node.status === status,
        onClick: () => changeStatus(status),
      }, statusLabel(status)))

      const failWarning = failPrompt
        ? h('div', { className: 'dsh-td-cond dsh-td-cond-off' },
          h('div', { className: 'dsh-td-hintline' },
            '还有 ' + String(successors.length) + ' 个后继；改为失败会先解除全部出边。'),
          h('div', { className: 'dsh-td-toolbar-row' },
            h('button', {
              type: 'button',
              className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-danger',
              disabled: props.busy,
              onClick: detachAndFail,
            }, '改为失败并解除出边'),
            h('button', {
              type: 'button',
              className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text',
              onClick: () => setFailPrompt(false),
            }, '取消'),
          ),
        )
        : null

      return h('div', { className: 'dsh-td-detail-scroll' },
        // title
        h('div', { className: 'dsh-td-field' },
          h('span', { className: 'dsh-td-label' }, '标题'),
          h('input', {
            ref: titleRef,
            className: 'dsh-td-input',
            type: 'text',
            value: title,
            // Never disabled while a background save is in flight: disabling a
            // focused input makes the browser drop focus mid-typing.
            onChange: (event) => {
              setTitle(event.target.value)
              setDraftValue('title', event.target.value)
            },
            onBlur: () => flushDraft('title', true),
            onKeyDown: (event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            },
          }),
        ),
        // task description: Markdown editor between title and status
        h('div', { className: 'dsh-td-field' },
          h('div', { className: 'dsh-td-notes-head' },
            h('span', { className: 'dsh-td-label' }, '任务描述（Markdown）'),
            h('div', { className: 'dsh-td-notes-tabs', role: 'tablist' },
              h('button', {
                type: 'button',
                role: 'tab',
                'aria-selected': notesMode === 'edit',
                className: 'dsh-td-notes-tab' + (notesMode === 'edit' ? ' dsh-td-notes-tab-on' : ''),
                onClick: () => setNotesMode('edit'),
              }, '编辑'),
              h('button', {
                type: 'button',
                role: 'tab',
                'aria-selected': notesMode === 'preview',
                className: 'dsh-td-notes-tab' + (notesMode === 'preview' ? ' dsh-td-notes-tab-on' : ''),
                onClick: () => setNotesMode('preview'),
              }, '预览'),
            ),
          ),
          notesMode === 'edit'
            ? h('div', { className: 'dsh-td-field' },
              h('div', { className: 'dsh-td-notes-tools' },
                [
                  ['B', '加粗', '**', '**', '粗体'],
                  ['I', '斜体', '*', '*', '斜体'],
                  ['`', '行内代码', '`', '`', '代码'],
                  ['-', '无序列表', '- ', '', '列表项'],
                  ['>', '引用', '> ', '', '引用'],
                  ['H', '标题', '## ', '', '小标题'],
                ].map((tool) => h('button', {
                  key: 'md-' + tool[0],
                  type: 'button',
                  className: 'dsh-td-btn dsh-td-btn-sm dsh-td-notes-tool',
                  title: tool[1],
                  'aria-label': tool[1],
                  disabled: props.busy,
                  // Keep the textarea focused: a blur would save the pre-insert
                  // text and the incoming snapshot could overwrite the insertion.
                  onMouseDown: (event) => event.preventDefault(),
                  onClick: () => insertMarkdown(tool[2], tool[3], tool[4]),
                }, tool[0])),
              ),
              h('textarea', {
                ref: notesRef,
                className: 'dsh-td-textarea dsh-td-notes-textarea',
                style: { height: notesHeight + 'px' },
                value: notes,
                placeholder: '背景、约束、完成标准…支持 Markdown，自动保存',
                onChange: (event) => {
                  setNotes(event.target.value)
                  setDraftValue('notes', event.target.value)
                },
                onBlur: () => flushDraft('notes', true),
              }),
            )
            : h('div', {
              className: 'dsh-td-notes-preview dsh-td-md',
              style: { height: notesHeight + 'px' },
            }, notes.trim() === ''
              ? h('div', { className: 'dsh-td-notes-empty' }, '还没有任务描述。')
              : renderMarkdown(notes)),
          h('div', {
            className: 'dsh-td-notes-resizer',
            role: 'separator',
            'aria-orientation': 'horizontal',
            'aria-label': '调整任务描述输入框高度',
            'aria-valuenow': notesHeight,
            'aria-valuemin': MIN_NOTES_HEIGHT,
            'aria-valuemax': MAX_NOTES_HEIGHT,
            tabIndex: 0,
            title: '拖动调整高度，方向键微调',
            onPointerDown: startNotesResize,
            onKeyDown: handleNotesResizeKeyDown,
          }),
        ),
        // status (five states)
        h('div', { className: 'dsh-td-field' },
          h('span', { className: 'dsh-td-label' }, '状态'),
          h('div', { className: 'dsh-td-seg' }, statusButtons),
          h('div', { className: 'dsh-td-hintline' }, STATUS_HINTS[node.status] || ''),
          failWarning,
        ),
        // milestone
        h('label', { className: 'dsh-td-check' },
          h('input', {
            type: 'checkbox',
            checked: isMilestone,
            disabled: props.busy,
            onChange: toggleMilestone,
          }),
          '设为项目里程碑',
        ),
        // prerequisite conditions
        h('div', { className: 'dsh-td-section' },
          h('div', { className: 'dsh-td-section-head' },
            h('span', { className: 'dsh-td-section-title' }, '前置条件'),
            h('span', { className: 'dsh-td-section-note' },
              String(satisfiedConditionCount) + '/' + String(conditions.length) + ' 已满足'),
          ),
          h('div', { className: 'dsh-td-hintline' },
            '任一关联前序完成即满足；全部条件满足后可开始。'),
          conditionRows.length > 0
            ? conditionRows
            : h('div', { className: 'dsh-td-hintline' },
              '还没有前置条件。可在下方添加，或从画布拖一条关联过来。'),
          h('div', { className: 'dsh-td-toolbar-row' },
            h('input', {
              className: 'dsh-td-input dsh-td-grow',
              type: 'text',
              placeholder: '新条件标题，例如：需求评审通过',
              value: conditionTitle,
              onChange: (event) => setConditionTitle(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addCondition()
                }
              },
            }),
            h('button', {
              type: 'button',
              className: 'dsh-td-btn dsh-td-btn-sm',
              disabled: props.busy || conditionTitle.trim() === '',
              onClick: addCondition,
            }, '添加条件'),
          ),
        ),
        // successors
        successors.length > 0
          ? h('div', { className: 'dsh-td-section' },
            h('div', { className: 'dsh-td-section-head' },
              h('span', { className: 'dsh-td-section-title' }, '完成后解锁'),
              h('span', { className: 'dsh-td-section-note' }, String(successors.length) + ' 个'),
            ),
            successorRows,
          )
          : null,
        // session chain
        h('div', { className: 'dsh-td-section' },
          h('div', { className: 'dsh-td-section-head' },
            h('span', { className: 'dsh-td-section-title' }, '会话链'),
            h('span', { className: 'dsh-td-section-note' }, String(sessions.length) + ' 段'),
          ),
          sessionRows.length > 0
            ? sessionRows
            : h('div', { className: 'dsh-td-hintline' },
              '还没有会话。可交接新会话或挂接已有会话。'),
          active !== null
            ? h(ContextMeter, { fact: activeFact })
            : h('div', { className: 'dsh-td-hintline' }, '当前没有生效会话。'),
          h('div', { className: 'dsh-td-toolbar-row' },
            h('button', {
              type: 'button',
              className: 'dsh-td-btn dsh-td-btn-primary',
              disabled: props.busy,
              title: '新建会话并发送确定性交接简报，旧会话自动退休',
              onClick: () => act('handoff', { nodeId: node.id, mode: 'brief' }, '已创建新会话并发送交接简报'),
            }, '交接新会话'),
            h('button', {
              type: 'button',
              className: 'dsh-td-btn',
              disabled: props.busy,
              title: '只新建空会话并挂接，不发送任何内容',
              onClick: () => act('handoff', { nodeId: node.id, mode: 'blank' }, '已创建空会话并挂接'),
            }, '交接新会话（空会话）'),
            h('button', {
              type: 'button',
              className: 'dsh-td-btn',
              disabled: props.busy,
              onClick: toggleAttach,
            }, attachOpen ? '收起挂接面板' : '挂接已有会话'),
          ),
          attachPanel,
        ),
        // execution settings: agent preset + model/reasoning, saved through update-node
        h(CollapsibleSection, {
          title: '执行设置',
          note: executionSummary,
          defaultOpen: false,
        },
          h('div', { className: 'dsh-td-field' },
            h('span', { className: 'dsh-td-label' }, 'Agent 预设'),
            h('select', {
              className: 'dsh-td-select',
              value: agentPreset,
              disabled: props.busy,
              onChange: saveAgentPreset,
            }, presetOptions.map((option) => h('option', {
              key: option.value === '' ? '__default' : option.value,
              value: option.value,
            }, option.label))),
          ),
          h('div', { className: 'dsh-td-field' },
            h('span', { className: 'dsh-td-label' }, '模型与推理强度'),
            h(ModelPicker, {
              models,
              model: nodeModel,
              reasoningEffort: nodeReasoningEffort,
              busy: props.busy,
              onChange: applyExecutionTarget,
            }),
          ),
          h('div', { className: 'dsh-td-hintline' },
            '当前会话立即应用；交接与定时执行新建会话时同样生效。'),
          catalogWarnings.length > 0
            ? h('div', { className: 'dsh-td-errorline' }, catalogWarnings.join('；'))
            : null,
        ),
        // schedule
        h(CollapsibleSection, {
          title: '定时执行',
          note: scheduleEnabled ? '已启用' : '未启用',
          defaultOpen: false,
        },
          h('label', { className: 'dsh-td-check' },
            h('input', {
              type: 'checkbox',
              checked: scheduleEnabled,
              disabled: props.busy,
              onChange: toggleSchedule,
            }),
            '按 cron 自动执行',
          ),
          h('div', { className: 'dsh-td-hintline' },
            '到期按上述配置新建会话执行；节点非「待开始」或条件未满足时跳过。'),
          h('div', { className: 'dsh-td-toolbar-row' },
            h('input', {
              className: 'dsh-td-input dsh-td-grow',
              type: 'text',
              value: cronDraft,
              placeholder: '5 段 cron，例如 0 9 * * 1-5',
              onChange: (event) => {
                setCronDraft(event.target.value)
                setDraftValue('cron', event.target.value)
              },
              onBlur: () => flushDraft('cron', true),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  saveCron()
                }
              },
            }),
            h('button', {
              type: 'button',
              className: 'dsh-td-btn dsh-td-btn-sm',
              disabled: props.busy,
              title: '保存 cron 表达式（Host 会重新计算下次执行时间）',
              onClick: saveCron,
            }, '保存定时'),
          ),
          h('div', { className: 'dsh-td-presets' },
            CRON_PRESETS.map((preset) => h('button', {
              key: preset.cron,
              type: 'button',
              className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text',
              disabled: props.busy,
              title: preset.cron,
              onClick: () => applyCronPreset(preset.cron),
            }, preset.label)),
          ),
          h('div', { className: 'dsh-td-sched-line' },
            h('span', null, '下次执行'),
            h('span', { className: 'dsh-td-sched-value' },
              scheduleEnabled ? (scheduleNextRun !== '' ? scheduleNextRun : '待计算') : '—'),
          ),
          h('div', { className: 'dsh-td-sched-line' },
            h('span', null, '上次结果'),
            h('span', { className: 'dsh-td-sched-value' }, scheduleLastResult || '暂无记录'),
          ),
          scheduleLastRun !== ''
            ? h('div', { className: 'dsh-td-sched-line' },
              h('span', null, '上次执行'),
              h('span', { className: 'dsh-td-sched-value' }, scheduleLastRun))
            : null,
          scheduleSkippedReason !== ''
            ? h('div', { className: 'dsh-td-hintline' }, '跳过原因：' + scheduleSkippedReason)
            : null,
          scheduleLastError !== ''
            ? h('div', { className: 'dsh-td-errorline' }, '上次错误：' + scheduleLastError)
            : null,
        ),
        // danger zone (collapsed by default)
        h(CollapsibleSection, {
          title: '危险操作',
          defaultOpen: false,
        },
          h('div', { className: 'dsh-td-danger-zone' },
            h('span', { className: 'dsh-td-danger-title' }, '会话链'),
            archiveOpen
              ? h('div', { className: 'dsh-td-toolbar-row' },
                h('button', {
                  type: 'button',
                  className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-danger',
                  disabled: props.busy,
                  onClick: confirmArchiveChain,
                }, '确认归档'),
                h('button', {
                  type: 'button',
                  className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text',
                  onClick: () => setArchiveOpen(false),
                }, '取消'),
              )
              : h('button', {
                type: 'button',
                className: 'dsh-td-btn dsh-td-btn-sm',
                disabled: props.busy || sessions.length === 0,
                title: '归档这个节点上的全部会话，可在侧栏取消归档',
                onClick: () => setArchiveOpen(true),
              }, '归档整条会话链'),
            h('span', { className: 'dsh-td-hintline' }, '归档后可在侧栏恢复，不会删除对话。'),
            h('span', { className: 'dsh-td-danger-title' }, '删除节点'),
            successors.length > 0
              ? h('div', { className: 'dsh-td-field' },
                h('label', { className: 'dsh-td-radio' },
                  h('input', {
                    type: 'radio',
                    name: 'dsh-td-delete-mode',
                    checked: deleteMode === 'splice',
                    onChange: () => setDeleteMode('splice'),
                  }),
                  h('span', null, '拼接上游到后继条件（默认，'
                    + String(successors.length) + ' 个后继保留约束）'),
                ),
                h('label', { className: 'dsh-td-radio' },
                  h('input', {
                    type: 'radio',
                    name: 'dsh-td-delete-mode',
                    checked: deleteMode === 'unlink',
                    onChange: () => setDeleteMode('unlink'),
                  }),
                  h('span', null, '只移除关联边'),
                ),
              )
              : h('div', { className: 'dsh-td-hintline' }, '没有后继节点。'),
            h('label', { className: 'dsh-td-check' },
              h('input', {
                type: 'checkbox',
                checked: archiveOnDelete,
                onChange: (event) => setArchiveOnDelete(event.target.checked),
              }),
              '同时归档整条会话链',
            ),
            deleteOpen
              ? h('div', { className: 'dsh-td-toolbar-row' },
                h('button', {
                  type: 'button',
                  className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-danger',
                  disabled: props.busy,
                  onClick: confirmDelete,
                }, '确认删除'),
                h('button', {
                  type: 'button',
                  className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text',
                  onClick: () => setDeleteOpen(false),
                }, '取消'),
              )
              : h('button', {
                type: 'button',
                className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-danger',
                disabled: props.busy,
                onClick: () => setDeleteOpen(true),
              }, '删除节点'),
          ),
        ),
      )
    }

    function OverviewPane(props) {
      const model = props.model
      const workspace = props.workspace
      const readyNodes = model.nodes.filter((node) => model.ready.has(node.id))
      const doingNodes = model.nodes.filter((node) => node.status === 'doing')
      const plannedNodes = model.nodes.filter((node) => node.status === 'planned')
      const failedNodes = model.nodes.filter((node) => node.status === 'failed')
      const milestoneNode = model.milestoneNode
      const summary = model.summary
      const percent = summary.total > 0 ? Math.round((summary.done / summary.total) * 100) : 0

      function nodeRows(nodes, meta) {
        return nodes.map((node) => h('button', {
          key: node.id,
          type: 'button',
          className: 'dsh-td-ws',
          onClick: () => props.onSelectNode(node.id),
        },
          h('span', { className: 'dsh-td-ws-name' }, node.title),
          h('span', { className: 'dsh-td-ws-meta' }, meta),
        ))
      }

      return h('div', { className: 'dsh-td-detail-scroll' },
        h('div', { className: 'dsh-td-field' },
          h('span', { className: 'dsh-td-label' }, '项目'),
          h('div', { style: { fontSize: 'var(--dsh-td-fs)', fontWeight: 600, wordBreak: 'break-all' } },
            workspace !== null && workspace !== undefined && workspace.title !== '' ? workspace.title : '未选择项目'),
          workspace !== null && workspace !== undefined && workspace.path !== ''
            ? h('div', { className: 'dsh-td-hintline', style: { wordBreak: 'break-all' } }, workspace.path)
            : null,
        ),
        h('div', { className: 'dsh-td-section' },
          h('div', { className: 'dsh-td-section-head' },
            h('span', { className: 'dsh-td-section-title' }, '整体进度'),
            h('span', { className: 'dsh-td-section-note' },
              String(summary.done) + '/' + String(summary.total) + ' 完成'),
          ),
          h('div', { className: 'dsh-td-meter' },
            h('div', { className: 'dsh-td-meter-fill', style: { width: Math.max(2, percent) + '%' } }),
          ),
          h('div', { className: 'dsh-td-hintline' },
            '可开始 ' + String(summary.ready) + ' · 阻塞 ' + String(summary.blocked)
            + ' · 进行中 ' + String(summary.doing) + ' · 待规划 ' + String(summary.planned)
            + ' · 失败 ' + String(summary.failed)),
          h('div', { className: 'dsh-td-hintline' },
            milestoneNode !== null && milestoneNode !== undefined
              ? '里程碑：' + milestoneNode.title + ' · ' + statusLabel(milestoneNode.status)
              : '未设置里程碑'),
        ),
        readyNodes.length > 0
          ? h('div', { className: 'dsh-td-section' },
            h('div', { className: 'dsh-td-section-title' }, '可开始（' + String(readyNodes.length) + '）'),
            nodeRows(readyNodes, '可开始'),
          )
          : null,
        doingNodes.length > 0
          ? h('div', { className: 'dsh-td-section' },
            h('div', { className: 'dsh-td-section-title' }, '进行中（' + String(doingNodes.length) + '）'),
            nodeRows(doingNodes, '进行中'),
          )
          : null,
        plannedNodes.length > 0
          ? h('div', { className: 'dsh-td-section' },
            h('div', { className: 'dsh-td-section-title' }, '待规划（' + String(plannedNodes.length) + '）'),
            nodeRows(plannedNodes, '待规划'),
          )
          : null,
        failedNodes.length > 0
          ? h('div', { className: 'dsh-td-section' },
            h('div', { className: 'dsh-td-section-title' }, '已失败（' + String(failedNodes.length) + '）'),
            nodeRows(failedNodes, '已失败'),
          )
          : null,
        model.nodes.length === 0
          ? h('div', { className: 'dsh-td-empty' }, '还没有节点，双击画布新建。')
          : h('div', { className: 'dsh-td-hintline' }, '点击节点查看详情。'),
      )
    }

    function DetailDrawer(props) {
      const node = props.nodeId !== null && props.model.nodeById[props.nodeId] !== undefined
        ? props.model.nodeById[props.nodeId]
        : null
      const width = readWidth(props.width, DEFAULT_RIGHT_WIDTH, MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH)
      return h('aside', { className: 'dsh-td-col-right', style: { flexBasis: width + 'px' } },
        h('div', { className: 'dsh-td-detail-head' },
          h('span', { className: 'dsh-td-detail-title', title: node !== null ? node.title : '项目概览' },
            node !== null ? node.title : '项目概览'),
          node !== null
            ? h('button', {
              type: 'button',
              className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text dsh-td-close',
              title: '取消选中',
              onClick: props.onClose,
            }, '×')
            : null,
        ),
        node !== null
          ? h(NodePane, {
            key: node.id,
            node,
            model: props.model,
            workspace: props.workspace,
            ctx: props.ctx,
            catalog: props.catalog,
            busy: props.busy,
            act: props.act,
            notify: props.notify,
            focusTitle: props.focusTitle,
            onTitleFocused: props.onTitleFocused,
            onOpenSession: props.onOpenSession,
            onDeleted: props.onDeleted,
            onDraftFlush: props.onDraftFlush,
          })
          : h(OverviewPane, {
            model: props.model,
            workspace: props.workspace,
            onSelectNode: props.onSelectNode,
          }),
      )
    }

    // =======================================================================
    // 12. Panel page — state ownership, live updates, persistence.
    // =======================================================================
    function TaskDagPage(props) {
      const ctx = props !== null && props !== undefined && props.ctx !== undefined ? props.ctx : null
      const initialRef = useRef(null)
      if (initialRef.current === null) initialRef.current = readPersisted()
      const initial = initialRef.current

      const [workspaceId, setWorkspaceId] = useState(
        typeof initial.workspaceId === 'string' && initial.workspaceId !== '' ? initial.workspaceId : null,
      )
      const [selectedNodeId, setSelectedNodeId] = useState(
        typeof initial.selectedNodeId === 'string' && initial.selectedNodeId !== '' ? initial.selectedNodeId : null,
      )
      const [selectedEdgeId, setSelectedEdgeId] = useState(null)
      const [selectedGroupId, setSelectedGroupId] = useState(null)
      const [groupDraft, setGroupDraft] = useState(null)
      const [focusTitle, setFocusTitle] = useState(false)
      const [workspaces, setWorkspaces] = useState({ phase: 'loading', items: [], fallback: false })
      const [state, setState] = useState({ phase: 'idle', snapshot: null, error: null })
      const [notice, setNotice] = useState(null)
      const [pending, setPending] = useState(0)
      const [live, setLive] = useState(false)
      const [catalog, setCatalog] = useState({ phase: 'idle', presets: [], models: [], warnings: [] })
      const [linkDraft, setLinkDraft] = useState(null)
      const [layoutMode, setLayoutMode] = useState(() => readLayoutMode(initial))

      // Side-column widths. Persisted like the viewport so a remount (the
      // `main` slot unmounts on navigation) keeps the user's layout.
      const initialWidths = readColumnWidths(initial)
      const [leftWidth, setLeftWidth] = useState(initialWidths.left)
      const [rightWidth, setRightWidth] = useState(initialWidths.right)

      const snapshotRef = useRef(null)
      const workspaceIdRef = useRef(workspaceId)
      workspaceIdRef.current = workspaceId
      const queueRef = useRef(Promise.resolve())
      // Registered by the open NodePane: saves its text fields before the
      // drawer is pointed at another node, an edge, or another project.
      const draftFlushRef = useRef(null)
      const noticeTimerRef = useRef(null)
      const refreshTimerRef = useRef(null)
      const bodyRef = useRef(null)
      const widthRef = useRef({ left: leftWidth, right: rightWidth })
      widthRef.current = { left: leftWidth, right: rightWidth }
      const columnDragRef = useRef(null)
      const busy = pending > 0

      // Undo state is declared before the effects that clear it on a workspace
      // switch; the gesture helpers that fill it live with the canvas callbacks.
      const undoRef = useRef([])
      const [undoDepth, setUndoDepth] = useState(0)
      const dropUndoStack = useCallback(() => {
        if (undoRef.current.length === 0) return
        undoRef.current = []
        setUndoDepth(0)
      }, [])

      const showNotice = useCallback((kind, text) => {
        setNotice({ kind, text })
        if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = setTimeout(() => setNotice(null), 6000)
      }, [])

      useEffect(() => () => {
        if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current)
        if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current)
      }, [])

      // -- resizable side columns -------------------------------------------
      function columnLimits() {
        const body = bodyRef.current
        const measured = body !== null && typeof body.getBoundingClientRect === 'function'
          ? Number(body.getBoundingClientRect().width)
          : 0
        const fixed = MIN_MAIN_WIDTH + SPLITTER_WIDTH * 2
        const current = widthRef.current
        const leftMax = Number.isFinite(measured) && measured > 0
          ? Math.max(MIN_LEFT_WIDTH, Math.min(MAX_LEFT_WIDTH, measured - current.right - fixed))
          : MAX_LEFT_WIDTH
        const rightMax = Number.isFinite(measured) && measured > 0
          ? Math.max(MIN_RIGHT_WIDTH, Math.min(MAX_RIGHT_WIDTH, measured - current.left - fixed))
          : MAX_RIGHT_WIDTH
        return { leftMax, rightMax }
      }

      function endColumnResize() {
        if (columnDragRef.current === null) return
        columnDragRef.current = null
        writePersisted({ columnWidths: { left: widthRef.current.left, right: widthRef.current.right } })
        try {
          if (typeof document !== 'undefined' && document !== null && document.body !== null) {
            document.body.style.cursor = ''
            document.body.style.userSelect = ''
          }
        } catch (error) {
          console.error('[dsh-task-dag] cannot restore the cursor', error)
        }
      }

      function startColumnResize(side, event) {
        if (event !== null && event !== undefined && event.button !== undefined && event.button !== 0) return
        if (event !== null && event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
        const body = bodyRef.current
        if (body === null || typeof body.getBoundingClientRect !== 'function') return
        const rect = body.getBoundingClientRect()
        columnDragRef.current = { side, left: rect.left, right: rect.right }
        try {
          if (typeof document !== 'undefined' && document !== null && document.body !== null) {
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }
        } catch (error) {
          console.error('[dsh-task-dag] cannot set the resize cursor', error)
        }
      }

      useEffect(() => {
        if (typeof window === 'undefined' || window === null) return undefined
        if (typeof window.addEventListener !== 'function') return undefined
        function onPointerMove(event) {
          const drag = columnDragRef.current
          if (drag === null) return
          const limits = columnLimits()
          if (drag.side === 'left') {
            const next = Math.round(clamp(Number(event.clientX) - drag.left, MIN_LEFT_WIDTH, limits.leftMax))
            widthRef.current = { left: next, right: widthRef.current.right }
            setLeftWidth(next)
          } else {
            const next = Math.round(clamp(drag.right - Number(event.clientX), MIN_RIGHT_WIDTH, limits.rightMax))
            widthRef.current = { left: widthRef.current.left, right: next }
            setRightWidth(next)
          }
        }
        function onPointerUp() {
          endColumnResize()
        }
        window.addEventListener('pointermove', onPointerMove)
        window.addEventListener('pointerup', onPointerUp)
        window.addEventListener('pointercancel', onPointerUp)
        return () => {
          window.removeEventListener('pointermove', onPointerMove)
          window.removeEventListener('pointerup', onPointerUp)
          window.removeEventListener('pointercancel', onPointerUp)
          endColumnResize()
        }
      }, [])

      function stepColumnWidth(side, delta) {
        const limits = columnLimits()
        if (side === 'left') {
          setLeftWidth((current) => Math.round(clamp(current + delta, MIN_LEFT_WIDTH, limits.leftMax)))
        } else {
          setRightWidth((current) => Math.round(clamp(current - delta, MIN_RIGHT_WIDTH, limits.rightMax)))
        }
      }

      // -- persistence ------------------------------------------------------
      useEffect(() => {
        writePersisted({ workspaceId: workspaceId === null ? null : workspaceId })
      }, [workspaceId])

      useEffect(() => {
        writePersisted({ selectedNodeId: selectedNodeId === null ? null : selectedNodeId })
      }, [selectedNodeId])

      useEffect(() => {
        // Dragging is high-frequency: persist once on pointer-up instead of on
        // every intermediate width.
        if (columnDragRef.current !== null) return
        writePersisted({ columnWidths: { left: leftWidth, right: rightWidth } })
      }, [leftWidth, rightWidth])

      useEffect(() => {
        writePersisted({ layoutMode })
      }, [layoutMode])

      // -- workspace list ---------------------------------------------------
      const loadWorkspaces = useCallback(async () => {
        const result = await requestJson('GET', ENDPOINTS.workspaces)
        if (result.ok === true) {
          const items = normalizeWorkspaces(result.data !== null && typeof result.data === 'object'
            ? result.data.workspaces
            : null)
          setWorkspaces({ phase: 'ready', items, fallback: false })
          return
        }
        const fallbackItems = contextWorkspaces(ctx)
        if (fallbackItems.length > 0) {
          setWorkspaces({ phase: 'ready', items: fallbackItems, fallback: true })
          return
        }
        setWorkspaces({ phase: 'error', items: [], fallback: false })
        showNotice('error', result.message || '无法加载项目列表')
      }, [ctx, showNotice])

      // -- execution catalog (agent presets + models) -----------------------
      const loadCatalog = useCallback(async () => {
        setCatalog((previous) => Object.assign({}, previous, { phase: 'loading' }))
        const result = await requestJson('GET', ENDPOINTS.catalog)
        if (result.ok !== true) {
          const remoteModels = await loadRemoteModelCatalog(ctx)
          setCatalog({
            phase: 'error',
            presets: [],
            models: remoteModels === null ? [] : remoteModels,
            warnings: [result.message || '无法读取 Agent 预设与模型目录'],
          })
          return
        }
        const catalogData = result.data !== null && typeof result.data === 'object' ? result.data.catalog : null
        const normalized = normalizeCatalog(catalogData)
        let models = normalized.models
        if (models.length === 0) {
          const remoteModels = await loadRemoteModelCatalog(ctx)
          if (remoteModels !== null) models = remoteModels
        }
        setCatalog({
          phase: 'ready',
          presets: normalized.presets,
          models,
          warnings: normalized.warnings,
        })
      }, [ctx])

      // -- current snapshot -------------------------------------------------
      const loadState = useCallback(async (id) => {
        if (typeof id !== 'string' || id === '') return
        const result = await requestJson('GET', ENDPOINTS.state + '?workspaceId=' + encodeURIComponent(id))
        if (workspaceIdRef.current !== id) return
        if (result.ok !== true) {
          const message = result.message || '无法加载图谱'
          if (snapshotRef.current !== null) {
            showNotice('error', message)
            return
          }
          setState({ phase: 'error', snapshot: null, error: message })
          return
        }
        const snapshot = result.data !== null && typeof result.data === 'object' ? result.data.snapshot : null
        if (snapshot === null || typeof snapshot !== 'object') {
          setState({ phase: 'error', snapshot: null, error: 'Host 返回的快照格式不正确' })
          return
        }
        const incomingRevision = snapshot.graph !== null && typeof snapshot.graph === 'object'
          ? toCount(snapshot.graph.revision)
          : 0
        const currentRevision = snapshotRef.current !== null && snapshotRef.current.graph !== null
          && typeof snapshotRef.current.graph === 'object'
          ? toCount(snapshotRef.current.graph.revision)
          : -1
        if (incomingRevision < currentRevision) return
        snapshotRef.current = snapshot
        setState({ phase: 'ready', snapshot, error: null })
      }, [showNotice])

      function patchWorkspaceRow(snapshot) {
        if (snapshot === null || typeof snapshot !== 'object') return
        const workspace = snapshot.workspace !== null && typeof snapshot.workspace === 'object' ? snapshot.workspace : {}
        const id = typeof workspace.workspaceId === 'string' && workspace.workspaceId !== ''
          ? workspace.workspaceId
          : workspaceIdRef.current
        if (typeof id !== 'string' || id === '') return
        const summary = buildModel(snapshot).summary
        setWorkspaces((previous) => {
          if (!previous.items.some((item) => item.workspaceId === id)) return previous
          return {
            phase: previous.phase,
            fallback: previous.fallback,
            items: previous.items.map((item) => (item.workspaceId === id
              ? Object.assign({}, item, {
                revision: snapshot.graph !== null && typeof snapshot.graph === 'object'
                  ? toCount(snapshot.graph.revision)
                  : item.revision,
                done: summary.done,
                total: summary.total,
                readyCount: summary.ready,
                doing: summary.doing,
                failed: summary.failed,
                planned: summary.planned,
              })
              : item)),
          }
        })
      }

      // -- actions (serialized: every write carries the latest revision) ----
      const runAction = useCallback((action, payload, options) => {
        // Draft autosaves are background writes: they must not flip the whole
        // panel into `busy` (which disables buttons and shows "处理中…" for a
        // moment every time the user pauses typing).
        const quiet = options !== null && typeof options === 'object' && options.quiet === true
        const execute = async () => {
          const id = workspaceIdRef.current
          if (typeof id !== 'string' || id === '') {
            showNotice('warn', '请先在左侧选择一个项目')
            return { ok: false, code: 'no-workspace' }
          }
          const current = snapshotRef.current
          const expectedRevision = current !== null && current.graph !== null && typeof current.graph === 'object'
            ? toCount(current.graph.revision)
            : 0
          if (!quiet) setPending((value) => value + 1)
          try {
            const result = await requestJson('POST', ENDPOINTS.action, {
              workspaceId: id,
              action,
              expectedRevision,
              requestId: newRequestId(),
              payload,
            })
            if (result.ok === true) {
              // A draft flush fired just before a workspace switch can still be
              // in flight; the save landed, but its snapshot belongs to the old
              // project and must not replace the one now on screen.
              if (workspaceIdRef.current !== id) return { ok: true, snapshot: null, warnings: [] }
              const snapshot = result.data !== null && typeof result.data === 'object' ? result.data.snapshot : null
              if (snapshot !== null && typeof snapshot === 'object') {
                snapshotRef.current = snapshot
                setState({ phase: 'ready', snapshot, error: null })
                patchWorkspaceRow(snapshot)
              }
              const warnings = result.data !== null && typeof result.data === 'object'
                && Array.isArray(result.data.warnings)
                ? result.data.warnings.filter((warning) => typeof warning === 'string' && warning !== '')
                : []
              return { ok: true, snapshot, warnings }
            }
            if (workspaceIdRef.current !== id) {
              // Stale-project failure: its notice would only confuse the user
              // now looking at a different graph.
              return { ok: false, code: result.code || 'stale-workspace', message: '' }
            }
            if (result.code === 'revision-conflict') {
              await loadState(id)
              showNotice('warn', CONFLICT_TEXT)
              return { ok: false, code: result.code, message: CONFLICT_TEXT }
            }
            const message = typeof result.message === 'string' && result.message !== '' ? result.message : '操作失败'
            showNotice('error', message)
            return { ok: false, code: result.code, message }
          } catch (error) {
            console.error('[dsh-task-dag] action failed', action, error)
            showNotice('error', '操作失败：' + errText(error))
            return { ok: false, code: 'client-error', message: errText(error) }
          } finally {
            if (!quiet) setPending((value) => value - 1)
          }
        }
        const next = queueRef.current.then(execute, execute)
        queueRef.current = next.then(() => undefined, () => undefined)
        return next
      }, [loadState, showNotice])

      // -- open a session in the chat panel ---------------------------------
      const openSession = useCallback((sessionId) => {
        try {
          const ui = ctx !== null && typeof ctx === 'object' ? ctx.uiWorkspace : null
          if (ui !== null && typeof ui === 'object' && typeof ui.openSession === 'function') {
            ui.openSession(sessionId)
            return
          }
          showNotice('warn', '当前界面不支持直接打开会话，请在侧栏会话列表里手动打开')
        } catch (error) {
          console.error('[dsh-task-dag] openSession failed', error)
          showNotice('error', '打开会话失败：' + errText(error))
        }
      }, [ctx, showNotice])

      // -- initial loads, workspace switching, SSE --------------------------
      useEffect(() => {
        loadWorkspaces()
      }, [loadWorkspaces])

      useEffect(() => {
        loadCatalog()
      }, [loadCatalog])

      useEffect(() => {
        // Position undo is workspace-scoped: a snapshot from another project
        // must never be posted as positions to this one.
        dropUndoStack()
        if (workspaceId === null) {
          snapshotRef.current = null
          setState({ phase: 'idle', snapshot: null, error: null })
          return
        }
        snapshotRef.current = null
        setState({ phase: 'loading', snapshot: null, error: null })
        loadState(workspaceId)
      }, [workspaceId, loadState, dropUndoStack])

      useEffect(() => {
        if (workspaces.phase !== 'ready' || workspaces.items.length === 0) return
        if (workspaceId !== null && workspaces.items.some((item) => item.workspaceId === workspaceId)) return
        const firstWithGraph = workspaces.items.find((item) => item.total > 0)
        const next = firstWithGraph !== undefined ? firstWithGraph : workspaces.items[0]
        setWorkspaceId(next.workspaceId)
      }, [workspaces, workspaceId])

      useEffect(() => {
        if (workspaceId === null) {
          setLive(false)
          return undefined
        }
        setLive(false)
        let closed = false
        let source = null
        try {
          source = new EventSource(ENDPOINTS.events + '?workspaceId=' + encodeURIComponent(workspaceId))
        } catch (error) {
          console.error('[dsh-task-dag] cannot open the live stream', error)
          return undefined
        }
        source.onopen = () => {
          if (!closed) setLive(true)
        }
        source.onmessage = () => {
          if (closed) return
          if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current)
          refreshTimerRef.current = setTimeout(() => {
            if (!closed) loadState(workspaceId)
          }, 120)
        }
        source.onerror = () => {
          if (!closed) setLive(false)
        }
        return () => {
          closed = true
          if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current)
          try {
            source.close()
          } catch (error) {
            console.error('[dsh-task-dag] closing the live stream failed', error)
          }
        }
      }, [workspaceId, loadState])

      useEffect(() => {
        function onVisibilityChange() {
          if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
          loadWorkspaces()
          const id = workspaceIdRef.current
          if (typeof id === 'string' && id !== '') loadState(id)
        }
        document.addEventListener('visibilitychange', onVisibilityChange)
        return () => document.removeEventListener('visibilitychange', onVisibilityChange)
      }, [loadWorkspaces, loadState])

      // -- derived model ----------------------------------------------------
      const model = useMemo(() => buildModel(state.snapshot), [state.snapshot])

      useEffect(() => {
        if (state.snapshot === null) return
        if (selectedNodeId !== null && !model.nodeIds.has(selectedNodeId)) setSelectedNodeId(null)
        if (selectedEdgeId !== null && model.edges.every((edge) => edge.id !== selectedEdgeId)) setSelectedEdgeId(null)
        if (selectedGroupId !== null && model.groups.every((group) => group.id !== selectedGroupId)) {
          setSelectedGroupId(null)
        }
      }, [state.snapshot, model, selectedNodeId, selectedEdgeId, selectedGroupId])

      const currentWorkspace = useMemo(() => {
        const found = workspaces.items.find((item) => item.workspaceId === workspaceId)
        if (found !== undefined) return found
        if (workspaceId === null) return null
        const meta = state.snapshot !== null && state.snapshot.workspace !== null
          && typeof state.snapshot.workspace === 'object'
          ? state.snapshot.workspace
          : {}
        return {
          workspaceId,
          title: typeof meta.title === 'string' ? meta.title : '',
          path: typeof meta.path === 'string' ? meta.path : '',
          revision: 0,
          done: 0,
          total: 0,
          readyCount: 0,
        }
      }, [workspaces.items, workspaceId, state.snapshot])

      // -- canvas callbacks -------------------------------------------------
      const flushDrafts = useCallback(() => {
        const flush = draftFlushRef.current
        if (typeof flush === 'function') flush()
      }, [])

      const registerDraftFlush = useCallback((flush) => {
        draftFlushRef.current = typeof flush === 'function' ? flush : null
      }, [])

      // -- undo: drag and auto layout both restore the previous positions ----
      // Positions live on the Host, so a snapshot of the positions the user saw
      // is enough to bring the canvas back: undo re-posts them as explicit
      // coordinates. The stack is per workspace and deliberately in memory.
      const copyPositions = useCallback((source) => {
        const snapshot = {}
        const ids = source !== null && typeof source === 'object' ? Object.keys(source) : []
        for (const nodeId of ids) {
          const point = source[nodeId]
          if (point === null || point === undefined) continue
          const x = Number(point.x)
          const y = Number(point.y)
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue
          snapshot[nodeId] = { x: Math.round(x), y: Math.round(y) }
        }
        return snapshot
      }, [])
      const pushUndoEntry = useCallback((label, positions) => {
        if (positions === null || positions === undefined) return
        const snapshot = copyPositions(positions)
        if (Object.keys(snapshot).length === 0) return
        undoRef.current.push({ label, positions: snapshot })
        if (undoRef.current.length > UNDO_LIMIT) undoRef.current.shift()
        setUndoDepth(undoRef.current.length)
      }, [copyPositions])
      const handleUndo = useCallback(async () => {
        const entry = undoRef.current.pop()
        setUndoDepth(undoRef.current.length)
        if (entry === undefined) return
        const positions = []
        for (const nodeId of Object.keys(entry.positions)) {
          if (!model.nodeIds.has(nodeId)) continue
          positions.push({ nodeId, position: entry.positions[nodeId] })
        }
        if (positions.length === 0) {
          showNotice('warn', '这些节点已经不在图里，没有可以撤销的位置')
          return
        }
        flushDrafts()
        const result = await runAction('set-positions', { positions })
        if (result !== null && result !== undefined && result.ok === true) {
          showNotice('info', '已撤销：' + entry.label)
          return
        }
        // The undo did not land (conflict/offline): keep it so the user can retry.
        undoRef.current.push(entry)
        setUndoDepth(undoRef.current.length)
      }, [flushDrafts, model, runAction, showNotice])

      const handleSelectNode = useCallback((nodeId) => {
        flushDrafts()
        setSelectedNodeId(typeof nodeId === 'string' && nodeId !== '' ? nodeId : null)
        setSelectedEdgeId(null)
        setSelectedGroupId(null)
        setFocusTitle(false)
      }, [flushDrafts])

      const handleSelectEdge = useCallback((edgeId) => {
        flushDrafts()
        setSelectedEdgeId(edgeId)
        setSelectedGroupId(null)
      }, [flushDrafts])

      const handleSelectGroup = useCallback((groupId) => {
        flushDrafts()
        setSelectedGroupId(typeof groupId === 'string' && groupId !== '' ? groupId : null)
        setSelectedNodeId(null)
        setSelectedEdgeId(null)
        setFocusTitle(false)
      }, [flushDrafts])

      // -- lasso groups ------------------------------------------------------
      const handleLasso = useCallback((nodeIds) => {
        const list = Array.isArray(nodeIds) ? nodeIds.filter((nodeId) => typeof nodeId === 'string' && nodeId !== '') : []
        if (list.length === 0) {
          showNotice('warn', '圈选路径里没有完全包含的节点（只碰到边的不计入）')
          return
        }
        if (list.length < 2) {
          showNotice('warn', '组合至少需要两个节点：请把节点整个圈进去')
          return
        }
        setGroupDraft({ mode: 'create', nodeIds: list })
      }, [showNotice])

      const handleRenameGroup = useCallback((groupId) => {
        const group = model.groups.find((item) => item.id === groupId)
        if (group === undefined) return
        flushDrafts()
        setGroupDraft({ mode: 'rename', groupId, initialName: group.name })
      }, [flushDrafts, model])

      const handleDeleteGroup = useCallback(async (groupId) => {
        const result = await runAction('delete-group', { groupId })
        if (result !== null && result !== undefined && result.ok === true) {
          setSelectedGroupId(null)
          showNotice('info', '已解散组合，节点本身不变')
        }
      }, [runAction, showNotice])

      const handleConfirmGroup = useCallback(async (name) => {
        const draft = groupDraft
        if (draft === null) return { ok: false, code: 'no-draft' }
        if (draft.mode === 'rename') {
          const result = await runAction('rename-group', { groupId: draft.groupId, name })
          if (result !== null && result !== undefined && result.ok === true) {
            showNotice('info', '组合名称已更新为「' + name + '」')
          }
          return result
        }
        const result = await runAction('create-group', { name, nodeIds: draft.nodeIds })
        if (result !== null && result !== undefined && result.ok === true) {
          // Select the group that was just created so its bar (rename/dissolve)
          // is immediately reachable.
          const snapshot = result.snapshot
          const groups = snapshot !== null && snapshot !== undefined
            && snapshot.graph !== null && typeof snapshot.graph === 'object'
            && Array.isArray(snapshot.graph.groups)
            ? snapshot.graph.groups
            : []
          const created = groups.find((group) => group.name === name
            && Array.isArray(group.nodeIds)
            && group.nodeIds.length === draft.nodeIds.length)
          if (created !== undefined) setSelectedGroupId(created.id)
          showNotice('info', '已创建组合「' + name + '」')
        }
        return result
      }, [groupDraft, runAction, showNotice])

      const handleCreateNode = useCallback(async (position) => {
        flushDrafts()
        const before = snapshotRef.current
        const beforeIds = new Set(
          before !== null && before.graph !== null && typeof before.graph === 'object' && Array.isArray(before.graph.nodes)
            ? before.graph.nodes.map((node) => node.id)
            : [],
        )
        const payload = { title: '新任务' }
        let desiredPosition = null
        if (position !== null && position !== undefined
          && Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.y))) {
          desiredPosition = { x: Number(position.x), y: Number(position.y) }
        }
        if (layoutMode === 'grid') {
          payload.position = snapNewNodeToGrid(
            model.positions,
            model.nodes,
            desiredPosition === null ? { x: AUTO_X0, y: AUTO_Y0 } : desiredPosition,
          )
        } else if (desiredPosition !== null) {
          payload.position = desiredPosition
        }
        const result = await runAction('add-node', payload)
        if (result === null || result === undefined || result.ok !== true) return
        const createdNodes = result.snapshot !== null && result.snapshot !== undefined
          && result.snapshot.graph !== null && typeof result.snapshot.graph === 'object'
          && Array.isArray(result.snapshot.graph.nodes)
          ? result.snapshot.graph.nodes
          : []
        const created = createdNodes.find((node) => !beforeIds.has(node.id))
        if (created !== undefined) {
          setSelectedNodeId(created.id)
          setSelectedEdgeId(null)
          setFocusTitle(true)
        }
        showNotice('info', '已新建任务节点，请在右侧填写标题')
      }, [flushDrafts, runAction, showNotice, layoutMode, model])

      const handleMoveNode = useCallback((nodeId, position, displaced, beforePositions) => {
        if (position === null || position === undefined) return
        const entries = [{
          nodeId,
          position: { x: Math.round(Number(position.x)), y: Math.round(Number(position.y)) },
        }]
        if (Array.isArray(displaced)) {
          for (const item of displaced) {
            if (item === null || typeof item !== 'object') continue
            if (typeof item.nodeId !== 'string' || item.nodeId === '') continue
            if (typeof item.position !== 'object' || item.position === null) continue
            if (!Number.isFinite(Number(item.position.x)) || !Number.isFinite(Number(item.position.y))) continue
            entries.push({
              nodeId: item.nodeId,
              position: { x: Math.round(Number(item.position.x)), y: Math.round(Number(item.position.y)) },
            })
          }
        }
        const result = runAction('set-positions', { positions: entries })
        // Only a landed move becomes undoable: the pre-drag positions are kept
        // out of the stack while the write is still in flight.
        if (beforePositions !== null && beforePositions !== undefined
          && result !== null && typeof result === 'object' && typeof result.then === 'function') {
          result.then((outcome) => {
            if (outcome !== null && outcome !== undefined && outcome.ok === true) {
              pushUndoEntry('拖动节点', beforePositions)
            }
          }).catch(() => {})
        }
        return result
      }, [runAction, pushUndoEntry])

      // -- linking: drag opens the condition chooser, confirm posts `link` ---
      const handleRequestLink = useCallback((from, to) => {
        if (typeof from !== 'string' || typeof to !== 'string' || from === to) return
        flushDrafts()
        setLinkDraft({ from, to })
        setSelectedNodeId(null)
        setSelectedEdgeId(null)
      }, [flushDrafts])

      const handleConfirmLink = useCallback(async (payload) => {
        const result = await runAction('link', payload)
        if (result !== null && result !== undefined && result.ok === true) {
          showNotice('info', '已添加前置条件')
        }
        return result
      }, [runAction, showNotice])

      const handleDeleteEdge = useCallback(async (edgeId) => {
        const result = await runAction('unlink', { edgeId })
        if (result !== null && result !== undefined && result.ok === true) {
          setSelectedEdgeId(null)
          showNotice('info', '已解除关联')
        }
      }, [runAction, showNotice])

      const toggleLayoutMode = useCallback(async () => {
        const next = layoutMode === 'grid' ? 'free' : 'grid'
        setLayoutMode(next)
        if (next === 'free') {
          showNotice('info', '已切换到自由布局')
          return
        }
        const current = snapshotRef.current
        const nodes = current !== null && current.graph !== null && typeof current.graph === 'object'
          && Array.isArray(current.graph.nodes)
          ? current.graph.nodes
          : []
        if (nodes.length === 0) {
          showNotice('info', '已切换到网格布局')
          return
        }
        const snapped = gridAssignments(model.positions, nodes)
        const result = await runAction('set-positions', {
          positions: nodes.map((node) => ({ nodeId: node.id, position: snapped[node.id] })),
        })
        if (result !== null && result !== undefined && result.ok === true) {
          showNotice('info', '已切换到网格布局，节点中心已吸附到黄金比例网格')
        }
      }, [layoutMode, model, runAction, showNotice])

      const handleAutoLayout = useCallback(async () => {
        const current = snapshotRef.current
        const graph = current !== null && current.graph !== null && typeof current.graph === 'object'
          ? current.graph
          : null
        const nodes = graph !== null && Array.isArray(graph.nodes) ? graph.nodes : []
        // Everything the user currently sees, so one undo restores the layout
        // that existed before the auto layout was requested.
        const before = copyPositions(layoutMode === 'grid'
          ? gridAssignments(model.positions, model.nodes)
          : model.positions)
        if (layoutMode === 'grid') {
          if (nodes.length === 0) {
            showNotice('info', '没有需要布局的节点')
            return
          }
          const edges = Array.isArray(graph.edges) ? graph.edges : []
          const snapped = gridAssignments(autoGraphPositions(nodes, edges), nodes)
          const result = await runAction('set-positions', {
            positions: nodes.map((node) => ({ nodeId: node.id, position: snapped[node.id] })),
          })
          if (result !== null && result !== undefined && result.ok === true) {
            pushUndoEntry('自动布局', before)
            showNotice('info', '已按网格重新布局')
          }
          return
        }
        const moved = nodes.filter((node) => node.position !== null && typeof node.position === 'object'
          && Number.isFinite(Number(node.position.x)) && Number.isFinite(Number(node.position.y)))
        if (moved.length === 0) {
          showNotice('info', '所有节点已经在自动布局位置')
          return
        }
        const result = await runAction('set-positions', {
          positions: moved.map((node) => ({ nodeId: node.id, position: null })),
        })
        if (result !== null && result !== undefined && result.ok === true) {
          pushUndoEntry('自动布局', before)
          showNotice('info', '已恢复自动布局')
        }
      }, [layoutMode, model, runAction, showNotice, copyPositions, pushUndoEntry])

      const refreshAll = useCallback(() => {
        loadWorkspaces()
        loadCatalog()
        const id = workspaceIdRef.current
        if (typeof id === 'string' && id !== '') loadState(id)
      }, [loadWorkspaces, loadCatalog, loadState])

      // -- header -----------------------------------------------------------
      const summary = model.summary
      const milestoneNode = model.milestoneNode
      const header = h('div', { className: 'dsh-td-header' },
        h('h2', { className: 'dsh-td-heading' }, PANEL_LABEL),
        currentWorkspace !== null
          ? h('span', { className: 'dsh-td-heading-sub', title: currentWorkspace.path || '' }, currentWorkspace.title)
          : h('span', { className: 'dsh-td-heading-sub' }, '未选择项目'),
        h('div', { className: 'dsh-td-summary' },
          h('span', null, '已完成 ',
            h('span', { className: 'dsh-td-summary-strong' }, String(summary.done) + '/' + String(summary.total))),
          h('span', null, '可开始 ',
            h('span', { className: 'dsh-td-summary-strong' }, String(summary.ready))),
          h('span', null, '阻塞 ',
            h('span', { className: 'dsh-td-summary-strong' }, String(summary.blocked))),
          summary.doing > 0
            ? h('span', null, '进行中 ',
              h('span', { className: 'dsh-td-summary-strong' }, String(summary.doing)))
            : null,
          summary.failed > 0
            ? h('span', { title: '已失败的节点不能再当前序' }, '失败 ',
              h('span', { className: 'dsh-td-summary-strong' }, String(summary.failed)))
            : null,
          milestoneNode !== null
            ? h('span', { title: '里程碑只是图上的标记，节点完成不代表项目结束' },
              '里程碑：' + milestoneNode.title + (milestoneNode.status === 'done' ? ' ✓' : ''))
            : null,
        ),
        model.notes.length > 0
          ? h(Chip, { kind: 'muted', title: model.notes.join('\n') }, '提示 ' + String(model.notes.length))
          : null,
        h('div', { className: 'dsh-td-spacer' }),
        h('span', { className: 'dsh-td-live', title: live ? '已连接 Host 事件流' : 'Host 事件流未连接' },
          h('span', { className: 'dsh-td-live-dot' + (live ? ' dsh-td-live-dot-on' : '') }),
          live ? '实时同步' : '未连接',
        ),
        h('button', {
          type: 'button',
          className: 'dsh-td-btn dsh-td-btn-sm',
          onClick: refreshAll,
          disabled: busy,
        }, busy ? '处理中…' : '刷新'),
      )

      const noticeBar = notice !== null
        ? h('div', { className: 'dsh-td-notice dsh-td-notice-' + notice.kind, role: 'status' },
          h('span', { className: 'dsh-td-notice-text' }, notice.text),
          h('button', {
            type: 'button',
            className: 'dsh-td-btn dsh-td-btn-sm dsh-td-btn-text',
            onClick: () => setNotice(null),
          }, '知道了'),
        )
        : null

      // -- canvas overlay ---------------------------------------------------
      function overlayCard(title, text, action) {
        return h('div', { className: 'dsh-td-overlay' },
          h('div', { className: 'dsh-td-overlay-card' },
            h('div', { className: 'dsh-td-overlay-title' }, title),
            text !== null ? h('div', { className: 'dsh-td-overlay-text' }, text) : null,
            action !== null
              ? h('button', {
                type: 'button',
                className: 'dsh-td-btn dsh-td-btn-primary',
                onClick: action.onClick,
                disabled: busy,
              }, action.label)
              : null,
          ),
        )
      }

      let overlay = null
      if (workspaceId === null) {
        overlay = overlayCard('请选择一个项目',
          '左侧列表是 DSH 工作区；每个工作区有一张任务图，存放在项目目录的 .dsh-task-graph/graph.json。', null)
      } else if (state.phase === 'loading') {
        overlay = overlayCard('正在加载图谱…', '正在读取这个工作区的任务图。', null)
      } else if (state.phase === 'error') {
        overlay = overlayCard('图谱加载失败', state.error || '未知错误', {
          label: '重试',
          onClick: () => loadState(workspaceId),
        })
      } else if (state.phase === 'ready' && model.nodes.length === 0) {
        overlay = overlayCard('还没有任务节点', '双击画布空白处新建第一个节点，或点击左上角「新建节点」。', {
          label: '新建节点',
          onClick: () => handleCreateNode(null),
        })
      }

      return h('div', { className: 'dsh-td-root' },
        header,
        h('div', { className: 'dsh-td-body', ref: bodyRef },
          h(WorkspaceColumn, {
            items: workspaces.items,
            phase: workspaces.phase,
            fallback: workspaces.fallback,
            currentId: workspaceId,
            width: leftWidth,
            onSelect: (id) => {
              if (id === workspaceId) return
              flushDrafts()
              setSelectedNodeId(null)
              setSelectedEdgeId(null)
              setSelectedGroupId(null)
              setGroupDraft(null)
              setLinkDraft(null)
              setWorkspaceId(id)
            },
            onReload: loadWorkspaces,
          }),
          h(ColumnSplitter, {
            key: 'split-left',
            label: '调整项目列表宽度',
            width: leftWidth,
            min: MIN_LEFT_WIDTH,
            max: MAX_LEFT_WIDTH,
            onStart: (event) => startColumnResize('left', event),
            onReset: () => setLeftWidth(DEFAULT_LEFT_WIDTH),
            onStep: (delta) => stepColumnWidth('left', delta),
          }),
          h('div', { className: 'dsh-td-main' + (notice !== null ? ' dsh-td-main-notice' : '') },
            h(GraphCanvas, {
              model,
              selectedNodeId,
              selectedEdgeId,
              selectedGroupId,
              layoutMode,
              onToggleLayoutMode: toggleLayoutMode,
              onSelectNode: handleSelectNode,
              onSelectEdge: handleSelectEdge,
              onSelectGroup: handleSelectGroup,
              onRenameGroup: handleRenameGroup,
              onDeleteGroup: handleDeleteGroup,
              onMoveNode: handleMoveNode,
              onCreateNode: handleCreateNode,
              onRequestLink: handleRequestLink,
              onDeleteEdge: handleDeleteEdge,
              onAutoLayout: handleAutoLayout,
              onLasso: handleLasso,
              onUndo: handleUndo,
              canUndo: undoDepth > 0,
            }),
            overlay,
            linkDraft !== null
              ? h(LinkConditionDialog, {
                key: 'link:' + linkDraft.from + '→' + linkDraft.to,
                model,
                from: linkDraft.from,
                to: linkDraft.to,
                onConfirm: handleConfirmLink,
                onCancel: () => setLinkDraft(null),
                onDone: () => setLinkDraft(null),
              })
              : null,
            groupDraft !== null
              ? h(GroupNameDialog, {
                key: 'group:' + (groupDraft.mode === 'rename'
                  ? groupDraft.groupId
                  : groupDraft.nodeIds.join('|')),
                mode: groupDraft.mode,
                nodeCount: groupDraft.mode === 'rename' ? 0 : groupDraft.nodeIds.length,
                initialName: groupDraft.mode === 'rename'
                  ? groupDraft.initialName
                  : nextGroupName(model.groups),
                hasExistingMembers: groupDraft.mode === 'create'
                  && groupDraft.nodeIds.some((nodeId) => model.groupOfNode[nodeId] !== undefined),
                onConfirm: handleConfirmGroup,
                onCancel: () => setGroupDraft(null),
                onDone: () => setGroupDraft(null),
              })
              : null,
            // Operation feedback belongs to the canvas column and floats above
            // it: showing or hiding it never reflows the graph.
            noticeBar !== null ? h('div', { className: 'dsh-td-notice-dock' }, noticeBar) : null,
          ),
          h(ColumnSplitter, {
            key: 'split-right',
            label: '调整节点详情宽度',
            width: rightWidth,
            min: MIN_RIGHT_WIDTH,
            max: MAX_RIGHT_WIDTH,
            onStart: (event) => startColumnResize('right', event),
            onReset: () => setRightWidth(DEFAULT_RIGHT_WIDTH),
            onStep: (delta) => stepColumnWidth('right', delta),
          }),
          h(DetailDrawer, {
            model,
            workspace: currentWorkspace,
            nodeId: selectedNodeId,
            width: rightWidth,
            catalog,
            busy,
            act: runAction,
            notify: showNotice,
            ctx,
            focusTitle,
            onTitleFocused: () => setFocusTitle(false),
            onSelectNode: handleSelectNode,
            onDraftFlush: registerDraftFlush,
            onClose: () => {
              flushDrafts()
              setSelectedNodeId(null)
            },
            onDeleted: () => {
              flushDrafts()
              setSelectedNodeId(null)
            },
            onOpenSession: openSession,
          }),
        ),
      )
    }

    // =======================================================================
    // 13. Sidebar icon, error boundary, slot registration
    // =======================================================================
    function TaskDagIcon(props) {
      const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 18
      const active = props !== null && props !== undefined && props.active === true
      return h('svg', {
        className: 'dsh-td-icon',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        'data-active': active ? 'true' : 'false',
        style: {
          display: 'block',
          stroke: 'currentColor',
          color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        },
      },
        h('path', {
          d: 'M7.4 6 C 12 6, 12 12, 16.6 12',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M7.4 18 C 12 18, 12 12, 16.6 12',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 5, cy: 6, r: 2.4, fill: 'currentColor' }),
        h('circle', { cx: 5, cy: 18, r: 2.4, fill: 'currentColor' }),
        h('circle', { cx: 19, cy: 12, r: 2.4, fill: 'currentColor' }),
      )
    }

    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        console.error('[dsh-task-dag] panel render failed', error, info)
      }

      render() {
        if (this.state.error !== null) {
          return h('div', { className: 'dsh-td-root dsh-td-fatal' },
            h('div', { className: 'dsh-td-overlay-title' }, '任务图谱面板出错'),
            h('div', { className: 'dsh-td-overlay-text' }, errText(this.state.error)),
            h('button', {
              type: 'button',
              className: 'dsh-td-btn',
              onClick: () => this.setState({ error: null }),
            }, '重试'),
          )
        }
        return this.props.children
      }
    }

    return {
      inject: ['slots', 'workspaces', 'sessions', 'uiWorkspace', 'layout'],
      apply(ctx) {
        if (!claimMount()) return
        try {
          injectStyles()

          // Release the claim when the plugin fiber is unloaded (hot reload),
          // so the rebuilt bundle can register again instead of being dropped.
          try {
            if (ctx !== null && typeof ctx === 'object' && typeof ctx.effect === 'function') {
              ctx.effect(() => () => releaseMount(), 'dsh-task-dag: release client apply guard')
            }
          } catch (error) {
            console.error('[dsh-task-dag] cannot register the apply-guard cleanup', error)
          }

          function PanelRoot() {
            return h(PanelBoundary, null, h(TaskDagPage, { ctx }))
          }

          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, PanelRoot))

          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 25,
            // A plain string (not a fresh closure) keeps the resolved label
            // identity stable across slot re-syncs, so the row never flickers
            // through an empty label during a reload.
            label: PANEL_LABEL,
          }, TaskDagIcon))

          // If a previous client bundle instance was showing this panel when it
          // was replaced, put the user back after re-registering. The watcher
          // then keeps the flag in sync with deliberate navigation.
          restorePanelAfterReload(ctx)
          try {
            if (ctx !== null && typeof ctx === 'object' && typeof ctx.effect === 'function') {
              ctx.effect(() => watchPanelActivity(ctx), 'dsh-task-dag: track the active panel')
            }
          } catch (error) {
            console.error('[dsh-task-dag] cannot register the active-panel watcher', error)
          }
        } catch (error) {
          releaseMount()
          console.error('[dsh-task-dag] client apply failed', error)
        }
      },
    }
  },
})
