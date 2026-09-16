import { describe, expect, it } from "vitest";
import { __pollForExitTest__ } from "../../src/mux/poll.js";
import { findLatestAssistantText } from "../../src/tools/subagent-done.js";

describe("no-session completion summaries", () => {
	it("extracts final assistant text and carries it through the exit sidecar", () => {
		const summary = findLatestAssistantText([
			{ role: "user", content: "task" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private" },
					{ type: "text", text: "Safe smoke complete." },
				],
			},
		]);

		expect(summary).toBe("Safe smoke complete.");
		expect(
			__pollForExitTest__.interpretExitSidecar({
				type: "done",
				outputTokens: 12,
				summary,
			}),
		).toMatchObject({
			reason: "done",
			exitCode: 0,
			outputTokens: 12,
			summary: "Safe smoke complete.",
		});
	});
});
