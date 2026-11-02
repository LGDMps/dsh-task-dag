/**
 * Pure task-graph algebra: document shape, repair rules and every derived fact.
 *
 * v2 (this file) replaces the M1 "status + direct edges" model with:
 *
 *   - five node statuses: planned / todo / doing / done / failed;
 *   - *conditions* as the unit of dependency: a node owns a list of
 *     preconditions, and an edge records that one node satisfies one of those
 *     conditions;
 *   - a failed node may never be the source of an edge;
 *   - one project milestone (`milestoneNodeId`): a plain node marker with no
 *     special edge rules and no project-completion semantics;
 *   - node *groups*: an optional visual grouping of nodes (at least two at
 *     creation time); a node belongs to at most one group, and a group carries
 *     no ordering semantics;
 *   - per-node execution target (`agentPreset` / `model`) and schedule.
 *
 * Everything stored is the graph itself. "Can this task start?" is derived on
 * every read from conditions + statuses; a stored readiness flag would drift as
 * soon as one write path forgot to maintain it.
 *
 * This module imports only the shared error type so it stays usable anywhere,
 * including the browser test fixtures and the scheduler's pure helpers.
 */
import { CODES, TaskDagError } from './errors.js'

/** Node lifecycle, one per task-board column. */
export const STATUSES = Object.freeze(['planned', 'todo', 'doing', 'done', 'failed'])

/** Human labels used by the host tools, prompt section and tests. */
export const STATUS_LABELS = Object.freeze({
  planned: '待规划',
  todo: '待开始',
  doing: '进行中',
  done: '已完成',
  failed: '已失败',
})

/** Current persisted schema. v1 documents are migrated on load. */
export const SCHEMA_VERSION = 2

const LEGACY_SCHEMA_VERSION = 1
const HANDOFF_MODES = ['manual', 'brief', 'blank', 'attach', 'scheduled']
const SCHEDULE_RESULTS = ['succeeded', 'failed', 'skipped']
const UNTITLED = '未命名任务'
const UNTITLED_CONDITION = '前置条件'
const UNTITLED_GROUP = '未命名组合'
const MAX_CONDITION_TITLE = 200
const MAX_GROUP_NAME = 60
const MAX_TARGET_ID = 200

/** Random, greppable ids: `<stem>_<8 lowercase hex>` (e.g. `n_1a2b3c4d`). */
export function newId(prefix = 'n') {
  const stem = String(prefix).replace(/_+$/, '') || 'n'
  const hex = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  return `${stem}_${hex}`
}

/** The one timestamp format this document accepts. */
export function nowIso() {
  return new Date().toISOString()
}

/** A fully normalized, empty document. Revision 0 until the first commit. */
export function emptyGraph({ workspaceId = '', workspacePath = '', title = '' } = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    workspaceId: String(workspaceId ?? ''),
    workspacePath: String(workspacePath ?? ''),
    title: String(title ?? ''),
    revision: 0,
    updatedAt: null,
    milestoneNodeId: null,
    nodes: [],
    edges: [],
    groups: [],
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

function nonEmptyText(value) {
  const text = textOf(value).trim()
  return text === '' ? '' : text
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && value !== '' && !Number.isNaN(Date.parse(value))
}

function isoOr(value, fallback) {
  return isIsoTimestamp(value) ? value : fallback
}

function isoOrNull(value) {
  return isIsoTimestamp(value) ? value : null
}

function normalizeRevision(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0
}

function normalizePosition(raw) {
  if (!isRecord(raw)) return null
  const x = Number(raw.x)
  const y = Number(raw.y)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

function normalizeHandoff(raw) {
  const from = nonEmptyText(raw?.from) || null
  const mode = HANDOFF_MODES.includes(raw?.mode) ? raw.mode : 'manual'
  return { from, mode }
}

function normalizeOptionalId(value, limit = MAX_TARGET_ID) {
  const text = nonEmptyText(value)
  return text === '' ? null : text.slice(0, limit)
}

function uniqueId(seen, prefix) {
  let id = newId(prefix)
  while (seen.has(id)) id = newId(prefix)
  return id
}

/* ------------------------------------------------------------------ */
/* conditions                                                          */
/* ------------------------------------------------------------------ */

function conditionTitle(value) {
  const text = nonEmptyText(value)
  return text === '' ? UNTITLED_CONDITION : text.slice(0, MAX_CONDITION_TITLE)
}

/** Repair one node's condition list: ids unique, titles non-empty. */
function normalizeConditions(rawConditions) {
  const list = Array.isArray(rawConditions) ? rawConditions : []
  const conditions = []
  const seen = new Set()
  for (const raw of list) {
    if (!isRecord(raw)) continue
    let id = nonEmptyText(raw.id)
    if (id === '' || seen.has(id)) id = uniqueId(seen, 'c_')
    seen.add(id)
    conditions.push({
      id,
      title: conditionTitle(raw.title),
      createdAt: isoOr(raw.createdAt, nowIso()),
    })
  }
  return conditions
}

/** Append a condition with a unique id (used by edges that lack one). */
function appendCondition(node, title, wantedId) {
  const seen = new Set(node.conditions.map((condition) => condition.id))
  let id = nonEmptyText(wantedId)
  if (id === '' || seen.has(id)) id = uniqueId(seen, 'c_')
  const condition = {
    id,
    title: conditionTitle(title),
    createdAt: nowIso(),
  }
  node.conditions.push(condition)
  return condition
}

/* ------------------------------------------------------------------ */
/* schedule                                                            */
/* ------------------------------------------------------------------ */

function normalizeSchedule(raw) {
  if (!isRecord(raw)) return null
  const cron = nonEmptyText(raw.cron)
  const lastResult = SCHEDULE_RESULTS.includes(raw.lastResult) ? raw.lastResult : null
  return {
    // An enabled schedule without a cron expression is meaningless; keep the
    // record but disarm it so the repair cannot create an always-due node.
    enabled: raw.enabled === true && cron !== '',
    cron,
    nextRunAt: isoOrNull(raw.nextRunAt),
    lastTriggeredAt: isoOrNull(raw.lastTriggeredAt),
    lastFinishedAt: isoOrNull(raw.lastFinishedAt),
    lastResult,
    lastError: nonEmptyText(raw.lastError) || null,
    lastSkippedReason: nonEmptyText(raw.lastSkippedReason) || null,
    lastSessionId: nonEmptyText(raw.lastSessionId) || null,
  }
}

/* ------------------------------------------------------------------ */
/* sessions                                                            */
/* ------------------------------------------------------------------ */

/**
 * Repair one node's session chain. Exported only through normalizeGraph: every
 * rule here exists because a hand-edited or older graph.json must not be able
 * to wedge the plugin.
 */
function normalizeSessions(rawSessions, nodeTitle, seenSessionIds) {
  const list = Array.isArray(rawSessions) ? rawSessions : []
  const sessions = []
  let previousSlot = 0
  for (const raw of list) {
    if (!isRecord(raw)) continue
    const sessionId = nonEmptyText(raw.sessionId)
    // A session belongs to exactly one node; the first record wins.
    if (sessionId === '' || seenSessionIds.has(sessionId)) continue
    seenSessionIds.add(sessionId)
    // `slot` is the chain position. Renumber forward instead of dropping the
    // record: a handoff history is data, its numbering is cosmetic.
    const candidate = Number.isInteger(raw.slot) && raw.slot > 0 ? raw.slot : previousSlot + 1
    const slot = candidate > previousSlot ? candidate : previousSlot + 1
    previousSlot = slot
    const attachedAt = isoOr(raw.attachedAt, nowIso())
    const retiredAt = raw.retiredAt === null || raw.retiredAt === undefined
      ? null
      : isoOr(raw.retiredAt, attachedAt)
    sessions.push({
      sessionId,
      slot,
      titleSnapshot: nonEmptyText(raw.titleSnapshot) || nodeTitle,
      attachedAt,
      retiredAt,
      handoff: normalizeHandoff(raw.handoff),
    })
  }
  // Invariant 1: at most one current session. The newest record wins; earlier
  // actives are marked retired rather than erased.
  let activeKept = false
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index]
    if (session.retiredAt !== null) continue
    if (!activeKept) {
      activeKept = true
      continue
    }
    session.retiredAt = nowIso()
  }
  return sessions
}

