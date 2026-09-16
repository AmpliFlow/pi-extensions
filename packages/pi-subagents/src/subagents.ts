import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentListEntry } from "./agents/agent-list.js";
import {
	getAgentListEntries as getAgentListEntriesFromDefinitions,
	getAgentListSignature,
	renderAgentListReminder,
} from "./agents/agent-list.js";
import type { AgentDefaults } from "./agents/definitions.js";
import {
	getEffectiveAgentDefinitions,
	loadAgentDefaults as loadAgentDefaultsFromDefinitions,
} from "./agents/definitions.js";
import {
	getSubagentAgentOverrideError,
	getSubagentAgentRequirementError,
	resolveSubagentBlocking,
	resolveSubagentNoSession,
} from "./launch/policy.js";
import { resolveSubagentCwd } from "./launch/runtime-paths.js";
import { getNoSessionSeedMode } from "./launch/seed-child-session.js";
import { publishRunningSubagentCount } from "./runtime/nested-lifecycle.js";
import { initializeSpawnWidthForSession } from "./runtime/spawn-width.js";
import { registerOutstandingWorkReporting } from "./runtime/work-reporting.js";
import { parseSpawnEnv } from "./spawn/policy.js";

export { resolveSubagentConfigDir } from "./launch/runtime-paths.js";
export { buildSkillLaunchPlan as buildSkillLaunchPlanForTest } from "./launch/skills.js";

import { isMuxAvailable, muxSetupHint } from "./mux.js";
import {
	formatElapsed,
	getLaunchedSubagentResult,
	getShellReadyDelayMs,
	getWatcherSignal,
	launchBackgroundSubagent,
	launchSubagent,
	moduleAbortController,
	runningSubagents,
	shutdownSubagentsForParentExit,
	startWidgetRefresh,
	stopRunningSubagent,
	watchBackgroundSubagent,
	watchSubagent,
	widgetManager,
	wireSubagentSteerBack,
} from "./runtime/wiring.js";
import {
	resolveEffectiveSessionMode as resolveEffectiveSessionModeFromSessionFiles,
	resolveTaskSessionMode as resolveTaskSessionModeFromSessionFiles,
	type SubagentSessionMode,
} from "./session/session-files.js";
import type { SubagentParamsInput } from "./types.js";

export {
	getCompletedSubagentResultForTest,
	getLaunchedSubagentResultForTest,
	getPiInvocationForTest,
	getShellReadyDelayMs,
	getStartedSubagentDetailsForTest,
	getSubagentChildProcessEnvForTest,
	renderSubagentWidgetForTest,
	resetSubagentStateForTest,
	routeDetachedSubagentCompletionForTest,
	setRunningSubagentForTest,
	shutdownSubagentsForTest,
	waitForSubagentForTest,
} from "./runtime/wiring.js";

import { registerAfChecklistSubagentProvider } from "./integrations/af-checklist-watch.js";
import { traceSubagentLaunch } from "./launch/trace.js";
import { classifyAssistantMessageForMixedBatch } from "./runtime/batch-classifier.js";
import { createOrchestratorController } from "./runtime/orchestrator-controller.js";
import {
	markSubagentBatchBlocking,
	requestSubagentBatchStop,
	resetSubagentBatchStopRequest,
	stopAfterCurrentSubagentBatch,
} from "./runtime/state.js";
import { registerSubagentMessageRenderers } from "./tools/message-renderers.js";
import { registerSubagentResumeTool } from "./tools/resume-tool.js";
import {
	isHeadlessLaunchSession,
	markInitialPromptLaunchComplete,
	registerSubagentCoreTools,
} from "./tools/subagent-tools.js";
import { registerSubagentsView } from "./tools/subagents-view.js";
import { SUBAGENT_TOOL_NAME } from "./tools/tool-names.js";
import { adoptVerifiedRuns } from "./vf/run/adopt.js";

