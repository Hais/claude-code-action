#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import {
  createSanitizedSentryContext,
  sanitizeString,
  sanitizeCommitContent,
  validateGitHubThreadId,
} from "../utils/sanitization";
import { createOctokit, type Octokits } from "../github/api/client";
import { sanitizeContent } from "../github/utils/sanitizer";
import { generateMetadataComment } from "../github/utils/metadata-parser";
import {
  withErrorRecovery,
  withBatchErrorRecovery,
  CircuitBreaker,
} from "../utils/error-recovery";

// Initialize Sentry for error tracking
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.GITHUB_ACTIONS ? "github-actions" : "development",
    initialScope: {
      tags: {
        service: "github-review-server",
        repository: `${process.env.REPO_OWNER}/${process.env.REPO_NAME}`,
        pr_number: process.env.PR_NUMBER,
        github_actor: process.env.GITHUB_ACTOR,
        github_run_id: process.env.GITHUB_RUN_ID,
      },
    },
  });
} else {
  console.warn("SENTRY_DSN not provided - error tracking disabled");
}

// Get repository and PR information from environment variables
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const PR_NUMBER = process.env.PR_NUMBER;
const CLAUDE_COMMENT_ID = process.env.CLAUDE_COMMENT_ID;

if (!REPO_OWNER || !REPO_NAME || !PR_NUMBER) {
  const error = new Error(
    "REPO_OWNER, REPO_NAME, and PR_NUMBER environment variables are required",
  );
  console.error("Error:", error.message);
  Sentry.captureException(error);
  process.exit(1);
}

// GitHub Review MCP Server - Provides PR review submission functionality
const server = new McpServer({
  name: "GitHub Review Server",
  version: "0.0.1",
});

// Circuit breaker for GitHub API operations to prevent cascading failures
const githubApiCircuitBreaker = new CircuitBreaker(
  5, // failure threshold
  30000, // timeout (30 seconds)
  60000, // reset timeout (1 minute)
);

/**
 * Fetch all review threads with proper pagination and memory management
 */
async function fetchAllReviewThreads(
  octokits: Octokits,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<
  Array<{
    id: string;
    isResolved: boolean;
    comments: {
      nodes: Array<{
        id: string;
        databaseId: number;
        body: string;
        path: string;
        line: number | null;
        originalLine: number | null;
        author: {
          login: string;
        };
        createdAt: string;
        updatedAt: string;
      }>;
    };
  }>
> {
  let allThreads: any[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  // Memory management: Limit total threads and comments to prevent excessive memory usage
  const MAX_THREADS = 500; // Reasonable limit for PR review threads
  const MAX_COMMENTS_PER_THREAD = 200; // Limit comments per thread
  let threadCount = 0;

  while (hasNextPage && threadCount < MAX_THREADS) {
    const result: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: {
              hasNextPage: boolean;
              endCursor: string | null;
            };
            nodes: Array<{
              id: string;
              isResolved: boolean;
              comments: {
                pageInfo: {
                  hasNextPage: boolean;
                  endCursor: string | null;
                };
                nodes: Array<{
                  id: string;
                  databaseId: number;
                  body: string;
                  path: string;
                  line: number | null;
                  originalLine: number | null;
                  author: {
                    login: string;
                  };
                  createdAt: string;
                  updatedAt: string;
                }>;
              };
            }>;
          };
        };
      };
    } = await githubApiCircuitBreaker.execute(
      () =>
        octokits.graphql<{
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: {
                  hasNextPage: boolean;
                  endCursor: string | null;
                };
                nodes: Array<{
                  id: string;
                  isResolved: boolean;
                  comments: {
                    pageInfo: {
                      hasNextPage: boolean;
                      endCursor: string | null;
                    };
                    nodes: Array<{
                      id: string;
                      databaseId: number;
                      body: string;
                      path: string;
                      line: number | null;
                      originalLine: number | null;
                      author: {
                        login: string;
                      };
                      createdAt: string;
                      updatedAt: string;
                    }>;
                  };
                }>;
              };
            };
          };
        }>(
          `
      query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 50, after: $cursor) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                isResolved
                comments(first: 100) {
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                  nodes {
                    id
                    databaseId
                    body
                    path
                    line
                    originalLine
                    author {
                      login
                    }
                    createdAt
                    updatedAt
                  }
                }
              }
            }
          }
        }
      }
      `,
          {
            owner,
            repo,
            number: pullNumber,
            cursor,
          },
        ),
      `fetchAllReviewThreads page ${threadCount}`,
    );

    const threads = result.repository.pullRequest.reviewThreads.nodes;

    // For each thread that has more comments, fetch them with pagination
    for (const thread of threads) {
      let commentCursor = thread.comments.pageInfo.endCursor;
      let hasMoreComments = thread.comments.pageInfo.hasNextPage;
      let commentCount = thread.comments.nodes.length;

      while (hasMoreComments && commentCount < MAX_COMMENTS_PER_THREAD) {
        const commentResult = await withErrorRecovery(
          () =>
            octokits.graphql<{
              node: {
                comments: {
                  pageInfo: {
                    hasNextPage: boolean;
                    endCursor: string | null;
                  };
                  nodes: Array<{
                    id: string;
                    databaseId: number;
                    body: string;
                    path: string;
                    line: number | null;
                    originalLine: number | null;
                    author: {
                      login: string;
                    };
                    createdAt: string;
                    updatedAt: string;
                  }>;
                };
              };
            }>(
              `
          query($threadId: ID!, $cursor: String) {
            node(id: $threadId) {
              ... on PullRequestReviewThread {
                comments(first: 100, after: $cursor) {
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                  nodes {
                    id
                    databaseId
                    body
                    path
                    line
                    originalLine
                    author {
                      login
                    }
                    createdAt
                    updatedAt
                  }
                }
              }
            }
          }
          `,
              {
                threadId: thread.id,
                cursor: commentCursor,
              },
            ),
          `fetchCommentsForThread ${thread.id}`,
          false, // not critical - can continue without all comments
        );

        // Handle case where comment fetching failed and returned null
        if (!commentResult) {
          console.warn(
            `Failed to fetch additional comments for thread ${thread.id}, continuing with available comments`,
          );
          break;
        }

        const newComments = commentResult.node.comments.nodes;
        const remainingSpace = MAX_COMMENTS_PER_THREAD - commentCount;
        const commentsToAdd = newComments.slice(0, remainingSpace);

        thread.comments.nodes.push(...commentsToAdd);
        commentCount += commentsToAdd.length;
        commentCursor = commentResult.node.comments.pageInfo.endCursor;
        hasMoreComments = commentResult.node.comments.pageInfo.hasNextPage;

        // Break if we've hit the limit
        if (commentCount >= MAX_COMMENTS_PER_THREAD) {
          console.warn(
            `Thread ${thread.id} has more than ${MAX_COMMENTS_PER_THREAD} comments, truncating for memory management`,
          );
          break;
        }
      }
    }

    allThreads.push(...threads);
    threadCount += threads.length;
    cursor = result.repository.pullRequest.reviewThreads.pageInfo.endCursor;
    hasNextPage =
      result.repository.pullRequest.reviewThreads.pageInfo.hasNextPage;

    // Memory management: Clear intermediate data
    threads.length = 0;
  }

  // Log if we hit limits for debugging
  if (threadCount >= MAX_THREADS && hasNextPage) {
    console.warn(
      `PR has more than ${MAX_THREADS} threads, truncated for memory management`,
    );
  }

  return allThreads;
}

