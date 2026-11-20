# syntax=docker/dockerfile:1
FROM oven/bun:1.4.2 AS build
RUN apt-get update && apt-get install -y --no-install-recommends git
WORKDIR /build
COPY package.json bun.lock ./
COPY patches patches
COPY apps/cli/package.json apps/cli/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/reader/package.json packages/reader/package.json
COPY scripts/package.json scripts/package.json
RUN bun install --frozen-lockfile
COPY apps/cli/src apps/cli/src
COPY packages/core/src packages/core/src
COPY packages/reader/src packages/reader/src
COPY scripts/build-release.ts scripts/build-release.ts
ARG TACK_COMMIT
RUN TACK_BUILD_COMMIT=$TACK_COMMIT bun scripts/build-release.ts /release

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates ripgrep curl && apt-get clean
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build /release /opt/tack
RUN npm install --global @openai/codex@0.167.1 @anthropic-ai/claude-code@2.1.322
COPY evals/container/mcp-client.mjs /opt/evals/mcp-client.mjs
COPY evals/container/tack-trace.mjs /opt/evals/tack-trace.mjs
RUN mv /opt/tack/bin/tack /opt/tack/bin/tack-real && \
    printf '#!/bin/sh\nexec node /opt/evals/tack-trace.mjs /opt/tack/bin/tack-real "$@"\n' > /opt/tack/bin/tack && \
    chmod 755 /opt/tack/bin/tack && \
    printf 'export PATH="/opt/tack/bin:$PATH"\n' > /etc/profile.d/tack.sh
RUN mkdir -p /auth/codex /auth/claude /session /world /instructions && chown -R node:node /auth /session /world && chmod 700 /auth
ENV PATH="/opt/tack/bin:${PATH}" HOME=/session CODEX_HOME=/auth/codex CLAUDE_CONFIG_DIR=/auth/claude \
    TACK_STATE_DIR=/world/state XDG_CONFIG_HOME=/world/home/.config XDG_CACHE_HOME=/tmp/cache \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1
WORKDIR /session
USER node
CMD ["sleep", "infinity"]
