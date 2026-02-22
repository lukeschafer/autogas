/**
 * Main Agent Logic
 * Runs inside containers to solve GitHub issues
 */

import axios from 'axios';
import { logger } from './logger';
import { GitOperations } from './git-operations';
import { ClaudeWrapper } from './claude-wrapper';
import { AgentContext, AgentStatus } from './types';

export class Agent {
  private context: AgentContext;
  private gitOps: GitOperations;
  private claude: ClaudeWrapper;

  constructor(context: AgentContext) {
    this.context = context;
    this.gitOps = new GitOperations('/workspace/repo');
    this.claude = new ClaudeWrapper('/workspace/repo', context.claudeApiKey);
  }

  /**
   * Main execution flow
   */
  async run(): Promise<void> {
    logger.info('Agent started', {
      repo: `${this.context.repoOwner}/${this.context.repoName}`,
      issue: this.context.issueNumber
    });

    try {
      // Phase 1: Analyze the issue
      await this.reportStatus('analyzing', 'Reading and understanding the issue...');
      await this.analyzeIssue();

      // Phase 2: Develop solution
      await this.reportStatus('developing', 'Developing solution with Claude Code...');
      const developResult = await this.developSolution();

      if (!developResult.success) {
        throw new Error(`Development failed: ${developResult.error}`);
      }

      // Phase 3: Commit changes
      await this.reportStatus('testing', 'Committing changes...');
      const commitResult = await this.commitAndPush();

      if (!commitResult.success) {
        throw new Error(`Failed to commit changes: ${commitResult.error}`);
      }

      // Phase 4: Create PR
      await this.reportStatus('pr_created', 'Creating pull request...');
      const prResult = await this.createPR();

      if (!prResult.success) {
        throw new Error(`Failed to create PR: ${prResult.error}`);
      }

      logger.info('PR created successfully', {
        prNumber: prResult.prNumber,
        url: prResult.prUrl
      });

      // Phase 5: Enter feedback loop
      await this.reportStatus('awaiting_review', 'Waiting for review feedback...');
      await this.monitorPRAndIterate(prResult.prNumber!);

      // Phase 6: Complete
      await this.reportStatus('done', 'Agent completed successfully');

    } catch (error) {
      logger.error('Agent execution failed', { error });
      await this.reportStatus('error', `Agent failed: ${error}`);
      throw error;
    }
  }

  /**
   * Analyze the issue
   */
  private async analyzeIssue(): Promise<void> {
    logger.info('Analyzing issue', {
      title: this.context.issueTitle,
      body: this.context.issueBody.substring(0, 200)
    });

    // Build a prompt for analysis
    const analysisPrompt = this.claude.buildPrompt(
      this.context.issueTitle,
      this.context.issueBody,
      `
Current branch: ${this.context.branchName}
Repository: ${this.context.repoOwner}/${this.context.repoName}

Please explore the repository structure first to understand the codebase, then implement a solution for the issue.
`
    );

    // Store for execution phase
    this.context.issueBody = analysisPrompt;
  }

  /**
   * Develop the solution using Claude Code
   */
  private async developSolution(): Promise<{ success: boolean; error?: string }> {
    logger.info('Starting solution development');

    // Use custom prompt template if provided, otherwise use default
    const prompt = this.context.promptTemplate
      ? this.interpolateTemplate(this.context.promptTemplate)
      : this.claude.buildPrompt(
          this.context.issueTitle,
          this.context.issueBody,
          `
Current branch: ${this.context.branchName}
Repository: ${this.context.repoOwner}/${this.context.repoName}

Instructions:
1. First explore the repository structure to understand the codebase.
2. Implement the solution following existing patterns.
3. Test your changes if applicable.
4. When done, report "DONE" with a summary.
`
        );

    try {
      // Execute Claude Code
      const result = await this.claude.executeWithFile(prompt, 25 * 60 * 1000); // 25 min timeout

      if (!result.success) {
        logger.error('Claude Code execution failed', { error: result.error });
        return {
          success: false,
          error: result.error
        };
      }

      logger.info('Solution development completed', {
        outputLength: result.output.length
      });

      // Log summary of output
      const lines = result.output.split('\n');
      const lastLines = lines.slice(-20).join('\n');
      logger.info('Claude Code output (last 20 lines)', { output: lastLines });

      return { success: true };

    } catch (error) {
      logger.error('Exception during development', { error });
      return {
        success: false,
        error: String(error)
      };
    }
  }

