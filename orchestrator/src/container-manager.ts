/**
 * Container Manager
 * Handles Docker container lifecycle for agent containers
 */

import Docker from 'dockerode';
import { ActiveIssue, OrchestratorConfig } from './types';

export class ContainerManager {
  private docker: Docker;
  private config: OrchestratorConfig;

  constructor(config: OrchestratorConfig) {
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
    this.config = config;
  }

  /**
   * Start a new agent container for an issue
   */
  async startAgentContainer(issue: ActiveIssue): Promise<string> {
    const containerName = this.generateContainerName(issue);

    // Find the repo config to get custom prompt template
    const repoConfig = this.config.repos.find(
      r => r.owner.toLowerCase() === issue.repoOwner.toLowerCase() &&
           r.name.toLowerCase() === issue.repoName.toLowerCase()
    );

    // Get the prompt template for this repo (or use default)
    const promptTemplate = this.getPromptTemplate(repoConfig);
    const reviewFeedbackTemplate = this.config.claude.prompts?.reviewFeedback || '';

    // Prepare environment variables
    const env = [
      `GITHUB_REPO_OWNER=${issue.repoOwner}`,
      `GITHUB_REPO_NAME=${issue.repoName}`,
      `GITHUB_ISSUE_NUMBER=${issue.issueNumber}`,
      `GITHUB_ISSUE_TITLE=${this.escapeEnvVar(issue.issueTitle)}`,
      `GITHUB_ISSUE_BODY=${this.escapeEnvVar(issue.issueBody)}`,
      `ANTHROPIC_API_KEY=${this.config.claude.apiKey}`,
      `GITHUB_TOKEN=${this.config.github.token}`,
      `ORCHESTRATOR_URL=${this.config.server.publicUrl}`,
      `CONTAINER_ID=${containerName}`,
      `NODE_ENV=production`,
      `PROMPT_TEMPLATE=${this.escapeEnvVar(promptTemplate)}`,
      `REVIEW_FEEDBACK_TEMPLATE=${this.escapeEnvVar(reviewFeedbackTemplate)}`,
      // Force non-interactive mode for all tools
      `CI=true`,
      `CLAUDE_NON_INTERACTIVE=true`,
      `DEBIAN_FRONTEND=noninteractive`,
      `AUTO_CONFIRM=true`
    ];

    // Add custom container env vars from config (for local overrides, testing, etc.)
    if (this.config.containers.env) {
      for (const [key, value] of Object.entries(this.config.containers.env)) {
        env.push(`${key}=${this.escapeEnvVar(value)}`);
      }
    }

    // Container configuration
    const containerConfig: Docker.ContainerCreateOptions = {
      name: containerName,
      Image: this.config.containers.baseImage,
      Env: env,
      HostConfig: {
        NetworkMode: this.config.containers.network,
        Memory: this.parseMemoryLimit(this.config.containers.memoryLimit),
        NanoCpus: this.parseCpuLimit(this.config.containers.cpuLimit),
        AutoRemove: false // We'll handle cleanup manually
      },
      Labels: {
        'autogen.managed': 'true',
        'autogen.type': 'agent',
        'autogen.repo': `${issue.repoOwner}/${issue.repoName}`,
        'autogen.issue': issue.issueNumber.toString(),
        'autogen.started': issue.startedAt.toISOString()
      }
    };

    try {
      // Pull the image if not exists
      await this.ensureImage(this.config.containers.baseImage);

      // Create and start the container
      const container = await this.docker.createContainer(containerConfig);
      await container.start();

      return container.id;
    } catch (error) {
      throw new Error(`Failed to start container: ${error}`);
    }
  }

  /**
   * Stop and remove a container
   */
  async removeContainer(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);

      try {
        await container.stop({ t: 10 }); // 10 second grace period
      } catch (error) {
        // Container might already be stopped
      }

