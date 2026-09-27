import { MiraError } from "./error.ts"

export type Fetch = (input: string, init: RequestInit) => Promise<Response>

export const SDK = "mirafive-server/0.5.0"

export const trimHost = (host: string): string => {
  if (!/^https?:\/\/[^/]/.test(host)) {
    throw new TypeError(`host needs a scheme: ${host}`)
  }

  return host.replace(/\/+$/, "")
}

const codes: Record<number, string> = {
  401: "unauthorized",
  408: "timeout",
  413: "payload_too_large",
  429: "rate_limited"
}

/** One request with a timeout, resolving with the parsed body. Every failure is a MiraError. */
export const call = async <T = unknown>(
  fetch: Fetch | undefined,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<readonly [Response, T | undefined]> => {
  const controller = new AbortController()
  const abort = (): void => {
    controller.abort()
  }
  const timer = setTimeout(abort, timeoutMs)
  let response: Response
  let body: T | undefined

  signal?.addEventListener("abort", abort)

  try {
    if (signal?.aborted) {
      throw signal.reason
    }

    response = await (fetch ?? globalThis.fetch)(url, { ...init, signal: controller.signal })
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the server's answer follows the protocol
    body = (await response.json().catch(() => undefined)) as T | undefined
  } catch (cause) {
    const code = signal?.aborted ? "aborted" : controller.signal.aborted ? "timeout" : "network_error"

    throw new MiraError(code, `${code}: ${String(cause)}`, { cause })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }

  const { status } = response

  if (response.ok || status === 304) {
    return [response, body]
  }

  const answer: { code?: unknown; detail?: unknown; errors?: [] } = body ?? {}
  const code = typeof answer.code === "string" ? answer.code : (codes[status] ?? "unexpected")
  const header = response.headers.get("Retry-After") ?? ""
  const seconds = header ? +header : Number.NaN
  const retryAfterMs = seconds >= 0 ? seconds * 1000 : Date.parse(header) - Date.now()

  throw new MiraError(code, `${status} ${code}: ${typeof answer.detail === "string" ? answer.detail : ""}`, {
    status,
    retryAfterMs: Number.isNaN(retryAfterMs) ? undefined : Math.max(0, retryAfterMs),
    errors: answer.errors
  })
}
