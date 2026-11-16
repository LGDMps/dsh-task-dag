/**
 * Per-node time-window enforcement for the task DAG.
 *
 * The plugin does not schedule work any more: DSH's own automations own "run
 * something at a wall-clock time". What this module enforces is the task's own
 * window:
 *
 *   - `timing.startAt` is checked by the mutation layer before a task can be
 *     started, so a planned task cannot begin early;
 *   - `timing.maxRunMinutes` bounds one Agent run from its `turn/start`;
 *   - `timing.deadlineAt` is an absolute cutoff.
 *
 * A run that outlives either bound is cancelled through `session/cancel` and
 * the node returns to `todo`. The session chain is untouched, so the same
 * conversation can be resumed later. The watcher is deliberately small: one
 * periodic scan, no cron expression parser, no automatic session creation.
 */
import { CODES, TaskDagError, isTaskDagError } from './errors.js'
import { activeSession, findNode } from './model.js'
import { markTimingTimeout } from './ops.js'
import { cancelSession, readSessionEvents, sessionFacts } from './sessions.js'
import { listWorkspaces } from './workspaces.js'

/** Scan cadence: a run may overshoot its window by at most roughly this much. */
export const DEFAULT_TIMING_TICK_MS = 30_000

/** How many recent events to inspect when locating the current `turn/start`. */
export const RUN_START_EVENT_WINDOW = 80

const MAX_WARN_CHARS = 300

function reasonOf(error) {
  const text = error instanceof Error && typeof error.message === 'string' && error.message !== ''
    ? error.message
    : String(error)
  return text.length > MAX_WARN_CHARS ? `${text.slice(0, MAX_WARN_CHARS)}…` : text
}

/** One event time as epoch ms; ISO strings and seconds are accepted too. */
export function eventTimeMs(value) {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 100_000_000_000) return value
    if (value >= 100_000_000) return value * 1000
  }
  return null
}

/**
 * Start of the currently open turn, derived from a chronological event list.
 * `turn/end` closes a turn, so only a `turn/start` after the last `turn/end`
 * counts. Returns null when the window does not contain one.
 */
export function runStartedAtFromEvents(events) {
  let startedAt = null
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'turn/start') startedAt = eventTimeMs(event.time)
    else if (event.type === 'turn/end') startedAt = null
  }
  return startedAt
}

/**
 * Earliest enforced cutoff of one run, or null when the node sets neither a
 * per-run limit nor an absolute deadline. `runStartedMs` may be null when the
 * limit cannot be placed yet; an absolute deadline still applies.
 */
export function effectiveTimingDeadline(timing, runStartedMs) {
  if (timing === null || typeof timing !== 'object') return null
  const candidates = []
  if (Number.isInteger(timing.maxRunMinutes) && timing.maxRunMinutes > 0
    && Number.isFinite(runStartedMs)) {
    candidates.push({ reason: 'run-limit', at: runStartedMs + timing.maxRunMinutes * 60_000 })
  }
  if (typeof timing.deadlineAt === 'string' && timing.deadlineAt !== '') {
    const at = Date.parse(timing.deadlineAt)
    if (Number.isFinite(at)) candidates.push({ reason: 'deadline', at })
  }
  if (candidates.length === 0) return null
  candidates.sort((left, right) => left.at - right.at)
  return candidates[0]
}

export class TaskTimingWatcher {
  /**
   * @param {object} ctx host context
   * @param {{read: Function, commit: Function}} store graph store
   * @param {{tickMs?: number, now?: () => number, sessionFacts?: Function,
   *   readEvents?: Function, cancelSession?: Function,
   *   markTimeout?: Function}} [options] test seams
   */
  constructor(ctx, store, options = {}) {
    this.ctx = ctx
    this.store = store
    this.tickMs = Number.isFinite(options.tickMs) && options.tickMs > 0
      ? options.tickMs
      : DEFAULT_TIMING_TICK_MS
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.readFacts = typeof options.sessionFacts === 'function' ? options.sessionFacts : sessionFacts
    this.readEvents = typeof options.readEvents === 'function' ? options.readEvents : readSessionEvents
    this.cancel = typeof options.cancelSession === 'function' ? options.cancelSession : cancelSession
    this.markTimeout = typeof options.markTimeout === 'function' ? options.markTimeout : markTimingTimeout
    this.timers = []
    this.tickInFlight = false
    this.busy = new Set()
    this.disposed = false
  }

