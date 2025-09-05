import type { PreparedContext } from "./types";
import type { FetchDataResult } from "../github/data/fetcher";
import {
  formatContext,
  formatBody,
  formatComments,
  formatReviewComments,
  formatChangedFilesWithSHA,
} from "../github/data/formatter";
import { sanitizeContent } from "../github/utils/sanitizer";
import { getSystemPromptPrefix } from "../utils/assistant-branding";
import { findLastReviewFromUser, getCommitsSinceReview } from "./index";
import {
  getCommitsSinceSha,
  getChangedFilesSinceSha,
  shaExists,
} from "../github/utils/commit-helpers";

interface ReviewMetadata {
  lastReviewedSha: string;
  reviewDate: string;
}

interface FormattedGitHubData {
  formattedContext: string;
  formattedBody: string;
  formattedComments: string;
  formattedReviewComments: string;
  formattedChangedFiles: string;
  imagesInfo: string;
}

interface IncrementalReviewData {
  incrementalInfo: string;
  githubReviewInfo: string;
}

interface ThreadAnalysis {
  validThreads: Array<{
    threadId: string;
    isResolved: boolean;
    file: string;
    line: number | null;
    isRelevant: boolean;
    lastCommenter: string;
    prAuthorResponded: boolean;
    readyForResolution: boolean;
    comments: Array<{
      id: string;
      databaseId: string;
      body: string;
      author: string;
      createdAt: string;
    }>;
  }>;
  outdatedThreads: Array<{
    threadId: string;
    reason: string;
  }>;
  threadsToResolve: Array<{
    threadId: string;
    reason: string;
    suggestedMessage: string;
  }>;
  stats: {
    total: number;
    resolved: number;
    unresolved: number;
    outdated: number;
    readyForResolution: number;
  };
  fileThreadMap: Map<
    string,
    {
      activeThreads: number;
      resolvedThreads: number;
      totalComments: number;
      threadIds: string[];
    }
  >;
}

interface DeduplicatedComment {
  databaseId: string;
  body: string;
  author: string;
  createdAt: string;
  threadId?: string;
  file?: string;
  line?: number | null;
  isReviewComment: boolean;
}

/**
 * Formats GitHub data for the review prompt using thread-aware processing
 */
async function formatGitHubDataThreadAware(
  context: PreparedContext,
  githubData: FetchDataResult,
): Promise<
  FormattedGitHubData & {
    threadAnalysisSummary: string;
    threadActions: {
      threadsToResolve: Array<{ threadId: string; reason: string }>;
      threadsToReplyTo: Array<{ threadId: string; suggestedReply: string }>;
      newCommentsNeeded: boolean;
    };
  }
> {
  const { contextData, changedFilesWithSHA, imageUrlMap } = githubData;
  const { eventData } = context;

  // Execute three-phase thread-aware processing
  const threadAnalysis = await analyzeExistingThreads(context, githubData);
  const deduplicatedComments = await getDeduplicatedComments(
    githubData,
    threadAnalysis,
    context,
  );
  const threadActions = await planThreadActions(
    threadAnalysis,
    deduplicatedComments,
  );

  const formattedContext = formatContext(contextData, eventData.isPR);

  // Use new thread-aware comment formatting instead of separate formatters
  const formattedComments = formatDeduplicatedComments(
    deduplicatedComments,
    imageUrlMap,
  );
  const formattedReviewComments = ""; // Now integrated into formattedComments

  const formattedChangedFiles = eventData.isPR
    ? formatChangedFilesWithSHA(changedFilesWithSHA)
    : "";

  const hasImages = imageUrlMap && imageUrlMap.size > 0;
  const imagesInfo = hasImages
    ? `

<images_info>
Images have been downloaded from GitHub comments and saved to disk. Their file paths are included in the formatted comments and body above. You can use the Read tool to view these images.
</images_info>`
    : "";

  const formattedBody = contextData?.body
    ? formatBody(contextData.body, imageUrlMap)
    : "No description provided";

  const threadAnalysisSummary = formatThreadAnalysisSummary(threadAnalysis);

  return {
    formattedContext,
    formattedBody,
    formattedComments,
    formattedReviewComments,
    formattedChangedFiles,
    imagesInfo,
    threadAnalysisSummary,
    threadActions,
  };
}

/**
 * Formats GitHub data for the review prompt (legacy version for fallback)
 */
function formatGitHubData(
  context: PreparedContext,
  githubData: FetchDataResult,
): FormattedGitHubData {
  const {
    contextData,
    comments,
    changedFilesWithSHA,
    reviewData,
    imageUrlMap,
  } = githubData;
  const { eventData } = context;

  const formattedContext = formatContext(contextData, eventData.isPR);
  const formattedComments = formatComments(comments, imageUrlMap);
  const formattedReviewComments = eventData.isPR
    ? formatReviewComments(reviewData, imageUrlMap)
    : "";
  const formattedChangedFiles = eventData.isPR
    ? formatChangedFilesWithSHA(changedFilesWithSHA)
    : "";

  const hasImages = imageUrlMap && imageUrlMap.size > 0;
  const imagesInfo = hasImages
    ? `

<images_info>
Images have been downloaded from GitHub comments and saved to disk. Their file paths are included in the formatted comments and body above. You can use the Read tool to view these images.
</images_info>`
    : "";

  const formattedBody = contextData?.body
    ? formatBody(contextData.body, imageUrlMap)
    : "No description provided";

  return {
    formattedContext,
    formattedBody,
    formattedComments,
    formattedReviewComments,
    formattedChangedFiles,
    imagesInfo,
  };
}

/**
 * Builds incremental review information from metadata
 */
function buildIncrementalReviewFromMetadata(metadata: ReviewMetadata): string {
  const { lastReviewedSha: lastSha, reviewDate } = metadata;

  if (!shaExists(lastSha)) {
    return `
**Note:** Found previous review metadata (SHA: ${lastSha}, Date: ${new Date(reviewDate).toISOString()}), but the SHA no longer exists in this branch (likely due to force-push or rebase). Falling back to timestamp-based review context.`;
  }

  const commitsSinceSha = getCommitsSinceSha(lastSha);
  const changedFilesSinceSha = getChangedFilesSinceSha(lastSha);

  const commitsSection = formatCommitsSection(commitsSinceSha);
  const filesSection = formatFilesSection(changedFilesSinceSha);

  return `
**Incremental Review Context (from tracking comment metadata):**
- Last reviewed SHA: ${lastSha}
- Last review date: ${new Date(reviewDate).toISOString()}
- Commits since last review: ${commitsSinceSha.length}${commitsSection}
- Files changed since last review: ${changedFilesSinceSha.length}${filesSection}`;
}

