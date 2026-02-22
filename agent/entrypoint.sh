#!/bin/bash
set -e

# ========================================
# Agent Container Entrypoint Script
# This script runs when a container starts
# ========================================

# Log startup with all environment variables (sanitized)
echo "=========================================="
echo "Starting GitHub Agent Container"
echo "=========================================="
echo "Repo: ${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}"
echo "Issue: #${GITHUB_ISSUE_NUMBER}"
echo "Title: ${GITHUB_ISSUE_TITLE}"
echo "Orchestrator: ${ORCHESTRATOR_URL}"
echo "Container ID: ${CONTAINER_ID}"
echo "=========================================="

# Validate required environment variables
required_vars=(
    "GITHUB_REPO_OWNER"
    "GITHUB_REPO_NAME"
    "GITHUB_ISSUE_NUMBER"
    "GITHUB_ISSUE_TITLE"
    "ANTHROPIC_API_KEY"
    "GITHUB_TOKEN"
    "ORCHESTRATOR_URL"
    "CONTAINER_ID"
)

missing_vars=()
for var in "${required_vars[@]}"; do
    if [[ -z "${!var}" ]]; then
        missing_vars+=("$var")
    fi
done

if [[ ${#missing_vars[@]} -gt 0 ]]; then
    echo "ERROR: Missing required environment variables: ${missing_vars[*]}"
    exit 1
fi

# Function to send status updates to orchestrator
send_status() {
    local status="$1"
    local message="$2"
    local details="${3:-{}}"

    local payload=$(cat <<EOF
{
  "container_id": "${CONTAINER_ID}",
  "status": "${status}",
  "message": "${message}",
  "details": ${details},
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)

    echo "Sending status: ${status} - ${message}"

    # Try to send status to orchestrator (fire and forget)
    curl -X POST \
        -H "Content-Type: application/json" \
        -d "$payload" \
        "${ORCHESTRATOR_URL}/api/status" \
        --max-time 5 \
        --silent \
        || echo "Warning: Failed to send status update to orchestrator"
}

# Function to send heartbeat
send_heartbeat() {
    send_status "heartbeat" "Agent is running" "{}"
}

# Send initial status
send_status "starting" "Container started, initializing..." "{}"

# Create a unique branch name
TIMESTAMP=$(date +%s)
BRANCH_NAME="ai-agent-issue-${GITHUB_ISSUE_NUMBER}-${TIMESTAMP}"
export BRANCH_NAME

# Set git configuration (non-interactive)
git config --global user.name "AI Agent"
git config --global user.email "ai-agent@autogen.local"
git config --global core.autoCRLF false
git config --global init.defaultBranch main
# Prevent any interactive prompts
git config --global core.askPass true

# Configure npm for non-interactive mode
npm config set yes true
npm config --global set progress false
npm config --global set spin false

# Configure Python/pip for non-interactive mode
export PIP_YES=true
export PIP_DISABLE_PIP_VERSION_CHECK=1
export PIP_NO_WARN_SCRIPT_LOCATION=1

# Other tools
export DEBIAN_FRONTEND=noninteractive
export AUTO_CONFIRM=true

# Clone the repository
echo "Cloning repository..."
send_status "cloning" "Cloning repository..." "{}"

REPO_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}.git"

if git clone "$REPO_URL" /workspace/repo; then
    echo "Repository cloned successfully"
else
    send_status "error" "Failed to clone repository" '{"error": "clone_failed"}'
    exit 1
fi

cd /workspace/repo

# Create and checkout branch
echo "Creating branch: ${BRANCH_NAME}"
git checkout -b "$BRANCH_NAME"

# Run the agent
echo "Starting agent process..."
send_status "analyzing" "Analyzing issue and preparing solution..." "{}"

# Execute the agent Node.js process
node /usr/src/agent/dist/agent.js

# Capture exit status
EXIT_STATUS=$?

if [[ $EXIT_STATUS -eq 0 ]]; then
    echo "Agent completed successfully"
    send_status "done" "Agent completed successfully" "{}"
else
    echo "Agent failed with exit code: ${EXIT_STATUS}"
    send_status "error" "Agent failed with exit code: ${EXIT_STATUS}" "{\"exit_code\": ${EXIT_STATUS}}"
fi

exit $EXIT_STATUS
