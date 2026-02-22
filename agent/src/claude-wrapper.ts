/**
 * Claude Code Wrapper
 * Interface for running Claude Code CLI
 */

import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { logger } from './logger';
import { ClaudeResult } from './types';

export class ClaudeWrapper {
  private workingDir: string;
  private apiKey: string;
  private maxOutputLength: number = 50000; // Limit output size

  constructor(workingDir: string, apiKey: string) {
    this.workingDir = workingDir;
    this.apiKey = apiKey;
  }

  /**
   * Get environment variables for Claude Code execution
   */
  private getEnv(): Record<string, string> {
    return {
      ...process.env,
      ANTHROPIC_API_KEY: this.apiKey,
      PATH: process.env.PATH,
      // Force non-interactive mode
      CI: 'true',
      CLAUDE_NON_INTERACTIVE: 'true',
      AUTO_CONFIRM: 'true',
      NODE_ENV: 'production',
      // Support custom Anthropic endpoints (e.g., TensorFoundry)
      ...(process.env.ANTHROPIC_BASE_URL && { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL }),
      ...(process.env.DEFAULT_MODEL && { DEFAULT_MODEL: process.env.DEFAULT_MODEL }),
      ...(process.env.ANTHROPIC_MODEL && { ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL }),
      ...(process.env.ANTHROPIC_SMALL_FAST_MODEL && { ANTHROPIC_SMALL_FAST_MODEL: process.env.ANTHROPIC_SMALL_FAST_MODEL }),
      ...(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL && { ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL }),
      ...(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL && { ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL })
    };
  }

