FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    TRANSCODE_ENABLED=true \
    TRANSCODE_ACCEL=auto \
    FFMPEG_PATH=ffmpeg

# Coffee Lake 的完整 H.264 编码功能需要含媒体着色器的 iHD 驱动。
RUN set -eu; \
    if [ "$(dpkg --print-architecture)" = amd64 ]; then \
      sed -i 's/Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates ffmpeg chromium xvfb xauth; \
    if [ "$(dpkg --print-architecture)" = amd64 ]; then \
      apt-get install -y --no-install-recommends intel-media-va-driver-non-free mesa-vulkan-drivers; \
    fi; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node web/package.json web/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node web/ ./
COPY --chown=node:node LICENSE ./LICENSE
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
