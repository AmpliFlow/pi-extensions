import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionCompactEvent,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { latestCheckpoint } from "./checkpoint.js";
import {
	type ContextToolRuntime,
	EXPERIMENTAL_CONTEXT_TOOL_DESCRIPTIONS,
	EXPERIMENTAL_CONTEXT_TOOL_NAMES,
	registerExperimentalContextTools,
} from "./context-tools.js";
import {
	activeExperimentalCompaction,
	CONTEXT_CONTRACT_MESSAGE_TYPE,
	CONTEXT_DEACTIVATION_MESSAGE_TYPE,
	CONTEXT_DETAILS_KIND,
	CONTEXT_STATE_ENTRY_TYPE,
	CONTEXT_VERSION,
	type ContextLineage,
	compactionKeptMessages,
	contextContract,
	contextDeactivation,
	createExperimentalContextDetails,
	createInitialContextState,
	hasContextContract,
	latestContextMode,
	loadContextLineage,
	parseExperimentalContextDetails,
	projectExperimentalContext,
	reconcileContextContract,
} from "./context-window.js";
import type { CodexCompactSettingsRuntime } from "./settings.js";
import { terminalText } from "./terminal.js";

const CONTINUATION_MESSAGE_TYPE = "pi-codex-context-continuation";

type PendingRollover = {
	requestId: string;
	nextWindowId: string;
	sessionId: string;
	generation: number;
	status: "requested" | "compacting" | "completed" | "failed";
	turnStartedAfterRequest: boolean;
	reason?: string;
	errorMessage?: string;
};

