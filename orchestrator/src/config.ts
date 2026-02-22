/**
 * Configuration loader
 */

import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import { OrchestratorConfig, PromptTemplates } from './types';

export function loadConfig(configPath: string = 'config/config.yaml'): OrchestratorConfig {
  try {
    const fileContents = fs.readFileSync(configPath, 'utf8');
    const config = yaml.load(fileContents) as any;

    // Substitute environment variables
    const substituted = substituteEnvVars(config);

    // Load prompt templates
    if (substituted.claude?.prompts) {
      substituted.claude.prompts = loadPromptTemplates(substituted.claude.prompts, path.dirname(configPath));
    }

    // Validate required fields
    validateConfig(substituted);

    return substituted as OrchestratorConfig;
  } catch (error) {
    throw new Error(`Failed to load configuration from ${configPath}: ${error}`);
  }
}

/**
 * Load prompt templates from config or external files
 */
function loadPromptTemplates(prompts: any, configDir: string): PromptTemplates {
  const result: any = {};

  for (const [key, value] of Object.entries(prompts)) {
    if (typeof value === 'string') {
      // Check if it's a file path (starts with './', '../', or absolute)
      if (value.startsWith('./') || value.startsWith('../') || value.startsWith('/')) {
        const filePath = path.resolve(configDir, value);
        try {
          result[key] = fs.readFileSync(filePath, 'utf8');
        } catch (error) {
          throw new Error(`Failed to load prompt template from ${filePath}: ${error}`);
        }
      } else {
        // Inline prompt template
        result[key] = value;
      }
    }
  }

  return result as PromptTemplates;
}

/**
 * Recursively substitute ${VAR} with environment variables
 */
function substituteEnvVars(obj: any): any {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      const value = process.env[varName];
      if (value === undefined) {
        throw new Error(`Environment variable ${varName} is not set but referenced in config`);
      }
      return value;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map(substituteEnvVars);
  }

  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteEnvVars(value);
    }
    return result;
  }

  return obj;
}

/**
 * Validate required configuration fields
 */
function validateConfig(config: any): void {
  const required = [
    'github.token',
    'github.webhookSecret',
    'claude.apiKey',
    'server.port',
    'server.publicUrl'
  ];

  for (const field of required) {
    const parts = field.split('.');
    let current = config;
    for (const part of parts) {
      if (!current || current[part] === undefined) {
        throw new Error(`Missing required configuration field: ${field}`);
      }
      current = current[part];
    }
  }

  // Validate repos array
  if (!Array.isArray(config.repos) || config.repos.length === 0) {
    throw new Error('Configuration must include at least one repository in repos array');
  }

  // Validate each repo config
  for (const repo of config.repos) {
    if (!repo.owner || !repo.name || !repo.triggerComment) {
      throw new Error('Each repo must have owner, name, and triggerComment fields');
    }
  }

  // Validate numeric values
  if (config.containers?.maxConcurrent !== undefined) {
    if (typeof config.containers.maxConcurrent !== 'number' || config.containers.maxConcurrent < 1) {
      throw new Error('containers.maxConcurrent must be a positive number');
    }
  }
}

/**
 * Load config with defaults
 */
export function loadConfigWithDefaults(configPath?: string): OrchestratorConfig {
  const config = loadConfig(configPath);

  // Default prompt templates
  const defaultPrompts: PromptTemplates = {
    default: config.claude?.prompts?.default || getDefaultPrompt(),
    reviewFeedback: config.claude?.prompts?.reviewFeedback || getDefaultReviewPrompt()
  };

  // Apply defaults
  return {
    github: config.github,
    repos: config.repos,
    claude: {
      apiKey: config.claude.apiKey,
      maxTokens: config.claude.maxTokens || 200000,
      prompts: defaultPrompts
    },
    containers: {
      maxConcurrent: config.containers?.maxConcurrent || 5,
      baseImage: config.containers?.baseImage || 'ghcr-agent:latest',
      network: config.containers?.network || 'bridge',
      memoryLimit: config.containers?.memoryLimit || '4g',
      cpuLimit: config.containers?.cpuLimit || '2'
    },
    server: {
      port: config.server.port || 3000,
      publicUrl: config.server.publicUrl
    }
  };
}

/**
 * Get default prompt template
 */
function getDefaultPrompt(): string {
  return `You are an AI software development agent. Your task is to solve the following GitHub issue.

## Issue
Title: {{issue_title}}

{{#if issue_body}}
Description:
{{issue_body}}
{{/if}}

{{#if additional_context}}
Additional Context:
{{additional_context}}
{{/if}}

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

Begin working on this issue now.`;
}

/**
 * Get default review feedback prompt template
 */
function getDefaultReviewPrompt(): string {
  return `You received feedback on your pull request. Please address the feedback and make necessary changes.

## Feedback
{{feedback}}

## Instructions
1. Read and understand the feedback.
2. Make the necessary changes to address the feedback.
3. Test your changes if applicable.
4. Commit the changes with a message like "Address review feedback: [summary]".
5. When complete, respond with "DONE" and a summary of what was changed.

Begin addressing the feedback now.`;
}
