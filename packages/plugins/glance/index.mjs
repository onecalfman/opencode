// Native OpenCode V2 plugin. No OpenCode imports are needed at runtime.
// Install the directory containing this file and opencode.mjs as a plugin package.
export default {
  id: "glance",
  async setup(ctx) {
    const url = ctx.options.url ?? process.env.GLANCE_URL
    const token = process.env.GLANCE_WRITE_TOKEN
    const source = ctx.options.source ?? "opencode-couch-pc"
    if (!url || !token) return
    const endpoint = new URL("/api/v1/events", url)
    if (endpoint.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) {
      throw new Error("Glance requires HTTPS except on loopback")
    }
    const controller = new AbortController()
    const saved = (await ctx.storage.get("items")) ?? []
    const items = new Map(saved.map((item) => [item.id, item]))
    let queue = Promise.resolve()
    const save = () => ctx.storage.set("items", [...items.values()].slice(-200))
    const publish = async (item) => {
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(item),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      })
      await response.body?.cancel()
      if (!response.ok) throw new Error(`Glance HTTP ${response.status}`)
    }
    const enqueue = (task) => {
      queue = queue.then(task).catch(() => {
        if (!controller.signal.aborted) console.warn("Glance delivery failed; retrying on heartbeat")
      })
    }
    const reader = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (
          ![
            "session.execution.started",
            "session.execution.succeeded",
            "session.execution.failed",
            "session.execution.interrupted",
            "permission.asked",
            "permission.replied",
            "form.created",
            "form.replied",
            "form.cancelled",
            "session.deleted",
          ].includes(event.type)
        )
          continue
        enqueue(async () => {
          const id = event.data.sessionID ?? event.data.form?.sessionID
          if (!id || id === "global") return
          if (event.type === "session.deleted") {
            const old = items.get(id)
            if (old) await publish({ ...old, state: "idle", reason: "", message: "" })
            items.delete(id)
            await save()
            return
          }
          const session = await ctx.session.get({ sessionID: id })
          // The bus is server-wide, but each plugin instance belongs to one location.
          if (
            session.parentID ||
            session.location.directory !== ctx.location.directory ||
            session.projectID !== ctx.location.project.id
          )
            return
          const old = items.get(id)
          const waits = { ...(old?.waits ?? {}) }
          if (event.type === "permission.asked")
            waits[event.data.id] = { reason: "permission", message: event.data.action }
          if (event.type === "form.created")
            waits[event.data.form.id] = { reason: "question", message: event.data.form.title }
          if (event.type === "permission.replied") delete waits[event.data.requestID]
          if (event.type === "form.replied" || event.type === "form.cancelled")
            delete waits[event.data.formID ?? event.data.id]
          const waiting = Object.values(waits).at(-1)
          const terminal = {
            "session.execution.succeeded": "done",
            "session.execution.failed": "failed",
            "session.execution.interrupted": "idle",
          }[event.type]
          const item = {
            source,
            id,
            category: "agent",
            state: terminal ?? (waiting ? "waiting" : "working"),
            reason: terminal ? "" : (waiting?.reason ?? ""),
            title: (session.title || id).slice(0, 120),
            message: (terminal ? "" : (waiting?.message ?? "")).slice(0, 480),
            ttlSeconds: 120,
            waits: terminal ? {} : waits,
            observed: event.created ?? Date.now(),
          }
          items.delete(id)
          items.set(id, item)
          while (items.size > 200) items.delete(items.keys().next().value)
          // Persist before network I/O; failed deliveries survive plugin/server restarts.
          await save()
          await publish(item)
        })
      }
    })().catch(() => {
      if (!controller.signal.aborted) console.warn("Glance event stream stopped")
    })
    const heartbeat = () =>
      enqueue(async () => {
        for (const [id, item] of items) {
          const session = await ctx.session.get({ sessionID: id }).catch(() => undefined)
          if (!session) continue
          // Recover settlements that occurred while delivery/the plugin was offline.
          if (session.time.idle >= item.observed && ["working", "waiting"].includes(item.state)) {
            const state = { succeeded: "done", failed: "failed", interrupted: "idle" }[session.outcome]
            if (state) items.set(id, { ...item, state, reason: "", message: "", waits: {} })
          }
          await publish(items.get(id))
        }
        await save()
      })
    heartbeat()
    const timer = setInterval(heartbeat, 30000)
    return async () => {
      clearInterval(timer)
      controller.abort()
      await reader
      await queue
    }
  },
}
