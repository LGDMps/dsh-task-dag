/**
 * Per-session system prompt section for the `dsh-task-dag` plugin.
 *
 * When the assembling session is attached to a graph node, every turn gets a
 * short reminder of where the session sits in the project DAG: the node, its
 * prerequisite conditions, what finishing it unlocks, and the standing
 * instruction to keep the node's task description current as the user adds
 * requirements. Everything else returns an empty string so unattached sessions
 * are untouched.
 *
 * The section callback runs inside prompt assembly, where a throwing callback
 * would break the turn: it therefore never throws and never assumes the
 * assemble payload has a particular shape.
 */
import { CODES, TaskDagError } from './errors.js'
import { conditionsOf, findNode, satisfiersOf, successorsOf } from './model.js'
import { workspaceForSession } from './workspaces.js'

/** Section identity in the prompt assembler. */
export const PROMPT_SECTION_NAME = 'task-dag.node'

/** Placement: after the core identity sections, before tool-specific hints. */
export const PROMPT_SECTION_ORDER = 55

const STATUS_LABELS = Object.freeze({
  planned: '待规划',
  todo: '待开始',
  doing: '进行中',
  done: '已完成',
  failed: '已失败',
})

function statusLabel(status) {
  return STATUS_LABELS[status] ?? String(status ?? '')
}

/**
 * Candidate session ids, most specific first.
 *
 * `assemble.scope` is the agent the prompt is being assembled for; depending on
 * the caller it is the scope key string or an object. Fall back to the agent
 * fields before giving up.
 */
export function scopeSessionCandidates(assemble) {
  const candidates = []
  const seen = new Set()
  const push = (value) => {
    if (typeof value !== 'string') return
    const id = value.trim()
    if (id === '' || seen.has(id)) return
    seen.add(id)
    candidates.push(id)
  }

  if (typeof assemble === 'string') {
    push(assemble)
    return candidates
  }
  if (assemble === null || typeof assemble !== 'object') return candidates

  const scope = assemble.scope
  if (typeof scope === 'string') push(scope)
  else if (scope !== null && typeof scope === 'object') {
    push(scope.id)
    push(scope.sessionId)
    push(scope.session?.id)
  }

  push(assemble.sessionId)
  push(assemble.agent?.id)
  push(assemble.agent?.session?.id)
  push(assemble.agentId)

  return candidates
}

/** The node whose session chain contains `sessionId`, if any. */
function findAttachedNode(graph, sessionId) {
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    for (const session of Array.isArray(node?.sessions) ? node.sessions : []) {
      if (session?.sessionId === sessionId) return node
    }
  }
  return undefined
}

function titlesOf(list) {
  return list.map((node) => node.title).filter((title) => typeof title === 'string' && title !== '')
}

/**
 * A condition is satisfied when at least one node linked to it is `done`
 * (ANY semantics); an unlinked condition cannot be satisfied yet.
 */
function conditionStates(graph, node) {
  return conditionsOf(graph, node.id).map((condition) => {
    const linked = satisfiersOf(graph, node.id, condition.id)
      .map((edge) => findNode(graph, edge.from))
      .filter((linkedNode) => linkedNode !== undefined)
    return {
      title: condition.title,
      satisfied: linked.some((linkedNode) => linkedNode.status === 'done'),
    }
  })
}

/**
 * Render the exact node-context lines for one session. Returns `''` when the
 * session is not attached to a node or its graph cannot be read.
 *
 * @param {object} ctx host context (workspace registry)
 * @param {{read: Function}} store graph store
 * @param {string} sessionId
 */
export function renderNodeSection(ctx, store, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return ''

  const workspace = workspaceForSession(ctx, sessionId)
  if (workspace === undefined) return ''

  const graph = store.read(workspace)?.graph
  const node = findAttachedNode(graph, sessionId)
  if (node === undefined) return ''

  const conditions = conditionStates(graph, node)
  const satisfiedCount = conditions.filter((condition) => condition.satisfied).length
  const unsatisfied = conditions.filter((condition) => !condition.satisfied)

  const unlocked = [...new Set(
    successorsOf(graph, node.id)
      .map((edge) => findNode(graph, edge.to))
      .filter((successor) => successor !== undefined),
  )]

  const first = `本会话挂在任务节点「${node.title}」（状态：${statusLabel(node.status)}）。`
  const second = unsatisfied.length === 0
    ? `前置条件：${satisfiedCount}/${conditions.length} 已满足。`
    : `前置条件：${satisfiedCount}/${conditions.length} 已满足 - 未满足：${titlesOf(unsatisfied).join('、')}。`
  const third = `完成后解锁：${unlocked.length === 0 ? '无' : titlesOf(unlocked).join('、')}。`
  // The task description is the node's durable brief. Conversations keep
  // producing new requirements, so every turn reminds the agent to fold them
  // back into the node instead of leaving them buried in the transcript.
  const fourth = '任务描述维护：用户提出新的需求、约束或完成标准时，及时调用 graph_update_node '
    + '把本节点的任务描述更新为当前完整版本（保留仍然有效的内容）。'

  return [first, second, third, fourth].join('\n')
}

/**
 * Register the prompt section. Returns its disposer.
 *
 * @param {object} ctx host context (needs `systemPrompt`)
 * @param {{store: object}} options
 */
export function registerPromptSection(ctx, options = {}) {
  const store = options?.store
  if (store === null || typeof store !== 'object' || typeof store.read !== 'function') {
    throw new TaskDagError(CODES.hostUnavailable, '图存储不可用，提示段落没有注册。')
  }

  const systemPrompt = ctx?.systemPrompt
  if (systemPrompt === null || typeof systemPrompt !== 'object'
    || typeof systemPrompt.section !== 'function') {
    console.error('[dsh-task-dag] systemPrompt 服务不可用，提示段落没有注册')
    return () => {}
  }

  const registration = systemPrompt.section({
    name: PROMPT_SECTION_NAME,
    order: PROMPT_SECTION_ORDER,
    text: (assemble) => {
      try {
        for (const sessionId of scopeSessionCandidates(assemble)) {
          const text = renderNodeSection(ctx, store, sessionId)
          if (text !== '') return text
        }
      } catch (error) {
        console.error('[dsh-task-dag] 生成节点提示失败', error)
      }
      return ''
    },
  })

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    try {
      if (typeof registration === 'function') registration()
      else if (registration !== null && typeof registration === 'object'
        && typeof registration.dispose === 'function') {
        registration.dispose()
      }
    } catch (error) {
      console.error('[dsh-task-dag] 注销提示段落失败', error)
    }
  }
}
