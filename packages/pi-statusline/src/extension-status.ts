import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { powerlineExtensionSeparator } from "./powerline.js";
import { DEFAULT_EXTENSION_STATUS_ICONS } from "./settings.js";
import type { StatuslineConfig } from "./types.js";

export type ExtensionStatusIconAliasMap = ReadonlyMap<string, readonly string[]>;
export interface ExtensionStatusRuntime {
	duplicateExtensions: string[];
	extensionStatusIconAliases: ExtensionStatusIconAliasMap;
	installedExtensionPackages?: InstalledExtensionPackage[];
}

export interface InstalledExtensionPackage {
	packageName: string;
	source: string;
	identity: string;
}

type WatcherState = "off" | "polling" | "queued" | "working" | "waiting" | "paused" | "error";

interface WatcherDefinition {
	id: string;
	label: string;
	packageNames: readonly string[];
}

const WATCHER_STATES = new Set<WatcherState>([
	"off",
	"polling",
	"queued",
	"working",
	"waiting",
	"paused",
	"error",
]);
const WATCHERS: readonly WatcherDefinition[] = [
	{
		id: "pw",
		label: "PW",
		packageNames: ["af-project-task-watch", "af-task-watch"],
	},
	{
		id: "cw",
		label: "CW",
		packageNames: ["af-checklist-watch"],
	},
	{
		id: "iw",
		label: "IW",
		packageNames: ["af-improvement-watch"],
	},
	{
		id: "rw",
		label: "RW",
		packageNames: ["github-pr-review-watch"],
	},
	{
		id: "sw",
		label: "SW",
		packageNames: ["sentry-issue-watch"],
	},
];
const WATCHER_STATUS_KEYS = new Set(WATCHERS.map((watcher) => `watcher:${watcher.id}`));
const WATCHER_KEY_PATTERN = /^watcher:([a-z0-9-]{1,16})$/u;
const WATCHER_GIT_PACKAGE_NAMES: Readonly<Record<string, string>> = {
	"af-project-task-watch": "af-project-task-watch",
	"af-task-watch": "af-project-task-watch",
	"af-checklist-watch": "af-checklist-watch",
	"af-improvement-watch": "af-improvement-watch",
	"github-pr-review-watch": "github-pr-review-watch",
	"sentry-issue-watch": "sentry-issue-watch",
};

const STATUSLINE_KEY = "statusline";
const COMPATIBLE_STATUS_ICON_KEYS: Readonly<Record<string, string>> = {
	retry: "unknown-error-retry",
	sync: "pisync",
	"unknown-error-retry": "retry",
	pisync: "sync",
};
const EMPTY_EXTENSION_STATUS_ICON_ALIASES: ExtensionStatusIconAliasMap = new Map();
function extensionStatusSeparator(
	config: StatuslineConfig,
	theme: Theme,
	trueColor: boolean,
): string {
	return powerlineExtensionSeparator(theme, config.palettePreset, trueColor);
}

export function formatExtensionStatuses(
	statuses: ReadonlyMap<string, string>,
	theme: Theme,
	config: StatuslineConfig,
	runtime: ExtensionStatusRuntime,
	hiddenKeys: ReadonlySet<string> = new Set(),
	trueColor = true,
): string {
	const separator = extensionStatusSeparator(config, theme, trueColor);
	const watcherGroup = formatWatcherStatusGroup(statuses, runtime.installedExtensionPackages ?? []);
	const visibleStatuses = [
		...formatDuplicateExtensionStatus(runtime, theme),
		...[...statuses.entries()]
			.filter(
				([key, value]) =>
					key !== STATUSLINE_KEY &&
					!isWatcherStatusKey(key) &&
					!hiddenKeys.has(key) &&
					value.trim().length > 0,
			)
			.map(([key, value]) =>
				formatExtensionStatus(key, value, theme, config, runtime.extensionStatusIconAliases),
			),
	].slice(0, 5);

	return [watcherGroup, ...visibleStatuses].filter(Boolean).join(separator);
}

