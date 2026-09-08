FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY team-web ./team-web
RUN npm run team:build

FROM node:24-bookworm-slim
ENV NODE_ENV=production TEAM_AUTH_MODE=feishu TEAM_HOST=0.0.0.0 TEAM_PORT=4318 TEAM_DB_PATH=/data/team.sqlite
WORKDIR /app
COPY --from=build /app/team-web/dist ./team-web/dist
COPY team-web/server ./team-web/server
COPY package.json LICENSE NOTICE.md ./
COPY scripts/team-backup.mjs ./scripts/team-backup.mjs
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 4318
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:4318/api/health',{headers:{host:new URL(process.env.TEAM_PUBLIC_URL).host}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "team-web/server/server.mjs"]
