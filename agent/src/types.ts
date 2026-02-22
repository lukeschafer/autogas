/**
 * Agent types and interfaces
 */

export interface AgentContext {
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  branchName: string;
  claudeApiKey: string;
  githubToken: string;
  orchestratorUrl: string;
  containerId: string;
  promptTemplate?: string;  // Custom prompt template from config
  reviewFeedbackTemplate?: string;  // Custom review feedback prompt template
}

export interface AgentStatus {
  status: string;
  message: string;
  details: Record<string, any>;
}

export interface ClaudeResult {
  success: boolean;
  output: string;
  error?: string;
  changes?: string[];
}

export interface PRReview {
  id: number;
  user: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
  body: string;
  submittedAt: Date;
}

export interface GitCommitResult {
  success: boolean;
  hash?: string;
  error?: string;
}

export interface PRCreationResult {
  success: boolean;
  prNumber?: number;
  prUrl?: string;
  error?: string;
}
