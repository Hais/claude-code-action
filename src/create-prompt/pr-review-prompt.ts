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

/**
 * Formats GitHub data for the review prompt
 */
function formatGitHubData(
  context: PreparedContext,
  githubData: FetchDataResult,
): FormattedGitHubData {
  const { contextData, comments, changedFilesWithSHA, reviewData, imageUrlMap } = githubData;
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
function buildIncrementalReviewFromMetadata(
  metadata: ReviewMetadata,
): string {
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
  
  const moreCommits = commits.length > maxCommitsToShow
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
    .map((commit) => `\n- ${commit.oid.substring(0, 8)}: ${commit.message.split("\n")[0]}`)
    .join("");
  
  const moreCommits = commits.length > maxCommitsToShow
    ? `\n... and ${commits.length - maxCommitsToShow} more commits`
    : "";

  return `\nCommits since your last review:${commitsList}${moreCommits}`;
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
    incrementalInfo = buildIncrementalReviewFromMetadata(lastReviewMetadata.metadata);
  }

  // Get GitHub API-based review data
  const lastReview = requestedReviewer
    ? findLastReviewFromUser(reviewData, requestedReviewer)
    : null;
  
  const commitsSinceReview = lastReview && contextData
    ? getCommitsSinceReview(
        (contextData as any).commits?.nodes || [],
        lastReview.submittedAt,
      )
    : [];
  
  const githubReviewInfo = buildGitHubReviewInfo(lastReview, commitsSinceReview);

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
  const { incrementalInfo, githubReviewInfo } = getIncrementalReviewData(eventData, githubData);

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
- Adding context when resolving threads (e.g., "Fixed in commit abc123", "No longer applicable after refactoring")

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