export function formatWatcherStatusGroup(
	statuses: ReadonlyMap<string, string>,
	installedPackages: readonly InstalledExtensionPackage[],
): string {
	const known = WATCHERS.flatMap((watcher) => {
		const installations = installedPackages.filter((extensionPackage) =>
			watcher.packageNames.includes(extensionPackage.packageName),
		);
		if (installations.length === 0) return [];
		const state = installations.length > 1 ? "conflict" : watcherState(watcher, statuses);
		return [`${watcher.label}: ${state}`];
	});
	const knownIds = new Set(WATCHERS.map((watcher) => watcher.id));
	const future = [...statuses.entries()]
		.flatMap(([key, value]) => {
			const id = WATCHER_KEY_PATTERN.exec(key)?.[1];
			const state = id ? canonicalWatcherState(value, id.toUpperCase()) : undefined;
			return id && !knownIds.has(id) && state ? [{ id, state }] : [];
		})
		.sort((left, right) => left.id.localeCompare(right.id))
		.map(({ id, state }) => `${id.toUpperCase()}: ${state}`);
	return [...known, ...future].join(" | ");
}

function isWatcherStatusKey(key: string): boolean {
	return WATCHER_STATUS_KEYS.has(key) || WATCHER_KEY_PATTERN.test(key);
}

function watcherState(
	watcher: WatcherDefinition,
	statuses: ReadonlyMap<string, string>,
): WatcherState | "unavailable" | "conflict" {
	const canonical = canonicalWatcherState(statuses.get(`watcher:${watcher.id}`), watcher.label);
	if (canonical) return canonical;

	return "unavailable";
}

function canonicalWatcherState(
	value: string | undefined,
	expectedLabel: string,
): WatcherState | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	const prefix = `${expectedLabel.toLowerCase()}:`;
	if (!normalized.startsWith(prefix)) return undefined;
	const state = normalized.slice(prefix.length).trim();
	return WATCHER_STATES.has(state as WatcherState) ? (state as WatcherState) : undefined;
}

export function formatExtensionStatus(
	key: string,
	value: string,
	theme: Theme,
	config: Pick<StatuslineConfig, "extensionStatusIcons">,
	extensionStatusIconAliases: ExtensionStatusIconAliasMap = EMPTY_EXTENSION_STATUS_ICON_ALIASES,
): string {
	const status = splitExtensionStatusIcon(stripExtensionStatusPrefix(key, value));
	const text = simplifyExtensionStatusText(status.text);
	const color = extensionColor(key, value);
	const textColor = color === "warning" ? "warning" : "muted";
	const icon = extensionStatusIcon(
		key,
		status.icon,
		config.extensionStatusIcons,
		extensionStatusIconAliases,
	);
	const renderedText = theme.fg(textColor, text);
	return icon ? `${theme.fg(color, icon)} ${renderedText}` : renderedText;
}

function extensionStatusIcon(
	key: string,
	leadingIcon: string | undefined,
	configuredIcons: Record<string, string>,
	extensionStatusIconAliases: ExtensionStatusIconAliasMap,
) {
	if (Object.hasOwn(configuredIcons, key)) return configuredIcons[key];
	const namespaceIcon = configuredNamespaceIcon(key, configuredIcons);
	if (namespaceIcon !== undefined) return namespaceIcon;
	const compatibleKey = COMPATIBLE_STATUS_ICON_KEYS[key];
	if (compatibleKey && Object.hasOwn(configuredIcons, compatibleKey)) {
		return configuredIcons[compatibleKey];
	}
	for (const alias of extensionStatusAliasesForKey(key, extensionStatusIconAliases)) {
		if (Object.hasOwn(configuredIcons, alias)) return configuredIcons[alias];
	}
	return leadingIcon ?? DEFAULT_EXTENSION_STATUS_ICONS[key] ?? "🔌";
}

function configuredNamespaceIcon(
	key: string,
	configuredIcons: Readonly<Record<string, string>>,
): string | undefined {
	let match: { baseLength: number; icon: string } | undefined;
	for (const [selector, icon] of Object.entries(configuredIcons)) {
		if (!selector.endsWith(":*")) continue;
		const base = selector.slice(0, -2);
		if (!base || !key.startsWith(`${base}:`)) continue;
		if (!match || base.length > match.baseLength) match = { baseLength: base.length, icon };
	}
	return match?.icon;
}

function extensionStatusAliasesForKey(
	key: string,
	extensionStatusIconAliases: ExtensionStatusIconAliasMap,
): readonly string[] {
	for (const [statusBase, aliases] of extensionStatusIconAliases) {
		if (statusKeyMatchesStatusBase(key, statusBase)) return aliases;
	}
	return [];
}

function statusKeyMatchesStatusBase(key: string, statusBase: string): boolean {
	return key === statusBase || key.startsWith(`${statusBase}:`) || key.startsWith(`${statusBase}/`);
}

