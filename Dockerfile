FROM node:20-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    ALLOW_LIVE_MODE=false

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev

COPY backend ./backend
COPY frontend ./frontend

RUN mkdir -p /app/backend/past_trades \
    && chown -R node:node /app

USER node
WORKDIR /app/backend

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:4000/healthz >/dev/null || exit 1

CMD ["npm", "start"]
