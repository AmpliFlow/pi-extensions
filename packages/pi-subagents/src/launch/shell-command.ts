import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shellEscape } from "../mux.js";
import { getPiInvocation } from "./child-command.js";
import {
	buildParentEnvSnapshot,
	PANE_IDENTITY_ENV_PATTERNS,
	resolveDenyEnvPatterns,
} from "./child-env.js";
import { disposeEnvCapsule, writeEnvCapsule } from "./env-capsule.js";
import { buildInteractiveSentinelShellCommands } from "./interactive-sentinel.js";
import { buildShellChangeDirectoryPrefix } from "./resume.js";

export interface InteractiveShellCommandInput {
	cwd?: string;
	/** Raw pi argv (unescaped); the capsule carries it as structured data. */
	piArgs: string[];
	/** Controlled launch overrides: frontmatter `env:` plus PI_* control vars. */
	envOverrides: Record<string, string>;
	/** Agent frontmatter `deny-env` spec; unioned with PI_SUBAGENT_ENV_DENY. */
	denyEnv?: string;
	doneSentinelFile: string;
	/** Derive PI_SUBAGENT_SURFACE from the child pane's ZELLIJ_PANE_ID. */
	deriveZellijPaneSurface?: boolean;
}

export interface InteractiveShellCommand {
	/** The string typed or staged into the child pane. Paths only — never env data. */
	command: string;
	capsulePath: string;
	/**
	 * Delete the capsule. Call only when the launch failed before the pane's
	 * launcher could consume it; after a successful send the pane owns the file.
	 */
	dispose: () => void;
}

export function getRunChildLauncherPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "run-child.mjs");
}

/**
 * Build the single interactive launch command used by initial launch, resume,
 * and timeout wrap-up.
 *
 * The observable pane command carries only the sentinel trap, the cd prefix,
 * and two paths (launcher + capsule). The pi argv and the environment travel
 * inside the one-shot capsule, which the launcher unlinks before spawning.
 */
export function buildInteractiveShellCommand(
	input: InteractiveShellCommandInput,
): InteractiveShellCommand {
	const invocation = getPiInvocation(input.piArgs);
	const capsulePath = writeEnvCapsule({
		command: invocation.command,
		args: invocation.args,
		...(input.cwd ? { cwd: input.cwd } : {}),
		parentEnv: buildParentEnvSnapshot(process.env, resolveDenyEnvPatterns(input.denyEnv)),
		overrides: input.envOverrides,
		paneIdentityKeys: [...PANE_IDENTITY_ENV_PATTERNS],
		...(input.deriveZellijPaneSurface ? { deriveZellijPaneSurface: true } : {}),
	});
	const sentinel = buildInteractiveSentinelShellCommands(input.doneSentinelFile);
	// Pi can run as a bundled executable, where process.execPath is the Pi binary,
	// not a JavaScript runtime. run-child.mjs must always be launched with Node.
	const launcher = `${shellEscape("node")} ${shellEscape(getRunChildLauncherPath())} ${shellEscape(capsulePath)}`;
	const command =
		`trap ${shellEscape(sentinel.exitTrap)} EXIT; ` +
		`${buildShellChangeDirectoryPrefix(input.cwd)}${launcher}; ${sentinel.direct}`;
	return { command, capsulePath, dispose: () => disposeEnvCapsule(capsulePath) };
}
