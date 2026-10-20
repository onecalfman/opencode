"""Take an authorized online SQLite/configuration snapshot without starting OpenCode."""

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import time
from datetime import UTC, datetime
from pathlib import Path


def digest(filename):
    with open(filename, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def process_info(pid):
    proc = Path("/proc") / str(pid)
    env = dict(
        entry.split("=", 1)
        for entry in proc.joinpath("environ").read_text().split("\0")
        if "=" in entry
    )
    home = Path(env["HOME"])
    databases = set()
    for fd in proc.joinpath("fd").iterdir():
        try:
            target = os.readlink(fd)
        except FileNotFoundError:
            continue
        if target.endswith(".db") and Path(target).is_file():
            databases.add(target)
    roots = {
        "home": str(home),
        "config": env.get(
            "OPENCODE_CONFIG_DIR",
            str(Path(env.get("XDG_CONFIG_HOME", home / ".config")) / "opencode"),
        ),
        "data": str(Path(env.get("XDG_DATA_HOME", home / ".local/share")) / "opencode"),
        "state": str(
            Path(env.get("XDG_STATE_HOME", home / ".local/state")) / "opencode"
        ),
    }
    return {
        "pid": pid,
        "executable": os.readlink(proc / "exe"),
        "cwd": os.readlink(proc / "cwd"),
        "startTicks": proc.joinpath("stat").read_text().rsplit(")", 1)[1].split()[19],
        "openDatabases": sorted(databases),
        "pinnedDatabase": env.get("OPENCODE_DB"),
        "roots": roots,
    }, env


def private_json(filename, value):
    with open(
        filename, "x", opener=lambda name, flags: os.open(name, flags, 0o600)
    ) as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")


def copy_configuration(source, destination, entries, links, excluded, ancestors=()):
    if source.is_symlink():
        links.append({"source": str(source), "target": os.readlink(source)})
    if not source.exists():
        excluded.append({"source": str(source), "reason": "missing or dangling link"})
        return
    resolved = source.resolve()
    if source.is_dir():
        if resolved in ancestors:
            excluded.append({"source": str(source), "reason": "recursive link"})
            return
        destination.mkdir(mode=0o700, parents=True, exist_ok=True)
        for child in sorted(source.iterdir()):
            if child.name in {"node_modules", ".git", ".cache", "__pycache__"} or (
                source.name == ".opencode" and child.name == "references"
            ):
                excluded.append(
                    {
                        "source": str(child),
                        "reason": "dependencies, cache, or reference checkout",
                    }
                )
                continue
            if child.suffix in {".db", ".sqlite", ".sqlite3"} or child.name.endswith(
                ("-wal", "-shm")
            ):
                excluded.append(
                    {
                        "source": str(child),
                        "reason": "database requires its own consistent backup",
                    }
                )
                continue
            copy_configuration(
                child,
                destination / child.name,
                entries,
                links,
                excluded,
                (*ancestors, resolved),
            )
        return
    if not source.is_file():
        excluded.append({"source": str(source), "reason": "not a regular file"})
        return
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    content = source.read_bytes()
    with open(
        destination, "xb", opener=lambda name, flags: os.open(name, flags, 0o600)
    ) as stream:
        stream.write(content)
    checksum = hashlib.sha256(content).hexdigest()
    if digest(destination) != checksum:
        raise RuntimeError("Configuration copy verification failed")
    entries.append(
        {
            "source": str(source),
            "copy": str(destination),
            "bytes": len(content),
            "sha256": checksum,
        }
    )


def inventory(filename):
    with sqlite3.connect(filename.as_uri() + "?mode=ro", uri=True) as db:
        tables = {
            row[0]
            for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        names = (
            "project",
            "session",
            "session_v2",
            "message",
            "part",
            "session_message",
            "session_input",
            "session_inbox",
            "ui_profile",
            "push_key",
            "push_subscription",
            "credential",
            "migration",
        )
        counts = {
            name: db.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
            if name in tables
            else 0
            for name in names
        }
        projection_only = (
            db.execute("""
            SELECT COUNT(*) FROM session_message
            WHERE NOT EXISTS (
                SELECT 1 FROM message WHERE message.id = session_message.id
                AND message.session_id = session_message.session_id
            )
        """).fetchone()[0]
            if {"session_message", "message"} <= tables
            else 0
        )
        pending = (
            db.execute(
                "SELECT COUNT(*) FROM session_input WHERE promoted_seq IS NULL"
            ).fetchone()[0]
            if "session_input" in tables
            else 0
        )
        return {
            "quickCheck": [row[0] for row in db.execute("PRAGMA quick_check")],
            "foreignKeyViolations": sum(
                1 for _ in db.execute("PRAGMA foreign_key_check")
            ),
            "counts": counts,
            "projectionOnlyMessages": projection_only,
            "pendingLegacyInputs": pending,
        }


parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=["inspect", "backup"])
parser.add_argument("pid", type=int)
parser.add_argument("destination", nargs="?", type=Path)
parser.add_argument("--project", type=Path)
args = parser.parse_args()
before, env = process_info(args.pid)
if args.mode == "inspect":
    print(json.dumps(before, indent=2))
    raise SystemExit(0)
if not args.destination or not args.destination.is_absolute():
    parser.error("backup requires a new absolute destination directory")
if len(before["openDatabases"]) != 1:
    raise RuntimeError(
        "Expected exactly one observed live database; do not guess which file to back up"
    )
source = Path(before["openDatabases"][0])
if before["pinnedDatabase"] and Path(before["pinnedDatabase"]) != source:
    raise RuntimeError("Pinned database does not match the observed open database")
os.umask(0o077)
root = args.destination
root.mkdir(mode=0o700)
partial = root / "backup.partial.db"
with open(partial, "xb"):
    pass
started = time.monotonic()
last_progress = [started]


def progress(status, remaining, total):
    now = time.monotonic()
    if now - started > 600:
        raise TimeoutError("Online backup exceeded its ten-minute deadline")
    if now - last_progress[0] >= 10:
        print(
            json.dumps({"backupPagesRemaining": remaining, "backupPagesTotal": total}),
            flush=True,
        )
        last_progress[0] = now


with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=10) as origin:
    origin.execute("PRAGMA query_only=ON")
    if origin.execute("PRAGMA journal_mode").fetchone()[0] != "wal":
        raise RuntimeError(
            "This live-backup workflow requires WAL mode to keep writers unblocked"
        )
    # Keep one WAL read snapshot across backup steps; otherwise every active writer restarts a large backup.
    origin.execute("BEGIN")
    origin.execute("SELECT rootpage FROM sqlite_master LIMIT 1").fetchone()
    with sqlite3.connect(partial) as target:
        origin.backup(target, pages=1024, progress=progress, sleep=0.05)
        target.execute("PRAGMA journal_mode=DELETE")
