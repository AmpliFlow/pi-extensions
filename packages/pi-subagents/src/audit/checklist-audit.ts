import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fsyncSync,
	mkdirSync,
	openSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SECRET_KEY =
	/(?:authorization|cookie|credential|password|passwd|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|ownerToken|thinking|reasoning)/i;

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function projectDirectoryName(cwd: string): string {
	const slug =
		basename(cwd)
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.slice(0, 48) || "project";
	return `${slug}-${digest(cwd).slice(0, 12)}`;
}

export function resolveChecklistAuditDirectory(cwd: string, root?: string): string {
	const base =
		root ??
		process.env.PI_AF_CHECKLIST_AUDIT_ROOT?.trim() ??
		join(homedir(), ".pi", "agent", "logs", "af-checklist-watch");
	return join(base, projectDirectoryName(cwd));
}

function secretPlaceholder(value: unknown): Record<string, unknown> {
	const serialized = typeof value === "string" ? value : JSON.stringify(value);
	return { redacted: true, sha256: digest(serialized ?? String(value)) };
}

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string"
	)
		return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "undefined") return null;
	if (value instanceof Error)
		return { name: value.name, message: value.message, stack: value.stack };
	if (Buffer.isBuffer(value))
		return { type: "buffer", bytes: value.byteLength, sha256: digest(value.toString("base64")) };
	if (typeof value !== "object") return String(value);
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		result[key] = SECRET_KEY.test(key) ? secretPlaceholder(item) : sanitize(item, seen);
	}
	return result;
}

class ChildChecklistAuditLogger {
	private sequence = 0;

	constructor(
		private readonly directory: string,
		private readonly cwd: string,
		private readonly actorId: string,
		private readonly requestId: string,
		private readonly launchId: string,
	) {}

	write(eventType: string, payload?: unknown): void {
		const timestamp = new Date().toISOString();
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		chmodSync(this.directory, 0o700);
		const unsigned = {
			schemaVersion: 1,
			eventId: randomUUID(),
			timestamp,
			sequence: ++this.sequence,
			processId: process.pid,
			cwd: this.cwd,
			eventType,
			actor: { type: "checklist_agent", id: this.actorId },
			requestId: this.requestId,
			launchId: this.launchId,
			...(payload === undefined ? {} : { payload: sanitize(payload) }),
		};
		const serialized = JSON.stringify(unsigned);
		const line = `${JSON.stringify({ ...unsigned, recordHash: digest(serialized) })}\n`;
		const descriptor = openSync(
			join(this.directory, `${timestamp.slice(0, 10)}.jsonl`),
			constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			fchmodSync(descriptor, 0o600);
			const bytes = Buffer.from(line, "utf8");
			let offset = 0;
			while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
	}
}

export function installChecklistChildAudit(pi: ExtensionAPI): void {
	const directory = process.env.PI_AF_CHECKLIST_AUDIT_DIR?.trim();
	if (!directory) return;
	const logger = new ChildChecklistAuditLogger(
		directory,
		process.cwd(),
		process.env.PI_SUBAGENT_NAME ?? "checklist-agent",
		process.env.PI_AF_CHECKLIST_AUDIT_REQUEST_ID ?? "unknown",
		process.env.PI_AF_CHECKLIST_AUDIT_LAUNCH_ID ?? "unknown",
	);
	const write = (eventType: string, payload?: unknown) => logger.write(eventType, payload);
	const writeOrShutdown = (
		eventType: string,
		payload: unknown,
		ctx: { ui: { notify(message: string, level?: "error"): void }; shutdown(): void },
	) => {
		try {
			write(eventType, payload);
		} catch (error) {
			ctx.ui.notify(
				`Checklist audit log failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			ctx.shutdown();
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		writeOrShutdown(
			"checklist_agent.session_start",
			{ model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined },
			ctx,
		);
	});
	pi.on("input", async (event, ctx) => {
		if (event.source !== "extension") writeOrShutdown("operator.child_input", event, ctx);
	});
	pi.on("message_end", async (event, ctx) => {
		writeOrShutdown("checklist_agent.message", event.message, ctx);
	});
	pi.on("tool_execution_start", async (event, ctx) => {
		writeOrShutdown("checklist_agent.tool_start", event, ctx);
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		writeOrShutdown("checklist_agent.tool_end", event, ctx);
	});
	pi.on("session_shutdown", async () => {
		write("checklist_agent.session_shutdown");
	});
}
