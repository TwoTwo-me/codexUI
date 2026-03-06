ARG CODEX_CLI_VERSION=0.110.0

FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build \
  && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
ARG CODEX_CLI_VERSION=0.110.0
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git python3 ripgrep tini \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global @openai/codex@${CODEX_CLI_VERSION} \
  && npm cache clean --force

ENV NODE_ENV=production \
    HOME=/data \
    CODEX_HOME=/data/codex-home \
    CODEXUI_BIND_HOST=0.0.0.0 \
    CODEXUI_PORT=4300 \
    CODEXUI_ADMIN_USERNAME=admin \
    CODEXUI_SKIP_CODEX_LOGIN=true \
    CODEXUI_OPEN_BROWSER=false

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-cli ./dist-cli
COPY docker/hub/entrypoint.sh /usr/local/bin/codexui-entrypoint

RUN chmod +x /usr/local/bin/codexui-entrypoint \
  && mkdir -p /data/codex-home /workspace

EXPOSE 4300
VOLUME ["/data", "/workspace"]

ENTRYPOINT ["/usr/bin/tini", "--", "codexui-entrypoint"]
