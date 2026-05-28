# Supervising the worker with launchd

In production the Sandy worker runs as a supervised background service via
**launchd** — macOS's native service manager. launchd starts the worker on boot,
restarts it if it crashes (or is `kill -9`'d), and captures its logs. This is the
intended way to run Sandy on a Mac mini; for development you can just run
`pnpm dev` in a terminal instead.

The worker is the `@sandy/bot-worker` package's entry point. Before installing
the service, make sure the rest of setup is done: the agent image is built
([`sandcastle-image.md`](./sandcastle-image.md)), Convex is deployed
([`convex.md`](./convex.md)), `.config/.env` holds the GitHub App + Convex
credentials ([`github-app.md`](./github-app.md)), and `.config/bot.yaml` exists
([`bot-yaml.md`](./bot-yaml.md)).

## 1. Build the worker

The service runs built output, not the dev watcher:

```bash
pnpm -r build
```

## 2. Write the plist

Create a **user** LaunchAgent at
`~/Library/LaunchAgents/dev.sandy.worker.plist`. Replace every `__PLACEHOLDER__`
with an absolute path for your host — launchd does not expand `~`, `$HOME`, or
shell variables, so all paths must be absolute.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.sandy.worker</string>

    <!-- pnpm runs the worker's start script. Use the absolute path to the
         pnpm binary (`which pnpm`) — launchd has a minimal PATH. -->
    <key>ProgramArguments</key>
    <array>
        <string>__ABS_PATH_TO_PNPM__</string>
        <string>--filter</string>
        <string>@sandy/bot-worker</string>
        <string>start</string>
    </array>

    <!-- Run from the repo root so .config/ and workspace paths resolve. -->
    <key>WorkingDirectory</key>
    <string>__ABS_PATH_TO_SANDY_REPO__</string>

    <!-- launchd's PATH is minimal; add Homebrew + the global npm bin so the
         worker (and the containers it spawns) can find `container`, `git`,
         `opensrc`, `node`, `pnpm`. Adjust for your install (Apple Silicon
         Homebrew is /opt/homebrew). -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>

    <!-- Start on load/boot and restart on exit (covers crashes and `kill -9`). -->
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>

    <!-- Back off restarts so a crash-loop doesn't hammer the machine. -->
    <key>ThrottleInterval</key>
    <integer>10</integer>

    <!-- Logs. Create the directory first (step 3). -->
    <key>StandardOutPath</key>
    <string>__ABS_PATH_TO_LOG_DIR__/worker.out.log</string>
    <key>StandardErrorPath</key>
    <string>__ABS_PATH_TO_LOG_DIR__/worker.err.log</string>
</dict>
</plist>
```

Placeholder reference:

| Placeholder | Example | How to find it |
|-------------|---------|----------------|
| `__ABS_PATH_TO_PNPM__` | `/opt/homebrew/bin/pnpm` | `which pnpm` |
| `__ABS_PATH_TO_SANDY_REPO__` | `/Users/you/projects/sandy` | repo root (`pwd`) |
| `__ABS_PATH_TO_LOG_DIR__` | `/Users/you/projects/sandy/logs` | a writable dir you create in step 3 |

> Sandy reads its own config from `.config/.env` and `.config/bot.yaml` relative
> to `WorkingDirectory`, so you don't need to list GitHub/Convex secrets in the
> plist. `EnvironmentVariables` here is only for `PATH`. Keep secrets in
> `.config/.env`, not in this world-readable plist.

## 3. Create the log directory

```bash
mkdir -p __ABS_PATH_TO_LOG_DIR__
```

(Use the same absolute path you put in the plist.)

## 4. Load and start

`launchctl bootstrap` loads the service into your per-user GUI domain
(`gui/<uid>`); with `RunAtLoad` it starts immediately:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.sandy.worker.plist
```

Confirm it's running and note the PID:

```bash
launchctl print gui/$(id -u)/dev.sandy.worker | grep -E "state|pid"
```

`state = running` with a numeric `pid` means the worker is up and listening on
port 3007 (see [`tailscale.md`](./tailscale.md)).

## 5. Stop, reload, uninstall

```bash
# Restart after a config or code change (rebuild first: `pnpm -r build`):
launchctl kickstart -k gui/$(id -u)/dev.sandy.worker

# Unload (stop and remove from launchd):
launchctl bootout gui/$(id -u)/dev.sandy.worker

# Reload after editing the plist: bootout, then bootstrap again.
```

> Older guides use `launchctl load`/`unload`. On current macOS prefer
> `bootstrap`/`bootout`/`kickstart` as above; the `load`/`unload` pair is
> deprecated and behaves inconsistently for GUI-domain agents.

## 6. Verify supervision

- **Boot/start:** after `bootstrap`, `launchctl print …` shows `state = running`.
- **Crash recovery:** `kill -9` the worker PID; within `ThrottleInterval`
  seconds launchd restarts it with a new PID (`KeepAlive`). The acceptance test
  for Phase 1 expects exactly this — the worker comes back after `kill -9` with
  no leaked Apple Containers (the provider tears containers down on the worker's
  signal handlers; confirm with `container list` after a restart).
- **Logs:** tail the files you configured —

  ```bash
  tail -f __ABS_PATH_TO_LOG_DIR__/worker.out.log __ABS_PATH_TO_LOG_DIR__/worker.err.log
  ```

## Next

The worker is now supervised. Make sure the [GitHub App](./github-app.md) webhook
points at your live [Funnel URL](./tailscale.md), then post `@bot review` on a
PR in a Repo declared in [`bot.yaml`](./bot-yaml.md) to trigger the first Review.
