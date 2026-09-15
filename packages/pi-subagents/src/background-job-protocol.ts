import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentRuntime } from "./runtime.js";
import { resolveStartJobInput } from "./tools.js";
import type { SubagentThinkingLevel } from "./types.js";

export const BACKGROUND_JOB_START_EVENT = "pi:background-job:v1:start";

export interface BackgroundJobCompletion {
	jobId: string;
	state: "completed" | "partial" | "failed" | "timed_out" | "cancelled";
	result?: string;
	error?: string;
	limitations?: string[];
}

export type BackgroundJobStartResponse =
	| { ok: true; jobId: string; state: "queued" }
	| { ok: false; error: string };

export interface BackgroundJobStartRequest {
	version: 1;
	requestId: string;
	task: string;
	cwd: string;
	tools?: string[];
	thinkingLevel?: SubagentThinkingLevel;
	timeout?: number;
	signal?: AbortSignal;
	claim(): boolean;
	respond(response: BackgroundJobStartResponse): void;
	complete(completion: BackgroundJobCompletion): void;
}

function isAbortSignal(value: unknown): value is AbortSignal {
	if (!value || typeof value !== "object") return false;
	const signal = value as Partial<AbortSignal>;
	return (
		typeof signal.aborted === "boolean" &&
		typeof signal.addEventListener === "function" &&
		typeof signal.removeEventListener === "function"
	);
}

function isStartRequest(value: unknown): value is BackgroundJobStartRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as Partial<BackgroundJobStartRequest>;
	return (
		request.version === 1 &&
		typeof request.requestId === "string" &&
		request.requestId.length > 0 &&
		typeof request.task === "string" &&
		typeof request.cwd === "string" &&
		(request.signal === undefined || isAbortSignal(request.signal)) &&
		typeof request.claim === "function" &&
		typeof request.respond === "function" &&
		typeof request.complete === "function"
	);
}

function rejectRequest(request: BackgroundJobStartRequest, error: string): void {
	try {
		request.respond({ ok: false, error });
	} catch {
		// A consumer callback cannot interrupt the provider event loop.
	}
}

export function registerBackgroundJobProtocol(
	pi: ExtensionAPI,
	runtime: SubagentRuntime,
	getContext: () => ExtensionContext | undefined,
): () => void {
	return pi.events.on(BACKGROUND_JOB_START_EVENT, (value: unknown) => {
		if (!isStartRequest(value)) return;
		try {
			if (!value.claim()) return;
		} catch {
			return;
		}
		const ctx = getContext();
		if (value.requestId.length > 128 || value.requestId.includes("\0")) {
			rejectRequest(value, "Background-job requestId is invalid.");
			return;
		}
		if (!ctx) {
			rejectRequest(value, "Background-job service has no active Pi session.");
			return;
		}
		if (value.cwd !== ctx.cwd) {
			rejectRequest(value, "Background-job cwd does not match the active Pi session.");
			return;
		}
		try {
			const started = runtime.start(
				resolveStartJobInput(
					pi,
					{
						task: value.task,
						tools: value.tools,
						thinkingLevel: value.thinkingLevel,
						timeout: value.timeout,
					},
					ctx,
					"background-job protocol",
				),
			);
			try {
				value.respond({ ok: true, jobId: started.jobId, state: started.state });
			} catch {
				void runtime.cancel(started.jobId).catch(() => undefined);
				return;
			}
			const abort = () => void runtime.cancel(started.jobId).catch(() => undefined);
			if (value.signal?.aborted) abort();
			else value.signal?.addEventListener("abort", abort, { once: true });
			void runtime
				.completion(started.jobId)
				.then(
					(completion) => {
						try {
							value.complete(completion);
						} catch {
							// A consumer callback cannot change or interrupt the completed job.
						}
					},
					(error: unknown) => {
						try {
							value.complete({
								jobId: started.jobId,
								state: "failed",
								error: error instanceof Error ? error.message : String(error),
							});
						} catch {
							// A consumer callback cannot change the failed job.
						}
					},
				)
				.finally(() => {
					try {
						value.signal?.removeEventListener("abort", abort);
					} catch {
						// Consumer-owned signal cleanup must not reject the job completion chain.
					}
				});
		} catch (error) {
			rejectRequest(value, error instanceof Error ? error.message : String(error));
		}
	});
}
