# Customized OpenCode → V2 migration

## Prepared source and authorization

- Task: [MIN-35](https://linear.app/minktec/issue/MIN-35).
- Original: `vertical-tabs` at `a0cce823cd5f856b39245d6c405f0b60d7267539`. Keep its checkout, deployed binary, database, and configuration available for rollback.
- Candidate: `opencode-two`, rebased onto upstream tag `v2.0.32`, commit `843a6c514e606b436a7fe713422ace0a93ad3d61`.
- Replayed stack tip: `2dac59a3ee`. Compatibility import/audit tooling, profile persistence, preference migration, and UI fixes are subsequent local source-finalization changes. Review the preparation commits before publication or release.
- On October 20, Jonas authorized a private online database/configuration backup and an isolated real-data rehearsal. That backup and rehearsal are complete. Live database conversion, service replacement, deployment, and rewritten-history publication remain outside the authorization.

The fork's branch named `2.0` is an older exploration, not this target. The target is a versioned source tag; GitHub's Latest release listing is not evidence that it is a published V2 release artifact.

## Custom behavior carried forward

| Existing customization                       | V2 owner / disposition                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vertical tab orientation                     | Native V2 appearance setting; the obsolete layout patch was skipped. The custom V1 `general.tabLayout` preference migrates to `appearance.tabLayout`, without replacing an existing native preference.             |
| Project tags                                 | Canonical Project schema/service, workspace settings, tab badges, and previous-V2 import.                                                                                                                          |
| Machine/project groups, including draft tabs | Native titlebar/tab strip. Groups use stable server/worktree keys so metadata updates retain hover, preview, and drag state.                                                                                       |
| Cross-device UI profiles                     | Canonical Profile schema, `/api/profile`, CAS persistence, server registry, and native tabs/composer admission. Portable data omits credentials; authentication stays device-local.                                |
| Recent-chat authority and remote tab closes  | Durable per-home pending operations and import checkpoints, legacy queue migration, input timestamps, and native tab reconciliation. Browser cases prove remote closure/reload and offline closure/reconciliation. |
| Web Push and Reload app                      | Native completion/failure/permission/form events, `/api/push`, root Notifications settings, General settings reload, and public `push-worker.js`.                                                                  |
| Google Chat addition/removal                 | Separate plugin worktree now has dual V1/V2 entrypoints, native completion/form/permission handling and scoped cleanup. It loads successfully on the isolated native server.                                       |
| Old mobile-settings layout                   | Superseded by native V2 settings.                                                                                                                                                                                  |

Keep these custom migration identities unchanged. Existing customized databases have already journaled them:

```text
20260904134539_project-tag
20260910155807_ui-profile
20261018041219_web-push
```

Regenerating them under new timestamps would repeat existing ALTER/CREATE operations. Regenerate schema/registry files with `bun run migration` in `packages/core`, and clients with `bun run generate` in `packages/client` after contract changes.

## Important data compatibility gate

The original fork can contain both V1 `message`/`part` history and earlier experimental V2 history in `session_message`. The latter predates upstream's recognized previous-V2 marker, `20260730195856_optional_session_title`.

Upstream migration `20260804233008_loose_psylocke` rebuilds the V1 projections. In the synthetic mixed-history rehearsal it discarded an earlier V2-only message while leaving its session row present. **Session counts alone do not establish that history survived.**

The candidate now recognizes **complete native-only sessions**: it validates every projected payload, copies the session metadata/history into the new tables in the schema transaction, preserves sequence watermarks, releases obsolete replay ownership, and records the retained IDs under `migration.pre-split-v2`. V1 conversion advances its durable cursor past those retained sessions instead of overwriting them. Unsupported payloads, mixed V1/native histories, and unpromoted inputs still fail before destructive changes. Do not fake a newer lineage marker to bypass these guards.

On an **offline backup**, the relevant inventory query is:

```sql
SELECT COUNT(*) AS projection_only_messages
FROM session_message
WHERE NOT EXISTS (
  SELECT 1 FROM message
  WHERE message.id = session_message.id
    AND message.session_id = session_message.session_id
);

SELECT COUNT(*) AS pending_legacy_inputs
FROM session_input
WHERE promoted_seq IS NULL;
```

These queries are for the original fork's schema. Quiesce active work and resolve pending legacy inputs before a final cutover snapshot. The upstream migration removes the old input/context tables and clears the old event log; those are not an automatic execution-resume path.

## Isolated rehearsals

Use Bun **1.4.2**. `Justfile` checks the version and contains the recurring verification commands. Set `TMPDIR` to a writable local filesystem if the host's `/tmp` quota is exhausted; preparation on this host used `/home/jonas/dev`.

The rehearsal builds only Database and the V1 converter. It does not start service election, execution recovery, providers, tools, plugins, push delivery, or HTTP listeners. All HOME/XDG/config/data/state roots are isolated before runtime imports. The destination must be a new absolute directory; it is created exclusively with owner-only permissions.

### Synthetic original-schema fixtures

From the candidate root, substitute your preserved V1 checkout and new destination paths:

```sh
just v2-rehearse-fixture /absolute/path/to/original-checkout /absolute/path/to/new-legacy-rehearsal
just v2-rehearse-projection /absolute/path/to/original-checkout /absolute/path/to/new-projection-rehearsal
```

Both fixtures now convert successfully and remain identical on a second converter run. The second proves preservation of supported native-only history alongside ordinary V1 history. Unit coverage retains the unsafe-payload refusal regression. Fixture SQL and historical IDs come from the original checkout's static generated schema/registry, rather than a hand-maintained approximation. No original database is opened.

Each run leaves:

- `source.db`: unmodified rehearsal input;
- `candidate.db`: disposable migrated or refused candidate;
- `report.json`: counts, source checksum, preservation checks, and conversion status.

Reports compare legacy message/part contents, source/session/message IDs, project tags, UI profile revision/document, credentials, signing keys, subscriptions, integrity/foreign keys, pending inputs, and projection-only history. They do not print transcript or credential values. A successful report is **ready for data review**, not deployment approval or proof that every history feature renders correctly.

### A real-data snapshot, after authorization

First identify the exact pinned database and deployed binary from the current service/operator configuration. Do not infer the database from a version/channel default. Ask the operator for an authorized standalone SQLite backup, including committed WAL contents; copying only an active `.db` file is insufficient. An SQLite `.backup` operation can take a consistent online snapshot; obtain a final fresh snapshot after quiescing writes for cutover.

Run the prepared tool against that backup only:

```sh
just v2-rehearse-snapshot /absolute/path/to/offline-backup.db /absolute/path/to/new-real-data-rehearsal
# Include a privately backed-up legacy provider-auth file when checking credential import:
just v2-rehearse-snapshot /absolute/path/to/offline-backup.db /absolute/path/to/new-rehearsal /absolute/path/to/auth.json
# Reaudit an existing rehearsal without replacing its original report:
just v2-verify-snapshot /absolute/path/to/offline-backup.db /absolute/path/to/rehearsal /absolute/path/to/auth.json
```

The tool copies the supplied snapshot before opening any database, refuses symlinks and adjacent WAL files, and checks that both input copies retain their original checksum. It never chooses the live database itself. A nonzero result requires investigation on the disposable candidate; retain the original snapshot and begin each attempt in a new directory.

Also preserve configuration, `auth.json`/MCP auth material, file-based definitions, referenced attachments, plugin environment variables, and launch configuration as a separate owner-only backup. An optional auth-file argument copies it into the isolated data root before migrations; it never authenticates with external providers. MCP/provider token refresh remains a cutover check because refreshing a copied rotating token can invalidate the live service's token.

### Verified Linux backup workflow

`migration-backup.py` correlates an explicit live PID with its open database and pinned environment path. After authorization, the Linux operator recipes are:

```sh
just v2-inspect-live <pid>
just v2-backup-live <pid> /absolute/path/to/original-checkout /absolute/path/to/new-private-snapshot
```

The helper uses Python's SQLite online backup API through `uv`, a read-only source connection, and one pinned WAL read transaction. Pinning the read view is important for a large, actively written database: otherwise writes can restart incremental backup indefinitely. It requires WAL mode so writers can continue, places the backup and resolved configuration copies under a new private directory, verifies their bytes, and records a private manifest plus launch metadata. Installed dependencies, caches, and reference checkouts are excluded; definition symlink targets are captured. Snapshot files are owner-only. Configuration files are captured individually while the service runs, so a fresh, quiesced cutover backup remains necessary.

### Real-data result — October 20

The initial guarded rehearsal correctly refused one earlier Linear-created session. The compatibility import has since preserved that session's two messages and completed the **full real-data conversion**. All 813 sessions are present, with 97,687 native projected messages and two imported provider credentials. The 97,316 raw legacy messages, 582,673 parts, tags, profile, and signing key are unchanged; the original backup checksum is unchanged. Integrity, foreign keys, second-run idempotence, and all preservation checks pass.

The post-conversion audit recomputes each of the 812 V1 session projections with the owning converter and compares every stored row. It reports **zero mismatched sessions, zero unaccounted messages, and zero parser warnings**. Raw ID equality is not a correct compaction audit: 451 summary rows are folded into compaction records; six failed-compaction and two incomplete-compaction internal rows are intentionally omitted under the existing conversion rules. The converter now reports those dispositions explicitly. Their raw records remain archived intact.

All 228 embedded file attachments are represented in native file data. Fifteen local path references (14 directory mentions and one text-file mention) retain their expanded synthetic context and archived source parts; the upstream converter makes their original URI references explicit text notices rather than reading mutable files during conversion.

Detailed inventories, manifests, configuration/auth copies, and the rehearsal report are retained privately outside Git under the operator's local application-data directory. No transcript contents or credential values belong in a public migration report. The rehearsal now streams row fingerprints: the real history is too large to materialize as one JS array/string.

### Configuration and standalone runtime validation

`v2-prepare-config` makes a separate private clone and validates both JSON/JSONC files with the pinned native normalizer/schema. The actual snapshot normalized with **zero diagnostics**. Mode `validation` disables all eight MCP connections and Google Chat delivery; mode `cutover` preserves the original MCP enablement and environment-owned webhook configuration. Both replace the two V1 plugin implementations with the prepared native packages.

```sh
just v2-prepare-config <snapshot-directory> <new-config-directory> <Google-Chat-package-directory> <WakaTime-package-directory>
just v2-prepare-config <snapshot-directory> <new-ready-config-directory> <Google-Chat-package-directory> <WakaTime-package-directory> cutover
just v2-preview <offline-converted.db> <validation-config-directory> <new-runtime-directory> 4481
just v2-browser <private-runtime-directory>
```

At this pinned release, explicitly configured local plugin targets **must be package directories**, not individual `.ts` files. Use the Google Chat repository root and the `plugins/wakatime` directory containing `index.ts`/`package.json`. Wait for plugin settlement before asserting inventory: the first list response can precede asynchronous activation.

The standalone preview uses an independent copied database, random private credentials, explicit loopback port, isolated data/config/state roots, no managed-service registration, no execution claims, and sanitized profile/session Locations. It cannot discover production servers through the copied profile. The real native API reports migration completed, both custom plugins active, the configured `openai/gpt-6.1-sol` model available among 31 models, and all eight MCP entries disabled for validation. Provider credential fingerprints remain unchanged. Chromium renders the retained session and editable composer, and verifies the Reload app action with zero page errors.

The `cutover` configuration is prepared but **not activated**. Keep validation-only network suppression separate from the actual production enablement settings.

### Companion sources

- `opencode-chat-v2`, branch `opencode-two`, starts at the fetched Google Chat `origin/main` (`27a1f4b`); the original checkout is unchanged. V1 and V2 plugin tests pass together.
- `dotfiles-opencode-two`, branch `opencode-two`, starts at fetched dotfiles `origin/main` (`ed68d0f`). It contains the opt-in native WakaTime package and a V2 API port of the existing MIN-25 dispatcher, copied from its existing `118c4b2` source without changing that worker's checkout/runtime. The native transport uses fixed Basic username `opencode`, native model catalog, title-at-create, and scoped MCP connect endpoints. Legacy transport and durable retry/tab-publication behavior remain covered.
- Neither companion repository has a remote `dev`; their authoritative remote default was verified as `main` before creating the isolated worktrees. Companion source finalization is local; publication and runtime activation require separate authorization.

## Configuration and integration inventory

Current guidance: [Migrate from V1](https://opencode.ai/v2/docs/migrate-v1/).

| Area                                        | Migration action                                                                                                                                                                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global `opencode.json` and `opencode.jsonc` | Both exist on this host. Preserve and inspect their effective settings together; do not overwrite either with a partial conversion. Supported V1 server config normalizes in memory without rewriting it. Native conversion is optional.                    |
| Model, agents, commands, skills, references | Keep existing supported definitions first. Preserve IDs and relative paths when moving files. Project `.opencode/opencode.jsonc` currently uses supported V1 provider/permission/tools fields and references.                                               |
| Permissions                                 | Verify retained rules and grants. V2 defaults `external_directory` to allow; add an explicit ask rule in the isolated configuration if preserving V1's outside-project prompt is required. Session-local V1 permissions are intentionally cleared upstream. |
| Terminal settings                           | V2 uses global `cli.json`, auto-migrating supported global `tui.json(c)` when absent. This host already has `cli.json`; preserve it rather than assuming first-run migration. Project `.opencode/tui.json` is not migrated as global client configuration.  |
| Plugins                                     | Native Google Chat and WakaTime ports are prepared and tested; both appear active in the actual standalone server. Install reviewed package directories and retain their CLI/environment-owned authentication.                                              |
| Native plugin config                        | Optional `plugin` → `plugins`; tuples become `{ package, options }`. Keep the old config backed up and do not point V1 at native-only rewrites.                                                                                                             |
| Server/API consumers                        | The [MIN-25](https://linear.app/minktec/issue/MIN-25) native transport port passes controlled HTTP tests alongside legacy transport. Coordinate integration of the prepared companion branch; its production timer/runtime was not changed.                 |
| Authentication and service                  | Native password-based API authentication uses username `opencode`. Verify external clients, proxy routing, paired tokens, CORS, and operator credentials using the new service options. Legacy `server` config is not the V2 launch contract.               |
| LSP                                         | V2 retains config but does not run language servers or expose LSP diagnostics/tools. Use the project's compiler/lint/typecheck commands for those workflows.                                                                                                |
| PWA/device state                            | Keep the same intended origin and device storage; do not clear site data as a migration step. Confirm native storage migration, profile synchronization, reload, and existing per-server push registrations on the actual devices.                          |

Do not run implicit candidate CLI startup or `dev:live` as a migration rehearsal. Different-version clients can replace the elected managed service, and connecting to the existing live service does not test a V2 backend. UI tests here use independent fixture servers.

## Verification commands and acceptance

```sh
just v2-check
just v2-core-tests
just v2-ui-tests
just v2-tab-benchmark
just v2-build-cli
```

Recorded preparation evidence:

- Full root `bun run check`: lint/typechecks passed (advisory lint warnings remain).
- Core project/profile/push plus database/V1 migration suites: 85 passed; includes compatibility retention, refusal, and retry coverage. Server push: 2 passed; client: 49 passed.
- App unit suite: 785 passed. Browser push-worker test: passed without real FCM/APNs delivery.
- Production-build tabs/settings keeper suites: 63 passed, including remote-closure/reload and offline-close/reconciliation regressions. App e2e typecheck is clean; the four pre-existing overload/listener typing errors were corrected without altering browser behavior.
- Native Linux x64 CLI compilation: passed in dev channel with `--single --skip-install --skip-web-ui`; no installation performed.
- Initial upstream warm-tab benchmark: first correct 25.4ms, stable observation 47ms, zero message requests. Final candidate: 32.7ms / 59.7ms, also zero message requests and no blank/wrong/source samples (run `2026-10-20T06-43-36-452Z-3886428`). These are single-run observations, not a statistical performance guarantee.
- Both synthetic lineages and the full real-data audit pass, including native-only history, credential import and idempotence.
- Companion Google Chat: 11 passed across V1/V2. WakaTime native CLI batch test: passed. Dispatcher legacy/native controlled HTTP suite: 12 passed. Companion typechecks pass.
- Chrome DevTools MCP was unavailable (`Target closed`), so interactive inspection through that connector was not completed. Browser behavior above was verified through the isolated Chromium Playwright suites.

Before cutover, review the real snapshot report and representative sessions: long history, tool calls, forks, compaction, images/files, metadata, project bindings, and archived sessions. Verify pending-input disposition, provider credentials, MCP, external API consumers, and two-device profile close/input behavior. Complete physical-phone background push acceptance under [MIN-13](https://linear.app/minktec/issue/MIN-13). Windows/macOS and device acceptance are not established by the Linux preparation checks.

## Authorized cutover and rollback handoff

1. Resolve every failed data check and plugin/API compatibility gate. Review the local preparation commits and publish only with explicit authorization.
2. During an approved maintenance window, quiesce active work, take a fresh consistent backup, and record the exact old binary, launch environment, database path, config/auth files, proxy origin, and service ownership.
3. Launch the verified candidate with explicitly isolated paths/port first. Confirm `/api/experimental/migration/v1` reports `completed`, inspect histories, and perform the integration checks above. Do not let execution recovery run against copied real sessions without reviewing its possible continuation behavior.
4. Switch the production operator's selected binary/database/assets together only after acceptance. Keep the old database/config backup intact; new V2 work after cutover is not automatically merged back into V1.
5. If rollback is required, stop only the authorized candidate instance and restore the recorded old binary, untouched V1 database, compatible config/auth and launch environment. Do not reopen a converted database or native-only config with the V1 binary. Restore preserved browser state if needed; reopening the PWA should revalidate its assets and reconnect to the selected server.

**Next rollout action:** review/integrate the prepared source changes and authorize the production maintenance window. Take a fresh quiesced snapshot and fresh auth material, rerun the verified conversion, then validate actual provider/MCP authentication and physical-device push before final acceptance. Do not promote the older rehearsal database over work created since that snapshot.