  /**
   * Execute Claude Code with a prompt
   */
  async execute(prompt: string, timeoutMs: number = 30 * 60 * 1000): Promise<ClaudeResult> {
    return new Promise((resolve) => {
      logger.info('Starting Claude Code execution (non-interactive)');

      const env = this.getEnv();

      // Claude Code reads input from stdin
      // Run in non-interactive mode - no confirmations, auto-proceed
      const claude = spawn('claude', ['--yes', '--non-interactive'], {
        cwd: this.workingDir,
        env: env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      const chunks: Buffer[] = [];

      // Collect stdout
      claude.stdout?.on('data', (data: Buffer) => {
        chunks.push(data);
        const chunkStr = data.toString();
        stdout += chunkStr;

        // Log progress (but limit size)
        if (stdout.length % 5000 < 100) {
          logger.debug('Claude Code output fragment', {
            length: stdout.length
          });
        }
      });

      // Collect stderr
      claude.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      // Set timeout
      const timeout = setTimeout(() => {
        logger.warn('Claude Code execution timed out, terminating');
        claude.kill('SIGTERM');
        resolve({
          success: false,
          output: stdout.slice(-this.maxOutputLength),
          error: `Execution timed out after ${timeoutMs}ms`
        });
      }, timeoutMs);

      // Handle process exit
      claude.on('close', (code) => {
        clearTimeout(timeout);

        const fullOutput = stdout.slice(-this.maxOutputLength);

        if (code === 0 || code === null) {
          logger.info('Claude Code execution completed', {
            exitCode: code,
            outputLength: fullOutput.length
          });
          resolve({
            success: true,
            output: fullOutput
          });
        } else {
          logger.error('Claude Code execution failed', {
            exitCode: code,
            stderr
          });
          resolve({
            success: false,
            output: fullOutput,
            error: `Claude Code exited with code ${code}: ${stderr}`
          });
        }
      });

      // Handle process error
      claude.on('error', (error) => {
        clearTimeout(timeout);
        logger.error('Failed to start Claude Code', { error });
        resolve({
          success: false,
          output: '',
          error: `Failed to start Claude Code: ${error.message}`
        });
      });

      // Write prompt to stdin and close
      try {
        claude.stdin?.write(prompt);
        claude.stdin?.end();
      } catch (error) {
        clearTimeout(timeout);
        logger.error('Failed to write to Claude Code stdin', { error });
        resolve({
          success: false,
          output: '',
          error: `Failed to send prompt to Claude Code: ${error}`
        });
      }
    });
  }

  /**
   * Execute Claude Code with a file-based approach
   * This is more reliable for complex prompts
   */
  async executeWithFile(
    prompt: string,
    timeoutMs: number = 30 * 60 * 1000
  ): Promise<ClaudeResult> {
    try {
      // Create a temporary file with the prompt
      const promptFile = path.join(this.workingDir, '.claude-prompt.txt');
      await fs.writeFile(promptFile, prompt, 'utf-8');

      logger.info('Executing Claude Code with prompt file (non-interactive)');

      return new Promise((resolve) => {
        const env = this.getEnv();

        const claude = spawn('claude', ['--prompt', promptFile, '--yes', '--non-interactive'], {
          cwd: this.workingDir,
          env: env,
          stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        const timeout = setTimeout(() => {
          claude.kill('SIGTERM');
          resolve({
            success: false,
            output: '',
            error: `Execution timed out after ${timeoutMs}ms`
          });
        }, timeoutMs);

        claude.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        claude.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        claude.on('close', async (code) => {
          clearTimeout(timeout);

          // Clean up prompt file
          try {
            await fs.unlink(promptFile);
          } catch (e) {
            // Ignore cleanup errors
          }

          const output = stdout.slice(-this.maxOutputLength);

          if (code === 0) {
            resolve({
              success: true,
              output: output
            });
          } else {
            resolve({
              success: false,
              output: output,
              error: `Claude Code exited with code ${code}: ${stderr}`
            });
          }
        });

        claude.on('error', (error) => {
          clearTimeout(timeout);
          resolve({
            success: false,
            output: '',
            error: `Failed to start Claude Code: ${error.message}`
          });
        });
      });
    } catch (error) {
      return {
        success: false,
        output: '',
        error: `Failed to setup execution: ${error}`
      };
    }
  }

  /**
   * Execute Claude Code with specific command flags
   * Uses the --non-interactive flag for automated execution
   */
  async executeCommand(
    command: string,
    args: string[] = [],
    timeoutMs: number = 30 * 60 * 1000
  ): Promise<ClaudeResult> {
    logger.info('Executing Claude Code command', { command, args });

    return new Promise((resolve) => {
      const env = this.getEnv();

      const claude = spawn('claude', [command, ...args, '--yes'], {
        cwd: this.workingDir,
        env: env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      const timeout = setTimeout(() => {
        claude.kill('SIGTERM');
        resolve({
          success: false,
          output: '',
          error: `Execution timed out after ${timeoutMs}ms`
        });
      }, timeoutMs);

      claude.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      claude.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      claude.on('close', (code) => {
        clearTimeout(timeout);
        const output = stdout.slice(-this.maxOutputLength);

        if (code === 0) {
          resolve({
            success: true,
            output: output
          });
        } else {
          resolve({
            success: false,
            output: output,
            error: `Exit code ${code}: ${stderr}`
          });
        }
      });

      claude.on('error', (error) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          output: '',
          error: `Failed to execute: ${error.message}`
        });
      });
    });
  }

  /**
   * Build a prompt from the issue context
   */
  buildPrompt(
    issueTitle: string,
    issueBody: string,
    additionalContext?: string
  ): string {
    let prompt = `You are an AI software development agent. Your task is to solve the following GitHub issue.

## Issue
Title: ${issueTitle}

${issueBody ? `Description:\n${issueBody}` : ''}

${additionalContext ? `Additional Context:\n${additionalContext}\n` : ''}

## Instructions
1. First, explore the codebase to understand the structure and relevant files.
2. Analyze the issue and determine what changes are needed.
3. Implement the solution, following the existing code style and patterns.
4. Test your changes if appropriate (run tests, lint, etc.).
5. Commit your changes with a descriptive commit message.
6. When complete, respond with "DONE" and a summary of what was done.

## Important Notes
- Write clean, maintainable code that follows the project's conventions.
- Add appropriate error handling and edge case considerations.
- If you need to install dependencies, do so.
- If the issue is unclear, make reasonable assumptions and document them.

Begin working on this issue now.
`;

    return prompt;
  }

  /**
   * Build a prompt for handling review feedback
   */
  buildFeedbackPrompt(feedback: string): string {
    return `You received feedback on your pull request. Please address the feedback and make necessary changes.

## Feedback
${feedback}

## Instructions
1. Read and understand the feedback.
2. Make the necessary changes to address the feedback.
3. Test your changes if applicable.
4. Commit the changes with a message like "Address review feedback: [summary]".
5. When complete, respond with "DONE" and a summary of what was changed.

Begin addressing the feedback now.
`;
  }
}
