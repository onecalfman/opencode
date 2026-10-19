import { describe, expect, test } from "bun:test"
import { createPushApi, pushKey, pushScope } from "./push"

describe("push client", () => {
  test("uses server authentication only for management requests", async () => {
    const requests: Request[] = []
    const api = createPushApi(
      { url: "https://backend.example.com/", username: "user", password: "secret" },
      async (url, init) => {
        requests.push(new Request(url, init))
        return Response.json(init?.method === "GET" ? { publicKey: "public-key" } : true)
      },
    )
    const id = "a71521b1-6a87-46b7-a864-7c1d3663bdef"
    expect(await api.configuration()).toEqual({ publicKey: "public-key" })
    await api.remove(id)
    await api.test(id)
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", "https://backend.example.com/api/push"],
      ["DELETE", `https://backend.example.com/api/push/subscriptions/${id}`],
      ["POST", `https://backend.example.com/api/push/subscriptions/${id}/test`],
    ])
    expect(requests.every((request) => request.headers.get("authorization") === `Basic ${btoa("user:secret")}`)).toBe(
      true,
    )
    expect(requests.every((request) => !request.url.includes("secret"))).toBe(true)
  })

  test("rejects failed requests and malformed responses", async () => {
    const unauthorized = createPushApi(
      { url: "https://backend.example.com" },
      async () => new Response(null, { status: 401 }),
    )
    await expect(unauthorized.configuration()).rejects.toThrow("401")
    const invalid = createPushApi({ url: "https://backend.example.com" }, async () =>
      Response.json({ privateKey: "not-public" }),
    )
    await expect(invalid.configuration()).rejects.toThrow()
  })

  test("isolates VAPID registrations per server and decodes URL-safe keys", () => {
    expect(pushScope("https://one.example.com")).not.toBe(pushScope("https://two.example.com"))
    expect(pushScope("https://one.example.com")).toMatch(/^\/_opencode\/push\/[A-Za-z0-9_-]+\/$/)
    expect(Array.from(pushKey("_wAB"))).toEqual([255, 0, 1])
  })
})
