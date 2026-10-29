/**
 * The mutation layer for the task DAG (v2).
 *
 * Every write in the plugin — HTTP action route and Agent tool alike — goes
 * through `applyAction`. It validates the request against the *current* graph,
 * mutates a deep copy, and lets `GraphStore.commit` do the compare-and-swap and
 * the invariant check. Things that are derived (ready / blocked / progress) are
 * never written here; they are recomputed by `model.derive` for each snapshot.
 *
 * v2 rules enforced here:
 *   - a condition must exist on the target before an edge can satisfy it;
 *   - a failed node can never be the source of an edge, and turning a node into
 *     `failed` either refuses (it still has successors) or explicitly detaches
 *     those successors;
 *   - node-level execution targets and schedules are validated here, including
 *     the cron expression and the next run instant;
 *   - the project milestone has no edge restrictions.
 */

import { CODES, TaskDagError } from './errors.js'
import { isValidCron, nextRunAtMs } from './cron.js'
import {
  STATUSES,
  activeSession,
  assertInvariants,
  cloneGraph,
  conditionOf,
  derive,
  findNode,
  newId,
  nextSlot,
  nowIso,
  sessionOwner,
  spliceIncoming,
  unlinkIncoming,
  wouldCreateCycle,
} from './model.js'
import {
  applySessionTarget,
  archiveSession,
  buildBrief,
  createBlankSession,
  promptSession,
  readTail,
  renameSession,
  unarchiveSession,
} from './sessions.js'

/** Actions `applyAction` understands; an unknown action is a 400. */
export const SUPPORTED_ACTIONS = Object.freeze([
  'add-node',
  'update-node',
  'set-position',
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
  'unarchive-session',
])

/** `set-closeout` stays accepted so a stale browser bundle cannot 400. */
const LEGACY_ACTIONS = Object.freeze({ 'set-closeout': 'set-milestone' })

const MAX_TITLE_CHARS = 200
const MAX_NOTES_CHARS = 20000
const MAX_CONDITION_CHARS = 200
const MAX_TARGET_CHARS = 200
const MAX_SESSION_TITLE_CHARS = 120
const MAX_SCHEDULE_ERROR_CHARS = 500
const TAIL_MESSAGES = 12

/* ------------------------------------------------------------------ */
/* errors + request plumbing                                           */
/* ------------------------------------------------------------------ */

function invalidRequest(message, details) {
  return new TaskDagError(CODES.invalidRequest, message, { status: 400, details })
}

function notFound(message, details) {
  return new TaskDagError(CODES.notFound, message, { status: 404, details })
}

function claimed(message, details) {
  return new TaskDagError(CODES.sessionClaimed, message, { status: 409, details })
}

function sessionMissing(message, details) {
  return new TaskDagError(CODES.sessionNotFound, message, { status: 404, details })
}

/** Fail early and readably when the host wires the plugin without a store. */
function ensureStore(store) {
  if (store === null || typeof store !== 'object'
    || typeof store.read !== 'function' || typeof store.commit !== 'function') {
    throw new TaskDagError(CODES.hostUnavailable, '图存储没有就绪，暂时不能修改任务。', { status: 503 })
  }
}

function requireWorkspace(workspace) {
  const workspaceId = typeof workspace?.workspaceId === 'string' ? workspace.workspaceId : ''
  const path = typeof workspace?.path === 'string' ? workspace.path : ''
  if (workspaceId === '' || path === '') {
    throw invalidRequest('缺少工作区信息，无法修改任务图。')
  }
  return workspace
}

function readGraph(store, workspace) {
  return store.read(workspace).graph
}

/** Missing revisions are tolerated for in-process callers (Agent tools). */
function resolveRevision(store, workspace, value) {
  if (value === undefined || value === null) {
    const graph = readGraph(store, workspace)
    return typeof graph?.revision === 'number' && Number.isInteger(graph.revision) && graph.revision >= 0
      ? graph.revision
      : 0
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidRequest('修改版本号无效，请刷新页面后重试。', { field: 'expectedRevision' })
  }
  return value
}

async function runMutation(store, workspace, expectedRevision, mutate) {
  const revision = resolveRevision(store, workspace, expectedRevision)
  let outcome
  const graph = await store.commit(workspace, revision, (current) => {
    outcome = mutate(current)
    return { next: outcome.next, event: outcome.event }
  })
  if (outcome === undefined) {
    throw new TaskDagError(CODES.hostUnavailable, '图存储没有返回修改结果，请重试。', { status: 503 })
  }
  return { graph, result: outcome.result, warnings: [] }
}

/* ------------------------------------------------------------------ */
/* payload validation                                                  */
/* ------------------------------------------------------------------ */

function requireNodeId(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidRequest('缺少任务 ID。', { field: 'nodeId' })
  }
  return value
}

function requireEdgeId(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidRequest('缺少依赖 ID。', { field: 'edgeId' })
  }
  return value
}

function requireConditionId(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidRequest('缺少前置条件 ID。', { field: 'conditionId' })
  }
  return value
}

function requireSessionId(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidRequest('缺少会话 ID。', { field: 'sessionId' })
  }
  return value
}

function requireNode(graph, value) {
  const nodeId = requireNodeId(value)
  const node = findNode(graph, nodeId)
  if (node === undefined || node === null) {
    throw notFound('没有找到这个任务节点。', { nodeId })
  }
  return node
}

function cleanTitle(value) {
  if (typeof value !== 'string') {
    throw invalidRequest('任务标题必须是文字。', { field: 'title' })
  }
  const title = value.trim()
  if (title === '') throw invalidRequest('任务标题不能为空。', { field: 'title' })
  if (title.length > MAX_TITLE_CHARS) {
    throw invalidRequest(`任务标题太长，最多 ${MAX_TITLE_CHARS} 个字。`, { field: 'title' })
  }
  return title
}

function cleanNotes(value) {
  if (typeof value !== 'string') {
    throw invalidRequest('任务描述必须是文字。', { field: 'notes' })
  }
  if (value.length > MAX_NOTES_CHARS) {
    throw invalidRequest(`任务描述太长，最多 ${MAX_NOTES_CHARS} 个字。`, { field: 'notes' })
  }
  return value
}

