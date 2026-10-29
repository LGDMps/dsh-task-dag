/**
 * Host adapters over the DSH session API.
 *
 * The graph never reads session files from disk: every session fact comes from
 * `ctx.typertGateway` (list / create / rename / prompt / follow) or from the
 * live `ctx.sessions` registry. This module is also where the deterministic
 * handoff brief lives, because that brief is the only thing that survives a
 * context compression.
 *
 * Gateway call shapes (verified against DSH 0.2.1-rc.3):
 *   invoke({namespace, method, args}) with args = {request: {...}},
 *   except `session/list`, which takes {_request: {}}.
 *   stream({namespace:'session', method:'follow', args:{request:{...}}}).
 *
 * Every helper turns failures into `TaskDagError`; raw errors never escape.
 */

import { randomUUID } from 'node:crypto'
import { CODES, TaskDagError } from './errors.js'
import { findNode, prereqsOf, successorsOf } from './model.js'
import { getService } from './services.js'

/** Events the brief cares about (append-surface chat messages). */
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

const DEFAULT_TAIL_MESSAGES = 12
const DEFAULT_EVENT_MESSAGES = 80
const MAX_TAIL_MESSAGES = 200

/** Brief excerpt limits, in characters (≈4 chars per token). */
const ASSISTANT_CHARS = 3200
const USER_CHARS = 800
const MAX_USER_REQUESTS = 3
const NOTES_CHARS = 2000

const STATUS_LABELS = Object.freeze({
  planned: '待规划',
  todo: '待开始',
  doing: '进行中',
  done: '已完成',
  failed: '已失败',
})

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

/** Human-readable text for an unknown thrown value. */
function reasonOf(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message !== '') {
    return error.message.length > 200 ? `${error.message.slice(0, 200)}…` : error.message
  }
  const text = String(error)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/** Throw when the host has no usable session gateway. */
function requireGateway(ctx) {
  const gateway = getService(ctx, 'typertGateway')
  if (gateway === undefined || gateway === null || typeof gateway.invoke !== 'function') {
    throw new TaskDagError(CODES.hostUnavailable, '当前环境没有会话服务，暂时无法操作会话。', { status: 503 })
  }
  return gateway
}

/**
 * One in-process Peer per calling context, reused for every gateway call.
 *
 * DSH 0.2.1-rc.3's gateway no longer supplies a default operator Peer: its
 * `prepareInvocation` runs `assertPeerLive(request.peer)`, which reads
 * `peer.signal`. An in-process caller that omits `peer` therefore dies with
 * `Cannot read properties of undefined (reading 'signal')` — an opaque error
 * that says nothing about the real cause. `connection.createPeer` is the
 * documented way to create a Peer owned by the caller's context, and an owner
 * principal is exactly what an in-process plugin acts as.
 */
const PEERS = new WeakMap()

function peerFor(ctx) {
  if (ctx === null || typeof ctx !== 'object') return undefined
  const cached = PEERS.get(ctx)
  if (cached !== undefined) return cached
  const connection = getService(ctx, 'connection')
  if (connection === undefined || connection === null || typeof connection.createPeer !== 'function') {
    return undefined
  }
  try {
    const peer = connection.createPeer({ principal: { kind: 'owner' } })
    PEERS.set(ctx, peer)
    return peer
  } catch (error) {
    console.error('[dsh-task-dag] 创建本机调用凭据失败', error)
    return undefined
  }
}

/** Build one gateway request, attaching the caller's Peer when one is available. */
function gatewayRequest(ctx, namespace, method, args) {
  const request = { namespace, method, args }
  const peer = peerFor(ctx)
  if (peer !== undefined) request.peer = peer
  return request
}

/** One gateway invoke, with every failure coerced to `host-unavailable`. */
async function invoke(ctx, namespace, method, args) {
  const gateway = requireGateway(ctx)
  try {
    return await gateway.invoke(gatewayRequest(ctx, namespace, method, args))
  } catch (error) {
    throw new TaskDagError(
      CODES.hostUnavailable,
      `会话服务调用失败（${method}）：${reasonOf(error)}`,
      { status: 503, details: { namespace, method, cause: reasonOf(error) } },
    )
  }
}

/** Validate a session id given from outside the host. */
function requireSessionId(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (id === '') {
    throw new TaskDagError(CODES.invalidRequest, '缺少会话 ID。', { details: { field: 'sessionId' } })
  }
  return id
}

/** A usable tail limit: integer between 1 and the hard cap. */
function clampLimit(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(MAX_TAIL_MESSAGES, Math.floor(parsed))
}

function clampTailLimit(value) {
  return clampLimit(value, DEFAULT_TAIL_MESSAGES)
}

