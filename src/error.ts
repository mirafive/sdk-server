import type { ErrorCode } from "./protocol/types.ts"

export type MiraErrorCode =
  | ErrorCode
  | "network_error"
  | "timeout"
  | "aborted"
  | "invalid_event"
  | "unexpected"
  | (string & {})

export interface MiraErrorInit {
  readonly status?: number | undefined
  readonly retryAfterMs?: number | undefined
  readonly errors?: readonly { readonly path: string; readonly message: string }[] | undefined
  readonly cause?: unknown
}

/** Why a delivery or a flag request failed. `retryable` says whether the SDK would try again. */
export class MiraError extends Error {
  override readonly name = "MiraError"
  readonly retryable: boolean
  declare readonly code: MiraErrorCode
  declare readonly status?: number
  declare readonly retryAfterMs?: number
  declare readonly errors?: readonly { readonly path: string; readonly message: string }[]

  constructor(code: MiraErrorCode, message: string, init: MiraErrorInit = {}) {
    super(message, init)
    Object.assign(this, init, { code })

    const { status } = init

    this.retryable = status
      ? status === 408 || status === 429 || status > 499
      : code === "network_error" || code === "timeout"
  }
}
