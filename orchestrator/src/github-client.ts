/**
 * GitHub Client
 * Wrapper around GitHub REST API
 */

import { Octokit } from 'octokit';
import { CreatePRParams, GitHubIssue, PullRequest, Review, RepoConfig } from './types';

export class GitHubClient {
  private octokit: Octokit;
  private webhookSecret: string;

  constructor(token: string, webhookSecret: string) {
    this.octokit = new Octokit({ auth: token });
    this.webhookSecret = webhookSecret;
  }

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(payload: string, signature: string): boolean {
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', this.webhookSecret);
    const digest = `sha256=${hmac.update(payload).digest('hex')}`;
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  }

  /**
   * Check if a comment body matches any trigger comment
   */
  isTriggerComment(body: string, repos: RepoConfig[]): boolean {
    const lowerBody = body.toLowerCase();
    return repos.some(repo =>
      repo.enabled && lowerBody.includes(repo.triggerComment.toLowerCase())
    );
  }

  /**
   * Get the trigger comment that was matched
   */
  getMatchedTrigger(body: string, repos: RepoConfig[]): string | null {
    const lowerBody = body.toLowerCase();
    for (const repo of repos) {
      if (repo.enabled && lowerBody.includes(repo.triggerComment.toLowerCase())) {
        return repo.triggerComment;
      }
    }
    return null;
  }

  /**
   * Get repo config for a specific repository
   */
  getRepoConfig(owner: string, name: string, repos: RepoConfig[]): RepoConfig | undefined {
    return repos.find(repo =>
      repo.enabled &&
      repo.owner.toLowerCase() === owner.toLowerCase() &&
      repo.name.toLowerCase() === name.toLowerCase()
    );
  }

  /**
   * Check if a comment is from a bot (to avoid loops)
   */
  isBotComment(userLogin: string): boolean {
    const botSuffixes = ['[bot]', '-bot', 'bot', 'agent', 'ai-agent'];
    return botSuffixes.some(suffix =>
      userLogin.toLowerCase().endsWith(suffix)
    );
  }

  /**
   * Post a comment on an issue
   */
  async postIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<void> {
    try {
      await this.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body
      });
    } catch (error) {
      throw new Error(`Failed to post comment to ${owner}/${repo}#${issueNumber}: ${error}`);
    }
  }

  /**
   * Add a reaction to an issue comment
   */
  async addReaction(
    owner: string,
    repo: string,
    commentId: number,
    reaction: '+1' | '-1' | 'laugh' | 'hooray' | 'confused' | 'heart' | 'rocket' | 'eyes'
  ): Promise<void> {
    try {
      await this.octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: commentId,
        content: reaction
      });
    } catch (error) {
      // Non-critical, log but don't throw
      console.error(`Failed to add reaction: ${error}`);
    }
  }

  /**
   * Get issue details
   */
  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssue> {
    try {
      const { data } = await this.octokit.rest.issues.get({
        owner,
        repo,
        issue_number: issueNumber
      });

      return {
        owner,
        repo,
        number: data.number,
        title: data.title,
        body: data.body || '',
        htmlUrl: data.html_url,
        user: {
          login: data.user?.login || 'unknown'
        }
      };
    } catch (error) {
      throw new Error(`Failed to get issue ${owner}/${repo}#${issueNumber}: ${error}`);
    }
  }

  /**
   * Create a pull request
   */
  async createPR(
    owner: string,
    repo: string,
    params: CreatePRParams
  ): Promise<PullRequest> {
    try {
      const { data } = await this.octokit.rest.pulls.create({
        owner,
        repo,
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base
      });

      return {
        number: data.number,
        title: data.title,
        body: data.body || '',
        htmlUrl: data.html_url,
        headRef: {
          name: data.head.ref
        },
        baseRef: {
          name: data.base.ref
        },
        state: data.state as 'open' | 'closed' | 'merged',
        mergeable: data.mergeable
      };
    } catch (error) {
      throw new Error(`Failed to create PR in ${owner}/${repo}: ${error}`);
    }
  }

  /**
   * Get PR details
   */
  async getPR(owner: string, repo: string, prNumber: number): Promise<PullRequest> {
    try {
      const { data } = await this.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber
      });

      return {
        number: data.number,
        title: data.title,
        body: data.body || '',
        htmlUrl: data.html_url,
        headRef: {
          name: data.head.ref
        },
        baseRef: {
          name: data.base.ref
        },
        state: data.state as 'open' | 'closed' | 'merged',
        mergeable: data.mergeable
      };
    } catch (error) {
      throw new Error(`Failed to get PR ${owner}/${repo}#${prNumber}: ${error}`);
    }
  }

  /**
   * Get reviews on a PR
   */
  async getPRReviews(owner: string, repo: string, prNumber: number): Promise<Review[]> {
    try {
      const { data } = await this.octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: prNumber
      });

      return data.map(review => ({
        id: review.id,
        user: {
          login: review.user?.login || 'unknown'
        },
        state: review.state as 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED',
        body: review.body || '',
        submittedAt: new Date(review.submitted_at)
      }));
    } catch (error) {
      throw new Error(`Failed to get reviews for PR ${owner}/${repo}#${prNumber}: ${error}`);
    }
  }

  /**
   * Get comments on a PR (for feedback)
   */
  async getPRComments(owner: string, repo: string, prNumber: number): Promise<any[]> {
    try {
      const { data } = await this.octokit.rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: prNumber
      });
      return data;
    } catch (error) {
      throw new Error(`Failed to get PR comments for ${owner}/${repo}#${prNumber}: ${error}`);
    }
  }

  /**
   * Update PR status comment (finds and edits a previous comment or creates new)
   */
  async updatePRStatusComment(
    owner: string,
    repo: string,
    prNumber: number,
    status: string
  ): Promise<void> {
    // For simplicity, we'll create a new comment
    // In production, you might want to find and update existing bot comments
    await this.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: status
    });
  }

  /**
   * Get issue comments to find trigger
   */
  async getIssueComments(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<Array<{ id: number; user: string; body: string; createdAt: Date }>> {
    try {
      const { data } = await this.octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber
      });

      return data.map(comment => ({
        id: comment.id,
        user: comment.user?.login || 'unknown',
        body: comment.body || '',
        createdAt: new Date(comment.created_at)
      }));
    } catch (error) {
      throw new Error(`Failed to get comments for ${owner}/${repo}#${issueNumber}: ${error}`);
    }
  }

  /**
   * Check if repository is accessible
   */
  async verifyAccess(owner: string, repo: string): Promise<boolean> {
    try {
      await this.octokit.rest.repos.get({
        owner,
        repo
      });
      return true;
    } catch (error) {
      return false;
    }
  }
}