function cleanConditionTitle(value) {
  if (typeof value !== 'string') {
    throw invalidRequest('前置条件标题必须是文字。', { field: 'title' })
  }
  const title = value.trim()
  if (title === '') throw invalidRequest('前置条件标题不能为空。', { field: 'title' })
  if (title.length > MAX_CONDITION_CHARS) {
    throw invalidRequest(`前置条件标题太长，最多 ${MAX_CONDITION_CHARS} 个字。`, { field: 'title' })
  }
  return title
}

/**
 * Node-level execution target: undefined = leave unchanged, null/'' = clear.
 * The value is an opaque id (agent preset id / model id); the host validates it
 * when it actually creates a session.
 */
function cleanOptionalTarget(value, field, label) {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') {
    throw invalidRequest(`${label}必须是文字，或留空表示默认。`, { field })
  }
  const text = value.trim()
  if (text === '') return null
  if (text.length > MAX_TARGET_CHARS) {
    throw invalidRequest(`${label}太长，最多 ${MAX_TARGET_CHARS} 个字符。`, { field })
  }
  return text
}

function cleanPosition(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRequest('节点位置需要 x 和 y 两个数字。', { field: 'position' })
  }
  const x = Number(value.x)
  const y = Number(value.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw invalidRequest('节点位置需要有效的 x 和 y 坐标。', { field: 'position' })
  }
  return { x, y }
}

function cleanNodeIdList(value, field, label) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw invalidRequest(`${label}需要一个任务 ID 列表。`, { field })
  }
  const ids = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw invalidRequest(`${label}里有无效的任务 ID。`, { field })
    }
    if (!ids.includes(item)) ids.push(item)
  }
  return ids
}

function cleanConditionSpecs(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw invalidRequest('前置条件需要是一个列表。', { field: 'conditions' })
  }
  return value.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw invalidRequest(`第 ${index + 1} 个前置条件格式不对。`, { field: 'conditions' })
    }
    return {
      title: cleanConditionTitle(raw.title),
      after: cleanNodeIdList(raw.after, 'after', '前置任务'),
    }
  })
}

/* ------------------------------------------------------------------ */
/* session-chain helpers                                               */
/* ------------------------------------------------------------------ */

function sessionRecordOf(node, sessionId) {
  const sessions = Array.isArray(node?.sessions) ? node.sessions : []
  return sessions.find((record) => record?.sessionId === sessionId)
}

/** Mark the node's current session as handed over; returns it. */
function retireActiveSession(node, now) {
  const current = activeSession(node)
  if (current !== undefined) current.retiredAt = now
  return current
}

function chainSessionIds(node) {
  const sessions = Array.isArray(node?.sessions) ? node.sessions : []
  return sessions.map((record) => record.sessionId)
}

