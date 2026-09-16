import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	AF_CHECKLIST_ASYNC_SUBAGENT_EVENT,
	type AfChecklistSubagentCompletion,
	type AfChecklistSubagentRuntime,
	registerAfChecklistSubagentProvider,
} from "../../src/integrations/af-checklist-watch.js";
import type { RunningSubagent, SubagentResult } from "../../src/types.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((ok, fail) => {
		resolve = ok;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function running(): RunningSubagent {
	return {
		id: "child-1",
		name: "checklist-request-1",
		task: "task",
		agent: "af-checklist-worker",
		mode: "interactive",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		autoExit: true,
		startTime: Date.now(),
		sessionFile: "/tmp/child.jsonl",
	};
}

function result(overrides: Partial<SubagentResult> = {}): SubagentResult {
	return {
		name: "checklist-request-1",
		task: "task",
		summary: "done",
		exitCode: 0,
		elapsed: 1,
		...overrides,
	};
}

function harness() {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const events = new Map<string, (value: unknown) => void>();
	const pi = {
		on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(name, handler);
		}),
		events: {
			on: vi.fn((name: string, handler: (value: unknown) => void) => {
				events.set(name, handler);
				return () => undefined;
			}),
		},
		getThinkingLevel: vi.fn(() => "high"),
		sendMessage: vi.fn(),
	};
	const completion = deferred<SubagentResult>();
	const child = running();
	const runtime: AfChecklistSubagentRuntime = {
		isMuxAvailable: vi.fn(() => true),
		getSpawnWidthLimit: vi.fn(() => 4),
		tryAcquireSlot: vi.fn(() => true),
		releaseReservedSlot: vi.fn(),
		launch: vi.fn(async () => child),
		watch: vi.fn(() => completion.promise),
		stop: vi.fn(async (active) => {
			active.abortController?.abort();
		}),
		claimSlot: vi.fn(),
		releaseSlot: vi.fn(),
		trackCompletion: vi.fn((_active, promise) => promise),
		route: vi.fn(),
	};
	registerAfChecklistSubagentProvider(pi as unknown as ExtensionAPI, runtime);
	const context = {
		cwd: "/repo",
		hasUI: true,
		model: { provider: "provider", id: "model" },
		modelRegistry: {},
		sessionManager: {
			getSessionFile: () => "/tmp/parent.jsonl",
			getSessionId: () => "parent",
		},
	};
	handlers.get("session_start")?.({}, context);
	return { pi, runtime, handlers, events, completion, child, context };
}

function request(overrides: Record<string, unknown> = {}) {
	const completions: AfChecklistSubagentCompletion[] = [];
	const responses: unknown[] = [];
	const value = {
		version: 1,
		requestId: "request-1",
		cwd: "/repo",
		prompt: "Do the checklist work.",
		claim: vi.fn(() => true),
		respond: vi.fn((response) => responses.push(response)),
		complete: vi.fn((completion) => completions.push(completion)),
		...overrides,
	};
	return { value, responses, completions };
}

