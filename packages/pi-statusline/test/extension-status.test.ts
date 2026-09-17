import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
	buildExtensionStatusIconAliases,
	findDuplicateExtensions,
	formatWatcherStatusGroup,
	type InstalledExtensionPackage,
	readInstalledExtensionPackages,
} from "../src/extension-status.js";

function installed(
	packageName: string,
	source = `npm:${packageName}@1.0.0`,
	identity = source.replace(/@\d.*$/u, ""),
): InstalledExtensionPackage {
	return { packageName, source, identity };
}

test("watcher protocol renders all installed watchers in stable order", () => {
	const packages = [
		installed("sentry-issue-watch"),
		installed("af-improvement-watch"),
		installed("github-pr-review-watch"),
		installed("af-project-task"),
		installed("af-checklist-watch"),
	];
	const statuses = new Map([
		["watcher:sw", "waiting"],
		["watcher:rw", "working"],
		["watcher:iw", "off"],
		["watcher:cw", "queued"],
		["watcher:pw", "polling"],
	]);

	assert.equal(
		formatWatcherStatusGroup(statuses, packages),
		"PW: polling | CW: queued | IW: off | RW: working | SW: waiting",
	);
});

test("future canonical watcher keys follow known watchers in deterministic order", () => {
	const statuses = new Map([
		["watcher:zz", "waiting"],
		["watcher:aa", "working"],
		["watcher:invalid", "busy"],
		["watcher:pw", "off"],
	]);
	assert.equal(
		formatWatcherStatusGroup(statuses, [installed("af-project-task")]),
		"PW: off | AA: working | ZZ: waiting",
	);
});

test("watcher protocol accepts only the canonical lifecycle vocabulary", () => {
	for (const state of ["off", "polling", "queued", "working", "waiting", "paused", "error"]) {
		assert.equal(
			formatWatcherStatusGroup(new Map([["watcher:pw", state]]), [installed("af-project-task")]),
			`PW: ${state}`,
		);
	}
	assert.equal(
		formatWatcherStatusGroup(new Map([["watcher:pw", "busy"]]), [installed("af-project-task")]),
		"PW: unavailable",
	);
});

test("watcher aliases adapt legacy keys and values", () => {
	const packages = [
		installed("af-project-task"),
		installed("af-checklist-watch"),
		installed("af-improvement-watch"),
		installed("github-pr-review-watch"),
		installed("sentry-issue-watch"),
	];
	const statuses = new Map([
		["af-task-watch", "af:queue #14 q:2 done:1"],
		["af-checklist-watch", "af-checklist #14 phase:waiting_for_human q:0 blocked:0"],
		["af-improvement-watch", "watching registration,analyze | 1 running | 0 waiting"],
		["gh-review-watch", "gh:rate_limited q:3 a:2 n:4"],
		["sentry-issue-watch", "off"],
	]);

	assert.equal(
		formatWatcherStatusGroup(statuses, packages),
		"PW: queued | CW: waiting | IW: working | RW: waiting | SW: off",
	);
});

test("valid canonical watcher state wins over legacy state", () => {
	assert.equal(
		formatWatcherStatusGroup(
			new Map([
				["watcher:pw", "paused"],
				["af-task-watch", "af:work task:#37 q:0 done:0"],
			]),
			[installed("af-project-task")],
		),
		"PW: paused",
	);
});

test("watchers distinguish unavailable publishers and conflicting installations", () => {
	assert.equal(
		formatWatcherStatusGroup(new Map(), [installed("af-checklist-watch")]),
		"CW: unavailable",
	);
	assert.equal(
		formatWatcherStatusGroup(new Map([["watcher:rw", "polling"]]), [
			installed(
				"github-pr-review-watch",
				"npm:github-pr-review-watch@1",
				"npm:github-pr-review-watch",
			),
			installed("github-pr-review-watch", "/local/review-watch", "/local/review-watch"),
		]),
		"RW: conflict",
	);
	const duplicate = installed("sentry-issue-watch");
	assert.equal(
		formatWatcherStatusGroup(new Map([["watcher:sw", "off"]]), [duplicate, duplicate]),
		"SW: conflict",
	);
});

test("watcher package discovery recognizes Git sources and the af-task-watch package alias", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-watcher-sources-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			packages: [
				"git:github.com/AmpliFlow/af-task-watch",
				"git:github.com/AmpliFlow/af-checklist-watch@main",
			],
		}),
	);

	try {
		assert.deepEqual(
			readInstalledExtensionPackages(projectDir).map(({ packageName }) => packageName),
			["af-project-task", "af-checklist-watch"],
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

test("installed package discovery uses the configured Pi agent directory", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-statusline-agent-dir-"));
	const agentDir = join(root, "configured-agent");
	const homeDir = join(root, "unrelated-home");
	const homeAgentDir = join(homeDir, ".pi", "agent");
	const projectDir = join(root, "project");
	const projectSettingsDir = join(projectDir, ".pi");
	const localExtensionDir = join(projectDir, "local-foo");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousHome = process.env.HOME;

	mkdirSync(agentDir, { recursive: true });
	mkdirSync(homeAgentDir, { recursive: true });
	mkdirSync(projectSettingsDir, { recursive: true });
	mkdirSync(localExtensionDir, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ packages: ["npm:@test/pi-foo@1.0.0"] }),
	);
	writeFileSync(
		join(homeAgentDir, "settings.json"),
		JSON.stringify({ packages: ["npm:@test/pi-home-only@1.0.0"] }),
	);
	writeFileSync(
		join(projectSettingsDir, "settings.json"),
		JSON.stringify({ packages: ["../local-foo", "npm:@test/pi-project@1.0.0"] }),
	);
	writeFileSync(join(localExtensionDir, "package.json"), JSON.stringify({ name: "@test/pi-foo" }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.HOME = homeDir;

	try {
		const installedPackages = readInstalledExtensionPackages(projectDir);

		assert.deepEqual(
			installedPackages.map(({ packageName, source }) => ({ packageName, source })),
			[
				{ packageName: "@test/pi-foo", source: "npm:@test/pi-foo@1.0.0" },
				{ packageName: "@test/pi-foo", source: "../local-foo" },
				{ packageName: "@test/pi-project", source: "npm:@test/pi-project@1.0.0" },
			],
		);
		assert.deepEqual(findDuplicateExtensions(installedPackages), ["foo"]);
		const aliases = buildExtensionStatusIconAliases(installedPackages);
		assert.ok(aliases.get("foo")?.includes("npm:@test/pi-foo"));
		assert.equal(aliases.has("home-only"), false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
});