  /**
   * Commit and push changes
   */
  private async commitAndPush(): Promise<{ success: boolean; error?: string }> {
    try {
      // Get changed files
      const changedFiles = await this.gitOps.getChangedFiles();
      logger.info('Changed files', { files: changedFiles });

      if (changedFiles.length === 0) {
        logger.warn('No files were changed');
        return {
          success: false,
          error: 'No files were modified during development'
        };
      }

      // Commit changes
      const commitMessage = this.buildCommitMessage();
      const commitResult = await this.gitOps.commitAll(commitMessage);

      if (!commitResult.success) {
        return {
          success: false,
          error: commitResult.error
        };
      }

      // Push changes
      const pushResult = await this.gitOps.push();

      if (!pushResult.success) {
        return {
          success: false,
          error: pushResult.error
        };
      }

      logger.info('Changes committed and pushed');
      return { success: true };

    } catch (error) {
      logger.error('Failed to commit/push', { error });
      return {
        success: false,
        error: String(error)
      };
    }
  }

  /**
   * Create pull request
   */
  private async createPR(): Promise<{ success: boolean; prNumber?: number; prUrl?: string; error?: string }> {
    try {
      const title = `AI Agent: Fix for #${this.context.issueNumber} - ${this.context.issueTitle}`;
      const body = this.buildPRBody();

      // Get default branch name (assume 'main' or 'master')
      const baseBranch = await this.getDefaultBranch();

      const result = await this.gitOps.createPR(
        title,
        body,
        baseBranch,
        this.context.repoOwner,
        this.context.repoName,
        this.context.githubToken
      );

      return result;

    } catch (error) {
      logger.error('Failed to create PR', { error });
      return {
        success: false,
        error: String(error)
      };
    }
  }