/* ------------------------------------------------------------------ */
/* nodes + edges                                                       */
/* ------------------------------------------------------------------ */

function normalizeNode(raw, id, seenSessionIds, migrating) {
  const status = STATUSES.includes(raw.status) ? raw.status : 'todo'
  const createdAt = isoOr(raw.createdAt, nowIso())
  const updatedAt = isoOr(raw.updatedAt, createdAt)
  const title = nonEmptyText(raw.title) || UNTITLED
  const conditions = migrating ? [] : normalizeConditions(raw.conditions)
  return {
    id,
    title,
    status,
    notes: textOf(raw.notes),
    conditions,
    sessions: normalizeSessions(raw.sessions, title, seenSessionIds),
    position: normalizePosition(raw.position),
    agentPreset: normalizeOptionalId(raw.agentPreset),
    model: normalizeOptionalId(raw.model),
    reasoningEffort: normalizeOptionalId(raw.reasoningEffort),
    schedule: migrating ? null : normalizeSchedule(raw.schedule),
    createdAt,
    updatedAt,
    // Invariant 4: completedAt / failedAt are the single carriers of the
    // terminal statuses, and they never coexist.
    completedAt: status === 'done' ? isoOr(raw.completedAt, updatedAt) : null,
    failedAt: status === 'failed' ? isoOr(raw.failedAt, updatedAt) : null,
  }
}

/**
 * v1 edges were a bare `from -> to` relation. v2 needs a condition to satisfy,
 * so the migration mints one condition per legacy edge. That keeps the old
 * AND semantics: every legacy predecessor must still be done before the
 * successor can start.
 */
function migrateLegacyEdges(rawEdges, byId, idSeen) {
  const list = Array.isArray(rawEdges) ? rawEdges : []
  const edges = []
  const triples = new Set()
  for (const raw of list) {
    if (!isRecord(raw)) continue
    const from = nonEmptyText(raw.from)
    const to = nonEmptyText(raw.to)
    if (!byId.has(from) || !byId.has(to) || from === to) continue
    if (byId.get(from).status === 'failed') continue
    const condition = appendCondition(byId.get(to), `${byId.get(from).title} 完成`)
    const triple = `${from}\u0000${to}\u0000${condition.id}`
    if (triples.has(triple)) continue
    triples.add(triple)
    let id = nonEmptyText(raw.id)
    if (id === '' || idSeen.has(id)) id = uniqueId(idSeen, 'e_')
    idSeen.add(id)
    edges.push({ id, from, to, conditionId: condition.id })
  }
  return edges
}