      await container.remove({ force: true });
    } catch (error) {
      throw new Error(`Failed to remove container ${containerId}: ${error}`);
    }
  }

  /**
   * Get container logs
   */
  async getLogs(containerId: string, tail: number = 100): Promise<string> {
    try {
      const container = this.docker.getContainer(containerId);
      const logs = await container.logs({
        stdout: true,
        stderr: true,
        tail: tail,
        timestamps: true
      });
      return logs.toString('utf-8');
    } catch (error) {
      return `Error reading logs: ${error}`;
    }
  }

  /**
   * Send a signal to a running container
   */
  async sendSignal(containerId: string, signal: NodeJS.Signals): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.kill({ signal });
    } catch (error) {
      throw new Error(`Failed to send signal ${signal} to container ${containerId}: ${error}`);
    }
  }

  /**
   * Get container status
   */
  async getContainerStatus(containerId: string): Promise<string> {
    try {
      const container = this.docker.getContainer(containerId);
      const info = await container.inspect();
      return info.State.Status;
    } catch (error) {
      return 'unknown';
    }
  }

  /**
   * List all containers managed by this orchestrator
   */
  async listActiveContainers(): Promise<Array<{ id: string; name: string; status: string }>> {
    try {
      const containers = await this.docker.listContainers({ all: true });

      return containers
        .filter(c => c.Labels?.['autogen.managed'] === 'true')
        .map(c => ({
          id: c.Id,
          name: c.Names[0].replace(/^\//, ''),
          status: c.Status
        }));
    } catch (error) {
      throw new Error(`Failed to list containers: ${error}`);
    }
  }

  /**
   * Cleanup stopped containers
   */
  async cleanupStoppedContainers(): Promise<number> {
    const containers = await this.docker.listContainers({ all: true });
    const stoppedManagedContainers = containers.filter(
      c => c.Labels?.['autogen.managed'] === 'true' &&
           (c.State === 'exited' || c.State === 'dead')
    );

    for (const containerInfo of stoppedManagedContainers) {
      try {
        const container = this.docker.getContainer(containerInfo.Id);
        await container.remove();
      } catch (error) {
        // Log but continue
        console.error(`Failed to remove container ${containerInfo.Id}: ${error}`);
      }
    }

    return stoppedManagedContainers.length;
  }

  /**
   * Ensure image is available locally
   */
  private async ensureImage(imageName: string): Promise<void> {
    try {
      await this.docker.getImage(imageName).inspect();
    } catch (error) {
      // Image doesn't exist locally, pull it
      console.log(`Pulling image ${imageName}...`);
      await new Promise((resolve, reject) => {
        this.docker.pull(imageName, (err: Error, stream: NodeJS.ReadableStream) => {
          if (err) {
            reject(err);
            return;
          }

          this.docker.modem.followProgress(stream, (err) => {
            if (err) reject(err);
            else resolve(undefined);
          });
        });
      });
    }
  }

  /**
   * Generate unique container name
   */
  private generateContainerName(issue: ActiveIssue): string {
    const timestamp = Date.now();
    const safeOwner = issue.repoOwner.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const safeRepo = issue.repoName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    return `agent-${safeOwner}-${safeRepo}-issue-${issue.issueNumber}-${timestamp}`;
  }

  /**
   * Escape environment variable value
   */
  private escapeEnvVar(value: string): string {
    // Remove newlines and escape special characters
    return value
      .replace(/[\n\r]/g, ' ')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$');
  }

  /**
   * Parse memory limit (e.g., "4g" -> bytes)
   */
  private parseMemoryLimit(limit: string): number {
    const units: Record<string, number> = {
      'b': 1,
      'k': 1024,
      'm': 1024 * 1024,
      'g': 1024 * 1024 * 1024
    };

    const match = limit.toLowerCase().match(/^(\d+(?:\.\d+)?)([bkmg]?)$/);
    if (!match) {
      // Default to 4GB
      return 4 * 1024 * 1024 * 1024;
    }

    const value = parseFloat(match[1]);
    const unit = match[2] || 'b';
    return Math.floor(value * (units[unit] || 1));
  }

  /**
   * Parse CPU limit (e.g., "2" -> nanoseconds)
   */
  private parseCpuLimit(limit: string): number {
    // Docker uses nanoseconds: 2 CPUs = 2 * 10^9 nanoseconds
    const cpus = parseFloat(limit) || 2;
    return Math.floor(cpus * 1e9);
  }

  /**
   * Get the prompt template for a repo
   */
  private getPromptTemplate(repoConfig?: any): string {
    if (repoConfig?.promptTemplate) {
      // If repo specifies a named template, look it up
      const namedTemplate = this.config.claude.prompts?.[repoConfig.promptTemplate];
      if (namedTemplate) {
        return namedTemplate;
      }
    }

    // Use default prompt template
    return this.config.claude.prompts?.default || '';
  }
}