/** Normalize an optional preset/model option: null or a non-empty string. */
function optionalText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** Truncate an excerpt deterministically. */
function truncateText(text, limit) {
  if (typeof text !== 'string') return ''
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit).trimEnd()}…（已截断）`
}

/* ------------------------------------------------------------------ */
/* sessionFacts                                                        */
/* ------------------------------------------------------------------ */

/** Project a `session/list` summary onto the Fact shape the snapshot uses. */
function factFromSummary(sessionId, summary) {
  return {
    sessionId,
    title: titleOf(summary),
    running: summary?.running === true,
    blank: summary?.blank === true,
    updatedAt: updatedAtOf(summary),
    cwd: cwdOf(summary),
    available: true,
    contextPressure: contextPressureOf(summary),
  }
}

/** A fact for a session the host does not know (deleted / never listed). */
function missingFact(sessionId) {
  return {
    sessionId,
    title: '',
    running: false,
    blank: false,
    updatedAt: null,
    cwd: '',
    available: false,
    contextPressure: {},
  }
}

function projectionsOf(summary) {
  const projections = summary?.projections
  if (projections === null || typeof projections !== 'object') return {}
  const values = projections.values
  return values !== null && typeof values === 'object' ? values : projections
}

function titleOf(summary) {
  const title = projectionsOf(summary).title
  return typeof title === 'string' ? title : ''
}

function updatedAtOf(summary) {
  const value = summary?.updatedAt
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

function cwdOf(summary) {
  const cwd = summary?.cwd ?? summary?.header?.cwd
  return typeof cwd === 'string' ? cwd : ''
}

/** `contextPressure` wire view plus the derived ratio used by the water level UI. */
function contextPressureOf(summary) {
  const raw = projectionsOf(summary).contextPressure
  if (raw === null || typeof raw !== 'object') return {}
  const out = {}
  const window = raw.contextWindow
  if (typeof window === 'number' && Number.isFinite(window) && window > 0) out.contextWindow = window
  for (const key of ['pressureTokens', 'projectedTokens']) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value
  }
  const used = out.projectedTokens ?? out.pressureTokens
  if (used !== undefined && out.contextWindow !== undefined) {
    out.ratio = used / out.contextWindow
  }
  return out
}

/** The host-wide archived set, read without assuming the getter exists. */
function archivedIdsOf(ctx) {
  const registry = getService(ctx, 'workspaceRegistry')
  if (registry === undefined || registry === null) return new Set()
  try {
    const value = registry.archivedSessionIds
    const ids = Array.isArray(value)
      ? value
      : Array.isArray(value?.ids)
        ? value.ids
        : typeof value === 'function'
          ? value.call(registry)
          : []
    return new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)))
  } catch {
    return new Set()
  }
}

/**
 * Batch-enrich session ids with host facts.
 *
 * @returns {Promise<{byId: Record<string, object>, archived: string[], warnings: string[]}>}
 */
export async function sessionFacts(ctx, sessionIds) {
  const source = Array.isArray(sessionIds)
    ? sessionIds
    : sessionIds !== null && typeof sessionIds === 'object' && typeof sessionIds[Symbol.iterator] === 'function'
      ? [...sessionIds]
      : []

  const ids = []
  const seen = new Set()
  for (const value of source) {
    const id = typeof value === 'string' ? value : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }

  const byId = {}
  const warnings = []
  const archivedSet = archivedIdsOf(ctx)
  const archived = ids.filter((id) => archivedSet.has(id))

  if (ids.length === 0) return { byId, archived, warnings }

  let response
  try {
    response = await invoke(ctx, 'session', 'list', { _request: {} })
  } catch (error) {
    if (error instanceof TaskDagError) throw error
    throw new TaskDagError(CODES.hostUnavailable, `读取会话列表失败：${reasonOf(error)}`, { status: 503 })
  }

  const items = Array.isArray(response)
    ? response
    : Array.isArray(response?.items)
      ? response.items
      : []

  const bySessionId = new Map()
  for (const item of items) {
    const id = typeof item?.sessionId === 'string'
      ? item.sessionId
      : typeof item?.id === 'string'
        ? item.id
        : ''
    if (id !== '') bySessionId.set(id, item)
  }

  for (const id of ids) {
    const summary = bySessionId.get(id)
    if (summary === undefined) {
      byId[id] = missingFact(id)
      warnings.push(`会话 ${id} 已不在会话列表里，可能已被删除。`)
      continue
    }
    byId[id] = factFromSummary(id, summary)
  }

  return { byId, archived, warnings }
}

/* ------------------------------------------------------------------ */
/* readTail                                                            */
/* ------------------------------------------------------------------ */

/** Normalize one session event into the shape the brief consumes. */
function normalizeEvent(event) {
  if (event === null || typeof event !== 'object') return null
  return {
    type: typeof event.type === 'string' ? event.type : '',
    seq: typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : null,
    time: event.time ?? null,
    data: event.data ?? {},
  }
}

/** Keep only chat messages, in chronological order, at most `limit` of them. */
function tailMessages(events, limit) {
  const messages = []
  for (const raw of Array.isArray(events) ? events : []) {
    const event = normalizeEvent(raw)
    if (event !== null && MESSAGE_TYPES.has(event.type)) messages.push(event)
  }
  return messages.slice(-limit)
}

/**
 * Read the last few chat messages of one session.
 *
 * Strategy: the live log first (zero RPC), then the `session/follow` opening
 * snapshot (works for cold sessions), never a raw throw.
 *
 * @returns {Promise<{events: object[], source: 'log'|'follow'|'unavailable', warnings: string[]}>}
 */
export async function readTail(ctx, sessionId, maxMessages = DEFAULT_TAIL_MESSAGES) {
  const id = typeof sessionId === 'string' ? sessionId : ''
  const limit = clampTailLimit(maxMessages)
  if (id === '') {
    return { events: [], source: 'unavailable', warnings: ['缺少会话 ID，无法读取历史消息。'] }
  }

  const warnings = []

  // 1) Live session log (synchronous, no gateway call).
  try {
    const live = getService(ctx, 'sessions')?.get?.(id)
    const log = live?.log
    if (Array.isArray(log)) {
      return { events: tailMessages(log, limit), source: 'log', warnings }
    }
  } catch (error) {
    warnings.push(`读取会话 ${id} 的内存记录失败：${reasonOf(error)}`)
  }

  // 2) Opening snapshot of `session/follow`.
  const gateway = getService(ctx, 'typertGateway')
  const stream = gateway !== null && typeof gateway === 'object' ? gateway.stream : undefined
  if (typeof stream !== 'function') {
    return {
      events: [],
      source: 'unavailable',
      warnings: [...warnings, '当前环境没有会话服务，无法读取历史消息。'],
    }
  }

  let iterator
  try {
    // Call through the gateway object: its methods rely on `this`.
    const handle = await gateway.stream(gatewayRequest(ctx, 'session', 'follow', {
      request: { address: { kind: 'session', sessionId: id }, maxMessages: limit },
    }))
    iterator = typeof handle?.[Symbol.asyncIterator] === 'function'
      ? handle[Symbol.asyncIterator]()
      : handle
    if (iterator === null || iterator === undefined || typeof iterator.next !== 'function') {
      return {
        events: [],
        source: 'unavailable',
        warnings: [...warnings, `会话 ${id} 的跟随流不可用。`],
      }
    }
    const first = await iterator.next()
    const frame = first?.value
    const records = Array.isArray(frame?.records)
      ? frame.records
      : Array.isArray(frame?.events)
        ? frame.events
        : []
    const events = tailMessages(records.map((record) => record?.event ?? record), limit)
    return { events, source: 'follow', warnings }
  } catch (error) {
    return {
      events: [],
      source: 'unavailable',
      warnings: [...warnings, `会话 ${id} 的历史消息读取失败：${reasonOf(error)}`],
    }
  } finally {
    try {
      await iterator?.return?.()
    } catch {
      // Closing the stream is best effort; the snapshot already arrived.
    }
  }
}

/* ------------------------------------------------------------------ */
/* readSessionEvents                                                   */
/* ------------------------------------------------------------------ */

/** Normalize a list of raw records/events without filtering by message type. */
function rawEventsOf(records, limit) {
  const events = []
  for (const raw of Array.isArray(records) ? records : []) {
    const event = normalizeEvent(raw?.event ?? raw)
    if (event !== null) events.push(event)
  }
  return events.slice(-limit)
}

/**
 * Read the last few *events* of one session, keeping control events too.
 *
 * `readTail` answers "what did the agent and the user say"; the scheduler needs
 * the opposite: the last `turn/end` (including `reason.kind === 'error'`), which
 * the message filter would drop. Same two-tier strategy as `readTail` (live log
 * first, `session/follow` opening snapshot second) and the same no-throw rule.
 *
 * @param {object} ctx plugin context
 * @param {string} sessionId
 * @param {number} [maxMessages=80]
 * @returns {Promise<{events: object[], source: 'log'|'follow'|'unavailable', warnings: string[]}>}
 */
export async function readSessionEvents(ctx, sessionId, maxMessages = DEFAULT_EVENT_MESSAGES) {
  const id = typeof sessionId === 'string' ? sessionId : ''
  const limit = clampLimit(maxMessages, DEFAULT_EVENT_MESSAGES)
  if (id === '') {
    return { events: [], source: 'unavailable', warnings: ['缺少会话 ID，无法读取会话事件。'] }
  }

  const warnings = []

  // 1) Live session log (synchronous, no gateway call).
  try {
    const live = getService(ctx, 'sessions')?.get?.(id)
    const log = live?.log
    if (Array.isArray(log)) {
      return { events: rawEventsOf(log, limit), source: 'log', warnings }
    }
  } catch (error) {
    warnings.push(`读取会话 ${id} 的内存记录失败：${reasonOf(error)}`)
  }

  // 2) Opening snapshot of `session/follow`.
  const gateway = getService(ctx, 'typertGateway')
  const stream = gateway !== null && typeof gateway === 'object' ? gateway.stream : undefined
  if (typeof stream !== 'function') {
    return {
      events: [],
      source: 'unavailable',
      warnings: [...warnings, '当前环境没有会话服务，无法读取会话事件。'],
    }
  }

  let iterator
  try {
    // Call through the gateway object: its methods rely on `this`.
    const handle = await gateway.stream(gatewayRequest(ctx, 'session', 'follow', {
      request: { address: { kind: 'session', sessionId: id }, maxMessages: limit },
    }))
    iterator = typeof handle?.[Symbol.asyncIterator] === 'function'
      ? handle[Symbol.asyncIterator]()
      : handle
    if (iterator === null || iterator === undefined || typeof iterator.next !== 'function') {
      return {
        events: [],
        source: 'unavailable',
        warnings: [...warnings, `会话 ${id} 的跟随流不可用。`],
      }
    }
    const first = await iterator.next()
    const frame = first?.value
    const records = Array.isArray(frame?.records)
      ? frame.records
      : Array.isArray(frame?.events)
        ? frame.events
        : []
    return { events: rawEventsOf(records, limit), source: 'follow', warnings }
  } catch (error) {
    return {
      events: [],
      source: 'unavailable',
      warnings: [...warnings, `会话 ${id} 的事件读取失败：${reasonOf(error)}`],
    }
  } finally {
    try {
      await iterator?.return?.()
    } catch {
      // Closing the stream is best effort; the snapshot already arrived.
    }
  }
}

/* ------------------------------------------------------------------ */
/* buildBrief                                                          */
/* ------------------------------------------------------------------ */

/**
 * Pull readable text out of a session event payload. The DSH wire shape has
 * changed across versions, so this accepts every common nesting:
 * `{text}`, `{content:[{type:'text',text}]}`, `{message:{content:[...]}}`,
 * `{parts:[...]}` and codec-style `[{type:'text',text}]`.
 */
export function textOfEvent(event) {
  if (event === null || typeof event !== 'object') return ''
  const data = event.data
  if (typeof data === 'string') return data
  return extractText(data, 0, new Set())
}

function extractText(value, depth, seen) {
  if (depth > 8 || value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = []
    for (const item of value) {
      const text = extractText(item, depth + 1, seen)
      if (text !== '') parts.push(text)
    }
    return parts.join('\n')
  }
  if (typeof value !== 'object') return ''
  if (seen.has(value)) return ''
  seen.add(value)

  if (typeof value.text === 'string' && value.text !== '') return value.text
  if (typeof value.content === 'string' && value.content !== '') return value.content
  for (const key of ['content', 'message', 'parts', 'blocks']) {
    const nested = value[key]
    if (nested !== undefined) {
      const text = extractText(nested, depth + 1, seen)
      if (text !== '') return text
    }
  }
  return ''
}

/**
 * Deterministic handoff brief. No model call, same inputs => same output.
 *
 * @param {{graph: object, node: object, events?: object[], derived?: object}} input
 * @returns {{text: string, tokens: {assistant: number, users: number}}}
 *   `tokens` counts the characters of the excerpts actually included, so the UI
 *   can show how small the new context is.
 */
export function buildBrief({ graph, node, events, derived } = {}) {
  const target = node !== null && typeof node === 'object' ? node : {}
  const title = typeof target.title === 'string' && target.title.trim() !== ''
    ? target.title.trim()
    : '（未命名任务）'
  const status = STATUS_LABELS[target.status] ?? '未知'
  const notes = typeof target.notes === 'string' ? target.notes.trim() : ''
  const graphRef = graph !== null && typeof graph === 'object' && Array.isArray(graph.edges)
    ? graph
    : null

  const prereqIds = graphRef !== null && typeof target.id === 'string'
    ? prereqsOf(graphRef, target.id)
    : []
  const prereqLines = prereqIds.map((edge) => {
    const prereq = findNode(graphRef, edge.from)
    const prereqTitle = typeof prereq?.title === 'string' && prereq.title.trim() !== ''
      ? prereq.title.trim()
      : edge.from
    return `- ${prereqTitle}（${prereq?.status === 'done' ? '已完成' : '未完成'}）`
  })
  if (prereqLines.length === 0) prereqLines.push('- 无')

  const successorIds = graphRef !== null && typeof target.id === 'string'
    ? successorsOf(graphRef, target.id)
    : []
  const successorLines = successorIds.map((edge) => {
    const successor = findNode(graphRef, edge.to)
    const successorTitle = typeof successor?.title === 'string' && successor.title.trim() !== ''
      ? successor.title.trim()
      : edge.to
    return `- ${successorTitle}`
  })
  if (successorLines.length === 0) successorLines.push('- 无')

  const list = Array.isArray(events) ? events.filter((event) => event !== null && typeof event === 'object') : []

  const assistantEvent = [...list]
    .reverse()
    .find((event) => event.type === 'assistant/message' && textOfEvent(event) !== '')
  const assistantText = truncateText(assistantEvent === undefined ? '' : textOfEvent(assistantEvent), ASSISTANT_CHARS)

  const userTexts = list
    .filter((event) => event.type === 'user/message')
    .map((event) => truncateText(textOfEvent(event), USER_CHARS))
    .filter((text) => text !== '')
    .slice(-MAX_USER_REQUESTS)

  const tokens = {
    assistant: assistantText.length,
    users: userTexts.reduce((sum, text) => sum + text.length, 0),
  }

  const lines = [
    `# 交接简报：${title}`,
    '',
    '## 任务',
    `- 状态：${status}`,
    `- 任务描述：${notes === '' ? '无' : truncateText(notes, NOTES_CHARS)}`,
    '',
    '## 前置',
    ...prereqLines,
    '',
    '## 完成后解锁',
    ...successorLines,
    '',
    '## 上一段会话的最后回复',
    assistantText === '' ? '（没有可用的历史回复）' : assistantText,
    '',
    '## 最近的用户请求',
    ...(userTexts.length === 0
      ? ['（没有可用的历史请求）']
      : userTexts.map((text, index) => `${index + 1}. ${text}`)),
    '',
    '## 下一步',
    '请先复述你对任务目标和当前进度的理解，再从上次中断处继续。',
    '对话中用户提出新的需求、约束或完成标准时，及时调用 graph_update_node 更新本节点的任务描述（notes），保留仍然有效的内容。',
    '',
  ]

  // `derived` is accepted so callers can reuse the graph derivation they already
  // computed; the brief itself derives only the prereq/successor titles above.
  void derived

  return { text: lines.join('\n'), tokens }
}

