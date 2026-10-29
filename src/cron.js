/**
 * Dependency-free 5-field cron parsing and next-run computation.
 *
 * Grammar: five whitespace-separated fields — minute hour day-of-month month
 * day-of-week. Every field supports the wildcard, step (wildcard or
 * range + `/n`), single value, inclusive range `a-b`, and comma lists mixing
 * any of those. Ranges: minutes 0-59, hours 0-23, days 1-31, months 1-12,
 * weekdays 0-7 (0 and 7 both mean Sunday). When both the day and weekday
 * fields are restricted they combine with OR semantics (standard cron).
 *
 * The rules deliberately match the DSH task board's `core/schedule.ts` so a
 * cron expression means the same thing in both plugins. `nextRunAtMs` walks
 * candidate wall-clock fields instead of scanning every minute, but constructs
 * every candidate through the local-timezone `Date` constructor and re-checks
 * it with the same `matches` gate, so DST behaviour stays identical to a
 * minute-by-minute scan: nonexistent spring-forward minutes normalize forward
 * and the repeated fall-back hour is visited only once.
 *
 * This module has no imports and no I/O, so the scheduler and tests can share
 * one definition of "next run".
 */

/** Inclusive ranges per field, in cron order. */
const FIELD_RANGES = [
  [0, 59], // minutes
  [0, 23], // hours
  [1, 31], // days
  [1, 12], // months
  [0, 7], // weekdays (7 = Sunday, normalized below)
]

/** Largest calendar day per month; February keeps 29 to stay leap-aware. */
const MAX_DAY_BY_MONTH = new Map([
  [1, 31], [2, 29], [3, 31], [4, 30], [5, 31], [6, 30],
  [7, 31], [8, 31], [9, 30], [10, 31], [11, 30], [12, 31],
])

const FIVE_YEAR_HORIZON_MS = 5 * 366 * 24 * 60 * 60 * 1000

/**
 * Parse one 5-field cron expression.
 *
 * @param {string} expr
 * @returns {{minutes: Set<number>, hours: Set<number>, days: Set<number>,
 *   months: Set<number>, weekdays: Set<number>, dayWildcard: boolean,
 *   weekdayWildcard: boolean} | null} the match sets, or null when invalid
 */
export function parseCron(expr) {
  if (typeof expr !== 'string') return null
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null

  const sets = []
  for (let index = 0; index < 5; index += 1) {
    const [min, max] = FIELD_RANGES[index]
    const set = new Set()
    if (!parseField(fields[index], min, max, set)) return null
    sets.push(set)
  }

  // Normalize 7 to 0 so `weekdays.has(date.getDay())` works directly.
  const weekdays = new Set()
  for (const day of sets[4]) weekdays.add(day === 7 ? 0 : day)

  return {
    minutes: sets[0],
    hours: sets[1],
    days: sets[2],
    months: sets[3],
    weekdays,
    // Only a literal '*' marks the field unrestricted: an explicit full
    // enumeration such as '1-31' is restricted and participates in the
    // day/weekday OR semantics.
    dayWildcard: fields[2] === '*',
    weekdayWildcard: fields[4] === '*',
  }
}

/** Whether a cron expression parses. Never throws. */
export function isValidCron(expr) {
  return parseCron(expr) !== null
}

/**
 * The next matching instant strictly after `fromMs`, at minute granularity.
 *
 * @param {string} expr 5-field cron expression
 * @param {number} fromMs epoch milliseconds
 * @returns {number | undefined} epoch milliseconds of the matching minute's
 *   start, or undefined when the expression is invalid or can never match
 *   within the five-year horizon (for example `0 0 30 2 *`)
 */
