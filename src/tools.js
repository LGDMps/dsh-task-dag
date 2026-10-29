/**
 * Agent tools for the `dsh-task-dag` plugin.
 *
 * The tools are the Agent-facing transport of the same mutation layer the
 * browser uses: every write goes through `ops.applyAction`, so both transports
 * share validation, revision checks and session rules.
 *
 * v2 semantics: a node owns `conditions[]` and an edge satisfies exactly one of
 * them, so tools talk about 前置条件 rather than a single "prerequisite" edge.
 * Agents may not delete nodes, cut edges, delete conditions, change the
 * milestone or configure schedules — those stay human-only.
 *
 * Definitions are written in the *compiled* JSON Schema dialect that
 * `ctx.tools.register` expects (`parameters` is raw JSON Schema, not the author
 * dialect with `required: true` on properties). Arguments are validated here
 * before they reach `ops`, and every `output.schema` mirrors the exact value
 * `execute` returns.
 */
import { CODES, TaskDagError, isTaskDagError } from './errors.js'
import {
  STATUSES,
  activeSession,
  conditionsOf,
  derive,
  findNode,
  prereqsOf,
  sessionOwner,
  successorsOf,
} from './model.js'
import { applyAction } from './ops.js'
import { workspaceForSession } from './workspaces.js'

/** Tool names in registration order. */
export const TOOL_NAMES = [
  'graph_map',
  'graph_next',
  'graph_add_node',
  'graph_link',
  'graph_update_node',
  'graph_add_condition',
  'graph_attach_session',
]

const STATUS_LABELS = Object.freeze({
  planned: '待规划',
  todo: '待开始',
  doing: '进行中',
  done: '已完成',
  failed: '已失败',
})

const SCHEDULE_RESULTS = ['succeeded', 'failed', 'skipped']

const PROGRESS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['done', 'total', 'ready', 'blocked', 'doing', 'failed', 'planned'],
  properties: {
    done: { type: 'integer' },
    total: { type: 'integer' },
    ready: { type: 'integer' },
    blocked: { type: 'integer' },
    doing: { type: 'integer' },
    failed: { type: 'integer' },
    planned: { type: 'integer' },
  },
})

const WORKSPACE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['workspaceId', 'path', 'title'],
  properties: {
    workspaceId: { type: 'string' },
    path: { type: 'string' },
    title: { type: 'string' },
  },
})

const NODE_BRIEF_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'status'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string', enum: [...STATUSES] },
  },
})

const NODE_LABEL_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
  },
})

const CONDITION_VIEW_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'satisfied', 'linked'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    satisfied: { type: 'boolean' },
    linked: { type: 'array', items: NODE_BRIEF_SCHEMA },
  },
})

const SCHEDULE_SUMMARY_SCHEMA = Object.freeze({
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['enabled', 'cron', 'nextRunAt', 'lastResult', 'lastError'],
  properties: {
    enabled: { type: 'boolean' },
    cron: { type: ['string', 'null'] },
    nextRunAt: { type: ['string', 'null'] },
    lastResult: { type: ['string', 'null'] },
    lastError: { type: ['string', 'null'] },
  },
})

const MILESTONE_SCHEMA = Object.freeze({
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['id', 'title', 'status', 'done'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string', enum: [...STATUSES] },
    done: { type: 'boolean' },
  },
})

const NODE_ID = {
  type: 'string',
  description: '节点 id，形如 n_1a2b3c4d，可用 graph_map 查看。',
}

const PRESET_SCHEMA = {
  type: ['string', 'null'],
  description: 'Agent 预设 id；null 或空字符串表示用宿主默认。',
}

const MODEL_SCHEMA = {
  type: ['string', 'null'],
  description: '模型（provider/model 或 model id）；null 或空字符串表示用宿主默认。',
}

const REASONING_EFFORT_SCHEMA = {
  type: ['string', 'null'],
  description: '推理强度 id（由所选模型提供）；null 或空字符串表示该模型的默认强度。',
}

const EMPTY_PROGRESS = Object.freeze({
  done: 0,
  total: 0,
  ready: 0,
  blocked: 0,
  doing: 0,
  failed: 0,
  planned: 0,
})

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function statusLabel(status) {
  return STATUS_LABELS[status] ?? String(status ?? '')
}

function revisionOf(graph) {
  return Number.isInteger(graph?.revision) && graph.revision >= 0 ? graph.revision : 0
}

function normalizeIdList(list) {
  if (!Array.isArray(list)) return []
  const ids = []
  for (const entry of list) {
    if (typeof entry === 'string' && entry !== '') ids.push(entry)
    else if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '') {
      ids.push(entry.id)
    }
  }
  return ids
}

function progressStatusCount(nodes, status) {
  return nodes.filter((node) => node?.status === status).length
}

function fallbackProgress(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  return {
    done: progressStatusCount(nodes, 'done'),
    total: nodes.length,
    ready: 0,
    blocked: 0,
    doing: progressStatusCount(nodes, 'doing'),
    failed: progressStatusCount(nodes, 'failed'),
    planned: progressStatusCount(nodes, 'planned'),
  }
}