function sameNames(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

function contractMessage(lineage: ContextLineage) {
	return {
		customType: CONTEXT_CONTRACT_MESSAGE_TYPE,
		content: contextContract(lineage),
		display: false,
		details: {
			kind: CONTEXT_DETAILS_KIND,
			version: CONTEXT_VERSION,
			currentWindowId: lineage.currentWindowId,
		},
	};
}

function deactivationMessage() {
	return {
		customType: CONTEXT_DEACTIVATION_MESSAGE_TYPE,
		content: contextDeactivation(),
		display: false,
		details: { kind: CONTEXT_DETAILS_KIND, version: CONTEXT_VERSION },
	};
}

interface CompactFailedEvent {
	errorMessage?: string;
	aborted: boolean;
}

export interface ExperimentalContextManager {
	isEnabled(): boolean;
	startSession(ctx: ExtensionContext): void;
	applySettings(ctx: ExtensionContext): void;
	beforeCompact(
		event: SessionBeforeCompactEvent,
		ctx: ExtensionContext,
	):
		| {
				compaction: {
					summary: string;
					firstKeptEntryId: string;
					tokensBefore: number;
					details: unknown;
				};
		  }
		| undefined;
	projectContext(
		messages: readonly AgentMessage[],
		ctx: ExtensionContext,
	): AgentMessage[] | undefined;
	onCompact(event: SessionCompactEvent, ctx: ExtensionContext): void;
	onCompactFailed(event: CompactFailedEvent, ctx: ExtensionContext): void;
	onTurnStart(ctx: ExtensionContext): void;
	onAgentSettled(ctx: ExtensionContext): void;
	shutdown(): void;
}

export function createExperimentalContextManager(
	pi: ExtensionAPI,
	settingsRuntime: CodexCompactSettingsRuntime,
): ExperimentalContextManager {
	let generation = 0;
	let ownerSessionId: string | undefined;
	let lineage: ContextLineage | undefined;
	let pending: PendingRollover | undefined;
	let warned = false;
	let warnedOpaque = false;
	let warnedUnavailableTools = false;
	let toolsAvailable = false;
	let controller = new AbortController();

	const isConfigured = () => settingsRuntime.get().settings.experimentalContextManagement;
	const isEnabled = () => isConfigured() && toolsAvailable;

	const isOwned = (ctx: ExtensionContext, request?: PendingRollover) =>
		!controller.signal.aborted &&
		ownerSessionId === ctx.sessionManager.getSessionId() &&
		(!request ||
			(request.sessionId === ownerSessionId &&
				request.generation === generation &&
				pending?.requestId === request.requestId));

	const reconcileTools = (configured: boolean, ctx: ExtensionContext): boolean => {
		const available = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
		const ownedNames = new Set<string>(
			EXPERIMENTAL_CONTEXT_TOOL_NAMES.filter(
				(name) => available.get(name)?.description === EXPERIMENTAL_CONTEXT_TOOL_DESCRIPTIONS[name],
			),
		);
		const unavailableNames = EXPERIMENTAL_CONTEXT_TOOL_NAMES.filter(
			(name) => !ownedNames.has(name),
		);
		toolsAvailable = configured && unavailableNames.length === 0;
		const current = pi.getActiveTools();
		const withoutOwned = current.filter((name) => !ownedNames.has(name));
		const next = toolsAvailable
			? [...withoutOwned, ...EXPERIMENTAL_CONTEXT_TOOL_NAMES]
			: withoutOwned;
		if (!sameNames(current, next)) pi.setActiveTools(next);
		if (configured && !toolsAvailable && !warnedUnavailableTools && ctx.hasUI) {
			warnedUnavailableTools = true;
			ctx.ui.notify(
				`Experimental context management could not activate because these tool names are unavailable or owned by another extension: ${unavailableNames.join(", ")}. Pi-native compaction remains active.`,
				"warning",
			);
		}
		return toolsAvailable;
	};

	const ensureLineage = (ctx: ExtensionContext): ContextLineage => {
		lineage ??= loadContextLineage(ctx.sessionManager.getBranch());
		if (lineage) return lineage;
		const state = createInitialContextState();
		lineage = state;
		pi.appendEntry(CONTEXT_STATE_ENTRY_TYPE, state);
		return state;
	};

	const warnEnabled = (ctx: ExtensionContext) => {
		if (warned || !ctx.hasUI) return;
		warned = true;
		ctx.ui.notify(
			"Experimental context management is active. Context rollover does not create a summary; preserve important information with update_notes.",
			"warning",
		);
	};

	const applySettings = (ctx: ExtensionContext) => {
		if (!isOwned(ctx)) return;
		const branch = ctx.sessionManager.getBranch();
		const enabled = reconcileTools(isConfigured(), ctx);
		if (!enabled) {
			pending = undefined;
			if (latestContextMode(branch) === "active") {
				pi.sendMessage(deactivationMessage(), { triggerTurn: false });
			}
			return;
		}
		const activeLineage = ensureLineage(ctx);
		if (
			!warnedOpaque &&
			!activeExperimentalCompaction(branch) &&
			latestCheckpoint(branch) &&
			ctx.hasUI
		) {
			warnedOpaque = true;
			ctx.ui.notify(
				"The active remote checkpoint contains opaque history that recall_context cannot decode; only plaintext Pi entries and future notes are locally recallable.",
				"warning",
			);
		}
		const messages = branch.flatMap(sessionEntryToContextMessages);
		if (latestContextMode(branch) !== "active" || !hasContextContract(messages, activeLineage)) {
			pi.sendMessage(contractMessage(activeLineage), { triggerTurn: false });
		}
		warnEnabled(ctx);
	};

	const requestNewContext: ContextToolRuntime["requestNewContext"] = (ctx, input) => {
		if (!isOwned(ctx))
			throw new Error("The context session was replaced; retry in the active session");
		if (pending) throw new Error("A context rollover is already pending");
		const activeLineage = ensureLineage(ctx);
		pending = {
			requestId: randomUUID(),
			nextWindowId: randomUUID(),
			sessionId: ctx.sessionManager.getSessionId(),
			generation,
			status: "requested",
			turnStartedAfterRequest: false,
			...(input.reason ? { reason: input.reason } : {}),
		};
		return { requestId: pending.requestId, currentWindowId: activeLineage.currentWindowId };
	};

	registerExperimentalContextTools(pi, { isEnabled, requestNewContext });

	const continueAfterRollover = (ctx: ExtensionContext, request: PendingRollover) => {
		if (!isOwned(ctx, request) || request.status !== "completed") return;
		const current = lineage;
		pending = undefined;
		if (!current) return;
		pi.sendMessage(
			{
				customType: CONTINUATION_MESSAGE_TYPE,
				content: [
					`Context window ${current.currentWindowId} is now active.`,
					request.reason ? `Rollover reason: ${request.reason}` : undefined,
					"Continue the interrupted task. Use recall_context for older details and do not assume an automatic summary exists.",
				]
					.filter((line): line is string => Boolean(line))
					.join("\n"),
				display: false,
				details: {
					kind: CONTEXT_DETAILS_KIND,
					version: CONTEXT_VERSION,
					requestId: request.requestId,
					currentWindowId: current.currentWindowId,
				},
			},
			{ triggerTurn: true },
		);
	};

	const failRollover = (ctx: ExtensionContext, request: PendingRollover, message: string) => {
		if (!isOwned(ctx, request)) return;
		pending = undefined;
		const safeMessage = terminalText(message).slice(0, 2_000);
		if (ctx.hasUI) ctx.ui.notify(safeMessage, "warning");
		pi.sendMessage(
			{
				customType: CONTINUATION_MESSAGE_TYPE,
				content: `The requested context rollover failed and the previous context remains active. ${safeMessage}`,
				display: false,
				details: {
					kind: CONTEXT_DETAILS_KIND,
					version: CONTEXT_VERSION,
					requestId: request.requestId,
					failed: true,
				},
			},
			request.turnStartedAfterRequest
				? { triggerTurn: false }
				: ctx.isIdle()
					? { triggerTurn: true }
					: { triggerTurn: true, deliverAs: "followUp" },
		);
	};

	return {
		isEnabled,
		startSession(ctx) {
			controller.abort();
			controller = new AbortController();
			generation += 1;
			ownerSessionId = ctx.sessionManager.getSessionId();
			lineage = loadContextLineage(ctx.sessionManager.getBranch());
			pending = undefined;
			warned = false;
			warnedOpaque = false;
			warnedUnavailableTools = false;
			toolsAvailable = false;
			applySettings(ctx);
		},
		applySettings,
		beforeCompact(event, ctx) {
			if (!isEnabled() || !isOwned(ctx) || event.signal.aborted) return undefined;
			const activeLineage = ensureLineage(ctx);
			const request = pending;
			const details = createExperimentalContextDetails({
				lineage: activeLineage,
				keptMessages: compactionKeptMessages(event),
				reason: event.reason,
				...(request ? { requestId: request.requestId, windowId: request.nextWindowId } : {}),
			});
			if (request) request.status = "compacting";
			return {
				compaction: {
					summary: contextContract(details),
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details,
				},
			};
		},
		projectContext(messages, ctx) {
			if (!isEnabled() || !isOwned(ctx)) return undefined;
			const activeLineage = lineage ?? loadContextLineage(ctx.sessionManager.getBranch());
			if (!activeLineage) return undefined;
			const compaction = activeExperimentalCompaction(ctx.sessionManager.getBranch());
			if (compaction) {
				const projected = projectExperimentalContext(
					messages,
					compaction.entry,
					compaction.details,
				);
				return projected ? reconcileContextContract(projected, compaction.details) : undefined;
			}
			return hasContextContract(messages, activeLineage)
				? undefined
				: reconcileContextContract(messages, activeLineage);
		},
		onCompact(event, ctx) {
			if (!isOwned(ctx)) return;
			const details = parseExperimentalContextDetails(event.compactionEntry.details);
			if (details) lineage = details;
			const request = pending;
			if (request?.status !== "compacting" || !isOwned(ctx, request)) return;
			if (
				!details ||
				details.requestId !== request.requestId ||
				event.compactionEntry.summary !== contextContract(details)
			) {
				request.status = "failed";
				request.errorMessage = "Compaction completed without the requested context marker.";
				return;
			}
			request.status = "completed";
		},
		onCompactFailed(event, ctx) {
			const request = pending;
			if (request?.status !== "compacting" || !isOwned(ctx, request)) return;
			request.status = "failed";
			request.errorMessage =
				event.errorMessage ?? (event.aborted ? "Compaction was cancelled." : "Compaction failed.");
		},
		onTurnStart(ctx) {
			const request = pending;
			if (request && isOwned(ctx, request)) request.turnStartedAfterRequest = true;
		},
		onAgentSettled(ctx) {
			const request = pending;
			if (!request || !isOwned(ctx, request)) return;
			if (request.status === "completed") {
				if (request.turnStartedAfterRequest) pending = undefined;
				else continueAfterRollover(ctx, request);
				return;
			}
			if (request.status === "failed") {
				failRollover(ctx, request, request.errorMessage ?? "Compaction failed.");
				return;
			}
			if (request.status !== "requested") return;
			request.status = "compacting";
			ctx.compact({
				onComplete: (result) => {
					if (!isOwned(ctx, request)) return;
					const details = parseExperimentalContextDetails(result.details);
					if (!details || details.requestId !== request.requestId) {
						failRollover(
							ctx,
							request,
							"Compaction completed without the requested context marker.",
						);
						return;
					}
					lineage = details;
					request.status = "completed";
					if (request.turnStartedAfterRequest) pending = undefined;
					else continueAfterRollover(ctx, request);
				},
				onError: (error) => failRollover(ctx, request, error.message),
			});
		},
		shutdown() {
			generation += 1;
			controller.abort();
			ownerSessionId = undefined;
			lineage = undefined;
			pending = undefined;
			warned = false;
			warnedOpaque = false;
			warnedUnavailableTools = false;
			toolsAvailable = false;
		},
	};
}