export { classifyAssistantMessageForMixedBatch as classifyAssistantMessageForMixedBatchForTest } from "./runtime/batch-classifier.js";
export { shouldAwaitSubagentLaunch as shouldAwaitSubagentLaunchForTest } from "./runtime/running-registry.js";
export {
	getSubagentBatchStopMetadata as getSubagentBatchStopMetadataForTest,
	markSubagentBatchBlocking as markSubagentBatchBlockingForTest,
	requestSubagentBatchStop as requestSubagentBatchStopForTest,
} from "./runtime/state.js";
export * from "./testing/test-helpers.js";

export function loadAgentDefaults(
	agentName: string,
	cwdHint?: string | null,
	baseCwd = process.cwd(),
): AgentDefaults | null {
	return loadAgentDefaultsFromDefinitions(agentName, cwdHint, baseCwd, resolveSubagentCwd);
}

function getAgentListEntries(baseCwd = process.cwd()): AgentListEntry[] {
	const callerEnv = parseSpawnEnv(process.env);
	return getAgentListEntriesFromDefinitions(baseCwd, resolveTaskSessionMode, {
		callerAgent: callerEnv.callerAgent,
		callerSpawnable: callerEnv.callerSpawnable,
	});
}

function resolveEffectiveSessionMode(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
): SubagentSessionMode {
	return resolveEffectiveSessionModeFromSessionFiles(params, agentDefs);
}

function resolveTaskSessionMode(agentDefs: AgentDefaults | null): SubagentSessionMode {
	return resolveTaskSessionModeFromSessionFiles(
		agentDefs,
		resolveSubagentNoSession,
		getNoSessionSeedMode,
	);
}

let lastAmbientRosterSignature: string | null = null;
let pendingAmbientRoster: {
	signature: string;
	content: string;
	entries: AgentListEntry[];
	supersedes?: true;
} | null = null;

