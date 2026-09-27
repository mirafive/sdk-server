import * as flags from "../../dist/flags.js"
import * as sdk from "../../dist/index.js"
import { smoke } from "./smoke.mjs"

// One of each per isolate, as the README recommends for Workers.
let shared

export async function reuse(url, ctx) {
  const host = url.searchParams.get("host")
  const key = "mf_smoke000_reuse"

  shared ??= (() => {
    const mira = new sdk.Mira({ key, host })

    return { mira, flags: new flags.MiraFlags({ key, host, mira }) }
  })()

  const waitUntil = (promise) => ctx.waitUntil(promise)
  const user = await shared.flags.for({ userId: url.searchParams.get("user") }, { waitUntil })

  shared.mira.track("page", { userId: url.searchParams.get("user") })
  ctx.waitUntil(shared.mira.flush())

  return `${user.variant("pricing")} ${user.enabled("checkout")}`
}

// oxlint-disable-next-line import/no-default-export -- the Workers module format
export default {
  async fetch(request, _env, ctx) {
    try {
      const url = new URL(request.url)

      if (url.pathname === "/reuse") {
        return new Response(await reuse(url, ctx))
      }

      return new Response(
        await smoke(sdk, flags, url.searchParams.get("host"), "workerd", (promise) => ctx.waitUntil(promise))
      )
    } catch (error) {
      return new Response(String(error?.stack ?? error), { status: 500 })
    }
  }
}