server.tool(
  "submit_pr_review",
  "Submit a pull request review with APPROVE, REQUEST_CHANGES, or COMMENT event",
  {
    event: z
      .enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"])
      .describe(
        "The review action: APPROVE (approve the PR), REQUEST_CHANGES (request changes), or COMMENT (general feedback without approval/rejection)",
      ),
    body: z
      .string()
      .describe(
        "The review comment body (supports markdown). Required for REQUEST_CHANGES and COMMENT events.",
      ),
    commit_id: z
      .string()
      .optional()
      .describe("Specific commit SHA to review (defaults to latest commit)"),
  },
  async ({ event, body, commit_id }) => {
    try {
      const githubToken = process.env.GITHUB_TOKEN;

      if (!githubToken) {
        throw new Error("GITHUB_TOKEN environment variable is required");
      }

      const owner = REPO_OWNER;
      const repo = REPO_NAME;
      const pull_number = parseInt(PR_NUMBER, 10);

      const octokits = createOctokit(githubToken);
      const octokit = octokits.rest;

      // Validate that body is provided for events that require it
      if (
        (event === "REQUEST_CHANGES" || event === "COMMENT") &&
        !body.trim()
      ) {
        throw new Error(`A review body is required for ${event} events`);
      }

      // Sanitize the review body to remove any potential GitHub tokens
      const sanitizedBody = sanitizeContent(body);

      const pr = await octokit.pulls.get({
        owner,
        repo,
        pull_number,
      });

      // Pre-flight check: Look for existing pending reviews
      const pendingReviews = await getPendingReviews(
        octokits,
        owner,
        repo,
        pull_number,
      );

      let result: any;
      let handledExistingReview = false;

      if (pendingReviews.length > 0) {
        // Handle existing pending review
        const pendingReview = pendingReviews[0]!; // Take the first (should only be one)
        console.log(
          `Found existing pending review (ID: ${pendingReview.id}), attempting to submit it with merged content`,
        );

        const handleResult = await handleExistingPendingReview(
          octokits,
          owner,
          repo,
          pull_number,
          { id: pendingReview.id, body: pendingReview.body },
          {
            body: sanitizedBody,
            event,
            commit_id: commit_id || pr.data.head.sha,
          },
        );

        if (handleResult.success) {
          // Successfully submitted existing pending review with merged content
          result = { data: { id: handleResult.review_id } };
          handledExistingReview = true;
        } else if (handleResult.action === "dismissed_pending_review") {
          // Dismissed existing review, now create new one
          console.log("Dismissed existing pending review, creating new review");
        } else {
          // Failed to handle existing pending review
          throw new Error(
            `Failed to handle existing pending review: ${handleResult.message}`,
          );
        }
      }

      // Create new review if we didn't handle an existing one
      if (!handledExistingReview) {
        result = await octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number,
          body: sanitizedBody,
          event,
          commit_id: commit_id || pr.data.head.sha,
        });
      }

      // After successful review submission, automatically add tracking comment metadata
      await addTrackingCommentMetadata(
        octokits,
        owner,
        repo,
        result.data.id,
        commit_id || pr.data.head.sha,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                review_id: result.data.id,
                html_url: result.data.html_url,
                state: result.data.state,
                event,
                message: `PR review submitted successfully with ${event} state`,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Handle specific "pending review" constraint error
      if (errorMessage.includes("User can only have one pending review")) {
        console.warn("Detected pending review constraint error, attempting recovery");
        
        // Attempt recovery by finding and handling pending review
        try {
          const recoveryOctokits = createOctokit(process.env.GITHUB_TOKEN!);
          const pendingReviews = await getPendingReviews(
            recoveryOctokits,
            REPO_OWNER,
            REPO_NAME,
            parseInt(PR_NUMBER, 10),
          );

          if (pendingReviews.length > 0) {
            const pendingReview = pendingReviews[0]!;
            console.log(`Found pending review ${pendingReview.id} during error recovery`);

            const handleResult = await handleExistingPendingReview(
              recoveryOctokits,
              REPO_OWNER,
              REPO_NAME,
              parseInt(PR_NUMBER, 10),
              { id: pendingReview.id, body: pendingReview.body },
              { body: sanitizeContent(body), event, commit_id },
            );

            if (handleResult.success) {
              // Recovery successful - return success response
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        success: true,
                        review_id: handleResult.review_id,
                        html_url: `https://github.com/${REPO_OWNER}/${REPO_NAME}/pull/${PR_NUMBER}#pullrequestreview-${handleResult.review_id}`,
                        state: event,
                        event,
                        message: `PR review recovered and submitted successfully: ${handleResult.message}`,
                        recovery_action: handleResult.action,
                      },
                      null,
                      2,
                    ),
                  },
                ],
              };
            }
          }

          // Recovery failed - provide helpful error message
          return {
            content: [
              {
                type: "text",
                text: `Error: ${errorMessage}\n\nRecovery attempted but failed. You have a pending review on this PR that must be submitted or dismissed first. Please:\n1. Check your pending review in the GitHub UI\n2. Submit it with APPROVE, REQUEST_CHANGES, or COMMENT\n3. Or dismiss the pending review\n4. Then retry this operation`,
              },
            ],
            error: errorMessage,
            isError: true,
          };
        } catch (recoveryError) {
          console.warn("Recovery attempt failed:", recoveryError);
          // Fall through to normal error handling
        }
      }

      // Capture submit_pr_review errors with context
      Sentry.withScope((scope) => {
        scope.setTag("operation", "submit_pr_review");
        scope.setContext("repository", {
          owner: REPO_OWNER,
          repo: REPO_NAME,
          pull_number: parseInt(PR_NUMBER, 10),
        });
        scope.setContext(
          "review_details",
          createSanitizedSentryContext({
            event: sanitizeString(event),
            body: sanitizeCommitContent(body),
            commit_id: sanitizeString(commit_id),
          }),
        );
        scope.setLevel("error");
        Sentry.captureException(
          error instanceof Error
            ? error
            : new Error(sanitizeString(errorMessage)),
        );
      });

      // Provide more helpful error messages for common issues
      let helpMessage = "";
      if (errorMessage.includes("User can only have one pending review")) {
        helpMessage =
          "\n\nThis error occurs when you already have a pending review on this PR. GitHub only allows one pending review per user per PR. The system attempted automatic recovery but it failed. Please check the GitHub UI and submit or dismiss your existing pending review, then try again.";
      } else if (errorMessage.includes("Validation Failed")) {
        helpMessage =
          "\n\nThis usually means the PR has already been merged, closed, or there's an issue with the commit SHA.";
      } else if (errorMessage.includes("Not Found")) {
        helpMessage =
          "\n\nThis usually means the PR number or repository is incorrect.";
      } else if (errorMessage.includes("Forbidden")) {
        helpMessage =
          "\n\nThis usually means you don't have permission to submit reviews on this repository.";
      } else if (errorMessage.includes("Unprocessable Entity")) {
        helpMessage =
          "\n\nThis usually indicates a problem with the request data or PR state. Check if the PR is still open and the commit SHA is valid.";
      }

      return {
        content: [
          {
            type: "text",
            text: `Error submitting PR review: ${errorMessage}${helpMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

/**
 * Automatically adds tracking comment metadata after successful PR review submission.
 * This ensures consistent metadata embedding without relying on the LLM.
 */
async function addTrackingCommentMetadata(
  octokits: Octokits,
  owner: string,
  repo: string,
  reviewId: number,
  commitSha: string,
): Promise<void> {
  try {
    // Only update tracking comment if CLAUDE_COMMENT_ID is available
    if (!CLAUDE_COMMENT_ID) {
      console.log("CLAUDE_COMMENT_ID not available - skipping metadata update");
      return;
    }

    const commentId = parseInt(CLAUDE_COMMENT_ID, 10);
    if (isNaN(commentId)) {
      console.warn(
        "Invalid CLAUDE_COMMENT_ID format - skipping metadata update",
      );
      return;
    }

    // Get the current tracking comment content
    const comment = await octokits.rest.issues.getComment({
      owner,
      repo,
      comment_id: commentId,
    });

    const currentBody = comment.data.body || "";

    // Generate metadata for this review
    const metadata = {
      lastReviewedSha: commitSha,
      reviewDate: new Date().toISOString(),
      reviewId: reviewId.toString(),
    };

    const metadataComment = generateMetadataComment(metadata);

    // Check if metadata already exists in the comment
    const metadataRegex = /<!--\s*pr-review-metadata-v1:\s*{.*?}\s*-->/s;
    let updatedBody: string;

    if (metadataRegex.test(currentBody)) {
      // Replace existing metadata
      updatedBody = currentBody.replace(metadataRegex, metadataComment);
    } else {
      // Append metadata to the end of the comment
      updatedBody = currentBody + "\n\n" + metadataComment;
    }

    // Update the tracking comment with metadata
    await octokits.rest.issues.updateComment({
      owner,
      repo,
      comment_id: commentId,
      body: updatedBody,
    });

    console.log(
      `Successfully added tracking metadata to comment ${commentId} for review ${reviewId}`,
    );
  } catch (error) {
    // Log but don't fail the review submission if metadata update fails
    console.warn("Failed to add tracking comment metadata:", error);

    // Capture metadata update errors with context for debugging
    Sentry.withScope((scope) => {
      scope.setTag("operation", "add_tracking_metadata");
      scope.setContext(
        "metadata_details",
        createSanitizedSentryContext({
          comment_id: sanitizeString(CLAUDE_COMMENT_ID?.toString() || ""),
          review_id: sanitizeString(reviewId.toString()),
          commit_sha: sanitizeString(commitSha, 50), // Commit SHAs are safe but limit length
        }),
      );
      scope.setLevel("warning");
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  }
}

/**
 * Get existing pending reviews for the authenticated user on a specific PR
 */
async function getPendingReviews(
  octokits: Octokits,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<Array<{
  id: number;
  node_id: string;
  state: string;
  body: string;
  user: { login: string };
}>> {
  try {
    const reviews = await octokits.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: pullNumber,
    });

    // Filter for pending reviews by the authenticated user
    const pendingReviews = reviews.data.filter(
      (review) => review.state === "PENDING"
    );

    return pendingReviews.map((review) => ({
      id: review.id,
      node_id: review.node_id,
      state: review.state,
      body: review.body || "",
      user: review.user || { login: "" },
    }));
  } catch (error) {
    console.warn("Failed to fetch pending reviews:", error);
    return [];
  }
}

/**
 * Handle existing pending review by submitting it with merged content
 */
async function handleExistingPendingReview(
  octokits: Octokits,
  owner: string,
  repo: string,
  pullNumber: number,
  pendingReview: { id: number; body: string },
  newReviewData: { body: string; event: string; commit_id?: string },
): Promise<{
  success: boolean;
  action: string;
  review_id: number;
  message: string;
}> {
  try {
    // Strategy: Submit the existing pending review with merged content
    // Combine existing body with new body if both exist
    let mergedBody = "";
    
    if (pendingReview.body && pendingReview.body.trim()) {
      mergedBody += pendingReview.body.trim();
    }
    
    if (newReviewData.body && newReviewData.body.trim()) {
      if (mergedBody) {
        mergedBody += "\n\n---\n\n"; // Separator between old and new content
      }
      mergedBody += newReviewData.body.trim();
    }

    // Submit the pending review with merged content
    const result = await octokits.rest.pulls.submitReview({
      owner,
      repo,
      pull_number: pullNumber,
      review_id: pendingReview.id,
      body: mergedBody || newReviewData.body,
      event: newReviewData.event as "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    });

    return {
      success: true,
      action: "submitted_existing_pending_review",
      review_id: result.data.id,
      message: `Submitted existing pending review with merged content using ${newReviewData.event} state`,
    };
  } catch (error) {
    console.warn("Failed to submit existing pending review:", error);
    
    // Fallback: Try to dismiss the existing pending review and let caller create new one
    try {
      await octokits.rest.pulls.dismissReview({
        owner,
        repo,
        pull_number: pullNumber,
        review_id: pendingReview.id,
        message: "Dismissed to create new review",
      });
      
      return {
        success: false,
        action: "dismissed_pending_review",
        review_id: pendingReview.id,
        message: "Dismissed existing pending review - caller should retry creating new review",
      };
    } catch (dismissError) {
      console.warn("Failed to dismiss pending review:", dismissError);
      return {
        success: false,
        action: "failed_to_handle_pending",
        review_id: pendingReview.id,
        message: "Could not submit or dismiss existing pending review",
      };
    }
  }
}

server.tool(
  "get_file_comments",
  "Get all review comments for specific files in the PR, with thread information",
  {
    files: z
      .array(z.string())
      .optional()
      .describe(
        "Array of file paths to get comments for. If not provided, gets comments for all files.",
      ),
    includeResolved: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include resolved threads in the results"),
  },
  async ({ files, includeResolved }) => {
    try {
      const githubToken = process.env.GITHUB_TOKEN;

      if (!githubToken) {
        throw new Error("GITHUB_TOKEN environment variable is required");
      }

      const owner = REPO_OWNER;
      const repo = REPO_NAME;
      const pull_number = parseInt(PR_NUMBER, 10);

      const octokits = createOctokit(githubToken);

      // Get PR review threads with pagination for better coverage
      const threads = await fetchAllReviewThreads(
        octokits,
        owner,
        repo,
        pull_number,
      );

      // Filter threads based on resolution status
      const filteredThreads = includeResolved
        ? threads
        : threads.filter((thread) => !thread.isResolved);

      // Group comments by file if specific files requested
      let fileComments: Record<string, any[]> = {};

      for (const thread of filteredThreads) {
        for (const comment of thread.comments.nodes) {
          if (comment.path && (!files || files.includes(comment.path))) {
            if (!fileComments[comment.path]) {
              fileComments[comment.path] = [];
            }
            const pathComments = fileComments[comment.path];
            if (pathComments) {
              pathComments.push({
                threadId: thread.id,
                isResolved: thread.isResolved,
                comment: {
                  id: comment.id,
                  databaseId: comment.databaseId,
                  body: comment.body,
                  line: comment.line,
                  originalLine: comment.originalLine,
                  author: comment.author.login,
                  createdAt: comment.createdAt,
                  updatedAt: comment.updatedAt,
                },
              });
            }
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                fileComments,
                totalThreads: filteredThreads.length,
                totalComments: Object.values(fileComments).flat().length,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      Sentry.withScope((scope) => {
        scope.setTag("operation", "get_file_comments");
        scope.setContext("repository", {
          owner: REPO_OWNER,
          repo: REPO_NAME,
          pull_number: parseInt(PR_NUMBER, 10),
        });
        // Don't include files parameter in Sentry as it may contain sensitive paths
        scope.setLevel("error");
        Sentry.captureException(
          error instanceof Error
            ? error
            : new Error(sanitizeString(errorMessage)),
        );
      });

      return {
        content: [
          {
            type: "text",
            text: `Error getting file comments: ${errorMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

server.tool(
  "reply_to_thread",
  "Add a reply to an existing review thread without resolving it",
  {
    threadId: z
      .string()
      .describe(
        "The GraphQL thread ID to reply to (get this from get_file_comments or review queries)",
      ),
    body: z
      .string()
      .describe("The reply text to add to the thread (supports markdown)"),
  },
  async ({ threadId, body }) => {
    try {
      // Validate thread ID format before proceeding
      if (!validateGitHubThreadId(threadId)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: "Invalid thread ID format",
                  threadId,
                  suggestion:
                    "Thread ID should be a valid GitHub GraphQL ID (base64 encoded string)",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const githubToken = process.env.GITHUB_TOKEN;

      if (!githubToken) {
        throw new Error("GITHUB_TOKEN environment variable is required");
      }

      const octokits = createOctokit(githubToken);
      const sanitizedBody = sanitizeContent(body);

      const result = await withErrorRecovery(
        () =>
          octokits.graphql<{
            addPullRequestReviewThreadReply: {
              comment: {
                id: string;
                databaseId: number;
              };
            };
          }>(
            `
          mutation($threadId: ID!, $body: String!) {
            addPullRequestReviewThreadReply(input: {
              pullRequestReviewThreadId: $threadId
              body: $body
            }) {
              comment {
                id
                databaseId
              }
            }
          }
        `,
            {
              threadId,
              body: sanitizedBody,
            },
          ),
        `reply_to_thread ${threadId}`,
        true, // Critical operation - should retry on failure
      );

      if (!result) {
        throw new Error("Failed to add reply to thread after retry attempts");
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                commentId: result.addPullRequestReviewThreadReply.comment.id,
                databaseId:
                  result.addPullRequestReviewThreadReply.comment.databaseId,
                threadId,
                message: "Reply added to thread successfully",
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      Sentry.withScope((scope) => {
        scope.setTag("operation", "reply_to_thread");
        scope.setContext(
          "thread_details",
          createSanitizedSentryContext({
            thread_id: sanitizeString(threadId),
            body_preview: sanitizeCommitContent(body),
          }),
        );
        scope.setLevel("error");
        Sentry.captureException(
          error instanceof Error
            ? error
            : new Error(sanitizeString(errorMessage)),
        );
      });

      return {
        content: [
          {
            type: "text",
            text: `Error replying to thread: ${errorMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

server.tool(
  "get_thread_status",
  "Get the status and details of specific review threads",
  {
    threadIds: z
      .array(z.string())
      .optional()
      .describe(
        "Array of thread IDs to check. If not provided, gets status for all threads.",
      ),
  },
  async ({ threadIds }) => {
    try {
      const githubToken = process.env.GITHUB_TOKEN;

      if (!githubToken) {
        throw new Error("GITHUB_TOKEN environment variable is required");
      }

      const owner = REPO_OWNER;
      const repo = REPO_NAME;
      const pull_number = parseInt(PR_NUMBER, 10);

      const octokits = createOctokit(githubToken);

      const result = await octokits.graphql<{
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: Array<{
                id: string;
                isResolved: boolean;
                comments: {
                  totalCount: number;
                  nodes: Array<{
                    path: string;
                    line: number | null;
                    author: {
                      login: string;
                    };
                    createdAt: string;
                  }>;
                };
              }>;
            };
          };
        };
      }>(
        `
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100) {
                nodes {
                  id
                  isResolved
                  comments(first: 1) {
                    totalCount
                    nodes {
                      path
                      line
                      author {
                        login
                      }
                      createdAt
                    }
                  }
                }
              }
            }
          }
        }
      `,
        {
          owner,
          repo,
          number: pull_number,
        },
      );

      const allThreads = result.repository.pullRequest.reviewThreads.nodes;

      // Filter to specific threads if requested
      const filteredThreads = threadIds
        ? allThreads.filter((thread) => threadIds.includes(thread.id))
        : allThreads;

      const threadStatuses = filteredThreads.map((thread) => {
        const firstComment = thread.comments.nodes[0];
        return {
          threadId: thread.id,
          isResolved: thread.isResolved,
          commentCount: thread.comments.totalCount,
          file: firstComment?.path,
          line: firstComment?.line,
          author: firstComment?.author.login,
          createdAt: firstComment?.createdAt,
        };
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                threads: threadStatuses,
                summary: {
                  total: threadStatuses.length,
                  resolved: threadStatuses.filter((t) => t.isResolved).length,
                  unresolved: threadStatuses.filter((t) => !t.isResolved)
                    .length,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      Sentry.withScope((scope) => {
        scope.setTag("operation", "get_thread_status");
        scope.setContext("repository", {
          owner: REPO_OWNER,
          repo: REPO_NAME,
          pull_number: parseInt(PR_NUMBER, 10),
        });
        scope.setContext(
          "thread_details",
          createSanitizedSentryContext({
            thread_ids: threadIds?.map((id) => sanitizeString(id)),
            thread_count: threadIds?.length || 0,
          }),
        );
        scope.setLevel("error");
        Sentry.captureException(
          error instanceof Error
            ? error
            : new Error(sanitizeString(errorMessage)),
        );
      });

      return {
        content: [
          {
            type: "text",
            text: `Error getting thread status: ${errorMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

server.tool(
  "resolve_review_thread",
  "Resolve a pull request review thread (conversation) with an optional comment. Requires Contents: Read/Write permissions.",
  {
    threadId: z
      .string()
      .describe(
        "The GraphQL thread ID to resolve (different from REST comment IDs). Get this from review thread queries.",
      ),
    body: z
      .string()
      .optional()
      .describe(
        "Optional comment to add when resolving the thread (e.g., 'Fixed in latest commit', 'No longer applicable')",
      ),
  },
  async ({ threadId, body }) => {
    try {
      // Validate thread ID format before proceeding
      if (!validateGitHubThreadId(threadId)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: "Invalid thread ID format",
                  threadId,
                  suggestion:
                    "Thread ID should be a valid GitHub GraphQL ID (base64 encoded string)",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const githubToken = process.env.GITHUB_TOKEN;

      if (!githubToken) {
        throw new Error("GITHUB_TOKEN environment variable is required");
      }

      const octokit = createOctokit(githubToken);

      // If a comment is provided, add it to the thread first
      if (body && body.trim()) {
        const sanitizedBody = sanitizeContent(body);

        // Add a reply to the review thread
        try {
          await octokit.graphql(
            `
            mutation($threadId: ID!, $body: String!) {
              addPullRequestReviewThreadReply(input: {
                pullRequestReviewThreadId: $threadId
                body: $body
              }) {
                comment {
                  id
                }
              }
            }
          `,
            {
              threadId,
              body: sanitizedBody,
            },
          );
        } catch (replyError) {
          console.warn(
            "Failed to add reply before resolving thread:",
            replyError,
          );
          // Continue with resolution even if reply fails
        }
      }

      // Resolve the thread
      const result = await octokit.graphql<{
        resolveReviewThread: {
          thread: {
            id: string;
            isResolved: boolean;
          };
        };
      }>(
        `
        mutation($threadId: ID!) {
          resolveReviewThread(input: {
            threadId: $threadId
          }) {
            thread {
              id
              isResolved
            }
          }
        }
      `,
        {
          threadId,
        },
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                thread_id: threadId,
                is_resolved: result.resolveReviewThread.thread.isResolved,
                message: `Review thread resolved successfully${body ? " with comment" : ""}`,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Capture resolve_review_thread errors with context
      Sentry.withScope((scope) => {
        scope.setTag("operation", "resolve_review_thread");
        scope.setContext("repository", {
          owner: REPO_OWNER,
          repo: REPO_NAME,
          pull_number: parseInt(PR_NUMBER, 10),
        });
        scope.setContext(
          "thread_details",
          createSanitizedSentryContext({
            thread_id: sanitizeString(threadId),
            has_body: !!body,
            body_preview: body ? sanitizeCommitContent(body) : undefined,
          }),
        );
        scope.setLevel("error");
        Sentry.captureException(
          error instanceof Error
            ? error
            : new Error(sanitizeString(errorMessage)),
        );
      });

      // Provide more helpful error messages for common issues
      let helpMessage = "";
      if (errorMessage.includes("Resource not accessible by integration")) {
        helpMessage =
          "\n\nThis usually means insufficient permissions. The resolveReviewThread mutation requires Contents: Read/Write permissions, not just Pull Requests permissions.";
      } else if (errorMessage.includes("Could not resolve to a node")) {
        helpMessage =
          "\n\nThis usually means the thread ID is invalid or the thread doesn't exist. Make sure you're using the GraphQL thread ID, not a REST API comment ID.";
      } else if (errorMessage.includes("Not Found")) {
        helpMessage =
          "\n\nThis usually means the thread doesn't exist or you don't have access to it.";
      }

      return {
        content: [
          {
            type: "text",
            text: `Error resolving review thread: ${errorMessage}${helpMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

server.tool(
  "bulk_resolve_threads",
  "Resolve multiple review threads at once with optional comments",
  {
    threadIds: z
      .array(z.string())
      .describe("Array of GraphQL thread IDs to resolve"),
    comment: z
      .string()
      .optional()
      .describe(
        "Optional comment to add to all threads when resolving (e.g., 'All issues addressed in latest commit')",
      ),
  },
  async ({ threadIds, comment }) => {
    try {
      // Validate thread IDs first
      const invalidThreadIds = threadIds.filter(
        (id) => !validateGitHubThreadId(id),
      );
      if (invalidThreadIds.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Invalid thread ID format(s): ${invalidThreadIds.join(", ")}. Thread IDs must be valid base64-encoded GitHub identifiers.`,
            },
          ],
          error: "Invalid thread ID format",
          isError: true,
        };
      }

      const githubToken = process.env.GITHUB_TOKEN;

      if (!githubToken) {
        throw new Error("GITHUB_TOKEN environment variable is required");
      }

      const octokits = createOctokit(githubToken);

      // Use batch error recovery for better resilience
      const { results: batchResults, errors } = await withBatchErrorRecovery(
        threadIds,
        async (threadId: string) => {
          // Add comment if provided
          if (comment && comment.trim()) {
            const sanitizedComment = sanitizeContent(comment);
            await withErrorRecovery(
              () =>
                octokits.graphql(
                  `
                mutation($threadId: ID!, $body: String!) {
                  addPullRequestReviewThreadReply(input: {
                    pullRequestReviewThreadId: $threadId
                    body: $body
                  }) {
                    comment {
                      id
                    }
                  }
                }
              `,
                  {
                    threadId,
                    body: sanitizedComment,
                  },
                ),
              `addCommentToThread ${threadId}`,
              false, // Not critical - continue with resolution even if comment fails
            );
          }

          // Resolve the thread (this is the critical operation)
          const result = await withErrorRecovery(
            () =>
              octokits.graphql<{
                resolveReviewThread: {
                  thread: {
                    id: string;
                    isResolved: boolean;
                  };
                };
              }>(
                `
              mutation($threadId: ID!) {
                resolveReviewThread(input: {
                  threadId: $threadId
                }) {
                  thread {
                    id
                    isResolved
                  }
                }
              }
            `,
                {
                  threadId,
                },
              ),
            `resolveThread ${threadId}`,
            true, // This is critical - should retry on failure
          );

          return {
            threadId,
            success: result !== null,
            isResolved: result?.resolveReviewThread.thread.isResolved ?? false,
          };
        },
        "bulk_resolve_threads",
        {
          maxConcurrent: 3, // Limit concurrent operations to avoid rate limits
          failOnAnyError: false, // Continue processing other threads on individual failures
          isCritical: false, // Individual thread failures shouldn't stop the batch
        },
      );

      // Filter out null results and convert errors to expected format
      const results = batchResults.filter((r) => r !== null);
      const formattedErrors = errors.map(({ item: threadId, error }) => ({
        threadId,
        error: error instanceof Error ? error.message : String(error),
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: formattedErrors.length === 0,
                resolved: results.length,
                failed: formattedErrors.length,
                results,
                errors: formattedErrors,
                message: `Resolved ${results.length}/${threadIds.length} threads${comment ? " with comment" : ""}`,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      Sentry.withScope((scope) => {
        scope.setTag("operation", "bulk_resolve_threads");
        scope.setContext(
          "thread_details",
          createSanitizedSentryContext({
            thread_ids: threadIds.map((id) => sanitizeString(id)),
            thread_count: threadIds.length,
            has_comment: !!comment,
            comment_preview: comment
              ? sanitizeCommitContent(comment)
              : undefined,
          }),
        );
        scope.setLevel("error");
        Sentry.captureException(
          error instanceof Error
            ? error
            : new Error(sanitizeString(errorMessage)),
        );
      });

      return {
        content: [
          {
            type: "text",
            text: `Error bulk resolving threads: ${errorMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

server.tool(
  "get_diff_context",
  "Get diff context around specific lines in PR files",
  {
    file: z.string().describe("File path to get diff context for"),
    line: z.number().describe("Line number to get context around"),
    contextLines: z
      .number()
      .optional()
      .default(3)
      .describe("Number of context lines before and after (default: 3)"),
  },
  async ({ file, line, contextLines }) => {
    try {
      const githubToken = process.env.GITHUB_TOKEN;

      if (!githubToken) {
        throw new Error("GITHUB_TOKEN environment variable is required");
      }

      const owner = REPO_OWNER;
      const repo = REPO_NAME;
      const pull_number = parseInt(PR_NUMBER, 10);

      const octokits = createOctokit(githubToken);

      // Get PR details to get the commit SHA
      const pr = await octokits.rest.pulls.get({
        owner,
        repo,
        pull_number,
      });

      // Get the file content from the PR head
      const fileContent = await octokits.rest.repos.getContent({
        owner,
        repo,
        path: file,
        ref: pr.data.head.sha,
      });

      if (Array.isArray(fileContent.data) || fileContent.data.type !== "file") {
        throw new Error(`${file} is not a regular file`);
      }

      // Check if file is binary before attempting to decode as UTF-8
      const isBinaryFile = (filePath: string): boolean => {
        const binaryExtensions = [
          ".png",
          ".jpg",
          ".jpeg",
          ".gif",
          ".bmp",
          ".webp",
          ".svg",
          ".pdf",
          ".doc",
          ".docx",
          ".xls",
          ".xlsx",
          ".ppt",
          ".pptx",
          ".zip",
          ".rar",
          ".7z",
          ".tar",
          ".gz",
          ".exe",
          ".dll",
          ".so",
          ".bin",
          ".dat",
          ".db",
          ".sqlite",
          ".sqlite3",
          ".mp3",
          ".mp4",
          ".avi",
          ".mov",
          ".wav",
          ".flv",
          ".ico",
          ".woff",
          ".woff2",
          ".ttf",
          ".otf",
          ".eot",
        ];

        const extension = filePath
          .toLowerCase()
          .substring(filePath.lastIndexOf("."));
        return binaryExtensions.includes(extension);
      };

      if (isBinaryFile(file)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: "Cannot display diff context for binary file",
                  file,
                  isBinary: true,
                  suggestion:
                    "Binary files cannot be displayed as text. Consider using a different approach for reviewing binary content.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Decode file content and check for binary content indicators
      const contentBuffer = Buffer.from(fileContent.data.content, "base64");

      // Check for null bytes which typically indicate binary content
      if (contentBuffer.includes(0)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: "File contains binary data (null bytes detected)",
                  file,
                  isBinary: true,
                  suggestion:
                    "This file appears to be binary based on its content. Cannot display as text.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const content = contentBuffer.toString("utf-8").split("\n");

      // Memory management: Limit context size for very large files
      const MAX_CONTEXT_LINES = 50; // Reasonable limit to prevent memory issues
      const actualContextLines = Math.min(contextLines, MAX_CONTEXT_LINES);

      const startLine = Math.max(0, line - actualContextLines - 1);
      const endLine = Math.min(content.length, line + actualContextLines);

      // Also limit total file size we process
      const MAX_FILE_LINES = 10000;
      if (content.length > MAX_FILE_LINES) {
        console.warn(
          `File ${file} has ${content.length} lines, may impact performance`,
        );
      }

      const contextLines_data = content
        .slice(startLine, endLine)
        .map((lineContent, index) => ({
          lineNumber: startLine + index + 1,
          content: lineContent,
          isTargetLine: startLine + index + 1 === line,
        }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                file,
                targetLine: line,
                contextLines: contextLines_data,
                totalLines: content.length,
                sha: pr.data.head.sha,
                requestedContextLines: contextLines,
                actualContextLines: actualContextLines,
                truncated: actualContextLines < contextLines,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      Sentry.withScope((scope) => {
        scope.setTag("operation", "get_diff_context");
        scope.setContext("repository", {
          owner: REPO_OWNER,
          repo: REPO_NAME,
          pull_number: parseInt(PR_NUMBER, 10),
        });
        scope.setContext(
          "file_details",
          createSanitizedSentryContext({
            file_path: sanitizeString(file, 200), // Sanitize file paths
            target_line: line,
            context_lines: contextLines,
          }),
        );
        scope.setLevel("error");
        Sentry.captureException(
          error instanceof Error
            ? error
            : new Error(sanitizeString(errorMessage)),
        );
      });

      return {
        content: [
          {
            type: "text",
            text: `Error getting diff context: ${errorMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

server.tool(
  "get_review_stats",
  "Get comprehensive statistics about the PR review status",
  {
    includeDetails: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include detailed breakdown of threads by file"),
  },
  async ({ includeDetails }) => {
    try {
      const githubToken = process.env.GITHUB_TOKEN;

      if (!githubToken) {
        throw new Error("GITHUB_TOKEN environment variable is required");
      }

      const owner = REPO_OWNER;
      const repo = REPO_NAME;
      const pull_number = parseInt(PR_NUMBER, 10);

      const octokits = createOctokit(githubToken);

      const result = await octokits.graphql<{
        repository: {
          pullRequest: {
            reviews: {
              totalCount: number;
              nodes: Array<{
                state: string;
                author: {
                  login: string;
                };
                submittedAt: string;
              }>;
            };
            reviewThreads: {
              totalCount: number;
              nodes: Array<{
                id: string;
                isResolved: boolean;
                comments: {
                  totalCount: number;
                  nodes: Array<{
                    path: string;
                    author: {
                      login: string;
                    };
                  }>;
                };
              }>;
            };
          };
        };
      }>(
        `
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviews(first: 100) {
                totalCount
                nodes {
                  state
                  author {
                    login
                  }
                  submittedAt
                }
              }
              reviewThreads(first: 100) {
                totalCount
                nodes {
                  id
                  isResolved
                  comments(first: 1) {
                    totalCount
                    nodes {
                      path
                      author {
                        login
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
        {
          owner,
          repo,
          number: pull_number,
        },
      );

      const reviews = result.repository.pullRequest.reviews.nodes;
      const threads = result.repository.pullRequest.reviewThreads.nodes;

      // Calculate review statistics
      const reviewStats = {
        totalReviews: reviews.length,
        approved: reviews.filter((r) => r.state === "APPROVED").length,
        changesRequested: reviews.filter((r) => r.state === "CHANGES_REQUESTED")
          .length,
        comments: reviews.filter((r) => r.state === "COMMENTED").length,
        dismissed: reviews.filter((r) => r.state === "DISMISSED").length,
      };

      const threadStats = {
        totalThreads: threads.length,
        resolved: threads.filter((t) => t.isResolved).length,
        unresolved: threads.filter((t) => !t.isResolved).length,
        totalComments: threads.reduce(
          (sum, t) => sum + t.comments.totalCount,
          0,
        ),
      };

      // File-level details if requested
      const fileDetails = includeDetails
        ? threads.reduce(
            (acc, thread) => {
              const firstComment = thread.comments.nodes[0];
              if (firstComment?.path) {
                if (!acc[firstComment.path]) {
                  acc[firstComment.path] = {
                    resolved: 0,
                    unresolved: 0,
                    totalComments: 0,
                  };
                }
                const fileDetail = acc[firstComment.path];
                if (fileDetail) {
                  if (thread.isResolved) {
                    fileDetail.resolved++;
                  } else {
                    fileDetail.unresolved++;
                  }
                  fileDetail.totalComments += thread.comments.totalCount;
                }
              }
              return acc;
            },
            {} as Record<
              string,
              { resolved: number; unresolved: number; totalComments: number }
            >,
          )
        : undefined;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                reviews: reviewStats,
                threads: threadStats,
                ...(fileDetails && { fileDetails }),
                summary: {
                  hasApprovals: reviewStats.approved > 0,
                  hasChangeRequests: reviewStats.changesRequested > 0,
                  hasUnresolvedThreads: threadStats.unresolved > 0,
                  reviewCompletionRate:
                    threadStats.totalThreads > 0
                      ? Math.round(
                          (threadStats.resolved / threadStats.totalThreads) *
                            100,
                        )
                      : 100,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      Sentry.withScope((scope) => {
        scope.setTag("operation", "get_review_stats");
        scope.setContext("repository", {
          owner: REPO_OWNER,
          repo: REPO_NAME,
          pull_number: parseInt(PR_NUMBER, 10),
        });
        scope.setContext("request_details", {
          include_details: includeDetails,
        });
        scope.setLevel("error");
        Sentry.captureException(
          error instanceof Error
            ? error
            : new Error(sanitizeString(errorMessage)),
        );
      });

      return {
        content: [
          {
            type: "text",
            text: `Error getting review stats: ${errorMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on("exit", () => {
    server.close();
  });
}

runServer().catch(console.error);
