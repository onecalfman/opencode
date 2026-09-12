# Google Chat notifications

`google-chat.ts` is a standalone OpenCode plugin. It is auto-loaded for this
repository and stays disabled until a webhook is configured. No OpenCode source
changes or Google SDK are required.

## Setup

1. In your Google Chat space, open **Apps & integrations → Webhooks** and create
   an incoming webhook. Copy its URL. Your Workspace administrator must allow
   incoming webhooks.
2. Set the environment variable in the environment that launches the OpenCode
   **server** (for the normal CLI, this is your shell):

   ```sh
   export GOOGLE_CHAT_WEBHOOK_URL='https://chat.googleapis.com/v1/spaces/SPACE/messages?key=KEY&token=TOKEN'
   opencode
   ```

3. Quit and restart OpenCode. Running sessions do not reload plugins or their
   configuration.

For notifications in every project, copy `google-chat.ts` to
`~/.config/opencode/plugins/google-chat.ts` and remove the project copy to avoid
loading both. The file's imports are type-only; it has no runtime dependencies.

Alternatively, place the file outside an auto-loaded plugin directory and add
this entry to the `plugin` array in your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["./google-chat.ts", { "webhookUrl": "{env:GOOGLE_CHAT_WEBHOOK_URL}" }]]
}
```

Keep the webhook URL out of committed files: it contains the credentials to post
to your space. Messages include the project path, session ID, session title when
known, and question text/options or requested permission/patterns.

## Behavior

- **Question needs input:** listens for `question.asked` (the question tool).
- **Permission needed:** listens for `permission.asked`, so automatically allowed
  actions do not generate notifications.
- **Chat done:** listens for a busy/retry → idle transition in `session.status`.
  Failed/cancelled turns and known subagent sessions are excluded. This means the
  current run has ended, not that the conversation is permanently closed.
- Questions and permissions from subagents still notify you because they need
  your input. Ordinary questions written in assistant prose are not question-tool
  requests and do not generate a separate question notification.

Delivery runs in a background queue, with a 10-second request timeout. Each plugin
instance spaces sends at least 1.1 seconds apart and retries HTTP 429/5xx responses
up to twice. Repeated request events are deduplicated. Delivery errors are logged
under `google-chat` without the webhook URL or response body and do not fail the
session. The queue is in memory (up to 100 outstanding messages); it is not a
durable delivery service. Multiple OpenCode processes sharing a space also share
Google's rate limit.

Incoming webhooks are one-way: answer questions and grant permissions in OpenCode,
not Google Chat.

Google's webhook guide: https://developers.google.com/workspace/chat/quickstart/webhooks

## Development checks

With repository dependencies installed:

- From `.opencode/tests`: `bun test google-chat.test.ts`
- From `packages/plugin`: `bun typecheck --project ../../.opencode/tests/tsconfig.json`
