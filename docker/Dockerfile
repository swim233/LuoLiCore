FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig*.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile=false && pnpm build

FROM node:22-bookworm-slim
RUN corepack enable && groupadd -r luoli && useradd -r -g luoli luoli
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-lock.yaml* ./
COPY --from=build /app/apps/bot/package.json ./apps/bot/package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/telegram/package.json ./packages/telegram/package.json
COPY --from=build /app/packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/bot/node_modules ./apps/bot/node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/db/migrations ./packages/db/migrations
RUN mkdir -p packages/shared/dist packages/db/dist packages/core/dist packages/server/dist packages/telegram/dist packages/plugin-sdk/dist \
 && cp -r dist/packages/shared/src/* packages/shared/dist/ \
 && cp -r dist/packages/db/src/* packages/db/dist/ \
 && cp -r dist/packages/core/src/* packages/core/dist/ \
 && cp -r dist/packages/server/src/* packages/server/dist/ \
 && cp -r dist/packages/telegram/src/* packages/telegram/dist/ \
 && cp -r dist/packages/plugin-sdk/src/* packages/plugin-sdk/dist/ \
 && mkdir -p node_modules/@luoli \
 && ln -s /app/packages/shared node_modules/@luoli/shared \
 && ln -s /app/packages/db node_modules/@luoli/db \
 && ln -s /app/packages/core node_modules/@luoli/core \
 && ln -s /app/packages/server node_modules/@luoli/server \
 && ln -s /app/packages/telegram node_modules/@luoli/telegram \
 && ln -s /app/packages/plugin-sdk node_modules/@luoli/plugin-sdk
COPY --from=build /app/packages/webui/dist ./packages/webui/dist
COPY config ./config
COPY memory ./memory
RUN mkdir -p data logs skills plugins && chown -R luoli:luoli /app
USER luoli
EXPOSE 8787
CMD ["node", "dist/apps/bot/src/main.js"]
