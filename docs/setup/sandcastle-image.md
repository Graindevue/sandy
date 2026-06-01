# Building the Sandy agent image

Every Agent in a Review runs inside an [Apple Container][apple-container] spawned
by [Sandcastle][sandcastle]. Sandy ships its own purpose-built image — leaner
than upstream and including the toolset Sandy's Agents actually use (`opensrc`,
`rg`, `gh`, etc.). Sandy does **not** reuse Sandcastle's Docker image and does
**not** ship the Apple Container provider's original Dockerfile (ADR
[0009](../adr/0009-apple-container-provider-copied-from-graindevue.md)).

This doc covers the global `opensrc` install (a hard host dependency, ADR
[0008](../adr/0008-opensrc-for-framework-source-truth.md)) and building the agent
image.

## 1. Host tooling: `opensrc` and Codex

[`opensrc`][opensrc] fetches actual source code for npm / PyPI / crates / GitHub
dependencies on demand and caches it locally, so Agents can verify framework
behavior against the real installed version instead of training-cutoff
knowledge. Sandy requires it **both** on the host and baked into the agent image.

Install it globally. Pin the same version the agent image bakes in (the
Dockerfile pins `opensrc@0.7.2`) so the host and the container share one cache
format — keep this in step with `images/agent/Dockerfile` when that bumps:

```bash
npm install -g opensrc@0.7.2
opensrc --version
```

The host's `~/.opensrc` cache directory is mounted into every container, so a
package version is fetched once on the host and reused across Reviews. Run a
package through it once to prime the cache and confirm it works:

```bash
opensrc path convex
```

### Codex (the default `logic` Agent vendor)

The Phase 1 `logic` Agent runs on **Codex** (`vendor: codex`), so the host also
needs the Codex CLI and a login. The agent image bakes the same CLI
(`@openai/codex`, pinned to match the host); at review time the worker stages a
read-only copy of the host's `~/.codex/auth.json` into each Agent container, so
Codex authenticates inside the sandbox without exposing or mutating your real
`~/.codex`.

Install the CLI and log in — this uses your ChatGPT subscription and writes
`~/.codex/auth.json`. Pin the version the image bakes (`images/agent/Dockerfile`)
so the host login and the in-container `codex exec` share an `auth.json` format:

```bash
npm install -g @openai/codex@0.134.0
codex login
codex --version
```

If a Review later fails with a Codex auth error after a long idle period, run any
`codex` command on the host to refresh the token.

> **Prefer Agent API-key auth, or want Claude instead?** `OPENAI_API_KEY` is
> already required in `.config/.env` for Finding embeddings; Codex can also use
> it for API-key auth (no `codex login` needed). Or switch the `logic` Agent to
> `vendor: claude` and set `ANTHROPIC_API_KEY` (see
> [`github-app.md`](./github-app.md) and [`bot-yaml.md`](./bot-yaml.md)).

## 2. Confirm Apple Container is installed

The agent image is an Apple Container image, so [Apple Container][apple-container]
must be installed and its system service running. Verify:

```bash
container --version
container system status
```

If the service isn't running, start it per Apple Container's instructions before
building.

## 3. Build the agent image

Sandy builds the image with a workspace script:

```bash
pnpm sandcastle:build-image
```

This builds from the Sandy-owned Dockerfile at `images/agent/Dockerfile` — a
self-hosting agent image that bakes in `opensrc` and Sandy's review toolchain on
top of a Node 24 base. The script passes `--build-arg AGENT_UID=$(id -u)` and
`--build-arg AGENT_GID=$(id -g)` so the image's `agent` user matches your host
UID/GID and bind-mounted worktree files share an owner, then tags the result
`sandy-agent` — the local image the worker references when it asks Sandcastle to
spawn an Agent.

## 4. Verify

The build always tags the image `sandy-agent` (the `-t sandy-agent` in the
script). After a successful build it appears in Apple Container's image list:

```bash
container image list
```

You should see the `sandy-agent` image. A quick smoke test that `opensrc` and
the core tools are present inside the image — the image's entrypoint is
`sleep infinity`, so override it with `--entrypoint` to actually run a tool, and
pass the tool's own flags after the image name:

```bash
container run --rm --entrypoint opensrc sandy-agent --version
container run --rm --entrypoint rg sandy-agent --version
container run --rm --entrypoint tree_sitter_query sandy-agent --help
container run --rm --entrypoint codex sandy-agent --version
```

The worker mounts the per-Review worktree and the host `~/.opensrc` cache into a
container started from this image; nothing else needs to be installed inside it
by hand.

## Next

Continue to [`convex.md`](./convex.md) (if not done) and
[`github-app.md`](./github-app.md). Agent **selection** — which Agents run, and
the fact that only `logic` runs in Phase 1 — is configured in
[`bot-yaml.md`](./bot-yaml.md).

[apple-container]: https://github.com/apple/container
[sandcastle]: https://www.npmjs.com/package/@ai-hero/sandcastle
[opensrc]: https://opensrc.run