  /**
   * Monitor PR for reviews and iterate on feedback
   */
  private async monitorPRAndIterate(prNumber: number): Promise<void> {
    const maxIterations = 5;
    let iterations = 0;
    const checkInterval = 60 * 1000; // Check every minute

    logger.info('Starting PR monitoring loop', { prNumber });

    while (iterations < maxIterations) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));

      // Check for reviews
      const reviews = await this.gitOps.getPRReviews(
        prNumber,
        this.context.repoOwner,
        this.context.repoName,
        this.context.githubToken
      );

      // Check for changes requested
      const changesRequested = reviews.filter(r =>
        r.state === 'CHANGES_REQUESTED' &&
        !this.isBotUser(r.user?.login)
      );

      if (changesRequested.length > 0) {
        logger.info('Changes requested, iterating', {
          count: changesRequested.length
        });

        await this.reportStatus('iterating', 'Addressing review feedback...');

        // Aggregate feedback
        const feedback = changesRequested
          .map(r => `@${r.user?.login}: ${r.body}`)
          .join('\n\n');

        // Handle feedback
        const handled = await this.handleFeedback(feedback);

        if (!handled) {
          logger.warn('Failed to handle feedback, will retry');
          iterations++;
          continue;
        }

        // Commit and push changes
        await this.gitOps.commitAll(`Address review feedback (iteration ${iterations + 1})`);
        await this.gitOps.push();

        await this.reportStatus('awaiting_review', 'Changes pushed, awaiting review...');
        iterations++;
      }

      // Check for approval
      const approved = reviews.some(r => r.state === 'APPROVED');
      if (approved) {
        logger.info('PR approved, ending monitoring');
        break;
      }
    }

    if (iterations >= maxIterations) {
      logger.warn('Max iterations reached, ending monitoring');
    }
  }

  /**
   * Handle review feedback
   */
  private async handleFeedback(feedback: string): Promise<boolean> {
    logger.info('Handling review feedback', { feedback: feedback.substring(0, 200) });

    // Use custom review feedback template if provided, otherwise use default
    const prompt = this.context.reviewFeedbackTemplate
      ? this.interpolateReviewFeedbackTemplate(this.context.reviewFeedbackTemplate, feedback)
      : this.claude.buildFeedbackPrompt(feedback);

    try {
      const result = await this.claude.executeWithFile(prompt, 20 * 60 * 1000);

      if (!result.success) {
        logger.error('Failed to execute feedback handling', { error: result.error });
        return false;
      }

      logger.info('Feedback handling completed');
      return true;

    } catch (error) {
      logger.error('Exception during feedback handling', { error });
      return false;
    }
  }

  /**
   * Interpolate review feedback template
   */
  private interpolateReviewFeedbackTemplate(template: string, feedback: string): string {
    return template.replace(/\{\{feedback\}\}/g, feedback);
  }

  /**
   * Report status to orchestrator
   */
  private async reportStatus(status: string, message: string): Promise<void> {
    logger.info(`Status: ${status} - ${message}`);

    try {
      await axios.post(
        `${this.context.orchestratorUrl}/api/status`,
        {
          container_id: this.context.containerId,
          status,
          message,
          details: {},
          timestamp: new Date().toISOString()
        },
        {
          timeout: 5000,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (error) {
      // Non-critical, log but don't fail
      logger.warn('Failed to report status to orchestrator', { error });
    }
  }

  /**
   * Build commit message
   */
  private buildCommitMessage(): string {
    return `Fix for #${this.context.issueNumber}: ${this.context.issueTitle}

This change was implemented by an AI agent to address the reported issue.

Closes #${this.context.issueNumber}`;
  }

  /**
   * Build PR body
   */
  private buildPRBody(): string {
    return `## Summary
This PR addresses issue #${this.context.issueNumber}: ${this.context.issueTitle}

## Changes
${this.context.issueBody ? `- ${this.context.issueBody.substring(0, 500)}` : ''}

## Checklist
- [ ] Tests pass (if applicable)
- [ ] Code follows project conventions
- [ ] Documentation updated (if needed)

---
*This PR was created by an AI agent. Please review carefully before merging.*

Closes #${this.context.issueNumber}`;
  }

  /**
   * Get default branch name
   */
  private async getDefaultBranch(): Promise<string> {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${this.context.repoOwner}/${this.context.repoName}`,
        {
          headers: {
            'Authorization': `Bearer ${this.context.githubToken}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        }
      );

      if (response.ok) {
        const data = await response.json();
        return data.default_branch || 'main';
      }
    } catch (error) {
      logger.warn('Failed to get default branch', { error });
    }

    return 'main';
  }

  /**
   * Check if user is a bot
   */
  private isBotUser(login: string): boolean {
    if (!login) return true;
    const botPatterns = ['[bot]', '-bot', 'agent', 'ai-agent'];
    return botPatterns.some(p => login.toLowerCase().endsWith(p));
  }

  /**
   * Interpolate template variables
   * Supports {{variable}} syntax and simple conditionals
   */
  private interpolateTemplate(template: string): string {
    let result = template;

    // Replace variables
    const variables = {
      issue_title: this.context.issueTitle,
      issue_body: this.context.issueBody || '',
      repo_owner: this.context.repoOwner,
      repo_name: this.context.repoName,
      issue_number: this.context.issueNumber.toString(),
      branch_name: this.context.branchName
    };

    // Simple variable substitution
    result = result.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      return variables[key as keyof typeof variables] || '';
    });

    // Handle {{#if var}}...{{/if}} conditionals
    result = result.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, varName, content) => {
      const value = variables[varName as keyof typeof variables];
      return value ? content : '';
    });

    return result;
  }
}

/**
 * Entry point when run as a module
 */
export async function main(): Promise<void> {
  // Load context from environment
  const context: AgentContext = {
    repoOwner: process.env.GITHUB_REPO_OWNER || '',
    repoName: process.env.GITHUB_REPO_NAME || '',
    issueNumber: parseInt(process.env.GITHUB_ISSUE_NUMBER || '0'),
    issueTitle: process.env.GITHUB_ISSUE_TITLE || '',
    issueBody: process.env.GITHUB_ISSUE_BODY || '',
    branchName: process.env.BRANCH_NAME || '',
    claudeApiKey: process.env.ANTHROPIC_API_KEY || '',
    githubToken: process.env.GITHUB_TOKEN || '',
    orchestratorUrl: process.env.ORCHESTRATOR_URL || '',
    containerId: process.env.CONTAINER_ID || '',
    promptTemplate: process.env.PROMPT_TEMPLATE,
    reviewFeedbackTemplate: process.env.REVIEW_FEEDBACK_TEMPLATE
  };

  // Validate required fields
  if (!context.repoOwner || !context.repoName || !context.issueNumber) {
    throw new Error('Missing required environment variables');
  }

  const agent = new Agent(context);

  try {
    await agent.run();
    process.exit(0);
  } catch (error) {
    logger.error('Agent failed', { error });
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
