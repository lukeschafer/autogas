/**
 * Shared types and interfaces for the orchestrator
 */

export interface ActiveIssue {
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  containerId: string;
  containerName: string;
  status: ActiveIssueStatus;
  branchName: string;
  prNumber?: number;
  startedAt: Date;
  lastHeartbeat?: Date;
  error?: string;
}

export type ActiveIssueStatus =
  | 'starting'
  | 'cloning'
  | 'analyzing'
  | 'developing'
  | 'testing'
  | 'pr_created'
  | 'awaiting_review'
  | 'iterating'
  | 'done'
  | 'error'
  | 'aborted';

export interface GitHubIssue {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  user: {
    login: string;
  };
}

export interface GitHubComment {
  id: number;
  user: {
    login: string;
  };
  body: string;
  createdAt: Date;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  headRef: {
    name: string;
  };
  baseRef: {
    name: string;
  };
  state: 'open' | 'closed' | 'merged';
  mergeable?: boolean;
}

export interface Review {
  id: number;
  user: {
    login: string;
  };
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
  body: string;
  submittedAt: Date;
}

export interface CreatePRParams {
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  status: string;
  created: Date;
}

export interface RepoConfig {
  owner: string;
  name: string;
  triggerComment: string;
  enabled: boolean;
  promptTemplate?: string;  // Path to custom prompt template
}

export interface PromptTemplates {
  default: string;
  reviewFeedback: string;
  // Additional named templates can be added
  [key: string]: string;
}

export interface OrchestratorConfig {
  github: {
    token: string;
    webhookSecret: string;
  };
  repos: RepoConfig[];
  claude: {
    apiKey: string;
    maxTokens: number;
    prompts?: PromptTemplates;
  };
  containers: {
    maxConcurrent: number;
    baseImage: string;
    network: string;
    memoryLimit: string;
    cpuLimit: string;
    env?: Record<string, string>;  // Additional env vars passed to all containers
  };
  server: {
    port: number;
    publicUrl: string;
  };
}

export interface WebhookEvent {
  id: string;
  name: string;
  payload: any;
}

export interface StatusUpdate {
  containerId: string;
  status: ActiveIssueStatus;
  message: string;
  details: Record<string, any>;
  timestamp: string;
}
