/**
 * Webhook Server
 * Express server that receives GitHub webhook events
 */

import express, { Request, Response } from 'express';
import { GitHubClient } from './github-client';
import { OrchestratorConfig, WebhookEvent } from './types';
import { logger } from './logger';

export interface WebhookHandlers {
  onIssueTriggered: (issue: any, commentId: number) => Promise<void>;
  onPRClosed: (owner: string, repo: string, prNumber: number) => Promise<void>;
  onPRReview: (owner: string, repo: string, prNumber: number, review: any) => Promise<void>;
}

export class WebhookServer {
  private app: express.Application;
  private githubClient: GitHubClient;
  private config: OrchestratorConfig;
  private handlers: WebhookHandlers;

  constructor(
    githubClient: GitHubClient,
    config: OrchestratorConfig,
    handlers: WebhookHandlers
  ) {
    this.githubClient = githubClient;
    this.config = config;
    this.handlers = handlers;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // Raw body parser for signature verification
    this.app.use('/webhook/github', express.raw({ type: 'application/json' }));

    // JSON parser for other routes
    this.app.use(express.json());
  }

  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      });
    });

    // Status endpoint for agents to report back
    this.app.post('/api/status', async (req: Request, res: Response) => {
      try {
        const statusUpdate = req.body;
        logger.info('Status update received', {
          containerId: statusUpdate.container_id,
          status: statusUpdate.status,
          message: statusUpdate.message
        });
        res.json({ received: true });
      } catch (error) {
        logger.error('Error processing status update', { error });
        res.status(500).json({ error: 'Failed to process status' });
      }
    });

    // GitHub webhook endpoint
    this.app.post('/webhook/github', this.handleGitHubWebhook.bind(this));

    // Stats endpoint
    this.app.get('/api/stats', (_req: Request, res: Response) => {
      res.json({
        version: '1.0.0',
        orchestrator: 'autogen'
      });
    });
  }

  /**
   * Handle incoming GitHub webhooks
   */
  private async handleGitHubWebhook(req: Request, res: Response): Promise<void> {
    const signature = req.headers['x-hub-signature-256'] as string;

    if (!signature) {
      logger.warn('Webhook received without signature');
      res.status(401).json({ error: 'No signature provided' });
      return;
    }

    // Verify signature
    const payload = req.body;
    if (!this.githubClient.verifyWebhookSignature(payload.toString(), signature)) {
      logger.warn('Webhook signature verification failed');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    // Parse webhook event
    const event = req.headers['x-github-event'] as string;
    const deliveryId = req.headers['x-github-delivery'] as string;

    logger.info(`Webhook received: ${event}`, { deliveryId });

    try {
      const eventData = JSON.parse(payload.toString());
      await this.processWebhookEvent(event, eventData, deliveryId);
      res.status(202).json({ received: true });
    } catch (error) {
      logger.error(`Error processing webhook ${event}`, { error });
      res.status(500).json({ error: 'Failed to process webhook' });
    }
  }

  /**
   * Process webhook event based on type
   */
  private async processWebhookEvent(
    eventName: string,
    payload: any,
    deliveryId: string
  ): Promise<void> {
    const event: WebhookEvent = {
      id: deliveryId,
      name: eventName,
      payload
    };

    switch (eventName) {
      case 'issues':
        await this.handleIssuesEvent(event);
        break;

      case 'issue_comment':
        await this.handleIssueCommentEvent(event);
        break;

      case 'pull_request':
        await this.handlePullRequestEvent(event);
        break;

      case 'pull_request_review':
        await this.handlePullRequestReviewEvent(event);
        break;

      default:
        logger.debug(`Unhandled event type: ${eventName}`);
    }
  }

  /**
   * Handle issues events (opened, edited)
   */
  private async handleIssuesEvent(event: WebhookEvent): Promise<void> {
    const { action, issue, repository } = event.payload;

    // Only check for trigger comment when issue is opened or edited
    if (action !== 'opened' && action !== 'edited') {
      return;
    }

    // Check if issue body contains trigger
    const repoConfig = this.githubClient.getRepoConfig(
      repository.owner.login,
      repository.name,
      this.config.repos
    );

    if (!repoConfig) {
      return; // Not a configured repo
    }

    const hasTrigger = this.githubClient.isTriggerComment(issue.body || '', this.config.repos);

    if (hasTrigger && !this.githubClient.isBotComment(issue.user.login)) {
      logger.info(`Trigger found in issue #${issue.number}`, {
        repo: repository.full_name,
        issue: issue.number
      });

      await this.handlers.onIssueTriggered(
        {
          owner: repository.owner.login,
          repo: repository.name,
          number: issue.number,
          title: issue.title,
          body: issue.body || '',
          htmlUrl: issue.html_url,
          user: { login: issue.user.login }
        },
        issue.id
      );
    }
  }

  /**
   * Handle issue_comment events
   */
  private async handleIssueCommentEvent(event: WebhookEvent): Promise<void> {
    const { action, comment, issue, repository } = event.payload;

    // Only care about new comments
    if (action !== 'created') {
      return;
    }

    // Skip bot comments
    if (this.githubClient.isBotComment(comment.user.login)) {
      return;
    }

    // Check if this is a configured repo
    const repoConfig = this.githubClient.getRepoConfig(
      repository.owner.login,
      repository.name,
      this.config.repos
    );

    if (!repoConfig) {
      return;
    }

    // Check for trigger comment
    const hasTrigger = this.githubClient.isTriggerComment(comment.body, this.config.repos);

    if (hasTrigger) {
      logger.info(`Trigger comment found in issue #${issue.number}`, {
        repo: repository.full_name,
        issue: issue.number,
        comment: comment.id
      });

      // Add reaction to acknowledge
      await this.githubClient.addReaction(
        repository.owner.login,
        repository.name,
        comment.id,
        'eyes'
      );

      await this.handlers.onIssueTriggered(
        {
          owner: repository.owner.login,
          repo: repository.name,
          number: issue.number,
          title: issue.title,
          body: issue.body || '',
          htmlUrl: issue.html_url,
          user: { login: issue.user.login }
        },
        comment.id
      );
    }
  }

  /**
   * Handle pull_request events
   */
  private async handlePullRequestEvent(event: WebhookEvent): Promise<void> {
    const { action, pull_request, repository } = event.payload;

    // Handle PR closed for cleanup
    if (action === 'closed') {
      logger.info(`PR #${pull_request.number} closed`, {
        repo: repository.full_name,
        merged: pull_request.merged
      });

      await this.handlers.onPRClosed(
        repository.owner.login,
        repository.name,
        pull_request.number
      );
    }
  }

  /**
   * Handle pull_request_review events
   */
  private async handlePullRequestReviewEvent(event: WebhookEvent): Promise<void> {
    const { review, pull_request, repository } = event.payload;

    // We care about changes requested and new comments
    if (review.state !== 'CHANGES_REQUESTED' && review.state !== 'COMMENTED') {
      return;
    }

    // Skip bot reviews
    if (this.githubClient.isBotComment(review.user.login)) {
      return;
    }

    logger.info(`PR review received`, {
      repo: repository.full_name,
      pr: pull_request.number,
      state: review.state
    });

    await this.handlers.onPRReview(
      repository.owner.login,
      repository.name,
      pull_request.number,
      {
        id: review.id,
        user: { login: review.user.login },
        state: review.state,
        body: review.body || '',
        submittedAt: new Date(review.submitted_at)
      }
    );
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    const port = this.config.server.port;

    return new Promise((resolve) => {
      this.app.listen(port, () => {
        logger.info(`Webhook server listening on port ${port}`);
        logger.info(`Webhook URL: ${this.config.server.publicUrl}/webhook/github`);
        resolve();
      });
    });
  }

  /**
   * Get the Express app (for testing)
   */
  getApp(): express.Application {
    return this.app;
  }
}