function normalizeProgress(progress, graph) {
  const fallback = fallbackProgress(graph)
  if (progress === null || typeof progress !== 'object' || Array.isArray(progress)) return fallback
  return {
    done: Number.isInteger(progress.done) ? progress.done : fallback.done,
    total: Number.isInteger(progress.total) ? progress.total : fallback.total,
    ready: Number.isInteger(progress.ready) ? progress.ready : fallback.ready,
    blocked: Number.isInteger(progress.blocked) ? progress.blocked : fallback.blocked,
    doing: Number.isInteger(progress.doing) ? progress.doing : fallback.doing,
    failed: Number.isInteger(progress.failed) ? progress.failed : fallback.failed,
    planned: Number.isInteger(progress.planned) ? progress.planned : fallback.planned,
  }
}

function nodeBrief(node) {
  return {
    id: typeof node?.id === 'string' ? node.id : '',
    title: typeof node?.title === 'string' ? node.title : '',
    status: STATUSES.includes(node?.status) ? node.status : 'todo',
  }
}

function nodeLabel(node) {
  return {
    id: typeof node?.id === 'string' ? node.id : '',
    title: typeof node?.title === 'string' ? node.title : '',
  }
}

function presetOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function scheduleSummary(schedule) {
  if (schedule === null || typeof schedule !== 'object' || Array.isArray(schedule)) return null
  return {
    enabled: schedule.enabled === true,
    cron: typeof schedule.cron === 'string' ? schedule.cron : null,
    nextRunAt: typeof schedule.nextRunAt === 'string' ? schedule.nextRunAt : null,
    lastResult: SCHEDULE_RESULTS.includes(schedule.lastResult) ? schedule.lastResult : null,
    lastError: typeof schedule.lastError === 'string' ? schedule.lastError : null,
  }
}

function toolFailure(error) {
  if (isTaskDagError(error)) return error
  console.error('[dsh-task-dag] 工具执行失败', error)
  const message = error instanceof Error ? error.message : String(error)
  const short = message.length > 160 ? `${message.slice(0, 160)}…` : message
  return new TaskDagError(CODES.invalidRequest, `操作失败：${short}`)
}

function invalid(message) {
  return new TaskDagError(CODES.invalidRequest, message)
}

/** The workspace and session the tool call acts for. */
function resolveCallContext(ctx, exec) {
  const candidates = [exec?.agent?.id, exec?.agent?.session?.id, exec?.sessionId]
  const sessionId = candidates.find((value) => typeof value === 'string' && value !== '') ?? ''
  if (sessionId === '') {
    throw new TaskDagError(CODES.invalidRequest, '这个工具只能在会话里调用。')
  }
  const workspace = workspaceForSession(ctx, sessionId)
  if (workspace === undefined) {
    throw new TaskDagError(CODES.notFound, '当前会话没有关联到工作区。', { status: 404 })
  }
  return { sessionId, workspace }
}

function readGraph(store, workspace) {
  const graph = store.read(workspace)?.graph
  if (graph === null || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new TaskDagError(CODES.invalidGraph, '任务图谱无法读取。')
  }
  return graph
}

function requireText(value, field, message) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TaskDagError(CODES.invalidRequest, message, { details: { field } })
  }
  return value.trim()
}

function requireId(value, field, message) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TaskDagError(CODES.invalidRequest, message, { details: { field } })
  }
  return value.trim()
}

function optionalText(value, field) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new TaskDagError(CODES.invalidRequest, `${field} 必须是文本。`, { details: { field } })
  }
  return value
}

function optionalIdArray(value, field) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new TaskDagError(CODES.invalidRequest, `${field} 必须是节点 id 列表。`, { details: { field } })
  }
  return value.map((entry) => requireId(entry, field, `${field} 里只能放节点 id。`))
}

/** `null` clears the choice; an empty string means "use the host default". */
function optionalPresetValue(value, field) {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new TaskDagError(CODES.invalidRequest, `${field} 必须是文字或 null。`, { details: { field } })
  }
  const text = value.trim()
  return text === '' ? null : text
}

function optionalConditions(value) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new TaskDagError(CODES.invalidRequest, 'conditions 必须是条件列表。', { details: { field: 'conditions' } })
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TaskDagError(CODES.invalidRequest, `conditions 第 ${index + 1} 项必须是对象。`, {
        details: { field: 'conditions' },
      })
    }
    const title = requireText(
      entry.title,
      'conditions',
      `conditions 第 ${index + 1} 项缺少条件标题。`,
    )
    const condition = { title }
    const after = optionalIdArray(entry.after, 'conditions')
    if (after !== undefined) condition.after = after
    return condition
  })
}

function appliedGraph(applied, store, workspace) {
  if (applied !== null && typeof applied === 'object'
    && applied.graph !== null && typeof applied.graph === 'object') {
    return applied.graph
  }
  return readGraph(store, workspace)
}

// ---------------------------------------------------------------------------
// pure view builders (also unit-tested directly)
// ---------------------------------------------------------------------------

/** The single most useful ready node: first by unlock count, then by level. */
export function pickNextNode(graph, derived) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  if (nodes.length === 0) return undefined

  const readyIds = normalizeIdList(derived?.ready)
    .filter((id) => findNode(graph, id)?.status === 'todo')
  if (readyIds.length === 0) return undefined

  const levels = derived !== null && typeof derived?.levels === 'object' && derived.levels !== null
    ? derived.levels
    : {}
  const orderIndex = new Map(normalizeIdList(derived?.order).map((id, index) => [id, index]))

  const scored = readyIds.map((id) => {
    const node = findNode(graph, id)
    const unlocks = successorsOf(graph, id)
      .filter((edge) => findNode(graph, edge.to)?.status === 'todo')
      .length
    const level = Number.isFinite(levels[id]) ? levels[id] : 0
    const order = orderIndex.has(id) ? orderIndex.get(id) : Number.MAX_SAFE_INTEGER
    return { id, unlocks, level, order }
  })

  scored.sort((left, right) => (
    right.unlocks - left.unlocks
    || left.level - right.level
    || left.order - right.order
    || left.id.localeCompare(right.id)
  ))

  return findNode(graph, scored[0].id)
}