function normalizeEdges(rawEdges, byId, idSeen) {
  const list = Array.isArray(rawEdges) ? rawEdges : []
  const edges = []
  const triples = new Set()
  for (const raw of list) {
    if (!isRecord(raw)) continue
    const from = nonEmptyText(raw.from)
    const to = nonEmptyText(raw.to)
    // Dangling, self and duplicate edges are all meaningless for a DAG.
    if (!byId.has(from) || !byId.has(to) || from === to) continue
    // Invariant 3: a failed node may never satisfy a condition.
    if (byId.get(from).status === 'failed') continue
    const target = byId.get(to)
    let conditionId = nonEmptyText(raw.conditionId)
    let condition = conditionId === ''
      ? undefined
      : target.conditions.find((item) => item.id === conditionId)
    if (condition === undefined) {
      // A condition reference that cannot be resolved keeps the dependency by
      // minting the missing condition on the target instead of dropping data.
      condition = appendCondition(target, `${byId.get(from).title} 完成`, conditionId)
    }
    const triple = `${from}\u0000${to}\u0000${condition.id}`
    if (triples.has(triple)) continue
    triples.add(triple)
    let id = nonEmptyText(raw.id)
    if (id === '' || idSeen.has(id)) id = uniqueId(idSeen, 'e_')
    idSeen.add(id)
    edges.push({ id, from, to, conditionId: condition.id })
  }
  return edges
}

/* ------------------------------------------------------------------ */
/* groups                                                              */
/* ------------------------------------------------------------------ */

/**
 * Repair the group list of a parsed document.
 *
 * Groups are pure presentation data, so nothing here throws: unknown members
 * are dropped, a repeated member is dropped, ids are de-duplicated and a group
 * that loses every member disappears. When the same node is claimed by two
 * groups, the first group in document order keeps it. A group that still has a
 * member after the repair is kept even with a single member: deleting a node
 * can legitimately shrink a group, and the UI must be able to draw it.
 */
function normalizeGroups(rawGroups, byId) {
  const list = Array.isArray(rawGroups) ? rawGroups : []
  const groups = []
  const seenGroupIds = new Set()
  const claimedNodeIds = new Set()
  for (const raw of list) {
    if (!isRecord(raw)) continue
    const rawName = nonEmptyText(raw.name)
    const name = (rawName === '' ? UNTITLED_GROUP : rawName).slice(0, MAX_GROUP_NAME)
    let id = nonEmptyText(raw.id)
    if (id === '' || seenGroupIds.has(id)) id = uniqueId(seenGroupIds, 'g')
    seenGroupIds.add(id)

    const nodeIds = []
    for (const rawNodeId of Array.isArray(raw.nodeIds) ? raw.nodeIds : []) {
      const nodeId = nonEmptyText(rawNodeId)
      if (nodeId === '' || !byId.has(nodeId) || claimedNodeIds.has(nodeId)) continue
      claimedNodeIds.add(nodeId)
      nodeIds.push(nodeId)
    }
    // A group without members has nothing to outline; drop it instead of
    // persisting a record that can never become visible again.
    if (nodeIds.length === 0) continue

    const createdAt = isoOr(raw.createdAt, nowIso())
    groups.push({
      id,
      name,
      nodeIds,
      createdAt,
      updatedAt: isoOr(raw.updatedAt, createdAt),
    })
  }
  return groups
}

function looksLikeV2(raw) {
  if (raw.milestoneNodeId !== undefined) return true
  if (Array.isArray(raw.nodes)
    && raw.nodes.some((node) => isRecord(node) && Array.isArray(node.conditions))) {
    return true
  }
  return Array.isArray(raw.edges)
    && raw.edges.some((edge) => isRecord(edge) && nonEmptyText(edge.conditionId) !== '')
}

/**
 * Coerce a parsed document into the current schema, repairing everything that
 * can be repaired without guessing. Callers treat the result as canonical.
 */
export function normalizeGraph(raw) {
  if (!isRecord(raw)) {
    throw new TaskDagError(CODES.invalidGraph, '任务图文档必须是 JSON 对象。', {
      details: { received: raw === null ? 'null' : typeof raw },
    })
  }

  const declared = raw.schemaVersion
  if (declared !== undefined && declared !== null && declared !== LEGACY_SCHEMA_VERSION && declared !== SCHEMA_VERSION) {
    throw new TaskDagError(
      CODES.unsupportedVersion,
      `任务图文档版本 ${JSON.stringify(declared)} 不受支持（本插件支持 ${LEGACY_SCHEMA_VERSION} 与 ${SCHEMA_VERSION}）。`,
      { details: { schemaVersion: declared, supportedVersions: [LEGACY_SCHEMA_VERSION, SCHEMA_VERSION] } },
    )
  }
  const migrating = declared === LEGACY_SCHEMA_VERSION
    || (declared === undefined && !looksLikeV2(raw))

  const graph = emptyGraph({
    workspaceId: textOf(raw.workspaceId),
    workspacePath: textOf(raw.workspacePath),
    title: textOf(raw.title),
  })
  graph.revision = normalizeRevision(raw.revision)
  graph.updatedAt = isoOr(raw.updatedAt, null)

  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : []
  const seenNodeIds = new Set()
  const seenSessionIds = new Set()
  const byId = new Map()
  for (const rawNode of rawNodes) {
    if (!isRecord(rawNode)) continue
    const id = nonEmptyText(rawNode.id)
    // A node without an id cannot be referenced; a duplicate id keeps the first
    // record so edges stay meaningful.
    if (id === '' || seenNodeIds.has(id)) continue
    seenNodeIds.add(id)
    const node = normalizeNode(rawNode, id, seenSessionIds, migrating)
    graph.nodes.push(node)
    byId.set(id, node)
  }

  const edgeIds = new Set()
  graph.edges = migrating
    ? migrateLegacyEdges(raw.edges, byId, edgeIds)
    : normalizeEdges(raw.edges, byId, edgeIds)

  const milestoneId = nonEmptyText(raw.milestoneNodeId ?? raw.closeoutNodeId)
  graph.milestoneNodeId = seenNodeIds.has(milestoneId) ? milestoneId : null
  graph.groups = normalizeGroups(raw.groups, byId)
  return graph
}