/**
 * Formats commits section for incremental review
 */
function formatCommitsSection(commits: any[]): string {
  if (commits.length === 0) return "";

  const maxCommitsToShow = 10;
  const commitsList = commits
    .slice(0, maxCommitsToShow)
    .map((commit) => `  - ${commit.oid}: ${commit.message}`)
    .join("\n");

  const moreCommits =
    commits.length > maxCommitsToShow
      ? `\n  ... and ${commits.length - maxCommitsToShow} more commits`
      : "";

  return `\n${commitsList}${moreCommits}`;
}

/**
 * Formats files section for incremental review
 */
function formatFilesSection(files: string[]): string {
  if (files.length === 0) return "";

  if (files.length <= 15) {
    return `\n${files.map((file) => `  - ${file}`).join("\n")}`;
  }

  const filesList = files
    .slice(0, 15)
    .map((file) => `- ${file}`)
    .join(", ");

  return `\n  ${filesList} and ${files.length - 15} more files`;
}

/**
 * Builds GitHub review information from API data
 */
function buildGitHubReviewInfo(
  lastReview: any,
  commitsSinceReview: any[],
): string {
  if (!lastReview) {
    return "This appears to be your first review of this pull request.";
  }

  const reviewDate = new Date(lastReview.submittedAt);
  const commitsList = formatCommitsSinceReview(commitsSinceReview);

  return `**GitHub Review History:**
Your last review was submitted on ${reviewDate.toISOString()} at ${reviewDate.toLocaleTimeString()}.
Review ID: ${lastReview.id}
${commitsList}`;
}

/**
 * Formats commits since review for display
 */
function formatCommitsSinceReview(commits: any[]): string {
  if (commits.length === 0) {
    return "\nNo new commits since your last review.";
  }

  const maxCommitsToShow = 10;
  const commitsList = commits
    .slice(0, maxCommitsToShow)
    .map(
      (commit) =>
        `\n- ${commit.oid.substring(0, 8)}: ${commit.message.split("\n")[0]}`,
    )
    .join("");

  const moreCommits =
    commits.length > maxCommitsToShow
      ? `\n... and ${commits.length - maxCommitsToShow} more commits`
      : "";

  return `\nCommits since your last review:${commitsList}${moreCommits}`;
}

/**
 * Phase 1: Analyze existing threads for relevance by reconstructing from GitHub data
 */
async function analyzeExistingThreads(
  _context: PreparedContext,
  githubData?: FetchDataResult,
): Promise<ThreadAnalysis> {
  try {
    // If no GitHub data provided, return empty analysis
    if (!githubData?.reviewData?.nodes) {
      return {
        validThreads: [],
        outdatedThreads: [],
        threadsToResolve: [],
        stats: {
          total: 0,
          resolved: 0,
          unresolved: 0,
          outdated: 0,
          readyForResolution: 0,
        },
        fileThreadMap: new Map(),
      };
    }

    // Reconstruct threads from review comments
    const threadMap = new Map<
      string,
      {
        threadId: string;
        isResolved: boolean;
        file: string;
        line: number | null;
        isRelevant: boolean;
        lastCommenter: string;
        prAuthorResponded: boolean;
        readyForResolution: boolean;
        comments: Array<{
          id: string;
          databaseId: string;
          body: string;
          author: string;
          createdAt: string;
        }>;
        reviewStates: string[];
      }
    >();

    // Process all review comments to reconstruct threads
    for (const review of githubData.reviewData.nodes) {
      const reviewState = review.state;

      for (const comment of review.comments.nodes) {
        // Create thread identifier from file path and line number
        const threadKey = `${comment.path}:${comment.line || "null"}`;

        if (!threadMap.has(threadKey)) {
          threadMap.set(threadKey, {
            threadId: threadKey,
            isResolved: false, // Will be updated based on review states
            file: comment.path,
            line: comment.line,
            isRelevant: true, // Will be analyzed based on current PR state
            lastCommenter: "unknown",
            prAuthorResponded: false,
            readyForResolution: false,
            comments: [],
            reviewStates: [],
          });
        }

        const thread = threadMap.get(threadKey)!;

        // Add comment to thread
        thread.comments.push({
          id: comment.id,
          databaseId: comment.databaseId.toString(),
          body: comment.body,
          author: comment.author.login,
          createdAt: comment.createdAt,
        });

        // Track review states for resolution analysis
        if (!thread.reviewStates.includes(reviewState)) {
          thread.reviewStates.push(reviewState);
        }
      }
    }

    // Analyze threads for resolution and relevance
    const threads = Array.from(threadMap.values());
    const changedFiles = githubData.changedFiles || [];

    // Get PR author for comparison
    const prAuthor = (githubData.contextData as any)?.author?.login || null;

    for (const thread of threads) {
      // Determine if thread is resolved based on review states
      thread.isResolved =
        thread.reviewStates.includes("APPROVED") &&
        !thread.reviewStates.includes("CHANGES_REQUESTED");

      // Determine relevance - thread is relevant if:
      // 1. The file is still being changed in this PR, OR
      // 2. The file exists in the current PR (even if not changed)
      const fileStillExists =
        changedFiles.some((f) => f.path === thread.file) ||
        thread.file.length > 0; // Basic existence check

      thread.isRelevant = fileStillExists;

      // Mark as outdated if file was deleted
      if (!thread.isRelevant) {
        thread.isRelevant = false;
      }

      // Enhanced analysis for thread resolution readiness
      if (thread.comments.length > 0) {
        // Sort comments by creation date to find the last commenter
        const sortedComments = [...thread.comments].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );

        thread.lastCommenter = sortedComments[0]?.author || "unknown";
        thread.prAuthorResponded = prAuthor
          ? thread.comments.some((c) => c.author === prAuthor)
          : false;

        // Determine if thread is ready for resolution
        // A thread is ready for resolution if:
        // 1. PR author was the last commenter (indicating they've responded/addressed the issue)
        // 2. OR PR author has responded with explanatory context (we detect keywords)
        const lastCommentByAuthor = thread.lastCommenter === prAuthor;
        const authorResponseContainsResolution =
          prAuthor &&
          thread.comments
            .filter((c) => c.author === prAuthor)
            .some((c) => {
              const body = c.body.toLowerCase();
              return (
                body.includes("fixed") ||
                body.includes("addressed") ||
                body.includes("updated") ||
                body.includes("changed") ||
                body.includes("done") ||
                body.includes("thanks") ||
                body.includes("good point") ||
                body.includes("you're right") ||
                body.includes("agreed") ||
                body.includes("implemented")
              );
            });

        thread.readyForResolution =
          lastCommentByAuthor || authorResponseContainsResolution;
      } else {
        thread.lastCommenter = "unknown";
        thread.prAuthorResponded = false;
        thread.readyForResolution = false;
      }
    }

    // Separate valid and outdated threads
    const validThreads = threads.filter((t) => !t.isResolved && t.isRelevant);
    const outdatedThreads = threads
      .filter((t) => !t.isRelevant)
      .map((t) => ({
        threadId: t.threadId,
        reason: `Thread on ${t.file}${t.line ? `:${t.line}` : ""} is no longer relevant`,
      }));

    // Create threads ready for resolution with suggested messages
    const threadsToResolve = validThreads
      .filter((t) => t.readyForResolution)
      .map((t) => {
        let suggestedMessage = "Thread resolved";

        // Generate contextual resolution message based on author's response
        if (t.lastCommenter === prAuthor && t.comments.length > 0) {
          const lastComment = [...t.comments].sort(
            (a, b) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          )[0];
          if (lastComment) {
            const body = lastComment.body.toLowerCase();

            if (body.includes("fixed") || body.includes("addressed")) {
              suggestedMessage = "Thanks for addressing this feedback!";
            } else if (body.includes("updated") || body.includes("changed")) {
              suggestedMessage = "Resolved - changes implemented as requested";
            } else if (body.includes("done") || body.includes("implemented")) {
              suggestedMessage = "Perfect, thanks for implementing this!";
            } else if (body.includes("thanks") || body.includes("good point")) {
              suggestedMessage = "Glad this was helpful - resolved";
            } else {
              suggestedMessage =
                "Thanks for the response - marking as resolved";
            }
          }
        }

        return {
          threadId: t.threadId,
          reason: `PR author responded - ready for resolution`,
          suggestedMessage,
        };
      });

    const stats = {
      total: threads.length,
      resolved: threads.filter((t) => t.isResolved).length,
      unresolved: threads.filter((t) => !t.isResolved).length,
      outdated: outdatedThreads.length,
      readyForResolution: threadsToResolve.length,
    };

    // Build file thread map for efficient LLM guidance
    const fileThreadMap = new Map<
      string,
      {
        activeThreads: number;
        resolvedThreads: number;
        totalComments: number;
        threadIds: string[];
      }
    >();

    for (const thread of threads) {
      const file = thread.file;
      if (!fileThreadMap.has(file)) {
        fileThreadMap.set(file, {
          activeThreads: 0,
          resolvedThreads: 0,
          totalComments: 0,
          threadIds: [],
        });
      }

      const fileData = fileThreadMap.get(file)!;
      fileData.threadIds.push(thread.threadId);
      fileData.totalComments += thread.comments.length;

      if (thread.isResolved) {
        fileData.resolvedThreads += 1;
      } else {
        fileData.activeThreads += 1;
      }
    }

    console.log(
      `Thread analysis: ${stats.total} total, ${stats.unresolved} unresolved, ${stats.resolved} resolved, ${stats.outdated} outdated across ${fileThreadMap.size} files`,
    );

    return {
      validThreads,
      outdatedThreads,
      threadsToResolve,
      stats,
      fileThreadMap,
    };
  } catch (error) {
    console.warn("Thread analysis failed, falling back to basic mode:", error);
    return {
      validThreads: [],
      outdatedThreads: [],
      threadsToResolve: [],
      stats: {
        total: 0,
        resolved: 0,
        unresolved: 0,
        outdated: 0,
        readyForResolution: 0,
      },
      fileThreadMap: new Map(),
    };
  }
}

