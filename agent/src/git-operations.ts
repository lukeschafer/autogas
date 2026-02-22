/**
 * Git Operations
 * Handles git operations for the agent
 */

import simpleGit, { SimpleGit } from 'simple-git';
import { promises as fs } from 'fs';
import { logger } from './logger';

export class GitOperations {
  private git: SimpleGit;
  private workingDir: string;

  constructor(workingDir: string = '/workspace/repo') {
    this.workingDir = workingDir;
    // Configure git for non-interactive mode
    this.git = simpleGit(workingDir, {
      config: [
        'core.askPass=true',
        'core.autoCRLF=false'
      ]
    });
    this.git.env({
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GITSSH_COMMAND: 'ssh -o BatchMode=yes'
    });
  }

  /**
   * Get the current git status
   */
  async getStatus(): Promise<string> {
    try {
      const status = await this.git.status();
      return JSON.stringify({
        branch: status.current,
        files: status.files,
        staged: status.staged,
        modified: status.modified
      });
    } catch (error) {
      logger.error('Failed to get git status', { error });
      throw error;
    }
  }

  /**
   * Commit all changes
   */
  async commitAll(message: string): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
      logger.info('Committing all changes', { message });

      // Add all changes
      await this.git.add('.', { '-A': null });

      // Check if there's anything to commit
      const status = await this.git.status();
      if (status.files.length === 0) {
        logger.info('No changes to commit');
        return { success: true };
      }

      // Commit
      const result = await this.git.commit(message);
      logger.info('Changes committed', { hash: result.commit });

      return {
        success: true,
        hash: result.commit
      };
    } catch (error) {
      logger.error('Failed to commit changes', { error });
      return {
        success: false,
        error: String(error)
      };
    }
  }

  /**
   * Push to remote
   */
  async push(): Promise<{ success: boolean; error?: string }> {
    try {
      logger.info('Pushing to remote');

      await this.git.push('origin', 'HEAD', {
        '--force-with-lease': null
      });

      logger.info('Push successful');
      return { success: true };
    } catch (error) {
      logger.error('Failed to push', { error });
      return {
        success: false,
        error: String(error)
      };
    }
  }

  /**
   * Create a pull request using GitHub API
   */
  async createPR(
    title: string,
    body: string,
    base: string,
    owner: string,
    repo: string,
    githubToken: string
  ): Promise<{ success: boolean; prNumber?: number; prUrl?: string; error?: string }> {
    try {
      logger.info('Creating pull request', { title, base });

      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            title,
            body,
            head: await this.git.revparse(['--abbrev-ref', 'HEAD']),
            base,
            draft: false
          })
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${error}`);
      }

      const data = await response.json();
      logger.info('Pull request created', { number: data.number, url: data.html_url });

      return {
        success: true,
        prNumber: data.number,
        prUrl: data.html_url
      };
    } catch (error) {
      logger.error('Failed to create pull request', { error });
      return {
        success: false,
        error: String(error)
      };
    }
  }

  /**
   * Get reviews for a PR
   */
  async getPRReviews(
    prNumber: number,
    owner: string,
    repo: string,
    githubToken: string
  ): Promise<any[]> {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        }
      );

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const reviews = await response.json();
      return reviews;
    } catch (error) {
      logger.error('Failed to get PR reviews', { error });
      return [];
    }
  }

  /**
   * Get review comments for a PR
   */
  async getPRComments(
    prNumber: number,
    owner: string,
    repo: string,
    githubToken: string
  ): Promise<any[]> {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        }
      );

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const comments = await response.json();
      return comments;
    } catch (error) {
      logger.error('Failed to get PR comments', { error });
      return [];
    }
  }

  /**
   * Get the current branch name
   */
  async getCurrentBranch(): Promise<string> {
    try {
      const branch = await this.git.revparse(['--abbrev-ref', 'HEAD']);
      return branch.trim();
    } catch (error) {
      logger.error('Failed to get current branch', { error });
      throw error;
    }
  }

  /**
   * Create a new branch
   */
  async createBranch(branchName: string): Promise<void> {
    try {
      await this.git.checkoutLocalBranch(branchName);
      logger.info(`Created and checked out branch: ${branchName}`);
    } catch (error) {
      logger.error('Failed to create branch', { branchName, error });
      throw error;
    }
  }

  /**
   * Get changed files
   */
  async getChangedFiles(): Promise<string[]> {
    try {
      const status = await this.git.status();
      return [...status.modified, ...status.created, ...status.deleted];
    } catch (error) {
      logger.error('Failed to get changed files', { error });
      return [];
    }
  }

  /**
   * Get diff for a file
   */
  async getDiff(filePath?: string): Promise<string> {
    try {
      const args = filePath ? ['--', filePath] : [];
      return await this.git.diff(args);
    } catch (error) {
      logger.error('Failed to get diff', { filePath, error });
      return '';
    }
  }
}
