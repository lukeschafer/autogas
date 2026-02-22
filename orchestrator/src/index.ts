/**
 * Main Orchestrator Entry Point
 * Coordinates all components to manage autonomous GitHub agents
 */

import dotenv from 'dotenv';
import { OrchestratorConfig, ActiveIssue } from './types';
import { loadConfigWithDefaults } from './config';
import { logger } from './logger';
import { StateManager } from './state-manager';
import { ContainerManager } from './container-manager';
import { GitHubClient } from './github-client';
import { WebhookServer } from './webhooks';
import { GitHubPoller } from './poller';

// Load environment variables
// .env.local overrides .env (useful for local development)
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

// Use polling mode by default for local development
const USE_POLLING = process.env.USE_POLLING !== 'false';
const POLL_INTERVAL_SECONDS = parseInt(process.env.POLL_INTERVAL_SECONDS || '60', 10);

export class Orchestrator {
  private config: OrchestratorConfig;
  private stateManager: StateManager;
  private containerManager: ContainerManager;
  private githubClient: GitHubClient;
  private webhookServer?: WebhookServer;
  private poller?: GitHubPoller;
  private healthCheckInterval?: NodeJS.Timeout;
  private cleanupInterval?: NodeJS.Timeout;
  private usePolling: boolean;

  constructor(configPath?: string, usePolling: boolean = USE_POLLING) {
    this.config = loadConfigWithDefaults(configPath);
    this.usePolling = usePolling;

    // Initialize components
    this.stateManager = new StateManager(this.config);
    this.containerManager = new ContainerManager(this.config);
    this.githubClient = new GitHubClient(
      this.config.github.token,
      this.config.github.webhookSecret
    );

    // Create handlers object
    const handlers = {
      onIssueTriggered: this.handleIssueTriggered.bind(this),
      onPRClosed: this.handlePRClosed.bind(this),
      onPRReview: this.handlePRReview.bind(this)
    };

    // Initialize either webhook server or poller based on mode
    if (this.usePolling) {
      logger.info('Initializing in POLLING mode - no webhook required');
      this.poller = new GitHubPoller(
        this.config,
        handlers,
        POLL_INTERVAL_SECONDS
      );
    } else {
      logger.info('Initializing in WEBHOOK mode - configure GitHub webhooks');
      this.webhookServer = new WebhookServer(
        this.githubClient,
        this.config,
        handlers
      );
    }
  }

  /**
   * Start the orchestrator
   */
  async start(): Promise<void> {
    logger.info('Starting Autonomous GitHub Agent Orchestrator');
    logger.info(`Max concurrent agents: ${this.config.containers.maxConcurrent}`);
    logger.info(`Watching ${this.config.repos.length} repositories`);

    // Start either webhook server or poller
    if (this.usePolling) {
      if (this.poller) {
        this.poller.start();
      }
    } else {
      if (this.webhookServer) {
        await this.webhookServer.start();
      }
    }

    // Start health check loop for containers
    this.startHealthCheckLoop();

    // Start periodic cleanup
    this.startCleanupLoop();

    logger.info('Orchestrator started successfully');
  }

  /**
   * Handle a triggered issue
   */
  private async handleIssueTriggered(issue: any, commentId: number): Promise<void> {
    const { owner, repo, number } = issue;

    // Check if issue is already being handled
    if (this.stateManager.isIssueActive(owner, repo, number)) {
      logger.info(`Issue ${owner}/${repo}#${number} is already being handled`);
      await this.githubClient.postIssueComment(
        owner,
        repo,
        number,
        '🔄 This issue is already being handled by an agent.'
      );
      return;
    }

    // Check if we can start a new agent
    if (!this.stateManager.canStartNew()) {
      const queuePos = this.stateManager.getQueuePosition();
      await this.githubClient.postIssueComment(
        owner,
        repo,
        number,
        `🕐 All agent slots are full. Queue position: #${queuePos}. An agent will start when a slot becomes available.`
      );
      logger.info(`Queue full: Issue ${owner}/${repo}#${number} at position ${queuePos}`);
      return;
    }

    // Create active issue record
    const branchName = `ai-agent-issue-${number}-${Date.now()}`;
    const activeIssue: ActiveIssue = {
      repoOwner: owner,
      repoName: repo,
      issueNumber: number,
      issueTitle: issue.title,
      issueBody: issue.body,
      containerId: '',
      containerName: '',
      status: 'starting',
      branchName,
      startedAt: new Date()
    };

    try {
      // Acknowledge the trigger
      await this.githubClient.addReaction(owner, repo, commentId, 'rocket');

      // Post initial comment
      await this.githubClient.postIssueComment(
        owner,
        repo,
        number,
        `🚀 Starting agent for this issue...\n\n` +
        `- Branch: \`${branchName}\`\n` +
        `- Status: Initializing container`
      );

      // Start the container
      logger.info(`Starting container for ${owner}/${repo}#${number}`);
      const containerId = await this.containerManager.startAgentContainer(activeIssue);

      // Update active issue with container info
      activeIssue.containerId = containerId;
      activeIssue.containerName = `agent-${owner}-${repo}-issue-${number}`;
      this.stateManager.registerIssue(activeIssue);

      logger.info(`Agent container started: ${containerId}`);
    } catch (error) {
      logger.error(`Failed to start agent for ${owner}/${repo}#${number}`, { error });

      await this.githubClient.postIssueComment(
        owner,
        repo,
        number,
        `❌ Failed to start agent: ${error}\n\nPlease check the orchestrator logs.`
      );
    }
  }