/**
 * Helper function to build thread ID mapping from review comments
 * This creates a mapping between comment database IDs and their thread IDs
 * based on file path and line number correlation
 */
async function buildThreadCommentMapping(
  _context: PreparedContext,
  githubData?: FetchDataResult,
): Promise<Map<string, string>> {
  const threadCommentMap = new Map<string, string>();

  if (!githubData?.reviewData?.nodes) {
    console.warn("No review data available for thread comment mapping");
    return threadCommentMap;
  }

  try {
    // Build mapping by reconstructing threads from review comments
    // This mirrors the logic in analyzeExistingThreads to ensure consistency
    const threadMap = new Map<string, string>(); // threadKey -> threadId

    for (const review of githubData.reviewData.nodes) {
      for (const comment of review.comments.nodes) {
        if (!comment.databaseId || !comment.path) {
          continue; // Skip comments without essential identifiers
        }

        // Create consistent thread key (same as in analyzeExistingThreads)
        const threadKey = `${comment.path}:${comment.line || "null"}`;

        // Use the first comment's ID as the thread ID (consistent with GitHub's approach)
        if (!threadMap.has(threadKey)) {
          // Generate deterministic thread ID from first comment in thread
          const threadId = `thread_${comment.databaseId}`;
          threadMap.set(threadKey, threadId);
        }

        // Map this comment's database ID to its thread ID
        const threadId = threadMap.get(threadKey);
        if (threadId) {
          threadCommentMap.set(comment.databaseId.toString(), threadId);
        }
      }
    }

    console.log(
      `Built thread comment mapping: ${threadCommentMap.size} comments mapped to threads`,
    );
    return threadCommentMap;
  } catch (error) {
    console.warn(
      "Failed to build thread comment mapping, proceeding without thread correlation:",
      error,
    );
    return new Map();
  }
}

/**
 * Phase 2: Get deduplicated comments using thread-aware approach
 */
async function getDeduplicatedComments(
  githubData: FetchDataResult,
  threadAnalysis: ThreadAnalysis,
  context?: PreparedContext,
): Promise<DeduplicatedComment[]> {
  const commentMap = new Map<string, DeduplicatedComment>();
  const { comments, reviewData } = githubData;

  // Build mapping from comment database IDs to thread IDs
  const threadCommentMap = context
    ? await buildThreadCommentMapping(context, githubData)
    : new Map<string, string>();

  // Process general comments
  comments?.forEach((comment) => {
    if (!comment.isMinimized && comment.databaseId) {
      commentMap.set(comment.databaseId, {
        databaseId: comment.databaseId,
        body: comment.body,
        author: comment.author.login,
        createdAt: comment.createdAt,
        threadId: threadCommentMap.get(comment.databaseId),
        isReviewComment: false,
      });
    }
  });

  // Process review comments (inline comments) with deduplication
  reviewData?.nodes?.forEach((review) => {
    review.comments?.nodes?.forEach((comment) => {
      if (!comment.isMinimized && comment.databaseId) {
        // Only add if not already present (deduplication by databaseId)
        if (!commentMap.has(comment.databaseId)) {
          commentMap.set(comment.databaseId, {
            databaseId: comment.databaseId,
            body: comment.body,
            author: comment.author.login,
            createdAt: comment.createdAt,
            file: comment.path,
            line: comment.line,
            threadId: threadCommentMap.get(comment.databaseId), // Now properly assigned!
            isReviewComment: true,
          });
        }
      }
    });
  });

  // Filter out comments from outdated threads if thread analysis is available
  const outdatedThreadIds = new Set(
    threadAnalysis.outdatedThreads.map((t) => t.threadId),
  );

  return Array.from(commentMap.values()).filter((comment) => {
    // If comment has threadId and it's outdated, exclude it
    return !comment.threadId || !outdatedThreadIds.has(comment.threadId);
  });
}

