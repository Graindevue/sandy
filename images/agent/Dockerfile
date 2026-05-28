# Sandy agent sandbox image.
#
# Purpose-built per ADR 0009 (NOT copied from graindevue). A lean image that
# sandcastle launches via @sandy/apple-container-provider to run review Agents.
# Ships the tools the default Agents declare (rg, tree-sitter, git, gh), plus
# `opensrc` for framework-source lookup (ADR 0008) and the Claude agent CLI the
# Phase 1 `logic` Agent uses (vendor: claude).
#
# Build with `pnpm sandcastle:build-image`, which aligns the image UID/GID to the
# host so bind-mounted worktree files share an owner. The provider verifies the
# image's numeric USER matches the expected UID at runtime.
FROM node:24-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  g++ \
  git \
  jq \
  make \
  python3 \
  ripgrep \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI — the `gh` tool the Agents use.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Align the base image's `node` user to the host UID/GID so files created in the
# image and bind-mounted from the host share an owner without a runtime chown.
# Reuse an existing group when present (a macOS primary GID is often 20/staff).
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN set -eux; \
  if ! getent group "$AGENT_GID" >/dev/null; then \
    groupmod -g "$AGENT_GID" node; \
  fi; \
  usermod -u "$AGENT_UID" -g "$AGENT_GID" -d /home/agent -m -l agent node

# Global tooling: pnpm, opensrc (framework-source lookup), tree-sitter (the
# `tree_sitter_query` Agent tool), and the Claude agent CLI (Phase 1 `logic`
# Agent → vendor: claude). Pin exact versions once the e2e setup (issue #9)
# confirms the CLIs sandcastle's providers invoke.
RUN npm install -g \
  pnpm@10 \
  opensrc \
  tree-sitter-cli \
  @anthropic-ai/claude-code

# A numeric USER is mandatory: the provider refuses an image whose USER is
# missing or non-numeric, and checks that it matches the expected UID.
USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent

# Sandcastle bind-mounts the git worktree at /home/agent/workspace, overrides the
# working directory there at container start, then execs Agent commands.
ENTRYPOINT ["sleep", "infinity"]
