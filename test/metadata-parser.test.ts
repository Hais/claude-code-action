import { describe, test, expect } from "bun:test";
import {
  extractReviewMetadata,
  findLastTrackingComment,
  generateMetadataComment,
  hasReviewMetadata,
  type ReviewMetadata,
} from "../src/github/utils/metadata-parser";
import type { GitHubComment } from "../src/github/types";

describe("metadata-parser", () => {
  describe("extractReviewMetadata", () => {
    test("extracts valid metadata from HTML comment", () => {
      const commentBody = `
Some review content here.

<!-- pr-review-metadata-v1: {"lastReviewedSha": "abc1234", "reviewDate": "2023-12-01T10:00:00Z"} -->

More content after.
      `;

      const result = extractReviewMetadata(commentBody);

      expect(result).toEqual({
        lastReviewedSha: "abc1234",
        reviewDate: "2023-12-01T10:00:00Z",
      });
    });

    test("extracts metadata with optional reviewId", () => {
      const commentBody = `
<!-- pr-review-metadata-v1: {"lastReviewedSha": "abc1234", "reviewDate": "2023-12-01T10:00:00Z", "reviewId": "R_123"} -->
      `;

      const result = extractReviewMetadata(commentBody);

      expect(result).toEqual({
        lastReviewedSha: "abc1234",
        reviewDate: "2023-12-01T10:00:00Z",
        reviewId: "R_123",
      });
    });

    test("returns null for comment without metadata", () => {
      const commentBody = "Just a regular comment with no metadata.";

      const result = extractReviewMetadata(commentBody);

      expect(result).toBeNull();
    });

    test("returns null for empty comment body", () => {
      const result = extractReviewMetadata("");
      expect(result).toBeNull();
    });

    test("returns null for invalid JSON in metadata", () => {
      const commentBody = `
<!-- pr-review-metadata-v1: {"lastReviewedSha": "abc1234", "reviewDate": invalid-json} -->
      `;

      const result = extractReviewMetadata(commentBody);

      expect(result).toBeNull();
    });

    test("returns null for missing required fields", () => {
      const commentBody = `
<!-- pr-review-metadata-v1: {"reviewDate": "2023-12-01T10:00:00Z"} -->
      `;

      const result = extractReviewMetadata(commentBody);

      expect(result).toBeNull();
    });

    test("returns null for invalid SHA format", () => {
      const commentBody = `
<!-- pr-review-metadata-v1: {"lastReviewedSha": "invalid-sha!", "reviewDate": "2023-12-01T10:00:00Z"} -->
      `;

      const result = extractReviewMetadata(commentBody);

      expect(result).toBeNull();
    });

    test("returns null for invalid date format", () => {
      const commentBody = `
<!-- pr-review-metadata-v1: {"lastReviewedSha": "abc1234", "reviewDate": "not-a-date"} -->
      `;

      const result = extractReviewMetadata(commentBody);

      expect(result).toBeNull();
    });

    test("accepts various SHA lengths", () => {
      const shortSha = `
<!-- pr-review-metadata-v1: {"lastReviewedSha": "abc1234", "reviewDate": "2023-12-01T10:00:00Z"} -->
      `;

      const longSha = `
<!-- pr-review-metadata-v1: {"lastReviewedSha": "abc1234567890abcdef1234567890abcdef12345", "reviewDate": "2023-12-01T10:00:00Z"} -->
      `;

      expect(extractReviewMetadata(shortSha)).toBeTruthy();
      expect(extractReviewMetadata(longSha)).toBeTruthy();
    });
  });

  describe("findLastTrackingComment", () => {
    const mockComments: GitHubComment[] = [
      {
        id: "comment-1",
        databaseId: "1",
        body: "Regular comment",
        createdAt: "2023-12-01T09:00:00Z",
        author: { login: "user1" },
        isMinimized: false,
      },
      {
        id: "comment-2",
        databaseId: "2",
        body: `Old Claude comment
<!-- pr-review-metadata-v1: {"lastReviewedSha": "old123", "reviewDate": "2023-12-01T10:00:00Z"} -->`,
        createdAt: "2023-12-01T10:00:00Z",
        author: { login: "claude-code" },
        isMinimized: false,
      },
      {
        id: "comment-3",
        databaseId: "3",
        body: "Another regular comment",
        createdAt: "2023-12-01T11:00:00Z",
        author: { login: "user2" },
        isMinimized: false,
      },
      {
        id: "comment-4",
        databaseId: "4",
        body: `Latest Claude comment
<!-- pr-review-metadata-v1: {"lastReviewedSha": "abc1234", "reviewDate": "2023-12-01T12:00:00Z"} -->`,
        createdAt: "2023-12-01T12:00:00Z",
        author: { login: "claude-code" },
        isMinimized: false,
      },
    ];

    test("finds the most recent tracking comment with metadata", () => {
      const result = findLastTrackingComment(mockComments);

      expect(result).toBeTruthy();
      expect(result?.comment.databaseId).toBe("4");
      expect(result?.metadata.lastReviewedSha).toBe("abc1234");
    });

    test("returns null when no Claude comments exist", () => {
      const commentsWithoutClaude = mockComments.filter(
        (comment) => comment.author?.login !== "claude-code",
      );

      const result = findLastTrackingComment(commentsWithoutClaude);

      expect(result).toBeNull();
    });

    test("returns null when Claude comments exist but have no metadata", () => {
      const commentsWithoutMetadata: GitHubComment[] = [
        {
          id: "comment-1",
          databaseId: "1",
          body: "Claude comment without metadata",
          createdAt: "2023-12-01T10:00:00Z",
          author: { login: "claude-code" },
          isMinimized: false,
        },
      ];

      const result = findLastTrackingComment(commentsWithoutMetadata);

      expect(result).toBeNull();
    });

    test("returns null for empty comments array", () => {
      const result = findLastTrackingComment([]);
      expect(result).toBeNull();
    });

    test("handles custom Claude username", () => {
      const customComments: GitHubComment[] = [
        {
          id: "comment-1",
          databaseId: "1",
          body: `Custom Claude comment
<!-- pr-review-metadata-v1: {"lastReviewedSha": "abc1234", "reviewDate": "2023-12-01T10:00:00Z"} -->`,
          createdAt: "2023-12-01T10:00:00Z",
          author: { login: "custom-claude" },
          isMinimized: false,
        },
      ];

      const result = findLastTrackingComment(customComments, "custom-claude");

      expect(result).toBeTruthy();
      expect(result?.metadata.lastReviewedSha).toBe("abc1234");
    });
  });

  describe("generateMetadataComment", () => {
    test("generates valid HTML comment with metadata", () => {
      const metadata: ReviewMetadata = {
        lastReviewedSha: "abc1234",
        reviewDate: "2023-12-01T10:00:00Z",
      };

      const result = generateMetadataComment(metadata);

      expect(result).toBe(
        `<!-- pr-review-metadata-v1: {"lastReviewedSha":"abc1234","reviewDate":"2023-12-01T10:00:00Z"} -->`,
      );
    });

    test("includes optional reviewId when provided", () => {
      const metadata: ReviewMetadata = {
        lastReviewedSha: "abc1234",
        reviewDate: "2023-12-01T10:00:00Z",
        reviewId: "R_123",
      };

      const result = generateMetadataComment(metadata);

      expect(result).toBe(
        `<!-- pr-review-metadata-v1: {"lastReviewedSha":"abc1234","reviewDate":"2023-12-01T10:00:00Z","reviewId":"R_123"} -->`,
      );
    });
  });

  describe("hasReviewMetadata", () => {
    test("returns true for comment with valid metadata", () => {
      const commentBody = `
Some content
<!-- pr-review-metadata-v1: {"lastReviewedSha": "abc1234", "reviewDate": "2023-12-01T10:00:00Z"} -->
More content
      `;

      const result = hasReviewMetadata(commentBody);

      expect(result).toBe(true);
    });

    test("returns false for comment without metadata", () => {
      const commentBody = "Just a regular comment";

      const result = hasReviewMetadata(commentBody);

      expect(result).toBe(false);
    });

    test("returns false for comment with invalid metadata", () => {
      const commentBody = `
<!-- pr-review-metadata-v1: {"invalid": "json"} -->
      `;

      const result = hasReviewMetadata(commentBody);

      expect(result).toBe(false);
    });
  });
});