/* ------------------------------------------------------------------ */
/* write-side helpers                                                  */
/* ------------------------------------------------------------------ */

function sessionIdOf(response) {
  if (typeof response?.sessionId === 'string' && response.sessionId !== '') return response.sessionId
  if (typeof response?.id === 'string' && response.id !== '') return response.id
  return ''
}

/**
 * Create a blank session bound to the workspace. Returns its session id.
 *
 * `workspaceId` is the correct binding (it puts the session into the workspace
 * account and derives the cwd from the workspace record), but the Host rejects
 * it when the workspace record's path and the session cwd disagree. The `cwd`
 * form has the same effect for this plugin — the graph attributes sessions by
 * `workspace.sessionIds` first and by `cwd` second — so a rejection on the
 * strict form is retried once on the path form before giving up.
 *
 * `options.agentPreset` is sent on every attempt (a retry must not silently
 * fall back to the default preset). `options.model` / `options.reasoningEffort`
 * are applied after creation with `selectModel`; a model failure is only a
 * warning, because a session with the host default model is far more useful
 * than no session at all.
 *
 * @param {object} ctx plugin context
 * @param {{workspaceId?: string, id?: string, path?: string}} workspace
 * @param {{agentPreset?: string|null, model?: string|null, reasoningEffort?: string|null}} [options]
 * @returns {Promise<string>} the new session id
 */
