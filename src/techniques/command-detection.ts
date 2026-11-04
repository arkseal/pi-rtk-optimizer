import { advanceQuoteEscapeState, type QuoteEscapeState } from "../shell-quote-state.js";

const SINGLE_QUOTED = "'(?:'\\\\''|[^'])*'";
const DOUBLE_QUOTED = '"(?:\\\\.|[^"])*"';
const SHELL_VALUE = `(?:${DOUBLE_QUOTED}|${SINGLE_QUOTED}|[^\\s;&|]+)`;
const LEADING_ENV_PREFIX_PATTERN = new RegExp(
	`^(?:(?:export\\s+)?[A-Za-z_][A-Za-z0-9_]*=${SHELL_VALUE}\\s*)+`,
);
const RTK_BINARY_PREFIX_PATTERN = /^(?:(?:\S*[/\\])?rtk(?:\.exe)?)\s+/i;
const CD_COMMAND_PATTERN = /^(?:cd|pushd)\b/i;
const EXPORT_ONLY_PATTERN = new RegExp(
	`^(?:export\\s+[A-Za-z_][A-Za-z0-9_]*=${SHELL_VALUE}\\s*)+$`,
);

function splitTopLevelSegments(command: string): string[] {
	const segments: string[] = [];
	const state: QuoteEscapeState = { quote: null, escaped: false };
	let start = 0;

	for (let i = 0; i < command.length; i++) {
		const char = command[i] ?? "";
		const next = command[i + 1] ?? "";

		if (advanceQuoteEscapeState(state, char, "\"'`")) {
			continue;
		}

		if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
			segments.push(command.slice(start, i));
			start = i + 2;
			i += 1;
			continue;
		}

		if (char === ";" || (char === "|" && next !== ">")) {
			const len = char === "|" && next === "&" ? 2 : 1;
			segments.push(command.slice(start, i));
			start = i + len;
			if (len === 2) i += 1;
			continue;
		}
	}

	segments.push(command.slice(start));
	return segments;
}

function cleanSegment(segment: string): string {
	let trimmed = segment.trim();
	if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
		trimmed = trimmed.slice(1, -1).trim();
	}
	trimmed = trimmed.replace(LEADING_ENV_PREFIX_PATTERN, "").trim();
	trimmed = trimmed.replace(RTK_BINARY_PREFIX_PATTERN, "").trim();
	return trimmed;
}

export function extractAllCommandSegments(command: string | undefined | null): string[] {
	if (typeof command !== "string" || !command.trim()) {
		return [];
	}

	const lines = command
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const lineToProcess = lines[0] ?? "";
	if (!lineToProcess) {
		return [];
	}

	const rawSegments = splitTopLevelSegments(lineToProcess);
	const cleaned: string[] = [];

	for (const raw of rawSegments) {
		const trimmedRaw = raw.trim();
		if (!trimmedRaw || EXPORT_ONLY_PATTERN.test(trimmedRaw)) {
			continue;
		}
		const c = cleanSegment(raw);
		if (c) {
			cleaned.push(c.toLowerCase());
		}
	}

	return cleaned;
}

export function normalizeCommandForDetection(command: string | undefined | null): string | null {
	const segments = extractAllCommandSegments(command);
	if (segments.length === 0) {
		return null;
	}

	if (segments.length > 1 && CD_COMMAND_PATTERN.test(segments[0] ?? "")) {
		for (let i = 1; i < segments.length; i++) {
			const seg = segments[i];
			if (seg && !CD_COMMAND_PATTERN.test(seg)) {
				return seg;
			}
		}
	}

	return segments[0] ?? null;
}

export function matchesCommandPatterns(
	command: string | undefined | null,
	patterns: readonly RegExp[],
): boolean {
	const segments = extractAllCommandSegments(command);
	if (segments.length === 0) {
		return false;
	}

	for (const seg of segments) {
		if (patterns.some((pattern) => pattern.test(seg))) {
			return true;
		}
	}

	return false;
}
