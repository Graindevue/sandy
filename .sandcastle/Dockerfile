# Dev-harness agent image for Sandy's `.sandcastle` AFK loop.
#
# This is the image the orchestrator (main.mts) launches its coding agents in —
# it must ship the CLIs those agents invoke: Codex (implementer/reviewer/
# publisher/review-gate) and Cursor Agent (planner), plus opensrc, gh, pnpm.
#
# It is intentionally SEPARATE from sandy's product image
# (`images/agent/Dockerfile`, tag `sandy-agent`), which is Claude-based and runs
# Sandy's review Agents. Build this one with `pnpm sandcastle:build-agent-image`
# (tag `sandcastle:sandy`).
FROM node:24-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
  git \
  curl \
  jq \
  ripgrep \
  python3 \
  make \
  g++ \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Build-args for UID/GID alignment: pnpm sandcastle:build-agent-image
# defaults these to the host user's UID/GID so image-built files and
# bind-mounted files share an owner without a runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
# On macOS, the host user's primary GID is often 20 ("staff"), which already
# exists in Debian-based images. Reuse an existing group when present.
RUN set -eux; \
  if ! getent group "$AGENT_GID" >/dev/null; then \
    groupmod -g "$AGENT_GID" node; \
  fi; \
  usermod -u "$AGENT_UID" -g "$AGENT_GID" -d /home/agent -m -l agent node

# Install the package manager used by this monorepo. Use npm rather than Corepack
# shims so pnpm is available non-interactively inside sandbox hooks. Pin to match
# the repo's `packageManager` field so the lockfile resolves consistently.
RUN npm install -g pnpm@10.34.1

# Install the Codex CLI (codex agents) and agent source-lookup tooling (opensrc).
RUN npm install -g @openai/codex@0.133.0 opensrc@0.7.2

USER ${AGENT_UID}:${AGENT_GID}

WORKDIR /home/agent

# Pre-create ~/.config as the agent user. Apple `container` auto-creates missing
# bind-mount parent directories as root, so mounting ~/.config/gh would otherwise
# leave /home/agent/.config owned by root — and the cursor agent's first action
# is `mkdir ~/.config/cursor`, which then fails with EACCES. Creating it here
# (after the USER switch, so it is agent-owned) keeps it writable; the runtime
# won't re-create / re-own a directory that already exists. The pnpm store mount
# (~/.local/share/pnpm/store) is nested the same way, so pre-create its parent too.
# The ~/.npmrc stops pnpm 10's manage-package-manager-versions self-switch: it
# would try to download the repo-pinned pnpm on every invocation and fail in the
# sandbox with "pnpm@X binary missing"; the baked pnpm above is the one that runs.
RUN mkdir -p ~/.config ~/.local/share/pnpm \
  && printf 'manage-package-manager-versions=false\n' > ~/.npmrc

# Install Cursor Agent CLI (provides the `agent` binary that sandcastle's cursor
# provider invokes — used by the planner). The installer writes to ~/.local/bin
# under the agent user, so it must run after the USER switch.
RUN curl https://cursor.com/install -fsS | bash
ENV PATH="/home/agent/.local/bin:$PATH"

# Pre-populate ~/.ssh with a Linux-compatible config and GitHub's verified host
# keys. The host's id_ed25519 is bind-mounted as a single read-only file at
# runtime so git can use the user's GitHub credentials without inheriting
# macOS-only options (UseKeychain) from the host config and without exposing the
# rest of ~/.ssh.
RUN mkdir -p ~/.ssh \
  && chmod 700 ~/.ssh \
  && printf '%s\n' \
       'Host github.com' \
       '  IdentityFile ~/.ssh/id_ed25519' \
       '  IdentitiesOnly yes' \
       '  StrictHostKeyChecking yes' \
       > ~/.ssh/config \
  && chmod 600 ~/.ssh/config \
  && ssh-keyscan -t rsa,ecdsa,ed25519 github.com > ~/.ssh/known_hosts 2>/dev/null \
  && chmod 600 ~/.ssh/known_hosts

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at
# /home/agent/workspace and overrides the working directory there at start.
ENTRYPOINT ["sleep", "infinity"]
