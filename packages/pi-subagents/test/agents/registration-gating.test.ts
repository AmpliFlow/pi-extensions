import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	join,
	mkdirSync,
	resetSubagentStateForTest,
	subagentsExtension,
	writeFileSync,
} from "../support/index.js";

interface CapturedRegistrations {
	handlers: Map<string, unknown>;
	tools: string[];
	commands: string[];
	shortcuts: string[];
	renderers: string[];
	events: string[];
}

function createCapturingPi(): { captured: CapturedRegistrations; api: ExtensionAPI } {
	const captured: CapturedRegistrations = {
		handlers: new Map(),
		tools: [],
		commands: [],
		shortcuts: [],
		renderers: [],
		events: [],
	};
	const api = {
		on(event: string, handler: unknown) {
			captured.handlers.set(event, handler);
		},
		registerTool(tool: { name: string }) {
			captured.tools.push(tool.name);
		},
		registerCommand(name: string) {
			captured.commands.push(name);
		},
		registerShortcut(shortcut: string) {
			captured.shortcuts.push(shortcut);
		},
		registerMessageRenderer(customType: string) {
			captured.renderers.push(customType);
		},
		events: {
			on(name: string) {
				captured.events.push(name);
				return () => undefined;
			},
		},
	} as unknown as ExtensionAPI;
	return { captured, api };
}

function writeGlobalAgent(configDir: string, frontmatter: string): void {
	const agentsDir = join(configDir, "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, "worker.md"), `---\n${frontmatter}\n---\n\nWorker body.`);
}

function assertFullSurface(captured: CapturedRegistrations): void {
	assert.deepEqual([...captured.tools].sort(), ["subagent", "subagent_kill", "subagent_resume"]);
	assert.deepEqual(captured.commands, ["subagents"]);
	assert.deepEqual(captured.shortcuts, ["alt+s"]);
	assert.deepEqual([...captured.renderers].sort(), ["subagent_ping", "subagent_result"]);
	assert.deepEqual(captured.events, ["pi:af-checklist-watch:v1:start"]);
}

describe("extension registration gating", () => {
	afterEach(() => resetSubagentStateForTest());

	it("registers the full surface from bundled agent definitions", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		mkdirSync(join(configDir, "agents"), { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;
		const prevCwd = process.cwd();
		process.chdir(dir);
		try {
			const { captured, api } = createCapturingPi();
			subagentsExtension(api);
			assertFullSurface(captured);
		} finally {
			process.chdir(prevCwd);
		}
	});

	it("allows a global definition to override a bundled agent", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		writeGlobalAgent(configDir, "name: worker\ndescription: Worker for gating tests");
		process.env.PI_CODING_AGENT_DIR = configDir;
		const setTabTitleOptIn = process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
		delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
		const prevCwd = process.cwd();
		process.chdir(dir);
		try {
			const { captured, api } = createCapturingPi();
			subagentsExtension(api);
			assertFullSurface(captured);
			assert.ok(captured.handlers.has("session_start"));
			assert.ok(captured.handlers.has("session_shutdown"));
		} finally {
			process.chdir(prevCwd);
			if (setTabTitleOptIn == null) delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
			else process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = setTabTitleOptIn;
		}
	});

	it("keeps other bundled agents when a disabled global override is ignored", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		writeGlobalAgent(configDir, "name: worker\ndescription: Disabled worker\nenabled: false");
		process.env.PI_CODING_AGENT_DIR = configDir;
		const prevCwd = process.cwd();
		process.chdir(dir);
		try {
			const { captured, api } = createCapturingPi();
			subagentsExtension(api);
			assertFullSurface(captured);
		} finally {
			process.chdir(prevCwd);
		}
	});
});