/** One node, or undefined. */
export function findNode(graph, nodeId) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  return nodes.find((node) => node.id === nodeId)
}

/** The node's declared preconditions (empty array when none). */
export function conditionsOf(graph, nodeId) {
  const node = findNode(graph, nodeId)
  return Array.isArray(node?.conditions) ? node.conditions : []
}

/** One condition of one node, or undefined. */
export function conditionOf(graph, nodeId, conditionId) {
  if (typeof conditionId !== 'string' || conditionId === '') return undefined
  return conditionsOf(graph, nodeId).find((condition) => condition.id === conditionId)
}

/** Edges satisfying a condition of a node, in document order. */
export function satisfiersOf(graph, nodeId, conditionId) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  return edges
    .filter((edge) => edge.to === nodeId && edge.conditionId === conditionId)
    .map((edge) => ({ edgeId: edge.id, from: edge.from }))
}

/** Edges pointing at a node, in document order. */
export function prereqsOf(graph, nodeId) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  return edges
    .filter((edge) => edge.to === nodeId)
    .map((edge) => ({ id: edge.id, from: edge.from, conditionId: edge.conditionId }))
}

/** Edges leaving a node, in document order. */
export function successorsOf(graph, nodeId) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  return edges
    .filter((edge) => edge.from === nodeId)
    .map((edge) => ({ id: edge.id, to: edge.to, conditionId: edge.conditionId }))
}

/** The session currently representing this node (at most one by invariant). */
export function activeSession(node) {
  const sessions = Array.isArray(node?.sessions) ? node.sessions : []
  return sessions.find((session) => session.retiredAt === null)
}

/** Which node currently owns a session, or null. */
export function sessionOwner(graph, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const owner = nodes.find((node) => (node.sessions ?? []).some((session) => session.sessionId === sessionId))
  return owner === undefined ? null : owner.id
}

/** Next chain slot: max(slot) + 1, or 1 for a fresh node. Slots are never reused. */
export function nextSlot(node) {
  const sessions = Array.isArray(node?.sessions) ? node.sessions : []
  let max = 0
  for (const session of sessions) {
    if (Number.isInteger(session.slot) && session.slot > max) max = session.slot
  }
  return max + 1
}

/* ------------------------------------------------------------------ */
/* derivation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Topology shared by derive() and assertInvariants(): Kahn's algorithm over
 * node pairs (several edges may exist between the same pair, one per
 * condition, but the ordering graph itself is node-level).
 */
function topology(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const incoming = new Map(nodes.map((node) => [node.id, []]))
  const outgoing = new Map(nodes.map((node) => [node.id, []]))
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  const pairs = new Set()

  for (const edge of edges) {
    if (typeof edge?.from !== 'string' || typeof edge?.to !== 'string') continue
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue
    const pair = `${edge.from}\u0000${edge.to}`
    if (pairs.has(pair)) continue
    pairs.add(pair)
    incoming.get(edge.to).push(edge.from)
    outgoing.get(edge.from).push(edge.to)
    indegree.set(edge.to, indegree.get(edge.to) + 1)
  }

  const levels = {}
  const order = []
  const pending = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  while (pending.length > 0) {
    const id = pending.shift()
    order.push(id)
    let level = 0
    for (const from of incoming.get(id)) level = Math.max(level, levels[from] + 1)
    levels[id] = level
    for (const to of outgoing.get(id)) {
      const left = indegree.get(to) - 1
      indegree.set(to, left)
      if (left === 0) pending.push(to)
    }
  }

  if (order.length !== nodes.length) {
    const placed = new Set(order)
    const remaining = nodes.filter((node) => !placed.has(node.id)).map((node) => node.id)
    throw new TaskDagError(CODES.cycle, '任务图中存在环，请先断开形成环的连线。', {
      details: { remaining },
    })
  }
  return { nodes, byId, incoming, order, levels }
}

/** Conditions of one node with their live satisfaction state. */
function deriveConditions(graph, node, byId) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  const conditions = Array.isArray(node.conditions) ? node.conditions : []
  return conditions.map((condition) => {
    // A node is reported once even when a malformed document has several edges
    // from it to the same condition; the UI reasons about satisfiers, not edges.
    const sources = new Map()
    for (const edge of edges) {
      if (edge.to !== node.id || edge.conditionId !== condition.id) continue
      const source = byId.get(edge.from)
      if (source === undefined) continue
      sources.set(source.id, { id: source.id, title: source.title, status: source.status })
    }
    const linked = [...sources.values()]
    const waiting = linked.filter((source) => source.status !== 'done')
    return {
      id: condition.id,
      title: condition.title,
      // ANY semantics: one completed satisfier fulfils the condition. A
      // condition nobody satisfies stays unmet on purpose.
      satisfied: linked.some((source) => source.status === 'done'),
      linked,
      waiting,
    }
  })
}

/**
 * Everything the UI and the tools need, derived from statuses + conditions.
 * `levels` is the 0-based topological depth; it throws `cycle` on a cyclic graph.
 */
