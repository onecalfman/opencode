import { describe, expect, test } from "bun:test"
import { ShellRestart } from "@opencode/core/shell/restart"

describe("shell restart allowlist", () => {
  test.each([
    "gh run watch 123",
    "gh run watch 123 --exit-status --compact -i 5 -R MinkTec/opencode",
    'gh run watch "123" --repo "MinkTec/opencode" --interval=10',
    "gh -R github.example.com/MinkTec/opencode run watch 123",
    "gh pr checks 42 --watch",
    "gh pr checks --watch --required --fail-fast -i 10 42 --repo MinkTec/opencode",
    "\tgh  run watch '123' \t",
  ])("allows a literal read-only watcher: %s", (command) => {
    expect(ShellRestart.allows(command)).toBe(true)
  })

  test.each([
    "",
    "gh run watch",
    "gh run watch --exit-status",
    "gh pr checks --watch",
    "gh pr checks 42",
    "gh pr checks main --watch",
    "gh run watch 0",
    "gh run rerun 123",
    "gh run cancel 123",
    "gh pr merge 42",
    "gh workflow run deploy",
    "gh api -X POST repos/MinkTec/opencode/actions/runs/123/rerun",
    "gh run watch 123 && gh pr merge 42",
    "gh run watch 123; rm -rf project",
    "gh run watch 123 | tee result",
    "gh run watch 123 > result",
    "gh run watch 123 &",
    "gh run watch 123\necho done",
    "gh run watch 123\n",
    "gh run watch 123\r",
    'gh run watch "$(touch pwned)"',
    "gh run watch `echo 123`",
    "gh run watch $RUN_ID",
    "gh run watch ${RUN_ID}",
    "gh run watch 123 # ignored",
    "gh run watch 123 < input",
    "env gh run watch 123",
    "bash -c 'gh run watch 123'",
    "sudo gh run watch 123",
    "GH_HOST=example.com gh run watch 123",
    "/custom/gh run watch 123",
    "./gh run watch 123",
    "gh run watch 123 --unknown",
    "gh run watch 123 --interval=0",
    "gh run watch 123 -i -1",
    "gh run watch 123 --repo",
    "gh run watch 123 --repo owner",
    "gh run watch 123 456",
    "gh pr checks 42 --watch --web",
    "gh pr checks 42 --watch --template anything",
    "gh run watch 123 --repo=owner/repo=extra",
    "gh run watch 123 --exit-status=false",
    "gh -R owner/repo run watch 123 --repo other/repo",
    "gh run watch 123 --compact --compact",
    "gh run watch 123 --interval 1 --interval 2",
    "gh run watch 123 --repo=owner/repo/extra/path",
    "gh run watch '123",
    "gh run watch 12'3'",
    "gh run watch 123\u0000",
  ])("rejects an ambiguous or non-allowlisted command: %s", (command) => {
    expect(ShellRestart.allows(command)).toBe(false)
  })
})
