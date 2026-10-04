FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# --- Production image ---
FROM node:22-alpine AS production

WORKDIR /app

# Security: run as non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Create persistent storage directory with proper permissions
RUN mkdir -p /app/data/wa-auth && chown -R appuser:appgroup /app/data

USER appuser

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/server.js"]