/** Short label for a brand-new session that continues an existing chain. */
function continuationTitle(title, hasPrevious) {
  const base = typeof title === 'string' && title !== '' ? title : '任务'
  const text = hasPrevious ? `${base} · 续` : base
  return text.slice(0, MAX_SESSION_TITLE_CHARS)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------ */
/* graph helpers shared by the mutations                               */
/* ------------------------------------------------------------------ */

function requireUsableSource(graph, nodeId, label) {
  const node = findNode(graph, nodeId)
  if (node === undefined) {
    throw notFound(`${label}不存在，请刷新后重试。`, { nodeId })
  }
  if (node.status === 'failed') {
    throw invalidRequest('已失败的任务不能作为前置条件，请换一个任务或先把它的状态改回来。', {
      nodeId,
      status: node.status,
    })
  }
  return node
}

function assertNoCycle(graph, from, to) {
  if (wouldCreateCycle(graph, from, to)) {
    throw new TaskDagError(CODES.cycle, '新增这条依赖会形成循环，已拒绝。', {
      status: 400,
      details: { from, to },
    })
  }
}

function pushEdge(next, from, to, conditionId) {
  if (from === to) throw invalidRequest('任务不能依赖自己。', { field: 'from' })
  if (next.edges.some((edge) => edge.from === from && edge.to === to && edge.conditionId === conditionId)) {
    throw invalidRequest('这个前置条件已经由该任务满足了。', { from, to, conditionId })
  }
  assertNoCycle(next, from, to)
  const edge = { id: newId('e_'), from, to, conditionId }
  next.edges.push(edge)
  return edge
}

function addConditionToNode(next, node, title, now) {
  const condition = { id: newId('c_'), title, createdAt: now }
  node.conditions.push(condition)
  return condition
}

/** Target conditions list, formatted for an error message. */
function describeConditions(node) {
  const conditions = Array.isArray(node?.conditions) ? node.conditions : []
  return conditions.length === 0
    ? '（目标节点还没有前置条件）'
    : conditions.map((condition) => `${condition.title}（${condition.id}）`).join('、')
}

/* ------------------------------------------------------------------ */
/* graph mutations (pure: current graph in, next graph + event out)     */
/* ------------------------------------------------------------------ */

function addNode(current, payload) {
  const title = cleanTitle(payload.title)
  const notes = payload.notes === undefined ? '' : cleanNotes(payload.notes)
  const after = cleanNodeIdList(payload.after, 'after', '前置任务')
  const conditionSpecs = cleanConditionSpecs(payload.conditions)
  const position = cleanPosition(payload.position)
  const agentPreset = cleanOptionalTarget(payload.agentPreset, 'agentPreset', 'Agent 预设')
  const model = cleanOptionalTarget(payload.model, 'model', '模型')
  const reasoningEffort = cleanOptionalTarget(payload.reasoningEffort, 'reasoningEffort', '推理强度')

  const predecessorIds = [...after]
  for (const spec of conditionSpecs) predecessorIds.push(...spec.after)
  for (const predecessorId of predecessorIds) {
    if (findNode(current, predecessorId) === undefined) {
      throw notFound('前置任务不存在，请刷新后重试。', { nodeId: predecessorId })
    }
    requireUsableSource(current, predecessorId, '前置任务')
  }

  const next = cloneGraph(current)
  const nodeId = newId('n_')
  const now = nowIso()
  const node = {
    id: nodeId,
    title,
    status: 'todo',
    notes,
    conditions: [],
    sessions: [],
    position,
    agentPreset: agentPreset === undefined ? null : agentPreset,
    model: model === undefined ? null : model,
    reasoningEffort: reasoningEffort === undefined ? null : reasoningEffort,
    schedule: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    failedAt: null,
  }
  next.nodes.push(node)

  const edges = []
  const conditions = []

  for (const spec of conditionSpecs) {
    const condition = addConditionToNode(next, node, spec.title, now)
    conditions.push(condition)
    for (const predecessorId of spec.after) {
      edges.push(pushEdge(next, predecessorId, nodeId, condition.id))
    }
  }

  for (const predecessorId of after) {
    const predecessor = findNode(next, predecessorId)
    const condition = addConditionToNode(
      next,
      node,
      `${predecessor?.title ?? predecessorId} 完成`,
      now,
    )
    conditions.push(condition)
    edges.push(pushEdge(next, predecessorId, nodeId, condition.id))
  }

  return {
    next,
    event: {
      type: 'node/add',
      data: { nodeId, title, after, position, conditionIds: conditions.map((condition) => condition.id) },
    },
    result: {
      nodeId,
      node,
      edges,
      conditions,
      agentPreset: node.agentPreset,
      model: node.model,
      reasoningEffort: node.reasoningEffort,
    },
  }
}

function updateNode(current, payload) {
  const fields = ['title', 'notes', 'status', 'agentPreset', 'model', 'reasoningEffort']
  if (!fields.some((field) => payload[field] !== undefined)) {
    throw invalidRequest('没有需要修改的内容。', { field: 'payload' })
  }

  const next = cloneGraph(current)
  const node = requireNode(next, payload.nodeId)
  const now = nowIso()
  const changes = {}
  let detachedEdges = []

  if (payload.title !== undefined) {
    const title = cleanTitle(payload.title)
    if (title !== node.title) {
      node.title = title
      changes.title = title
    }
  }
  if (payload.notes !== undefined) {
    const notes = cleanNotes(payload.notes)
    if (notes !== node.notes) {
      node.notes = notes
      changes.notes = notes
    }
  }
  if (payload.status !== undefined) {
    const status = payload.status
    if (typeof status !== 'string' || !STATUSES.includes(status)) {
      throw invalidRequest(`状态只能是 ${STATUSES.join('、')}。`, { field: 'status' })
    }
    if (status !== node.status) {
      if (status === 'failed') {
        // Invariant: a failed node may not be a prerequisite. Refuse the
        // transition while it still has successors unless the caller opted in
        // to detaching them in the same action.
        const successors = next.edges.filter((edge) => edge.from === node.id)
        if (successors.length > 0 && payload.detachSuccessors !== true) {
          throw invalidRequest(
            `这个任务还有 ${successors.length} 个后续任务依赖它；已失败的任务不能作为前置。`
            + '请先解除这些依赖，或选择「失败并解除依赖」。',
            {
              successorCount: successors.length,
              successors: successors.map((edge) => ({ to: edge.to, conditionId: edge.conditionId })),
            },
          )
        }
        if (successors.length > 0) {
          const detachedIds = new Set(successors.map((edge) => edge.id))
          next.edges = next.edges.filter((edge) => !detachedIds.has(edge.id))
          detachedEdges = successors.map((edge) => ({ id: edge.id, to: edge.to, conditionId: edge.conditionId }))
        }
        node.status = 'failed'
        node.failedAt = now
        node.completedAt = null
      } else if (status === 'done') {
        node.status = 'done'
        node.completedAt = now
        node.failedAt = null
      } else {
        node.status = status
        node.completedAt = null
        node.failedAt = null
      }
      changes.status = status
    }
  }

  const agentPreset = cleanOptionalTarget(payload.agentPreset, 'agentPreset', 'Agent 预设')
  if (agentPreset !== undefined && agentPreset !== node.agentPreset) {
    node.agentPreset = agentPreset
    changes.agentPreset = agentPreset
  }
  const model = cleanOptionalTarget(payload.model, 'model', '模型')
  if (model !== undefined && model !== node.model) {
    node.model = model
    changes.model = model
    // An effort belongs to a model, so switching/clearing the model drops it;
    // the caller can send a matching reasoningEffort in the same action.
    if (payload.reasoningEffort === undefined && node.reasoningEffort !== null) {
      node.reasoningEffort = null
      changes.reasoningEffort = null
    }
  }
  const reasoningEffort = cleanOptionalTarget(payload.reasoningEffort, 'reasoningEffort', '推理强度')
  if (reasoningEffort !== undefined && reasoningEffort !== node.reasoningEffort) {
    node.reasoningEffort = reasoningEffort
    changes.reasoningEffort = reasoningEffort
  }

  if (Object.keys(changes).length > 0) node.updatedAt = now

  return {
    next,
    event: {
      type: 'node/update',
      data: { nodeId: node.id, changes, ...(detachedEdges.length > 0 ? { detachedEdges } : {}) },
    },
    result: { nodeId: node.id, node, changes, detachedEdges },
  }
}

function setPosition(current, payload) {
  const next = cloneGraph(current)
  const node = requireNode(next, payload.nodeId)
  const position = cleanPosition(payload.position)
  node.position = position
  return {
    next,
    event: { type: 'node/position', data: { nodeId: node.id, position } },
    result: { nodeId: node.id, position },
  }
}

/**
 * Batch position update shared by auto-layout and drag collision avoidance.
 * One commit means one snapshot and one revision bump for the whole move.
 */
function setPositions(current, payload) {
  const list = payload.positions
  if (!Array.isArray(list) || list.length === 0) {
    throw invalidRequest('positions 需要至少一个节点的位置。', { field: 'positions' })
  }
  const next = cloneGraph(current)
  const seen = new Set()
  const applied = []
  for (const item of list) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw invalidRequest('positions 里的每一项都需要 nodeId 和 position。', { field: 'positions' })
    }
    const nodeId = requireNodeId(item.nodeId)
    if (seen.has(nodeId)) {
      throw invalidRequest(`节点 ${nodeId} 在 positions 里重复出现。`, { field: 'positions' })
    }
    seen.add(nodeId)
    const node = requireNode(next, nodeId)
    const position = cleanPosition(item.position)
    node.position = position
    applied.push({ nodeId, position })
  }
  return {
    next,
    event: { type: 'node/positions', data: { positions: applied } },
    result: { positions: applied },
  }
}

