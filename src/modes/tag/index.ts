import * as core from "@actions/core";
import type { Mode, ModeOptions, ModeResult } from "../types";
import { checkContainsTrigger } from "../../github/validation/trigger";
import { checkHumanActor } from "../../github/validation/actor";
import { createInitialComment } from "../../github/operations/comments/create-initial";
import { setupBranch } from "../../github/operations/branch";
import { configureGitAuth } from "../../github/operations/git-config";
import { prepareMcpConfig } from "../../mcp/install-mcp-server";
import {
  fetchGitHubData,
  extractTriggerTimestamp,
} from "../../github/data/fetcher";
import { createPrompt, generateDefaultPrompt } from "../../create-prompt";
import { isEntityContext, isPullRequestReviewCommentEvent } from "../../github/context";
import type { PreparedContext } from "../../create-prompt/types";
import type { FetchDataResult } from "../../github/data/fetcher";

/**
 * Tag mode implementation.
 *
 * The traditional implementation mode that responds to @claude mentions,
 * issue assignments, or labels. Creates tracking comments showing progress
 * and has full implementation capabilities.
 */
export const tagMode: Mode = {
  name: "tag",
  description: "Traditional implementation mode triggered by @claude mentions",

  shouldTrigger(context) {
    // Tag mode only handles entity events
    if (!isEntityContext(context)) {
      return false;
    }
    return checkContainsTrigger(context);
  },

  prepareContext(context, data) {
    return {
      mode: "tag",
      githubContext: context,
      commentId: data?.commentId,
      baseBranch: data?.baseBranch,
      claudeBranch: data?.claudeBranch,
    };
  },

  getAllowedTools() {
    return [];
  },

  getDisallowedTools() {
    return [];
  },

  shouldCreateTrackingComment() {
    return true;
  },

  async prepare({
    context,
    octokit,
    githubToken,
  }: ModeOptions): Promise<ModeResult> {
    // Tag mode only handles entity-based events
    if (!isEntityContext(context)) {
      throw new Error("Tag mode requires entity context");
    }

    // Check if actor is human
    await checkHumanActor(octokit.rest, context);

    // Create initial tracking comment
    const commentData = await createInitialComment(octokit.rest, context);
    const commentId = commentData.id;
    console.log("Created initial tracking comment for tag mode");

    const triggerTime = extractTriggerTimestamp(context);

    // Extract triggerCommentId for PR review comment contexts
    const triggerCommentId = isPullRequestReviewCommentEvent(context) 
      ? context.payload.comment.id 
      : undefined;

    const githubData = await fetchGitHubData({
      octokits: octokit,
      repository: `${context.repository.owner}/${context.repository.repo}`,
      prNumber: context.entityNumber.toString(),
      isPR: context.isPR,
      triggerUsername: context.actor,
      triggerTime,
      triggerCommentId,
    });

    // Setup branch
    const branchInfo = await setupBranch(octokit, githubData, context);

    // Configure git authentication if not using commit signing
    if (!context.inputs.useCommitSigning) {
      try {
        await configureGitAuth(githubToken, context, commentData.user);
      } catch (error) {
        console.error("Failed to configure git authentication:", error);
        throw error;
      }
    }

    // Create prompt file
    const modeContext = this.prepareContext(context, {
      commentId,
      baseBranch: branchInfo.baseBranch,
      claudeBranch: branchInfo.claudeBranch,
    });

    await createPrompt(tagMode, modeContext, githubData, context);

    // Get our GitHub MCP servers configuration
    const ourMcpConfig = await prepareMcpConfig({
      githubToken,
      owner: context.repository.owner,
      repo: context.repository.repo,
      branch: branchInfo.claudeBranch || branchInfo.currentBranch,
      baseBranch: branchInfo.baseBranch,
      claudeCommentId: commentId.toString(),
      allowedTools: [],
      context,
    });

    // Don't output mcp_config separately anymore - include in claude_args

    // Build claude_args for tag mode with all capabilities plus thread reply tools
    const tagModeTools = [
      "Edit",
      "MultiEdit",
      "Glob",
      "Grep",
      "LS",
      "Read",
      "Write",
      "mcp__github_comment__update_claude_comment",
      "mcp__github_ci__get_ci_status",
      "mcp__github_ci__get_workflow_run_details",
      "mcp__github_ci__download_job_log",
      // Thread reply tools for PR review discussions
      "mcp__github_review__reply_to_thread",
      "mcp__github_inline_comment__create_inline_comment",
    ];

    // Add git commands
    if (!context.inputs.useCommitSigning) {
      tagModeTools.push(
        "Bash(git add:*)",
        "Bash(git commit:*)",
        "Bash(git push:*)",
        "Bash(git status:*)",
        "Bash(git diff:*)",
        "Bash(git log:*)",
        "Bash(git rm:*)",
      );
    } else {
      // When using commit signing, use MCP file ops tools
      tagModeTools.push(
        "mcp__github_file_ops__commit_files",
        "mcp__github_file_ops__delete_files",
      );
    }

    const userClaudeArgs = process.env.CLAUDE_ARGS || "";

    // Build complete claude_args with multiple --mcp-config flags
    let claudeArgs = "";

    // Add our GitHub servers config
    const escapedOurConfig = ourMcpConfig.replace(/'/g, "'\\''");
    claudeArgs = `--mcp-config '${escapedOurConfig}'`;

    // Add required tools for tag mode
    claudeArgs += ` --allowedTools "${tagModeTools.join(",")}"`;

    // Append user's claude_args (which may have more --mcp-config flags)
    if (userClaudeArgs) {
      claudeArgs += ` ${userClaudeArgs}`;
    }

    core.setOutput("claude_args", claudeArgs.trim());

    return {
      commentId,
      branchInfo,
      mcpConfig: ourMcpConfig,
    };
  },

  async generatePrompt(
    context: PreparedContext,
    githubData: FetchDataResult,
    useCommitSigning: boolean,
    allowPrReviews: boolean = false,
  ): Promise<string> {
    // Generate standard tag mode prompt with thread reply capabilities
    const defaultPrompt = generateDefaultPrompt(
      context,
      githubData,
      useCommitSigning,
      allowPrReviews,
    );

    // Add thread reply instructions
    const threadReplyInstructions = `

# PR Review Thread Discussions

When responding to PR review comments or participating in review thread discussions:

- Use \`mcp__github_review__reply_to_thread\` to reply directly to specific review comment threads
- Use \`mcp__github_inline_comment__create_inline_comment\` to create new inline comments on specific lines
- These tools are available alongside all standard implementation capabilities
- You can still modify files, run CI checks, and perform all other tag mode functions as needed`;

    // If a custom prompt is provided, inject it into the tag mode prompt
    if (context.githubContext?.inputs?.prompt) {
      return (
        defaultPrompt +
        threadReplyInstructions +
        `

<custom_instructions>
${context.githubContext.inputs.prompt}
</custom_instructions>`
      );
    }

    return defaultPrompt + threadReplyInstructions;
  },

  getSystemPrompt() {
    // Tag mode doesn't need additional system prompts
    return undefined;
  },
};
