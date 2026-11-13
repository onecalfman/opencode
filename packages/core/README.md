# @opencode/core

Core runtime services for OpenCode.

## Command recovery

After a server restart, tracked background shell jobs can restart automatically
only when their saved command matches the literal watcher allowlist:

- `gh run watch <run-id>`
- `gh pr checks <pr-number> --watch`

Known polling/display flags and repository selectors are accepted. Targets must
be explicit numeric IDs. Scripts, wrappers, shell composition, substitutions,
redirections, and unknown flags are not eligible. This is a conservative replay
policy, not a sandbox for an untrusted executable or shell configuration.

Recovery preserves the saved working directory and shell, uses the current
session environment, and permits at most three restarts per job across server
lifetimes. Finished, failed, cancelled, and already-notified jobs are not rerun.
Normal command failures do not trigger retries. Cancelling a recovered job also
stops its shell.

Only tracked background tool jobs are covered. Older records without a saved
working directory and shell, manual user shells, and arbitrary shell API commands
are not automatically restarted.

Run the focused suite from the repository root with `just v2-command-recovery-tests`.