/**
 * Phase 3: Plan thread management actions with smart resolution detection
 */
async function planThreadActions(
  threadAnalysis: ThreadAnalysis,
  cleanComments: DeduplicatedComment[],
): Promise<{
  threadsToResolve: Array<{
    threadId: string;
    reason: string;
    suggestedMessage: string;
  }>;
  threadsToReplyTo: Array<{ threadId: string; suggestedReply: string }>;
  newCommentsNeeded: boolean;
}> {
  // Combine outdated threads with threads ready for resolution
  const allThreadsToResolve = [
    // Outdated threads (from old logic)
    ...threadAnalysis.outdatedThreads.map((thread) => ({
      threadId: thread.threadId,
      reason: thread.reason,
      suggestedMessage: "No longer relevant - resolving outdated thread",
    })),
    // New: Threads ready for resolution based on author responses
    ...threadAnalysis.threadsToResolve,
  ];

  // Threads that need follow-up (active threads that aren't ready for resolution)
  const threadsToReplyTo = threadAnalysis.validThreads
    .filter(
      (thread) =>
        !thread.isResolved && thread.isRelevant && !thread.readyForResolution,
    )
    .map((thread) => {
      let suggestedReply =
        "Following up on this thread in the context of recent changes.";

      // Customize reply based on thread context
      if (thread.prAuthorResponded) {
        if (thread.lastCommenter !== thread.comments[0]?.author) {
          // PR author responded but conversation continues
          suggestedReply =
            "Thanks for the response! Let me review the latest changes and follow up.";
        }
      } else {
        // PR author hasn't responded yet
        suggestedReply =
          "Following up on this feedback - please let me know your thoughts on the suggested changes.";
      }

      return {
        threadId: thread.threadId,
        suggestedReply,
      };
    });

  return {
    threadsToResolve: allThreadsToResolve,
    threadsToReplyTo,
    newCommentsNeeded: cleanComments.length > 0,
  };
}

/**
 * Format deduplicated comments for display
 */
function formatDeduplicatedComments(
  comments: DeduplicatedComment[],
  imageUrlMap?: Map<string, string>,
): string {
  if (comments.length === 0) {
    return "No comments";
  }

  return comments
    .map((comment) => {
      let body = comment.body;

      if (imageUrlMap && body) {
        for (const [originalUrl, localPath] of imageUrlMap) {
          body = body.replaceAll(originalUrl, localPath);
        }
      }

      body = sanitizeContent(body);

      const location =
        comment.file && comment.line
          ? ` on ${comment.file}:${comment.line}`
          : "";

      const type = comment.isReviewComment
        ? "Review Comment"
        : "General Comment";

      return `[${type} by ${comment.author} at ${comment.createdAt}${location}]: ${body}`;
    })
    .join("\n\n");
}

/**
 * Generate thread analysis summary for the prompt
 */
function formatThreadAnalysisSummary(threadAnalysis: ThreadAnalysis): string {
  if (threadAnalysis.stats.total === 0) {
    return "";
  }

  // Sort files by total thread activity (active + resolved) for prioritization
  const filesWithActiveThreads = Array.from(
    threadAnalysis.fileThreadMap.entries(),
  )
    .filter(([, data]) => data.activeThreads > 0)
    .sort((a, b) => b[1].activeThreads - a[1].activeThreads);

  const filesWithOnlyResolvedThreads = Array.from(
    threadAnalysis.fileThreadMap.entries(),
  )
    .filter(([, data]) => data.activeThreads === 0 && data.resolvedThreads > 0)
    .sort((a, b) => b[1].resolvedThreads - a[1].resolvedThreads);

  const activeFilesSection =
    filesWithActiveThreads.length > 0
      ? `
**Files with Active Review Threads (${filesWithActiveThreads.length} total):**
${filesWithActiveThreads
  .map(
    ([file, data]) =>
      `- ${file} (${data.activeThreads} unresolved thread${data.activeThreads > 1 ? "s" : ""}, ${data.totalComments} comment${data.totalComments > 1 ? "s" : ""})`,
  )
  .join("\n")}
`
      : "";

  const resolvedFilesSection =
    filesWithOnlyResolvedThreads.length > 0
      ? `
**Files with Resolved Threads Only (${filesWithOnlyResolvedThreads.length} total):**
${filesWithOnlyResolvedThreads
  .map(
    ([file, data]) =>
      `- ${file} (${data.resolvedThreads} resolved thread${data.resolvedThreads > 1 ? "s" : ""})`,
  )
  .join("\n")}
`
      : "";

  const priorityGuidance =
    filesWithActiveThreads.length > 0
      ? `
**Priority Review Guidance:**
Focus on files with active threads first to maintain conversation continuity and address existing concerns before reviewing unchanged areas.
`
      : "";

  const readyForResolutionSection =
    threadAnalysis.stats.readyForResolution > 0
      ? `
**Threads Ready for Resolution (${threadAnalysis.stats.readyForResolution} total):**
${threadAnalysis.threadsToResolve
  .map((t) => `- ${t.threadId}: ${t.reason} - "${t.suggestedMessage}"`)
  .join("\n")}
`
      : "";

  return `

<thread_analysis_summary>
**Thread Analysis Summary:**
- Total threads analyzed: ${threadAnalysis.stats.total}
- Active threads: ${threadAnalysis.stats.unresolved}
- Resolved threads: ${threadAnalysis.stats.resolved}
- Ready for resolution: ${threadAnalysis.stats.readyForResolution} (PR author responded)
- Outdated threads: ${threadAnalysis.stats.outdated}
${activeFilesSection}${resolvedFilesSection}${readyForResolutionSection}${priorityGuidance}
${
  threadAnalysis.outdatedThreads.length > 0
    ? `**Outdated threads marked for resolution:**
${threadAnalysis.outdatedThreads.map((t) => `- Thread ${t.threadId}: ${t.reason}`).join("\n")}
`
    : ""
}
</thread_analysis_summary>`;
}

