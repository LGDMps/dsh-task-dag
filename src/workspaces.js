/**
 * Workspace resolution for the task-DAG plugin.
 *
 * DSH has no "project" concept: a workspace is the durable entity and sessions
 * are attributed to it by `session.header.cwd === workspace.path`. Everything
 * the plugin does is scoped to one workspace, so this module is the single
 * place that answers "which workspace?" for both transports.
 */
import { CODES, TaskDagError } from './errors.js'
import { getService } from './services.js'

/** Normalize a filesystem path for comparison (Windows is case-insensitive). */
export function normalizePath(value) {
  if (typeof value !== 'string' || value === '') return ''
  let out = value.replace(/[\\/]+/g, '\\').replace(/\\+$/, '')
  if (process.platform === 'win32') out = out.toLowerCase()
  return out
}

/** Project a registry entity onto the shape the plugin passes around. */
function projectWorkspace(entity) {
  if (entity === undefined || entity === null) return undefined
  return {
    workspaceId: String(entity.id ?? entity.workspaceId ?? ''),
    path: String(entity.path ?? ''),
    title: String(entity.title ?? '') || String(entity.path ?? ''),
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    sessionIds: Array.isArray(entity.sessionIds) ? entity.sessionIds.map(String) : [],
  }
}

/** All registered workspaces, in registry order. */
export function listWorkspaces(ctx) {
  const registry = getService(ctx, 'workspaceRegistry')
  if (registry === undefined || registry === null || typeof registry.list !== 'function') return []
  let entities = []
  try {
    entities = registry.list() ?? []
  } catch (error) {
    console.error('[dsh-task-dag] workspaceRegistry.list failed', error)
    return []
  }
  const out = []
  for (const entity of entities) {
    const projected = projectWorkspace(entity)
    if (projected !== undefined && projected.workspaceId !== '') out.push(projected)
  }
  return out
}

/** Look up one workspace by id. */
export function getWorkspace(ctx, workspaceId) {
  const id = String(workspaceId ?? '')
  if (id === '') {
    throw new TaskDagError(CODES.invalidRequest, '缺少 workspaceId。', { details: { field: 'workspaceId' } })
  }
  const found = listWorkspaces(ctx).find((item) => item.workspaceId === id)
  if (found === undefined) {
    throw new TaskDagError(CODES.notFound, `没有找到工作区 ${id}。`, {
      status: 404,
      details: { workspaceId: id },
    })
  }
  return found
}

/** Look up one workspace by id, falling back to an exact path match. */
export function resolveWorkspaceRef(ctx, ref) {
  if (typeof ref === 'string' && ref !== '') {
    const byId = listWorkspaces(ctx).find((item) => item.workspaceId === ref)
    if (byId !== undefined) return byId
    const wanted = normalizePath(ref)
    const byPath = listWorkspaces(ctx).find((item) => normalizePath(item.path) === wanted)
    if (byPath !== undefined) return byPath
    throw new TaskDagError(CODES.notFound, `没有找到工作区 ${ref}。`, {
      status: 404,
      details: { workspaceRef: ref },
    })
  }
  throw new TaskDagError(CODES.invalidRequest, '缺少工作区引用。', { details: { field: 'workspaceId' } })
}

/** The cwd a live session reports, when the session is live in this process. */
function liveSessionCwd(ctx, sessionId) {
  const store = getService(ctx, 'sessions')
  if (store === undefined || store === null || typeof store.get !== 'function') return ''
  try {
    const session = store.get(sessionId)
    return typeof session?.header?.cwd === 'string' ? session.header.cwd : ''
  } catch {
    return ''
  }
}

/**
 * Which workspace a session belongs to: the workspace account first, then the
 * `cwd` fallback for sessions created outside `workspaceId`.
 */
export function workspaceForSession(ctx, sessionId) {
  const id = String(sessionId ?? '')
  if (id === '') return undefined
  const workspaces = listWorkspaces(ctx)
  const accounted = workspaces.find((item) => item.sessionIds.includes(id))
  if (accounted !== undefined) return accounted
  const cwd = normalizePath(liveSessionCwd(ctx, sessionId))
  if (cwd === '') return undefined
  return workspaces.find((item) => normalizePath(item.path) === cwd)
}

export { projectWorkspace }