function conditionViewFromDerived(entry) {
  return {
    id: typeof entry?.id === 'string' ? entry.id : '',
    title: typeof entry?.title === 'string' ? entry.title : '',
    satisfied: entry?.satisfied === true,
    linked: (Array.isArray(entry?.linked) ? entry.linked : [])
      .filter((item) => item !== null && typeof item === 'object')
      .map((item) => nodeBrief(item)),
  }
}

/** Compute condition views from the document when `derive` did not carry them. */
function fallbackConditionViews(graph, node, nodeById) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  return conditionsOf(graph, node.id).map((condition) => {
    const linked = edges
      .filter((edge) => edge?.to === node.id && edge?.conditionId === condition.id)
      .map((edge) => nodeById.get(edge.from))
      .filter((linkedNode) => linkedNode !== undefined)
      .map((linkedNode) => nodeBrief(linkedNode))
    return {
      id: condition.id,
      title: condition.title,
      satisfied: linked.some((item) => item.status === 'done'),
      linked,
    }
  })
}

export function buildGraphMap(workspace, graph, derived) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const ready = new Set(normalizeIdList(derived?.ready))
  const blocked = new Set(normalizeIdList(derived?.blocked))
  const derivedConditions = derived?.conditions !== null && typeof derived?.conditions === 'object'
    ? derived.conditions
    : {}

  const mapped = nodes.map((node) => {
    const conditions = Array.isArray(derivedConditions[node.id])
      ? derivedConditions[node.id].map(conditionViewFromDerived)
      : fallbackConditionViews(graph, node, nodeById)
    const prereqs = prereqsOf(graph, node.id).map((edge) => {
      const prereq = nodeById.get(edge.from)
      return {
        id: edge.from,
        title: prereq?.title ?? '',
        status: STATUSES.includes(prereq?.status) ? prereq.status : 'todo',
      }
    })
    return {
      id: node.id,
      title: node.title,
      status: STATUSES.includes(node.status) ? node.status : 'todo',
      conditions,
      agentPreset: presetOf(node.agentPreset),
      model: presetOf(node.model),
      reasoningEffort: presetOf(node.reasoningEffort),
      schedule: scheduleSummary(node.schedule),
      prereqs,
      sessionCount: Array.isArray(node.sessions) ? node.sessions.length : 0,
      activeSessionId: activeSession(node)?.sessionId ?? null,
      ready: ready.has(node.id),
      blocked: blocked.has(node.id),
    }
  })

  const milestoneNode = typeof graph?.milestoneNodeId === 'string'
    ? nodeById.get(graph.milestoneNodeId)
    : undefined

  return {
    workspace: {
      workspaceId: workspace.workspaceId,
      path: workspace.path,
      title: workspace.title,
    },
    revision: revisionOf(graph),
    nodes: mapped,
    ready: mapped.filter((node) => node.ready).map((node) => nodeLabel(node)),
    blocked: mapped
      .filter((node) => node.blocked)
      .map((node) => ({
        id: node.id,
        title: node.title,
        // A blocked node waits on the conditions that are not satisfied yet.
        waitingFor: node.conditions.filter((condition) => !condition.satisfied).map((condition) => condition.title),
      })),
    failed: mapped.filter((node) => node.status === 'failed').map((node) => nodeLabel(node)),
    planned: mapped.filter((node) => node.status === 'planned').map((node) => nodeLabel(node)),
    milestone: milestoneNode === undefined
      ? null
      : {
        id: milestoneNode.id,
        title: milestoneNode.title,
        status: STATUSES.includes(milestoneNode.status) ? milestoneNode.status : 'todo',
        done: milestoneNode.status === 'done',
      },
    progress: normalizeProgress(derived?.progress, graph),
  }
}

export function buildNext(graph, derived) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const readyIds = normalizeIdList(derived?.ready)
    .filter((id) => findNode(graph, id)?.status === 'todo')
  const node = pickNextNode(graph, derived)

  if (node === undefined) {
    return {
      node: null,
      readyCount: readyIds.length,
      blockedCount: normalizeIdList(derived?.blocked).length,
      total: nodes.length,
      done: normalizeIdList(derived?.done).length,
    }
  }

  return {
    node: {
      ...nodeBrief(node),
      prereqs: prereqsOf(graph, node.id)
        .map((edge) => findNode(graph, edge.from))
        .filter((prereq) => prereq !== undefined)
        .map((prereq) => nodeBrief(prereq)),
      unlocks: successorsOf(graph, node.id)
        .map((edge) => findNode(graph, edge.to))
        .filter((successor) => successor !== undefined && successor.status === 'todo')
        .map((successor) => nodeBrief(successor)),
    },
    readyCount: readyIds.length,
    blockedCount: normalizeIdList(derived?.blocked).length,
    total: nodes.length,
    done: normalizeIdList(derived?.done).length,
  }
}

// ---------------------------------------------------------------------------
// renderers: the text the model sees
// ---------------------------------------------------------------------------