export async function createBlankSession(ctx, workspace, options = {}) {
  const workspaceId = typeof workspace?.workspaceId === 'string'
    ? workspace.workspaceId
    : typeof workspace?.id === 'string'
      ? workspace.id
      : ''
  const cwd = typeof workspace?.path === 'string' ? workspace.path : ''
  if (workspaceId === '' && cwd === '') {
    throw new TaskDagError(CODES.invalidRequest, '缺少工作区信息，无法新建会话。', { details: { field: 'workspaceId' } })
  }

  const agentPreset = optionalText(options?.agentPreset)
  const model = optionalText(options?.model)
  const reasoningEffort = optionalText(options?.reasoningEffort)
  const presetFields = agentPreset === null ? {} : { agentPreset }

  const attempts = []
  if (workspaceId !== '') attempts.push({ by: 'workspaceId', request: { workspaceId, ...presetFields } })
  if (cwd !== '') attempts.push({ by: 'cwd', request: { cwd, ...presetFields } })

  let firstError
  for (const attempt of attempts) {
    try {
      const response = await invoke(ctx, 'session', 'create', { request: attempt.request })
      const sessionId = sessionIdOf(response)
      if (sessionId === '') {
        throw new TaskDagError(CODES.hostUnavailable, '会话服务没有返回新会话，请稍后重试。', { status: 503 })
      }
      if (model !== null) {
        // Never blocks the session: selectModel reports its own warning, and
        // this extra guard keeps an unforeseen throw from retrying the create.
        try {
          await selectModel(ctx, sessionId, model, reasoningEffort)
        } catch {
          // Ignored on purpose: the session exists and is usable.
        }
      }
      return sessionId
    } catch (error) {
      if (firstError === undefined) firstError = error
    }
  }

  throw firstError ?? new TaskDagError(CODES.hostUnavailable, '无法新建会话。', { status: 503 })
}