/**
 * Gets incremental review data for review requests
 */
function getIncrementalReviewData(
  eventData: any,
  githubData: FetchDataResult,
): IncrementalReviewData {
  const { contextData, reviewData, lastReviewMetadata } = githubData;
  const requestedReviewer = eventData.requestedReviewer;

  // Try metadata-based incremental review first
  let incrementalInfo = "";
  if (lastReviewMetadata?.metadata) {
    incrementalInfo = buildIncrementalReviewFromMetadata(
      lastReviewMetadata.metadata,
    );
  }

  // Get GitHub API-based review data
  const lastReview = requestedReviewer
    ? findLastReviewFromUser(reviewData, requestedReviewer)
    : null;

  const commitsSinceReview =
    lastReview && contextData
      ? getCommitsSinceReview(
          (contextData as any).commits?.nodes || [],
          lastReview.submittedAt,
        )
      : [];

  const githubReviewInfo = buildGitHubReviewInfo(
    lastReview,
    commitsSinceReview,
  );

  return { incrementalInfo, githubReviewInfo };
}

/**
 * Builds the review request context section
 */
function buildReviewRequestContext(
  context: PreparedContext,
  githubData: FetchDataResult,
): string {
  const { eventData } = context;

  if (
    eventData.eventName !== "pull_request" ||
    (eventData as any).eventAction !== "review_requested" ||
    !eventData.isPR
  ) {
    return "";
  }

  const requestedReviewer = (eventData as any).requestedReviewer;
  const { incrementalInfo, githubReviewInfo } = getIncrementalReviewData(
    eventData,
    githubData,
  );

  return `<review_request_context>
You have been requested to review this pull request.
${requestedReviewer ? `The reviewer trigger matched: ${requestedReviewer}` : ""}

${incrementalInfo}

${incrementalInfo ? githubReviewInfo : githubReviewInfo}

IMPORTANT: For incremental reviews, embed review metadata in your tracking comment as HTML comment for future reference:
<!-- pr-review-metadata-v1: {"lastReviewedSha": "current-head-sha", "reviewDate": "iso-timestamp"} -->
This helps maintain conversational continuity across force-pushes and rebases.
</review_request_context>`;
}

/**
 * Builds custom prompt section
 */
function buildCustomPromptSection(customPrompt?: string): string {
  if (!customPrompt) return "";

  return `

<custom_review_instructions>
You have been provided with specific instructions for this review:

${sanitizeContent(customPrompt)}

Please follow these custom instructions while conducting your review, in addition to the standard review practices outlined below.
</custom_review_instructions>`;
}

/**
 * Builds PR review tools information
 */
