# Glance status integration

Native OpenCode V2 server plugin for the Garmin Glance inbox. It is optional and
not bundled or automatically loaded. The maintained source and HTTP backend are
in `garmin-glance-notifier/adapters/opencode-plugin.mjs`.

```json
{
  "plugins": [
    {
      "package": "file:///absolute/path/to/packages/plugins/glance",
      "options": { "url": "http://127.0.0.1:8787", "source": "opencode-couch-pc" }
    }
  ]
}
```

Set `GLANCE_WRITE_TOKEN` in the server environment. Do not configure a write token
on the watch. This plugin publishes working, question, permission, success and
failure states from native events. Interruptions remove the item from the inbox.
It filters by plugin location and excludes child sessions; answers and approvals
remain in OpenCode. Heartbeats and a per-location persistent outbox recover
delivery failures. Older work is not imported automatically on first install.

The companion repository's `backend/test/plugin.test.mjs` exercises the plugin
against the real notification HTTP server, including outbox replay and ack
semantics. Never run another publisher with the same source/session identity.