  /**
   * Handle PR closed event
   */
  private async handlePRClosed(owner: string, repo: string, prNumber: number): Promise<void> {
    // Find the issue associated with this PR
    const activeIssues = this.stateManager.getAllActive();
    const issue = activeIssues.find(i => i.prNumber === prNumber);

    if (!issue) {
      logger.debug(`No active issue found for PR ${owner}/${repo}#${prNumber}`);
      return;
    }

    logger.info(`Cleaning up agent for ${owner}/${repo}#${issue.issueNumber} (PR #${prNumber} closed)`);

    try {
      // Remove the container
      if (issue.containerId) {
        await this.containerManager.removeContainer(issue.containerId);
      }

      // Remove from state
      this.stateManager.removeIssue(issue.repoOwner, issue.repoName, issue.issueNumber);

      // Post final comment
      await this.githubClient.postIssueComment(
        owner,
        repo,
        issue.issueNumber,
        `✅ Agent completed for this issue. PR #${prNumber} has been closed and container cleaned up.`
      );
    } catch (error) {
      logger.error(`Failed to cleanup agent for ${owner}/${repo}#${issue.issueNumber}`, { error });
    }
  }

  /**
   * Handle PR review event
   */
  private async handlePRReview(
    owner: string,
    repo: string,
    prNumber: number,
    review: any
  ): Promise<void> {
    // Find the issue associated with this PR
    const activeIssues = this.stateManager.getAllActive();
    const issue = activeIssues.find(i => i.prNumber === prNumber);

    if (!issue) {
      logger.debug(`No active issue found for PR ${owner}/${repo}#${prNumber}`);
      return;
    }

    if (review.state === 'CHANGES_REQUESTED') {
      logger.info(`Changes requested on PR ${prNumber}, signaling agent to iterate`);

      // Update issue status
      this.stateManager.updateIssueStatus(
        owner,
        repo,
        issue.issueNumber,
        'iterating'
      );

      // Send signal to container (could use Docker exec or shared volume)
      // For now, we'll post a comment that the agent can poll for
      await this.githubClient.postIssueComment(
        owner,
        repo,
        issue.issueNumber,
        `📝 Feedback received:\n\n${review.body}\n\nAgent will iterate on the changes.`
      );
    }
  }

  /**
   * Start health check loop for containers
   */
  private startHealthCheckLoop(): void {
    this.healthCheckInterval = setInterval(async () => {
      const staleIssues = this.stateManager.getStaleIssues();

      for (const issue of staleIssues) {
        logger.warn(`Stale container detected: ${issue.containerId} for ${issue.repoOwner}/${issue.repoName}#${issue.issueNumber}`);

        // Check if container is still running
        try {
          const status = await this.containerManager.getContainerStatus(issue.containerId);

          if (status === 'exited' || status === 'dead') {
            logger.error(`Container ${issue.containerId} has ${status}`);

            // Update status
            this.stateManager.updateIssueStatus(
              issue.repoOwner,
              issue.repoName,
              issue.issueNumber,
              'error',
              `Container terminated unexpectedly (status: ${status})`
            );

            // Get logs for debugging
            const logs = await this.containerManager.getLogs(issue.containerId, 50);
            logger.error(`Container logs:\n${logs}`);

            // Notify on GitHub
            await this.githubClient.postIssueComment(
              issue.repoOwner,
              issue.repoName,
              issue.issueNumber,
              `❌ Agent encountered an error and stopped.\n\n` +
              `Container status: ${status}\n\n` +
              `Please check the issue or try triggering the agent again.`
            );
          }
        } catch (error) {
          logger.error(`Error checking container ${issue.containerId}`, { error });
        }
      }

      // Log stats
      const stats = this.stateManager.getStats();
      logger.debug('Agent stats', stats);
    }, 30 * 1000); // Every 30 seconds
  }

  /**
   * Start periodic cleanup
   */
  private startCleanupLoop(): void {
    this.cleanupInterval = setInterval(async () => {
      try {
        const cleaned = await this.containerManager.cleanupStoppedContainers();
        if (cleaned > 0) {
          logger.info(`Cleaned up ${cleaned} stopped containers`);
        }
      } catch (error) {
        logger.error('Error during cleanup', { error });
      }
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  /**
   * Stop the orchestrator gracefully
   */
  async stop(): Promise<void> {
    logger.info('Stopping orchestrator...');

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Stop poller if running
    if (this.poller) {
      this.poller.stop();
    }

    // Optionally, stop all running containers
    const activeIssues = this.stateManager.getAllActive();
    for (const issue of activeIssues) {
      if (issue.containerId) {
        try {
          await this.containerManager.removeContainer(issue.containerId);
        } catch (error) {
          logger.error(`Failed to stop container ${issue.containerId}`, { error });
        }
      }
    }

    logger.info('Orchestrator stopped');
  }
}

// CLI entry point
if (require.main === module) {
  const orchestrator = new Orchestrator();

  orchestrator.start().catch((error) => {
    logger.error('Failed to start orchestrator', { error });
    process.exit(1);
  });

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down...');
    await orchestrator.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down...');
    await orchestrator.stop();
    process.exit(0);
  });
}

export * from './types';
