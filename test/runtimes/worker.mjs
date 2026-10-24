import * as sdk from "../../dist/index.js"
import { smoke } from "./smoke.mjs"

// One client per isolate, as the README recommends for Workers.
let shared

export async function reuse(url, ctx) {
  const host = url.searchParams.get("host")
  const user = url.searchParams.get("user")

  shared ??= new sdk.Mira({ key: "mf_smoke000_reuse", host })
  shared.track("page", { userId: user })
  ctx.waitUntil(shared.flush())

  return user
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
        await smoke(sdk, url.searchParams.get("host"), "workerd", (promise) => ctx.waitUntil(promise))
      )
    } catch (error) {
      return new Response(String(error?.stack ?? error), { status: 500 })
    }
  }
}
