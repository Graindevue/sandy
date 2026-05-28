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

## 1. Install `opensrc` globally on the host

[`opensrc`][opensrc] fetches actual source code for npm / PyPI / crates / GitHub
dependencies on demand and caches it locally, so Agents can verify framework
behavior against the real installed version instead of training-cutoff
knowledge. Sandy requires it **both** on the host and baked into the agent image.

Install it globally:

```bash
npm install -g opensrc
opensrc --version
```

The host's `~/.opensrc` cache directory is mounted into every container, so a
package version is fetched once on the host and reused across Reviews. Run a
package through it once to prime the cache and confirm it works:

```bash
opensrc path convex
```

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
top of a Node 24 base. The build tags a local image the worker references when it
asks Sandcastle to spawn an Agent.

> **Heads up — lands in a separate change.** The `sandcastle:build-image` script
> and `images/agent/Dockerfile` ship in a separate Phase 1 PR and may not be
> present on the branch you're reading this from yet. The build command and image
> path above are the intended, stable interface; once that PR merges,
> `pnpm sandcastle:build-image` is the one command you run here. If the script
> isn't defined yet, that PR hasn't landed — pull the latest `staging`.

## 4. Verify

After a successful build, the image appears in Apple Container's image list:

```bash
container images list
```

You should see the Sandy agent image tag. A quick smoke test that `opensrc` and
the core tools are present inside the image:

```bash
container run --rm <sandy-agent-image-tag> opensrc --version
container run --rm <sandy-agent-image-tag> rg --version
```

(Substitute the tag printed by the build.) The worker mounts the per-Review
worktree and the host `~/.opensrc` cache into a container started from this
image; nothing else needs to be installed inside it by hand.

## Next

Continue to [`convex.md`](./convex.md) (if not done) and
[`github-app.md`](./github-app.md). Agent **selection** — which Agents run, and
the fact that only `logic` runs in Phase 1 — is configured in
[`bot-yaml.md`](./bot-yaml.md).

[apple-container]: https://github.com/apple/container
[sandcastle]: https://www.npmjs.com/package/@ai-hero/sandcastle
[opensrc]: https://opensrc.run