export function derive(graph) {
  const { nodes, byId, order, levels } = topology(graph)
  const ready = []
  const blocked = []
  const doing = []
  const done = []
  const failed = []
  const planned = []
  const conditions = {}

  for (const id of order) {
    const node = byId.get(id)
    const derivedConditions = deriveConditions(graph, node, byId)
    conditions[id] = derivedConditions

    if (node.status === 'done') {
      done.push(id)
      continue
    }
    if (node.status === 'failed') {
      failed.push(id)
      continue
    }
    if (node.status === 'doing') {
      doing.push(id)
      continue
    }
    if (node.status === 'planned') {
      planned.push(id)
      continue
    }
    // Anything left is treated as todo: unknown statuses are an invariant
    // violation, and this keeps the UI usable until a commit fixes it.
    const waiting = derivedConditions.some((condition) => !condition.satisfied)
    if (waiting) blocked.push(id)
    else ready.push(id)
  }

  return {
    ready,
    blocked,
    doing,
    done,
    failed,
    planned,
    levels,
    order,
    conditions,
    progress: {
      done: done.length,
      total: nodes.length,
      ready: ready.length,
      blocked: blocked.length,
      doing: doing.length,
      failed: failed.length,
      planned: planned.length,
    },
    milestone: computeMilestone(graph, byId),
  }
}

/**
 * The milestone node, when one is set. `done` is only this node's status; it is
 * a marker fact, never a signal that the project as a whole is finished.
 */
function computeMilestone(graph, byId) {
  const milestoneId = graph?.milestoneNodeId
  if (typeof milestoneId !== 'string' || !byId.has(milestoneId)) return null
  const node = byId.get(milestoneId)
  return {
    id: node.id,
    title: node.title,
    status: node.status,
    done: node.status === 'done',
  }
}

/**
 * Would adding `from -> to` close a cycle? True when `from` is already reachable
 * from `to`, and always true for a self edge.
 */
export function wouldCreateCycle(graph, from, to) {
  if (from === to) return true
  if (typeof from !== 'string' || typeof to !== 'string') return false
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  const outgoing = new Map()
  for (const edge of edges) {
    if (typeof edge?.from !== 'string' || typeof edge?.to !== 'string') continue
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, [])
    outgoing.get(edge.from).push(edge.to)
  }
  const stack = [to]
  const seen = new Set(stack)
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === from) return true
    for (const next of outgoing.get(id) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      stack.push(next)
    }
  }
  return false
}

/**
 * Edge list for deleting a node with "splice": every upstream node that
 * satisfied one of the removed node's conditions is wired to each successor
 * condition the removed node used to satisfy. This preserves the *ordering*
 * constraint of the chain without pretending the removed node still exists.
 *
 * Pure: returns a new edge array plus the report callers put in an event.
 */
export function spliceIncoming(graph, removedNodeId) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const removed = byId.get(removedNodeId)
  const removedConditionIds = new Set(
    Array.isArray(removed?.conditions) ? removed.conditions.map((condition) => condition.id) : [],
  )
  const kept = edges.filter((edge) => edge.from !== removedNodeId && edge.to !== removedNodeId)
  const upstream = edges.filter((edge) => edge.to === removedNodeId && removedConditionIds.has(edge.conditionId))
  const downstream = edges.filter((edge) => edge.from === removedNodeId)
  const existing = new Set(kept.map((edge) => `${edge.from}\u0000${edge.to}\u0000${edge.conditionId}`))
  const added = []
  const skipped = []
  for (const out of downstream) {
    for (const source of upstream) {
      const from = source.from
      const to = out.to
      const conditionId = out.conditionId
      if (from === to) {
        skipped.push({ from, to, conditionId, reason: 'self' })
        continue
      }
      if (byId.get(from)?.status === 'failed') {
        skipped.push({ from, to, conditionId, reason: 'failed-source' })
        continue
      }
      const triple = `${from}\u0000${to}\u0000${conditionId}`
      if (existing.has(triple)) {
        skipped.push({ from, to, conditionId, reason: 'duplicate' })
        continue
      }
      existing.add(triple)
      added.push({ id: newId('e_'), from, to, conditionId })
    }
  }
  return { edges: [...kept, ...added], added, skipped }
}

/** Edge list for deleting a node with "unlink": drop every edge that touches it. */
export function unlinkIncoming(graph, removedNodeId) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  return edges.filter((edge) => edge.from !== removedNodeId && edge.to !== removedNodeId)
}

/** Node id -> topological depth. */
export function layoutLevels(graph) {
  return { ...derive(graph).levels }
}

/**
 * Ready-made positions for nodes without a manual position.
 *
 * Disconnected components are laid out independently and stacked vertically, so
 * two unrelated subgraphs can never share a column or overlap. Inside a
 * component, nodes are ordered per topological level with a barycenter sweep
 * (followed by adjacent-swap hill climbing) so avoidable edge crossings are
 * removed. Isolated nodes are packed into a small grid after the components.
 */
export function autoLayout(graph, options = {}) {
  const originX = Number.isFinite(options.originX) ? options.originX : 40
  const originY = Number.isFinite(options.originY) ? options.originY : 40
  const columnGap = Number.isFinite(options.columnGap) ? options.columnGap : 260
  const rowGap = Number.isFinite(options.rowGap) ? options.rowGap : 130
  const nodeWidth = Number.isFinite(options.nodeWidth) ? options.nodeWidth : 208
  const nodeHeight = Number.isFinite(options.nodeHeight) ? options.nodeHeight : 84
  const componentGap = Number.isFinite(options.componentGap) ? options.componentGap : 80
  const isolatedColumns = Number.isFinite(options.isolatedColumns) ? options.isolatedColumns : 3

  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  if (nodes.length === 0) return {}

  const derived = derive(graph)
  const levels = derived.levels ?? {}
  const indexOf = new Map(nodes.map((node, index) => [node.id, index]))
  const { components, validEdges } = layoutComponentsOf(nodes, edges)
  const connected = []
  const isolated = []
  for (const component of components) {
    if (component.length === 1) isolated.push(component[0])
    else connected.push(component)
  }
  connected.sort((left, right) => Math.min(...left.map((id) => indexOf.get(id) ?? 0))
    - Math.min(...right.map((id) => indexOf.get(id) ?? 0)))

  const positions = {}
  let cursorY = originY
  for (const component of connected) {
    const { layers } = orderComponentLayers(component, levels, validEdges, indexOf, columnGap, rowGap)
    const maxRows = Math.max(...layers.map((ids) => ids.length))
    for (let levelIndex = 0; levelIndex < layers.length; levelIndex += 1) {
      const ids = layers[levelIndex]
      const offset = Math.floor((maxRows - ids.length) / 2)
      for (let row = 0; row < ids.length; row += 1) {
        positions[ids[row]] = {
          x: originX + levelIndex * columnGap,
          y: cursorY + (offset + row) * rowGap,
        }
      }
    }
    cursorY += (maxRows - 1) * rowGap + nodeHeight + componentGap
  }

  if (isolated.length > 0) {
    const columns = Math.min(isolatedColumns, isolated.length)
    for (let index = 0; index < isolated.length; index += 1) {
      positions[isolated[index]] = {
        x: originX + (index % columns) * (nodeWidth + 60),
        y: cursorY + Math.floor(index / columns) * (nodeHeight + 40),
      }
    }
  }
  return positions
}