partial.rename(root / "backup.db")
snapshot = root / "backup.db"
observed = inventory(snapshot)
if observed["quickCheck"] != ["ok"]:
    raise RuntimeError("Snapshot integrity check failed")

entries, links, excluded = [], [], []
copy_configuration(
    Path(before["roots"]["config"]),
    root / "configuration/global",
    entries,
    links,
    excluded,
)
if args.project:
    copy_configuration(
        args.project / ".opencode",
        root / "configuration/project/.opencode",
        entries,
        links,
        excluded,
    )
    for name in ("AGENTS.md", "opencode.json", "opencode.jsonc"):
        if (args.project / name).exists():
            copy_configuration(
                args.project / name,
                root / "configuration/project" / name,
                entries,
                links,
                excluded,
            )
data_root = Path(before["roots"]["data"])
for name in ("auth.json", "mcp-auth.json", "mcp-oauth.json"):
    if (data_root / name).exists():
        copy_configuration(
            data_root / name,
            root / "configuration/auth" / name,
            entries,
            links,
            excluded,
        )
wakatime = (
    Path(env.get("WAKATIME_HOME", before["roots"]["home"])).expanduser()
    / ".wakatime.cfg"
)
if wakatime.is_file():
    copy_configuration(
        wakatime, root / "configuration/auth/wakatime.cfg", entries, links, excluded
    )
if Path("/etc/opencode").exists():
    copy_configuration(
        Path("/etc/opencode"), root / "configuration/system", entries, links, excluded
    )
if env.get("OPENCODE_CONFIG") and Path(env["OPENCODE_CONFIG"]).is_file():
    copy_configuration(
        Path(env["OPENCODE_CONFIG"]),
        root / "configuration/explicit-config",
        entries,
        links,
        excluded,
    )
private_json(
    root / "configuration/launch-private.json",
    {
        "argv": Path(f"/proc/{args.pid}/cmdline").read_text().split("\0"),
        "environment": {
            key: value
            for key, value in env.items()
            if key.startswith(("OPENCODE_", "XDG_"))
            or key
            in {
                "HOME",
                "PATH",
                "GOOGLE_CHAT_WEBHOOK_URL",
                "WAKATIME_HOME",
                "WAKATIME_API_KEY",
            }
        },
        "cgroup": Path(f"/proc/{args.pid}/cgroup").read_text(),
    },
)
private_json(
    root / "configuration-manifest-private.json",
    {"files": entries, "links": links, "excluded": excluded},
)
after, _ = process_info(args.pid)
unchanged = all(
    before[key] == after[key]
    for key in ("pid", "startTicks", "executable", "openDatabases")
)
receipt = {
    "createdAt": datetime.now(UTC).isoformat(),
    "source": before,
    "executableSHA256": digest(before["executable"]),
    "backup": str(snapshot),
    "backupBytes": snapshot.stat().st_size,
    "backupSHA256": digest(snapshot),
    "backupSeconds": round(time.monotonic() - started, 3),
    "configurationFiles": len(entries),
    "configurationBytes": sum(entry["bytes"] for entry in entries),
    "configurationLinksResolved": len(links),
    "configurationExclusions": len(excluded),
    "serviceIdentityUnchanged": unchanged,
    "sqliteVersion": sqlite3.sqlite_version,
    "inventory": observed,
}
private_json(root / "backup-receipt.json", receipt)
shutil.copyfile(__file__, root / "snapshot-tool.py")
os.chmod(root / "snapshot-tool.py", 0o600)
print(json.dumps(receipt, indent=2))
if not unchanged:
    raise SystemExit(1)
