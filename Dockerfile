# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS frontend-build
WORKDIR /build/frontweb
COPY frontweb/package*.json ./
RUN npm ci
COPY frontweb/ ./
ARG VITE_PUBLIC_PLATFORM_MODE=true
ENV VITE_PUBLIC_PLATFORM_MODE=${VITE_PUBLIC_PLATFORM_MODE}
RUN npm run build

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS backend-dependencies
WORKDIR /build/backend-node
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*
COPY backend-node/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend-node
ENV NODE_ENV=production \
    PORT=5679 \
    WEB_DIST_PATH=/app/frontweb/dist

COPY --from=backend-dependencies /build/backend-node/node_modules ./node_modules
COPY backend-node/ ./
COPY --from=frontend-build /build/frontweb/dist /app/frontweb/dist

RUN mkdir -p /var/lib/molimama/storage /var/lib/molimama/backups \
    && chown -R node:node /app /var/lib/molimama

USER node
EXPOSE 5679
VOLUME ["/var/lib/molimama"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5679/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "src/server.js"]