function orphanedConditions(next, outbound, removedNodeId) {
  const seen = new Set()
  const orphaned = []
  for (const edge of outbound) {
    const key = `${edge.to}\u0000${edge.conditionId}`
    if (seen.has(key)) continue
    seen.add(key)
    const target = findNode(next, edge.to)
    const condition = conditionOf(next, edge.to, edge.conditionId)
    if (target === undefined || condition === undefined) continue
    const remaining = next.edges.some((item) => item.to === edge.to && item.conditionId === edge.conditionId)
    if (!remaining) orphaned.push({ nodeId: edge.to, nodeTitle: target.title, conditionId: condition.id, title: condition.title })
  }
  void removedNodeId
  return orphaned
}

function deleteNode(current, payload) {
  const mode = payload.mode === undefined || payload.mode === null ? 'splice' : payload.mode
  if (mode !== 'splice' && mode !== 'unlink') {
    throw invalidRequest('删除方式只能是 splice 或 unlink。', { field: 'mode' })
  }

  const next = cloneGraph(current)
  const node = requireNode(next, payload.nodeId)
  const sessionIds = chainSessionIds(node)
  const title = node.title
  const outbound = current.edges.filter((edge) => edge.from === node.id)
  const conditionIds = Array.isArray(node.conditions) ? node.conditions.map((condition) => condition.id) : []

  const rewired = mode === 'splice'
    ? spliceIncoming(current, node.id)
    : { edges: unlinkIncoming(current, node.id), added: [], skipped: [] }

  next.nodes = next.nodes.filter((item) => item.id !== node.id)
  next.edges = Array.isArray(rewired.edges) ? rewired.edges : []
  if (next.milestoneNodeId === node.id) next.milestoneNodeId = null
  const orphaned = orphanedConditions(next, outbound, node.id)

  try {
    assertInvariants(next)
  } catch (error) {
    if (error?.code === CODES.cycle) {
      throw new TaskDagError(CODES.cycle, '删除这个任务会把前置条件变成环，请改用「只移除该任务」。', {
        status: 400,
        details: { nodeId: node.id, mode },
      })
    }
    throw error
  }

  return {
    next,
    event: {
      type: 'node/delete',
      data: { nodeId: node.id, title, mode, sessionIds, conditionIds, orphanedConditions: orphaned },
    },
    result: {
      nodeId: node.id,
      title,
      mode,
      sessionIds,
      conditionIds,
      added: Array.isArray(rewired.added) ? rewired.added : [],
      skipped: Array.isArray(rewired.skipped) ? rewired.skipped : [],
      orphanedConditions: orphaned,
    },
  }
}

function linkNodes(current, payload) {
  const from = requireNodeId(payload.from)
  const to = requireNodeId(payload.to)
  if (from === to) throw invalidRequest('任务不能依赖自己。', { field: 'from' })
  const source = requireUsableSource(current, from, '起点任务')
  const target = requireNode(current, to)

  let condition
  let conditionCreated = false
  const rawConditionId = payload.conditionId === undefined || payload.conditionId === null
    ? ''
    : requireConditionId(payload.conditionId)

  if (rawConditionId !== '') {
    condition = conditionOf(current, to, rawConditionId)
    if (condition === undefined) {
      throw invalidRequest(`目标节点没有这个前置条件：${rawConditionId}。`, {
        field: 'conditionId',
        nodeId: to,
        conditions: Array.isArray(target.conditions) ? target.conditions.map((item) => item.id) : [],
      })
    }
  } else if (payload.conditionTitle !== undefined && payload.conditionTitle !== null) {
    const title = cleanConditionTitle(payload.conditionTitle)
    condition = (Array.isArray(target.conditions) ? target.conditions : [])
      .find((item) => item.title === title)
  } else {
    // No explicit choice: reuse the only still-unsatisfied single condition, or
    // mint a condition named after the source node (the M1-like default). If the
    // pair already has a link, refuse instead of silently creating a second
    // same-titled condition — the caller must say which condition it satisfies.
    const unsatisfied = (Array.isArray(target.conditions) ? target.conditions : [])
      .filter((item) => !current.edges.some((edge) => edge.to === to && edge.conditionId === item.id))
    if (unsatisfied.length === 1) {
      condition = unsatisfied[0]
    } else if (current.edges.some((edge) => edge.from === from && edge.to === to)) {
      throw invalidRequest('这个任务已经是目标的前置了；请选择它具体满足哪个前置条件，或先新建条件。', {
        from,
        to,
        conditions: Array.isArray(target.conditions) ? target.conditions.map((item) => ({ id: item.id, title: item.title })) : [],
      })
    }
  }

  const next = cloneGraph(current)
  const nextTarget = requireNode(next, to)
  if (condition === undefined) {
    condition = addConditionToNode(next, nextTarget, payload.conditionTitle === undefined || payload.conditionTitle === null
      ? `${source.title} 完成`
      : cleanConditionTitle(payload.conditionTitle), nowIso())
    conditionCreated = true
  }

  if (next.edges.some((edge) => edge.from === from && edge.to === to && edge.conditionId === condition.id)) {
    throw invalidRequest('这个前置条件已经由该任务满足了。', { from, to, conditionId: condition.id })
  }
  assertNoCycle(next, from, to)

  const now = nowIso()
  const edge = { id: newId('e_'), from, to, conditionId: condition.id }
  next.edges.push(edge)
  for (const nodeId of [from, to]) {
    const node = findNode(next, nodeId)
    if (node !== undefined) node.updatedAt = now
  }

  return {
    next,
    event: {
      type: 'edge/add',
      data: { edgeId: edge.id, from, to, conditionId: condition.id, conditionCreated },
    },
    result: {
      edge,
      edgeId: edge.id,
      from,
      to,
      conditionId: condition.id,
      condition,
      conditionCreated,
    },
  }
}

function unlinkEdge(current, payload) {
  const edgeId = requireEdgeId(payload.edgeId)
  const edge = current.edges.find((item) => item?.id === edgeId)
  if (edge === undefined) throw notFound('没有找到这条依赖。', { edgeId })

  const next = cloneGraph(current)
  next.edges = next.edges.filter((item) => item.id !== edgeId)
  const now = nowIso()
  for (const nodeId of [edge.from, edge.to]) {
    const node = findNode(next, nodeId)
    if (node !== undefined) node.updatedAt = now
  }

  return {
    next,
    event: {
      type: 'edge/remove',
      data: { edgeId, from: edge.from, to: edge.to, conditionId: edge.conditionId },
    },
    result: { edgeId, from: edge.from, to: edge.to, conditionId: edge.conditionId },
  }
}

