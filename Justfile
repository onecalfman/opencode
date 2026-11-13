# Use the repository-pinned Bun; these recipes never select or start a managed service.
check-bun:
    @test "$(bun --version)" = "1.4.2"

v2-check: check-bun
    bun run check

v2-core-tests: check-bun
    bun run --cwd packages/core script/test.ts test/project.test.ts test/profile.test.ts test/push.test.ts test/database-migration.test.ts test/v1-migration.test.ts
    bun run --cwd packages/server test test/push.test.ts
    bun run --cwd packages/client test test/promise.test.ts test/effect.test.ts

v2-session-inactivity-tests: check-bun
    bun run --cwd packages/core script/test.ts test/location-activity.test.ts test/session-execution.test.ts test/session-run-coordinator.test.ts test/form.test.ts test/browser-idle.test.ts

[working-directory: "packages/app"]
v2-ui-tests: check-bun
    PLAYWRIGHT_PORT=4473 bun run test:e2e:built -- e2e/regression/tabs.spec.ts e2e/regression/settings.spec.ts --project chromium --workers=3 --retries=0 --reporter=line

v2-build-cli: check-bun
    OPENCODE_CHANNEL=dev bun run --cwd packages/app build
    OPENCODE_CHANNEL=dev bun run --cwd packages/cli script/build.ts --single --skip-install --skip-web-ui

# Rebuild browser assets as well as the binary; never reuse an older worktree's bundle.
v2-build-release version: check-bun
    OPENCODE_CHANNEL=latest OPENCODE_VERSION="{{version}}" bun run --cwd packages/cli script/build.ts --single --skip-install

[working-directory: "packages/app"]
v2-command-progress-tests: check-bun
    PLAYWRIGHT_PORT=4479 bun run test:e2e:built -- e2e/regression/session-timeline-tool-projection.spec.ts e2e/regression/timeline-stream.spec.ts --grep 'command progress|Working|background shell presentation' --project chromium --workers=1 --retries=0 --reporter=line

[working-directory: "packages/app"]
v2-tab-benchmark: check-bun
    PLAYWRIGHT_PORT=4471 PLAYWRIGHT_BUILD=1 npx playwright test --config e2e/performance/playwright.config.ts timeline/session-tab-switch-benchmark.spec.ts --project chromium --grep 'tab switch: warm, review closed' --workers=1 --retries=0 --reporter=line

v2-rehearse-fixture checkout destination: check-bun
    bun run --cwd packages/core script/migration-rehearsal.ts --fixture-from "{{checkout}}" "{{destination}}"

v2-rehearse-projection checkout destination: check-bun
    bun run --cwd packages/core script/migration-rehearsal.ts --fixture-with-projection "{{checkout}}" "{{destination}}"

v2-rehearse-snapshot snapshot destination auth="": check-bun
    bun run --cwd packages/core script/migration-rehearsal.ts --snapshot "{{snapshot}}" "{{destination}}" "{{auth}}"

v2-inspect-live pid:
    uv run --no-project python packages/core/script/migration-backup.py inspect "{{pid}}"

v2-backup-live pid project destination:
    uv run --no-project python packages/core/script/migration-backup.py backup "{{pid}}" "{{destination}}" --project "{{project}}"

v2-verify-snapshot snapshot rehearsal auth="": check-bun
    bun run --cwd packages/core script/migration-rehearsal.ts --verify "{{snapshot}}" "{{rehearsal}}" "{{auth}}"

v2-prepare-config snapshot destination google_chat wakatime mode="validation": check-bun
    bun run --cwd packages/core script/migration-config.ts "{{snapshot}}" "{{destination}}" "{{google_chat}}" "{{wakatime}}" "{{mode}}"

v2-preview converted config destination port="4480": check-bun
    bun run --cwd packages/core script/migration-preview.ts "{{converted}}" "{{config}}" "{{destination}}" "{{port}}"

v2-browser runtime: check-bun
    bun run --cwd packages/app script/migration-browser.ts "{{runtime}}"
