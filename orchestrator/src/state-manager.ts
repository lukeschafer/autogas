/**
 * State Manager
 * Tracks active issues and their associated containers
 */

import { ActiveIssue, ActiveIssueStatus, OrchestratorConfig } from './types';

export class StateManager {
  private activeIssues: Map<string, ActiveIssue>;
  private maxConcurrent: number;
  private config: OrchestratorConfig;

  constructor(config: OrchestratorConfig) {
    this.activeIssues = new Map();
    this.maxConcurrent = config.containers.maxConcurrent;
    this.config = config;
  }

  /**
   * Check if we can start a new agent
   */
  canStartNew(): boolean {
    const activeCount = this.activeIssues.size;
    return activeCount < this.maxConcurrent;
  }

  /**
   * Get queue position if unable to start
   */
  getQueuePosition(): number {
    return this.activeIssues.size - this.maxConcurrent + 1;
  }

  /**
   * Register a new active issue
   */
  registerIssue(issue: ActiveIssue): void {
    const key = this.getIssueKey(issue.repoOwner, issue.repoName, issue.issueNumber);
    this.activeIssues.set(key, issue);
  }

  /**
   * Get an active issue by key
   */
  getIssue(owner: string, repo: string, issueNumber: number): ActiveIssue | undefined {
    const key = this.getIssueKey(owner, repo, issueNumber);
    return this.activeIssues.get(key);
  }

  /**
   * Get issue by container ID
   */
  getIssueByContainerId(containerId: string): ActiveIssue | undefined {
    for (const issue of this.activeIssues.values()) {
      if (issue.containerId === containerId) {
        return issue;
      }
    }
    return undefined;
  }

  /**
   * Update issue status
   */
  updateIssueStatus(
    owner: string,
    repo: string,
    issueNumber: number,
    status: ActiveIssueStatus,
    error?: string
  ): void {
    const issue = this.getIssue(owner, repo, issueNumber);
    if (issue) {
      issue.status = status;
      issue.lastHeartbeat = new Date();
      if (error) {
        issue.error = error;
      }
    }
  }

  /**
   * Update issue by container ID
   */
  updateIssueByContainerId(
    containerId: string,
    updates: Partial<ActiveIssue>
  ): void {
    const issue = this.getIssueByContainerId(containerId);
    if (issue) {
      Object.assign(issue, updates);
      issue.lastHeartbeat = new Date();
    }
  }

  /**
   * Set PR number for an issue
   */
  setPRNumber(owner: string, repo: string, issueNumber: number, prNumber: number): void {
    const issue = this.getIssue(owner, repo, issueNumber);
    if (issue) {
      issue.prNumber = prNumber;
      issue.status = 'pr_created';
    }
  }

  /**
   * Remove an issue (e.g., after cleanup)
   */
  removeIssue(owner: string, repo: string, issueNumber: number): void {
    const key = this.getIssueKey(owner, repo, issueNumber);
    this.activeIssues.delete(key);
  }

  /**
   * Get all active issues
   */
  getAllActive(): ActiveIssue[] {
    return Array.from(this.activeIssues.values());
  }

  /**
   * Get issues by status
   */
  getIssuesByStatus(status: ActiveIssueStatus): ActiveIssue[] {
    return this.getAllActive().filter(issue => issue.status === status);
  }

  /**
   * Check if an issue is already being handled
   */
  isIssueActive(owner: string, repo: string, issueNumber: number): boolean {
    return this.getIssue(owner, repo, issueNumber) !== undefined;
  }

  /**
   * Get stale issues (no heartbeat for 5 minutes)
   */
  getStaleIssues(heartbeatTimeoutMs: number = 5 * 60 * 1000): ActiveIssue[] {
    const now = Date.now();
    return this.getAllActive().filter(issue => {
      if (!issue.lastHeartbeat) {
        // Issues with no heartbeat and started more than 10 minutes ago are stale
        return (now - issue.startedAt.getTime()) > 10 * 60 * 1000;
      }
      return (now - issue.lastHeartbeat.getTime()) > heartbeatTimeoutMs;
    });
  }

  /**
   * Get statistics
   */
  getStats(): {
    total: number;
    byStatus: Record<ActiveIssueStatus, number>;
    canStartMore: boolean;
  } {
    const all = this.getAllActive();
    const byStatus: Record<string, number> = {};

    for (const status of this.getAllStatuses()) {
      byStatus[status] = all.filter(i => i.status === status).length;
    }

    return {
      total: all.length,
      byStatus: byStatus as Record<ActiveIssueStatus, number>,
      canStartMore: this.canStartNew()
    };
  }

  /**
   * Generate unique issue key
   */
  private getIssueKey(owner: string, repo: string, issueNumber: string): string {
    return `${owner}/${repo}#${issueNumber}`;
  }

  /**
   * Get all possible status values
   */
  private getAllStatuses(): ActiveIssueStatus[] {
    return [
      'starting',
      'cloning',
      'analyzing',
      'developing',
      'testing',
      'pr_created',
      'awaiting_review',
      'iterating',
      'done',
      'error',
      'aborted'
    ];
  }
}