function setMilestone(current, payload) {
  const raw = payload.nodeId
  let nodeId = null
  if (raw !== null && raw !== undefined && raw !== '') {
    nodeId = requireNodeId(raw)
    if (findNode(current, nodeId) === undefined) {
      throw notFound('没有找到要标记为里程碑的任务。', { nodeId })
    }
  }

  const next = cloneGraph(current)
  next.milestoneNodeId = nodeId
  return {
    next,
    event: { type: 'milestone/set', data: { milestoneNodeId: nodeId } },
    result: { milestoneNodeId: nodeId },
  }
}

function addCondition(current, payload) {
  const title = cleanConditionTitle(payload.title)
  const next = cloneGraph(current)
  const node = requireNode(next, payload.nodeId)
  const now = nowIso()
  const condition = addConditionToNode(next, node, title, now)
  node.updatedAt = now
  return {
    next,
    event: { type: 'condition/add', data: { nodeId: node.id, conditionId: condition.id, title: condition.title } },
    result: { nodeId: node.id, condition },
  }
}

function updateCondition(current, payload) {
  const conditionId = requireConditionId(payload.conditionId)
  const title = cleanConditionTitle(payload.title)
  const next = cloneGraph(current)
  const node = requireNode(next, payload.nodeId)
  const condition = conditionOf(next, node.id, conditionId)
  if (condition === undefined) throw notFound('没有找到这个前置条件。', { nodeId: node.id, conditionId })
  condition.title = title
  node.updatedAt = nowIso()
  return {
    next,
    event: { type: 'condition/update', data: { nodeId: node.id, conditionId, title } },
    result: { nodeId: node.id, condition },
  }
}

function deleteCondition(current, payload) {
  const conditionId = requireConditionId(payload.conditionId)
  const next = cloneGraph(current)
  const node = requireNode(next, payload.nodeId)
  const condition = conditionOf(next, node.id, conditionId)
  if (condition === undefined) throw notFound('没有找到这个前置条件。', { nodeId: node.id, conditionId })
  const removedEdges = next.edges
    .filter((edge) => edge.to === node.id && edge.conditionId === conditionId)
    .map((edge) => ({ id: edge.id, from: edge.from, conditionId: edge.conditionId }))
  node.conditions = node.conditions.filter((item) => item.id !== conditionId)
  next.edges = next.edges.filter((edge) => !(edge.to === node.id && edge.conditionId === conditionId))
  node.updatedAt = nowIso()
  return {
    next,
    event: {
      type: 'condition/remove',
      data: { nodeId: node.id, conditionId, title: condition.title, removedEdges },
    },
    result: { nodeId: node.id, conditionId, title: condition.title, removedEdges },
  }
}

function cleanCron(value) {
  if (typeof value !== 'string') {
    throw invalidRequest('定时表达式必须是文字。', { field: 'cron' })
  }
  const cron = value.trim()
  if (cron !== '' && !isValidCron(cron)) {
    throw invalidRequest('定时表达式不合法，需要 5 段：分 时 日 月 周。', { field: 'cron' })
  }
  return cron
}

function setSchedule(current, payload, now = nowIso()) {
  const next = cloneGraph(current)
  const node = requireNode(next, payload.nodeId)
  const existing = node.schedule
  const schedule = {
    enabled: existing?.enabled === true,
    cron: existing?.cron ?? '',
    nextRunAt: existing?.nextRunAt ?? null,
    lastTriggeredAt: existing?.lastTriggeredAt ?? null,
    lastFinishedAt: existing?.lastFinishedAt ?? null,
    lastResult: existing?.lastResult ?? null,
    lastError: existing?.lastError ?? null,
    lastSkippedReason: existing?.lastSkippedReason ?? null,
    lastSessionId: existing?.lastSessionId ?? null,
  }

  if (payload.cron !== undefined) schedule.cron = cleanCron(payload.cron)
  if (payload.enabled !== undefined) {
    if (typeof payload.enabled !== 'boolean') {
      throw invalidRequest('定时开关必须是 true 或 false。', { field: 'enabled' })
    }
    schedule.enabled = payload.enabled
  }

  if (schedule.enabled) {
    if (schedule.cron === '') {
      throw invalidRequest('开启定时执行前请先填写定时表达式。', { field: 'cron' })
    }
    const nextMs = nextRunAtMs(schedule.cron, Date.parse(now))
    if (nextMs === undefined) {
      throw invalidRequest('这个定时表达式永远不会触发，请换一个。', { field: 'cron' })
    }
    schedule.nextRunAt = new Date(nextMs).toISOString()
  } else {
    schedule.nextRunAt = null
  }

  node.schedule = schedule
  node.updatedAt = now
  return {
    next,
    event: { type: 'schedule/set', data: { nodeId: node.id, schedule } },
    result: { nodeId: node.id, schedule },
  }
}

/* ------------------------------------------------------------------ */
/* execution settlement (shared with the scheduler)                    */
/* ------------------------------------------------------------------ */

/**
 * Settle a scheduled/manual execution against the node it ran for.
 *
 * Only applies while the node is still `doing` and the recorded session is the
 * node's current session, so a human edit made during the run always wins.
 * A failed execution detaches the node's outgoing edges because a failed node
 * may never remain a prerequisite.
 *
 * @returns {{next: object, event: object|undefined, result: object}|null}
 */