function renderCondition(condition) {
  if (condition.satisfied) return `${condition.title}（已满足）`
  if (condition.linked.length === 0) return `${condition.title}（尚未关联节点）`
  const waiting = condition.linked
    .filter((item) => item.status !== 'done')
    .map((item) => `${item.title}（${statusLabel(item.status)}）`)
  return `${condition.title}（等待 ${waiting.join('、')}）`
}

function renderMapText(value) {
  const progress = value?.progress ?? EMPTY_PROGRESS
  const nodes = Array.isArray(value?.nodes) ? value.nodes : []
  const lines = [
    `任务图谱：${value?.workspace?.title ?? ''}（完成 ${progress.done}/${progress.total}，可开始 ${value?.ready?.length ?? 0}，等待前置条件 ${value?.blocked?.length ?? 0}，进行中 ${progress.doing}，已失败 ${progress.failed}，待规划 ${progress.planned}）`,
  ]

  if (nodes.length === 0) {
    lines.push('还没有任务节点，可以用 graph_add_node 添加。')
  } else {
    for (const node of nodes) {
      const conditionText = node.conditions.length === 0
        ? '无条件'
        : `前置条件：${node.conditions.map(renderCondition).join('、')}`
      const extras = []
      if (node.agentPreset !== null) extras.push(`预设 ${node.agentPreset}`)
      if (node.model !== null) extras.push(`模型 ${node.model}`)
      if (node.reasoningEffort !== null) extras.push(`推理 ${node.reasoningEffort}`)
      if (node.schedule?.enabled === true) extras.push(`定时 ${node.schedule.cron ?? '未配置'}`)
      const suffix = extras.length === 0 ? '' : `（${extras.join('，')}）`
      lines.push(`- ${node.title}（${node.id}）[${statusLabel(node.status)}] ${conditionText}${suffix}`)
    }
  }

  lines.push(value?.ready?.length > 0
    ? `可开始：${value.ready.map((node) => `${node.title}（${node.id}）`).join('、')}`
    : '可开始：无')

  if (value?.blocked?.length > 0) {
    lines.push(`等待前置条件：${value.blocked.map((node) => `${node.title}（等 ${node.waitingFor.join('、')}）`).join('；')}`)
  }
  if (value?.failed?.length > 0) {
    lines.push(`已失败：${value.failed.map((node) => `${node.title}（${node.id}）`).join('、')}`)
  }
  if (value?.planned?.length > 0) {
    lines.push(`待规划：${value.planned.map((node) => `${node.title}（${node.id}）`).join('、')}`)
  }

  lines.push(value?.milestone === null || value?.milestone === undefined
    ? '里程碑：未设置'
    : `里程碑：${value.milestone.title}（${value.milestone.id}，${statusLabel(value.milestone.status)}）`)

  return lines.join('\n')
}

function renderNextText(value) {
  if (value?.node === null || value?.node === undefined) {
    if (value?.total === 0) return '当前没有任务节点，请先用 graph_add_node 添加。'
    if (value.readyCount === 0 && value.blockedCount > 0) {
      return `当前没有可开始的任务，有 ${value.blockedCount} 个任务在等待前置条件完成。`
    }
    return '当前没有可开始的任务。'
  }

  const node = value.node
  const conditions = node.prereqs.length === 0
    ? '它没有前置条件。'
    : `它的前置条件都满足了（${node.prereqs.map((item) => item.title).join('、')}）。`
  const unlocks = node.unlocks.length === 0
    ? '完成后不会解锁其他任务。'
    : `完成后解锁：${node.unlocks.map((item) => item.title).join('、')}。`
  return `建议下一个任务：${node.title}（${node.id}）。\n${conditions}\n${unlocks}`
}

function renderAddText(value) {
  const title = value?.node?.title ?? value?.nodeId ?? ''
  const graph = value?.graph ?? {}
  const progress = graph.progress ?? EMPTY_PROGRESS
  return `已新增任务节点「${title}」（${value?.nodeId ?? ''}）。当前共 ${graph.total ?? 0} 个节点，完成 ${progress.done}/${progress.total}。`
}

function renderLinkText(value) {
  const condition = typeof value?.conditionTitle === 'string' && value.conditionTitle !== ''
    ? `（满足条件「${value.conditionTitle}」）`
    : ''
  return `已连接：${value?.from?.title ?? ''}（${value?.from?.id ?? ''}）→ ${value?.to?.title ?? ''}（${value?.to?.id ?? ''}）${condition}。`
}

function renderUpdateText(value) {
  if (value?.node === null || value?.node === undefined) return '已更新任务节点。'
  return `已更新「${value.node.title}」（${value.node.id}）：状态 ${statusLabel(value.node.status)}。`
}

function renderAddConditionText(value) {
  const title = value?.condition?.title ?? ''
  return `已为任务节点「${value?.nodeTitle ?? value?.nodeId ?? ''}」添加前置条件「${title}」。`
}

function renderAttachText(value) {
  return `已把当前会话挂到「${value?.node?.title ?? ''}」，这是第 ${value?.slot ?? 0} 段会话。`
}

function safeRender(render, fallback) {
  return (args, value) => {
    try {
      return [{ type: 'text', text: render(value) }]
    } catch (error) {
      console.error('[dsh-task-dag] 工具结果渲染失败', error)
      return [{ type: 'text', text: fallback }]
    }
  }
}

// ---------------------------------------------------------------------------
// definitions
// ---------------------------------------------------------------------------