function layoutComponentsOf(nodes, edges) {
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
      for (const next of adjacency.get(current) ?? []) {
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
      const rows = (neighbors.get(id) ?? [])
        .map((neighbor) => neighborRows.get(neighbor))
        .filter((row) => Number.isFinite(row))
      const barycenter = rows.length > 0
        ? rows.reduce((sum, row) => sum + row, 0) / rows.length
        : index
      return { id, barycenter, index }
    })
    .sort((left, right) => (left.barycenter - right.barycenter)
      || (left.index - right.index)
      || ((indexOf.get(left.id) ?? 0) - (indexOf.get(right.id) ?? 0)))
    .map((entry) => entry.id)
}

function layoutLinesCross(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const o1 = cross(a, b, c)
  const o2 = cross(a, b, d)
  const o3 = cross(c, d, a)
  const o4 = cross(c, d, b)
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0))
    && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))
}

function countLayerCrossings(layers, nodeLevelIndex, edges, componentSet, columnGap, rowGap) {
  const rows = new Map()
  for (const ids of layers) ids.forEach((id, row) => rows.set(id, row))
  const points = new Map()
  for (const id of rows.keys()) {
    const level = nodeLevelIndex.get(id)
    if (level === undefined) continue
    points.set(id, { x: level * columnGap, y: rows.get(id) * rowGap })
  }
  const inComponent = edges.filter((edge) => componentSet.has(edge.from)
    && componentSet.has(edge.to) && points.has(edge.from) && points.has(edge.to))
  let crossings = 0
  for (let i = 0; i < inComponent.length; i += 1) {
    for (let j = i + 1; j < inComponent.length; j += 1) {
      const first = inComponent[i]
      const second = inComponent[j]
      if (first.from === second.from || first.to === second.to
        || first.from === second.to || first.to === second.from) continue
      if (layoutLinesCross(points.get(first.from), points.get(first.to),
        points.get(second.from), points.get(second.to))) crossings += 1
    }
  }
  return crossings
}