export function applyExecutionOutcome(current, options = {}) {
  const nodeId = requireNodeId(options.nodeId)
  const outcome = options.outcome
  if (outcome !== 'succeeded' && outcome !== 'failed' && outcome !== 'cancelled') {
    throw invalidRequest('执行结果只能是 succeeded、failed 或 cancelled。', { field: 'outcome' })
  }
  const next = cloneGraph(current)
  const node = findNode(next, nodeId)
  if (node === undefined) return null

  if (node.status !== 'doing') {
    return { next: current, event: undefined, result: { applied: false, reason: 'not-doing', outcome } }
  }
  const currentSessionId = activeSession(node)?.sessionId
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId : ''
  if (sessionId !== '' && currentSessionId !== undefined && currentSessionId !== sessionId) {
    return { next: current, event: undefined, result: { applied: false, reason: 'session-changed', outcome } }
  }

  const now = typeof options.now === 'string' && options.now !== '' ? options.now : nowIso()
  let detachedEdges = []
  if (outcome === 'succeeded') {
    node.status = 'done'
    node.completedAt = now
    node.failedAt = null
  } else if (outcome === 'failed') {
    const outgoing = next.edges.filter((edge) => edge.from === node.id)
    const detachedIds = new Set(outgoing.map((edge) => edge.id))
    if (outgoing.length > 0) next.edges = next.edges.filter((edge) => !detachedIds.has(edge.id))
    detachedEdges = outgoing.map((edge) => ({ id: edge.id, to: edge.to, conditionId: edge.conditionId }))
    node.status = 'failed'
    node.failedAt = now
    node.completedAt = null
  } else {
    return { next: current, event: undefined, result: { applied: false, reason: 'cancelled', outcome } }
  }
  node.updatedAt = now

  return {
    next,
    event: {
      type: 'node/execution',
      data: {
        nodeId: node.id,
        outcome,
        sessionId: sessionId === '' ? null : sessionId,
        error: typeof options.error === 'string' ? options.error.slice(0, MAX_SCHEDULE_ERROR_CHARS) : null,
        detachedEdges,
      },
    },
    result: { applied: true, outcome, nodeId: node.id, detachedEdges },
  }
}

/* ------------------------------------------------------------------ */
/* session mutations (same shape as M1)                                */
/* ------------------------------------------------------------------ */

function attachSession(current, payload, sessionId) {
  const next = cloneGraph(current)
  const node = requireNode(next, payload.nodeId)

  const owner = sessionOwner(next, sessionId)
  if (owner !== null && owner !== node.id) {
    throw claimed('这个会话已经挂在别的任务上，请先在那里摘除。', {
      sessionId,
      nodeId: node.id,
      ownerNodeId: owner,
    })
  }

  const existing = sessionRecordOf(node, sessionId)
  if (existing !== undefined) {
    // Idempotent: the session is already in this node's chain. Use
    // `switch-session` to make a retired record current again.
    return {
      next: current,
      event: undefined,
      result: { nodeId: node.id, sessionId, slot: existing.slot, session: existing, idempotent: true },
    }
  }

  const now = nowIso()
  const makeActive = payload.makeActive !== false
  const previous = makeActive ? retireActiveSession(node, now) : activeSession(node)
  const rawSnapshot = payload.titleSnapshot
  const titleSnapshot = typeof rawSnapshot === 'string' && rawSnapshot.trim() !== ''
    ? rawSnapshot.trim().slice(0, MAX_TITLE_CHARS)
    : node.title

  const record = {
    sessionId,
    slot: nextSlot(node),
    titleSnapshot,
    attachedAt: now,
    retiredAt: makeActive ? null : now,
    handoff: {
      from: makeActive ? previous?.sessionId ?? null : null,
      mode: payload.handoffMode === 'scheduled' ? 'scheduled' : 'attach',
    },
  }
  node.sessions.push(record)
  node.updatedAt = now

  return {
    next,
    event: {
      type: 'session/attach',
      data: {
        nodeId: node.id,
        sessionId,
        slot: record.slot,
        retiredSessionId: makeActive ? previous?.sessionId ?? null : null,
        mode: record.handoff.mode,
      },
    },
    result: {
      nodeId: node.id,
      sessionId,
      slot: record.slot,
      session: record,
      idempotent: false,
      retiredSessionId: makeActive ? previous?.sessionId ?? null : null,
    },
  }
}

function switchSession(current, payload) {
  const next = cloneGraph(current)
  const node = requireNode(next, payload.nodeId)
  const sessionId = requireSessionId(payload.sessionId)
  const record = sessionRecordOf(node, sessionId)
  if (record === undefined) {
    throw sessionMissing('这个会话不在这条任务链上。', { sessionId, nodeId: node.id })
  }
  if (record.retiredAt === null) {
    return {
      next: current,
      event: undefined,
      result: { nodeId: node.id, sessionId, idempotent: true },
    }
  }

  const now = nowIso()
  const previous = retireActiveSession(node, now)
  record.retiredAt = null
  node.updatedAt = now

  return {
    next,
    event: {
      type: 'session/switch',
      data: { nodeId: node.id, sessionId, retiredSessionId: previous?.sessionId ?? null },
    },
    result: {
      nodeId: node.id,
      sessionId,
      idempotent: false,
      retiredSessionId: previous?.sessionId ?? null,
    },
  }
}

function detachSession(current, payload) {
  const next = cloneGraph(current)
  const node = requireNode(next, payload.nodeId)
  const sessionId = requireSessionId(payload.sessionId)
  const record = sessionRecordOf(node, sessionId)
  if (record === undefined) {
    throw sessionMissing('这个会话不在这条任务链上。', { sessionId, nodeId: node.id })
  }

  const wasActive = record.retiredAt === null
  node.sessions = node.sessions.filter((item) => item !== record)
  node.updatedAt = nowIso()

  return {
    next,
    event: { type: 'session/detach', data: { nodeId: node.id, sessionId, wasActive } },
    result: { nodeId: node.id, sessionId, wasActive },
  }
}

function applyHandoff(current, { nodeId, sessionId, mode, briefText }) {
  const next = cloneGraph(current)
  const node = requireNode(next, nodeId)

  const owner = sessionOwner(next, sessionId)
  if (owner !== null) {
    throw claimed('新建的会话已经属于别的任务，请重试。', {
      sessionId,
      nodeId: node.id,
      ownerNodeId: owner,
    })
  }

  const now = nowIso()
  const previous = retireActiveSession(node, now)
  const record = {
    sessionId,
    slot: nextSlot(node),
    titleSnapshot: node.title,
    attachedAt: now,
    retiredAt: null,
    handoff: { from: previous?.sessionId ?? null, mode },
  }
  node.sessions.push(record)
  node.updatedAt = now

  return {
    next,
    event: {
      type: 'session/handoff',
      data: {
        nodeId: node.id,
        from: previous?.sessionId ?? null,
        to: sessionId,
        mode,
        slot: record.slot,
        brief: typeof briefText === 'string' ? briefText : null,
      },
    },
    result: {
      nodeId: node.id,
      sessionId,
      slot: record.slot,
      previousSessionId: previous?.sessionId ?? null,
      session: record,
    },
  }
}

