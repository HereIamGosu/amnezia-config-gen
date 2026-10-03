FROM node:22-alpine
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
