/**
 * Sanitization utilities for secure logging and error reporting
 */

// Common patterns that should be sanitized from logs
const SENSITIVE_PATTERNS = [
  // GitHub tokens
  /ghp_[a-zA-Z0-9]{36}/gi,
  /github_pat_[a-zA-Z0-9_]{82}/gi,
  /gho_[a-zA-Z0-9]{36}/gi,
  /ghu_[a-zA-Z0-9]{36}/gi,
  /ghs_[a-zA-Z0-9]{36}/gi,
  /ghr_[a-zA-Z0-9]{36}/gi,

  // Generic secrets/tokens
  /(?:api[_-]?key|secret|token|password|pwd|auth)[_-]*[:=]\s*['\"]?[a-zA-Z0-9+/]{8,}['\"]?/gi,

  // AWS credentials
  /AKIA[0-9A-Z]{16}/gi,
  /[0-9a-zA-Z/+]{40}/g,

  // Other common secret patterns
  /sk-[a-zA-Z0-9]{48}/gi, // OpenAI API keys
  /xoxb-[0-9]{12}-[0-9]{12}-[a-zA-Z0-9]{24}/gi, // Slack bot tokens
];

/**
 * Sanitizes a string by removing or masking sensitive information
 */
export function sanitizeString(
  input: string | null | undefined,
  maxLength: number = 500,
): string {
  if (!input) return "";

  let sanitized = input;

  // Apply sensitive pattern replacements
  SENSITIVE_PATTERNS.forEach((pattern) => {
    sanitized = sanitized.replace(pattern, "[REDACTED_SECRET]");
  });

  // Truncate to prevent log spam
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength) + "... [TRUNCATED]";
  }

  return sanitized;
}

/**
 * Sanitizes an object for safe logging, recursively sanitizing string values
 */
export function sanitizeObject<T extends Record<string, any>>(
  obj: T | null | undefined,
  maxDepth: number = 3,
  currentDepth: number = 0,
): Partial<T> {
  if (!obj || currentDepth >= maxDepth) {
    return {};
  }

  const sanitized: Partial<T> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      sanitized[key as keyof T] = sanitizeString(value) as T[keyof T];
    } else if (typeof value === "object" && value !== null) {
      sanitized[key as keyof T] = sanitizeObject(
        value,
        maxDepth,
        currentDepth + 1,
      ) as T[keyof T];
    } else if (typeof value === "number" || typeof value === "boolean") {
      sanitized[key as keyof T] = value as T[keyof T];
    } else {
      // Skip functions, symbols, etc.
      continue;
    }
  }

  return sanitized;
}

/**
 * Creates sanitized context for Sentry error reporting
 */
export function createSanitizedSentryContext(
  context: Record<string, any>,
): Record<string, any> {
  return sanitizeObject(context, 2); // Limit depth for Sentry context
}

/**
 * Sanitizes file paths to remove potential sensitive directory names
 */
export function sanitizeFilePath(filePath: string | null | undefined): string {
  if (!filePath) return "";

  // Replace user home directories and other potentially sensitive paths
  let sanitized = filePath
    .replace(/\/Users\/[^/]+/g, "/Users/[USER]")
    .replace(/\/home\/[^/]+/g, "/home/[USER]")
    .replace(/C:\\Users\\[^\\]+/g, "C:\\Users\\[USER]");

  return sanitizeString(sanitized, 200);
}

/**
 * Sanitizes commit messages and PR bodies for safe logging
 */
export function sanitizeCommitContent(
  content: string | null | undefined,
): string {
  if (!content) return "";

  // First apply general sanitization
  let sanitized = sanitizeString(content, 1000);

  // Additional patterns specific to commit content
  sanitized = sanitized
    .replace(/Co-authored-by:\s*[^\n]+/gi, "Co-authored-by: [AUTHOR]")
    .replace(/Signed-off-by:\s*[^\n]+/gi, "Signed-off-by: [AUTHOR]");

  return sanitized;
}

/**
 * Validates GitHub thread ID format
 * GitHub thread IDs are base64-encoded strings that typically start with specific prefixes
 */