function buildPrReviewToolsInfo(): string {
  return `<review_tool_info>
IMPORTANT: You have been provided with TWO DISTINCT types of tools:

**PR Review Tools:**
- mcp__github_review__submit_pr_review: Submit a formal PR review with APPROVE, REQUEST_CHANGES, or COMMENT event
- mcp__github_inline_comment__create_inline_comment: Add inline comments on specific lines with actionable feedback and code suggestions
- mcp__github_review__resolve_review_thread: Resolve previous review comment threads with optional explanatory comment

**Enhanced Thread Management Tools:**
- mcp__github_review__get_file_comments: Get all review comments for specific files with thread information (automatically used for deduplication)
- mcp__github_review__reply_to_thread: Add replies to existing review threads without resolving them
- mcp__github_review__get_thread_status: Check resolution status of specific review threads
- mcp__github_review__bulk_resolve_threads: Resolve multiple outdated threads at once with explanation
- mcp__github_review__get_diff_context: Get code context around specific lines for thread validation
- mcp__github_review__get_review_stats: Get comprehensive PR review statistics

**Efficient Thread Discovery Strategy:**
- Files with active threads are listed in the thread analysis summary above
- ONLY call mcp__github_review__get_file_comments for files that appear in the "Files with Active Review Threads" section
- This targeted approach reduces API calls and speeds up your review process
- For files without existing threads, proceed directly with standard review without calling get_file_comments

**Severity Classification System:**
Use these severity levels with human-friendly tagging for all review feedback:
- 🔴 **Blocker**: Correctness, security vulnerabilities, breaking changes, data loss risk → REQUEST_CHANGES
- 🟠 **High**: Likely defects, performance issues, unsafe patterns → Strong recommendation  
- 🟡 **Medium**: Maintainability, clarity, architectural improvements → Suggestion
- 🟢 **Low**: Style, minor optimizations, personal preferences → Nit
- 💬 **Question**: Clarification needed before judging
- 👍 **Praise**: Acknowledge good patterns and practices

**Tracking Comment Tool (for task status ONLY - NOT for review feedback):**
- mcp__github_comment__update_claude_comment: Update your tracking comment EXCLUSIVELY to show task completion status (the checklist)

CRITICAL: When formal review tools are available:
- ALL review feedback, suggestions, and assessments MUST go through the formal review tools
- The tracking comment (mcp__github_comment__update_claude_comment) is ONLY for updating the task checklist
- DO NOT put review feedback in the tracking comment - it belongs in the formal review

Review workflow:
1. Simple review: Use mcp__github_review__submit_pr_review directly with overall feedback
2. Comprehensive review: Use mcp__github_inline_comment__create_inline_comment for specific line feedback, then mcp__github_review__submit_pr_review to submit the formal review verdict
3. Follow-up review: Use mcp__github_review__resolve_review_thread to resolve outdated conversations from previous reviews
4. Status update: Use mcp__github_comment__update_claude_comment ONLY to update the task checklist (- [x] markings)

Tool usage example for mcp__github_review__submit_pr_review (with status + expandable format):
{
  "event": "COMMENT",
  "body": "## 💬 Comments\\nThis PR implements user authentication with solid error handling and clean architecture. The changes look good overall, with just a few minor security considerations to address before approval.\\n\\n<details>\\n<summary><b>📋 Full Review Details</b></summary>\\n\\n### What's Solid ✨\\n- Excellent input validation on login endpoints\\n- Clean separation of concerns in auth middleware\\n- Comprehensive test coverage for edge cases\\n\\n### Key Issues\\n🟡 **Medium [Security]**: Consider rate limiting on login attempts\\n🟢 **Low [Style]**: Consistent error message formatting\\n\\n</details>"
}

Tool usage example for mcp__github_inline_comment__create_inline_comment (inline comment with severity tagging):
{
  "path": "src/file.js", 
  "line": 42,
  "body": "🟡 **Medium [Style]**: Consider using const instead of let here since this value is never reassigned"
}

Tool usage example for mcp__github_inline_comment__create_inline_comment with code suggestion:
{
  "path": "src/utils.js",
  "line": 15,
  "body": "🔴 **Blocker [Correctness]**: This will throw a TypeError when user is null.\\n\\n\`\`\`suggestion\\nreturn user?.profile?.name || 'Anonymous';\`\`\`"
}

Tool usage example for conversational continuity (follow-up review):
{
  "path": "src/auth.js",
  "line": 28,
  "body": "🟠 **High [Security]**: Following up on our last review, this endpoint still lacks proper authentication checks before accessing user data."
}

Tool usage example for mcp__github_review__resolve_review_thread:
{
  "threadId": "RT_kwDOExample123",
  "body": "Fixed in latest commit"
}

IMPORTANT: Use mcp__github_inline_comment__create_inline_comment for:
- Highlighting actionable feedback on specific lines of code
- Providing critical information about bugs, security issues, or performance problems
- Suggesting concrete improvements with code suggestions using \`\`\`suggestion blocks
- Pointing out best practices violations or potential issues in specific code sections

**Comment Budgeting and Prioritization:**
- Limit inline comments to ≤15 per review to avoid overwhelming developers
- Always include ALL 🔴 Blocker and 🟠 High severity issues
- Group related 🟡 Medium and 🟢 Low issues into single per-file comments when possible
- Use rapid succession: post inline comments quickly, then immediately submit formal review
- Prioritize evidence-based feedback over theoretical concerns

IMPORTANT: Use mcp__github_review__resolve_review_thread for:
- Resolving previous review comment threads that are no longer applicable
- Closing conversations where the issue has been addressed
- **PRIORITY: Close threads with comments when PR author has addressed issues or provided necessary context**
- Adding context when resolving threads (e.g., "Fixed in commit abc123", "No longer applicable after refactoring")

**Thread Resolution Decision Matrix:**
- ✅ **Close with comment** when:
  * PR author was the last commenter (indicates they've addressed the feedback)
  * PR author responded with "fixed", "addressed", "updated", "done", "implemented"
  * PR author provided clarification or explanation ("thanks", "good point", "agreed")
  * The issue has clearly been resolved in the latest code changes

- 🔄 **Reply to continue discussion** when:
  * Author's response needs clarification or follow-up
  * New issues emerged from author's changes
  * Technical discussion is ongoing and requires more input

- ⏭️ **Leave thread open** when:
  * Waiting for author's response to critical feedback
  * Complex discussion that hasn't reached resolution
  * Blocking issues that require significant changes

**Resolution Message Templates:**
- For fixes: "Thanks for addressing this feedback!"
- For updates: "Resolved - changes implemented as requested"  
- For implementations: "Perfect, thanks for implementing this!"
- For clarifications: "Thanks for the explanation - marking as resolved"
- For acknowledgments: "Glad this was helpful - resolved"

IMPORTANT: Use mcp__github_review__submit_pr_review for:
- Submitting your formal GitHub review with your decision (APPROVE, REQUEST_CHANGES, or COMMENT)
- Start with quick status indicator (e.g., ## ✅ LGTM) plus 2-3 sentence assessment
- Follow with expandable <details> section containing comprehensive analysis
- **Status Selection Guide:**
  - Use ✅ LGTM for APPROVE events (clean code, minor issues only)
  - Use 🔧 Needs Changes for REQUEST_CHANGES events (blocking issues found)
  - Use 💬 Comments for COMMENT events (feedback without blocking)
  - Use specific indicators (🐞, ⚠️, 🏗️, 🚀, 📚) when primary issue type is clear
- This creates the official review record on the PR

IMPORTANT: Use mcp__github_comment__update_claude_comment for:
- Updating the task checklist ONLY (marking items as - [x] complete)
- Showing progress through the review process
- DO NOT include review feedback, suggestions, or assessments here
- This is purely for task tracking - ALL review content goes in the formal review

When to update your tracking comment:
- After completing initial analysis (mark task as complete)
- After reviewing each major file or component (mark task as complete)
- After adding inline review comments (mark task as complete)
- Before submitting the formal review (mark task as in progress)
- After submitting the formal review (mark task as complete)
- ONLY update with checkbox status changes, no review content

Note: Inline comments created with create_inline_comment appear immediately on the diff view, making them highly visible and actionable for developers. The formal review submission with submit_pr_review provides your overall assessment.

Use COMMENT for general feedback, REQUEST_CHANGES to request changes, or APPROVE to approve the PR.
</review_tool_info>`;
}

/**
 * Builds comment tools information for non-PR review mode
 */
function buildCommentToolsInfo(): string {
  return `<comment_tool_info>
IMPORTANT: You have been provided with the mcp__github_comment__update_claude_comment tool to update your comment. This tool automatically handles both issue and PR comments.

Tool usage example for mcp__github_comment__update_claude_comment:
{
  "body": "Your comment text here"
}
Only the body parameter is required - the tool automatically knows which comment to update.
</comment_tool_info>`;
}

/**
 * Builds review process instructions
 */
