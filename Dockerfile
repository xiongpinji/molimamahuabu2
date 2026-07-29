# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS frontend-build
WORKDIR /build/frontweb
COPY frontweb/package*.json ./
RUN npm ci
COPY frontweb/ ./
ARG VITE_PUBLIC_PLATFORM_MODE=true
ENV VITE_PUBLIC_PLATFORM_MODE=${VITE_PUBLIC_PLATFORM_MODE}
RUN npm run build:public

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS backend-dependencies
WORKDIR /build/backend-node
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*
COPY backend-node/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS rembg-dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY deploy/rembg/requirements.lock /tmp/rembg-requirements.lock
RUN python3 -m venv /opt/rembg \
    && /opt/rembg/bin/pip install --no-cache-dir --require-hashes -r /tmp/rembg-requirements.lock
COPY deploy/rembg/rembg-cpu /opt/rembg/bin/rembg-cpu
RUN chmod 0555 /opt/rembg/bin/rembg-cpu \
    && /opt/rembg/bin/rembg-cpu --version \
    && mkdir -p /opt/rembg-models \
    && curl --fail --location --retry 3 \
      --output /opt/rembg-models/u2netp.onnx \
      https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx \
    && echo "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8  /opt/rembg-models/u2netp.onnx" \
      | sha256sum --check -

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend-node
ENV NODE_ENV=production \
    PORT=5679 \
    WEB_DIST_PATH=/app/frontweb/dist \
    IMAGE_TOOL_REMBG_PATH=/opt/rembg/bin/rembg-cpu \
    IMAGE_TOOL_REMBG_VERSION=2.0.77 \
    IMAGE_TOOL_REMBG_MODEL=u2netp \
    IMAGE_TOOL_REMBG_MODEL_HOME=/opt/rembg-models \
    U2NET_HOME=/opt/rembg-models \
    IMAGE_TOOL_REMBG_MAX_CONCURRENCY=1 \
    IMAGE_TOOL_REMBG_MAX_TENANT_CONCURRENCY=1 \
    OMP_NUM_THREADS=1

COPY --from=backend-dependencies /build/backend-node/node_modules ./node_modules
COPY --from=rembg-dependencies /opt/rembg /opt/rembg
COPY --from=rembg-dependencies /opt/rembg-models /opt/rembg-models
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
