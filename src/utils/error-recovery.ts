/**
 * Enhanced error recovery utilities for GitHub MCP operations
 */

import { retryWithBackoff, type RetryOptions } from "./retry";
import { captureError, addBreadcrumb } from "./sentry";

export type ErrorCategory =
  | "network" // Network/connectivity issues
  | "rate_limit" // GitHub rate limiting
  | "authentication" // Token/auth issues
  | "not_found" // Resource not found
  | "validation" // Input validation errors
  | "permission" // Permission denied
  | "server_error" // GitHub server errors
  | "unknown"; // Uncategorized errors

export type ErrorRecoveryStrategy =
  | "retry" // Retry with backoff
  | "skip" // Skip operation and continue
  | "fail_fast" // Fail immediately
  | "degrade"; // Use fallback/degraded functionality

export type RecoveryConfig = {
  strategy: ErrorRecoveryStrategy;
  retryOptions?: RetryOptions;
  fallbackValue?: unknown;
  skipWarning?: string;
};

/**
 * Categorizes GitHub API errors based on error message and properties
 */
export function categorizeError(error: unknown): ErrorCategory {
  if (!(error instanceof Error)) {
    return "unknown";
  }

  const message = error.message.toLowerCase();

  // Check for specific GitHub error patterns
  if (message.includes("rate limit") || message.includes("rate_limit")) {
    return "rate_limit";
  }

  if (message.includes("not found") || message.includes("404")) {
    return "not_found";
  }

  if (message.includes("unauthorized") || message.includes("401")) {
    return "authentication";
  }

  if (message.includes("forbidden") || message.includes("403")) {
    return "permission";
  }

  if (
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("connection") ||
    message.includes("econnreset")
  ) {
    return "network";
  }

  if (
    message.includes("server error") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504")
  ) {
    return "server_error";
  }

  if (
    message.includes("invalid") ||
    message.includes("validation") ||
    message.includes("format")
  ) {
    return "validation";
  }

  return "unknown";
}

/**
 * Get recovery configuration based on error category and operation context
 */
export function getRecoveryConfig(
  category: ErrorCategory,
  isCritical: boolean = false,
): RecoveryConfig {
  switch (category) {
    case "rate_limit":
      return {
        strategy: "retry",
        retryOptions: {
          maxAttempts: 3,
          initialDelayMs: 10000,
          maxDelayMs: 60000,
          backoffFactor: 2,
        },
      };

    case "network":
    case "server_error":
      return {
        strategy: "retry",
        retryOptions: {
          maxAttempts: isCritical ? 5 : 2,
          initialDelayMs: 2000,
          maxDelayMs: 15000,
          backoffFactor: 2,
        },
      };

    case "authentication":
    case "permission":
    case "validation":
      return {
        strategy: "fail_fast",
      };

    case "not_found":
      return {
        strategy: isCritical ? "fail_fast" : "skip",
        skipWarning: "Resource not found - continuing with available data",
      };

    case "unknown":
      return {
        strategy: isCritical ? "retry" : "skip",
        retryOptions: { maxAttempts: 1 },
        skipWarning:
          "Unknown error encountered - continuing with degraded functionality",
      };

    default:
      return { strategy: "fail_fast" };
  }
}

/**
 * Enhanced error recovery wrapper for critical operations
 */
