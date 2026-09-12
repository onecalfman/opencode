import type { Plugin } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk/v2"

const GoogleChat: Plugin = async ({ client, directory }, options) => {
  const webhook = options?.webhookUrl ?? process.env.GOOGLE_CHAT_WEBHOOK_URL
  if (!webhook) return {}
  if (typeof webhook !== "string" || !URL.canParse(webhook)) {
    throw new Error("Google Chat: webhookUrl must be a valid URL")
  }

  const state = {
    queue: Promise.resolve(),
    pending: 0,
    next: 0,
  }
  const active = new Set<string>()
  const failed = new Set<string>()
  const seen = new Set<string>()
  const sessions = new Map<string, { title: string; parentID?: string }>()

  const log = async (message: string) => {
    await client.app
      .log({
        body: { service: "google-chat", level: "warn", message },
      })
      .catch(() => undefined)
  }

  const notify = (sessionID: string, heading: string, detail: string) => {
    if (state.pending >= 100) {
      void log("Notification queue full; notification dropped")
      return
    }
    const session = sessions.get(sessionID)
    const text = [`*OpenCode — ${heading}*`, session?.title, `Project: ${directory}`, `Session: ${sessionID}`, detail]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 6000)
    state.pending++
    state.queue = state.queue
      .then(async () => {
        // Google Chat permits one webhook message per second per space.
        for (const attempt of [0, 1, 2]) {
          await new Promise((resolve) => setTimeout(resolve, Math.max(0, state.next - Date.now())))
          state.next = Date.now() + 1100
          const response = await fetch(webhook, {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=UTF-8" },
            body: JSON.stringify({ text }),
            signal: AbortSignal.timeout(10_000),
            redirect: "error",
          })
          await response.body?.cancel()
          if (response.ok) return
          if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
            const retry = response.headers.get("retry-after")
            const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : 2000 * (attempt + 1)
            state.next = Date.now() + Math.min(30_000, Math.max(1100, delay))
            continue
          }
          await log(`Notification delivery failed (HTTP ${response.status})`)
          return
        }
      })
      .catch(() => log("Notification delivery failed (network error or timeout)"))
      .finally(() => {
        state.pending--
      })
  }

  return {
    async event(input) {
      // The legacy Plugin type uses SDK v1, but the bus forwards current events.
      const event = input.event as unknown as Event
      if (event.type === "session.created" || event.type === "session.updated") {
        sessions.set(event.properties.info.id, event.properties.info)
        return
      }
      if (event.type === "session.deleted") {
        sessions.delete(event.properties.info.id)
        active.delete(event.properties.info.id)
        failed.delete(event.properties.info.id)
        return
      }
      if (event.type === "session.error") {
        if (event.properties.sessionID) failed.add(event.properties.sessionID)
        return
      }
      if (event.type === "session.status") {
        const sessionID = event.properties.sessionID
        if (event.properties.status.type !== "idle") {
          if (!active.has(sessionID)) failed.delete(sessionID)
          active.add(sessionID)
          return
        }
        const running = active.delete(sessionID)
        const error = failed.delete(sessionID)
        if (running && !error && !sessions.get(sessionID)?.parentID) {
          notify(sessionID, "Chat done", "The session is now idle. Return to OpenCode to read the response.")
        }
        return
      }
      if (event.type !== "question.asked" && event.type !== "permission.asked") return
      const key = `${event.type}:${event.properties.id}`
      if (seen.has(key)) return
      seen.add(key)
      if (seen.size > 512) seen.delete(seen.values().next().value!)
      if (event.type === "question.asked") {
        notify(
          event.properties.sessionID,
          "Question needs input",
          event.properties.questions
            .map((question) =>
              [question.question, ...question.options.map((option) => `• ${option.label}: ${option.description}`)].join(
                "\n",
              ),
            )
            .join("\n\n") + "\n\nAnswer in OpenCode.",
        )
        return
      }
      notify(
        event.properties.sessionID,
        "Permission needed",
        [
          `Permission: ${event.properties.permission}`,
          ...event.properties.patterns,
          "Approve or deny in OpenCode.",
        ].join("\n"),
      )
    },
    async dispose() {
      await state.queue
    },
  }
}

export default GoogleChat
