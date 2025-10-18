import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  spyOn,
  mock,
} from "bun:test";
import { agentMode } from "../../src/modes/agent";
import type { GitHubContext } from "../../src/github/context";
import { createMockContext, createMockAutomationContext } from "../mockContext";
import * as core from "@actions/core";
import * as gitConfig from "../../src/github/operations/git-config";

describe("Agent Mode", () => {
  let mockContext: GitHubContext;
  let exportVariableSpy: any;
  let setOutputSpy: any;
  let configureGitAuthSpy: any;

  beforeEach(() => {
    mockContext = createMockAutomationContext({
      eventName: "workflow_dispatch",
    });
    exportVariableSpy = spyOn(core, "exportVariable").mockImplementation(
      () => {},
    );
    setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    // Mock configureGitAuth to prevent actual git commands from running
    configureGitAuthSpy = spyOn(
      gitConfig,
      "configureGitAuth",
    ).mockImplementation(async () => {
      // Do nothing - prevent actual git config modifications
    });
  });

  afterEach(() => {
    exportVariableSpy?.mockClear();
    setOutputSpy?.mockClear();
    configureGitAuthSpy?.mockClear();
    exportVariableSpy?.mockRestore();
    setOutputSpy?.mockRestore();
    configureGitAuthSpy?.mockRestore();
  });

  test("agent mode has correct properties", () => {
    expect(agentMode.name).toBe("agent");
    expect(agentMode.description).toBe(
      "Direct automation mode for explicit prompts",
    );
    expect(agentMode.shouldCreateTrackingComment()).toBe(false);
    expect(agentMode.getAllowedTools()).toEqual([]);
    expect(agentMode.getDisallowedTools()).toEqual([]);
  });

  test("prepareContext returns minimal data", () => {
    const context = agentMode.prepareContext(mockContext);

    expect(context.mode).toBe("agent");
    expect(context.githubContext).toBe(mockContext);
    // Agent mode doesn't use comment tracking or branch management
    expect(Object.keys(context)).toEqual(["mode", "githubContext"]);
  });

  test("agent mode only triggers when prompt is provided", () => {
    // Should NOT trigger for automation events without prompt
    const workflowDispatchContext = createMockAutomationContext({
      eventName: "workflow_dispatch",
    });
    expect(agentMode.shouldTrigger(workflowDispatchContext)).toBe(false);

    const scheduleContext = createMockAutomationContext({
      eventName: "schedule",
    });
    expect(agentMode.shouldTrigger(scheduleContext)).toBe(false);

    const repositoryDispatchContext = createMockAutomationContext({
      eventName: "repository_dispatch",
    });
    expect(agentMode.shouldTrigger(repositoryDispatchContext)).toBe(false);

    // Should NOT trigger for entity events without prompt
    const entityEvents = [
      "issue_comment",
      "pull_request",
      "pull_request_review",
      "issues",
    ] as const;

    entityEvents.forEach((eventName) => {
      const contextNoPrompt = createMockContext({ eventName });
      expect(agentMode.shouldTrigger(contextNoPrompt)).toBe(false);
    });

    // Should trigger for ANY event when prompt is provided
    const allEvents = [
      "workflow_dispatch",
      "repository_dispatch",
      "schedule",
      "issue_comment",
      "pull_request",
      "pull_request_review",
      "issues",
    ] as const;

    allEvents.forEach((eventName) => {
      const contextWithPrompt =
        eventName === "workflow_dispatch" ||
        eventName === "repository_dispatch" ||
        eventName === "schedule"
          ? createMockAutomationContext({
              eventName,
              inputs: { prompt: "Do something" },
            })
          : createMockContext({
              eventName,
              inputs: { prompt: "Do something" },
            });
      expect(agentMode.shouldTrigger(contextWithPrompt)).toBe(true);
    });
  });

  test("agent mode triggers on PR push/synchronize events when agent_trigger_on_push is enabled", () => {
    const supportedActions = [
      "opened",
      "synchronize",
      "ready_for_review",
      "reopened",
    ] as const;

    // Test that agent mode triggers for supported PR actions when flag is enabled WITH prompt
    supportedActions.forEach((action) => {
      const contextWithFlag = createMockContext({
        eventName: "pull_request",
        eventAction: action,
        inputs: { agentTriggerOnPush: true, prompt: "Run tests" },
      });
      expect(agentMode.shouldTrigger(contextWithFlag)).toBe(true);
    });

    // Test that agent mode does NOT trigger when flag is enabled but NO prompt
    supportedActions.forEach((action) => {
      const contextWithoutPrompt = createMockContext({
        eventName: "pull_request",
        eventAction: action,
        inputs: { agentTriggerOnPush: true, prompt: "" },
      });
      expect(agentMode.shouldTrigger(contextWithoutPrompt)).toBe(false);
    });

    // Test that agent mode does NOT trigger when flag is disabled (default behavior)
    supportedActions.forEach((action) => {
      const contextWithoutFlag = createMockContext({
        eventName: "pull_request",
        eventAction: action,
        inputs: { agentTriggerOnPush: false, prompt: "" },
      });
      expect(agentMode.shouldTrigger(contextWithoutFlag)).toBe(false);
    });

    // Test that agent mode does NOT trigger for unsupported PR actions even with flag enabled
    const unsupportedActions = [
      "closed",
      "labeled",
      "assigned",
      "review_requested",
    ] as const;

    unsupportedActions.forEach((action) => {
      const contextWithFlag = createMockContext({
        eventName: "pull_request",
        eventAction: action,
        inputs: { agentTriggerOnPush: true, prompt: "Run tests" },
      });
      expect(agentMode.shouldTrigger(contextWithFlag)).toBe(false);
    });

    // Test that agent mode STILL triggers for non-PR/non-push events with prompt (manual mode)
    // The flag enables automatic triggering on push/PR sync, but doesn't disable manual mode
    const otherEvents = [
      "issues",
      "issue_comment",
      "pull_request_review",
    ] as const;

    otherEvents.forEach((eventName) => {
      const contextWithFlag = createMockContext({
        eventName,
        inputs: { agentTriggerOnPush: true, prompt: "Run tests" },
      });
      // Manual mode should still work even when flag is enabled
      expect(agentMode.shouldTrigger(contextWithFlag)).toBe(true);
    });
  });

  test("agent mode triggers on push events when agent_trigger_on_push is enabled", () => {
    // Test that agent mode triggers on push event when flag is enabled WITH prompt
    const contextWithFlag = createMockAutomationContext({
      eventName: "push",
      inputs: { agentTriggerOnPush: true, prompt: "Run CI checks" },
    });
    expect(agentMode.shouldTrigger(contextWithFlag)).toBe(true);

    // Test that agent mode does NOT trigger on push when flag is enabled but NO prompt
    const contextNoPrompt = createMockAutomationContext({
      eventName: "push",
      inputs: { agentTriggerOnPush: true, prompt: "" },
    });
    expect(agentMode.shouldTrigger(contextNoPrompt)).toBe(false);

    // Test that agent mode does NOT trigger on push when flag is disabled even with prompt
    const contextNoFlag = createMockAutomationContext({
      eventName: "push",
      inputs: { agentTriggerOnPush: false, prompt: "Run CI checks" },
    });
    expect(agentMode.shouldTrigger(contextNoFlag)).toBe(false);
  });

  test("agent mode requires prompt to trigger", () => {
    // Test that agent mode does NOT trigger without a prompt, regardless of flag
    const contextNoPrompt = createMockAutomationContext({
      eventName: "workflow_dispatch",
      inputs: { agentTriggerOnPush: false, prompt: "" },
    });
    expect(agentMode.shouldTrigger(contextNoPrompt)).toBe(false);

    const contextNoPromptWithFlag = createMockAutomationContext({
      eventName: "workflow_dispatch",
      inputs: { agentTriggerOnPush: true, prompt: "" },
    });
    expect(agentMode.shouldTrigger(contextNoPromptWithFlag)).toBe(false);
  });

  test("prepare method passes through claude_args", async () => {
    // Clear any previous calls before this test
    exportVariableSpy.mockClear();
    setOutputSpy.mockClear();

    const contextWithCustomArgs = createMockAutomationContext({
      eventName: "workflow_dispatch",
    });

    // Save original env vars and set test values
    const originalHeadRef = process.env.GITHUB_HEAD_REF;
    const originalRefName = process.env.GITHUB_REF_NAME;
    delete process.env.GITHUB_HEAD_REF;
    delete process.env.GITHUB_REF_NAME;

    // Set CLAUDE_ARGS environment variable
    process.env.CLAUDE_ARGS = "--model claude-sonnet-4 --max-turns 10";

    const mockOctokit = {
      rest: {
        users: {
          getAuthenticated: mock(() =>
            Promise.resolve({
              data: { login: "test-user", id: 12345 },
            }),
          ),
          getByUsername: mock(() =>
            Promise.resolve({
              data: { login: "test-user", id: 12345 },
            }),
          ),
        },
      },
    } as any;
    const result = await agentMode.prepare({
      context: contextWithCustomArgs,
      octokit: mockOctokit,
      githubToken: "test-token",
    });

    // Verify claude_args includes user args (no MCP config in agent mode without allowed tools)
    const callArgs = setOutputSpy.mock.calls[0];
    expect(callArgs[0]).toBe("claude_args");
    expect(callArgs[1]).toBe("--model claude-sonnet-4 --max-turns 10");
    expect(callArgs[1]).not.toContain("--mcp-config");

    // Verify return structure - should use "main" as fallback when no env vars set
    expect(result).toEqual({
      commentId: undefined,
      branchInfo: {
        baseBranch: "main",
        currentBranch: "main",
        claudeBranch: undefined,
      },
      mcpConfig: expect.any(String),
    });

    // Clean up
    delete process.env.CLAUDE_ARGS;
    if (originalHeadRef !== undefined)
      process.env.GITHUB_HEAD_REF = originalHeadRef;
    if (originalRefName !== undefined)
      process.env.GITHUB_REF_NAME = originalRefName;
  });

  test("prepare method creates prompt file with correct content", async () => {
    const contextWithPrompts = createMockAutomationContext({
      eventName: "workflow_dispatch",
    });
    // In v1-dev, we only have the unified prompt field
    contextWithPrompts.inputs.prompt = "Custom prompt content";

    const mockOctokit = {
      rest: {
        users: {
          getAuthenticated: mock(() =>
            Promise.resolve({
              data: { login: "test-user", id: 12345 },
            }),
          ),
          getByUsername: mock(() =>
            Promise.resolve({
              data: { login: "test-user", id: 12345 },
            }),
          ),
        },
      },
    } as any;
    await agentMode.prepare({
      context: contextWithPrompts,
      octokit: mockOctokit,
      githubToken: "test-token",
    });

    // Note: We can't easily test file creation in this unit test,
    // but we can verify the method completes without errors
    // With our conditional MCP logic, agent mode with no allowed tools
    // should not include any MCP config
    const callArgs = setOutputSpy.mock.calls[0];
    expect(callArgs[0]).toBe("claude_args");
    // Should be empty or just whitespace when no MCP servers are included
    expect(callArgs[1]).not.toContain("--mcp-config");
  });
});
