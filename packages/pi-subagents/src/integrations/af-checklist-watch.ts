import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentDefaults } from "../agents/definitions.js";
import type { SubagentLaunchContext } from "../launch/prep.js";
import { isMuxAvailable } from "../mux.js";
import { routeSubagentOutcome } from "../runtime/result-router.js";
import {
	claimSpawnWidthSlot,
	getSpawnWidthLimit,
	releaseSlots,
	releaseSpawnWidthSlot,
	releaseSpawnWidthSlotOnCompletion,
	tryAcquireSlots,
} from "../runtime/spawn-width.js";
import {
	formatElapsed,
	launchSubagent,
	runningSubagents,
	stopRunningSubagent,
	watchSubagent,
	widgetManager,
} from "../runtime/wiring.js";
import type { RunningSubagent, SubagentParamsInput, SubagentResult } from "../types.js";

export const AF_CHECKLIST_ASYNC_SUBAGENT_EVENT = "pi:af-checklist-watch:v1:start";

export type AfChecklistSubagentState = "completed" | "failed" | "timed_out" | "cancelled";

export type AfChecklistSubagentResponse =
	| { ok: true; launchId: string; state: "queued" }
	| { ok: false; error: string };

export interface AfChecklistSubagentCompletion {
	launchId: string;
	state: AfChecklistSubagentState;
	output?: string;
	error?: string;
}

export interface AfChecklistSubagentRequest {
	version: 1;
	requestId: string;
	cwd: string;
	prompt: string;
	signal?: AbortSignal;
	claim(): boolean;
	respond(response: AfChecklistSubagentResponse): void;
	complete(completion: AfChecklistSubagentCompletion): void;
}

export interface AfChecklistSubagentRuntime {
	isMuxAvailable(): boolean;
	getSpawnWidthLimit(): number;
	tryAcquireSlot(limit: number): boolean;
	releaseReservedSlot(): void;
	launch(params: SubagentParamsInput, ctx: SubagentLaunchContext): Promise<RunningSubagent>;
	watch(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult>;
	stop(running: RunningSubagent): Promise<void>;
	claimSlot(running: RunningSubagent): void;
	releaseSlot(running: RunningSubagent): void;
	trackCompletion(
		running: RunningSubagent,
		completion: Promise<SubagentResult>,
	): Promise<SubagentResult>;
	route(pi: ExtensionAPI, running: RunningSubagent, result: SubagentResult): void;
}

const CHECKLIST_AGENT_DEFAULTS: AgentDefaults = {
	tools: "read,bash,edit,write",
	skills: "none",
	extensions: "none",
	spawning: false,
	autoExit: true,
	mode: "interactive",
	sessionMode: "standalone",
	async: true,
	noSession: true,
	trustProject: false,
	timeout: 900,
	onTimeout: "block-resume",
	parentClosePolicy: "terminate",
};

const defaultRuntime: AfChecklistSubagentRuntime = {
	isMuxAvailable,
	getSpawnWidthLimit,
	tryAcquireSlot: (limit) => tryAcquireSlots(1, limit),
	releaseReservedSlot: () => releaseSlots(1),
	launch: launchSubagent,
	watch: watchSubagent,
	stop: stopRunningSubagent,
	claimSlot: claimSpawnWidthSlot,
	releaseSlot: releaseSpawnWidthSlot,
	trackCompletion: releaseSpawnWidthSlotOnCompletion,
	route: (pi, running, result) => {
		routeSubagentOutcome({
			pi,
			running,
			result,
			formatElapsed,
			updateWidget: () => widgetManager.update(),
		});
	},
};

function isAbortSignal(value: unknown): value is AbortSignal {
	if (!value || typeof value !== "object") return false;
	const signal = value as Partial<AbortSignal>;
	return (
		typeof signal.aborted === "boolean" &&
		typeof signal.addEventListener === "function" &&
		typeof signal.removeEventListener === "function"
	);
}

function isRequest(value: unknown): value is AfChecklistSubagentRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as Partial<AfChecklistSubagentRequest>;
	return (
		request.version === 1 &&
		typeof request.requestId === "string" &&
		typeof request.cwd === "string" &&
		typeof request.prompt === "string" &&
		(request.signal === undefined || isAbortSignal(request.signal)) &&
		typeof request.claim === "function" &&
		typeof request.respond === "function" &&
		typeof request.complete === "function"
	);
}

function reject(request: AfChecklistSubagentRequest, error: string): void {
	try {
		request.respond({ ok: false, error });
	} catch {
		// Consumer callbacks cannot interrupt the provider event loop.
	}
}

function completionFromResult(
	launchId: string,
	result: SubagentResult,
): AfChecklistSubagentCompletion {
	const output = result.ping?.message || result.summary || undefined;
	if (result.timedOut) {
		return { launchId, state: "timed_out", output, error: result.errorMessage || result.error };
	}
	if (result.error === "cancelled") {
		return { launchId, state: "cancelled", output, error: result.errorMessage };
	}
	if (result.exitCode === 0 && !result.errorMessage) {
		return { launchId, state: "completed", output };
	}
	return {
		launchId,
		state: "failed",
		output,
		error: result.errorMessage || result.error || `Subagent exited with code ${result.exitCode}.`,
	};
}

