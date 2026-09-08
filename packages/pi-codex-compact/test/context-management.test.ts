import assert from "node:assert/strict";
import type { SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import { EXPERIMENTAL_CONTEXT_TOOL_NAMES } from "../src/context-tools.js";
import type { CodexCompactSettingsRuntime, CodexCompactSettingsState } from "../src/settings.js";
import { DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";

function settingsRuntime(enabled = true): CodexCompactSettingsRuntime {
	let state: CodexCompactSettingsState = {
		kind: "loaded",
		path: "/tmp/pi-codex-compact.json",
		settings: {
			...DEFAULT_CODEX_COMPACT_SETTINGS,
			experimentalContextManagement: enabled,
		},
		document: {},
	};
	return {
		get: () => structuredClone(state),
		async reload() {
			return structuredClone(state);
		},
		async update(patch) {
			state = { ...state, settings: { ...state.settings, ...patch } };
			return structuredClone(state);
		},
		async flush() {},
	};
}

function messageEntry(): SessionEntry {
	return {
		type: "message",
		id: "user",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
	};
}

function setup(enabled = true, fetch?: typeof globalThis.fetch) {
	const mock = createMockPi({ activeTools: ["read"] });
	const entries: SessionEntry[] = [messageEntry()];
	mock.rawPi.appendEntry = (customType, data) => {
		mock.entries.push({ customType, data });
		entries.push({
			type: "custom",
			customType,
			data,
			id: `custom-${entries.length}`,
			parentId: entries.at(-1)?.id ?? null,
			timestamp: new Date(entries.length).toISOString(),
		});
	};
	let compactOptions:
		| {
				onComplete?: (result: unknown) => void;
				onError?: (error: Error) => void;
		  }
		| undefined;
	const current = createMockContext({
		hasUI: true,
		mode: "tui",
		sessionManager: {
			getSessionId: () => "context-session",
			getSessionName: () => undefined,
			getBranch: () => entries,
			getEntries: () => entries,
		},
		getContextUsage: () => ({ tokens: 25, contextWindow: 100, percent: 25 }),
		compact: (options: typeof compactOptions) => {
			compactOptions = options;
		},
	});
	createCodexCompactExtension({ settingsRuntime: settingsRuntime(enabled), fetch })(mock.pi);
	return {
		mock,
		entries,
		current,
		get compactOptions() {
			return compactOptions;
		},
	};
}

async function start(setupResult: ReturnType<typeof setup>) {
	const handler = setupResult.mock.events.get("session_start")?.[0];
	assert.ok(handler);
	await handler({ type: "session_start", reason: "startup" }, setupResult.current.ctx);
}

function tool(setupResult: ReturnType<typeof setup>, name: string) {
	const found = setupResult.mock.tools.find((candidate) => candidate.name === name);
	assert.ok(found);
	return found as {
		execute: (...args: unknown[]) => Promise<{
			content: Array<{ type: string; text: string }>;
			details?: unknown;
			terminate?: boolean;
		}>;
		promptSnippet?: string;
		promptGuidelines?: string[];
	};
}

test("opt-in activates exactly four context tools after unrelated tools", async () => {
	const current = setup();
	await start(current);
	assert.deepEqual(
		current.mock.tools.map((candidate) => candidate.name),
		EXPERIMENTAL_CONTEXT_TOOL_NAMES,
	);
	assert.deepEqual(current.mock.rawPi.getActiveTools(), [
		"read",
		...EXPERIMENTAL_CONTEXT_TOOL_NAMES,
	]);
	for (const name of EXPERIMENTAL_CONTEXT_TOOL_NAMES) {
		assert.equal(tool(current, name).promptSnippet, undefined);
		assert.equal(tool(current, name).promptGuidelines, undefined);
	}
	assert.match(current.current.notifications[0]?.message ?? "", /Experimental context management/);
});

test("default-off removes context tools and stale calls fail", async () => {
	const current = setup(false);
	await start(current);
	assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read"]);
	await assert.rejects(
		tool(current, "get_context_remaining").execute(
			"call",
			{},
			undefined,
			undefined,
			current.current.ctx,
		),
		/disabled/,
	);
});

test("usage and notes tools remain observational and branch-persistent", async () => {
	const current = setup();
	await start(current);
	const usage = await tool(current, "get_context_remaining").execute(
		"usage",
		{},
		undefined,
		undefined,
		current.current.ctx,
	);
	assert.match(usage.content[0].text, /"remainingTokens": 75/);
	await tool(current, "update_notes").execute(
		"note",
		{ action: "write", note: "decision", content: "Use OAuth" },
		undefined,
		undefined,
		current.current.ctx,
	);
	const recalled = await tool(current, "recall_context").execute(
		"recall",
		{ source: "notes", action: "read", id: "decision" },
		undefined,
		undefined,
		current.current.ctx,
	);
	assert.match(recalled.content[0].text, /Use OAuth/);
});

test("cancelled note updates publish no session mutation", async () => {
	const current = setup();
	await start(current);
	const controller = new AbortController();
	controller.abort();
	const before = current.mock.entries.length;
	await assert.rejects(
		tool(current, "update_notes").execute(
			"note",
			{ action: "write", note: "cancelled", content: "not stored" },
			controller.signal,
			undefined,
			current.current.ctx,
		),
		/aborted/i,
	);
	assert.equal(current.mock.entries.length, before);
});

test("start_new_context compacts after settlement and continues exactly once", async () => {
	const current = setup();
	await start(current);
	const started = await tool(current, "start_new_context").execute(
		"start",
		{ reason: "fresh budget" },
		undefined,
		undefined,
		current.current.ctx,
	);
	assert.equal(started.terminate, true);
	const settled = current.mock.events.get("agent_settled")?.[0];
	assert.ok(settled);
	await settled({ type: "agent_settled" }, current.current.ctx);
	assert.ok(current.compactOptions);

	const before = current.mock.events.get("session_before_compact")?.[0];
	assert.ok(before);
	const event: SessionBeforeCompactEvent = {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "user",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 90,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
		},
		branchEntries: current.entries,
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
	};
	const result = (await before(event, current.current.ctx)) as {
		compaction: {
			summary: string;
			firstKeptEntryId: string;
			tokensBefore: number;
			details: unknown;
		};
	};
	assert.match(result.compaction.summary, /PI_CODEX_CONTEXT_WINDOW/);
	const compactEntry = {
		type: "compaction",
		id: "compact",
		parentId: current.entries.at(-1)?.id ?? null,
		timestamp: "2026-01-01T00:00:02.000Z",
		...result.compaction,
	};
	current.entries.push(compactEntry as SessionEntry);
	const compacted = current.mock.events.get("session_compact")?.[0];
	assert.ok(compacted);
	await compacted(
		{
			type: "session_compact",
			compactionEntry: compactEntry,
			fromExtension: true,
			reason: "manual",
			willRetry: false,
		},
		current.current.ctx,
	);
	current.compactOptions?.onComplete?.(result.compaction);
	current.compactOptions?.onComplete?.(result.compaction);
	const continuations = current.mock.sentMessages.filter(
		(item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn,
	);
	assert.equal(continuations.length, 1);
	assert.equal(
		(continuations[0].options as { deliverAs?: string } | undefined)?.deliverAs,
		undefined,
	);
	assert.match(JSON.stringify(continuations[0]), /fresh budget/);
});

test("experimental compaction takes precedence without a remote request", async () => {
	let fetches = 0;
	const current = setup(true, async () => {
		fetches += 1;
		throw new Error("remote fetch must not run");
	});
	await start(current);
	const before = current.mock.events.get("session_before_compact")?.[0];
	assert.ok(before);
	const result = (await before(
		{
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: "user",
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 90,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
			},
			branchEntries: current.entries,
			reason: "overflow",
			willRetry: true,
			signal: new AbortController().signal,
		},
		current.current.ctx,
	)) as { compaction: { summary: string; details: { reason: string } } };
	assert.equal(fetches, 0);
	assert.equal(result.compaction.details.reason, "overflow");
	assert.doesNotMatch(result.compaction.summary, /hello/);
});

test("automatic compaction consumes a pending request before settlement", async () => {
	const current = setup();
	await start(current);
	await tool(current, "start_new_context").execute(
		"start",
		{},
		undefined,
		undefined,
		current.current.ctx,
	);
	const before = current.mock.events.get("session_before_compact")?.[0];
	assert.ok(before);
	const event: SessionBeforeCompactEvent = {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "user",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 90,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
		},
		branchEntries: current.entries,
		reason: "threshold",
		willRetry: false,
		signal: new AbortController().signal,
	};
	const result = (await before(event, current.current.ctx)) as {
		compaction: {
			summary: string;
			firstKeptEntryId: string;
			tokensBefore: number;
			details: unknown;
		};
	};
	const compactEntry = {
		type: "compaction",
		id: "automatic",
		parentId: current.entries.at(-1)?.id ?? null,
		timestamp: "2026-01-01T00:00:03.000Z",
		...result.compaction,
	};
	current.entries.push(compactEntry as SessionEntry);
	await current.mock.events.get("session_compact")?.[0](
		{
			type: "session_compact",
			compactionEntry: compactEntry,
			fromExtension: true,
			reason: "threshold",
			willRetry: false,
		},
		current.current.ctx,
	);
	await current.mock.events.get("agent_settled")?.[0](
		{ type: "agent_settled" },
		current.current.ctx,
	);
	assert.equal(current.compactOptions, undefined);
	assert.equal(
		current.mock.sentMessages.filter(
			(item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn,
		).length,
		1,
	);
});

test("failed automatic rollover preserves the old context and reports once at settlement", async () => {
	const current = setup();
	await start(current);
	await tool(current, "start_new_context").execute(
		"start",
		{},
		undefined,
		undefined,
		current.current.ctx,
	);
	const before = current.mock.events.get("session_before_compact")?.[0];
	assert.ok(before);
	await before(
		{
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: "user",
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 90,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
			},
			branchEntries: current.entries,
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		},
		current.current.ctx,
	);
	await current.mock.events.get("session_compact_failed")?.[0](
		{
			type: "session_compact_failed",
			reason: "threshold",
			aborted: true,
			willRetry: false,
			fromExtension: true,
		},
		current.current.ctx,
	);
	assert.equal(
		current.mock.sentMessages.filter(
			(item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn,
		).length,
		0,
	);
	await current.mock.events.get("agent_settled")?.[0](
		{ type: "agent_settled" },
		current.current.ctx,
	);
	const continuations = current.mock.sentMessages.filter(
		(item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn,
	);
	assert.equal(continuations.length, 1);
	assert.match(JSON.stringify(continuations[0]), /previous context remains active/);
});

test("session shutdown invalidates pending compaction callbacks", async () => {
	const current = setup();
	await start(current);
	await tool(current, "start_new_context").execute(
		"start",
		{},
		undefined,
		undefined,
		current.current.ctx,
	);
	await current.mock.events.get("agent_settled")?.[0](
		{ type: "agent_settled" },
		current.current.ctx,
	);
	assert.ok(current.compactOptions);
	await current.mock.events.get("session_shutdown")?.[0](
		{ type: "session_shutdown", reason: "reload" },
		current.current.ctx,
	);
	current.compactOptions?.onError?.(new Error("stale"));
	assert.equal(
		current.mock.sentMessages.filter(
			(item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn,
		).length,
		0,
	);
});