/**
 * Pin a model (and optionally one reasoning-effort level) on a session.
 * Accepts `"provider/model"` or a bare model id.
 *
 * Best effort by design: the graph still owns a usable session when the model
 * is unavailable (for example a provider that was removed after the node was
 * configured), so this returns false and logs a warning instead of throwing.
 *
 * @returns {Promise<boolean>} whether the host accepted the selection
 */
export async function selectModel(ctx, sessionId, model, reasoningEffort) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  const raw = optionalText(model)
  if (id === '' || raw === null) return false

  const slash = raw.indexOf('/')
  const provider = slash > 0 ? raw.slice(0, slash).trim() : ''
  const modelId = slash >= 0 ? raw.slice(slash + 1).trim() : raw
  const effort = optionalText(reasoningEffort)
  if (modelId === '') {
    console.warn(`[dsh-task-dag] 会话 ${id} 的模型「${raw}」缺少模型 ID，继续使用默认模型。`)
    return false
  }

  const request = { sessionId: id, model: modelId }
  if (provider !== '') request.provider = provider
  if (effort !== null) request.reasoningEffort = effort

  try {
    await invoke(ctx, 'session', 'selectModel', { request })
    return true
  } catch (error) {
    const suffix = effort === null ? '' : `（推理强度 ${effort}）`
    console.warn(`[dsh-task-dag] 会话 ${id} 选择模型「${raw}」${suffix}失败，继续使用原配置：${reasonOf(error)}`)
    return false
  }
}

