import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
	activeExperimentalCompaction,
	CONTEXT_DETAILS_KIND,
	CONTEXT_STATE_ENTRY_TYPE,
	CONTEXT_VERSION,
	contextContract,
	createExperimentalContextDetails,
	createInitialContextState,
	loadContextLineage,
	parseExperimentalContextDetails,
	projectExperimentalContext,
	reconcileContextContract,
} from "../src/context-window.js";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

function message(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function customState(data: unknown): SessionEntry {
	return {
		type: "custom",
		customType: CONTEXT_STATE_ENTRY_TYPE,
		data,
		id: "state",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
	};
}

test("creates and reconstructs versioned context lineage", () => {
	const state = createInitialContextState(first);
	assert.deepEqual(state, {
		kind: CONTEXT_DETAILS_KIND,
		version: CONTEXT_VERSION,
		firstWindowId: first,
		currentWindowId: first,
	});
	const kept = message("kept", 2);
	const details = createExperimentalContextDetails({
		lineage: state,
		keptMessages: [kept],
		reason: "manual",
		windowId: second,
		createdAt: "2026-01-01T00:00:01.000Z",
	});
	const compaction: SessionEntry = {
		type: "compaction",
		id: "compact",
		parentId: "state",
		timestamp: "2026-01-01T00:00:01.000Z",
		summary: contextContract(details),
		firstKeptEntryId: "kept",
		tokensBefore: 100,
		details,
	};
	assert.deepEqual(loadContextLineage([customState(state), compaction]), details);
	assert.deepEqual(
		activeExperimentalCompaction([customState(state), compaction])?.details,
		details,
	);
});

test("rejects malformed and unsupported context details", () => {
	assert.equal(parseExperimentalContextDetails(undefined), undefined);
	assert.equal(
		parseExperimentalContextDetails({
			kind: CONTEXT_DETAILS_KIND,
			version: 2,
			firstWindowId: first,
			previousWindowId: first,
			currentWindowId: second,
			reason: "manual",
			keptMessageFingerprints: [],
			createdAt: "now",
		}),
		undefined,
	);
});

test("projects only an exactly fingerprinted retained prefix", () => {
	const kept = message("old retained", 2);
	const later = message("new window", 4);
	const details = createExperimentalContextDetails({
		lineage: createInitialContextState(first),
		keptMessages: [kept],
		reason: "threshold",
		windowId: second,
		createdAt: "2026-01-01T00:00:03.000Z",
	});
	const summary: AgentMessage = {
		role: "compactionSummary",
		summary: contextContract(details),
		tokensBefore: 100,
		timestamp: 3,
	};
	const entry = {
		type: "compaction",
		id: "compact",
		parentId: "kept",
		timestamp: "2026-01-01T00:00:03.000Z",
		summary: contextContract(details),
		firstKeptEntryId: "kept",
		tokensBefore: 100,
		details,
	} as CompactionEntry<typeof details>;
	assert.deepEqual(projectExperimentalContext([summary, kept, later], entry, details), [
		summary,
		later,
	]);
	assert.equal(
		projectExperimentalContext([summary, message("changed", 2), later], entry, details),
		undefined,
	);
	const next = message("next ordinary turn", 5);
	const firstProjection = projectExperimentalContext([summary, kept, later], entry, details);
	const secondProjection = projectExperimentalContext([summary, kept, later, next], entry, details);
	assert.deepEqual(secondProjection?.slice(0, firstProjection?.length), firstProjection);
});

test("fails closed when the active compaction summary timestamp is non-finite", () => {
	const kept = message("kept", 2);
	const details = createExperimentalContextDetails({
		lineage: createInitialContextState(first),
		keptMessages: [kept],
		reason: "threshold",
		windowId: second,
	});
	const summary: AgentMessage = {
		role: "compactionSummary",
		summary: contextContract(details),
		tokensBefore: 100,
		timestamp: Number.POSITIVE_INFINITY,
	};
	const olderSummary: AgentMessage = {
		role: "compactionSummary",
		summary: "older",
		tokensBefore: 50,
		timestamp: 1,
	};
	const entry = {
		type: "compaction",
		summary: contextContract(details),
	} as CompactionEntry<typeof details>;
	assert.equal(
		projectExperimentalContext([summary, olderSummary, kept], entry, details),
		undefined,
	);
});

test("restores exactly one current context contract", () => {
	const lineage = createInitialContextState(first);
	const ordinary = [message("hello", 1)];
	const once = reconcileContextContract(ordinary, lineage);
	const twice = reconcileContextContract(once, lineage);
	assert.equal(once.length, 2);
	assert.deepEqual(twice, once);
	const branchSummary: AgentMessage = {
		role: "branchSummary",
		summary: "branch",
		fromId: "old",
		timestamp: 2,
	};
	const restored = reconcileContextContract([branchSummary, ...ordinary], lineage);
	assert.equal(restored[0], branchSummary);
	assert.equal(restored[1].role, "custom");
	assert.equal(restored[2], ordinary[0]);
});
