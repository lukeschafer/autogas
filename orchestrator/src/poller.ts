/**
 * GitHub Poller
 * Periodically polls GitHub for triggers instead of using webhooks
 * Ideal for local development and simpler deployments
 */

import { Octokit } from 'octokit';
import { OrchestratorConfig, RepoConfig } from './types';
import { logger } from './logger';

// GitHub API rate limit: 5000 requests/hour for authenticated requests
// That's ~83 requests/minute, or ~1.4 requests/second
// Our polling makes ~5 requests per repo per poll cycle:
// - 1 for listing issues
// - 1 for each open issue's comments (up to 50)
// - 1 for listing PRs
// - 1 for each PR's reviews
// With 5 repos and 60s interval: ~25-50 requests/minute = well within limits

export interface PollerHandlers {
  onIssueTriggered: (owner: string, repo: string, issueNumber: number, trigger: string) => Promise<void>;
  onPRClosed: (owner: string, repo: string, prNumber: number) => Promise<void>;
  onPRReview: (owner: string, repo: string, prNumber: number, review: any) => Promise<void>;
}

interface PollState {
  lastIssueCheck: Map<string, number>; // repo -> timestamp
  lastCommentCheck: Map<string, Map<number, number>>; // repo -> issue -> last comment id
  knownPRs: Set<string>; // owner/repo#pr
  knownReviews: Map<string, number>; // owner/repo#pr -> last review id
}

export class GitHubPoller {
  private octokit: Octokit;
  private config: OrchestratorConfig;
  private handlers: PollerHandlers;
  private interval?: NodeJS.Timeout;
  private state: PollState;
  private pollIntervalMs: number;
  private rateLimitRemaining: number = 5000;
  private rateLimitReset: Date = new Date();

  constructor(
    config: OrchestratorConfig,
    handlers: PollerHandlers,
    pollIntervalSeconds: number = 60
  ) {
    this.config = config;
    this.handlers = handlers;
    this.octokit = new Octokit({ auth: config.github.token });
    this.pollIntervalMs = pollIntervalSeconds * 1000;
    this.state = {
      lastIssueCheck: new Map(),
      lastCommentCheck: new Map(),
      knownPRs: new Set(),
      knownReviews: new Map()
    };
  }

