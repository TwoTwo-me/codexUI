FROM node:20-bookworm-slim AS builder

ARG CODEX_CLI_VERSION=0.110.0

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build


FROM node:20-bookworm-slim AS runner

ARG CODEX_CLI_VERSION=0.110.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini bash \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global @openai/codex@${CODEX_CLI_VERSION} \
  && npm cache clean --force

ENV NODE_ENV=production \
  CODEX_HOME=/data/codex-home \
  CODEXUI_BIND_HOST=0.0.0.0 \
  CODEXUI_PORT=4300 \
  CODEXUI_PASSWORD_MODE=required

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-cli ./dist-cli
COPY docker/hub/start-hub.sh /usr/local/bin/start-codexui-hub

RUN chmod +x /usr/local/bin/start-codexui-hub \
  && mkdir -p /data/codex-home

EXPOSE 4300

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["start-codexui-hub"]
