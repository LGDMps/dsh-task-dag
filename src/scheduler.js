/**
 * Per-node scheduled execution for the task DAG.
 *
 * A node may carry a `schedule` (5-field cron) and an Agent preset/model. The
 * scheduler is the only component that turns time into work:
 *
 *  - `tick` scans every workspace graph, and for each enabled node whose
 *    `nextRunAt` is due it re-computes the next occurrence from *now* (missed
 *    occurrences are never replayed), checks the skip rules, then starts one
 *    blank session, attaches it as the node's current session, renames it and
 *    sends the deterministic execution brief;
 *  - `pollExecutions` settles those sessions: once `session/list` says the
 *    session is idle, the last `turn/end` event decides succeeded/failed and
 *    `ops.applyExecutionOutcome` applies the same status semantics the rest of
 *    the plugin uses. The schedule result fields are written in the same commit.
 *
 * The Host has no durable execution table here on purpose: the graph itself is
 * the ledger (`status: doing` + `schedule.lastSessionId`), so restart recovery
 * is just a scan of the graphs at startup. Everything is best effort — a broken
 * gateway or one bad node must never take down the tick or the plugin.
 */
import { CODES, TaskDagError } from './errors.js'
import { activeSession, findNode, nextSlot } from './model.js'
import { applyExecutionOutcome } from './ops.js'
import { isValidCron, nextRunAtMs } from './cron.js'
import {
  createBlankSession,
  promptSession,
  readSessionEvents,
  renameSession,
  renderDescriptionSection,
  sessionFacts,
} from './sessions.js'
import { getService } from './services.js'
import { listWorkspaces } from './workspaces.js'

const DEFAULT_TICK_MS = 30_000
const DEFAULT_POLL_MS = 5_000
const EVENTS_PER_SETTLEMENT = 120
const MAX_ERROR_CHARS = 500
const MAX_SESSION_TITLE_CHARS = 120

const STATUS_LABELS = Object.freeze({
  planned: '待规划',
  todo: '待开始',
  doing: '进行中',
  done: '已完成',
  failed: '已失败',
})

const INVALID_CRON_REASON = '定时表达式不合法，无法安排下一次执行。'
const IMPOSSIBLE_CRON_REASON = '这个定时表达式永远不会触发，请换一个。'

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function reasonOf(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message !== '') {
    return error.message.length > MAX_ERROR_CHARS ? `${error.message.slice(0, MAX_ERROR_CHARS)}…` : error.message
  }
  const text = String(error)
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text
}

function truncate(value, limit) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text.length <= limit) return text
  return `${text.slice(0, limit).trimEnd()}…（已截断）`
}

function isoOf(ms) {
  return new Date(ms).toISOString()
}

function isRecord(value) {
  return typeof value === 'object' && value !== null
}

/** Epoch ms of `schedule.nextRunAt` (ISO string or number), or undefined. */
function storedNextRunMs(schedule) {
  const value = schedule?.nextRunAt
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

/** Missing or unparsable `nextRunAt` counts as due, so it is recomputed. */
function isDue(schedule, nowMs) {
  const ms = storedNextRunMs(schedule)
  return ms === undefined || ms <= nowMs
}

/**
 * The node's conditions projected through the live graph.
 * A condition is satisfied when at least one linked predecessor is `done`.
 */
function conditionStates(graph, node) {
  const conditions = Array.isArray(node?.conditions) ? node.conditions : []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  return conditions.map((condition) => {
    const linked = []
    for (const edge of edges) {
      if (edge === null || typeof edge !== 'object') continue
      if (edge.to !== node.id || edge.conditionId !== condition.id) continue
      const from = findNode(graph, edge.from)
      if (from === undefined) continue
      linked.push({
        id: from.id,
        title: typeof from.title === 'string' ? from.title : from.id,
        status: from.status,
      })
    }
    const waiting = linked.filter((item) => item.status !== 'done')
    return {
      id: condition.id,
      title: typeof condition.title === 'string' && condition.title.trim() !== ''
        ? condition.title.trim()
        : '前置条件',
      satisfied: linked.some((item) => item.status === 'done'),
      linked,
      waiting,
    }
  })
}

/** The last `turn/end` in a chronological event list, or undefined. */
function lastTurnEnd(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/end') return event
  }
  return undefined
}

