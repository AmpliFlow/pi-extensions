import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { CONTEXT_STATE_ENTRY_TYPE, createInitialContextState } from "../src/context-window.js";
import { NOTES_ENTRY_TYPE } from "../src/notes-state.js";
import { historyItems, recallContext } from "../src/recall-context.js";

const windowId = "11111111-1111-4111-8111-111111111111";

function branch(): SessionEntry[] {
	return [
		{
			type: "message",
			id: "user",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "secret decision\u001b[31m" }],
				timestamp: 1,
			},
		},
		{
			type: "custom",
			customType: CONTEXT_STATE_ENTRY_TYPE,
			data: createInitialContextState(windowId),
			id: "state",
			parentId: "user",
			timestamp: "2026-01-01T00:00:01.000Z",
		},
		{
			type: "custom",
			customType: NOTES_ENTRY_TYPE,
			data: { version: 1, action: "write", note: "decision", content: "Use OAuth" },
			id: "note",
			parentId: "state",
			timestamp: "2026-01-01T00:00:02.000Z",
		},
	];
}

test("lists and searches model-visible history without custom-entry payloads", () => {
	const entries = branch();
	const items = historyItems(entries);
	assert.equal(items.length, 1);
	assert.equal(items[0].id, "user");
	assert.equal(items[0].windowId, windowId);
	const searched = recallContext(entries, {
		source: "history",
		action: "search",
		query: "decision",
	});
	assert.match(searched.text, /"id": "user"/);
	assert.doesNotMatch(searched.text, /Use OAuth/);
	assert.equal(searched.text.includes("\u001b"), false);
});

test("reads and searches notes separately from history", () => {
	const entries = branch();
	const listed = recallContext(entries, { source: "notes", action: "list" });
	assert.match(listed.text, /decision/);
	const read = recallContext(entries, { source: "notes", action: "read", id: "decision" });
	assert.match(read.text, /Use OAuth/);
	const searched = recallContext(entries, {
		source: "notes",
		action: "search",
		query: "oauth",
	});
	assert.match(searched.text, /decision/);
});

test("ignores note identifiers that would change at the display boundary", () => {
	const entries = branch();
	entries.push({
		type: "custom",
		customType: NOTES_ENTRY_TYPE,
		data: {
			version: 1,
			action: "write",
			note: "unsafe\u001b[31m",
			content: "hidden",
		},
		id: "unsafe-note",
		parentId: entries.at(-1)?.id ?? null,
		timestamp: "2026-01-01T00:00:03.000Z",
	});
	const listed = recallContext(entries, { source: "notes", action: "list" });
	assert.doesNotMatch(listed.text, /unsafe/);
	assert.throws(
		() => recallContext(entries, { source: "notes", action: "read", id: "unsafe\u001b[31m" }),
		/not found/,
	);
});

test("paginates long history reads below the response ceiling", () => {
	const entries = branch();
	const user = entries[0];
	if (user.type !== "message" || user.message.role !== "user") assert.fail("Expected user entry");
	user.message.content = [{ type: "text", text: "x".repeat(40_000) }];
	const first = recallContext(entries, { source: "history", action: "read", id: "user" });
	assert.ok(Buffer.byteLength(first.text, "utf8") < 32 * 1024);
	assert.match(first.text, /nextCursor/);
});

test("chunks multibyte reads by UTF-8 bytes without splitting code points", () => {
	const entries = branch();
	const user = entries[0];
	if (user.type !== "message" || user.message.role !== "user") assert.fail("Expected user entry");
	user.message.content = [{ type: "text", text: "😀".repeat(9_000) }];
	const first = recallContext(entries, { source: "history", action: "read", id: "user" });
	assert.ok(Buffer.byteLength(first.text, "utf8") < 32 * 1024);
	const cursor = String(first.details.nextCursor);
	assert.match(cursor, /^\d+$/);
	assert.doesNotThrow(() =>
		recallContext(entries, { source: "history", action: "read", id: "user", cursor }),
	);
});

test("sanitizes note previews before truncating them", () => {
	const entries = branch();
	const note = entries[2];
	if (note.type !== "custom") assert.fail("Expected note entry");
	note.data = {
		version: 1,
		action: "write",
		note: "decision",
		content: `${"\u001b[31m".repeat(100)}meaningful decision`,
	};
	const searched = recallContext(entries, {
		source: "notes",
		action: "search",
		query: "MEANINGFUL",
	});
	assert.match(searched.text, /meaningful decision/);
	assert.doesNotMatch(searched.text, /\[31m/);
});

test("validates action-specific inputs and cursors", () => {
	assert.throws(
		() => recallContext(branch(), { source: "history", action: "read" }),
		/requires id/,
	);
	assert.throws(
		() => recallContext(branch(), { source: "notes", action: "search", query: "" }),
		/requires a query/,
	);
	assert.throws(
		() =>
			recallContext(branch(), {
				source: "history",
				action: "list",
				cursor: "invalid",
			}),
		/cursor is invalid/,
	);
});
