// Vendored from mirafive/protocol b1346ccb992a. Do not edit; run bun run vendor:protocol.
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
  | "payload_too_large"
  | "rate_limited"
  | "sink_unavailable"

export interface ErrorBody {
  readonly code: ErrorCode | (string & {})
  readonly detail: string
  readonly errors?: readonly { readonly path: string; readonly message: string }[]
}
