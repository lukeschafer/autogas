# Autonomous GitHub Agent System

An autonomous agent system that watches GitHub repositories for new issues and spawns isolated Docker containers to develop solutions using Claude Code. Each agent creates pull requests and iterates based on review feedback.

## 🚀 Fully Autonomous Operation

**No user input required!** The system runs completely hands-free:

- ✅ **No confirmations** - All tools run in non-interactive mode
- ✅ **Auto-approvals** - npm, git, and other tools auto-confirm
- ✅ **Unattended execution** - Claude Code runs without prompts
- ✅ **Background processing** - Works while you sleep

Just trigger it with a comment and come back to a completed PR.

## Two Operating Modes

### 🔄 Polling Mode (Recommended for Local Development)

The orchestrator periodically polls GitHub to check for:
- New issues with trigger phrases in the body
- New comments on issues that contain trigger phrases
- PR status changes (closed, reviews)

**No webhook setup required!** Just configure your repositories and run.

### 🔔 Webhook Mode (For Production)

GitHub sends real-time webhook events when issues/comments/PRs change.
Requires a public URL and webhook configuration in your GitHub repositories.

The system defaults to **polling mode** for easy local development.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Orchestrator Service                        │
│  ┌──────────────┐  ┌─────────────┐  ┌──────────────────┐       │
│  │ Webhook      │  │ Container   │  │ State Manager    │       │
│  │ Server       │  │ Manager     │  │ (Active Issues)  │       │
│  └──────────────┘  └─────────────┘  └──────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Docker Containers                           │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐           │
│  │ Agent 1 │  │ Agent 2 │  │ Agent 3 │  │ Agent 4 │  ...       │
│  │ (Issue  │  │ (Issue  │  │ (Issue  │  │ (Issue  │           │
│  │  #42)   │  │  #47)   │  │  #51)   │  │  #55)   │           │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘           │
└─────────────────────────────────────────────────────────────────┘
```

## Features

- **Comment-based triggering**: Agents start when someone comments a trigger phrase (e.g., `@bot take this`)
- **Isolated environments**: Each agent runs in its own Docker container
- **Parallel processing**: Run 3-5 agents concurrently
- **Feedback loop**: Agents iterate on PR review comments
- **Auto-cleanup**: Containers are removed when PRs are closed
- **Status reporting**: Real-time updates posted to issues
- **Browser automation**: Playwright + Chromium included for UI testing and web scraping

## Quick Start (Polling Mode - Recommended)

### Prerequisites

- Docker installed and running
- Node.js 20+ (for local development)
- GitHub Personal Access Token with `repo` scope
- Anthropic API Key

### 1. Clone and Install

```bash
git clone <repo-url>
cd autogen
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
WEBHOOK_SECRET=any_random_string_here
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Polling mode is enabled by default - no webhooks needed!
USE_POLLING=true
POLL_INTERVAL_SECONDS=60  # Check GitHub every 60 seconds
```

### 3. Update Repository Configuration

Edit `config/config.yaml`:

```yaml
repos:
  - owner: "your-org"
    name: "your-repo"
    trigger_comment: "@bot take this"
    enabled: true
```

**Optional: Create a local config** (not checked in)

For local development, create `config/config.local.yaml` to override settings:

```bash
cp config/config.local.yaml.example config/config.local.yaml
```

Local config deep-merges with `config.yaml` so you only need to specify what you want to override. This file is gitignored and perfect for:
- Your personal test repositories
- Faster polling intervals for testing
- Custom prompts for experimentation
- Different container limits for your machine

### 4. Build the Base Docker Image

```bash
npm run build:docker:base
```

This builds the `ghcr-agent:latest` image with:
- Ubuntu 24.04
- Node.js 20.x
- Python 3
- Git
- Claude Code CLI
- **Playwright** with Chromium (for browser automation/testing)

### 5. Start the Orchestrator

```bash
npm run dev:orchestrator
```

You'll see:
```
[INFO] Starting Autonomous GitHub Agent Orchestrator
[INFO] Initializing in POLLING mode - no webhook required
[INFO] Max concurrent agents: 5
[INFO] Watching 1 repositories
[INFO] Starting GitHub poller (interval: 30s)
[INFO] Orchestrator started successfully
```

### 6. Trigger an Agent

In a watched repository:
1. Create a new issue (or find an existing one)
2. Add a comment with your trigger phrase:

```
@bot take this
```

The orchestrator will:
1. Detect the trigger on the next poll (within 60 seconds)
2. Spawn a Docker container
3. The agent will clone, analyze, develop, test, and create a PR
4. Post status updates to the issue

**That's it!** No webhook configuration needed.

## Project Structure

```
autogen/
├── orchestrator/                 # Main orchestrator service
│   ├── src/
│   │   ├── webhooks.ts          # GitHub webhook server
│   │   ├── poller.ts            # GitHub polling client (alternative to webhooks)
│   │   ├── container-manager.ts # Docker container lifecycle
│   │   ├── state-manager.ts     # Track active issues/containers
│   │   ├── github-client.ts     # GitHub API wrapper
│   │   ├── types.ts             # Shared types
│   │   ├── config.ts            # Configuration loader
│   │   ├── logger.ts            # Logging utility
│   │   └── index.ts             # Main entry point
│   ├── package.json
│   └── tsconfig.json
│
├── agent/                        # Code running INSIDE containers
│   ├── src/
│   │   ├── agent.ts             # Main agent logic
│   │   ├── claude-wrapper.ts    # Claude Code interface
│   │   ├── git-operations.ts    # Branch, commit, PR operations
│   │   ├── types.ts             # Agent types
│   │   └── logger.ts            # Logging utility
│   ├── package.json
│   ├── entrypoint.sh            # Container startup script
│   └── tsconfig.json
│
├── docker/
│   ├── base.Dockerfile          # Base image with dev tools
│   ├── agent.Dockerfile         # Runtime agent image
│   ├── orchestrator.Dockerfile  # Orchestrator service image
│   └── docker-compose.yml       # Development compose file
│
├── config/
│   └── config.yaml              # Repos to watch, settings
│
├── .env.example                  # Environment template
└── README.md
```

## Webhook Mode (For Production)

If you prefer real-time events or are deploying to production, you can use webhook mode instead of polling:

### 1. Set environment variable

```env
USE_POLLING=false
PUBLIC_URL=https://your-domain.com
SERVER_PORT=3000
```

### 2. Set up GitHub Webhook

In your GitHub repository settings:
1. Go to Settings → Webhooks → Add webhook
2. Payload URL: `https://your-domain.com/webhook/github`
3. Content type: `application/json`
4. Secret: Use the same `WEBHOOK_SECRET` from your `.env`
5. Events: Select "Issues", "Issue comments", "Pull requests", "Pull request reviews"

### 3. Start the orchestrator

```bash
npm run dev:orchestrator
```

The orchestrator will log the webhook URL for verification.

**Note:** For local development with webhooks, you'll need to use [ngrok](https://ngrok.com/) or [smee.io](https://smee.io/) to tunnel requests to your local machine.

## Workflow

1. **Trigger**: User comments trigger phrase on an issue
2. **Queue**: Orchestrator checks capacity (max 5 concurrent)
3. **Spawn**: Docker container created with issue context
4. **Analysis**: Agent explores codebase and understands requirements
5. **Development**: Claude Code implements the solution
6. **Testing**: Agent runs tests if applicable
7. **PR**: Pull request created with descriptive body
8. **Iteration**: Agent monitors for review feedback and iterates
9. **Cleanup**: Container removed when PR closes

## Configuration Options

### Local Configuration (config.local.yaml)

For local development, create `config/config.local.yaml` to override settings without committing them:

```yaml
# Override just the repos for local testing
repos:
  - owner: "my-username"
    name: "my-test-repo"
    trigger_comment: "@bot test"
    enabled: true
```

**How it works:**
- `config/config.local.yaml` is gitignored
- Settings are deep-merged with `config/config.yaml`
- Local settings take precedence
- Perfect for personal test repos and experimentation

**Copy the example:**
```bash
cp config/config.local.yaml.example config/config.local.yaml
```

### Orchestrator Settings

| Option | Default | Description |
|--------|---------|-------------|
| `USE_POLLING` | `true` | Use polling mode (true) or webhook mode (false) |
| `POLL_INTERVAL_SECONDS` | 60 | How often to poll GitHub (polling mode only) |
| `containers.max_concurrent` | 5 | Maximum parallel agents |
| `containers.memory_limit` | 4g | Memory per container |
| `containers.cpu_limit` | 2 | CPU cores per container |
| `server.port` | 3000 | Webhook server port (webhook mode only) |

### Rate Limiting

GitHub's API allows 5,000 requests/hour for authenticated tokens. The poller:

- Automatically checks rate limits before each poll cycle
- Pauses if fewer than 10% of requests remain
- Logs rate limit status periodically

**Approximate usage** with default settings:
- ~5-10 requests per repository per poll cycle
- With 5 repos at 60s intervals: ~25-50 requests/minute
- Well within the 5,000/hour limit (~83 requests/minute allowed)

### Per-Repository Settings

```yaml
repos:
  - owner: "org-name"
    name: "repo-name"
    trigger_comment: "@bot take this"  # Custom trigger phrase
    enabled: true                      # Enable/disable watching
    prompt_template: "strict-typescript"  # Use a named prompt template
```

## Custom Prompt Templates

You can define custom prompts to control how Claude works on issues. This lets you enforce your team's coding standards and workflows.

### Defining Prompts

**Inline prompt (in config.yaml):**
```yaml
prompts:
  default: |
    You are an expert developer. Solve this issue:
    Title: {{issue_title}}
    {{issue_body}}
    Follow best practices and write tests.
```

**External file reference:**
```yaml
prompts:
  default: "prompts/strict-typescript.md"
  frontend: "prompts/frontend-react.md"
```

### Template Variables

Available variables in prompts:
- `{{issue_title}}` - The issue title
- `{{issue_body}}` - The issue description
- `{{repo_owner}}` - Repository owner
- `{{repo_name}}` - Repository name
- `{{issue_number}}` - Issue number
- `{{branch_name}}` - Branch name

### Conditional Blocks

```yaml
{{#if issue_body}}
This issue has a description: {{issue_body}}
{{/if}}
```

### Included Prompt Templates

The repo includes example prompts in `config/prompts/`:

- **`strict-typescript.md`** - Strict TypeScript development with type safety requirements
- **`frontend-react.md`** - React/TypeScript component development guidelines
- **`minimal.md`** - Minimal prompt for quick fixes

Use them in your config:
```yaml
repos:
  - owner: "my-org"
    name: "backend-api"
    prompt_template: "strict-typescript"

  - owner: "my-org"
    name: "frontend-app"
    prompt_template: "frontend-react"
```

### Review Feedback Prompts

You can also customize how agents handle review feedback:
```yaml
prompts:
  review_feedback: |
    Address this feedback: {{feedback}}
    Make sure all tests pass before committing.
```

## Development

### Building

```bash
npm run build          # Build all packages
npm run build --workspace=orchestrator  # Build orchestrator only
npm run build --workspace=agent         # Build agent only
```

### Running

```bash
npm run dev:orchestrator  # Start orchestrator
npm run dev:agent         # Start agent (for testing)
```

### Docker

```bash
npm run build:docker:base    # Build base agent image
npm run build:docker:agent   # Build runtime agent image
docker-compose -f docker/docker-compose.yml up  # Full stack
```

## Monitoring

### Orchestrator Logs

```bash
tail -f orchestrator.log
```

### Container Status

```bash
docker ps -a --filter "label=autogen.managed=true"
```

### View Container Logs

```bash
docker logs <container-id>
```

### API Endpoints

- `GET /health` - Health check
- `POST /api/status` - Agent status updates
- `GET /api/stats` - Orchestrator statistics

## Troubleshooting

### Container Won't Start

1. Check Docker is running: `docker ps`
2. Verify base image exists: `docker images | grep ghcr-agent`
3. Check orchestrator logs for errors

### Agent Not Creating PR

1. Check GitHub token has `repo` scope
2. Verify branch protection rules allow agent's branch
3. Check container logs: `docker logs <container-id>`

### Webhook Not Received

1. Verify webhook URL is accessible
2. Check webhook secret matches
3. Review GitHub webhook delivery logs in repo settings

### Claude Code Errors

1. Verify API key is valid
2. Check API quota/billing
3. Ensure prompt is within context limits

### Playwright in Docker

Playwright runs in headless mode by default in containers. If you need to debug:

```javascript
// In your code or when asking Claude to use Playwright
const browser = await playwright.chromium.launch({
  headless: true  // Always true in Docker
});

// Or use the CLI tool
npx playwright codegen --target=javascript https://example.com
```

The container includes all system libraries needed for Chromium to run.

### Autonomous Mode Configuration

The system is configured to run without any user interaction:

**Environment variables set:**
```bash
CI=true                          # Signals CI mode to tools
CLAUDE_NON_INTERACTIVE=true     # Claude Code auto-mode
AUTO_CONFIRM=true               # Auto-confirm for all prompts
DEBIAN_FRONTEND=noninteractive  # No apt prompts
```

**Git configuration:**
```
core.askPass=true               # No password prompts
GIT_TERMINAL_PROMPT=0           # No interactive git prompts
```

**npm configuration:**
```
npm config set yes true          # Auto-confirm all npm commands
```

**If you see any prompts**, it means something is misconfigured. Check:
1. All environment variables are being passed through
2. The entrypoint script runs before the agent
3. No `.gitconfig` or `.npmrc` in the repo overrides settings

## Security Considerations

- **API Keys**: Store in environment variables, never commit
- **Webhook Secrets**: Use strong random strings
- **Token Scopes**: Use minimal required permissions
- **Container Isolation**: Agents run in isolated containers
- **Network**: Consider running orchestrator in private VPC for production

## Production Deployment

### Docker Compose

```bash
docker-compose -f docker/docker-compose.yml up -d
```

### Kubernetes (Future)

The architecture supports container orchestration:
- Deploy orchestrator as Deployment
- Use ConfigMaps for configuration
- Secrets for API keys
- Service for webhook endpoint

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT

## Support

For issues and questions, please create an issue in the repository.
