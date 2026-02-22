# Orchestrator service container
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY orchestrator/package.json orchestrator/package-lock.json* ./
RUN npm ci --production

# Copy source and config
COPY orchestrator/src/ ./src/
COPY config/ ./config/

# Build TypeScript
RUN npm run build

# Expose webhook port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "dist/index.js"]
