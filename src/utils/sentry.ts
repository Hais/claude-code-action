/**
 * Sentry integration for error tracking and monitoring
 */

import * as Sentry from "@sentry/node";
import { sanitizeObject, sanitizeString } from "./sanitization";
import type { GitHubContext } from "../github/context";
import type { Mode } from "../modes/types";

interface SentryInitOptions {
  context: GitHubContext;
  mode?: Mode;
}

/**
 * Initialize Sentry if DSN is provided via environment variable
 */
export function initSentry(options: SentryInitOptions): void {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    // Sentry is optional - silently skip if not configured
    return;
  }

  const environment =
    process.env.SENTRY_ENVIRONMENT || detectEnvironment(options.context);
  const release = process.env.SENTRY_RELEASE || process.env.GITHUB_SHA;

  Sentry.init({
    dsn,
    environment,
    release,
    // Only capture errors, no performance monitoring
    tracesSampleRate: 0,
    // Capture all errors
    sampleRate: 1.0,
    beforeSend: (event) => sanitizeSentryEvent(event),
    beforeBreadcrumb: (breadcrumb) => sanitizeBreadcrumb(breadcrumb),
    integrations: [
      // Basic integrations - using default Sentry integrations
    ],
  });

  // Set global tags
  const repositoryString =
    typeof options.context.repository === "string"
      ? options.context.repository
      : `${options.context.repository.owner}/${options.context.repository.repo}`;

  Sentry.setTags({
    "github.event": options.context.eventName,
    "github.repository": repositoryString,
    mode: options.mode?.name || "unknown",
  });

  // Set context
  Sentry.setContext("github", {
    repository: repositoryString,
    event_name: options.context.eventName,
    workflow_run_id: process.env.GITHUB_RUN_ID || "",
    job_id: process.env.GITHUB_JOB || "",
    run_attempt: process.env.GITHUB_RUN_ATTEMPT || "",
    actor: options.context.actor || "",
  });
}

/**
 * Capture an error with structured context
 */
export function captureError(
  error: Error | unknown,
  context: {
    operation: string;
    phase?: string;
    mode?: string;
    toolName?: string;
    serverType?: string;
    retryAttempts?: number;
    recoveryStrategy?: string;
    rateLimitRemaining?: number;
    [key: string]: unknown;
  },
): void {
  if (!Sentry.getClient()) {
    // Sentry not initialized, skip
    return;
  }

  const sanitizedContext = sanitizeObject(context, 3);

  Sentry.withScope((scope) => {
    // Add tags for filtering
    scope.setTag("operation", context.operation);
    if (context.phase) scope.setTag("phase", context.phase);
    if (context.mode) scope.setTag("mode", context.mode);
    if (context.toolName) scope.setTag("tool", context.toolName);
    if (context.serverType) scope.setTag("server", context.serverType);

    // Add structured context
    scope.setContext("operation", {
      name: context.operation,
      phase: context.phase,
      retry_attempts: context.retryAttempts,
      recovery_strategy: context.recoveryStrategy,
    });

    if (context.toolName || context.serverType) {
      scope.setContext("mcp", {
        tool: context.toolName,
        server: context.serverType,
      });
    }

    if (context.rateLimitRemaining !== undefined) {
      scope.setContext("rate_limit", {
        remaining: context.rateLimitRemaining,
      });
    }

    // Add extra data
    scope.setExtras(sanitizedContext);

    // Capture the error
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
    );
  });
}

/**
 * Add a breadcrumb for debugging context
 */
export function addBreadcrumb(
  message: string,
  category: string,
  data?: Record<string, unknown>,
  level: "debug" | "info" | "warning" | "error" = "info",
): void {
  if (!Sentry.getClient()) {
    return;
  }

  Sentry.addBreadcrumb({
    message: sanitizeString(message, 200),
    category,
    level,
    data: data ? sanitizeObject(data, 2) : undefined,
    timestamp: Date.now() / 1000,
  });
}

/**
 * Capture GitHub API errors with specific context
 */
export function captureGitHubApiError(
  error: Error | unknown,
  context: {
    endpoint: string;
    method: string;
    statusCode?: number;
    rateLimitRemaining?: number;
    repository?: string;
    operation: string;
  },
): void {
  captureError(error, {
    operation: "github_api",
    phase: context.operation,
    endpoint: sanitizeString(context.endpoint, 100),
    method: context.method,
    statusCode: context.statusCode,
    rateLimitRemaining: context.rateLimitRemaining,
    repository: context.repository,
  });
}

/**
 * Capture MCP tool execution errors
 */
export function captureMcpError(
  error: Error | unknown,
  context: {
    toolName: string;
    serverType: string;
    parameters?: Record<string, unknown>;
    operation: string;
  },
): void {
  captureError(error, {
    operation: "mcp_tool",
    toolName: context.toolName,
    serverType: context.serverType,
    phase: context.operation,
    parameters: context.parameters
      ? sanitizeObject(context.parameters, 2)
      : undefined,
  });
}

/**
 * Auto-detect environment based on GitHub context
 */
function detectEnvironment(context: GitHubContext): string {
  // Check if this is main/master branch (for push events)
  if (
    "ref" in context &&
    context.ref &&
    (context.ref === "refs/heads/main" || context.ref === "refs/heads/master")
  ) {
    return "production";
  }

  // Check if this is a pull request
  if (
    context.eventName === "pull_request" ||
    context.eventName === "pull_request_review"
  ) {
    return "staging";
  }

  // Default to development
  return "development";
}

/**
 * Sanitize Sentry events to remove sensitive data
 */
function sanitizeSentryEvent(
  event: Sentry.ErrorEvent,
): Sentry.ErrorEvent | null {
  // Sanitize exception messages
  if (event.exception?.values) {
    for (const exception of event.exception.values) {
      if (exception.value) {
        exception.value = sanitizeString(exception.value, 1000);
      }
    }
  }

  // Sanitize request URLs
  if (event.request?.url) {
    event.request.url = sanitizeString(event.request.url, 200);
  }

  // Sanitize extra data
  if (event.extra) {
    event.extra = sanitizeObject(event.extra, 3);
  }

  return event;
}

/**
 * Sanitize breadcrumbs to remove sensitive data
 */
function sanitizeBreadcrumb(
  breadcrumb: Sentry.Breadcrumb,
): Sentry.Breadcrumb | null {
  if (breadcrumb.message) {
    breadcrumb.message = sanitizeString(breadcrumb.message, 200);
  }

  if (breadcrumb.data) {
    breadcrumb.data = sanitizeObject(breadcrumb.data, 2);
  }

  return breadcrumb;
}