export async function withErrorRecovery<T>(
  operation: () => Promise<T>,
  operationName: string,
  isCritical: boolean = false,
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    const category = categorizeError(error);
    const config = getRecoveryConfig(category, isCritical);

    console.warn(
      `Error in ${operationName} (${category}):`,
      error instanceof Error ? error.message : String(error),
    );

    // Add breadcrumb for error context
    addBreadcrumb(
      `Error in ${operationName}`,
      "error",
      {
        operation: operationName,
        category,
        strategy: config.strategy,
        isCritical,
      },
      "error",
    );

    switch (config.strategy) {
      case "retry":
        try {
          console.log(`Retrying ${operationName} with recovery strategy...`);
          addBreadcrumb(`Retrying ${operationName}`, "retry", {
            attempts: config.retryOptions?.maxAttempts,
          });
          return await retryWithBackoff(operation, config.retryOptions);
        } catch (retryError) {
          // Capture error after retry failure for critical operations
          if (isCritical) {
            captureError(retryError, {
              operation: "error_recovery",
              phase: "retry_failed",
              operationName,
              category,
              retryAttempts: config.retryOptions?.maxAttempts || 0,
              recoveryStrategy: config.strategy,
            });
            throw retryError;
          }
          console.warn(
            `${operationName} failed after retry attempts, continuing...`,
          );
          return null;
        }

      case "skip":
        if (config.skipWarning) {
          console.warn(config.skipWarning);
        }
        return (config.fallbackValue as T) || null;

      case "degrade":
        console.log(`${operationName} using degraded functionality`);
        return (config.fallbackValue as T) || null;

      case "fail_fast":
      default:
        // Capture critical errors that will cause failure
        captureError(error, {
          operation: "error_recovery",
          phase: "fail_fast",
          operationName,
          category,
          recoveryStrategy: config.strategy,
        });
        throw error;
    }
  }
}

/**
 * Batch operation error recovery - continues processing other items on individual failures
 */
export async function withBatchErrorRecovery<TInput, TResult>(
  items: TInput[],
  operation: (item: TInput) => Promise<TResult>,
  operationName: string,
  {
    maxConcurrent = 5,
    failOnAnyError = false,
    isCritical = false,
  }: {
    maxConcurrent?: number;
    failOnAnyError?: boolean;
    isCritical?: boolean;
  } = {},
): Promise<{
  results: (TResult | null)[];
  errors: Array<{ item: TInput; error: unknown }>;
}> {
  const results: (TResult | null)[] = [];
  const errors: Array<{ item: TInput; error: unknown }> = [];

  // Process in batches to avoid overwhelming the API
  for (let i = 0; i < items.length; i += maxConcurrent) {
    const batch = items.slice(i, i + maxConcurrent);

    const batchPromises = batch.map(async (item) => {
      try {
        const result = await withErrorRecovery(
          () => operation(item),
          `${operationName} for item ${JSON.stringify(item)}`,
          isCritical,
        );
        return { result, error: null };
      } catch (error) {
        errors.push({ item, error });
        if (failOnAnyError) {
          throw error;
        }
        return { result: null, error };
      }
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults.map((r) => r.result));
  }

  if (errors.length > 0) {
    console.warn(
      `${operationName} had ${errors.length}/${items.length} failures`,
    );
  }

  return { results, errors };
}

/**
 * Circuit breaker pattern for preventing cascading failures
 */
export class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  constructor(
    private readonly failureThreshold = 5,
    private readonly timeoutMs = 60000,
    private readonly resetTimeoutMs = 30000,
  ) {}

  async execute<T>(
    operation: () => Promise<T>,
    operationName: string,
  ): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime < this.resetTimeoutMs) {
        throw new Error(`Circuit breaker is OPEN for ${operationName}`);
      } else {
        this.state = "half-open";
        console.log(`Circuit breaker is HALF-OPEN for ${operationName}`);
      }
    }

    try {
      const result = await Promise.race([
        operation(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Operation timeout")),
            this.timeoutMs,
          ),
        ),
      ]);

      // Success - reset circuit breaker
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.failureThreshold) {
      this.state = "open";
      console.warn(
        `Circuit breaker is now OPEN after ${this.failures} failures`,
      );

      // Capture circuit breaker trip as it indicates systemic issues
      captureError(new Error("Circuit breaker tripped"), {
        operation: "circuit_breaker",
        phase: "trip",
        failures: this.failures,
        threshold: this.failureThreshold,
      });
    }
  }

  getState(): string {
    return this.state;
  }
}