function muxUnavailableResult(kind: "subagents" | "tab-title" = "subagents") {
	const text =
		kind === "tab-title"
			? `Terminal multiplexer not available. ${muxSetupHint()}`
			: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`;
	return {
		content: [{ type: "text" as const, text }],
		details: { error: "mux not available" },
	};
}

export default function subagentsExtension(pi: ExtensionAPI) {
	registerAfChecklistSubagentProvider(pi);

	// Register no model-facing surface when the user has no named agents. The factory re-runs
	// on every session replacement (/new, /resume, /fork) and on /reload, so
	// creating an agent file and starting a session restores the full surface.
	if (getEffectiveAgentDefinitions().length === 0) return;

	publishRunningSubagentCount(() => runningSubagents.size);
	const workReporting = registerOutstandingWorkReporting(pi);

	function attachWidgetContext(ctx: ExtensionContext) {
		widgetManager.attachContext(ctx);
	}

	function applySubagentLineage(ctx: ExtensionContext) {
		const parentSession = process.env.PI_SUBAGENT_PARENT_SESSION?.trim();
		if (!parentSession) return;
		const header = ctx.sessionManager.getHeader?.();
		if (!header || header.parentSession) return;
		header.parentSession = parentSession;
	}

	const orchestrator = createOrchestratorController(pi, {
		environment: process.env,
		getRunningSubagentCount: () => runningSubagents.size,
	});
	let latestContext: ExtensionContext | undefined;

	// Capture the UI context early so the widget keeps a stable slot above tasks.
	pi.on("session_start", (event, ctx) => {
		initializeSpawnWidthForSession();
		void workReporting.start(ctx);
		latestContext = ctx;
		resetSubagentBatchStopRequest();
		applySubagentLineage(ctx);
		attachWidgetContext(ctx);
		orchestrator.handleSessionStart(ctx);
		// Verified fan-outs outlive their parent session: deliver finished
		// results exactly once to their authorized recipient and re-watch live
		// runs (detached supervisors keep candidates running across
		// quit/reload/replacement).
		const sessionFile = ctx.sessionManager.getSessionFile?.() ?? "";
		adoptVerifiedRuns(pi, ctx.cwd, {
			sessionId: ctx.sessionManager.getSessionId?.() ?? "",
			// In print mode a startup steer must not trigger a model turn: the
			// `-p` process has its own single prompt to run, and triggering a
			// second turn at session start crashes some extensions' stale
			// captured contexts.
			triggerTurn: ctx.mode !== "print",
			confirmPersisted: sessionFile
				? async (deliveryId) => {
						// The send is async in Pi; poll our own transcript until the
						// deliveryId entry lands, then the receipt may be written.
						const deadline = Date.now() + 5_000;
						while (Date.now() < deadline) {
							try {
								if (readFileSync(sessionFile, "utf8").includes(deliveryId)) return true;
							} catch {
								// not flushed yet
							}
							await new Promise((resolve) => setTimeout(resolve, 150));
						}
						return false;
					}
				: undefined,
			updateWidget: () => widgetManager.update(),
		}).catch(() => {
			// Adoption is best-effort at startup; a failure must never block
			// the session from starting.
		});

		if (!shouldRegister(SUBAGENT_TOOL_NAME)) return;

		// Reset the cached signature on every fresh session so module-level state
		// does not leak between sessions. The reload path still uses the cached
		// signature to avoid duplicating the notification within the same session.
		if (event.reason !== "reload") {
			lastAmbientRosterSignature = null;
		}

		const entries = getAgentListEntries(ctx.cwd);
		const signature = getAgentListSignature(entries);
		// A headless parent awaits every launch, so the roster must not promise
		// a later report the model would otherwise plan around.
		const rosterOptions = { awaitAllLaunches: isHeadlessLaunchSession(ctx.hasUI) };
		if (entries.length === 0) {
			const hasDescribedAgents = getEffectiveAgentDefinitions(ctx.cwd).some((agent) =>
				agent.description?.trim(),
			);
			if (!hasDescribedAgents && lastAmbientRosterSignature === null) {
				pendingAmbientRoster = null;
				return;
			}
			if (signature === lastAmbientRosterSignature) {
				pendingAmbientRoster = null;
				return;
			}
			pendingAmbientRoster = {
				signature,
				content: renderAgentListReminder(entries, rosterOptions),
				entries,
				supersedes: true,
			};
			return;
		}

		if (signature === lastAmbientRosterSignature) {
			pendingAmbientRoster = null;
			return;
		}

		pendingAmbientRoster = {
			signature,
			content: renderAgentListReminder(entries, rosterOptions),
			entries,
			supersedes: event.reason === "reload" ? true : undefined,
		};
	});

	pi.on("before_agent_start", (event) => {
		const rosterResult = pendingAmbientRoster
			? {
					message: {
						customType: "subagent_roster",
						content: pendingAmbientRoster.content,
						display: false,
						details: {
							entries: pendingAmbientRoster.entries,
							signature: pendingAmbientRoster.signature,
							...(pendingAmbientRoster.supersedes ? { supersedes: true } : {}),
						},
					},
				}
			: undefined;
		if (pendingAmbientRoster) {
			lastAmbientRosterSignature = pendingAmbientRoster.signature;
			pendingAmbientRoster = null;
		}

		const orchestratorResult = orchestrator.beforeAgentStart(event);
		if (!rosterResult && !orchestratorResult) return undefined;
		return {
			...(rosterResult ?? {}),
			...(orchestratorResult ?? {}),
		};
	});

	pi.on("input", () => {
		resetSubagentBatchStopRequest();
		return { action: "continue" as const };
	});

	pi.on("message_end", (event) => {
		// Mixed-batch barrier: when an assistant message contains BOTH an async
		// subagent launch (subagent or subagent_resume) AND a non-subagent tool,
		// mark the batch blocking before any tool runs. The shared
		// shouldAwaitSubagentLaunch predicate then routes both subagent and
		// subagent_resume launches through the await path so the parent's
		// next turn sees completed results instead of racing the children.
		// Gated by PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN to share a kill
		// switch with the existing coordinator-only-turn behavior.
		const message = event?.message;
		if (!message) return;
		classifyAssistantMessageForMixedBatch(message, (agent, cwd) =>
			agent ? loadAgentDefaults(agent, cwd) : null,
		);
	});

	pi.on("tool_call", (event) => {
		const orchestratorResult = orchestrator.handleToolCall(event);
		if (orchestratorResult) return orchestratorResult;
		if (event.toolName !== SUBAGENT_TOOL_NAME) return {};
		const input = event.input as Partial<SubagentParamsInput>;
		const agentDefs =
			typeof input.agent === "string"
				? loadAgentDefaults(input.agent, typeof input.cwd === "string" ? input.cwd : undefined)
				: null;
		const agentError = getSubagentAgentRequirementError(input, agentDefs);
		const agentOverrideError = getSubagentAgentOverrideError(input, agentDefs);
		if (!agentError && !agentOverrideError) {
			if (resolveSubagentBlocking(input, agentDefs)) {
				markSubagentBatchBlocking();
			} else {
				requestSubagentBatchStop();
			}
		}
		return {};
	});

	pi.on("session_tree", (_event, ctx) => {
		orchestrator.handleSessionTree(ctx);
	});

	pi.on("turn_start", () => {
		resetSubagentBatchStopRequest();
	});

	pi.on("agent_end", () => {
		resetSubagentBatchStopRequest();
		markInitialPromptLaunchComplete();
	});

	// Clean up on real session shutdown. Pi also emits this event for the
	// coordinator-only turn stop after async launches; that must not kill the
	// children that the stop was created to leave running.
	pi.on("session_shutdown", async (event, ctx) => {
		traceSubagentLaunch("session.shutdown", {
			coordinatorOnlyTurnStop: stopAfterCurrentSubagentBatch,
			eventKeys: Object.keys((event ?? {}) as unknown as Record<string, unknown>),
			running: runningSubagents.size,
		});
		if (stopAfterCurrentSubagentBatch && !event.reason) {
			resetSubagentBatchStopRequest();
			return;
		}
		await workReporting.stop();
		orchestrator.handleSessionShutdown(ctx);

		moduleAbortController.abort();
		widgetManager.reset();
		resetSubagentBatchStopRequest();
		await shutdownSubagentsForParentExit();
		if (ctx.hasUI) {
			ctx.ui.setWidget("subagent-status", undefined);
		}
	});

	// Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
	const deniedTools = new Set(
		(process.env.PI_DENY_TOOLS ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);

	const shouldRegister = (name: string) => !deniedTools.has(name);

	registerSubagentCoreTools(pi, shouldRegister, {
		loadAgentDefaults: (agentName, cwd) =>
			agentName ? loadAgentDefaults(agentName, undefined, cwd) : null,
		resolveEffectiveSessionMode,
		resolveTaskSessionMode,
		launchBackgroundSubagent,
		launchSubagent,
		watchBackgroundSubagent,
		watchSubagent,
		getWatcherSignal,
		wireSubagentSteerBack,
		startWidgetRefresh,
		getLaunchedSubagentResult,
		stopRunningSubagent,
		muxUnavailableResult: () => muxUnavailableResult("tab-title"),
	});

	registerSubagentResumeTool(pi, shouldRegister, {
		getShellReadyDelayMs,
		isMuxAvailable,
		watchBackgroundSubagent,
		watchSubagent,
		getWatcherSignal,
		wireSubagentSteerBack,
		startWidgetRefresh,
		getLaunchedSubagentResult,
		runningSubagents,
		getContextWindow: (modelRef) => widgetManager.resolveModelContextWindow(modelRef),
		modelRegistry: {
			getAvailable: () => latestContext?.modelRegistry.getAvailable() ?? [],
		},
	});

	registerSubagentMessageRenderers(pi, formatElapsed);

	registerSubagentsView(pi, {
		getShellReadyDelayMs,
		isMuxAvailable,
		watchBackgroundSubagent,
		watchSubagent,
		getWatcherSignal,
		startWidgetRefresh,
		getContextWindow: (modelRef: string) => widgetManager.resolveModelContextWindow(modelRef),
		runningSubagents,
		pi,
		wireSubagentSteerBack,
		orchestrator,
	});
}
