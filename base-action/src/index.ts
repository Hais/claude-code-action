#!/usr/bin/env bun

import * as core from "@actions/core";
import { preparePrompt } from "./prepare-prompt";
import { runClaude } from "./run-claude";
import { setupClaudeCodeSettings } from "./setup-claude-code-settings";
import { validateEnvironmentVariables } from "./validate-env";
import { installPlugins } from "./install-plugins";

// Import Sentry utilities if available in main project
// These imports may not resolve in standalone base-action, which is fine
let initSentry: any, captureError: any, addBreadcrumb: any;
try {
  const sentryModule = await import("../../src/utils/sentry");
  initSentry = sentryModule.initSentry;
  captureError = sentryModule.captureError;
  addBreadcrumb = sentryModule.addBreadcrumb;
} catch {
  // Sentry not available in standalone base-action, create no-op functions
  initSentry = () => {};
  captureError = () => {};
  addBreadcrumb = () => {};
}

async function run() {
  try {
    // Initialize Sentry if available (only works in main action, not standalone base-action)
    try {
      if (initSentry && process.env.GITHUB_REPOSITORY) {
        // Create minimal context for base-action
        const context = {
          repository: process.env.GITHUB_REPOSITORY,
          eventName: process.env.GITHUB_EVENT_NAME || "unknown",
          actor: process.env.GITHUB_ACTOR,
        };
        initSentry({ context });
        addBreadcrumb("Base action execution started", "execution", {
          repository: context.repository,
          event: context.eventName,
        });
      }
    } catch (sentryInitError) {
      // Ignore Sentry initialization errors in base-action
    }

    validateEnvironmentVariables();

    await setupClaudeCodeSettings(
      process.env.INPUT_SETTINGS,
      undefined, // homeDir
    );

    // Install Claude Code plugins if specified
    await installPlugins(
      process.env.INPUT_PLUGIN_MARKETPLACES,
      process.env.INPUT_PLUGINS,
      process.env.INPUT_PATH_TO_CLAUDE_CODE_EXECUTABLE,
    );

    const promptConfig = await preparePrompt({
      prompt: process.env.INPUT_PROMPT || "",
      promptFile: process.env.INPUT_PROMPT_FILE || "",
    });

    addBreadcrumb("Starting Claude execution", "claude", {
      hasPrompt: !!process.env.INPUT_PROMPT,
      hasPromptFile: !!process.env.INPUT_PROMPT_FILE,
      model: process.env.ANTHROPIC_MODEL,
    });

    await runClaude(promptConfig.path, {
      claudeArgs: process.env.INPUT_CLAUDE_ARGS,
      allowedTools: process.env.INPUT_ALLOWED_TOOLS,
      disallowedTools: process.env.INPUT_DISALLOWED_TOOLS,
      maxTurns: process.env.INPUT_MAX_TURNS,
      mcpConfig: process.env.INPUT_MCP_CONFIG,
      systemPrompt: process.env.INPUT_SYSTEM_PROMPT,
      appendSystemPrompt: process.env.INPUT_APPEND_SYSTEM_PROMPT,
      claudeEnv: process.env.INPUT_CLAUDE_ENV,
      fallbackModel: process.env.INPUT_FALLBACK_MODEL,
      model: process.env.ANTHROPIC_MODEL,
      pathToClaudeCodeExecutable:
        process.env.INPUT_PATH_TO_CLAUDE_CODE_EXECUTABLE,
      showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
    });
  } catch (error) {
    // Capture execution errors
    captureError(error, {
      operation: "base_action",
      phase: "execution",
      model: process.env.ANTHROPIC_MODEL,
      hasPrompt: !!process.env.INPUT_PROMPT,
      hasPromptFile: !!process.env.INPUT_PROMPT_FILE,
    });

    core.setFailed(`Action failed with error: ${error}`);
    core.setOutput("conclusion", "failure");
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
