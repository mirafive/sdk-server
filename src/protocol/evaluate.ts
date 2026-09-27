// Vendored from mirafive/protocol 5037788489cb. Do not edit; run bun run vendor:protocol.
import { BUCKETS, bucket, SHARE_SALT, VARIANT_SALT } from "./hash.ts"
import type { Condition, Evaluation, Facts, Flag, Json, Op } from "./types.ts"

export const LEVEL = 1

export const JUNK_IDS: readonly string[] = [
  "undefined",
  "null",
  "none",
  "nan",
  "0",
  "true",
  "false",
  "anonymous",
  "guest",
  "id",
  "email",
  "distinct_id",
  "distinctid",
  "not_authenticated",
  "[object object]"
]

/** The id unchanged, or undefined for junk, blank or over 256 UTF-16 units. Never truncated. */
export const usable = (id: unknown): string | undefined => {
  if (typeof id !== "string" || id.length > 256) {
    return undefined
  }

  // ASCII-only lowering, as PHP's strtolower does.
  const bare = id
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase())
    .replace(/^[ \t\n\r"']+|[ \t\n\r"']+$/g, "")

  return bare === "" || JUNK_IDS.includes(bare) ? undefined : id
}

const isScalar = (value: Json): value is string | number | boolean =>
  value !== null && typeof value !== "object"

const decimal = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/

const same = (a: Json, b: Json): boolean =>
  typeof a === typeof b
    ? a === b
    : typeof a === "string" && typeof b === "number"
      ? decimal.test(a) && Number(a) === b
      : typeof a === "number" && typeof b === "string" && decimal.test(b) && Number(b) === a

const isAny = (value: Json, listed: readonly Json[]): boolean =>
  (Array.isArray(value) ? (value as readonly Json[]) : [value]).some(
    (item) => isScalar(item) && listed.some((entry) => same(item, entry))
  )

const propertyHolds = (value: Json | undefined, op: Op, expected: Json): boolean => {
  if (value === undefined || value === null) {
    return op === "unset"
  }

  const list = Array.isArray(expected) ? (expected as readonly Json[]) : undefined
  const found = (test: (text: string, entry: string) => boolean): boolean =>
    typeof value === "string" && !!list?.some((entry) => typeof entry === "string" && test(value, entry))

  switch (op) {
    case "is":
      return !!list && isAny(value, list)
    case "not":
      return !!list && (isScalar(value) || Array.isArray(value)) && !isAny(value, list)
    case "has":
      return found((text, entry) => text.includes(entry))
    case "nhas":
      return typeof value === "string" && !!list && !found((text, entry) => text.includes(entry))
    case "pre":
      return found((text, entry) => text.startsWith(entry))
    case "gt":
      return typeof value === "number" && typeof expected === "number" && value > expected
    case "lt":
      return typeof value === "number" && typeof expected === "number" && value < expected
    case "set":
      return true
    default:
      return false
  }
}

const holds = (condition: Condition, facts: Facts): boolean => {
  if (condition[0] === "p") {
    const { properties } = facts

    // Own keys only, so "toString" is missing as it is in PHP.
    return propertyHolds(
      properties && Object.hasOwn(properties, condition[1]) ? properties[condition[1]] : undefined,
      condition[2],
      condition[3]
    )
  }

  const { segments } = facts

  return (
    typeof segments === "object" &&
    !segments.unavailable.includes(condition[1]) &&
    segments.in.includes(condition[1]) !== (condition[2] === 1)
  )
}

export const evaluate = (flag: Flag, facts: Facts): Evaluation => {
  if ((flag.need ?? 1) > LEVEL || flag.r.some((rule) => "x" in rule && ("sh" in rule || "w" in rule))) {
    return { reason: "ERROR", errorCode: "UNSUPPORTED" }
  }

  if (flag.off) {
    return { variant: flag.d, reason: "DISABLED" }
  }

  const unit = usable(flag.u === "p" ? facts.userId : facts.id)

  for (const [rule, entry] of flag.r.entries()) {
    const conditions = entry.if

    if (facts.segments === "pending" && conditions?.some((condition) => condition[0] === "s")) {
      return { reason: "ERROR", errorCode: "NOT_READY" }
    }

    if (conditions && !conditions.every((condition) => holds(condition, facts))) {
      continue
    }

    if ("x" in entry) {
      return { variant: entry.x, reason: conditions ? "TARGETING_MATCH" : "STATIC", rule }
    }

    if (unit !== undefined && bucket(flag.s, SHARE_SALT, unit) < (entry.sh ?? BUCKETS)) {
      let point = bucket(flag.s, VARIANT_SALT, unit)

      for (const [variant, weight] of entry.w ?? []) {
        if ((point -= weight) < 0) {
          return { variant, reason: "SPLIT", rule }
        }
      }
    }

    return { variant: flag.d, reason: "DEFAULT", rule }
  }

  return { variant: flag.d, reason: "DEFAULT" }
}