const WATCHER_LABEL_STATE_PATTERN = new RegExp(
	`\\b([A-Z][A-Z0-9-]{0,15}:) (${[...WATCHER_STATES, "unavailable", "conflict"].join("|")})(?=\\s|$)`,
	"gu",
);

export function wrapExtensionStatusline(status: string, width: number): string[] {
	if (!status || width <= 0) return [];
	const marker = unusedPrivateUseMarker(status);
	const protectedStatus = status.replace(WATCHER_LABEL_STATE_PATTERN, `$1${marker}$2`);
	return wrapTextWithAnsi(protectedStatus, width).map((line) => line.replaceAll(marker, " "));
}

function unusedPrivateUseMarker(value: string): string {
	for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint += 1) {
		const marker = String.fromCodePoint(codePoint);
		if (!value.includes(marker)) return marker;
	}
	return "\u{f0000}";
}

function formatDuplicateExtensionStatus(runtime: ExtensionStatusRuntime, theme: Theme): string[] {
	if (runtime.duplicateExtensions.length === 0) return [];
	const names = runtime.duplicateExtensions.slice(0, 2).join(", ");
	const suffix =
		runtime.duplicateExtensions.length > 2 ? ` +${runtime.duplicateExtensions.length - 2}` : "";
	return [`${theme.fg("warning", "⚠️")} ${theme.fg("warning", `dup ${names}${suffix}`)}`];
}

export function splitExtensionStatusIcon(value: string): { icon?: string; text: string } {
	const trimmed = value.trim();
	const [firstToken, ...restTokens] = trimmed.split(/\s+/);
	if (firstToken && isEmojiOnlyToken(firstToken)) {
		return { icon: firstToken, text: restTokens.join(" ") };
	}
	return { text: trimmed };
}