/* ------------------------------------------------------------------ */
/* async action runners                                                */
/* ------------------------------------------------------------------ */

/** attach-session may be idempotent; do that without burning a revision. */
async function runAttachSession(ctx, store, workspace, request, payload) {
  const rawSessionId = payload.sessionId ?? request.callerSessionId
  const sessionId = requireSessionId(rawSessionId)

  const before = readGraph(store, workspace)
  const node = requireNode(before, payload.nodeId)

  const owner = sessionOwner(before, sessionId)
  if (owner !== null && owner !== node.id) {
    throw claimed('这个会话已经挂在别的任务上，请先在那里摘除。', {
      sessionId,
      nodeId: node.id,
      ownerNodeId: owner,
    })
  }

  const existing = sessionRecordOf(node, sessionId)
  if (existing !== undefined) {
    const warnings = payload.makeActive === false || existing.retiredAt !== null
      ? []
      : await sessionTargetWarnings(ctx, before, node.id, sessionId)
    return {
      graph: before,
      result: { nodeId: node.id, sessionId, slot: existing.slot, session: existing, idempotent: true },
      warnings,
    }
  }

  const outcome = await runMutation(store, workspace, request.expectedRevision,
    (current) => attachSession(current, payload, sessionId))
  const warnings = [...outcome.warnings]
  if (payload.makeActive !== false) {
    warnings.push(...await sessionTargetWarnings(ctx, outcome.graph, node.id))
  }
  return { ...outcome, warnings }
}

/** switch-session to the already-current session is a real no-op. */
async function runSwitchSession(ctx, store, workspace, request, payload) {
  const before = readGraph(store, workspace)
  const node = requireNode(before, payload.nodeId)
  const sessionId = requireSessionId(payload.sessionId)
  const record = sessionRecordOf(node, sessionId)
  if (record !== undefined && record.retiredAt === null) {
    const warnings = await sessionTargetWarnings(ctx, before, node.id, sessionId)
    return {
      graph: before,
      result: { nodeId: node.id, sessionId, idempotent: true },
      warnings,
    }
  }
  const outcome = await runMutation(store, workspace, request.expectedRevision,
    (current) => switchSession(current, payload))
  const warnings = [...outcome.warnings, ...await sessionTargetWarnings(ctx, outcome.graph, node.id, sessionId)]
  return { ...outcome, warnings }
}

/**
 * Best-effort application of the node target to its (now) active session.
 * `sessionId` defaults to whatever the graph says is current.
 */
async function sessionTargetWarnings(ctx, graph, nodeId, sessionId) {
  const node = findNode(graph, nodeId)
  if (node === undefined) return []
  const active = activeSession(node)
  if (active === undefined) return []
  if (typeof sessionId === 'string' && sessionId !== '' && active.sessionId !== sessionId) return []
  const applied = await applySessionTarget(ctx, active.sessionId, {
    model: node.model,
    reasoningEffort: node.reasoningEffort,
  })
  return applied.warning === null ? [] : [applied.warning]
}

/** update-node: the graph commit lands first, then the target reaches the live session. */
async function runUpdateNode(ctx, store, workspace, request, payload) {
  const outcome = await runMutation(store, workspace, request.expectedRevision,
    (current) => updateNode(current, payload))
  const changes = outcome.result !== null && typeof outcome.result === 'object' && outcome.result.changes !== null
    && typeof outcome.result.changes === 'object'
    ? outcome.result.changes
    : {}
  if (changes.model === undefined && changes.reasoningEffort === undefined) return outcome
  const node = findNode(outcome.graph, payload.nodeId)
  if (node === undefined) return outcome
  const active = activeSession(node)
  if (active === undefined) return outcome
  const applied = await applySessionTarget(ctx, active.sessionId, {
    model: node.model,
    reasoningEffort: node.reasoningEffort,
  })
  const warnings = [...outcome.warnings]
  if (applied.warning !== null) warnings.push(applied.warning)
  return { ...outcome, warnings }
}

/** Delete commits first, then archives the chain (best effort, as opted in). */
async function runDeleteNode(ctx, store, workspace, request, payload) {
  const outcome = await runMutation(store, workspace, request.expectedRevision,
    (current) => deleteNode(current, payload))

  const warnings = [...outcome.warnings]
  const archived = []
  const failed = []
  if (payload.archiveSessions === true) {
    for (const sessionId of outcome.result.sessionIds) {
      try {
        await archiveSession(ctx, sessionId, true)
        archived.push(sessionId)
      } catch (error) {
        failed.push({ sessionId, message: messageOf(error) })
        warnings.push(`会话 ${sessionId} 归档失败：${messageOf(error)}`)
      }
    }
  }

  return {
    graph: outcome.graph,
    result: { ...outcome.result, archive: { archived, failed } },
    warnings,
  }
}

/**
 * Handoff = new blank session + short deterministic brief. Ordering is fixed:
 * create -> CAS commit (retire old, attach new) -> rename -> prompt. A failed
 * commit therefore cannot deliver a brief into a session the graph does not own.
 * The node's own agentPreset/model are used for the new session.
 */
