import { matchesCommandPatterns } from "./command-detection.js";

interface TestSummary {
	passed: number;
	failed: number;
	skipped: number;
	failures: string[];
}

const TEST_COMMAND_PATTERNS = [
	/^npm\s+test\b/,
	/^pnpm\s+test\b/,
	/^yarn\s+test\b/,
	/^bun\s+test\b/,
	/^cargo\s+test\b/,
	/^go\s+test\b/,
	/^pytest\b/,
	/^python\s+-m\s+pytest\b/,
	/^(?:pnpm\s+)?(?:npx\s+)?vitest\b/,
	/^(?:npx\s+)?jest\b/,
	/^mocha\b/,
	/^ava\b/,
	/^tap\b/,
] as const;

const TEST_RESULT_PATTERNS = [
	/test result:\s*(\w+)\.\s*(\d+)\s*passed;\s*(\d+)\s*failed;/,
	/(\d+)\s*passed(?:,\s*(\d+)\s*failed)?(?:,\s*(\d+)\s*skipped)?/i,
	/(\d+)\s*pass(?:,\s*(\d+)\s*fail)?(?:,\s*(\d+)\s*skip)?/i,
	/tests?:\s*(\d+)\s*passed(?:,\s*(\d+)\s*failed)?(?:,\s*(\d+)\s*skipped)?/i,
];

const FAILURE_START_PATTERNS = [
	/^FAIL\s+/,
	/^FAILED\s+/,
	/^\s*●\s+/,
	/^\s*✕\s+/,
	/test\s+\w+\s+\.\.\.\s*FAILED/,
	/thread\s+'\w+'\s+panicked/,
];
const FALLBACK_PASS_PATTERN = /(?:\b(?:ok|PASS)\b|[✓✔])/;
const FALLBACK_FAIL_PATTERN = /(?:\b(?:FAIL|fail)\b|[✗✕])/;

function isFailureStart(line: string): boolean {
	return FAILURE_START_PATTERNS.some((pattern) => pattern.test(line));
}

function extractTestStats(output: string): Partial<TestSummary> {
	// Check Cargo test format: test result: ok. 10 passed; 0 failed; ...
	const cargoMatch = output.match(/test result:\s*(\w+)\.\s*(\d+)\s*passed;\s*(\d+)\s*failed;/i);
	if (cargoMatch) {
		return {
			passed: Number.parseInt(cargoMatch[2] ?? "0", 10) || 0,
			failed: Number.parseInt(cargoMatch[3] ?? "0", 10) || 0,
		};
	}

	// Look for summary lines in test runner output (Vitest, Jest, Pytest, Go, etc.)
	// Examples:
	// "Tests  1 failed | 5 passed (6)"
	// "1 failed, 5 passed, 2 skipped"
	// "Tests: 1 failed, 5 passed, 6 total"
	const lines = output.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i] ?? "";
		if (!/(?:tests?|test files?|passed|failed|skipped)/i.test(line)) {
			continue;
		}

		const failedMatch = line.match(/(\d+)\s*fail(?:ed)?\b/i);
		const passedMatch = line.match(/(\d+)\s*pass(?:ed)?\b/i);
		const skippedMatch = line.match(/(\d+)\s*skip(?:ped)?\b/i);

		if (failedMatch || passedMatch || skippedMatch) {
			return {
				passed: passedMatch ? Number.parseInt(passedMatch[1] ?? "0", 10) : undefined,
				failed: failedMatch ? Number.parseInt(failedMatch[1] ?? "0", 10) : undefined,
				skipped: skippedMatch ? Number.parseInt(skippedMatch[1] ?? "0", 10) : undefined,
			};
		}
	}

	return {};
}

export function isTestCommand(command: string | undefined | null): boolean {
	return matchesCommandPatterns(command, TEST_COMMAND_PATTERNS);
}

export function aggregateTestOutput(output: string, command: string | undefined | null): string | null {
	if (!isTestCommand(command)) {
		return null;
	}

	const lines = output.split("\n");
	const summary: TestSummary = {
		passed: 0,
		failed: 0,
		skipped: 0,
		failures: [],
	};

	const stats = extractTestStats(output);
	summary.passed = stats.passed ?? 0;
	summary.failed = stats.failed ?? 0;
	summary.skipped = stats.skipped ?? 0;

	if (summary.passed === 0 && summary.failed === 0) {
		for (const line of lines) {
			if (FALLBACK_PASS_PATTERN.test(line)) {
				summary.passed++;
			}
			if (FALLBACK_FAIL_PATTERN.test(line)) {
				summary.failed++;
			}
		}
	}

	// Always extract failure blocks so errors are never masked even if summary parsing missed
	let inFailure = false;
	let currentFailure: string[] = [];
	let blankCount = 0;

	for (const line of lines) {
		if (isFailureStart(line)) {
			if (inFailure && currentFailure.length > 0) {
				summary.failures.push(currentFailure.join("\n"));
			}
			inFailure = true;
			currentFailure = [line];
			blankCount = 0;
			continue;
		}

		if (!inFailure) {
			continue;
		}

		if (line.trim() === "") {
			blankCount++;
			if (blankCount >= 2 && currentFailure.length > 3) {
				summary.failures.push(currentFailure.join("\n"));
				inFailure = false;
				currentFailure = [];
			} else {
				currentFailure.push(line);
			}
			continue;
		}

		if (line.match(/^\s/) || line.match(/^-/)) {
			currentFailure.push(line);
			blankCount = 0;
			continue;
		}

		summary.failures.push(currentFailure.join("\n"));
		inFailure = false;
		currentFailure = [];
	}

	if (inFailure && currentFailure.length > 0) {
		summary.failures.push(currentFailure.join("\n"));
	}

	if (summary.failures.length > 0 && summary.failed === 0) {
		summary.failed = summary.failures.length;
	}

	// If no test summary or failures could be recognized, do not falsely claim success or invent a 0/0 pass
	if (
		summary.passed === 0 &&
		summary.failed === 0 &&
		summary.skipped === 0 &&
		summary.failures.length === 0
	) {
		return null;
	}

	const result: string[] = ["Test Results:"];
	result.push(`   PASS: ${summary.passed} passed`);
	if (summary.failed > 0) {
		result.push(`   FAIL: ${summary.failed} failed`);
	}
	if (summary.skipped > 0) {
		result.push(`   SKIP: ${summary.skipped} skipped`);
	}

	if (summary.failed > 0 && summary.failures.length > 0) {
		result.push("\n   Failures:");
		for (const failure of summary.failures.slice(0, 5)) {
			const failureLines = failure.split("\n");
			const firstLine = failureLines[0] ?? "";
			result.push(`   - ${firstLine.slice(0, 70)}${firstLine.length > 70 ? "..." : ""}`);
			for (const detailLine of failureLines.slice(1, 4)) {
				if (detailLine.trim()) {
					result.push(`     ${detailLine.slice(0, 65)}${detailLine.length > 65 ? "..." : ""}`);
				}
			}
			if (failureLines.length > 4) {
				result.push(`     ... (${failureLines.length - 4} more lines)`);
			}
		}
		if (summary.failures.length > 5) {
			result.push(`   ... and ${summary.failures.length - 5} more failures`);
		}
	}

	return result.join("\n");
}
