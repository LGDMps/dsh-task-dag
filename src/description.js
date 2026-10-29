/**
 * Automatic upkeep of a node's task description from the conversation.
 *
 * The per-turn prompt asks the attached Agent to call `graph_update_node` when
 * the user adds requirements, but that depends on the Agent actually issuing the
 * tool call (and on the tool being visible to the session). This tracker is the
 * deterministic fallback: every user message in the node's current session is
 * folded into a marked section at the end of the task description, so new
 * requirements show up in the graph even when the model does nothing.
 *
 * The section is deliberately compact: the last six user requests, one line
 * each, appended to whatever description the human/Agent wrote above it.
 */
import { CODES, TaskDagError } from './errors.js'
import { activeSession, nowIso } from './model.js'
import { textOfEvent } from './sessions.js'
import { listWorkspaces, normalizePath, workspaceForSession } from './workspaces.js'

export const AUTO_DESCRIPTION_HEADING = '## 对话需求（自动记录）'

const MAX_AUTO_ITEMS = 6
const MAX_AUTO_ITEM_CHARS = 280
const MAX_COMMIT_ATTEMPTS = 3
/** Mirrors `MAX_NOTES_CHARS` in ops.js so auto upkeep cannot bypass validation. */
const MAX_NOTES_CHARS = 20000

/** Accepts a requirement-shaped message, ignores briefs/commands/acks. */
const IGNORED_MESSAGES = new Set([
  '好', '好的', '可以', '行', '继续', '嗯', '收到', '谢谢',
  'ok', 'OK', 'Okay', 'okay', 'yes', 'no',
])

function normalizedMessage(value) {
  const text = typeof value === 'string' ? value : ''
  return text.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim()
}

function truncate(text, limit) {
  return text.length <= limit ? text : text.slice(0, limit - 1) + '…'
}

/** Offset of the auto-managed section heading, only when it is its own line. */
function autoHeadingOffset(text) {
  let offset = 0
  for (const line of text.split('\n')) {
    if (line.trim() === AUTO_DESCRIPTION_HEADING) return offset
    offset += line.length + 1
  }
  return -1
}

/**
 * Fold one user message into the auto-maintained section.
 *
 * The text before the heading is preserved byte for byte (minus trailing
 * whitespace); only the section itself is replaced. A repeated last message is
 * a no-op, so duplicate events cannot grow the description.
 *
 * @param {string} notes current task description
 * @param {string} message user message text
 * @returns {string} the new description (or the input when nothing changed)
 */
export function mergeAutoDescription(notes, message) {
  const current = typeof notes === 'string' ? notes : ''
  const clean = normalizedMessage(message)
  if (clean === '' || IGNORED_MESSAGES.has(clean)) return current
  // Plugin-generated handoff/execution briefs are prompts we injected, not new
  // requirements from the user.
  if (clean.startsWith('# 交接简报：') || clean.startsWith('# 定时执行：')) return current
  if (clean.startsWith('/')) return current

  // Match only a standalone heading line: descriptions may legitimately mention
  // the heading inline (for example when documenting this mechanism).
  const headingAt = autoHeadingOffset(current)
  const before = headingAt >= 0 ? current.slice(0, headingAt).trimEnd() : current.trimEnd()
  const existing = []
  if (headingAt >= 0) {
    const body = current.slice(headingAt + AUTO_DESCRIPTION_HEADING.length)
    for (const line of body.split('\n')) {
      const match = /^\s*-\s+(.*)$/.exec(line)
      if (match !== null) {
        const item = match[1].trim()
        if (item !== '') existing.push(item)
      }
    }
  }

  const item = truncate(clean, MAX_AUTO_ITEM_CHARS)
  if (existing.length > 0 && existing[existing.length - 1] === item) return current

  const items = [...existing, item].slice(-MAX_AUTO_ITEMS)
  const section = [AUTO_DESCRIPTION_HEADING, ...items.map((entry) => `- ${entry}`)].join('\n')
  if (section.length >= MAX_NOTES_CHARS) return section.slice(0, MAX_NOTES_CHARS)
  let prefix = before
  const room = MAX_NOTES_CHARS - section.length - 2
  if (prefix.length > room) {
    prefix = room > 0 ? prefix.slice(0, room - 1) + '…' : ''
  }
  return prefix === '' ? section : `${prefix}\n\n${section}`
}