export function nextRunAtMs(expr, fromMs) {
  if (typeof fromMs !== 'number' || !Number.isFinite(fromMs)) return undefined
  const schedule = parseCron(expr)
  if (schedule === null) return undefined
  if (!hasPossibleCalendarDay(schedule)) return undefined

  const from = new Date(fromMs)
  const limitMs = fromMs + FIVE_YEAR_HORIZON_MS

  const sortedMinutes = [...schedule.minutes].sort((a, b) => a - b)
  const sortedHours = [...schedule.hours].sort((a, b) => a - b)
  const sortedMonths = [...schedule.months].sort((a, b) => a - b)

  let year = from.getFullYear()
  let month = from.getMonth() + 1
  let day = from.getDate()
  let hour = from.getHours()
  // Strictly after `fromMs`: start at the next wall-clock minute.
  let minute = from.getMinutes() + 1

  while (new Date(year, month - 1, 1, 0, 0, 0, 0).getTime() <= limitMs) {
    for (const candidateMonth of sortedMonths) {
      if (candidateMonth < month) continue
      const daysInMonth = new Date(year, candidateMonth, 0).getDate()
      const dayStart = candidateMonth === month ? day : 1
      for (let candidateDay = dayStart; candidateDay <= daysInMonth; candidateDay += 1) {
        const dayProbe = new Date(year, candidateMonth - 1, candidateDay, 0, 0, 0, 0)
        if (!dayCandidate(schedule, dayProbe)) continue
        const hourStart = candidateMonth === month && candidateDay === day ? hour : 0
        for (const candidateHour of sortedHours) {
          if (candidateHour < hourStart) continue
          const minuteStart = candidateMonth === month && candidateDay === day && candidateHour === hour
            ? minute
            : 0
          for (const candidateMinute of sortedMinutes) {
            if (candidateMinute < minuteStart) continue
            const candidate = new Date(year, candidateMonth - 1, candidateDay, candidateHour, candidateMinute, 0, 0)
            const time = candidate.getTime()
            if (time <= fromMs) continue
            if (time > limitMs) return undefined
            if (matches(schedule, candidate)) return time
          }
        }
      }
    }
    year += 1
    month = 1
    day = 1
    hour = 0
    minute = 0
  }
  return undefined
}

/** Day/weekday OR gate shared by the candidate scan and {@link matches}. */
function dayCandidate(schedule, date) {
  const dayMatches = schedule.days.has(date.getDate())
  const weekdayMatches = schedule.weekdays.has(date.getDay())
  if (schedule.dayWildcard) return weekdayMatches
  if (schedule.weekdayWildcard) return dayMatches
  return dayMatches || weekdayMatches
}

/** Reject impossible month/day pairs without spending the multi-year scan. */
function hasPossibleCalendarDay(schedule) {
  if (schedule.dayWildcard || !schedule.weekdayWildcard) return true
  for (const month of schedule.months) {
    const maximum = MAX_DAY_BY_MONTH.get(month) ?? 0
    for (const day of schedule.days) {
      if (day <= maximum) return true
    }
  }
  return false
}

/** Parse one comma-list field into the match set; false when invalid. */
function parseField(field, min, max, out) {
  if (field === '*') {
    for (let value = min; value <= max; value += 1) out.add(value)
    return true
  }
  for (const part of field.split(',')) {
    if (part === '') return false
    const slash = part.split('/')
    if (slash.length > 2) return false
    const [range, stepRaw] = slash

    let low
    let high
    if (range === '*') {
      low = min
      high = max
    } else if (range.includes('-')) {
      const bounds = range.split('-')
      if (bounds.length !== 2) return false
      const [a, b] = bounds
      if (!isDigits(a) || !isDigits(b)) return false
      low = Number(a)
      high = Number(b)
    } else if (isDigits(range)) {
      low = Number(range)
      high = Number(range)
    } else {
      return false
    }

    if (low < min || high > max || low > high) return false
    const step = stepRaw === undefined ? 1 : isDigits(stepRaw) ? Number(stepRaw) : NaN
    if (!Number.isInteger(step) || step < 1) return false
    for (let value = low; value <= high; value += step) out.add(value)
  }
  return true
}

/** Final re-check of one wall-clock candidate: fields plus day OR semantics. */
function matches(schedule, date) {
  if (!schedule.minutes.has(date.getMinutes())) return false
  if (!schedule.hours.has(date.getHours())) return false
  if (!schedule.months.has(date.getMonth() + 1)) return false
  return dayCandidate(schedule, date)
}

function isDigits(value) {
  return /^\d+$/.test(value)
}