function launchContext(
	request: AfChecklistSubagentRequest,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	launchId: string,
): SubagentLaunchContext {
	return {
		sessionManager: ctx.sessionManager,
		cwd: request.cwd,
		launchToolCallId: launchId,
		autoExit: true,
		modelRegistry: ctx.modelRegistry,
		parentModelRef: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		parentThinking: pi.getThinkingLevel() as string,
		agentDefaultsOverride: CHECKLIST_AGENT_DEFAULTS,
	};
}

export function registerAfChecklistSubagentProvider(
	pi: ExtensionAPI,
	runtime: AfChecklistSubagentRuntime = defaultRuntime,
): void {
	let context: ExtensionContext | undefined;
	const owned = new Set<RunningSubagent>();

	pi.on("session_start", (_event, ctx) => {
		context = ctx;
	});
	pi.on("session_shutdown", async () => {
		context = undefined;
		await Promise.allSettled([...owned].map((running) => runtime.stop(running)));
	});

	if (!pi.events?.on) return;
	pi.events.on(AF_CHECKLIST_ASYNC_SUBAGENT_EVENT, (value: unknown) => {
		if (!isRequest(value)) return;
		try {
			if (!value.claim()) return;
		} catch {
			return;
		}

		if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value.requestId)) {
			reject(value, "Checklist subagent requestId is invalid.");
			return;
		}
		if (!value.prompt.trim() || Buffer.byteLength(value.prompt, "utf8") > 256 * 1024) {
			reject(value, "Checklist subagent prompt must contain at most 256 KiB of text.");
			return;
		}
		if (!context?.hasUI) {
			reject(value, "Checklist subagent provider has no active interactive Pi session.");
			return;
		}
		if (value.cwd !== context.cwd) {
			reject(value, "Checklist subagent cwd does not match the active Pi session.");
			return;
		}
		if (!runtime.isMuxAvailable()) {
			reject(value, "Checklist subagents require an active supported terminal multiplexer.");
			return;
		}
		if (value.signal?.aborted) {
			reject(value, "Checklist subagent request was already cancelled.");
			return;
		}
		const widthLimit = runtime.getSpawnWidthLimit();
		if (!runtime.tryAcquireSlot(widthLimit)) {
			reject(value, `Checklist subagent concurrency limit (${widthLimit}) is full.`);
			return;
		}

		const launchId = `af-checklist-${randomUUID()}`;
		let completed = false;
		const completeOnce = (completion: AfChecklistSubagentCompletion) => {
			if (completed) return;
			completed = true;
			try {
				value.complete(completion);
			} catch {
				// Consumer callbacks cannot change a settled launch.
			}
		};
		try {
			value.respond({ ok: true, launchId, state: "queued" });
		} catch {
			runtime.releaseReservedSlot();
			return;
		}

		const activeContext = context;
		void (async () => {
			let running: RunningSubagent | undefined;
			let abort: (() => void) | undefined;
			try {
				if (value.signal?.aborted) {
					runtime.releaseReservedSlot();
					completeOnce({
						launchId,
						state: "cancelled",
						error: "Checklist subagent was cancelled before launch.",
					});
					return;
				}
				const params: SubagentParamsInput = {
					name: `checklist-${value.requestId.slice(0, 48)}`,
					title: "AmpliFlow checklist worker",
					agent: "af-checklist-worker",
					task: value.prompt,
					cwd: value.cwd,
					async: true,
					blocking: false,
					background: false,
				};
				running = await runtime.launch(params, launchContext(value, activeContext, pi, launchId));
				runtime.claimSlot(running);
				owned.add(running);
				running.allowSteerDelivery = false;
				const watcherAbort = new AbortController();
				running.abortController = watcherAbort;
				abort = () => void runtime.stop(running as RunningSubagent);
				value.signal?.addEventListener("abort", abort, { once: true });
				if (value.signal?.aborted) abort();
				const watch = runtime.trackCompletion(running, runtime.watch(running, watcherAbort.signal));
				running.completionPromise = watch;
				const result = await watch;
				runtime.route(pi, running, result);
				completeOnce(completionFromResult(launchId, result));
			} catch (error) {
				if (running) {
					try {
						await runtime.stop(running);
					} catch {}
					runtime.releaseSlot(running);
					runningSubagents.delete(running.id);
				} else {
					runtime.releaseReservedSlot();
				}
				completeOnce({
					launchId,
					state: value.signal?.aborted ? "cancelled" : "failed",
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				if (abort) value.signal?.removeEventListener("abort", abort);
				if (running) owned.delete(running);
			}
		})();
	});
}
