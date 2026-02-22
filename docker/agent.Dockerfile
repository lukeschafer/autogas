# Runtime agent image - uses the base image
FROM ghcr-agent:latest

# Copy the entrypoint script
COPY agent/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Set up a non-root user for running the agent
RUN useradd -m -u 1000 -s /bin/bash agent && \
    chown -R agent:agent /workspace /usr/src/agent

# Switch to non-root user
USER agent

# Set working directory
WORKDIR /workspace

# Environment variables (will be overridden by orchestrator)
ENV GITHUB_REPO_OWNER=""
ENV GITHUB_REPO_NAME=""
ENV GITHUB_ISSUE_NUMBER=""
ENV GITHUB_ISSUE_TITLE=""
ENV GITHUB_ISSUE_BODY=""
ENV ANTHROPIC_API_KEY=""
ENV GITHUB_TOKEN=""
ENV ORCHESTRATOR_URL=""
ENV CONTAINER_ID=""

# Set entrypoint
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Default command (agent will handle this)
CMD []
