FROM ubuntu:24.04

# Avoid interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install core dependencies in smaller batches for better reliability
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x using NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install git and other development tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    git \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Install Playwright and browsers (optional - can comment out if issues persist)
RUN npx playwright install --with-deps chromium || echo "Playwright install failed, continuing..."

# Verify installations
RUN node --version && npm --version && git --version && python3 --version

# Create workspace directory
WORKDIR /workspace

# Create agent source directory
RUN mkdir -p /usr/src/agent

# Copy agent package files for dependency installation
COPY agent/package.json agent/package-lock.json* /usr/src/agent/

# Install agent dependencies
WORKDIR /usr/src/agent
RUN npm ci --production || npm install --production

# Copy agent source code
COPY agent/src/ /usr/src/agent/src/

# Build agent code
RUN npm run build || echo "Build failed, continuing..."

# Create workspace directory for repos
WORKDIR /workspace

# Set up environment variables
ENV NODE_ENV=production
ENV PATH="/usr/src/agent/dist:${PATH}"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "console.log('healthy')" || exit 1

# Default entrypoint will be overridden by agent-specific entrypoint
ENTRYPOINT ["/bin/bash"]
