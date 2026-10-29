/**
 * Reading Host services without declaring them in the plugin's `inject` list.
 *
 * Cordis installs the plugin context behind a proxy whose `get` trap throws
 * `cannot get property "<name>" without inject` for any service the plugin did
 * not declare. That is the right default for hard dependencies, but two of this
 * plugin's services are genuinely optional: without `typertGateway` the graph
 * still works (sessions just cannot be created or read), and without `sessions`
 * workspace attribution falls back to the registry account.
 *
 * Declaring them in `inject` would make the whole plugin fail to activate in a
 * profile that lacks them, so every optional read goes through `ctx.get(name)`
 * instead: it reads the store "without the inject requirement" and returns
 * `undefined` when nothing provides the service.
 */

/**
 * Read one service from the context, or `undefined` when it is absent.
 *
 * Tries, in order: `ctx.get(name)` (no inject requirement), the reflection
 * layer, then plain property access while guarding the proxy's throw. A service
 * that exists but belongs to an inactive fiber also counts as absent.
 *
 * @param {object} ctx plugin context
 * @param {string} name service name
 * @returns {unknown} the service value, or undefined
 */
export function getService(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined
  if (typeof name !== 'string' || name === '') return undefined

  if (typeof ctx.get === 'function') {
    try {
      const value = ctx.get(name)
      if (value !== undefined && value !== null) return value
    } catch {
      // Fall through: an older/mocked context may not implement `get`.
    }
  }

  let reflect
  try {
    reflect = ctx.reflect
  } catch {
    reflect = undefined
  }
  if (reflect !== null && typeof reflect === 'object' && typeof reflect.get === 'function') {
    try {
      const value = reflect.get(name)
      if (value !== undefined && value !== null) return value
    } catch {
      // Same as above.
    }
  }

  try {
    return ctx[name]
  } catch {
    // The proxy throws for a service this plugin did not inject.
    return undefined
  }
}