function isEmojiOnlyToken(value: string): boolean {
	return /^(?=.*(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\ufe0f?\u20e3))(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f|[0-9#*]\ufe0f?\u20e3)+$/u.test(
		value,
	);
}

export function extensionColor(key: string, value: string): ThemeColor {
	const normalized = `${key} ${value}`.toLowerCase();
	if (/missing|error|fail|conflict|duplicate|unavailable/.test(normalized)) return "warning";
	if (normalized.includes("codex")) return "accent";
	if (/ready|active|running|enabled|awake|ok/.test(normalized)) return "success";
	return "muted";
}

export function stripExtensionStatusPrefix(key: string, value: string): string {
	return value.trim().replace(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*`, "iu"), "");
}

export function simplifyExtensionStatusText(value: string): string {
	return value
		.trim()
		.replace(/\bready\b/giu, "✓")
		.replace(/\bmissing\b/giu, "✗")
		.replace(/,\s*/g, " ")
		.replace(/\s+\([^)]*\)\s*$/, "")
		.replace(/\s+/g, " ");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function readInstalledExtensionPackages(cwd: string): InstalledExtensionPackage[] {
	const packages: InstalledExtensionPackage[] = [];
	const settingsFiles = extensionSettingsFiles(cwd);

	for (const settingsFile of settingsFiles) {
		const baseDirectory = dirname(settingsFile);
		for (const rawSource of readPackageSources(settingsFile)) {
			const source = rawSource.trim();
			if (!source) continue;
			const packageName = packageNameForSource(source, baseDirectory);
			if (!packageName) continue;
			packages.push({ packageName, source, identity: sourceIdentity(source, baseDirectory) });
		}
	}

	return packages;
}

function extensionSettingsFiles(cwd: string): string[] {
	return [join(getAgentDir(), "settings.json"), join(cwd, ".pi", "settings.json")].filter((file) =>
		existsSync(file),
	);
}

export function findDuplicateExtensions(
	installedPackages: readonly InstalledExtensionPackage[],
): string[] {
	const sourcesByPackage = new Map<string, Set<string>>();

	for (const extensionPackage of installedPackages) {
		const sources = sourcesByPackage.get(extensionPackage.packageName) ?? new Set<string>();
		sources.add(extensionPackage.identity);
		sourcesByPackage.set(extensionPackage.packageName, sources);
	}

	return [...sourcesByPackage.entries()]
		.filter(([, sources]) => sources.size > 1)
		.map(([packageName]) => packageName.replace(/^@[^/]+\//, "").replace(/^pi-/, ""));
}

export function buildExtensionStatusIconAliases(
	installedPackages: readonly { packageName: string; source?: string }[],
): Map<string, string[]> {
	const packageAliasesByStatusBase = new Map<string, Map<string, string[]>>();

	for (const extensionPackage of installedPackages) {
		const candidate = extensionStatusIconAliasCandidate(
			extensionPackage.packageName,
			extensionPackage.source,
		);
		if (!candidate) continue;
		const aliasesByPackage =
			packageAliasesByStatusBase.get(candidate.statusBase) ?? new Map<string, string[]>();
		const existingAliases = aliasesByPackage.get(extensionPackage.packageName) ?? [];
		aliasesByPackage.set(
			extensionPackage.packageName,
			uniqueStrings([...existingAliases, ...candidate.aliases]),
		);
		packageAliasesByStatusBase.set(candidate.statusBase, aliasesByPackage);
	}

	const aliases = new Map<string, string[]>();
	for (const [statusBase, aliasesByPackage] of packageAliasesByStatusBase) {
		if (aliasesByPackage.size === 1)
			aliases.set(statusBase, [...aliasesByPackage.values()][0] ?? []);
	}
	return aliases;
}

function extensionStatusIconAliasCandidate(
	packageName: string,
	source?: string,
): { statusBase: string; aliases: string[] } | undefined {
	const packageBase = packageBaseName(packageName);
	const statusBase = statusBaseFromPackageBase(packageBase);
	if (!statusBase) return undefined;

	const sourceAliases = source?.startsWith("npm:") ? [source, `npm:${npmPackageName(source)}`] : [];
	return {
		statusBase,
		aliases: uniqueStrings([...sourceAliases, packageName, packageBase, statusBase]),
	};
}

function packageBaseName(packageName: string): string {
	const slashIndex = packageName.lastIndexOf("/");
	return slashIndex === -1 ? packageName : packageName.slice(slashIndex + 1);
}

function statusBaseFromPackageBase(packageBase: string): string {
	return packageBase.startsWith("pi-") && packageBase.length > "pi-".length
		? packageBase.slice("pi-".length)
		: packageBase;
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values.filter((value) => value.length > 0))];
}

function readPackageSources(settingsFile: string): string[] {
	try {
		const settings = JSON.parse(readFileSync(settingsFile, "utf8")) as { packages?: unknown[] };
		return (settings.packages ?? [])
			.map((entry) => {
				if (typeof entry === "string") return entry;
				if (
					entry &&
					typeof entry === "object" &&
					typeof (entry as { source?: unknown }).source === "string"
				) {
					return (entry as { source: string }).source;
				}
				return undefined;
			})
			.filter((source): source is string => source !== undefined);
	} catch {
		return [];
	}
}

function packageNameForSource(source: string, baseDirectory: string): string | undefined {
	if (source.startsWith("npm:")) return npmPackageName(source);
	const gitRepository = gitRepositoryName(source);
	if (gitRepository && Object.hasOwn(WATCHER_GIT_PACKAGE_NAMES, gitRepository)) {
		return WATCHER_GIT_PACKAGE_NAMES[gitRepository];
	}
	const packageJson = join(resolveSourcePath(source, baseDirectory), "package.json");
	try {
		const packageData = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: unknown };
		return typeof packageData.name === "string" ? packageData.name : undefined;
	} catch {
		return undefined;
	}
}

export function npmPackageName(source: string): string {
	const spec = source.slice("npm:".length);
	if (spec.startsWith("@")) return spec.split("@").slice(0, 2).join("@");
	return spec.split("@")[0] ?? spec;
}

function sourceIdentity(source: string, baseDirectory: string): string {
	if (source.startsWith("npm:")) return `npm:${npmPackageName(source)}`;
	const gitRepository = gitRepositoryPath(source);
	if (gitRepository) return `git:${gitRepository}`;
	return resolveSourcePath(source, baseDirectory);
}

function gitRepositoryName(source: string): string | undefined {
	return gitRepositoryPath(source)?.split("/").at(-1);
}

function gitRepositoryPath(source: string): string | undefined {
	const normalized = source
		.replace(/^git:/u, "")
		.replace(/^git\+https?:\/\//u, "")
		.replace(/^git\+ssh:\/\/git@/u, "")
		.replace(/^https?:\/\//u, "")
		.replace(/^git@([^:]+):/u, "$1/");
	const match = /^(?:www\.)?github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:[@#].*)?$/u.exec(
		normalized,
	);
	return match ? `${match[1]}/${match[2]}` : undefined;
}

function resolveSourcePath(source: string, baseDirectory: string): string {
	return isAbsolute(source) ? source : resolve(baseDirectory, source);
}