/**
 * Build the seven tool definitions. Exported so tests can inspect the compiled
 * schemas and exercise `execute` without a full tool service.
 *
 * @param {object} ctx host context
 * @param {{read: Function}} store graph store
 */
export function buildToolDefinitions(ctx, store) {
  return [
    {
      name: 'graph_map',
      description: '查看当前工作区的任务图谱：节点状态与前置条件、可开始/被阻塞/已失败/待规划的任务、里程碑节点（仅作标记，不代表项目结束）和完成进度。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: [
            'workspace', 'revision', 'nodes', 'ready', 'blocked', 'failed', 'planned',
            'milestone', 'progress',
          ],
          properties: {
            workspace: WORKSPACE_SCHEMA,
            revision: { type: 'integer' },
            nodes: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'id', 'title', 'status', 'conditions', 'agentPreset', 'model', 'reasoningEffort',
                  'schedule', 'prereqs', 'sessionCount', 'activeSessionId', 'ready', 'blocked',
                ],
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  status: { type: 'string', enum: [...STATUSES] },
                  conditions: { type: 'array', items: CONDITION_VIEW_SCHEMA },
                  agentPreset: { type: ['string', 'null'] },
                  model: { type: ['string', 'null'] },
                  reasoningEffort: { type: ['string', 'null'] },
                  schedule: SCHEDULE_SUMMARY_SCHEMA,
                  prereqs: { type: 'array', items: NODE_BRIEF_SCHEMA },
                  sessionCount: { type: 'integer' },
                  activeSessionId: { type: ['string', 'null'] },
                  ready: { type: 'boolean' },
                  blocked: { type: 'boolean' },
                },
              },
            },
            ready: { type: 'array', items: NODE_LABEL_SCHEMA },
            blocked: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'title', 'waitingFor'],
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  waitingFor: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            failed: { type: 'array', items: NODE_LABEL_SCHEMA },
            planned: { type: 'array', items: NODE_LABEL_SCHEMA },
            milestone: MILESTONE_SCHEMA,
            progress: PROGRESS_SCHEMA,
          },
        },
        render: safeRender(renderMapText, '任务图谱已读取。'),
      },
      execute: async (args, exec) => {
        try {
          const { workspace } = resolveCallContext(ctx, exec)
          const graph = readGraph(store, workspace)
          const derived = derive(graph)
          return buildGraphMap(workspace, graph, derived)
        } catch (error) {
          throw toolFailure(error)
        }
      },
    },

    {
      name: 'graph_next',
      description: '从可开始（前置条件已满足）的任务里挑出最值得先做的一个，并给出它的前置条件和完成后解锁的任务。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['node', 'readyCount', 'blockedCount', 'total', 'done'],
          properties: {
            node: {
              type: ['object', 'null'],
              additionalProperties: false,
              required: ['id', 'title', 'status', 'prereqs', 'unlocks'],
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string', enum: [...STATUSES] },
                prereqs: { type: 'array', items: NODE_BRIEF_SCHEMA },
                unlocks: { type: 'array', items: NODE_BRIEF_SCHEMA },
              },
            },
            readyCount: { type: 'integer' },
            blockedCount: { type: 'integer' },
            total: { type: 'integer' },
            done: { type: 'integer' },
          },
        },
        render: safeRender(renderNextText, '下一个任务已选出。'),
      },
      execute: async (args, exec) => {
        try {
          const { workspace } = resolveCallContext(ctx, exec)
          const graph = readGraph(store, workspace)
          const derived = derive(graph)
          return buildNext(graph, derived)
        } catch (error) {
          throw toolFailure(error)
        }
      },
    },

    {
      name: 'graph_add_node',
      description: '在当前工作区的任务图谱里新增一个任务节点，可选地给它添加前置条件、执行目标（预设/模型/推理强度）或位置；after 简写会为每个前序节点自动建一个条件。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务标题。' },
          after: {
            type: 'array',
            items: { type: 'string' },
            description: '简写：作为前序的节点 id 列表，每个会自动创建一个前置条件。',
          },
          conditions: {
            type: 'array',
            description: '前置条件列表；每条可带 after 指定由哪些前序节点来满足它。',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title'],
              properties: {
                title: { type: 'string', description: '条件标题。' },
                after: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '满足这个条件的前序节点 id；省略表示暂未关联节点。',
                },
              },
            },
          },
          notes: { type: 'string', description: '任务描述，可省略。' },
          agentPreset: PRESET_SCHEMA,
          model: MODEL_SCHEMA,
          reasoningEffort: REASONING_EFFORT_SCHEMA,
        },
        required: ['title'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['nodeId', 'node', 'graph'],
          properties: {
            nodeId: { type: 'string' },
            node: { ...NODE_BRIEF_SCHEMA, type: ['object', 'null'] },
            graph: {
              type: 'object',
              additionalProperties: false,
              required: ['revision', 'total', 'progress'],
              properties: {
                revision: { type: 'integer' },
                total: { type: 'integer' },
                progress: PROGRESS_SCHEMA,
              },
            },
          },
        },
        render: safeRender(renderAddText, '已新增任务节点。'),
      },
      execute: async (args, exec) => {
        try {
          const { workspace } = resolveCallContext(ctx, exec)
          const title = requireText(args?.title, 'title', '请提供任务标题。')
          const payload = { title }
          const notes = optionalText(args?.notes, 'notes')
          if (notes !== undefined) payload.notes = notes
          const after = optionalIdArray(args?.after, 'after')
          if (after !== undefined) payload.after = after
          const conditions = optionalConditions(args?.conditions)
          if (conditions !== undefined) payload.conditions = conditions
          const agentPreset = optionalPresetValue(args?.agentPreset, 'agentPreset')
          if (agentPreset !== undefined) payload.agentPreset = agentPreset
          const model = optionalPresetValue(args?.model, 'model')
          if (model !== undefined) payload.model = model
          const reasoningEffort = optionalPresetValue(args?.reasoningEffort, 'reasoningEffort')
          if (reasoningEffort !== undefined) payload.reasoningEffort = reasoningEffort

          const before = readGraph(store, workspace)
          const beforeIds = new Set((Array.isArray(before.nodes) ? before.nodes : []).map((node) => node.id))
          const applied = await applyAction(ctx, store, workspace, {
            action: 'add-node',
            expectedRevision: revisionOf(before),
            payload,
          })
          const graph = appliedGraph(applied, store, workspace)
          const result = applied?.result
          const created = (Array.isArray(graph.nodes) ? graph.nodes : [])
            .find((node) => !beforeIds.has(node.id))
            ?? (typeof result?.nodeId === 'string' ? findNode(graph, result.nodeId) : undefined)
          const nodeId = typeof result?.nodeId === 'string'
            ? result.nodeId
            : (typeof created?.id === 'string' ? created.id : '')
          const derived = derive(graph)

          return {
            nodeId,
            node: created === undefined ? null : nodeBrief(created),
            graph: {
              revision: revisionOf(graph),
              total: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
              progress: normalizeProgress(derived?.progress, graph),
            },
          }
        } catch (error) {
          throw toolFailure(error)
        }
      },
    },

    {
      name: 'graph_link',
      description: '添加一条前置关系：from 完成后满足 to 的某个前置条件。可用 conditionId 选择已有条件，或用 conditionTitle 按标题找/新建条件；都省略时自动选择或新建条件。会拒绝自环、重复和成环。',
      parameters: {
        type: 'object',
        properties: {
          from: { ...NODE_ID, description: '前序节点 id。' },
          to: { ...NODE_ID, description: '后置节点 id。' },
          conditionId: { type: 'string', description: '目标节点上已有的条件 id；省略则自动选择或新建。' },
          conditionTitle: { type: 'string', description: '目标节点上的条件标题；不存在时新建。' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'edgeId', 'conditionId', 'conditionTitle', 'from', 'to', 'revision'],
          properties: {
            ok: { type: 'boolean' },
            edgeId: { type: 'string' },
            conditionId: { type: 'string' },
            conditionTitle: { type: 'string' },
            from: NODE_BRIEF_SCHEMA,
            to: NODE_BRIEF_SCHEMA,
            revision: { type: 'integer' },
          },
        },
        render: safeRender(renderLinkText, '已添加前置关系。'),
      },
      execute: async (args, exec) => {
        try {
          const { workspace } = resolveCallContext(ctx, exec)
          const from = requireId(args?.from, 'from', '请提供前序节点 id。')
          const to = requireId(args?.to, 'to', '请提供后置节点 id。')
          const payload = { from, to }
          if (args?.conditionId !== undefined && args?.conditionId !== null) {
            payload.conditionId = requireId(args.conditionId, 'conditionId', 'conditionId 必须是非空字符串。')
          }
          if (args?.conditionTitle !== undefined && args?.conditionTitle !== null) {
            payload.conditionTitle = requireText(
              args.conditionTitle,
              'conditionTitle',
              'conditionTitle 必须是非空字符串。',
            )
          }

          const before = readGraph(store, workspace)
          const beforeEdgeIds = new Set(
            (Array.isArray(before.edges) ? before.edges : []).map((edge) => edge.id),
          )
          const applied = await applyAction(ctx, store, workspace, {
            action: 'link',
            expectedRevision: revisionOf(before),
            payload,
          })
          const graph = appliedGraph(applied, store, workspace)
          const result = applied?.result
          const created = (Array.isArray(graph.edges) ? graph.edges : [])
            .find((edge) => edge.from === from && edge.to === to && !beforeEdgeIds.has(edge.id))
          const edgeId = typeof result?.edgeId === 'string'
            ? result.edgeId
            : typeof result?.edge?.id === 'string'
              ? result.edge.id
              : (typeof created?.id === 'string' ? created.id : '')
          const conditionId = typeof result?.conditionId === 'string'
            ? result.conditionId
            : typeof created?.conditionId === 'string'
              ? created.conditionId
              : ''
          const toNode = findNode(graph, to)
          const condition = (Array.isArray(toNode?.conditions) ? toNode.conditions : [])
            .find((item) => item?.id === conditionId)
          const conditionTitle = typeof result?.conditionTitle === 'string'
            ? result.conditionTitle
            : typeof condition?.title === 'string'
              ? condition.title
              : ''

          return {
            ok: true,
            edgeId,
            conditionId,
            conditionTitle,
            from: nodeBrief(findNode(graph, from)),
            to: nodeBrief(toNode),
            revision: revisionOf(graph),
          }
        } catch (error) {
          throw toolFailure(error)
        }
      },
    },

    {
      name: 'graph_update_node',
      description: '修改任务节点的标题、任务描述、状态（planned/todo/doing/done/failed）或执行设置（Agent 预设、模型、推理强度）。把节点改为 failed 时若还有后继，需要显式 detachSuccessors 才会同时解除它的出边。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: NODE_ID,
          title: { type: 'string', description: '新标题；省略表示不改。' },
          notes: { type: 'string', description: '新任务描述；传空字符串表示清空。' },
          status: {
            type: 'string',
            enum: [...STATUSES],
            description: '新状态：planned 待规划、todo 待开始、doing 进行中、done 已完成、failed 已失败。',
          },
          agentPreset: PRESET_SCHEMA,
          model: MODEL_SCHEMA,
          reasoningEffort: REASONING_EFFORT_SCHEMA,
          detachSuccessors: {
            type: 'boolean',
            description: '改为 failed 时是否同时解除它的出边（默认 false，有后继会被拒绝）。',
          },
        },
        required: ['nodeId'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['node', 'revision', 'progress'],
          properties: {
            node: {
              type: ['object', 'null'],
              additionalProperties: false,
              required: [
                'id', 'title', 'status', 'notes', 'completedAt', 'failedAt', 'agentPreset',
                'model', 'reasoningEffort',
              ],
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string', enum: [...STATUSES] },
                notes: { type: 'string' },
                completedAt: { type: ['string', 'null'] },
                failedAt: { type: ['string', 'null'] },
                agentPreset: { type: ['string', 'null'] },
                model: { type: ['string', 'null'] },
                reasoningEffort: { type: ['string', 'null'] },
              },
            },
            revision: { type: 'integer' },
            progress: PROGRESS_SCHEMA,
          },
        },
        render: safeRender(renderUpdateText, '已更新任务节点。'),
      },
      execute: async (args, exec) => {
        try {
          const { workspace } = resolveCallContext(ctx, exec)
          const nodeId = requireId(args?.nodeId, 'nodeId', '请提供节点 id。')
          const payload = { nodeId }

          if (args?.title !== undefined) payload.title = requireText(args.title, 'title', '标题不能为空。')
          if (args?.notes !== undefined) {
            if (typeof args.notes !== 'string') throw invalid('notes 必须是文本。')
            payload.notes = args.notes
          }
          if (args?.status !== undefined) {
            if (!STATUSES.includes(args.status)) throw invalid(`status 只能是 ${STATUSES.join('、')}。`)
            payload.status = args.status
          }
          const agentPreset = optionalPresetValue(args?.agentPreset, 'agentPreset')
          if (agentPreset !== undefined) payload.agentPreset = agentPreset
          const model = optionalPresetValue(args?.model, 'model')
          if (model !== undefined) payload.model = model
          const reasoningEffort = optionalPresetValue(args?.reasoningEffort, 'reasoningEffort')
          if (reasoningEffort !== undefined) payload.reasoningEffort = reasoningEffort
          if (args?.detachSuccessors !== undefined) {
            if (typeof args.detachSuccessors !== 'boolean') throw invalid('detachSuccessors 必须是布尔值。')
            payload.detachSuccessors = args.detachSuccessors
          }
          if (Object.keys(payload).length === 1) throw invalid('请至少提供一个要修改的字段。')

          const before = readGraph(store, workspace)
          const applied = await applyAction(ctx, store, workspace, {
            action: 'update-node',
            expectedRevision: revisionOf(before),
            payload,
          })
          const graph = appliedGraph(applied, store, workspace)
          const node = findNode(graph, nodeId)

          return {
            node: node === undefined
              ? null
              : {
                id: node.id,
                title: node.title,
                status: STATUSES.includes(node.status) ? node.status : 'todo',
                notes: typeof node.notes === 'string' ? node.notes : '',
                completedAt: typeof node.completedAt === 'string' ? node.completedAt : null,
                failedAt: typeof node.failedAt === 'string' ? node.failedAt : null,
                agentPreset: presetOf(node.agentPreset),
                model: presetOf(node.model),
                reasoningEffort: presetOf(node.reasoningEffort),
              },
            revision: revisionOf(graph),
            progress: normalizeProgress(derive(graph)?.progress, graph),
          }
        } catch (error) {
          throw toolFailure(error)
        }
      },
    },

    {
      name: 'graph_add_condition',
      description: '给任务节点添加一个前置条件。条件不会自动关联节点；之后可以用 graph_link 把前序节点连到这个条件上。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: NODE_ID,
          title: { type: 'string', description: '条件标题，例如「需求评审通过」。' },
        },
        required: ['nodeId', 'title'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['nodeId', 'nodeTitle', 'conditionId', 'condition', 'revision'],
          properties: {
            nodeId: { type: 'string' },
            nodeTitle: { type: 'string' },
            conditionId: { type: 'string' },
            condition: {
              type: ['object', 'null'],
              additionalProperties: false,
              required: ['id', 'title'],
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
              },
            },
            revision: { type: 'integer' },
          },
        },
        render: safeRender(renderAddConditionText, '已添加前置条件。'),
      },
      execute: async (args, exec) => {
        try {
          const { workspace } = resolveCallContext(ctx, exec)
          const nodeId = requireId(args?.nodeId, 'nodeId', '请提供节点 id。')
          const title = requireText(args?.title, 'title', '请提供条件标题。')

          const before = readGraph(store, workspace)
          const beforeNode = findNode(before, nodeId)
          const beforeIds = new Set(
            (Array.isArray(beforeNode?.conditions) ? beforeNode.conditions : []).map((item) => item?.id),
          )
          const applied = await applyAction(ctx, store, workspace, {
            action: 'add-condition',
            expectedRevision: revisionOf(before),
            payload: { nodeId, title },
          })
          const graph = appliedGraph(applied, store, workspace)
          const node = findNode(graph, nodeId)
          const result = applied?.result
          const conditions = Array.isArray(node?.conditions) ? node.conditions : []
          const created = conditions.find((item) => !beforeIds.has(item?.id))
            ?? (typeof result?.conditionId === 'string'
              ? conditions.find((item) => item?.id === result.conditionId)
              : undefined)
            ?? (result?.condition !== null && typeof result?.condition === 'object' ? result.condition : undefined)
          const conditionId = typeof result?.conditionId === 'string'
            ? result.conditionId
            : (typeof created?.id === 'string' ? created.id : '')
          const conditionTitle = typeof created?.title === 'string' ? created.title : title

          return {
            nodeId,
            nodeTitle: typeof node?.title === 'string'
              ? node.title
              : (typeof beforeNode?.title === 'string' ? beforeNode.title : ''),
            conditionId,
            condition: conditionId === '' ? null : { id: conditionId, title: conditionTitle },
            revision: revisionOf(graph),
          }
        } catch (error) {
          throw toolFailure(error)
        }
      },
    },

    {
      name: 'graph_attach_session',
      description: '把当前会话挂到指定的任务节点，成为该节点最新的一段会话。节点已有其他进行中的会话时会拒绝，需要在界面里交接。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: NODE_ID,
        },
        required: ['nodeId'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['nodeId', 'sessionId', 'slot', 'attached', 'node', 'revision', 'progress'],
          properties: {
            nodeId: { type: 'string' },
            sessionId: { type: 'string' },
            slot: { type: 'integer' },
            attached: { type: 'boolean' },
            node: { ...NODE_BRIEF_SCHEMA, type: ['object', 'null'] },
            revision: { type: 'integer' },
            progress: PROGRESS_SCHEMA,
          },
        },
        render: safeRender(renderAttachText, '已挂接会话。'),
      },
      execute: async (args, exec) => {
        try {
          const { workspace, sessionId } = resolveCallContext(ctx, exec)
          const nodeId = requireId(args?.nodeId, 'nodeId', '请提供节点 id。')

          const before = readGraph(store, workspace)
          const node = findNode(before, nodeId)
          if (node === undefined) {
            throw new TaskDagError(CODES.notFound, '没有找到这个任务节点。', { status: 404 })
          }

          const owner = typeof sessionOwner === 'function' ? sessionOwner(before, sessionId) : null
          if (typeof owner === 'string' && owner !== '' && owner !== nodeId) {
            throw new TaskDagError(CODES.sessionClaimed, '这个会话已经挂在别的任务节点上。', { status: 409 })
          }

          const active = typeof activeSession === 'function' ? activeSession(node) : undefined
          if (active !== undefined && active !== null && active.sessionId !== sessionId) {
            throw new TaskDagError(
              CODES.sessionClaimed,
              '该节点已有进行中的会话，请先在界面里交接，再来挂接。',
              { status: 409 },
            )
          }

          const applied = await applyAction(ctx, store, workspace, {
            action: 'attach-session',
            expectedRevision: revisionOf(before),
            payload: { nodeId, sessionId, titleSnapshot: node.title, makeActive: true },
          })
          const graph = appliedGraph(applied, store, workspace)
          const updated = findNode(graph, nodeId)
          const record = (Array.isArray(updated?.sessions) ? updated.sessions : [])
            .find((session) => session?.sessionId === sessionId)

          return {
            nodeId,
            sessionId,
            slot: Number.isInteger(record?.slot) ? record.slot : 0,
            attached: true,
            node: updated === undefined ? null : nodeBrief(updated),
            revision: revisionOf(graph),
            progress: normalizeProgress(derive(graph)?.progress, graph),
          }
        } catch (error) {
          throw toolFailure(error)
        }
      },
    },
  ]
}

