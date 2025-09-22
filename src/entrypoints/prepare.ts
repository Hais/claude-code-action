#!/usr/bin/env bun

/**
 * Prepare the Claude action by checking trigger conditions, verifying human actor,
 * and creating the initial tracking comment
 */

import * as core from "@actions/core";
import { setupGitHubToken } from "../github/token";
import { checkWritePermissions } from "../github/validation/permissions";
import { createOctokit } from "../github/api/client";
import { parseGitHubContext, isEntityContext } from "../github/context";
import { getMode } from "../modes/registry";
import { prepare } from "../prepare";
import { collectActionInputsPresence } from "./collect-inputs";
import { initSentry, captureError, addBreadcrumb } from "../utils/sentry";

async function run() {
  try {
    collectActionInputsPresence();

    // Parse GitHub context first to enable mode detection
    const context = parseGitHubContext();

    // Auto-detect mode based on context
    const mode = getMode(context);

    // Initialize Sentry for error tracking (optional)
    initSentry({ context, mode });
    
    addBreadcrumb("Action preparation started", "prepare", {
      mode: mode.name,
      event: context.eventName,
      repository: context.repository,
    });

    // Setup GitHub token
    addBreadcrumb("Setting up GitHub token", "auth");
    const githubToken = await setupGitHubToken();
    const octokit = createOctokit(githubToken);

    // Step 3: Check write permissions (only for entity contexts)
    if (isEntityContext(context)) {
      // Check if github_token was provided as input (not from app)
      const githubTokenProvided = !!process.env.OVERRIDE_GITHUB_TOKEN;

      addBreadcrumb("Checking write permissions", "permissions", {
        actor: context.actor,
        repository: context.repository,
      });

      const hasWritePermissions = await checkWritePermissions(
        octokit.rest,
        context,
        context.inputs.allowedNonWriteUsers,
        githubTokenProvided,
      );
      if (!hasWritePermissions) {
        throw new Error(
          "Actor does not have write permissions to the repository",
        );
      }
    }

    // Check trigger conditions
    addBreadcrumb("Checking trigger conditions", "validation", {
      mode: mode.name,
      prompt: context.inputs?.prompt ? "[PRESENT]" : "[ABSENT]",
    });
    const containsTrigger = mode.shouldTrigger(context);

    // Debug logging
    console.log(`Mode: ${mode.name}`);
    console.log(`Context prompt: ${context.inputs?.prompt || "NO PROMPT"}`);
    console.log(`Trigger result: ${containsTrigger}`);

    // Set output for action.yml to check
    core.setOutput("contains_trigger", containsTrigger.toString());

    if (!containsTrigger) {
      console.log("No trigger found, skipping remaining steps");
      addBreadcrumb("No trigger found, action skipped", "validation");
      // Still set github_token output even when skipping
      core.setOutput("github_token", githubToken);
      return;
    }

    // Step 5: Use the new modular prepare function
    addBreadcrumb("Starting preparation phase", "prepare");
    const result = await prepare({
      context,
      octokit,
      mode,
      githubToken,
    });

    // MCP config is handled by individual modes (tag/agent) and included in their claude_args output

    // Expose the GitHub token (Claude App token) as an output
    core.setOutput("github_token", githubToken);

    // Step 6: Get system prompt from mode if available
    if (mode.getSystemPrompt) {
      const modeContext = mode.prepareContext(context, {
        commentId: result.commentId,
        baseBranch: result.branchInfo.baseBranch,
        claudeBranch: result.branchInfo.claudeBranch,
      });
      const systemPrompt = mode.getSystemPrompt(modeContext);
      if (systemPrompt) {
        core.exportVariable("APPEND_SYSTEM_PROMPT", systemPrompt);
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Capture error for Sentry with context
    captureError(error, {
      operation: "prepare",
      phase: "initialization",
      mode: "unknown", // Mode might not be available if error occurs early
    });
    
    core.setFailed(`Prepare step failed with error: ${errorMessage}`);
    // Also output the clean error message for the action to capture
    core.setOutput("prepare_error", errorMessage);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
