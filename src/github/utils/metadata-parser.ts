import type { GitHubComment } from "../types";

/**
 * Metadata structure embedded in Claude's tracking comments for incremental reviews
 */
export interface ReviewMetadata {
  /** The SHA of the commit that was last reviewed */
  lastReviewedSha: string;
  /** ISO timestamp of when the review was completed */
  reviewDate: string;
  /** Optional GitHub review ID for correlation */
  reviewId?: string;
}

/**
 * Extracts review metadata from a comment body containing embedded HTML metadata
 *
 * @param commentBody - The comment body to parse
 * @returns Parsed metadata or null if not found/invalid
 */
export function extractReviewMetadata(
  commentBody: string,
): ReviewMetadata | null {
  if (!commentBody) return null;

  // Match HTML comment with pr-review-metadata-v1 format
  const metadataRegex = /<!--\s*pr-review-metadata-v1:\s*({.*?})\s*-->/s;
  const match = commentBody.match(metadataRegex);

  if (!match || !match[1]) return null;

  try {
    const parsed = JSON.parse(match[1]) as ReviewMetadata;

    // Validate required fields
    if (!parsed.lastReviewedSha || !parsed.reviewDate) {
      return null;
    }

    // Validate SHA format (basic check for git SHA)
    if (!/^[a-f0-9]{7,40}$/i.test(parsed.lastReviewedSha)) {
      return null;
    }

    // Validate date format (basic ISO check)
    if (isNaN(new Date(parsed.reviewDate).getTime())) {
      return null;
    }

    return parsed;
  } catch (error) {
    // Invalid JSON or other parsing error
    return null;
  }
}

/**
 * Finds the most recent tracking comment from Claude containing review metadata
 *
 * @param comments - Array of comments to search through
 * @param claudeUsername - The username of Claude (to identify Claude's comments)
 * @returns The comment and its extracted metadata, or null if not found
 */
export function findLastTrackingComment(
  comments: GitHubComment[],
  claudeUsername: string = "claude-code",
): { comment: GitHubComment; metadata: ReviewMetadata } | null {
  if (!comments || comments.length === 0) {
    return null;
  }

  // Find Claude's comments in reverse chronological order
  const claudeComments = comments
    .filter(
      (comment) =>
        comment.author?.login === claudeUsername ||
        // Also check for app-based comments that might use different naming
        comment.author?.login?.includes("claude") ||
        // Check if it's likely a Claude comment based on content
        comment.body?.includes("Claude"),
    )
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

  // Look for the most recent comment with valid metadata
  for (const comment of claudeComments) {
    const metadata = extractReviewMetadata(comment.body);
    if (metadata) {
      return { comment, metadata };
    }
  }

  return null;
}

/**
 * Generates the metadata HTML comment to embed in Claude's tracking comments
 *
 * @param metadata - The metadata to embed
 * @returns HTML comment string ready for inclusion in comment body
 */
export function generateMetadataComment(metadata: ReviewMetadata): string {
  const jsonStr = JSON.stringify(metadata);
  return `<!-- pr-review-metadata-v1: ${jsonStr} -->`;
}

/**
 * Checks if a comment body contains Claude review metadata
 *
 * @param commentBody - The comment body to check
 * @returns True if metadata is present and valid
 */
export function hasReviewMetadata(commentBody: string): boolean {
  return extractReviewMetadata(commentBody) !== null;
}