function buildReviewProcessInstructions(
  allowPrReviews: boolean,
  customPrompt?: string,
): string {
  const trackingCommentInstructions = allowPrReviews
    ? "**Direct Review Flow**:\n   - Begin analysis immediately without tracking comment setup\n   - Use formal PR review tools for all feedback and status tracking\n   - GitHub's native review interface provides built-in progress tracking\n\n2. **Initial Analysis**:"
    : `**Create a Dynamic Todo List**:
   - Use your tracking comment to maintain a task checklist ONLY (no review content)
   - Format todos as a checklist (- [ ] for incomplete, - [x] for complete)
   - Update ONLY the checkbox status using mcp__github_comment__update_claude_comment
   - **Base checklist (always include):**
     - [ ] Initial Analysis - Understanding PR purpose and scope
     - [ ] Code Review - Examining changes for quality and issues
     - [ ] Submit Formal Review - Submitting GitHub review decision
   - **Add contextual tasks based on file patterns:**
     - If dependencies changed (package.json, go.mod, requirements.txt): Add "[ ] Dependency Review - Security and compatibility check"
     - If database files (.sql, migrations): Add "[ ] Migration Safety - Forward/backward compatibility review"
     - If public API changes (exported functions, endpoints): Add "[ ] API Compatibility - Breaking changes and documentation review"
     - If CI/workflow files: Add "[ ] CI Security - Secret handling and permissions review"
     - If performance-critical paths: Add "[ ] Performance Review - Checking for performance implications"
     - If authentication/authorization code: Add "[ ] Security Review - Authentication and access control check"
     - If test files substantial: Add "[ ] Test Coverage - Verify adequate test coverage for changes"
   - CRITICAL: This tracking comment is ONLY for checkboxes - ALL review feedback goes in the formal review

2. **Initial Analysis**:`;

  const feedbackInstructions = allowPrReviews
    ? `- Use mcp__github_inline_comment__create_inline_comment for specific line-by-line feedback on the code
   - Use mcp__github_review__resolve_review_thread to resolve outdated conversations from previous reviews
   - Use mcp__github_review__submit_pr_review to submit your formal GitHub review with:
     - APPROVE: If the changes look good with no significant issues
     - REQUEST_CHANGES: If there are important issues that need to be addressed  
     - COMMENT: For general feedback or questions without blocking approval
   - All feedback and progress tracking handled through GitHub's native review system`
    : `- Update your tracking comment with review feedback using mcp__github_comment__update_claude_comment
   - Provide both positive feedback and constructive criticism
   - Be specific about issues and suggest solutions where possible`;

  const finalStepsInstructions = allowPrReviews
    ? `- Submit your formal review using mcp__github_review__submit_pr_review with your decision and ALL feedback
   - Start with a **concise 2-3 sentence summary** stating your verdict and key reasoning
   - Follow with **detailed analysis in expandable <details> section** for full transparency
   - Use inline comments for specific line-by-line feedback
   - No separate tracking comment management required`
    : `- Update your tracking comment with final review feedback using mcp__github_comment__update_claude_comment
   - Ensure all review tasks show as complete in your checklist`;

  const structureInstructions = allowPrReviews
    ? `- **Structure your formal review with concise summary + expandable details:**
     
     **Format Structure:**
     \`\`\`
     ## [Status Icon] [Quick Status]
     [2-3 sentence concise assessment with clear verdict and reasoning]
     
     <details>
     <summary><b>📋 Full Review Details</b></summary>
     
     ### What's Solid ✨
     [Specific positive reinforcement - ESSENTIAL for mentorship]
     
     ### Key Issues
     [Organized by severity: 🔴 Blockers first, then 🟠 High, 🟡 Medium, 🟢 Low]
     
     ### [Additional sections as applicable]
     - **Risk Assessment** (high-impact changes): Potential downstream effects, rollback considerations  
     - **Test Plan Verification** (significant logic changes): Coverage gaps, edge cases
     - **Architecture Notes** (structural changes): Design patterns, future maintainability
     - etc..
     
     </details>
     \`\`\`
     
     **Quick Status Examples:**
     - \`## ✅ LGTM\` - Clean approval, minor or no issues
     - \`## 🔧 Needs Changes\` - Issues requiring fixes before merge  
     - \`## 💬 Comments\` - Feedback/questions, no blocking issues
     - \`## 🐞 Bugs Found\` - Functional issues identified
     - \`## ⚠️ Security Issues\` - Security concerns present
     - \`## 🏗️ Architecture Concerns\` - Design/structure issues
     - \`## 🚀 Performance Issues\` - Performance problems detected
     - \`## 📚 Needs Documentation\` - Missing/inadequate docs
     
   - This format provides quick scanning for busy developers while preserving detailed analysis
   - Only include strategic sections when relevant to avoid formality for simple changes`
    : `- Structure your tracking comment with clear sections when reviewing complex PRs`;

  return `Your task is to conduct a thorough pull request review. Here's how to approach it:

## Review Process:

1. ${trackingCommentInstructions} 
   - Read the PR description and understand the purpose of the changes
   - Review the changed files to understand the scope of modifications
   - Note any existing comments or previous review feedback${allowPrReviews ? "" : "\n   - Mark this task complete in your tracking comment: - [x] Initial Analysis"}

3. **Code Review**:
   - Examine each changed file for code quality, logic, and potential issues
   - Look for bugs, security vulnerabilities, performance issues, or style problems
   - Check for proper error handling, edge cases, and test coverage
   - Verify that the implementation matches the PR description${allowPrReviews ? "" : "\n   - Update your tracking comment as you complete each aspect"}

4. **Provide Feedback**:
   ${feedbackInstructions}

5. **Review Guidelines**:
   - Be constructive and respectful in your feedback
   - Explain the "why" behind your suggestions with specific benefits
   - Consider the broader impact of changes on the codebase
   - Balance thoroughness with practicality - focus on evidence-based concerns
   - **ESSENTIAL: Include "What's Solid" section with specific positive reinforcement:**
     - Acknowledge good patterns: "Excellent use of Promise.all here for parallel operations - much more efficient"
     - Praise good tests: "The edge case tests for this function are fantastic and will prevent regressions"
     - Recognize cleanups: "This refactoring greatly improves readability and maintainability"
     - Highlight security improvements: "Good catch adding input validation here"${allowPrReviews ? "" : "\n   - Keep your tracking comment updated with checkbox status only (no review content)"}

6. **Strategic Review Sections (Context-Aware)**:
   ${structureInstructions}

7. **Final Steps**:
   ${finalStepsInstructions}
${allowPrReviews ? "" : "   - Put your overall assessment in the formal review (if available) or tracking comment (if not)"}${
    customPrompt
      ? `\n   - Ensure your review addresses the custom instructions provided above`
      : ""
  }

Remember: Your goal is to help improve code quality while being helpful and collaborative with the development team.`;
}

/**
 * Builds thread-aware review process instructions with thread management actions
 */