/**
 * Register every Agent tool. Returns one disposer for all registrations.
 *
 * @param {object} ctx host context (needs `tools`)
 * @param {{store: object}} options
 */
export function registerTools(ctx, options = {}) {
  const store = options?.store
  if (store === null || typeof store !== 'object' || typeof store.read !== 'function') {
    throw new TaskDagError(CODES.hostUnavailable, '图存储不可用，Agent 工具没有注册。')
  }

  const tools = ctx?.tools
  if (tools === null || typeof tools !== 'object' || typeof tools.register !== 'function') {
    console.error('[dsh-task-dag] tools 服务不可用，Agent 工具没有注册')
    return () => {}
  }

  const disposers = []
  try {
    for (const definition of buildToolDefinitions(ctx, store)) {
      const registration = tools.register(definition)
      if (typeof registration === 'function') {
        disposers.push(registration)
      } else if (registration !== null && typeof registration === 'object'
        && typeof registration.dispose === 'function') {
        disposers.push(() => registration.dispose())
      }
    }
  } catch (error) {
    disposeAll(disposers, '[dsh-task-dag] 回滚 Agent 工具注册失败')
    throw error
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    disposeAll(disposers, '[dsh-task-dag] 注销 Agent 工具失败')
  }
}

function disposeAll(disposers, message) {
  for (let index = disposers.length - 1; index >= 0; index -= 1) {
    try {
      disposers[index]()
    } catch (error) {
      console.error(message, error)
    }
  }
}