  /**
   * Start polling
   */
  start(): void {
    logger.info(`Starting GitHub poller (interval: ${this.pollIntervalMs / 1000}s)`);

    // Initial check
    this.pollAll().catch(error => {
      logger.error('Error during initial poll', { error });
    });

    // Set up recurring poll
    this.interval = setInterval(async () => {
      try {
        await this.pollAll();
      } catch (error) {
        logger.error('Error during poll', { error });
      }
    }, this.pollIntervalMs);
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
      logger.info('GitHub poller stopped');
    }
  }

  /**
   * Poll all configured repositories
   */
  private async pollAll(): Promise<void> {
    // Check rate limits before polling
    if (!await this.checkRateLimit()) {
      logger.warn('Rate limit nearly exceeded, skipping this poll cycle');
      return;
    }

    const enabledRepos = this.config.repos.filter(r => r.enabled);

    for (const repo of enabledRepos) {
      try {
        await this.pollRepo(repo);
      } catch (error) {
        logger.error(`Error polling ${repo.owner}/${repo.name}`, { error });
      }
    }
  }

  /**
   * Check if we're within safe rate limits
   * Returns true if we can proceed, false if we should skip
   */
  private async checkRateLimit(): Promise<boolean> {
    try {
      const response = await this.octokit.request('GET /rate_limit');
      const { rate } = response.data.resources.core;

      this.rateLimitRemaining = rate.remaining;
      this.rateLimitReset = new Date(rate.reset * 1000);

      // Log rate limit status periodically
      if (this.rateLimitRemaining % 500 === 0 || this.rateLimitRemaining < 1000) {
        logger.info(`GitHub API rate limit: ${rate.remaining}/${rate.limit} remaining, resets at ${this.rateLimitReset.toISOString()}`);
      }

      // Skip poll if less than 10% remaining
      if (rate.remaining < rate.limit * 0.1) {
        logger.warn(`Rate limit low (${rate.remaining}/${rate.limit}), pausing until ${this.rateLimitReset.toISOString()}`);
        return false;
      }

      return true;
    } catch (error) {
      // If we can't check rate limits, proceed anyway (fail open)
      logger.warn('Failed to check rate limit, proceeding anyway', { error });
      return true;
    }
  }

  /**
   * Poll a single repository
   */
  private async pollRepo(repo: RepoConfig): Promise<void> {
    const repoKey = `${repo.owner}/${repo.name}`;

    // 1. Check for new issues
    await this.pollNewIssues(repo);

    // 2. Check for new comments on open issues
    await this.pollIssueComments(repo);

    // 3. Check PRs we created
    await this.pollOurPRs(repo);
  }

  /**
   * Poll for new issues that might contain triggers
   */
  private async pollNewIssues(repo: RepoConfig): Promise<void> {
    const repoKey = `${repo.owner}/${repo.name}`;
    const since = this.state.lastIssueCheck.get(repoKey) || Date.now() - 24 * 60 * 60 * 1000; // Default 24h

    logger.debug(`Checking for new issues in ${repoKey} since ${new Date(since).toISOString()}`);

    try {
      const response = await this.octokit.rest.issues.listForRepo({
        owner: repo.owner,
        repo: repo.name,
        since: new Date(since).toISOString(),
        state: 'open',
        sort: 'created',
        direction: 'desc',
        per_page: 30
      });

      const now = Date.now();

      for (const issue of response.data) {
        // Skip pull requests (they appear in issues list)
        if (issue.pull_request) {
          continue;
        }

        // Check if issue body contains trigger
        if (this.isTriggerComment(issue.body || '', repo)) {
          const issueKey = `${repoKey}#${issue.number}`;
          logger.info(`Trigger found in issue body`, { repo: repoKey, issue: issue.number });

          await this.handlers.onIssueTriggered(
            repo.owner,
            repo.name,
            issue.number,
            repo.triggerComment
          );
        }

        // Initialize comment tracking for this issue
        if (!this.state.lastCommentCheck.has(repoKey)) {
          this.state.lastCommentCheck.set(repoKey, new Map());
        }
      }

      this.state.lastIssueCheck.set(repoKey, now);
    } catch (error) {
      logger.error(`Error polling issues for ${repoKey}`, { error });
    }
  }

  /**
   * Poll for new comments on issues
   */
  private async pollIssueComments(repo: RepoConfig): Promise<void> {
    const repoKey = `${repo.owner}/${repo.name}`;
    const repoCommentState = this.state.lastCommentCheck.get(repoKey) || new Map();

    // Get open issues to check
    try {
      const issuesResponse = await this.octokit.rest.issues.listForRepo({
        owner: repo.owner,
        repo: repo.name,
        state: 'open',
        per_page: 50
      });

      for (const issue of issuesResponse.data) {
        if (issue.pull_request) continue;

        // Skip bot-created issues
        if (this.isBotUser(issue.user?.login)) continue;

        const lastCommentId = repoCommentState.get(issue.number) || 0;

        try {
          // Get comments for this issue
          const commentsResponse = await this.octokit.rest.issues.listComments({
            owner: repo.owner,
            repo: repo.name,
            issue_number: issue.number,
            since: lastCommentId > 0 ? new Date(lastCommentId).toISOString() : undefined,
            per_page: 20
          });

          // Check new comments for triggers
          for (const comment of commentsResponse.data) {
            // Skip old comments we've already seen
            if (comment.id <= lastCommentId) continue;

            // Skip bot comments
            if (this.isBotUser(comment.user?.login)) continue;

            // Check for trigger
            if (this.isTriggerComment(comment.body || '', repo)) {
              logger.info(`Trigger comment found`, {
                repo: repoKey,
                issue: issue.number,
                comment: comment.id
              });

              await this.handlers.onIssueTriggered(
                repo.owner,
                repo.name,
                issue.number,
                repo.triggerComment
              );
            }
          }

          // Update last seen comment ID
          if (commentsResponse.data.length > 0) {
            const maxId = Math.max(...commentsResponse.data.map(c => c.id));
            repoCommentState.set(issue.number, maxId);
          }

        } catch (commentError) {
          // Continue checking other issues even if one fails
          logger.debug(`Error checking comments for issue ${issue.number}`, { error: commentError });
        }
      }

      this.state.lastCommentCheck.set(repoKey, repoCommentState);

    } catch (error) {
      logger.error(`Error polling issue comments for ${repoKey}`, { error });
    }
  }

  /**
   * Poll PRs created by the agent for status changes
   */
  private async pollOurPRs(repo: RepoConfig): Promise<void> {
    const repoKey = `${repo.owner}/${repo.name}`;

    try {
      // Find PRs from our agent branches
      const response = await this.octokit.rest.pulls.list({
        owner: repo.owner,
        repo: repo.name,
        state: 'open',
        sort: 'updated',
        direction: 'desc',
        per_page: 30
      });

      for (const pr of response.data) {
        // Check if this is one of our PRs (by branch naming convention)
        if (!pr.head.ref.startsWith('ai-agent-issue-')) {
          continue;
        }

        const prKey = `${repoKey}#${pr.number}`;
        const wasKnown = this.state.knownPRs.has(prKey);

        // Track this PR
        this.state.knownPRs.add(prKey);

        // If this is a newly discovered PR, just track it
        if (!wasKnown) {
          logger.debug(`Tracking agent PR`, { repo: repoKey, pr: pr.number });
        }

        // Check for new reviews
        await this.pollPRReviews(repo, pr);

        // Check if PR was closed
        if (pr.state === 'closed') {
          logger.info(`Agent PR closed`, { repo: repoKey, pr: pr.number });
          await this.handlers.onPRClosed(repo.owner, repo.name, pr.number);
          this.state.knownPRs.delete(prKey);
          this.state.knownReviews.delete(prKey);
        }
      }

    } catch (error) {
      logger.error(`Error polling PRs for ${repoKey}`, { error });
    }
  }

  /**
   * Poll for reviews on a PR
   */
  private async pollPRReviews(repo: RepoConfig, pr: any): Promise<void> {
    const repoKey = `${repo.owner}/${repo.name}`;
    const prKey = `${repoKey}#${pr.number}`;
    const lastReviewId = this.state.knownReviews.get(prKey) || 0;

    try {
      const reviewsResponse = await this.octokit.rest.pulls.listReviews({
        owner: repo.owner,
        repo: repo.name,
        pull_number: pr.number
      });

      for (const review of reviewsResponse.data) {
        // Skip old reviews we've already processed
        if (review.id <= lastReviewId) continue;

        // Skip bot reviews
        if (this.isBotUser(review.user?.login)) continue;

        // Only care about change requests and comments
        if (review.state === 'CHANGES_REQUESTED' || review.state === 'COMMENTED') {
          logger.info(`New review on agent PR`, {
            repo: repoKey,
            pr: pr.number,
            state: review.state
          });

          await this.handlers.onPRReview(
            repo.owner,
            repo.name,
            pr.number,
            {
              id: review.id,
              user: { login: review.user?.login },
              state: review.state,
              body: review.body || '',
              submittedAt: new Date(review.submitted_at)
            }
          );
        }
      }

      // Update last seen review ID
      if (reviewsResponse.data.length > 0) {
        const maxId = Math.max(...reviewsResponse.data.map(r => r.id));
        this.state.knownReviews.set(prKey, maxId);
      }

    } catch (error) {
      logger.error(`Error polling reviews for PR ${pr.number}`, { error });
    }
  }

  /**
   * Check if a comment body matches the trigger
   */
  private isTriggerComment(body: string, repo: RepoConfig): boolean {
    const lowerBody = body.toLowerCase();
    return lowerBody.includes(repo.triggerComment.toLowerCase());
  }

  /**
   * Check if a user is a bot
   */
  private isBotUser(login?: string): boolean {
    if (!login) return true;
    const botPatterns = ['[bot]', '-bot', 'bot', 'agent', 'ai-agent'];
    return botPatterns.some(p => login.toLowerCase().endsWith(p));
  }

  /**
   * Manually trigger a poll (for testing)
   */
  async triggerPoll(): Promise<void> {
    await this.pollAll();
  }

  /**
   * Get poll state (for debugging)
   */
  getState(): PollState {
    return {
      lastIssueCheck: new Map(this.state.lastIssueCheck),
      lastCommentCheck: new Map(this.state.lastCommentCheck),
      knownPRs: new Set(this.state.knownPRs),
      knownReviews: new Map(this.state.knownReviews)
    };
  }
}