/**
 * Apply a node's execution target to one existing session.
 *
 * Used when the user changes the target while a session is attached, and when
 * an existing session becomes the node's current session. A node without a
 * model keeps whatever the session already has.
 *
 * @param {object} ctx plugin context
 * @param {string} sessionId target session
 * @param {{model?: string|null, reasoningEffort?: string|null}} target node target
 * @returns {Promise<{applied: boolean, warning: string|null}>}
 */
export async function applySessionTarget(ctx, sessionId, target) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  const model = optionalText(target?.model)
  const effort = optionalText(target?.reasoningEffort)
  if (id === '' || model === null) return { applied: false, warning: null }

  const applied = await selectModel(ctx, id, model, effort)
  if (applied) return { applied: true, warning: null }
  const suffix = effort === null ? '' : `，推理强度 ${effort}`
  return {
    applied: false,
    warning: `节点配置（模型 ${model}${suffix}）没有应用到会话 ${id}；该会话继续使用它原来的模型。`,
  }
}

/** Normalize the `agentPresets/list` response into `[{id, label?, broken?}]`. */
function normalizePresetList(response) {
  const list = Array.isArray(response)
    ? response
    : Array.isArray(response?.presets)
      ? response.presets
      : Array.isArray(response?.items)
        ? response.items
        : []
  const out = []
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (id === '') continue
    const entry = { id }
    const label = optionalText(raw.label ?? raw.name ?? raw.title)
    if (label !== null) entry.label = label
    if (typeof raw.broken === 'string' && raw.broken.trim() !== '') {
      entry.broken = raw.broken.trim()
    } else if (raw.broken === true) {
      entry.broken = '不可用'
    }
    out.push(entry)
  }
  return out
}

/**
 * Read the host's Agent preset catalog.
 *
 * `agentPresets/list` takes the bare `{}` args shape (not `{request:{}}`), as
 * verified against the task board's host runner. A missing or failing service
 * is an empty catalog, never a thrown error: the UI then offers just "默认".
 *
 * @returns {Promise<Array<{id: string, label?: string, broken?: string}>>}
 */
