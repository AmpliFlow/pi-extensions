import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import {
	CONTEXT_STATE_ENTRY_TYPE,
	loadContextLineage,
	parseContextState,
	parseExperimentalContextDetails,
} from "./context-window.js";
import { sortedNotes } from "./notes-state.js";

export const MAX_RECALL_QUERY_LENGTH = 512;
export const MAX_RECALL_RESULT_BYTES = 32 * 1024;
export const MAX_RECALL_MATCHES = 20;
const MAX_INDEXED_MESSAGE_CHARS = 256 * 1024;
const READ_CHUNK_CHARS = 24 * 1024;

export type RecallSource = "history" | "notes";
export type RecallAction = "list" | "read" | "search";

export interface RecallContextInput {
	source: RecallSource;
	action: RecallAction;
	id?: string;
	query?: string;
	cursor?: string;
}

interface HistoryItem {
	id: string;
	windowId?: string;
	role: string;
	content: string;
}

function parseCursor(cursor: string | undefined): number {
	if (cursor === undefined) return 0;
	if (!/^\d{1,12}$/.test(cursor)) throw new Error("recall_context cursor is invalid");
	return Number.parseInt(cursor, 10);
}

function messagePayload(message: AgentMessage): unknown {
	switch (message.role) {
		case "compactionSummary":
			return { summary: message.summary };
		case "branchSummary":
			return { summary: message.summary };
		case "custom":
			return { customType: message.customType, content: message.content };
		case "toolResult":
			return {
				toolName: message.toolName,
				toolCallId: message.toolCallId,
				content: message.content,
				isError: message.isError,
			};
		default: {
			const candidate = message as unknown as Record<string, unknown>;
			return Object.hasOwn(candidate, "content")
				? { content: candidate.content }
				: {
						command: candidate.command,
						output: candidate.output,
						exitCode: candidate.exitCode,
					};
		}
	}
}

function serializeMessage(message: AgentMessage): string {
	return JSON.stringify(messagePayload(message));
}

function firstWindowId(entries: readonly SessionEntry[]): string | undefined {
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === CONTEXT_STATE_ENTRY_TYPE) {
			const state = parseContextState(entry.data);
			if (state) return state.firstWindowId;
		}
		if (entry.type === "compaction") {
			const details = parseExperimentalContextDetails(entry.details);
			if (details) return details.firstWindowId;
		}
	}
	return loadContextLineage(entries)?.firstWindowId;
}

export function historyItems(entries: readonly SessionEntry[]): HistoryItem[] {
	const items: HistoryItem[] = [];
	let windowId = firstWindowId(entries);
	for (const entry of entries) {
		if (entry.type === "compaction") {
			const details = parseExperimentalContextDetails(entry.details);
			if (details) windowId = details.currentWindowId;
		}
		const messages = sessionEntryToContextMessages(entry);
		for (let index = 0; index < messages.length; index += 1) {
			const message = messages[index];
			items.push({
				id: messages.length === 1 ? entry.id : `${entry.id}:${index}`,
				...(windowId ? { windowId } : {}),
				role: message.role,
				content: serializeMessage(message),
			});
		}
	}
	return items;
}

function preview(value: string): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length > 240 ? `${compact.slice(0, 239)}…` : compact;
}

function paged<T>(values: readonly T[], offset: number) {
	const items = values.slice(offset, offset + MAX_RECALL_MATCHES);
	const next = offset + items.length;
	return {
		items,
		...(next < values.length ? { nextCursor: String(next) } : {}),
	};
}

function readChunk(value: string, offset: number) {
	if (offset > value.length) throw new Error("recall_context cursor exceeds the selected item");
	const chunk = value.slice(offset, offset + READ_CHUNK_CHARS);
	const next = offset + chunk.length;
	return {
		chunk,
		...(next < value.length ? { nextCursor: String(next) } : {}),
	};
}

