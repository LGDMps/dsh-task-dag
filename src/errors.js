/**
 * Shared error type for the task-DAG plugin. Every layer throws this so the
 * HTTP route and the Agent tools can map one failure model onto both
 * transports without translation tables.
 */

/** Error codes used across the plugin. */
export const CODES = {
  invalidRequest: 'invalid-request',
  notFound: 'not-found',
  revisionConflict: 'revision-conflict',
  cycle: 'cycle',
  invariant: 'invariant',
  invalidGraph: 'invalid-graph',
  methodNotAllowed: 'method-not-allowed',
  forbidden: 'forbidden',
  sessionNotFound: 'session-not-found',
  sessionClaimed: 'session-claimed',
  unsupportedVersion: 'unsupported-version',
  hostUnavailable: 'host-unavailable',
}

export class TaskDagError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {string} message human-readable reason, safe to show a user
   * @param {{status?: number, details?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'TaskDagError'
    this.code = code
    this.status = typeof options.status === 'number' ? options.status : 400
    this.details = options.details
  }
}

/** True when a value is a TaskDagError (survives bundling and duplicate copies). */
export function isTaskDagError(value) {
  return value instanceof TaskDagError
    || (typeof value === 'object' && value !== null
      && value.name === 'TaskDagError'
      && typeof value.code === 'string')
}

/** Coerce any thrown value into a TaskDagError without losing its message. */
export function asTaskDagError(error) {
  if (isTaskDagError(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  return new TaskDagError(CODES.invalidRequest, message, { details: { cause: message } })
}