export async function listAgentPresets(ctx) {
  if (getService(ctx, 'typertGateway') === undefined) return []
  try {
    const response = await invoke(ctx, 'agentPresets', 'list', {})
    return normalizePresetList(response)
  } catch (error) {
    console.warn(`[dsh-task-dag] 读取 Agent 预设目录失败：${reasonOf(error)}`)
    return []
  }
}

/** Project one model's reasoning metadata into the browser catalog shape. */
function normalizeReasoning(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const efforts = []
  for (const effort of Array.isArray(raw.efforts) ? raw.efforts : []) {
    const id = optionalText(effort?.id)
    if (id === null) continue
    const entry = { id, name: optionalText(effort?.name) ?? id }
    const description = optionalText(effort?.description)
    if (description !== null) entry.description = description
    efforts.push(entry)
  }
  const defaultEffort = optionalText(raw.defaultEffort)
  if (efforts.length === 0 && defaultEffort === null) return null
  const out = { efforts }
  if (defaultEffort !== null) out.defaultEffort = defaultEffort
  return out
}

/** Project one catalog item (`{id,name,provider}` or a bare string) to the catalog shape. */
function catalogEntry(provider, raw, providerLabel = '') {
  let id = ''
  let label = ''
  let itemProvider = typeof provider === 'string' ? provider.trim() : ''
  let reasoning = null
  if (typeof raw === 'string') {
    id = raw.trim()
    label = id
  } else if (raw !== null && typeof raw === 'object') {
    id = optionalText(raw.id ?? raw.model ?? raw.value) ?? ''
    label = optionalText(raw.label ?? raw.name ?? raw.title) ?? id
    if (itemProvider === '') {
      const rawProvider = optionalText(raw.provider)
      itemProvider = rawProvider ?? ''
    }
    reasoning = normalizeReasoning(raw.reasoning)
  }
  if (id === '') return null
  const entry = { provider: itemProvider, id, label: label === '' ? id : label }
  const groupLabel = optionalText(providerLabel)
  if (groupLabel !== null && groupLabel !== itemProvider) entry.providerLabel = groupLabel
  if (reasoning !== null) entry.reasoning = reasoning
  return entry
}

/**
 * Read the live LLM registry directly when the Host exposes it.
 *
 * This is the same source the GUI's own model combobox uses, so the plugin sees
 * the real providers, model names and reasoning-effort levels even when the
 * session gateway's `session/modelCatalog` is missing or broken. Returns `null`
 * when the service is unavailable so the gateway path can still be tried.
 *
 * @returns {Promise<Array<object>|null>}
 */