function findAttachedActiveNode(graph, sessionId) {
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    const active = activeSession(node)
    if (active !== undefined && active !== null && active.sessionId === sessionId) return node
  }
  return undefined
}

function workspaceForEvent(ctx, session, sessionId) {
  const resolved = workspaceForSession(ctx, sessionId)
  if (resolved !== undefined && resolved !== null) return resolved
  const cwd = typeof session?.header?.cwd === 'string' ? normalizePath(session.header.cwd) : ''
  if (cwd === '') return undefined
  return listWorkspaces(ctx).find((workspace) => normalizePath(workspace.path) === cwd)
}

function isUserMessage(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'user/message') return false
  const source = event.data?.source
  return source !== null && typeof source === 'object' && source.kind === 'user'
}

/**
 * Handle one `session/event`: update the attached node's description.
 *
 * @returns {Promise<boolean>} whether a description commit was written
 */
export async function handleSessionEvent(ctx, store, session, event) {
  if (!isUserMessage(event)) return false
  if (store === null || typeof store !== 'object') return false
  const sessionId = typeof session?.id === 'string'
    ? session.id
    : typeof session?.header?.id === 'string'
      ? session.header.id
      : ''
  if (sessionId === '') return false

  const message = textOfEvent(event)
  if (normalizedMessage(message) === '') return false
  const workspace = workspaceForEvent(ctx, session, sessionId)
  if (workspace === undefined || workspace === null) return false

  for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
    let graph
    try {
      graph = store.read(workspace).graph
    } catch (error) {
      console.error('[dsh-task-dag] 读取图失败，跳过任务描述自动更新', error)
      return false
    }
    const node = findAttachedActiveNode(graph, sessionId)
    if (node === undefined) return false
    const nextNotes = mergeAutoDescription(node.notes, message)
    if (nextNotes === node.notes) return false

    try {
      await store.commit(workspace, graph.revision, (current) => {
        const target = findAttachedActiveNode(current, sessionId)
        if (target === undefined) return { next: current }
        const merged = mergeAutoDescription(target.notes, message)
        if (merged === target.notes) return { next: current }
        target.notes = merged
        target.updatedAt = nowIso()
        return {
          next: current,
          event: {
            type: 'node/description-auto',
            data: { nodeId: target.id, sessionId, source: 'session-message' },
          },
        }
      })
      return true
    } catch (error) {
      if (error instanceof TaskDagError && error.code === CODES.revisionConflict) continue
      console.error('[dsh-task-dag] 自动更新任务描述失败', error)
      return false
    }
  }
  return false
}

/**
 * Subscribe the tracker to Host session events. Returns its disposer.
 *
 * @param {object} ctx host context (event bus)
 * @param {{read: Function, commit: Function}} store graph store
 */
export function startDescriptionTracker(ctx, store) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.on !== 'function') return () => {}
  let disposed = false
  let dispose = null
  try {
    // `global: true` is required: session events are emitted by the session
    // controller's fiber, and a plain scoped listener only sees events from the
    // plugin's own context.
    dispose = ctx.on('session/event', (session, event) => {
      if (disposed) return
      handleSessionEvent(ctx, store, session, event).catch((error) => {
        console.error('[dsh-task-dag] 自动更新任务描述失败', error)
      })
    }, { global: true })
  } catch (error) {
    console.error('[dsh-task-dag] 无法订阅会话事件，任务描述不会自动更新', error)
    return () => {}
  }
  return () => {
    if (disposed) return
    disposed = true
    if (typeof dispose === 'function') {
      try {
        dispose()
      } catch (error) {
        console.error('[dsh-task-dag] 取消任务描述自动更新订阅失败', error)
      }
    }
  }
}