  /** Start the periodic scan. The immediate scan also covers a Host restart. */
  start() {
    if (this.disposed || this.timers.length > 0) return this
    this.timers.push(setInterval(() => { void this.#timerTick() }, this.tickMs))
    this.timers[0]?.unref?.()
    void this.#timerTick()
    return this
  }

  stop() {
    this.disposed = true
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
  }

  #timerTick() {
    if (this.disposed || this.tickInFlight) return
    this.tickInFlight = true
    void this.tick()
      .catch((error) => {
        console.error('[dsh-task-dag] 时间窗口扫描失败', error)
      })
      .finally(() => { this.tickInFlight = false })
  }

  /** Scan every workspace once. Public so tests can drive one deterministic pass. */
  async tick(nowMs = this.now()) {
    for (const workspace of listWorkspaces(this.ctx)) {
      if (this.disposed) return
      let graph
      try {
        graph = this.store.read(workspace).graph
      } catch (error) {
        console.error(`[dsh-task-dag] 读取 ${workspace?.workspaceId ?? ''} 的任务图失败`, error)
        continue
      }
      const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
      for (const node of nodes) {
        if (this.disposed) return
        if (node?.status !== 'doing') continue
        const timing = node.timing
        if (timing === null || typeof timing !== 'object') continue
        if (!Number.isInteger(timing.maxRunMinutes) && !timing.deadlineAt) continue
        const session = activeSession(node)
        if (session === undefined) continue
        const key = `${workspace.workspaceId}:${node.id}`
        if (this.busy.has(key)) continue
        this.busy.add(key)
        try {
          await this.#inspectNode(workspace, node, session.sessionId, nowMs)
        } catch (error) {
          console.error(`[dsh-task-dag] 检查节点 ${node.id} 的时间窗口失败`, error)
        } finally {
          this.busy.delete(key)
        }
      }
    }
  }

  async #inspectNode(workspace, node, sessionId, nowMs) {
    const facts = await this.readFacts(this.ctx, [sessionId], nowMs)
    const fact = facts !== null && typeof facts === 'object'
      && facts.byId !== null && typeof facts.byId === 'object'
      ? facts.byId[sessionId]
      : undefined
    if (fact === undefined || fact.running !== true) return

    let runStartedMs = null
    try {
      const tail = await this.readEvents(this.ctx, sessionId, RUN_START_EVENT_WINDOW)
      runStartedMs = runStartedAtFromEvents(tail?.events)
    } catch (error) {
      console.warn(`[dsh-task-dag] 读取会话 ${sessionId} 的开始时间失败：${reasonOf(error)}`)
    }
    if (runStartedMs === null) {
      runStartedMs = typeof fact.updatedAt === 'number' && Number.isFinite(fact.updatedAt)
        ? fact.updatedAt
        : nowMs
    }

    const cutoff = effectiveTimingDeadline(node.timing, runStartedMs)
    if (cutoff === null || nowMs < cutoff.at) return

    try {
      await this.cancel(this.ctx, sessionId)
    } catch (error) {
      console.warn(`[dsh-task-dag] 取消超时会话 ${sessionId} 失败，稍后重试：${reasonOf(error)}`)
      return
    }
    await this.#commitTimeout(workspace, node.id, sessionId, cutoff.reason, nowMs)
  }

  /** Retry the CAS a few times: the cancel already happened, so the pause must land. */
  async #commitTimeout(workspace, nodeId, sessionId, reason, nowMs) {
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let graph
      try {
        graph = this.store.read(workspace).graph
      } catch (error) {
        lastError = error
        continue
      }
      const current = findNode(graph, nodeId)
      if (current === undefined || current.status !== 'doing') return
      try {
        await this.store.commit(workspace, graph.revision, (latest) => {
          const outcome = this.markTimeout(latest, {
            nodeId,
            reason,
            sessionId,
            now: new Date(nowMs).toISOString(),
          })
          if (outcome === null || outcome === undefined) {
            throw new TaskDagError(CODES.hostUnavailable, '时间窗口结算没有返回结果。', { status: 503 })
          }
          if (outcome.result?.applied !== true) return { next: latest }
          return { next: outcome.next, event: outcome.event }
        })
        return
      } catch (error) {
        lastError = error
        if (isTaskDagError(error) && error.code !== CODES.revisionConflict) throw error
      }
    }
    if (lastError !== null) {
      console.error(`[dsh-task-dag] 保存节点 ${nodeId} 的超时状态失败`, lastError)
    }
  }
}