export function validateGitHubThreadId(
  threadId: string | null | undefined,
): boolean {
  if (!threadId || typeof threadId !== "string") {
    return false;
  }

  // GitHub thread IDs are GraphQL node IDs with prefixes and base64-encoded sections
  // Format: PREFIX_base64EncodedString (e.g., "PRRT_kwDOGOHu5c5ZmzO9", "RT_kwDOExample123")
  // Allow underscores, hyphens, and standard base64 characters
  const githubNodeIdPattern = /^[A-Za-z0-9_+-/]+=*$/;

  // Basic length check (GitHub IDs are typically longer than 10 characters)
  if (threadId.length < 10 || threadId.length > 100) {
    return false;
  }

  return githubNodeIdPattern.test(threadId);
}

/**
 * Result of validating a GitHub review thread ID
 */
export interface ReviewThreadIdValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates GitHub PullRequestReviewThread ID format with prefix checking
 * This provides more specific validation for thread IDs used with MCP tools like reply_to_thread
 *
 * Valid prefixes:
 * - PRRT_ = PullRequestReviewThread (correct for thread operations)
 * - RT_ = ReviewThread (also valid for some operations)
 *
 * Invalid prefixes (common mistakes):
 * - PRRC_ = PullRequestReviewComment (comment ID, not thread ID)
 * - IC_ = IssueComment (wrong entity type)
 */
export function validateGitHubReviewThreadId(
  threadId: string | null | undefined,
): ReviewThreadIdValidationResult {
  if (!threadId || typeof threadId !== "string") {
    return {
      valid: false,
      error: "Thread ID is required and must be a string",
    };
  }

  // Basic format validation first
  if (!validateGitHubThreadId(threadId)) {
    return {
      valid: false,
      error: `Invalid thread ID format: "${threadId}". Thread ID should be a valid GitHub GraphQL ID.`,
    };
  }

  // Check for valid thread prefixes
  const validThreadPrefixes = ["PRRT_", "RT_"];
  const hasValidPrefix = validThreadPrefixes.some((prefix) =>
    threadId.startsWith(prefix),
  );

  if (hasValidPrefix) {
    return { valid: true };
  }

  // Check for common mistakes - using comment IDs instead of thread IDs
  if (threadId.startsWith("PRRC_")) {
    return {
      valid: false,
      error:
        `Invalid thread ID: "${threadId}" is a PullRequestReviewComment ID (PRRC_*), not a thread ID. ` +
        `Use the "threadId" field (PRRT_*) from get_file_comments, not "comment.id".`,
    };
  }

  if (threadId.startsWith("IC_")) {
    return {
      valid: false,
      error:
        `Invalid thread ID: "${threadId}" is an IssueComment ID (IC_*), not a review thread ID. ` +
        `Review thread IDs start with PRRT_ or RT_.`,
    };
  }

  // Unknown prefix - might be valid but we can't verify
  return {
    valid: false,
    error:
      `Unrecognized thread ID prefix in "${threadId}". ` +
      `Expected a PullRequestReviewThread ID starting with PRRT_ or RT_.`,
  };
}

/**
 * Validates GitHub database ID format
 * Database IDs are typically numeric or numeric strings
 */
export function validateGitHubDatabaseId(
  databaseId: string | number | null | undefined,
): boolean {
  if (databaseId === null || databaseId === undefined) {
    return false;
  }

  if (typeof databaseId === "number") {
    return Number.isInteger(databaseId) && databaseId > 0;
  }

  if (typeof databaseId === "string") {
    const parsed = parseInt(databaseId, 10);
    return !isNaN(parsed) && parsed > 0 && parsed.toString() === databaseId;
  }

  return false;
}

/**
 * Sanitizes and validates thread ID for safe use
 */
export function sanitizeAndValidateThreadId(
  threadId: string | null | undefined,
): string | null {
  if (!validateGitHubThreadId(threadId)) {
    console.warn(`Invalid thread ID format: ${threadId}`);
    return null;
  }

  return sanitizeString(threadId!, 100);
}