function improveLayerOrder(layers, nodeLevelIndex, edges, componentSet, columnGap, rowGap) {
  if (edges.length > 240 || layers.length < 2) return
  let best = countLayerCrossings(layers, nodeLevelIndex, edges, componentSet, columnGap, rowGap)
  for (let pass = 0; pass < 4 && best > 0; pass += 1) {
    let improved = false
    for (const ids of layers) {
      for (let index = 0; index + 1 < ids.length; index += 1) {
        const first = ids[index]
        ids[index] = ids[index + 1]
        ids[index + 1] = first
        const crossings = countLayerCrossings(layers, nodeLevelIndex, edges, componentSet, columnGap, rowGap)
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

function orderComponentLayers(componentIds, levels, edges, indexOf, columnGap, rowGap) {
  const componentSet = new Set(componentIds)
  const byLevel = new Map()
  for (const id of componentIds) {
    const level = levels[id] ?? 0
    if (!byLevel.has(level)) byLevel.set(level, [])
    byLevel.get(level).push(id)
  }
  const levelKeys = [...byLevel.keys()].sort((left, right) => left - right)
  const layers = levelKeys.map((level) => byLevel.get(level)
    .slice()
    .sort((left, right) => (indexOf.get(left) ?? 0) - (indexOf.get(right) ?? 0)))
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
  improveLayerOrder(layers, nodeLevelIndex, inComponent, componentSet, columnGap, rowGap)
  return { layers, nodeLevelIndex }
}

/* ------------------------------------------------------------------ */
/* invariants                                                          */
/* ------------------------------------------------------------------ */

function invariantError(message, details = {}) {
  return new TaskDagError(CODES.invariant, message, { details })
}

function assertSessionInvariants(node) {
  const sessions = node.sessions
  if (!Array.isArray(sessions)) {
    throw invariantError(`节点 ${node.id} 的 sessions 必须是数组。`, { nodeId: node.id })
  }
  const seen = new Set()
  let previousSlot = 0
  let activeCount = 0
  for (const session of sessions) {
    if (!isRecord(session)) {
      throw invariantError(`节点 ${node.id} 含有非法的会话记录。`, { nodeId: node.id })
    }
    if (typeof session.sessionId !== 'string' || session.sessionId === '') {
      throw invariantError(`节点 ${node.id} 含有缺少 sessionId 的会话记录。`, { nodeId: node.id })
    }
    if (seen.has(session.sessionId)) {
      throw invariantError(`节点 ${node.id} 的会话链重复出现 ${session.sessionId}。`, {
        nodeId: node.id,
        sessionId: session.sessionId,
      })
    }
    seen.add(session.sessionId)
    if (!Number.isInteger(session.slot) || session.slot <= 0) {
      throw invariantError(`节点 ${node.id} 的会话槽位必须是正整数。`, {
        nodeId: node.id,
        sessionId: session.sessionId,
        slot: session.slot,
      })
    }
    // Strictly increasing in array order, so slot also never repeats.
    if (session.slot <= previousSlot) {
      throw invariantError(`节点 ${node.id} 的会话槽位必须严格递增。`, {
        nodeId: node.id,
        sessionId: session.sessionId,
        slot: session.slot,
        previousSlot,
      })
    }
    previousSlot = session.slot
    if (session.retiredAt === null || session.retiredAt === undefined) activeCount += 1
  }
  if (activeCount > 1) {
    throw invariantError(`节点 ${node.id} 同时存在 ${activeCount} 个当前会话；每个节点至多一个。`, {
      nodeId: node.id,
      activeCount,
    })
  }
}

function assertConditionInvariants(node) {
  if (!Array.isArray(node.conditions)) {
    throw invariantError(`节点 ${node.id} 的 conditions 必须是数组。`, { nodeId: node.id })
  }
  const seen = new Set()
  for (const condition of node.conditions) {
    if (!isRecord(condition)) {
      throw invariantError(`节点 ${node.id} 含有非法的前置条件。`, { nodeId: node.id })
    }
    if (typeof condition.id !== 'string' || condition.id === '') {
      throw invariantError(`节点 ${node.id} 的前置条件缺少 id。`, { nodeId: node.id })
    }
    if (seen.has(condition.id)) {
      throw invariantError(`节点 ${node.id} 的前置条件 id 重复：${condition.id}。`, {
        nodeId: node.id,
        conditionId: condition.id,
      })
    }
    seen.add(condition.id)
    if (typeof condition.title !== 'string' || condition.title.trim() === '') {
      throw invariantError(`节点 ${node.id} 的前置条件缺少标题。`, {
        nodeId: node.id,
        conditionId: condition.id,
      })
    }
  }
}

function assertScheduleInvariants(node) {
  const schedule = node.schedule
  if (schedule === null || schedule === undefined) return
  if (!isRecord(schedule)) {
    throw invariantError(`节点 ${node.id} 的 schedule 必须是对象或 null。`, { nodeId: node.id })
  }
  if (typeof schedule.enabled !== 'boolean') {
    throw invariantError(`节点 ${node.id} 的定时开关必须是布尔值。`, { nodeId: node.id })
  }
  if (typeof schedule.cron !== 'string') {
    throw invariantError(`节点 ${node.id} 的定时表达式必须是字符串。`, { nodeId: node.id })
  }
  for (const field of ['nextRunAt', 'lastTriggeredAt', 'lastFinishedAt']) {
    const value = schedule[field]
    if (value !== null && value !== undefined && !isIsoTimestamp(value)) {
      throw invariantError(`节点 ${node.id} 的 ${field} 不是合法时间。`, { nodeId: node.id, field })
    }
  }
  if (schedule.lastResult !== null && schedule.lastResult !== undefined
    && !SCHEDULE_RESULTS.includes(schedule.lastResult)) {
    throw invariantError(`节点 ${node.id} 的定时结果非法：${String(schedule.lastResult)}。`, {
      nodeId: node.id,
      lastResult: schedule.lastResult,
    })
  }
}

function assertOptionalTarget(node, field) {
  const value = node[field]
  if (value === null || value === undefined) return
  if (typeof value !== 'string' || value.trim() === '') {
    throw invariantError(`节点 ${node.id} 的 ${field} 必须是非空字符串或 null。`, {
      nodeId: node.id,
      field,
    })
  }
}

/**
 * The commit gate: every invariant from the v2 design must hold before a
 * document reaches disk, because readers trust the file. Throws `invariant` or
 * `cycle` with details a transport can render, and returns true on success.
 */
export function assertInvariants(graph) {
  if (!isRecord(graph)) throw invariantError('任务图文档必须是对象。')
  if (!Array.isArray(graph.nodes)) throw invariantError('任务图的 nodes 必须是数组。')
  if (!Array.isArray(graph.edges)) throw invariantError('任务图的 edges 必须是数组。')

  const byId = new Map()
  for (const node of graph.nodes) {
    if (!isRecord(node)) throw invariantError('节点必须是对象。')
    if (typeof node.id !== 'string' || node.id === '') {
      throw invariantError('节点 id 必须是非空字符串。', { nodeId: node.id ?? null })
    }
    if (byId.has(node.id)) {
      throw invariantError(`节点 id 重复：${node.id}。`, { nodeId: node.id })
    }
    byId.set(node.id, node)
    if (!STATUSES.includes(node.status)) {
      throw invariantError(`节点 ${node.id} 的状态非法：${String(node.status)}。`, {
        nodeId: node.id,
        status: node.status,
      })
    }
    const hasCompletedAt = node.completedAt !== null && node.completedAt !== undefined
    const hasFailedAt = node.failedAt !== null && node.failedAt !== undefined
    if ((node.status === 'done') !== hasCompletedAt) {
      throw invariantError(`节点 ${node.id} 的 status 与 completedAt 不一致：done 必须对应 completedAt。`, {
        nodeId: node.id,
        status: node.status,
        completedAt: node.completedAt ?? null,
      })
    }
    if ((node.status === 'failed') !== hasFailedAt) {
      throw invariantError(`节点 ${node.id} 的 status 与 failedAt 不一致：failed 必须对应 failedAt。`, {
        nodeId: node.id,
        status: node.status,
        failedAt: node.failedAt ?? null,
      })
    }
    assertOptionalTarget(node, 'agentPreset')
    assertOptionalTarget(node, 'model')
    assertOptionalTarget(node, 'reasoningEffort')
    assertConditionInvariants(node)
    assertScheduleInvariants(node)
    assertSessionInvariants(node)
  }

  // Invariant 2: a session appears at most once in the whole graph.
  const owners = new Map()
  for (const node of graph.nodes) {
    for (const session of node.sessions) {
      const previousOwner = owners.get(session.sessionId)
      if (previousOwner !== undefined) {
        throw invariantError(
          `会话 ${session.sessionId} 同时属于节点 ${previousOwner} 和 ${node.id}；一个会话只能挂在一个节点上。`,
          { sessionId: session.sessionId, nodeIds: [previousOwner, node.id] },
        )
      }
      owners.set(session.sessionId, node.id)
    }
  }

  const triples = new Set()
  const edgeIds = new Set()
  for (const edge of graph.edges) {
    if (!isRecord(edge)) throw invariantError('边必须是对象。')
    if (typeof edge.id !== 'string' || edge.id === '') {
      throw invariantError('边的 id 必须是非空字符串。', { edgeId: edge.id ?? null })
    }
    if (edgeIds.has(edge.id)) throw invariantError(`边 id 重复：${edge.id}。`, { edgeId: edge.id })
    edgeIds.add(edge.id)
    if (!byId.has(edge.from)) {
      throw invariantError(`边 ${edge.id} 的 from 指向不存在的节点 ${String(edge.from)}。`, {
        edgeId: edge.id,
        from: edge.from ?? null,
      })
    }
    if (!byId.has(edge.to)) {
      throw invariantError(`边 ${edge.id} 的 to 指向不存在的节点 ${String(edge.to)}。`, {
        edgeId: edge.id,
        to: edge.to ?? null,
      })
    }
    if (edge.from === edge.to) {
      throw invariantError(`边 ${edge.id} 是自环：${edge.from}。`, { edgeId: edge.id, nodeId: edge.from })
    }
    // Invariant 3: a failed node can never be a prerequisite.
    if (byId.get(edge.from).status === 'failed') {
      throw invariantError(`已失败的任务不能作为前置：${edge.from}。`, {
        edgeId: edge.id,
        from: edge.from,
      })
    }
    const target = byId.get(edge.to)
    if (typeof edge.conditionId !== 'string' || edge.conditionId === '') {
      throw invariantError(`边 ${edge.id} 缺少 conditionId。`, { edgeId: edge.id })
    }
    if (!target.conditions.some((condition) => condition.id === edge.conditionId)) {
      throw invariantError(`边 ${edge.id} 指向不存在的前置条件 ${edge.conditionId}。`, {
        edgeId: edge.id,
        to: edge.to,
        conditionId: edge.conditionId,
      })
    }
    const triple = `${edge.from}\u0000${edge.to}\u0000${edge.conditionId}`
    if (triples.has(triple)) {
      throw invariantError(`重复的边：${edge.from} → ${edge.to}（条件 ${edge.conditionId}）。`, {
        from: edge.from,
        to: edge.to,
        conditionId: edge.conditionId,
      })
    }
    triples.add(triple)
  }

  if (graph.milestoneNodeId !== null && graph.milestoneNodeId !== undefined) {
    if (!byId.has(graph.milestoneNodeId)) {
      throw invariantError(`里程碑节点不存在：${String(graph.milestoneNodeId)}。`, {
        milestoneNodeId: graph.milestoneNodeId,
      })
    }
  }

  // Groups: ids unique, names non-empty, members are real and belong to at most
  // one group. A missing field is tolerated for in-process callers that build a
  // document literal, but anything stored back must be a real array.
  if (graph.groups !== undefined && !Array.isArray(graph.groups)) {
    throw invariantError('任务图的 groups 必须是数组。')
  }
  const groupIds = new Set()
  const groupOwner = new Map()
  for (const group of Array.isArray(graph.groups) ? graph.groups : []) {
    if (!isRecord(group)) throw invariantError('组合必须是对象。')
    if (typeof group.id !== 'string' || group.id === '') {
      throw invariantError('组合 id 必须是非空字符串。', { groupId: group.id ?? null })
    }
    if (groupIds.has(group.id)) {
      throw invariantError(`组合 id 重复：${group.id}。`, { groupId: group.id })
    }
    groupIds.add(group.id)
    if (typeof group.name !== 'string' || group.name.trim() === '') {
      throw invariantError(`组合 ${group.id} 缺少名称。`, { groupId: group.id })
    }
    if (!Array.isArray(group.nodeIds) || group.nodeIds.length === 0) {
      throw invariantError(`组合 ${group.id} 没有任何成员。`, { groupId: group.id })
    }
    for (const nodeId of group.nodeIds) {
      if (typeof nodeId !== 'string' || nodeId === '' || !byId.has(nodeId)) {
        throw invariantError(`组合 ${group.id} 的成员指向不存在的任务 ${String(nodeId)}。`, {
          groupId: group.id,
          nodeId: nodeId ?? null,
        })
      }
      const previousOwner = groupOwner.get(nodeId)
      if (previousOwner !== undefined) {
        throw invariantError(
          `任务 ${nodeId} 同时属于组合 ${previousOwner} 和 ${group.id}；一个任务最多属于一个组合。`,
          { nodeId, groupIds: [previousOwner, group.id] },
        )
      }
      groupOwner.set(nodeId, group.id)
    }
  }

  // Invariant 3: edges form a DAG. topology() throws `cycle` with the leftovers.
  derive(graph)
  return true
}

/** Deep copy, so callers can never mutate the store cache through a returned graph. */
export function cloneGraph(graph) {
  return structuredClone(graph)
}
