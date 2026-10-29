/**
 * Host half of the `dsh-task-dag` bundle.
 *
 * Wiring only: the graph store owns disk state, `src/routes.js` serves the
 * browser half, `src/tools.js` exposes the same operations to agents,
 * `src/prompt.js` injects the node context into attached sessions,
 * `src/description.js` keeps the task description current from user messages,
 * and `src/scheduler.js` runs the per-node timed executions.
 *
 * `sessions` and `typertGateway` are resolved lazily inside `src/sessions.js`
 * so the graph still works in a profile that has no session gateway.
 */
import { GraphStore } from './src/store.js'
import { registerRoutes } from './src/routes.js'
import { registerTools } from './src/tools.js'
import { registerPromptSection } from './src/prompt.js'
import { startDescriptionTracker } from './src/description.js'
import { TaskDagScheduler } from './src/scheduler.js'

export const inject = ['webServer', 'workspaceRegistry', 'tools', 'systemPrompt']

/**
 * Fraction of the context window above which the UI suggests a handoff.
 *
 * Kept as a code constant rather than an exported `Config`: the Loader validates
 * a row's config against a schemastery schema, and this plugin directory cannot
 * resolve `schemastery`, so declaring `Config` here would break activation.
 */
const DEFAULT_HANDOFF_THRESHOLD = 0.6

export function apply(ctx, config) {
  const options = {
    store: new GraphStore(),
    handoffThreshold: typeof config?.handoffThreshold === 'number'
      ? config.handoffThreshold
      : DEFAULT_HANDOFF_THRESHOLD,
  }

  // Each surface is mounted independently and defensively: one failing
  // registration must not take the others (or the whole Host) down, because
  // a plugin that throws while applying is reported to the user as a broken
  // install.
  const surfaces = [
    ['http and sse routes', () => registerRoutes(ctx, options)],
    ['agent tools', () => registerTools(ctx, options)],
    ['prompt section', () => registerPromptSection(ctx, options)],
    // Deterministic fallback for the prompt instruction: user messages in the
    // node's current session are folded into the task description even when the
    // Agent never issues graph_update_node.
    ['task description upkeep', () => startDescriptionTracker(ctx, options.store)],
    // Constructed inside the mount so a broken scheduler is caught by the same
    // per-surface try/catch as the other three; its disposer clears the timers.
    ['scheduled execution', () => new TaskDagScheduler(ctx, options.store).start()],
  ]
  for (const [label, mount] of surfaces) {
    ctx.effect(() => {
      try {
        return mount()
      } catch (error) {
        console.error(`[dsh-task-dag] ${label} failed to register`, error)
        return () => {}
      }
    }, `task-dag: ${label}`)
  }

  console.log('[dsh-task-dag] host half applied')
}