async function readRegistryModelCatalog(ctx) {
  const llm = getService(ctx, 'llm')
  if (llm === null || llm === undefined || typeof llm !== 'object') return null
  if (typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return null

  let providers = []
  try {
    providers = await Promise.resolve(llm.listProviders())
  } catch (error) {
    console.warn(`[dsh-task-dag] 读取模型提供方失败：${reasonOf(error)}`)
    return null
  }

  const out = []
  for (const provider of Array.isArray(providers) ? providers : []) {
    const providerId = optionalText(provider?.id ?? provider?.name ?? provider)
    if (providerId === null) continue
    let listed = []
    try {
      listed = await Promise.resolve(llm.listModels(providerId))
    } catch (error) {
      console.warn(`[dsh-task-dag] 读取提供方「${providerId}」的模型失败：${reasonOf(error)}`)
      continue
    }
    for (const model of Array.isArray(listed) ? listed : []) {
      const id = optionalText(typeof model === 'string' ? model : model?.id)
      if (id === null) continue
      const label = typeof model === 'object' && model !== null
        ? optionalText(model.name ?? model.label) ?? id
        : id
      const entry = { provider: providerId, id, label }
      const providerLabel = optionalText(provider?.name) ?? providerId
      if (providerLabel !== null && providerLabel !== providerId) entry.providerLabel = providerLabel
      if (typeof llm.resolveModelInfo === 'function') {
        try {
          const info = await Promise.resolve(llm.resolveModelInfo(providerId, id))
          const reasoning = normalizeReasoning(info?.reasoning)
          if (reasoning !== null) entry.reasoning = reasoning
        } catch (error) {
          // Reasoning metadata is optional: the model still lists without it.
          console.warn(`[dsh-task-dag] 读取模型「${providerId}/${id}」的推理强度失败：${reasonOf(error)}`)
        }
      }
      out.push(entry)
    }
  }
  return out
}

/**
 * Read the host's model catalog.
 *
 * Prefers the live LLM registry (real provider/model names plus reasoning
 * levels), then falls back to `session/modelCatalog`. Its wire shape changed
 * across DSH versions, so `{groups:[{provider,models:[...]}]}`, `{items:[...]}`
 * and `{models:[...]}` are all accepted (plus a `providers` spelling of
 * groups). Any failure is an empty catalog: the UI then shows only "默认" and
 * can note that the catalog is unavailable.
 *
 * @returns {Promise<Array<{provider: string, id: string, label: string, reasoning?: object}>>}
 */
export async function listModelCatalog(ctx) {
  const direct = await readRegistryModelCatalog(ctx)
  if (direct !== null && direct.length > 0) return direct
  if (getService(ctx, 'typertGateway') === undefined) return []

  let response
  try {
    response = await invoke(ctx, 'session', 'modelCatalog', { request: {} })
  } catch (error) {
    console.warn(`[dsh-task-dag] 读取模型目录失败：${reasonOf(error)}`)
    return []
  }

  const out = []
  const seen = new Set()
  const push = (entry) => {
    if (entry === null) return
    const key = `${entry.provider}\u0000${entry.id}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(entry)
  }

  const groups = Array.isArray(response?.groups)
    ? response.groups
    : Array.isArray(response?.providers)
      ? response.providers
      : []
  for (const group of groups) {
    if (group === null || typeof group !== 'object') continue
    const provider = optionalText(group.provider ?? group.id ?? group.name) ?? ''
    const providerLabel = optionalText(group.name ?? group.label) ?? provider
    for (const raw of Array.isArray(group.models) ? group.models : []) {
      push(catalogEntry(provider, raw, providerLabel))
    }
  }

  // Flat spellings are only consulted when no grouped shape produced entries.
  if (out.length === 0) {
    const flat = Array.isArray(response)
      ? response
      : Array.isArray(response?.items)
        ? response.items
        : Array.isArray(response?.models)
          ? response.models
          : []
    for (const raw of flat) {
      if (raw !== null && typeof raw === 'object' && Array.isArray(raw.models)) {
        const provider = optionalText(raw.provider ?? raw.id ?? raw.name) ?? ''
        for (const model of raw.models) push(catalogEntry(provider, model))
      } else {
        push(catalogEntry('', raw))
      }
    }
  }

  return out
}

/** Rename a session. Best effort: never throws, returns whether it worked. */
export async function renameSession(ctx, sessionId, title) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  const text = typeof title === 'string' ? title.trim() : ''
  if (id === '' || text === '') return false
  try {
    await invoke(ctx, 'session', 'rename', { request: { sessionId: id, title: text } })
    return true
  } catch {
    return false
  }
}

/** Send one user message into a session (queue = next turn; starts an idle agent). */
export async function promptSession(ctx, sessionId, text) {
  const id = requireSessionId(sessionId)
  const body = typeof text === 'string' ? text : ''
  if (body.trim() === '') {
    throw new TaskDagError(CODES.invalidRequest, '简报内容为空，无法发送。', { details: { field: 'text' } })
  }
  const requestId = `task-dag-${randomUUID()}`
  return invoke(ctx, 'session', 'prompt', {
    request: {
      sessionId: id,
      requestId,
      mode: 'queue',
      content: [{ type: 'text', text: body }],
    },
  })
}

/** Archive one session (stopActivity by default). Throws TaskDagError on failure. */
export async function archiveSession(ctx, sessionId, stopActivity = true) {
  const id = requireSessionId(sessionId)
  const options = { stopActivity: stopActivity !== false }

  const registry = getService(ctx, 'workspaceRegistry')
  if (registry !== undefined && registry !== null && typeof registry.archiveSession === 'function') {
    try {
      await registry.archiveSession(id, options)
      return true
    } catch (error) {
      throw new TaskDagError(CODES.hostUnavailable, `归档会话失败：${reasonOf(error)}`, {
        status: 503,
        details: { sessionId: id, cause: reasonOf(error) },
      })
    }
  }

  await invoke(ctx, 'workspace', 'archiveSession', {
    request: { sessionId: id, stopActivity: options.stopActivity },
  })
  return true
}

/** Undo an archive. Throws TaskDagError on failure. */
export async function unarchiveSession(ctx, sessionId) {
  const id = requireSessionId(sessionId)

  const registry = getService(ctx, 'workspaceRegistry')
  if (registry !== undefined && registry !== null && typeof registry.unarchiveSession === 'function') {
    try {
      await registry.unarchiveSession(id)
      return true
    } catch (error) {
      throw new TaskDagError(CODES.hostUnavailable, `恢复会话失败：${reasonOf(error)}`, {
        status: 503,
        details: { sessionId: id, cause: reasonOf(error) },
      })
    }
  }

  await invoke(ctx, 'workspace', 'unarchiveSession', { request: { sessionId: id } })
  return true
}
