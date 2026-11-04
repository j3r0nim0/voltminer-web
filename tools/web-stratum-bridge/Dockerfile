# Lightweight Node.js container for VoltMiner Web Stratum Bridge
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY server.mjs origin.mjs ./

# Default environment configuration
ENV NODE_ENV=production \
    BRIDGE_HOST=0.0.0.0 \
    BRIDGE_PORT=8787 \
    BRIDGE_ALLOW_INSECURE=1

EXPOSE 8787

# Run as unprivileged node user
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8787/health || exit 1

CMD ["node", "server.mjs"]
