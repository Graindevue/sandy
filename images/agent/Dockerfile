# Sandy agent sandbox image.
#
# Purpose-built per ADR 0009 (NOT copied from graindevue). A lean image that
# sandcastle launches via @sandy/apple-container-provider to run review Agents.
# Ships the tools the default Agents declare (rg, tree-sitter, git, gh), plus
# `opensrc` for framework-source lookup (ADR 0008), `rtk` for the test-coverage
# output-compression trial, and the agent CLIs the review Agents use —
# claude-code (vendor: claude) and codex (vendor: codex).
#
# Build with `pnpm sandcastle:build-image`, which aligns the image UID/GID to the
# host so bind-mounted worktree files share an owner. The provider verifies the
# image's numeric USER matches the expected UID at runtime.

# rtk is compiled from source because upstream publishes no static (musl) arm64
# Linux binary, and its prebuilt aarch64-gnu binary wants a newer glibc than
# Bookworm ships. Building on the same Bookworm generation links rtk against the
# runtime image's own glibc instead of upgrading the base OS for every Agent.
# The commit pin is tag v0.42.3; Cargo.lock at that commit makes --locked
# reproducible.
FROM rust:1-bookworm AS rtk-builder
ARG RTK_COMMIT=de78d70aee86fe6b7b5c2462820a1b6c250d425b
RUN cargo install --locked --git https://github.com/rtk-ai/rtk --rev "${RTK_COMMIT}" rtk --root /opt/rtk

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

# Global tooling: pnpm, opensrc (framework-source lookup), tree-sitter parser
# deps for the `tree_sitter_query` Agent tool, and the agent CLIs sandcastle's
# providers invoke — claude-code (vendor: claude) and codex (vendor: codex). The
# codex pin tracks the host CLI version (codex-cli 0.134.0) so a host
# `codex login` auth.json stays format-compatible with the in-container
# `codex exec`. Pinned for reproducible builds; bump as needed.
RUN CXXFLAGS="-std=c++20" npm install -g \
  pnpm@10.0.0 \
  opensrc@0.7.2 \
  tree-sitter-cli@0.26.8 \
  tree-sitter@0.21.1 \
  tree-sitter-javascript@0.23.1 \
  tree-sitter-typescript@0.23.2 \
  @anthropic-ai/claude-code@2.1.153 \
  @openai/codex@0.134.0 \
  && CXXFLAGS="-std=c++20" npm rebuild -g tree-sitter tree-sitter-javascript tree-sitter-typescript

# RTK trial for the test-coverage Agent: install the CLI proxy onto the global
# PATH so Reviews never need to download it at runtime. Compiled in the
# rtk-builder stage above (see that stage for why it is built from source).
COPY --from=rtk-builder /opt/rtk/bin/rtk /usr/local/bin/rtk
RUN rtk --version

COPY tree_sitter_query.mjs /usr/local/bin/tree_sitter_query
RUN chmod 0755 /usr/local/bin/tree_sitter_query

# A numeric USER is mandatory: the provider refuses an image whose USER is
# missing or non-numeric, and checks that it matches the expected UID.
USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent

# Sandcastle bind-mounts the git worktree at /home/agent/workspace, overrides the
# working directory there at container start, then execs Agent commands.
ENTRYPOINT ["sleep", "infinity"]