function safeJson(value: unknown): string {
	const text = Array.from(JSON.stringify(value, null, 2), (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint === 10) return character;
		return codePoint < 32 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
	}).join("");
	if (Buffer.byteLength(text, "utf8") > MAX_RECALL_RESULT_BYTES) {
		throw new Error("recall_context result exceeded its output limit");
	}
	if (text.split("\n").length > 1_000) {
		throw new Error("recall_context result exceeded its line limit");
	}
	return text;
}

export function recallContext(
	entries: readonly SessionEntry[],
	input: RecallContextInput,
): { text: string; details: Record<string, unknown> } {
	if (input.source !== "history" && input.source !== "notes") {
		throw new Error("recall_context source must be history or notes");
	}
	if (input.action !== "list" && input.action !== "read" && input.action !== "search") {
		throw new Error("recall_context action must be list, read, or search");
	}
	const offset = parseCursor(input.cursor);
	if (input.action === "read" && (!input.id || input.query !== undefined)) {
		throw new Error("recall_context read requires id and does not accept query");
	}
	if (input.action === "search") {
		if (!input.query || input.query.length > MAX_RECALL_QUERY_LENGTH || input.id !== undefined) {
			throw new Error(
				`recall_context search requires a query of 1-${MAX_RECALL_QUERY_LENGTH} characters and does not accept id`,
			);
		}
	}
	if (input.action === "list" && (input.id !== undefined || input.query !== undefined)) {
		throw new Error("recall_context list does not accept id or query");
	}

	if (input.source === "notes") {
		const notes = sortedNotes(entries);
		if (input.action === "list") {
			const page = paged(
				notes.map((note) => ({ id: note.name, bytes: Buffer.byteLength(note.content, "utf8") })),
				offset,
			);
			return { text: safeJson({ source: "notes", action: "list", ...page }), details: page };
		}
		if (input.action === "read") {
			const note = notes.find((candidate) => candidate.name === input.id);
			if (!note) throw new Error(`Context note ${JSON.stringify(input.id)} was not found`);
			const page = readChunk(note.content, offset);
			return {
				text: safeJson({ source: "notes", action: "read", id: note.name, ...page }),
				details: { source: "notes", id: note.name, ...page },
			};
		}
		const query = input.query?.toLocaleLowerCase() ?? "";
		const matches = notes.filter((note) =>
			`${note.name}\n${note.content.slice(0, MAX_INDEXED_MESSAGE_CHARS)}`
				.toLocaleLowerCase()
				.includes(query),
		);
		const page = paged(
			matches.map((note) => ({ id: note.name, preview: preview(note.content) })),
			offset,
		);
		return { text: safeJson({ source: "notes", action: "search", ...page }), details: page };
	}

	const history = historyItems(entries);
	if (input.action === "list") {
		const page = paged(
			history.map((item) => ({
				id: item.id,
				...(item.windowId ? { windowId: item.windowId } : {}),
				role: item.role,
				preview: preview(item.content),
			})),
			offset,
		);
		return { text: safeJson({ source: "history", action: "list", ...page }), details: page };
	}
	if (input.action === "read") {
		const item = history.find((candidate) => candidate.id === input.id);
		if (!item) throw new Error(`History item ${JSON.stringify(input.id)} was not found`);
		const page = readChunk(item.content, offset);
		return {
			text: safeJson({
				source: "history",
				action: "read",
				id: item.id,
				...(item.windowId ? { windowId: item.windowId } : {}),
				role: item.role,
				...page,
			}),
			details: { source: "history", id: item.id, ...page },
		};
	}
	const query = input.query?.toLocaleLowerCase() ?? "";
	const matches = history.filter((item) =>
		item.content.slice(0, MAX_INDEXED_MESSAGE_CHARS).toLocaleLowerCase().includes(query),
	);
	const page = paged(
		matches.map((item) => ({
			id: item.id,
			...(item.windowId ? { windowId: item.windowId } : {}),
			role: item.role,
			preview: preview(item.content),
		})),
		offset,
	);
	return { text: safeJson({ source: "history", action: "search", ...page }), details: page };
}
