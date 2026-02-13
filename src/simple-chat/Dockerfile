FROM node:22-bookworm AS build

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/docs/reference/templates ./docs/reference/templates
COPY --from=build /app/skills ./skills
COPY --from=build /app/extensions ./extensions

RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV SIMPLE_CHAT_HOST=0.0.0.0
ENV SIMPLE_CHAT_PORT=3000
ENV OPENCLAW_BUNDLED_PLUGINS_DIR=/app/extensions

EXPOSE 3000

CMD ["node", "dist/simple-chat/server.js"]
