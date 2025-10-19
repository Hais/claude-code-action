import type { Octokits } from "../api/client";
import { retryWithBackoff } from "../../utils/retry";
import * as Sentry from "@sentry/node";

export interface DismissalResult {
  success: boolean;
  dismissedCount: number;
  dismissedReviewIds: number[];
  errors: Array<{ reviewId: number; error: string }>;
}

export interface RequestReviewResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Dismisses previous REQUEST_CHANGES reviews submitted by the authenticated user.
 * This prevents old blocking reviews from keeping PRs stuck when the bot submits
 * a new COMMENT review.
 *
 * @param octokits - Octokit clients for REST and GraphQL
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param pullNumber - Pull request number
 * @returns Result object with dismissal statistics
 */
export async function dismissPreviousChangeRequests(
  octokits: Octokits,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<DismissalResult> {
  const result: DismissalResult = {
    success: false,
    dismissedCount: 0,
    dismissedReviewIds: [],
    errors: [],
  };

  try {
    // Get the authenticated user to ensure we only dismiss our own reviews
    const authenticatedUser = await retryWithBackoff(() =>
      octokits.rest.users.getAuthenticated(),
    );
    const botUserId = authenticatedUser.data.id;
    const botLogin = authenticatedUser.data.login;

    console.log(
      `Checking for REQUEST_CHANGES reviews from ${botLogin} (ID: ${botUserId})`,
    );

    // Fetch all reviews for the PR
    const reviews = await retryWithBackoff(() =>
      octokits.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: pullNumber,
      }),
    );

    // Filter for REQUEST_CHANGES reviews from the authenticated user
    const changeRequestReviews = reviews.data.filter(
      (review) =>
        review.state === "CHANGES_REQUESTED" && review.user?.id === botUserId,
    );

    if (changeRequestReviews.length === 0) {
      console.log("No REQUEST_CHANGES reviews found from authenticated user");
      result.success = true;
      return result;
    }

    console.log(
      `Found ${changeRequestReviews.length} REQUEST_CHANGES review(s) to dismiss`,
    );

    // Dismiss each REQUEST_CHANGES review
    for (const review of changeRequestReviews) {
      try {
        await retryWithBackoff(() =>
          octokits.rest.pulls.dismissReview({
            owner,
            repo,
            pull_number: pullNumber,
            review_id: review.id,
            message: "Superseded by newer review",
          }),
        );

        result.dismissedCount++;
        result.dismissedReviewIds.push(review.id);
        console.log(`Dismissed review ${review.id}`);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.warn(`Failed to dismiss review ${review.id}:`, errorMessage);

        result.errors.push({
          reviewId: review.id,
          error: errorMessage,
        });

        // Capture individual dismissal failures
        Sentry.withScope((scope) => {
          scope.setTag("operation", "dismiss_single_review");
          scope.setContext("review_details", {
            review_id: review.id,
            pull_number: pullNumber,
          });
          scope.setLevel("warning");
          Sentry.captureException(
            error instanceof Error ? error : new Error(errorMessage),
          );
        });
      }
    }

    // Consider success if we dismissed at least some reviews
    result.success = result.dismissedCount > 0 || result.errors.length === 0;

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error in dismissPreviousChangeRequests:", errorMessage);

    // Capture top-level errors
    Sentry.withScope((scope) => {
      scope.setTag("operation", "dismiss_previous_change_requests");
      scope.setContext("repository", {
        owner,
        repo,
        pull_number: pullNumber,
      });
      scope.setLevel("error");
      Sentry.captureException(
        error instanceof Error ? error : new Error(errorMessage),
      );
    });

    result.errors.push({
      reviewId: -1,
      error: errorMessage,
    });

    return result;
  }
}

/**
 * Requests a review on a pull request from specified reviewers.
 * This triggers a review_requested event that can be handled by PR review mode.
 *
 * @param octokits - Octokit clients for REST and GraphQL
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param pullNumber - Pull request number
 * @param reviewers - Array of GitHub usernames to request reviews from
 * @returns Result object with success status and message
 */
export async function requestReview(
  octokits: Octokits,
  owner: string,
  repo: string,
  pullNumber: number,
  reviewers: string[],
): Promise<RequestReviewResult> {
  const result: RequestReviewResult = {
    success: false,
    message: "",
  };

  try {
    if (!reviewers || reviewers.length === 0) {
      result.message = "No reviewers specified";
      result.error = "At least one reviewer must be provided";
      return result;
    }

    console.log(
      `Requesting review from ${reviewers.join(", ")} on PR #${pullNumber}`,
    );

    // Request review using GitHub API
    const response = await retryWithBackoff(() =>
      octokits.rest.pulls.requestReviewers({
        owner,
        repo,
        pull_number: pullNumber,
        reviewers,
      }),
    );

    // Validate that reviewers were actually added
    const actuallyAddedReviewers = response.data.requested_reviewers || [];
    const addedUsernames = actuallyAddedReviewers.map((r) => r.login);

    // Check if any of the requested reviewers were successfully added
    if (addedUsernames.length === 0) {
      result.success = false;
      result.message = `Failed to request review from ${reviewers.join(", ")} - no reviewers were added (this usually means they are the PR author or already requested)`;
      result.error =
        "Review cannot be requested from pull request author or reviewer is already requested";
      console.warn(result.message);
      return result;
    }

    result.success = true;
    result.message = `Successfully requested review from ${addedUsernames.join(", ")}`;
    console.log(result.message);

    // Warn if some reviewers weren't added
    const notAdded = reviewers.filter((r) => !addedUsernames.includes(r));
    if (notAdded.length > 0) {
      console.warn(
        `Note: Could not request review from ${notAdded.join(", ")} (may be PR author or already requested)`,
      );
    }

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error in requestReview:", errorMessage);

    result.message = `Failed to request review: ${errorMessage}`;
    result.error = errorMessage;

    // Capture top-level errors
    Sentry.withScope((scope) => {
      scope.setTag("operation", "request_review");
      scope.setContext("repository", {
        owner,
        repo,
        pull_number: pullNumber,
      });
      scope.setContext("review_request", {
        reviewers: reviewers.join(", "),
        reviewer_count: reviewers.length,
      });
      scope.setLevel("error");
      Sentry.captureException(
        error instanceof Error ? error : new Error(errorMessage),
      );
    });

    return result;
  }
}