function buildThreadAwareReviewProcessInstructions(
  allowPrReviews: boolean,
  customPrompt?: string,
  threadActions?: {
    threadsToResolve: Array<{ threadId: string; reason: string }>;
    threadsToReplyTo: Array<{ threadId: string; suggestedReply: string }>;
    newCommentsNeeded: boolean;
  },
): string {
  const threadManagementSection = threadActions
    ? `
## Thread Management Actions:

${
  threadActions.threadsToResolve.length > 0
    ? `**Outdated Threads to Resolve:**
${threadActions.threadsToResolve
  .map(
    (t) =>
      `- Use mcp__github_review__bulk_resolve_threads with thread ID ${t.threadId} (${t.reason})`,
  )
  .join("\n")}
`
    : ""
}
${
  threadActions.threadsToReplyTo.length > 0
    ? `**Active Threads to Address:**
${threadActions.threadsToReplyTo
  .map(
    (t) =>
      `- Use mcp__github_review__reply_to_thread for thread ID ${t.threadId}`,
  )
  .join("\n")}
`
    : ""
}

IMPORTANT: Use the enhanced thread management tools with priority-based resolution:

**Thread Resolution Priority (Do this FIRST):**
1. **High Priority - Close threads with comments**: Use mcp__github_review__resolve_review_thread for threads where:
   - PR author was the last commenter (they've likely addressed the feedback)
   - Author responded with resolution keywords ("fixed", "addressed", "implemented", etc.)
   - Author provided satisfactory explanation or acknowledgment
   - Use the suggested resolution messages from the thread analysis above

2. **Medium Priority - Reply to ongoing discussions**: Use mcp__github_review__reply_to_thread for:
   - Threads where author responded but needs follow-up
   - Active discussions that require technical clarification
   - Threads that need acknowledgment of author's response

3. **Low Priority - Clean up outdated threads**: Use mcp__github_review__bulk_resolve_threads for:
   - Threads on files that no longer exist or were significantly refactored
   - Discussions that are no longer relevant to current PR state

4. **Final Step - Standard review**: Then conduct your standard review process for new findings

`
    : "";

  const standardInstructions = buildReviewProcessInstructions(
    allowPrReviews,
    customPrompt,
  );

  return `${threadManagementSection}${standardInstructions}

## Enhanced Review Workflow:

1. **Thread Validation** (Automated):
   - Comments have been deduplicated using database IDs
   - Thread relevance has been analyzed against current code
   - Outdated threads have been identified for resolution

2. **File-Prioritized Review Strategy**:
   - Files with active threads are listed above and should be reviewed FIRST
   - For each file with active threads:
     a) Call mcp__github_review__get_file_comments to get full thread context
     b) Address existing conversations before adding new feedback
     c) Use reply_to_thread or resolve_review_thread as appropriate
   - For files without existing threads, proceed with standard review
   - This approach maintains conversation continuity and reduces reviewer cognitive load

3. **Intelligent Comment Processing**:
   - All comments are now presented in a unified, deduplicated format
   - Review comments and general comments are merged without duplication
   - Thread context and location information is preserved

4. **Proactive Thread Management**:
   - Use bulk_resolve_threads for outdated discussions
   - Use reply_to_thread for continuing relevant conversations
   - Focus your review on current, actionable feedback

This thread-aware approach ensures you see only relevant, current comments while maintaining conversation continuity and providing clear file-by-file review guidance.`;
}

/**
 * Generates a specialized prompt for PR review mode with thread-aware processing
 */
export async function generatePrReviewPromptThreadAware(
  context: PreparedContext,
  githubData: FetchDataResult,
  _useCommitSigning: boolean = false,
  allowPrReviews: boolean = false,
  customPrompt?: string,
): Promise<string> {
  const { eventData } = context;

  try {
    // Use thread-aware formatting
    const {
      formattedContext,
      formattedBody,
      formattedComments,
      formattedChangedFiles,
      imagesInfo,
      threadAnalysisSummary,
      threadActions,
    } = await formatGitHubDataThreadAware(context, githubData);

    // Build review request context
    const reviewRequestContext = buildReviewRequestContext(context, githubData);

    // Build custom prompt section
    const customPromptSection = buildCustomPromptSection(customPrompt);

    // Build review tools information
    const reviewToolsInfo = allowPrReviews
      ? buildPrReviewToolsInfo()
      : buildCommentToolsInfo();

    // Build review process instructions with thread management
    const reviewProcessInstructions = buildThreadAwareReviewProcessInstructions(
      allowPrReviews,
      customPrompt,
      threadActions,
    );

    // Generate the complete prompt
    const promptContent = `${getSystemPromptPrefix()} specialized in conducting thorough and helpful pull request reviews with advanced thread management capabilities. You have been requested to review this pull request using intelligent comment deduplication and thread validation.

<formatted_context>
${formattedContext}
</formatted_context>

<pr_or_issue_body>
${formattedBody}
</pr_or_issue_body>

<comments_deduplicated>
${formattedComments || "No comments"}
</comments_deduplicated>${threadAnalysisSummary}

<changed_files>
${formattedChangedFiles || "No files changed"}
</changed_files>${imagesInfo}

${reviewRequestContext}${customPromptSection}

<repository>${context.repository}</repository>
${eventData.isPR && "prNumber" in eventData ? `<pr_number>${eventData.prNumber}</pr_number>` : ""}
<claude_comment_id>${context.claudeCommentId}</claude_comment_id>
<trigger_username>${context.triggerUsername ?? "Unknown"}</trigger_username>

${reviewToolsInfo}

${reviewProcessInstructions}`;

    return promptContent;
  } catch (error) {
    console.warn(
      "Thread-aware processing failed, falling back to standard approach:",
      error,
    );
    return generatePrReviewPrompt(
      context,
      githubData,
      _useCommitSigning,
      allowPrReviews,
      customPrompt,
    );
  }
}

/**
 * Generates a specialized prompt for PR review mode that incorporates custom user prompts
 * into the review context while maintaining all the rich GitHub context.
 */
export function generatePrReviewPrompt(
  context: PreparedContext,
  githubData: FetchDataResult,
  _useCommitSigning: boolean = false,
  allowPrReviews: boolean = false,
  customPrompt?: string,
): string {
  const { eventData } = context;

  // Format GitHub data
  const {
    formattedContext,
    formattedBody,
    formattedComments,
    formattedReviewComments,
    formattedChangedFiles,
    imagesInfo,
  } = formatGitHubData(context, githubData);

  // Build review request context
  const reviewRequestContext = buildReviewRequestContext(context, githubData);

  // Build custom prompt section
  const customPromptSection = buildCustomPromptSection(customPrompt);

  // Build review tools information
  const reviewToolsInfo = allowPrReviews
    ? buildPrReviewToolsInfo()
    : buildCommentToolsInfo();

  // Build review process instructions
  const reviewProcessInstructions = buildReviewProcessInstructions(
    allowPrReviews,
    customPrompt,
  );

  // Generate the complete prompt
  const promptContent = `${getSystemPromptPrefix()} specialized in conducting thorough and helpful pull request reviews. You have been requested to review this pull request. Think carefully as you analyze the code changes and provide constructive feedback.

<formatted_context>
${formattedContext}
</formatted_context>

<pr_or_issue_body>
${formattedBody}
</pr_or_issue_body>

<comments>
${formattedComments || "No comments"}
</comments>

<review_comments>
${formattedReviewComments || "No review comments"}
</review_comments>

<changed_files>
${formattedChangedFiles || "No files changed"}
</changed_files>${imagesInfo}

${reviewRequestContext}${customPromptSection}

<repository>${context.repository}</repository>
${eventData.isPR && "prNumber" in eventData ? `<pr_number>${eventData.prNumber}</pr_number>` : ""}
<claude_comment_id>${context.claudeCommentId}</claude_comment_id>
<trigger_username>${context.triggerUsername ?? "Unknown"}</trigger_username>

${reviewToolsInfo}

${reviewProcessInstructions}`;

  return promptContent;
}
