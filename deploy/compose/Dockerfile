# syntax=docker/dockerfile:1.7
# Bunnyboard images. Build context is the repo root (docker-compose.yml sets it).
#   target board    the board server (server/dist/standalone.cjs) and the built canvas
#   target runtime  the agent runtime: Paseo daemon plus the claude and codex CLIs
#
# Behind a TLS-intercepting proxy, pass its CA as a build secret:
#   docker compose build --secret ... (see README, "Corporate proxies")
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
COPY canvas/package.json canvas/package-lock.json canvas/.npmrc canvas/
RUN --mount=type=secret,id=extra_ca,required=false --mount=type=cache,target=/root/.npm \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --no-audit --no-fund && npm ci --prefix canvas --no-audit --no-fund
COPY . .
# Restrictive checkout umasks must not make shipped source unreadable to USER node.
# a+rX preserves executable files without making ordinary source executable.
RUN chmod -R a+rX /src
# The tldraw licence key comes in as a build secret (compose: tldraw_license), so it is not
# stored in the image history; vite inlines VITE_TLDRAW_LICENSE_KEY into the canvas. No key:
# tldraw enforces its licence at runtime. The value is never printed.
RUN --mount=type=secret,id=tldraw_license,required=false \
    if [ -s /run/secrets/tldraw_license ]; then \
      export VITE_TLDRAW_LICENSE_KEY="$(tr -d '\r\n' < /run/secrets/tldraw_license)"; \
      echo "canvas: building with a tldraw licence key"; \
    else echo "canvas: building without a tldraw licence key"; fi; \
    npm run build
# Runtime dependencies only: board-mcp.mjs needs @modelcontextprotocol/sdk; the server
# bundles are self-contained apart from ws's optional native add-ons.
RUN --mount=type=secret,id=extra_ca,required=false --mount=type=cache,target=/root/.npm \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    mkdir /prod && cp package.json package-lock.json .npmrc /prod/ && cd /prod && npm ci --omit=dev --no-audit --no-fund

# Both images keep the app at /app, so the board can hand agents the same board-mcp.mjs
# path that exists in the runtime container.
FROM scratch AS app
COPY --from=build /prod/node_modules /app/node_modules
COPY --from=build /src/package.json /src/paseo-plugin.json /app/
COPY --from=build /src/server/dist /app/server/dist
COPY --from=build /src/canvas/dist /app/canvas/dist
COPY --from=build /src/mcp /app/mcp

FROM node:${NODE_VERSION}-bookworm-slim AS board
ENV NODE_ENV=production \
    BUNNY_STATE=/data/board \
    BOARD_PORT=8793
COPY --from=app /app /app
RUN mkdir -p /data/board /workspaces /app/server/dist/.compile-cache \
 && chown -R node:node /data /workspaces /app/server/dist/.compile-cache
USER node
WORKDIR /app
EXPOSE 8793
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.BOARD_PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/dist/standalone.cjs"]

# The full Debian image: agents need git, ssh, python3, make and friends.
FROM node:${NODE_VERSION}-bookworm AS runtime
ARG PASEO_VERSION=0.11.4
ARG CLAUDE_CODE_VERSION=2.1.314
ARG CODEX_VERSION=0.166.0
RUN --mount=type=secret,id=extra_ca,required=false --mount=type=cache,target=/root/.npm \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm install -g --no-audit --no-fund \
      @getpaseo/cli@${PASEO_VERSION} \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @openai/codex@${CODEX_VERSION}
COPY --from=app /app /app
COPY deploy/compose/runtime-entrypoint.sh /usr/local/bin/runtime-entrypoint
# One volume holds every agent login (agent-auth), one the daemon's state (paseo-home).
ENV HOME=/home/node \
    PASEO_HOME=/home/node/.paseo \
    CLAUDE_CONFIG_DIR=/home/node/.agent-auth/claude \
    CODEX_HOME=/home/node/.agent-auth/codex \
    PASEO_LISTEN=0.0.0.0:6767 \
    PASEO_RELAY_ENABLED=false \
    PASEO_DICTATION_ENABLED=false \
    PASEO_VOICE_MODE_ENABLED=false
RUN chmod 0755 /usr/local/bin/runtime-entrypoint \
 && mkdir -p /home/node/.paseo /home/node/.agent-auth/claude /home/node/.agent-auth/codex /data/board /workspaces \
 && chown -R node:node /home/node /data /workspaces
USER node
WORKDIR /workspaces
EXPOSE 6767
ENTRYPOINT ["runtime-entrypoint"]
CMD ["daemon"]
