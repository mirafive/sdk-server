// Vendored from mirafive/protocol 5037788489cb. Do not edit; run bun run vendor:protocol.
export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json }

export type Mode = "consentless" | "full"

export interface Page {
  readonly url?: string
  readonly title?: string
  readonly referrer?: string
}

export interface Context {
  readonly sdk?: string
  readonly locale?: string
  readonly timezone?: string
  readonly screen?: readonly [width: number, height: number]
}

export interface Event {
  readonly name: string
  readonly time?: number
  readonly id?: string
  readonly page?: Page
  readonly properties?: { readonly [key: string]: Json }
  readonly anonymousId?: string
  readonly userId?: string
  readonly sessionId?: string
}

export interface Batch {
  readonly v: 1
  readonly batch: string
  readonly mode: Mode
  readonly sentAt?: number
  readonly context?: Context
  readonly events: readonly Event[]
}

export type DropReason = "bot" | "install_check" | "ingestion_paused" | "allowance_exhausted"

export interface Receipt {
  readonly batch: string
  readonly accepted: number
  readonly dropped: number
  readonly reason?: DropReason
}

export type ErrorCode =
  | "invalid_json"
  | "validation_failed"
  | "collection_mode_not_allowed"
  | "unauthorized"
  | "origin_not_allowed"
  | "website_key_as_bearer"
  | "secret_key_in_path"
  | "secret_key_exposed"
  | "lookup_not_allowed"
  | "invalid_units"
  | "too_many_units"
  | "not_found"
  | "payload_too_large"
  | "rate_limited"
  | "sink_unavailable"

export interface ErrorBody {
  readonly code: ErrorCode | (string & {})
  readonly detail: string
  readonly errors?: readonly { readonly path: string; readonly message: string }[]
}

export type Op = "is" | "not" | "has" | "nhas" | "pre" | "gt" | "lt" | "set" | "unset"

export type Condition = readonly ["p", string, Op, Json] | readonly ["s", string] | readonly ["s", string, 1]

export type Rule =
  | { readonly if?: readonly Condition[]; readonly x: string }
  | {
      readonly if?: readonly Condition[]
      readonly sh?: number
      readonly w?: readonly (readonly [string, number])[]
    }

export interface Flag {
  readonly s: string
  readonly t: "b" | "m" | "c"
  readonly u: "b" | "p"
  readonly d: string
  readonly p?: { readonly [variant: string]: Json }
  readonly r: readonly Rule[]
  readonly off?: 1
  readonly e?: "r" | "o"
  readonly c?: "b" | "s"
  readonly need?: number
  readonly w?: 1
}

export interface FlagDocument {
  readonly v: 1
  readonly at: number
  readonly flags: { readonly [key: string]: Flag }
  readonly orig?: readonly string[]
}

export type FlagValue = readonly [variant: string, value?: Json]

export interface ValuesDocument {
  readonly v: 1
  readonly at: number
  readonly values: { readonly [key: string]: FlagValue }
  readonly orig?: readonly string[]
}

export interface Bootstrap {
  readonly v: 1
  readonly at: number
  readonly values: { readonly [key: string]: readonly [variant: string, value?: Json, expose?: 1] }
  readonly browser?: readonly string[]
  readonly unit?: string
}

export interface Membership {
  readonly segments: readonly string[]
  readonly unavailable: readonly string[]
  readonly refreshedAt: number | null
  readonly stale: boolean
}

export interface Segments {
  readonly in: readonly string[]
  readonly unavailable: readonly string[]
}

export interface Facts {
  readonly id?: string | undefined
  readonly userId?: string | undefined
  readonly properties?: { readonly [key: string]: Json | undefined } | undefined
  readonly segments?: Segments | "pending" | "unavailable" | undefined
}

export type Reason = "STATIC" | "TARGETING_MATCH" | "SPLIT" | "DEFAULT" | "DISABLED"

export interface Decision {
  readonly variant: string
  readonly reason: Reason
  readonly rule?: number
}

export interface Failure {
  readonly reason: "ERROR"
  readonly errorCode: "UNSUPPORTED" | "NOT_READY"
}

export type Evaluation = Decision | Failure

export interface SnippetEntry {
  readonly k: string
  readonly v: string
  readonly s: string
  readonly w: readonly number[]
  readonly m: "r" | "o"
  readonly h: string
  readonly b: 0 | 1
}
