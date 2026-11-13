import { expect, test } from "@playwright/test"
import type { ShellInfo } from "@opencode/client/promise"
import { timelinePresets } from "@opencode/session-ui/timeline/detail"
import { assistantMessage, directory, partUpdated, sessionID, setupTimeline, toolPart, userMessage } from "../utils/timeline"

test("shows command progress until the shell command settles", async ({ page }) => {
  const id = "prt_running_command"
  const command = { command: "sleep 1" }
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([toolPart(id, "shell", "running", command)], { completed: false })],
  })
  const status = page.getByRole("status").filter({ hasText: "Running commands" })
  await expect(status).toBeVisible()
  await expect(status.locator('[data-component="command-progress"]')).toBeVisible()
  await expect(page.locator('[data-component="session-working"]')).toHaveCount(0)
  await timeline.send(partUpdated(toolPart(id, "shell", "completed", command, { output: "done" })))
  await expect(status).toHaveCount(0)
})

test("shows command progress for an idle session until its background shell exits", async ({ page }) => {
  const shell = {
    id: "sh_idle_command",
    status: "running",
    command: "sleep 120",
    cwd: directory,
    shell: "bash",
    file: "/commands/sleep.out",
    metadata: { sessionID },
    time: { started: 2 },
  } satisfies ShellInfo
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage()],
    sessionStatus: { [sessionID]: { type: "idle" } },
    shellCommands: () => [shell, { ...shell, id: "sh_other_session", metadata: { sessionID: "ses_other" } }],
  })
  const progress = page.getByRole("status").filter({ hasText: "Running commands" })
  await expect(progress).toBeVisible()
  await expect(progress.locator('[data-component="command-progress"]')).toBeVisible()
  await expect(page.locator('[data-component="session-working"]')).toHaveCount(0)

  await timeline.transport.send({
    id: "evt_idle_command_exited",
    created: 3,
    type: "shell.exited",
    location: { directory },
    data: { id: shell.id, status: "exited", exit: 0 },
  })
  await expect(progress).toHaveCount(0)
})

test("keeps shell and question failures in their Used group", async ({ page }) => {
  const shellID = "prt_transition_error_shell"
  const questionID = "prt_transition_error_question"

  const timeline = await setupTimeline(page, {
    settings: { timelineDetail: timelinePresets[2].value },
    messages: [
      userMessage(),
      assistantMessage(
        [
          toolPart(shellID, "shell", "streaming", { command: "exit 1" }),
          toolPart(questionID, "question", "streaming", questionInput()),
        ],
        { completed: false },
      ),
    ],
  })

  const group = page.locator('[data-component="collapsed-tool-group"]')
  const used = group.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]')
  await used.click()
  await expect(page.locator(`[data-timeline-part-id="${questionID}"]`)).toHaveCount(0)
  await timeline.send(partUpdated(toolPart(shellID, "shell", "running", { command: "exit 1" })))
  await expect(page.locator(`[data-timeline-part-id="${shellID}"]`)).toContainText("exit 1")
  await timeline.send(partUpdated(toolPart(questionID, "question", "running", questionInput())))
  await expect(page.locator(`[data-timeline-part-id="${questionID}"]`)).toHaveCount(0)
  await timeline.send(
    partUpdated(
      toolPart(
        shellID,
        "shell",
        "completed",
        { command: "exit 1" },
        { output: "Command exited 1", metadata: { exit: 1 } },
      ),
    ),
  )
  await timeline.send(
    partUpdated(
      toolPart(questionID, "question", "error", questionInput(), { error: "The user dismissed this question" }),
    ),
  )

  await expect(group).toHaveAttribute("data-timeline-part-ids", `${shellID},${questionID}`)
  await expect(used).toHaveAttribute("aria-expanded", "true")
  const shell = group.locator(`[data-timeline-part-id="${shellID}"]`)
  await expect(shell.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "false")
  await shell.locator('[data-slot="collapsible-trigger"]').click()
  await expect(shell).toContainText("Command exited 1")
  const question = group.locator(`[data-timeline-part-id="${questionID}"]`)
  await expect(question).toContainText(/dismissed/i)
})

function questionInput() {
  return { questions: [{ header: "Stability", question: "Keep it stable?", options: [] }] }
}
