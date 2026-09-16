import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installChecklistChildAudit } from "../../src/audit/checklist-audit.js";

const previousEnv = {
	directory: process.env.PI_AF_CHECKLIST_AUDIT_DIR,
	requestId: process.env.PI_AF_CHECKLIST_AUDIT_REQUEST_ID,
	launchId: process.env.PI_AF_CHECKLIST_AUDIT_LAUNCH_ID,
	name: process.env.PI_SUBAGENT_NAME,
};

afterEach(() => {
	for (const [key, value] of [
		["PI_AF_CHECKLIST_AUDIT_DIR", previousEnv.directory],
		["PI_AF_CHECKLIST_AUDIT_REQUEST_ID", previousEnv.requestId],
		["PI_AF_CHECKLIST_AUDIT_LAUNCH_ID", previousEnv.launchId],
		["PI_SUBAGENT_NAME", previousEnv.name],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("checklist child audit", () => {
	it("records finalized messages and tool activity without private reasoning or credentials", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-checklist-child-audit-"));
		process.env.PI_AF_CHECKLIST_AUDIT_DIR = directory;
		process.env.PI_AF_CHECKLIST_AUDIT_REQUEST_ID = "actual-1";
		process.env.PI_AF_CHECKLIST_AUDIT_LAUNCH_ID = "launch-1";
		process.env.PI_SUBAGENT_NAME = "worker-1";
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const pi = {
			on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(name, handler),
			),
		};
		installChecklistChildAudit(pi as unknown as ExtensionAPI);
		const context = {
			model: { provider: "provider", id: "model" },
			ui: { notify: vi.fn() },
			shutdown: vi.fn(),
		};

		await handlers.get("session_start")?.({}, context);
		await handlers.get("tool_execution_start")?.(
			{ toolName: "bash", args: { command: "pwd", apiKey: "hidden" } },
			context,
		);
		await handlers.get("message_end")?.(
			{
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "private chain" },
						{ type: "text", text: "Visible result" },
					],
				},
			},
			context,
		);
		await handlers.get("session_shutdown")?.({}, context);

		const file = join(directory, `${new Date().toISOString().slice(0, 10)}.jsonl`);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const source = readFileSync(file, "utf8");
		expect(source).toContain("Visible result");
		expect(source).not.toContain("private chain");
		expect(source).not.toContain("hidden");
		const records = source.trim().split("\n").map(JSON.parse);
		expect(records.map((record) => record.eventType)).toEqual([
			"checklist_agent.session_start",
			"checklist_agent.tool_start",
			"checklist_agent.message",
			"checklist_agent.session_shutdown",
		]);
		expect(records.every((record) => record.requestId === "actual-1")).toBe(true);
		rmSync(directory, { recursive: true, force: true });
	});
});
