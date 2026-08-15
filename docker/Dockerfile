FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig*.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile=false && pnpm build

FROM node:22-bookworm-slim
RUN corepack enable
# sandbox.mode=docker 时 Sandbox 直接 spawn `docker`（先 `docker version` 探活）。容器形态下挂了
# /var/run/docker.sock 还不够，镜像里得有客户端 —— 缺了它 probe 报 ENOENT，执行类工具全部 fail-closed
# 消失。只装 docker-ce-cli，不装 daemon；用官方源而不是 docker.io，才能跟着宿主 arch 走。
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# scripts/postbuild.ts 已经把产物放到各包 exports 声明的 packages/<name>/dist/，
# 根 node_modules/@luoli/* 由 pnpm 按根 package.json 的 workspace 依赖生成 ——
# 宿主 `pnpm start` 和容器共用同一套布局，这里整目录搬过来即可。
COPY --from=build /app/package.json /app/pnpm-lock.yaml* /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/dist ./dist
COPY config ./config
COPY memory ./memory
# 用基础镜像自带的 node 用户（uid/gid 1000）而不是新建系统用户：./data 等目录是宿主 bind mount，
# 属主是宿主用户（通常 1000），uid 对不上就是启动即 EACCES mkdir /app/data/workspace；而且沙箱容器
# 固定跑 --user=1000:1000，uid 一致才不会出现「bash 写的文件应用改不动」。宿主用户不是 1000 时，
# 在 docker-compose.yml 里用 user: "${UID}:${GID}" 覆盖。
RUN mkdir -p data logs skills plugins && chown -R node:node /app
USER node
EXPOSE 8787
CMD ["node", "dist/apps/bot/src/main.js"]
