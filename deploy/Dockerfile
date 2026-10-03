# Readable tag plus pinned digest (multi-arch index): the digest is what gets pulled.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ARG APP_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/HereIamGosu/amnezia-config-gen" \
      org.opencontainers.image.revision="${APP_REVISION}"
ENV NODE_ENV=production PORT=3000 APP_REVISION=${APP_REVISION}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY vercel.json server.js ./
COPY api ./api
COPY src ./src
COPY public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/status >/dev/null || exit 1
CMD ["node", "server.js"]