/** `turn/end` reports an error through `data.reason.kind === 'error'`. */
function isErrorTurnEnd(event) {
  const data = event?.data
  if (!isRecord(data)) return false
  const reason = data.reason
  return isRecord(reason) && reason.kind === 'error'
}

function errorTextOf(event) {
  const reason = event?.data?.reason
  if (isRecord(reason) && typeof reason.message === 'string' && reason.message.trim() !== '') {
    return reason.message.trim()
  }
  return '会话轮次以错误结束。'
}

/* ------------------------------------------------------------------ */
/* buildExecutionBrief                                                 */
/* ------------------------------------------------------------------ */

/**
 * Deterministic execution brief — no model call, same inputs => same text.
 *
 * @param {{graph?: object, node?: object, derived?: object}} input
 * @returns {string} markdown ready to send as the session's first message
 */
export function buildExecutionBrief({ graph, node, derived } = {}) {
  const target = isRecord(node) ? node : {}
  const title = typeof target.title === 'string' && target.title.trim() !== ''
    ? target.title.trim()
    : '（未命名任务）'
  const status = STATUS_LABELS[target.status] ?? '待开始'
  const graphRef = isRecord(graph) ? graph : null

  const projected = isRecord(derived)
    && isRecord(derived.conditions)
    && Array.isArray(derived.conditions[target.id])
    ? derived.conditions[target.id]
    : conditionStates(graphRef, target)

  const conditionLines = []
  if (projected.length === 0) {
    conditionLines.push('- 无（无条件，可直接开始）')
  }
  for (const condition of projected) {
    const conditionTitle = typeof condition.title === 'string' && condition.title.trim() !== ''
      ? condition.title.trim()
      : '前置条件'
    if (condition.satisfied === true) {
      conditionLines.push(`- ${conditionTitle}：已满足`)
      continue
    }
    const waiting = Array.isArray(condition.waiting) ? condition.waiting : []
    if (waiting.length === 0) {
      conditionLines.push(`- ${conditionTitle}：等待（还没有关联的前序节点）`)
    } else {
      const names = waiting
        .map((item) => (typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : item.id))
        .join('、')
      conditionLines.push(`- ${conditionTitle}：等待 ${names}`)
    }
  }

  const lines = [
    `# 定时执行：${title}`,
    '',
    '## 任务',
    `- 状态：${status}`,
    '',
    ...renderDescriptionSection(target.notes),
    '',
    '## 前置条件（全部满足才会触发）',
    ...conditionLines,
    '',
    '## 执行要求',
    '1. 直接开始执行这个任务，不要只做计划。',
    '2. 完成后调用 graph_update_node 把本节点状态改为 done；失败则改为 failed 并说明原因。',
    '3. 需要人工决定时停下来提问。',
    '4. 用户提出新的需求、约束或完成标准时，及时用 graph_update_node 把本节点任务描述更新为当前完整版本。',
    '',
  ]
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* TaskDagScheduler                                                    */
/* ------------------------------------------------------------------ */

export class TaskDagScheduler {
  /**
   * @param {object} ctx plugin context (gateway / live sessions read lazily)
   * @param {{read: Function, commit: Function}} store graph store
   * @param {{tickMs?: number, pollMs?: number, now?: () => number,
   *   isActive?: () => boolean, applyOutcome?: Function}} [options]
   *   `applyOutcome` is a test seam; the default is `ops.applyExecutionOutcome`.
   */
  constructor(ctx, store, options = {}) {
    this.ctx = ctx
    this.store = store
    this.tickMs = Number.isFinite(options.tickMs) && options.tickMs > 0 ? options.tickMs : DEFAULT_TICK_MS
    this.pollMs = Number.isFinite(options.pollMs) && options.pollMs > 0 ? options.pollMs : DEFAULT_POLL_MS
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.isActive = typeof options.isActive === 'function' ? options.isActive : () => true
    this.applyOutcome = typeof options.applyOutcome === 'function' ? options.applyOutcome : applyExecutionOutcome

    /** @type {Map<string, {workspaceId: string, workspacePath: string, nodeId: string, sessionId: string, startedAt: number}>} */
    this.pending = new Map()
    this.timers = []
    this.disposed = false
    this.started = false
    this.restored = false
    this.tickInFlight = false
    this.pollInFlight = false
    this.missingOutcomeWarned = false
  }

  /**
   * Start the timers and take ownership of executions a previous Host process
   * left in `doing`. The immediate tick only advances schedules and runs at most
   * one occurrence per node — missed occurrences are not replayed.
   *
   * @returns {() => void} disposer
   */
  start() {
    if (this.disposed) return () => {}
    // Synchronous on purpose: `pendingExecutions()` must already report
    // recovered executions right after start().
    this.#restoreExecutions()
    if (!this.started) {
      this.started = true
      this.timers.push(this.#interval(() => this.#timerTick(), this.tickMs))
      this.timers.push(this.#interval(() => this.#timerPoll(), this.pollMs))
      this.#timerTick()
      this.#timerPoll()
    }
    return () => this.dispose()
  }

  /** One scheduling scan. Safe to call directly in tests (no timers involved). */
  async tick(nowMs = this.now()) {
    if (this.disposed || !this.isActive()) return
    const now = Number.isFinite(nowMs) ? nowMs : this.now()
    this.#restoreExecutions()

    let workspaces
    try {
      workspaces = listWorkspaces(this.ctx)
    } catch (error) {
      console.error('[dsh-task-dag] 定时调度读取工作区失败', error)
      return
    }

    for (const workspace of workspaces) {
      let graph
      try {
        graph = this.store.read(workspace).graph
      } catch (error) {
        console.error(`[dsh-task-dag] 读取工作区 ${workspace.workspaceId} 的任务图失败`, error)
        continue
      }
      const candidates = (Array.isArray(graph?.nodes) ? graph.nodes : [])
        .filter((node) => node?.schedule?.enabled === true)
        .map((node) => node.id)
      for (const nodeId of candidates) {
        if (this.disposed) return
        try {
          await this.#processDueNode(workspace, nodeId, now)
        } catch (error) {
          console.error(`[dsh-task-dag] 定时执行节点 ${nodeId} 失败`, error)
        }
      }
    }
  }

  /** One settlement scan over the in-memory pending executions. */
  async pollExecutions(nowMs = this.now()) {
    if (this.disposed || !this.isActive()) return
    if (this.pending.size === 0) return
    const now = Number.isFinite(nowMs) ? nowMs : this.now()

    let workspaces
    try {
      workspaces = listWorkspaces(this.ctx)
    } catch (error) {
      console.error('[dsh-task-dag] 执行结算读取工作区失败', error)
      return
    }
    const byId = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace]))

    const groups = new Map()
    for (const entry of this.pending.values()) {
      const group = groups.get(entry.workspaceId)
      if (group === undefined) groups.set(entry.workspaceId, [entry])
      else group.push(entry)
    }

    for (const [workspaceId, entries] of groups) {
      const workspace = byId.get(workspaceId)
      if (workspace === undefined) {
        // The workspace disappeared; nothing can be committed for it.
        for (const entry of entries) this.pending.delete(this.#pendingKey(entry))
        continue
      }
      let facts
      try {
        facts = await sessionFacts(this.ctx, entries.map((entry) => entry.sessionId))
      } catch (error) {
        console.warn(`[dsh-task-dag] 执行结算读取会话状态失败：${reasonOf(error)}`)
        continue
      }
      for (const entry of entries) {
        if (this.disposed) return
        try {
          await this.#settleOne(workspace, entry, facts.byId[entry.sessionId], now)
        } catch (error) {
          console.error(`[dsh-task-dag] 执行结算失败（会话 ${entry.sessionId}）`, error)
        }
      }
    }
  }

  /** Snapshot of the executions waiting for settlement (tests / diagnostics). */
  pendingExecutions() {
    return [...this.pending.values()].map((entry) => ({ ...entry }))
  }

  /** Clear every timer and forget pending executions. Idempotent. */
  dispose() {
    this.disposed = true
    for (const timer of this.timers.splice(0)) {
      try {
        clearInterval(timer)
      } catch {
        // Already gone.
      }
    }
    this.pending.clear()
  }

  /* ---------------------------------------------------------------- */
  /* scheduling internals                                              */
  /* ---------------------------------------------------------------- */

  #interval(callback, ms) {
    const timer = setInterval(callback, ms)
    // Never keep a Host process alive just for a scheduler tick.
    if (typeof timer?.unref === 'function') timer.unref()
    return timer
  }

  #timerTick() {
    if (this.disposed || this.tickInFlight) return
    this.tickInFlight = true
    void this.tick()
      .catch((error) => console.error('[dsh-task-dag] 定时调度扫描失败', error))
      .finally(() => { this.tickInFlight = false })
  }

  #timerPoll() {
    if (this.disposed || this.pollInFlight) return
    this.pollInFlight = true
    void this.pollExecutions()
      .catch((error) => console.error('[dsh-task-dag] 执行结算扫描失败', error))
      .finally(() => { this.pollInFlight = false })
  }

  async #processDueNode(workspace, nodeId, nowMs) {
    const { graph } = this.store.read(workspace)
    const node = findNode(graph, nodeId)
    if (node === undefined || node.schedule === null || node.schedule === undefined) return
    if (node.schedule.enabled !== true) return

    const schedule = node.schedule
    const cron = typeof schedule.cron === 'string' ? schedule.cron.trim() : ''
    if (!isValidCron(cron)) {
      // Avoid one commit every tick while an unusable expression stays armed.
      if (schedule.nextRunAt === null && schedule.lastSkippedReason === INVALID_CRON_REASON) return
      await this.#commitSkip(workspace, nodeId, nowMs, undefined, INVALID_CRON_REASON)
      return
    }
    if (!isDue(schedule, nowMs)) return

    const nextMs = nextRunAtMs(cron, nowMs)
    if (nextMs === undefined) {
      if (schedule.nextRunAt === null && schedule.lastSkippedReason === IMPOSSIBLE_CRON_REASON) return
      await this.#commitSkip(workspace, nodeId, nowMs, undefined, IMPOSSIBLE_CRON_REASON)
      return
    }

    if (node.status !== 'todo') {
      await this.#commitSkip(
        workspace,
        nodeId,
        nowMs,
        nextMs,
        `节点状态为「${STATUS_LABELS[node.status] ?? node.status}」，只有「待开始」的节点会自动执行。`,
      )
      return
    }

    const conditions = conditionStates(graph, node)
    const unsatisfied = conditions.filter((condition) => condition.satisfied !== true)
    if (unsatisfied.length > 0) {
      const names = unsatisfied.map((condition) => condition.title).join('、')
      await this.#commitSkip(workspace, nodeId, nowMs, nextMs, `前置条件未满足：${names}。`)
      return
    }

    const gateway = getService(this.ctx, 'typertGateway')
    if (gateway === undefined || gateway === null || typeof gateway.invoke !== 'function') {
      await this.#commitSkip(workspace, nodeId, nowMs, nextMs, '宿主没有会话网关，无法执行定时任务。')
      return
    }

    const runningReason = await this.#runningReason(node)
    if (runningReason !== null) {
      await this.#commitSkip(workspace, nodeId, nowMs, nextMs, runningReason)
      return
    }

    await this.#launch(workspace, nodeId, nowMs, nextMs, graph, node)
  }

  /** Why a node must not be started right now, or null when it may start. */
  async #runningReason(node) {
    const active = activeSession(node)
    if (active === undefined || active === null) return null
    try {
      const facts = await sessionFacts(this.ctx, [active.sessionId])
      if (facts.byId[active.sessionId]?.running === true) {
        return `已有会话正在运行（${active.sessionId}），本次跳过。`
      }
      return null
    } catch (error) {
      return `无法确认已有会话的运行状态（${reasonOf(error)}），本次跳过。`
    }
  }

  async #commitSkip(workspace, nodeId, nowMs, nextMs, reason) {
    const now = isoOf(nowMs)
    await this.#commitWithRetry(workspace, (current) => {
      const target = findNode(current, nodeId)
      if (target === undefined || target.schedule === null || target.schedule === undefined) {
        return { next: current }
      }
      target.schedule.nextRunAt = nextMs === undefined ? null : isoOf(nextMs)
      target.schedule.lastResult = 'skipped'
      target.schedule.lastSkippedReason = truncate(reason, MAX_ERROR_CHARS)
      target.schedule.lastError = null
      target.updatedAt = now
      return {
        next: current,
        event: {
          type: 'schedule/skip',
          data: { nodeId, reason, nextRunAt: target.schedule.nextRunAt },
        },
      }
    })
  }

  /**
   * The fixed launch sequence from the contract:
   * commit doing -> create session -> commit attach -> rename -> prompt.
   * A failure at any step rolls the node back to todo and records `lastError`.
   */
  async #launch(workspace, nodeId, nowMs, nextMs, beforeGraph, beforeNode) {
    const now = isoOf(nowMs)
    const agentPreset = typeof beforeNode.agentPreset === 'string' && beforeNode.agentPreset.trim() !== ''
      ? beforeNode.agentPreset.trim()
      : null
    const model = typeof beforeNode.model === 'string' && beforeNode.model.trim() !== ''
      ? beforeNode.model.trim()
      : null
    const reasoningEffort = typeof beforeNode.reasoningEffort === 'string' && beforeNode.reasoningEffort.trim() !== ''
      ? beforeNode.reasoningEffort.trim()
      : null
    const nodeTitle = typeof beforeNode.title === 'string' && beforeNode.title.trim() !== ''
      ? beforeNode.title.trim()
      : '未命名任务'

    // 1) Claim the node and advance the schedule in one commit.
    let claimed = false
    await this.#commitWithRetry(workspace, (current) => {
      const target = findNode(current, nodeId)
      if (target === undefined
        || target.schedule === null || target.schedule === undefined
        || target.schedule.enabled !== true
        || target.status !== 'todo') {
        return { next: current }
      }
      target.status = 'doing'
      target.completedAt = null
      target.failedAt = null
      target.updatedAt = now
      target.schedule.lastTriggeredAt = now
      target.schedule.nextRunAt = isoOf(nextMs)
      target.schedule.lastResult = null
      target.schedule.lastError = null
      target.schedule.lastSkippedReason = null
      claimed = true
      return {
        next: current,
        event: {
          type: 'schedule/trigger',
          data: { nodeId, nextRunAt: target.schedule.nextRunAt, agentPreset, model, reasoningEffort },
        },
      }
    })
    if (!claimed) return

    // 2) Create the session with the node's preset/model.
    let sessionId = ''
    try {
      sessionId = await createBlankSession(this.ctx, workspace, { agentPreset, model, reasoningEffort })
    } catch (error) {
      await this.#rollbackLaunch(workspace, nodeId, '', error, nowMs)
      return
    }

    // 3) Attach it as the node's current scheduled session.
    let attached = false
    try {
      await this.#commitWithRetry(workspace, (current) => {
        const target = findNode(current, nodeId)
        if (target === undefined) return { next: current }
        const previous = activeSession(target)
        if (previous !== undefined && previous !== null) previous.retiredAt = now
        const existing = Array.isArray(target.sessions)
          ? target.sessions.find((record) => record?.sessionId === sessionId)
          : undefined
        if (existing !== undefined) {
          existing.retiredAt = null
          existing.handoff = { from: previous?.sessionId ?? null, mode: 'scheduled' }
        } else {
          target.sessions.push({
            sessionId,
            slot: nextSlot(target),
            titleSnapshot: nodeTitle,
            attachedAt: now,
            retiredAt: null,
            handoff: { from: previous?.sessionId ?? null, mode: 'scheduled' },
          })
        }
        if (target.schedule !== null && target.schedule !== undefined) {
          target.schedule.lastSessionId = sessionId
        }
        target.updatedAt = now
        attached = true
        return {
          next: current,
          event: {
            type: 'session/scheduled-attach',
            data: { nodeId, sessionId, previousSessionId: previous?.sessionId ?? null },
          },
        }
      })
    } catch (error) {
      await this.#rollbackLaunch(workspace, nodeId, sessionId, error, nowMs)
      return
    }
    if (!attached) {
      await this.#rollbackLaunch(
        workspace,
        nodeId,
        sessionId,
        new TaskDagError(CODES.notFound, '任务节点在开跑过程中被删除，已放弃本次定时执行。', { status: 404 }),
        nowMs,
      )
      return
    }

    // 4) Rename (best effort, never throws) and 5) prompt with the brief.
    const sessionTitle = nodeTitle.length > MAX_SESSION_TITLE_CHARS
      ? nodeTitle.slice(0, MAX_SESSION_TITLE_CHARS)
      : nodeTitle
    await renameSession(this.ctx, sessionId, sessionTitle)

    const brief = buildExecutionBrief({ graph: beforeGraph, node: beforeNode })
    try {
      await promptSession(this.ctx, sessionId, brief)
    } catch (error) {
      await this.#rollbackLaunch(workspace, nodeId, sessionId, error, nowMs)
      return
    }

    this.#addPending(workspace, nodeId, sessionId, nowMs)
  }

  /** Undo a partially started execution: keep the node startable, record why. */
  async #rollbackLaunch(workspace, nodeId, sessionId, error, nowMs) {
    const now = isoOf(nowMs)
    const message = truncate(reasonOf(error), MAX_ERROR_CHARS)
    try {
      await this.#commitWithRetry(workspace, (current) => {
        const target = findNode(current, nodeId)
        if (target === undefined) return { next: current }
        if (target.status === 'doing') {
          target.status = 'todo'
          target.completedAt = null
          target.failedAt = null
        }
        if (target.schedule !== null && target.schedule !== undefined) {
          target.schedule.lastResult = 'failed'
          target.schedule.lastError = message
          target.schedule.lastFinishedAt = now
          if (sessionId !== '' && target.schedule.lastSessionId === sessionId) {
            target.schedule.lastSessionId = null
          }
        }
        if (sessionId !== '') {
          const record = Array.isArray(target.sessions)
            ? target.sessions.find((item) => item?.sessionId === sessionId)
            : undefined
          if (record !== undefined && record.retiredAt === null) record.retiredAt = now
        }
        target.updatedAt = now
        return {
          next: current,
          event: {
            type: 'schedule/launch-failed',
            data: { nodeId, sessionId: sessionId === '' ? null : sessionId, error: message },
          },
        }
      })
    } catch (rollbackError) {
      console.error(`[dsh-task-dag] 定时执行失败后回滚节点 ${nodeId} 失败`, rollbackError)
    }
  }

  /* ---------------------------------------------------------------- */
  /* settlement internals                                              */
  /* ---------------------------------------------------------------- */

  async #settleOne(workspace, entry, fact, nowMs) {
    if (fact === undefined || fact.available !== true) {
      await this.#settle(workspace, entry, 'cancelled', '执行会话已不存在，已停止跟踪。', nowMs)
      return
    }
    if (fact.running === true) return

    const read = await readSessionEvents(this.ctx, entry.sessionId, EVENTS_PER_SETTLEMENT)
    if (read.source === 'unavailable' && read.events.length === 0) {
      // Transient read failure: keep tracking and try again on the next poll.
      return
    }
    const turnEnd = lastTurnEnd(read.events)
    if (turnEnd === undefined) {
      // The prompt may still be queued; wait for the final event to land.
      return
    }

    if (isErrorTurnEnd(turnEnd)) {
      await this.#settle(workspace, entry, 'failed', errorTextOf(turnEnd), nowMs)
    } else {
      await this.#settle(workspace, entry, 'succeeded', undefined, nowMs)
    }
  }

  async #settle(workspace, entry, outcome, error, nowMs) {
    const now = isoOf(nowMs)
    let applied = false
    await this.#commitWithRetry(workspace, (current) => {
      const target = findNode(current, entry.nodeId)
      if (target === undefined) {
        // Node was deleted; nothing to settle, pending is dropped below.
        applied = true
        return { next: current }
      }
      let settled
      try {
        settled = this.applyOutcome(current, {
          nodeId: entry.nodeId,
          outcome,
          sessionId: entry.sessionId,
          error,
          now,
        })
      } catch (applyError) {
        console.error(`[dsh-task-dag] 结算执行结果失败（节点 ${entry.nodeId}）`, applyError)
        return { next: current }
      }
      if (settled === null || settled === undefined) {
        applied = true
        return { next: current }
      }

      const reason = settled.result?.reason
      const isCancelled = reason === 'cancelled'
      if (settled.result?.applied !== true && !isCancelled) {
        // Someone changed the node or its current session during the run: the
        // human edit wins, so this execution is no longer tracked.
        applied = true
        return { next: current }
      }

      const nextGraph = settled.next
      const settledNode = findNode(nextGraph, entry.nodeId)
      if (settledNode !== undefined
        && settledNode.schedule !== null
        && settledNode.schedule !== undefined) {
        settledNode.schedule.lastFinishedAt = now
        settledNode.schedule.lastResult = outcome === 'succeeded'
          ? 'succeeded'
          : outcome === 'failed'
            ? 'failed'
            : null
        settledNode.schedule.lastError = typeof error === 'string' && error !== ''
          ? truncate(error, MAX_ERROR_CHARS)
          : null
        settledNode.updatedAt = now
      }
      applied = true
      return {
        next: nextGraph,
        event: settled.event ?? {
          type: 'schedule/settle',
          data: { nodeId: entry.nodeId, sessionId: entry.sessionId, outcome },
        },
      }
    })
    if (applied) this.pending.delete(this.#pendingKey(entry))
  }

  /* ---------------------------------------------------------------- */
  /* recovery / pending bookkeeping                                    */
  /* ---------------------------------------------------------------- */

  /** Re-adopt executions a previous process left in `doing`. Runs once. */
  #restoreExecutions() {
    if (this.restored || this.disposed) return
    this.restored = true
    let workspaces
    try {
      workspaces = listWorkspaces(this.ctx)
    } catch (error) {
      console.error('[dsh-task-dag] 恢复定时执行时读取工作区失败', error)
      return
    }
    for (const workspace of workspaces) {
      let graph
      try {
        graph = this.store.read(workspace).graph
      } catch (error) {
        console.error(`[dsh-task-dag] 恢复定时执行时读取 ${workspace.workspaceId} 失败`, error)
        continue
      }
      for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
        if (node?.status !== 'doing') continue
        const sessionId = node.schedule?.lastSessionId
        if (typeof sessionId !== 'string' || sessionId.trim() === '') continue
        const triggered = typeof node.schedule?.lastTriggeredAt === 'string'
          ? Date.parse(node.schedule.lastTriggeredAt)
          : NaN
        this.#addPending(workspace, node.id, sessionId, Number.isNaN(triggered) ? this.now() : triggered)
      }
    }
  }

  #pendingKey(entry) {
    return `${entry.workspaceId}\u0000${entry.sessionId}`
  }

  #addPending(workspace, nodeId, sessionId, startedAt) {
    const key = `${workspace.workspaceId}\u0000${sessionId}`
    if (this.pending.has(key)) return
    this.pending.set(key, {
      workspaceId: workspace.workspaceId,
      workspacePath: workspace.path,
      nodeId,
      sessionId,
      startedAt: Number.isFinite(startedAt) ? startedAt : this.now(),
    })
  }

  /** Read a graph, run `produce`, and retry once on a revision conflict. */
  async #commitWithRetry(workspace, produce) {
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const graph = this.store.read(workspace).graph
      try {
        return await this.store.commit(workspace, graph.revision, produce)
      } catch (error) {
        lastError = error
        if (error?.code !== CODES.revisionConflict) throw error
      }
    }
    throw lastError
  }
}