async function runHandoff(ctx, store, workspace, request, payload) {
  const mode = payload.mode === undefined || payload.mode === null ? 'brief' : payload.mode
  if (mode !== 'brief' && mode !== 'blank') {
    throw invalidRequest('交接方式只能是 brief 或 blank。', { field: 'mode' })
  }
  const nodeId = requireNodeId(payload.nodeId)

  const before = readGraph(store, workspace)
  const nodeBefore = requireNode(before, nodeId)
  const previous = activeSession(nodeBefore)
  const revision = resolveRevision(store, workspace, request.expectedRevision)

  const warnings = []
  let brief = null
  if (mode === 'brief') {
    let events = []
    if (previous !== undefined) {
      const tail = await readTail(ctx, previous.sessionId, TAIL_MESSAGES)
      events = tail.events
      warnings.push(...tail.warnings)
      if (tail.source === 'unavailable') {
        warnings.push('没能读到旧会话的历史，交接简报只包含任务状态。')
      }
    }
    const derived = derive(before)
    brief = buildBrief({ graph: before, node: nodeBefore, events, derived })
  }

  // Created before the commit on purpose: a created-but-unattached session is
  // harmless (it shows up in the workspace list), while a committed-but-unsent
  // brief would silently lose context.
  const sessionId = await createBlankSession(ctx, workspace, {
    agentPreset: nodeBefore.agentPreset,
    model: nodeBefore.model,
    reasoningEffort: nodeBefore.reasoningEffort,
  })

  let committed = null
  const graph = await store.commit(workspace, revision, (current) => {
    committed = applyHandoff(current, {
      nodeId,
      sessionId,
      mode,
      briefText: brief === null ? null : brief.text,
    })
    return { next: committed.next, event: committed.event }
  })
  if (committed === null) {
    throw new TaskDagError(CODES.hostUnavailable, '图存储没有返回交接结果，请重试。', { status: 503 })
  }

  const handoffResult = committed.result
  const renamed = await renameSession(
    ctx,
    sessionId,
    continuationTitle(nodeBefore.title, handoffResult.previousSessionId !== null),
  )

  let prompted = false
  if (mode === 'brief' && brief !== null) {
    try {
      await promptSession(ctx, sessionId, brief.text)
      prompted = true
    } catch (error) {
      warnings.push(`新会话已经建好，但交接简报没能发送：${messageOf(error)}`)
    }
  }

  return {
    graph,
    result: {
      nodeId,
      sessionId,
      mode,
      previousSessionId: handoffResult.previousSessionId,
      slot: handoffResult.slot,
      renamed,
      brief: brief === null ? null : brief.text,
      briefTokens: brief === null ? null : brief.tokens,
      prompted,
      agentPreset: nodeBefore.agentPreset,
      model: nodeBefore.model,
      reasoningEffort: nodeBefore.reasoningEffort,
    },
    warnings,
  }
}

/** Archive every session of a node; graph untouched (archive is not deletion). */
async function runArchiveSessions(ctx, store, workspace, payload) {
  const graph = readGraph(store, workspace)
  const node = requireNode(graph, payload.nodeId)
  const archived = []
  const failed = []
  const warnings = []

  for (const sessionId of chainSessionIds(node)) {
    try {
      await archiveSession(ctx, sessionId, true)
      archived.push(sessionId)
    } catch (error) {
      failed.push({ sessionId, message: messageOf(error) })
      warnings.push(`会话 ${sessionId} 归档失败：${messageOf(error)}`)
    }
  }

  return {
    graph,
    result: { nodeId: node.id, archived, failed },
    warnings,
  }
}

async function runUnarchiveSession(ctx, store, workspace, payload) {
  const sessionId = requireSessionId(payload.sessionId)
  await unarchiveSession(ctx, sessionId)
  return {
    graph: readGraph(store, workspace),
    result: { sessionId },
    warnings: [],
  }
}

/* ------------------------------------------------------------------ */
/* public entry point                                                  */
/* ------------------------------------------------------------------ */

/**
 * Apply one graph action.
 *
 * @param {object} ctx fake or real Cordis context (sessions helpers use it)
 * @param {import('./store.js').GraphStore} store graph store for this host
 * @param {{workspaceId: string, path: string, title?: string}} workspace
 * @param {{action: string, expectedRevision?: number, payload?: object, callerSessionId?: string, requestId?: string}} request
 * @returns {Promise<{graph: object, result: object, warnings: string[]}>}
 */
export async function applyAction(ctx, store, workspace, request) {
  ensureStore(store)
  requireWorkspace(workspace)

  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw invalidRequest('操作请求格式不对。')
  }
  const rawAction = typeof request.action === 'string' ? request.action.trim() : ''
  if (rawAction === '') throw invalidRequest('缺少操作名称。', { field: 'action' })
  const action = LEGACY_ACTIONS[rawAction] ?? rawAction

  const payload = request.payload === undefined || request.payload === null ? {} : request.payload
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw invalidRequest('操作参数格式不对。', { field: 'payload' })
  }

  switch (action) {
    case 'add-node':
      return runMutation(store, workspace, request.expectedRevision,
        (current) => addNode(current, payload))

    case 'update-node':
      return runUpdateNode(ctx, store, workspace, request, payload)

    case 'set-position':
      return runMutation(store, workspace, request.expectedRevision,
        (current) => setPosition(current, payload))

    case 'set-positions':
      return runMutation(store, workspace, request.expectedRevision,
        (current) => setPositions(current, payload))

    case 'delete-node':
      return runDeleteNode(ctx, store, workspace, request, payload)

    case 'link':
      return runMutation(store, workspace, request.expectedRevision,
        (current) => linkNodes(current, payload))

    case 'unlink':
      return runMutation(store, workspace, request.expectedRevision,
        (current) => unlinkEdge(current, payload))

    case 'set-milestone':
      return runMutation(store, workspace, request.expectedRevision,
        (current) => setMilestone(current, payload))

    case 'add-condition':
      return runMutation(store, workspace, request.expectedRevision,
        (current) => addCondition(current, payload))

    case 'update-condition':
      return runMutation(store, workspace, request.expectedRevision,
        (current) => updateCondition(current, payload))

    case 'delete-condition':
      return runMutation(store, workspace, request.expectedRevision,
        (current) => deleteCondition(current, payload))

    case 'set-schedule':
      return runMutation(store, workspace, request.expectedRevision,
        (current) => setSchedule(current, payload))

    case 'attach-session':
      return runAttachSession(ctx, store, workspace, request, payload)

    case 'switch-session':
      return runSwitchSession(ctx, store, workspace, request, payload)

    case 'detach-session':
      return runMutation(store, workspace, request.expectedRevision,
        (current) => detachSession(current, payload))

    case 'handoff':
      return runHandoff(ctx, store, workspace, request, payload)

    case 'archive-sessions':
      return runArchiveSessions(ctx, store, workspace, payload)

    case 'unarchive-session':
      return runUnarchiveSession(ctx, store, workspace, payload)

    default:
      throw invalidRequest(`不支持的操作：${action}。`, { action })
  }
}
