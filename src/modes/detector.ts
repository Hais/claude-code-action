import type { GitHubContext } from "../github/context";
import {
  isEntityContext,
  isIssueCommentEvent,
  isPullRequestReviewCommentEvent,
  isPullRequestReviewRequestedEvent,
} from "../github/context";
import { checkContainsTrigger } from "../github/validation/trigger";

export type AutoDetectedMode = "tag" | "agent" | "pr_review";

export function detectMode(context: GitHubContext): AutoDetectedMode {
  // Check for PR review requests FIRST (pr_review mode takes precedence over agent mode)
  if (isEntityContext(context) && isPullRequestReviewRequestedEvent(context)) {
    const reviewerTrigger = context.inputs?.reviewerTrigger;
    if (reviewerTrigger) {
      const triggerUser = reviewerTrigger.replace(/^@/, "");
      const requestedReviewerUsername =
        (context.payload as any).requested_reviewer?.login || "";

      if (triggerUser && requestedReviewerUsername === triggerUser) {
        return "pr_review";
      }
    }
  }

  // If prompt is provided and not a PR review, use agent mode for direct execution
  if (context.inputs?.prompt) {
    return "agent";
  }

  // Check for @claude mentions (tag mode)
  if (isEntityContext(context)) {
    if (
      isIssueCommentEvent(context) ||
      isPullRequestReviewCommentEvent(context)
    ) {
      if (checkContainsTrigger(context)) {
        return "tag";
      }
    }

    if (context.eventName === "issues") {
      if (checkContainsTrigger(context)) {
        return "tag";
      }
    }
  }

  // Default to agent mode (which won't trigger without a prompt)
  return "agent";
}

export function getModeDescription(mode: AutoDetectedMode): string {
  switch (mode) {
    case "tag":
      return "Interactive mode triggered by @claude mentions";
    case "agent":
      return "Direct automation mode for explicit prompts";
    case "pr_review":
      return "Pull request review mode triggered by review requests";
    default:
      return "Unknown mode";
  }
}

export function shouldUseTrackingComment(mode: AutoDetectedMode): boolean {
  return mode === "tag" || mode === "pr_review";
}

export function getDefaultPromptForMode(
  mode: AutoDetectedMode,
  context: GitHubContext,
): string | undefined {
  switch (mode) {
    case "tag":
      return undefined;
    case "agent":
      return context.inputs?.prompt;
    case "pr_review":
      return context.inputs?.prompt; // Custom prompt can be injected
    default:
      return undefined;
  }
}
