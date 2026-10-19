import { createMemo, Show } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { usePushNotifications } from "@/context/push"
import { ServerConnection } from "@/context/server"
import { pushAvailability } from "@/utils/push"

export function SettingsPush() {
  const global = useGlobal()
  const language = useLanguage()
  const platform = usePlatform()
  const push = usePushNotifications()
  const conn = () => global.settings.server.selected()
  const key = () => {
    const connection = conn()
    return connection ? ServerConnection.key(connection) : ""
  }
  const availability = createMemo(() => {
    push.state.busy[key()]
    return pushAvailability()
  })
  const description = () => {
    const reason = availability()
    if (reason === "install") return language.t("settings.general.notifications.push.install")
    if (reason === "secure") return language.t("settings.general.notifications.push.secure")
    if (reason === "denied") return language.t("settings.general.notifications.push.denied")
    if (reason === "unsupported") return language.t("settings.general.notifications.push.unsupported")
    if (push.state.error[key()]) return language.t("settings.general.notifications.push.error")
    return language.t("settings.general.notifications.push.description")
  }
  return (
    <Show when={platform.platform === "web"}>
      <div
        class="flex flex-col gap-3 p-3"
        data-action="settings-push-notifications"
        aria-busy={push.state.busy[key()] ?? false}
      >
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <div class="text-14-medium">{language.t("settings.general.notifications.push.title")}</div>
            <p class="text-12-regular text-text-weak" role="status" aria-live="polite">
              {description()}
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <Show when={push.state.error[key()] && (!push.enabled(key()) || !availability())}>
              <ButtonV2
                variant="neutral"
                disabled={push.state.busy[key()]}
                onClick={() => {
                  const connection = conn()
                  if (connection) void push.retry(connection)
                }}
              >
                {language.t("settings.general.notifications.push.retry")}
              </ButtonV2>
            </Show>
            <Show when={push.enabled(key()) && push.state.active[key()]}>
              <ButtonV2
                variant="neutral"
                disabled={push.state.busy[key()]}
                onClick={() => {
                  const connection = conn()
                  if (connection) void push.test(connection)
                }}
              >
                {language.t("settings.general.notifications.push.test")}
              </ButtonV2>
            </Show>
            <ButtonV2
              variant="neutral"
              disabled={
                !push.ready() || !conn() || push.state.busy[key()] || (!push.enabled(key()) && !!availability())
              }
              onClick={() => {
                const connection = conn()
                if (connection) void push.toggle(connection, !push.enabled(key()))
              }}
            >
              {language.t(
                push.enabled(key())
                  ? "settings.general.notifications.push.disable"
                  : "settings.general.notifications.push.enable",
              )}
            </ButtonV2>
          </div>
        </div>
      </div>
    </Show>
  )
}
