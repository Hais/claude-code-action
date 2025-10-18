#!/usr/bin/env bun

import { describe, test, expect, mock } from "bun:test";
import { dismissPreviousChangeRequests } from "../src/github/operations/reviews";
import type { Octokits } from "../src/github/api/client";

// Mock Octokit responses
function createMockOctokits(
  authenticatedUser: { id: number; login: string },
  reviews: Array<{
    id: number;
    state: string;
    user: { id: number; login: string } | null;
  }>,
  dismissalShouldFail: boolean = false,
): Octokits {
  const dismissReviewMock = mock(() => {
    if (dismissalShouldFail) {
      throw new Error("Permission denied");
    }
    return Promise.resolve({
      data: { id: 1, state: "DISMISSED" },
    });
  });

  return {
    rest: {
      users: {
        getAuthenticated: mock(() =>
          Promise.resolve({
            data: authenticatedUser,
          }),
        ),
      },
      pulls: {
        listReviews: mock(() =>
          Promise.resolve({
            data: reviews,
          }),
        ),
        dismissReview: dismissReviewMock,
      },
    } as any,
    graphql: {} as any,
  };
}

describe("dismissPreviousChangeRequests", () => {
  test("should return success when no REQUEST_CHANGES reviews found", async () => {
    const octokits = createMockOctokits({ id: 123, login: "bot-user" }, [
      {
        id: 1,
        state: "APPROVED",
        user: { id: 123, login: "bot-user" },
      },
      {
        id: 2,
        state: "COMMENTED",
        user: { id: 123, login: "bot-user" },
      },
    ]);

    const result = await dismissPreviousChangeRequests(
      octokits,
      "owner",
      "repo",
      123,
    );

    expect(result.success).toBe(true);
    expect(result.dismissedCount).toBe(0);
    expect(result.dismissedReviewIds).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("should dismiss single REQUEST_CHANGES review from authenticated user", async () => {
    const octokits = createMockOctokits({ id: 123, login: "bot-user" }, [
      {
        id: 1,
        state: "CHANGES_REQUESTED",
        user: { id: 123, login: "bot-user" },
      },
      {
        id: 2,
        state: "APPROVED",
        user: { id: 456, login: "other-user" },
      },
    ]);

    const result = await dismissPreviousChangeRequests(
      octokits,
      "owner",
      "repo",
      123,
    );

    expect(result.success).toBe(true);
    expect(result.dismissedCount).toBe(1);
    expect(result.dismissedReviewIds).toEqual([1]);
    expect(result.errors).toEqual([]);
  });

  test("should dismiss multiple REQUEST_CHANGES reviews from authenticated user", async () => {
    const octokits = createMockOctokits({ id: 123, login: "bot-user" }, [
      {
        id: 1,
        state: "CHANGES_REQUESTED",
        user: { id: 123, login: "bot-user" },
      },
      {
        id: 2,
        state: "CHANGES_REQUESTED",
        user: { id: 123, login: "bot-user" },
      },
      {
        id: 3,
        state: "CHANGES_REQUESTED",
        user: { id: 123, login: "bot-user" },
      },
    ]);

    const result = await dismissPreviousChangeRequests(
      octokits,
      "owner",
      "repo",
      123,
    );

    expect(result.success).toBe(true);
    expect(result.dismissedCount).toBe(3);
    expect(result.dismissedReviewIds).toEqual([1, 2, 3]);
    expect(result.errors).toEqual([]);
  });

  test("should only dismiss REQUEST_CHANGES reviews, not other states", async () => {
    const octokits = createMockOctokits({ id: 123, login: "bot-user" }, [
      {
        id: 1,
        state: "APPROVED",
        user: { id: 123, login: "bot-user" },
      },
      {
        id: 2,
        state: "CHANGES_REQUESTED",
        user: { id: 123, login: "bot-user" },
      },
      {
        id: 3,
        state: "COMMENTED",
        user: { id: 123, login: "bot-user" },
      },
      {
        id: 4,
        state: "DISMISSED",
        user: { id: 123, login: "bot-user" },
      },
    ]);

    const result = await dismissPreviousChangeRequests(
      octokits,
      "owner",
      "repo",
      123,
    );

    expect(result.success).toBe(true);
    expect(result.dismissedCount).toBe(1);
    expect(result.dismissedReviewIds).toEqual([2]);
    expect(result.errors).toEqual([]);
  });

  test("should only dismiss reviews from authenticated user, not other users", async () => {
    const octokits = createMockOctokits({ id: 123, login: "bot-user" }, [
      {
        id: 1,
        state: "CHANGES_REQUESTED",
        user: { id: 123, login: "bot-user" },
      },
      {
        id: 2,
        state: "CHANGES_REQUESTED",
        user: { id: 456, login: "other-user" },
      },
      {
        id: 3,
        state: "CHANGES_REQUESTED",
        user: { id: 789, login: "another-user" },
      },
    ]);

    const result = await dismissPreviousChangeRequests(
      octokits,
      "owner",
      "repo",
      123,
    );

    expect(result.success).toBe(true);
    expect(result.dismissedCount).toBe(1);
    expect(result.dismissedReviewIds).toEqual([1]);
    expect(result.errors).toEqual([]);
  });

  test("should handle reviews with null user gracefully", async () => {
    const octokits = createMockOctokits({ id: 123, login: "bot-user" }, [
      {
        id: 1,
        state: "CHANGES_REQUESTED",
        user: null,
      },
      {
        id: 2,
        state: "CHANGES_REQUESTED",
        user: { id: 123, login: "bot-user" },
      },
    ]);

    const result = await dismissPreviousChangeRequests(
      octokits,
      "owner",
      "repo",
      123,
    );

    expect(result.success).toBe(true);
    expect(result.dismissedCount).toBe(1);
    expect(result.dismissedReviewIds).toEqual([2]);
    expect(result.errors).toEqual([]);
  });

  test(
    "should handle dismissal errors gracefully and continue",
    async () => {
      // Create a mock that fails on dismissal
      const octokits = createMockOctokits(
        { id: 123, login: "bot-user" },
        [
          {
            id: 1,
            state: "CHANGES_REQUESTED",
            user: { id: 123, login: "bot-user" },
          },
        ],
        true, // dismissalShouldFail
      );

      const result = await dismissPreviousChangeRequests(
        octokits,
        "owner",
        "repo",
        123,
      );

      expect(result.success).toBe(false);
      expect(result.dismissedCount).toBe(0);
      expect(result.dismissedReviewIds).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.reviewId).toBe(1);
      expect(result.errors[0]?.error).toContain("Permission denied");
    },
    { timeout: 50000 }, // 50 seconds to account for retries
  );

  test(
    "should handle API error when fetching authenticated user",
    async () => {
      const octokits = {
        rest: {
          users: {
            getAuthenticated: mock(() =>
              Promise.reject(new Error("API rate limit exceeded")),
            ),
          },
          pulls: {
            listReviews: mock(() => Promise.resolve({ data: [] })),
            dismissReview: mock(() => Promise.resolve({ data: {} })),
          },
        } as any,
        graphql: {} as any,
      };

      const result = await dismissPreviousChangeRequests(
        octokits,
        "owner",
        "repo",
        123,
      );

      expect(result.success).toBe(false);
      expect(result.dismissedCount).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.error).toContain("API rate limit exceeded");
    },
    { timeout: 50000 }, // 50 seconds to account for retries
  );

  test(
    "should handle API error when listing reviews",
    async () => {
      const octokits = {
        rest: {
          users: {
            getAuthenticated: mock(() =>
              Promise.resolve({
                data: { id: 123, login: "bot-user" },
              }),
            ),
          },
          pulls: {
            listReviews: mock(() =>
              Promise.reject(new Error("Failed to fetch reviews")),
            ),
            dismissReview: mock(() => Promise.resolve({ data: {} })),
          },
        } as any,
        graphql: {} as any,
      };

      const result = await dismissPreviousChangeRequests(
        octokits,
        "owner",
        "repo",
        123,
      );

      expect(result.success).toBe(false);
      expect(result.dismissedCount).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.error).toContain("Failed to fetch reviews");
    },
    { timeout: 50000 }, // 50 seconds to account for retries
  );

  test("should be case-sensitive for user ID matching", async () => {
    const octokits = createMockOctokits({ id: 123, login: "bot-user" }, [
      {
        id: 1,
        state: "CHANGES_REQUESTED",
        user: { id: 123, login: "bot-user" },
      },
      {
        id: 2,
        state: "CHANGES_REQUESTED",
        user: { id: 124, login: "bot-user" }, // Different ID, same login
      },
    ]);

    const result = await dismissPreviousChangeRequests(
      octokits,
      "owner",
      "repo",
      123,
    );

    expect(result.success).toBe(true);
    expect(result.dismissedCount).toBe(1);
    expect(result.dismissedReviewIds).toEqual([1]); // Only the one with matching ID
    expect(result.errors).toEqual([]);
  });
});