async function tick() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("af-checklist-watch async subagent provider", () => {
	it("claims and acknowledges synchronously, then launches the fixed interactive profile", async () => {
		const h = harness();
		const r = request();
		h.events.get(AF_CHECKLIST_ASYNC_SUBAGENT_EVENT)?.(r.value);

		expect(r.value.claim).toHaveBeenCalledOnce();
		expect(r.responses).toEqual([expect.objectContaining({ ok: true, state: "queued" })]);
		expect(h.runtime.launch).toHaveBeenCalledOnce();
		const [params, context] = vi.mocked(h.runtime.launch).mock.calls[0];
		expect(params).toMatchObject({
			agent: "af-checklist-worker",
			task: "Do the checklist work.",
			cwd: "/repo",
			async: true,
			blocking: false,
			background: false,
			launchEnv: {
				PI_AF_CHECKLIST_AUDIT_REQUEST_ID: "request-1",
				PI_AF_CHECKLIST_AUDIT_LAUNCH_ID: expect.stringMatching(/^af-checklist-/),
				PI_AF_CHECKLIST_AUDIT_DIR: expect.stringContaining("af-checklist-watch"),
			},
		});
		expect(context).toMatchObject({
			cwd: "/repo",
			autoExit: true,
			parentModelRef: "provider/model",
			parentThinking: "high",
			agentDefaultsOverride: {
				mode: "interactive",
				autoExit: true,
				tools: "read,bash,edit,write",
				extensions: "none",
				skills: "none",
				spawning: false,
				timeout: 900,
				parentClosePolicy: "terminate",
				env: "PI_SUBAGENT_ZELLIJ_PLACEMENT=dwindle",
			},
		});

		h.completion.resolve(result());
		await tick();
		expect(r.completions).toEqual([
			expect.objectContaining({ state: "completed", output: "done" }),
		]);
		expect(h.runtime.route).toHaveBeenCalledOnce();
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
	});

	it("forwards cancellation to the owned pane and settles once", async () => {
		const h = harness();
		const controller = new AbortController();
		const r = request({ signal: controller.signal });
		h.events.get(AF_CHECKLIST_ASYNC_SUBAGENT_EVENT)?.(r.value);
		await tick();
		controller.abort();
		expect(h.runtime.stop).toHaveBeenCalledWith(h.child);

		h.completion.resolve(result({ exitCode: 1, error: "cancelled" }));
		await tick();
		expect(r.completions).toHaveLength(1);
		expect(r.completions[0]).toMatchObject({ state: "cancelled" });
	});

	it("fails closed before launch for missing UI, cwd mismatch, and full capacity", () => {
		for (const setup of [
			(h: ReturnType<typeof harness>) => h.handlers.get("session_shutdown")?.({}, h.context),
			(_h: ReturnType<typeof harness>, r: ReturnType<typeof request>) => {
				r.value.cwd = "/other";
			},
			(h: ReturnType<typeof harness>) => vi.mocked(h.runtime.tryAcquireSlot).mockReturnValue(false),
		]) {
			const h = harness();
			const r = request();
			setup(h, r);
			h.events.get(AF_CHECKLIST_ASYNC_SUBAGENT_EVENT)?.(r.value);
			expect(r.responses).toEqual([expect.objectContaining({ ok: false })]);
			expect(h.runtime.launch).not.toHaveBeenCalled();
		}
	});

	it("ignores malformed and unclaimed requests", () => {
		const h = harness();
		h.events.get(AF_CHECKLIST_ASYNC_SUBAGENT_EVENT)?.({ version: 2 });
		const r = request({ claim: vi.fn(() => false) });
		h.events.get(AF_CHECKLIST_ASYNC_SUBAGENT_EVENT)?.(r.value);
		expect(r.responses).toEqual([]);
		expect(h.runtime.launch).not.toHaveBeenCalled();
	});

	it("maps timeout and caller-ping outcomes without parent steer delivery", async () => {
		for (const [outcome, expected] of [
			[result({ timedOut: "timeout", timedOutAfter: 900 }), "timed_out"],
			[result({ summary: "", ping: { name: "worker", message: "Need approval" } }), "completed"],
		] as const) {
			const h = harness();
			const r = request();
			h.events.get(AF_CHECKLIST_ASYNC_SUBAGENT_EVENT)?.(r.value);
			h.completion.resolve(outcome);
			await tick();
			expect(r.completions[0]?.state).toBe(expected);
			expect(h.pi.sendMessage).not.toHaveBeenCalled();
		}
	});

	it("rejects an unavailable multiplexer and cancels owned panes on shutdown", async () => {
		const unavailable = harness();
		vi.mocked(unavailable.runtime.isMuxAvailable).mockReturnValue(false);
		const rejected = request();
		unavailable.events.get(AF_CHECKLIST_ASYNC_SUBAGENT_EVENT)?.(rejected.value);
		expect(rejected.responses).toEqual([expect.objectContaining({ ok: false })]);

		const active = harness();
		const started = request();
		active.events.get(AF_CHECKLIST_ASYNC_SUBAGENT_EVENT)?.(started.value);
		await tick();
		await active.handlers.get("session_shutdown")?.({}, active.context);
		expect(active.runtime.stop).toHaveBeenCalledWith(active.child);
	});

	it("reports post-ack launch failures exactly once", async () => {
		const h = harness();
		vi.mocked(h.runtime.launch).mockRejectedValue(new Error("pane launch failed"));
		const r = request();
		h.events.get(AF_CHECKLIST_ASYNC_SUBAGENT_EVENT)?.(r.value);
		await tick();
		expect(r.completions).toEqual([
			expect.objectContaining({ state: "failed", error: "pane launch failed" }),
		]);
		expect(h.runtime.releaseReservedSlot).toHaveBeenCalledOnce();
	});
});
