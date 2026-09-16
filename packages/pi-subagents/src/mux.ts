export {
	exitStatusVar,
	getMuxBackend,
	isCmuxAvailable,
	isFishShell,
	isHerdrAvailable,
	isMuxAvailable,
	isTmuxAvailable,
	isZellijAvailable,
	muxSetupHint,
	shellEscape,
} from "./mux/core.js";
export { resolveHerdrPlacementPolicy } from "./mux/herdr-surfaces.js";
export {
	closeSurface,
	readScreen,
	readScreenAsync,
	sendCommand,
	sendShellCommand,
} from "./mux/io.js";
export { consumeSubagentExitSignal, pollForExit } from "./mux/poll.js";
export {
	createSurface,
	createSurfaceSplit,
	renameCurrentTab,
	renameWorkspace,
} from "./mux/surfaces.js";
export { resolveZellijPlacementPolicy } from "./mux/zellij-placement.js";
