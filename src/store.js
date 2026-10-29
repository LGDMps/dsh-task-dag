/**
 * Durable graph documents.
 *
 * The store is the only module that touches `.dsh-task-graph/`. It owns four
 * guarantees the rest of the Host relies on:
 *
 *  - every write is a compare-and-swap on `revision`, so two browser windows
 *    (or an Agent tool and the UI) can never silently overwrite each other;
 *  - writes are serialized per graph file inside this process, so a commit never
 *    reads a half-written revision;
 *  - `graph.json` is replaced atomically (tmp + fsync + rename) and the audit
 *    line is appended first, so a crash leaves either the old or the new file;
 *  - a corrupt document never takes the plugin down: it is quarantined next to
 *    the original and the caller gets an empty graph plus a warning.
 *
 * Disk is authoritative. The in-memory cache only saves re-parsing on repeated
 * reads; `commit` always re-reads from disk before checking the revision.
 */
import { CODES, TaskDagError } from './errors.js'
import { SCHEMA_VERSION, assertInvariants, cloneGraph, emptyGraph, normalizeGraph, nowIso } from './model.js'
import * as nodeFs from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const MAX_WARNINGS = 20

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class GraphStore {
  /**
   * @param {{dirFor?: (workspace: object) => string, fs?: object}} [options]
   *   `fs` is a partial override of `node:fs`; tests use it to inject failures.
   */
  constructor(options = {}) {
    this.dirFor = typeof options.dirFor === 'function'
      ? options.dirFor
      : (workspace) => join(workspace.path, '.dsh-task-graph')
    this.fs = { ...nodeFs, ...(options.fs ?? {}) }
    /** @type {Map<string, {graph: object, missing: boolean}>} */
    this.cache = new Map()
    /** @type {Map<string, string[]>} */
    this.warnings = new Map()
    /** @type {Map<string, Promise<void>>} promise-chain tail per graph file */
    this.queues = new Map()
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map()
  }

  /** Absolute path of the graph document for a workspace. */
  pathFor(workspace) {
    return resolve(this.#dirFor(workspace), 'graph.json')
  }

  /**
   * Load for reading. A missing file is not an error: it is an empty graph at
   * revision 0, so the first commit is an ordinary CAS from 0.
   */
  read(workspace) {
    const path = this.pathFor(workspace)
    const entry = this.#load(workspace, path, false)
    return {
      graph: cloneGraph(entry.graph),
      path,
      eventsPath: this.#eventsPath(path),
      missing: entry.missing,
      warnings: [...(this.warnings.get(path) ?? [])],
    }
  }

  /**
   * Serialized compare-and-swap commit.
   *
   * `produce(currentGraph)` returns `{next, event?}`. The revision bump, graph
   * timestamp and workspace identity are the store's job, never the producer's;
   * a stale `expectedRevision` throws `revision-conflict` (409) with the current
   * revision in `details.current`.
   *
   * @param {{workspaceId: string, path: string, title: string}} workspace
   * @param {number} expectedRevision
   * @param {(current: object) => {next: object, event?: {type?: string, data?: unknown}}} produce
   * @returns {Promise<object>} the committed graph
   */
  async commit(workspace, expectedRevision, produce) {
    if (typeof produce !== 'function') {
      throw new TaskDagError(CODES.invalidRequest, 'commit 需要 produce 回调。', {
        details: { field: 'produce' },
      })
    }
    const path = this.pathFor(workspace)
    const run = () => this.#commit(workspace, path, expectedRevision, produce)
    const previous = this.queues.get(path) ?? Promise.resolve()
    // Chain on both outcomes: a rejected commit must not wedge the queue, but
    // the caller still sees its own rejection.
    const result = previous.then(run, run)
    const tail = result.then(() => undefined, () => undefined)
    this.queues.set(path, tail)
    void tail.then(() => {
      if (this.queues.get(path) === tail) this.queues.delete(path)
    })
    return result
  }

  /** Subscribe to successful commits. Returns an unsubscribe function. */
  subscribe(workspace, listener) {
    if (typeof listener !== 'function') {
      throw new TaskDagError(CODES.invalidRequest, 'subscribe 需要 listener 函数。', {
        details: { field: 'listener' },
      })
    }
    const path = this.pathFor(workspace)
    let listeners = this.listeners.get(path)
    if (listeners === undefined) {
      listeners = new Set()
      this.listeners.set(path, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0 && this.listeners.get(path) === listeners) {
        this.listeners.delete(path)
      }
    }
  }

  // ---------------------------------------------------------------- internals

  #dirFor(workspace) {
    if (!isRecord(workspace) || typeof workspace.path !== 'string' || workspace.path.trim() === '') {
      throw new TaskDagError(CODES.invalidRequest, '工作区缺少 path，无法定位任务图。', {
        details: { workspaceId: workspace?.workspaceId ?? null },
      })
    }
    const dir = this.dirFor(workspace)
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new TaskDagError(CODES.invalidRequest, 'dirFor 必须返回任务图目录。', {
        details: { workspaceId: workspace.workspaceId ?? null },
      })
    }
    return dir
  }

  #eventsPath(graphPath) {
    return join(dirname(graphPath), 'events.jsonl')
  }

  #emptyFor(workspace) {
    return emptyGraph({
      workspaceId: typeof workspace.workspaceId === 'string' ? workspace.workspaceId : '',
      workspacePath: workspace.path,
      title: typeof workspace.title === 'string' ? workspace.title : '',
    })
  }

  #warn(path, message) {
    const list = this.warnings.get(path) ?? []
    list.push(message)
    if (list.length > MAX_WARNINGS) list.splice(0, list.length - MAX_WARNINGS)
    this.warnings.set(path, list)
  }

  /** Cached entry, or load from disk. `force` is used by commit to trust disk. */
  #load(workspace, path, force) {
    if (!force) {
      const cached = this.cache.get(path)
      if (cached !== undefined) return cached
    }
    return this.#readDisk(workspace, path)
  }

  #readDisk(workspace, path) {
    let text
    try {
      text = this.fs.readFileSync(path, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Unreadable is not parseable: report once and keep the plugin usable.
        this.#warn(path, `graph.json 无法读取（${error?.code ?? error?.message}），本次按空图处理。`)
      }
      const entry = { graph: this.#emptyFor(workspace), missing: true }
      this.cache.set(path, entry)
      return entry
    }

    try {
      const graph = normalizeGraph(JSON.parse(text))
      const entry = { graph, missing: false }
      this.cache.set(path, entry)
      return entry
    } catch (error) {
      // A newer document is not corrupt: quarantining it would throw away data
      // this build does not understand, so refuse instead of silently replacing.
      if (error instanceof TaskDagError && error.code === CODES.unsupportedVersion) throw error
      return this.#quarantine(workspace, path, error)
    }
  }

  /** Move the unusable document aside and continue from an empty graph. */
  #quarantine(workspace, path, cause) {
    // ISO timestamps contain ':' and '.', which Windows file names reject.
    const stamp = nowIso().replace(/[:.]/g, '-')
    const target = `${path}.corrupt-${stamp}-${process.pid}`
    let message = `graph.json 已损坏（${cause?.message ?? String(cause)}），已隔离为 ${target} 并按空图继续。`
    let moved = false
    try {
      this.fs.renameSync(path, target)
      moved = true
    } catch (renameError) {
      message = `graph.json 已损坏（${cause?.message ?? String(cause)}），且隔离失败（${renameError?.code ?? renameError?.message}）；本次按空图处理，原文件未被移动。`
    }
    this.#warn(path, message)
    const entry = { graph: this.#emptyFor(workspace), missing: moved }
    this.cache.set(path, entry)
    return entry
  }

  async #commit(workspace, path, expectedRevision, produce) {
    const fs = this.fs
    const current = this.#load(workspace, path, true).graph

    // Every write must name the revision it was derived from; that is the whole
    // point of CAS and also protects callers that forget the argument.
    if (expectedRevision !== current.revision) {
      throw new TaskDagError(
        CODES.revisionConflict,
        `任务图已被其他窗口修改（当前版本 ${current.revision}，提交基于 ${String(expectedRevision)}），请刷新后重试。`,
        { status: 409, details: { current: current.revision, expected: expectedRevision ?? null } },
      )
    }

    // The producer gets a copy: a handler that mutates its argument in place
    // must not be able to corrupt the cache when later validation fails.
    const outcome = await produce(cloneGraph(current))
    if (!isRecord(outcome) || !isRecord(outcome.next)) {
      throw new TaskDagError(CODES.invariant, 'commit 的 produce 必须返回 {next: 图对象}。', {
        details: { received: outcome === null ? 'null' : typeof outcome },
      })
    }

    const next = outcome.next
    next.revision = current.revision + 1
    next.updatedAt = nowIso()
    // Identity follows the workspace: the document lives at a workspace-scoped
    // path, so ids cached inside it must not outlive a move/rename.
    next.workspaceId = typeof workspace.workspaceId === 'string' ? workspace.workspaceId : ''
    next.workspacePath = workspace.path
    if (!next.title) next.title = typeof workspace.title === 'string' ? workspace.title : ''
    next.schemaVersion = SCHEMA_VERSION

    // Validate before any byte reaches disk: readers trust the file.
    assertInvariants(next)

    let serialized
    try {
      serialized = `${JSON.stringify(next, null, 2)}\n`
    } catch (error) {
      throw new TaskDagError(CODES.invariant, `任务图无法序列化为 JSON：${error?.message ?? error}`, {
        details: { reason: 'not-serializable' },
      })
    }

    const dir = dirname(path)
    fs.mkdirSync(dir, { recursive: true })

    // Audit line first: it is allowed to be lost (warning), never to block the
    // commit — a missing audit entry must not make the graph unwritable.
    const event = isRecord(outcome.event) ? outcome.event : {}
    try {
      const line = JSON.stringify({
        at: next.updatedAt,
        type: typeof event.type === 'string' && event.type !== '' ? event.type : 'commit',
        revision: next.revision,
        workspaceId: next.workspaceId,
        data: event.data ?? null,
      })
      fs.appendFileSync(this.#eventsPath(path), `${line}\n`, 'utf8')
    } catch (error) {
      this.#warn(path, `events.jsonl 追加失败（${error?.code ?? error?.message}），图已提交但审计记录缺失。`)
    }

    this.#writeAtomic(path, serialized)
    this.cache.set(path, { graph: cloneGraph(next), missing: false })
    this.#notify(path, next)
    return next
  }

  /** tmp file -> fsync -> rename. The directory fsync is best effort (Windows). */
  #writeAtomic(path, text) {
    const fs = this.fs
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 10)}`
    try {
      fs.writeFileSync(tmp, text, 'utf8')
      const fd = fs.openSync(tmp, 'r+')
      try {
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, path)
    } catch (error) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        // The tmp file may never have been created.
      }
      throw error
    }
    this.#fsyncDir(dirname(path))
  }

  #fsyncDir(dir) {
    try {
      const fd = this.fs.openSync(dir, 'r')
      try {
        this.fs.fsyncSync(fd)
      } finally {
        this.fs.closeSync(fd)
      }
    } catch {
      // Windows cannot fsync a directory handle; rename is still atomic there.
    }
  }

  #notify(path, graph) {
    const listeners = this.listeners.get(path)
    if (listeners === undefined || listeners.size === 0) return
    const payload = { workspaceId: graph.workspaceId ?? '', revision: graph.revision }
    for (const listener of [...listeners]) {
      try {
        listener({ ...payload })
      } catch (error) {
        // A dead SSE client must never fail someone else's commit.
        console.error('[dsh-task-dag] store subscriber failed', error)
      }
    }
  }
}
