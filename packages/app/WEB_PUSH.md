# Mobile Web Push

OpenCode can send task-completion, question, permission, and optional error notifications without keeping the web app open. A native mobile app is not required.

## Enable a device

1. Serve the updated web app over HTTPS and run an updated OpenCode backend. Localhost HTTP is supported for development.
2. On iPhone/iPad (iOS/iPadOS 16.4+), add OpenCode to the Home Screen and open that installed web app. Android browsers supporting Web Push do not generally require installation.
3. Select the server in Settings, then open **General → Notifications → Push notifications on this device** and choose **Enable push**.
4. Grant notification permission and choose **Send test**.

The existing Agent preference controls completion and question pushes; Permissions controls permission requests; Errors controls failures. Enable push separately for each server and each device. Preferences and translated notification titles are refreshed while the app is open and when it reconnects. Closed devices use their most recently registered preferences.

If chats are missing or the installed PWA needs refreshing, open **Settings → General → Reload app** near the top of the page. This reloads the current web app and reconnects to your servers while retaining the device's push subscription.

Choose **Disable push** to revoke a device's subscription. Removing a connected server also revokes its device subscription. Push delivery does not depend on an open page, frontend event stream, or an unexpired browser login. Following a notification still requires the server's normal authentication. The current server is single-user; subscriptions are authorized against that server rather than a separate multi-user account system.

## Hosting

- Deploy the new frontend assets, including `/push-worker.js`, and the new backend together. `opencode dev web` proxies the hosted frontend, so it will not serve local frontend changes.
- Serve the worker as JavaScript with `Cache-Control: no-cache`. It must be reachable without application-managed credentials so the browser can update it in the background. The bundled server exempts this exact static path from authentication; subscription management endpoints remain authenticated.
- Each backend generates a VAPID signing key on first use and stores it, along with device subscriptions, in its SQLite database. Preserve that database across backend restarts. If the database/signing key is replaced, reopen the web app to renew the subscription.
- Optionally set `OPENCODE_WEB_PUSH_SUBJECT` to a contact `mailto:` address or HTTPS URL. The default is `https://opencode.ai`.
- The backend needs outbound HTTPS access to browser push services (Google FCM, Apple Push, Mozilla Push, or Windows Push). No incoming push-service webhook, relay, or cloud account is required.
- The worker only receives notifications and opens same-origin links. It does not cache authenticated pages/API responses or store server credentials.

Notifications are best-effort: the backend must be running when an event occurs. Transient delivery errors are retried twice, and browser push services may hold accepted messages for up to one hour while a phone is offline. This does not add a durable notification outbox or replay old task completions after a backend crash. Expired subscriptions (HTTP 404/410) are removed. Device notification settings, Focus modes and browser/OS restrictions still apply.

## Verification

From `packages/core`:

```sh
bun test test/push.test.ts test/session-runner.test.ts test/session-runner-tool-events.test.ts
bun typecheck
```

From `packages/opencode`:

```sh
bun test test/server/httpapi-push.test.ts test/server/httpapi-ui.test.ts
bun typecheck
```

From `packages/app`:

```sh
bun test --conditions=solid --preload ./happydom.ts src/utils/push.test.ts
bun test --conditions=browser --preload ./happydom.ts ./test-browser/push-worker.test.ts
bun typecheck
bun run build
```

The worker browser test delivers a push through Chromium's DevTools service-worker API after closing the app page. It verifies worker execution and notification display without making a real FCM/APNs subscription. Finish acceptance on a physical Android/iPhone: subscribe, close the app, lock the phone, complete a task and trigger an input request, then follow the notification and confirm disable stops delivery.
