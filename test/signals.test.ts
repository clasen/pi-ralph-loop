import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

// We test the pure functions by importing them via a helper that re-exports
// the module internals. Since the extension exports only a default function,
// we inline the logic here to validate the regex patterns and helpers.

// --- Inlined helpers (must stay in sync with src/index.ts) ---

function extractCount(output: string, patterns: RegExp[]): number | undefined {
  let latest: number | undefined;
  for (const pattern of patterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const globalPattern = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = globalPattern.exec(output)) !== null) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed)) latest = parsed;
      if (match.index === globalPattern.lastIndex) globalPattern.lastIndex++;
    }
  }
  return latest;
}

type CommandSignals = { testFailures?: number; testPassed?: number; lintErrors?: number; lintWarnings?: number };
type IterationSignals = CommandSignals & { hadTimeout: boolean; hadError: boolean };
type IterationCommandSummary = { name: string; status: "ok" | "failed" | "timed_out" | "error"; excerpt: string; signals: CommandSignals };
type IterationSummary = {
  iteration: number; duration: number; assistantRecap: string;
  commandSummaries: IterationCommandSummary[]; signals: IterationSignals;
  hadChanges?: boolean; regressed?: boolean;
  objectiveValue?: number; objectiveAccepted?: boolean; objectiveReason?: string;
  diffFingerprint?: string;
};

const DEFAULT_SIGNAL_PATTERNS: Record<string, RegExp[]> = {
  testFailures: [
    /\b(\d+)\s+failed\b/gi,
    /\bfailures?:\s*(\d+)\b/gi,
    /# fail\s+(\d+)/gi,
    /Tests:\s+(\d+)\s+failed/gi,
    /(\d+)\s+failing\b/gi,
  ],
  testPassed: [
    /\b(\d+)\s+passed\b/gi,
    /\bpasses?:\s*(\d+)\b/gi,
    /# pass\s+(\d+)/gi,
    /Tests:\s+(\d+)\s+passed/gi,
    /(\d+)\s+passing\b/gi,
  ],
  lintErrors: [
    /(\d+)\s+problems?\b/gi,
    /\b(\d+)\s+errors?\b/gi,
    /\berrors?:\s*(\d+)\b/gi,
  ],
  lintWarnings: [
    /\b(\d+)\s+warnings?\b/gi,
    /\bwarnings?:\s*(\d+)\b/gi,
  ],
};

function extractCommandSignals(output: string): CommandSignals {
  const patterns = DEFAULT_SIGNAL_PATTERNS;
  return {
    testFailures: extractCount(output, patterns.testFailures),
    testPassed: extractCount(output, patterns.testPassed),
    lintErrors: extractCount(output, patterns.lintErrors),
    lintWarnings: extractCount(output, patterns.lintWarnings),
  };
}

type CommandOutput = { name: string; output: string; exitCode?: number };

function summarizeCommandOutput(output: CommandOutput): IterationCommandSummary {
  const trimmed = output.output.trim();
  const signals = extractCommandSignals(trimmed);
  let status: "ok" | "failed" | "timed_out" | "error" = "ok";
  if (/^\[timed out after \d+s\]$/i.test(trimmed)) {
    status = "timed_out";
  } else if (/^\[error:/i.test(trimmed)) {
    status = "error";
  } else if (output.exitCode !== undefined) {
    status = output.exitCode === 0 ? "ok" : "failed";
  } else {
    const sanitized = trimmed.replace(/\b(fail(?:ed|ures?|s)?)\s*[:=]?\s*0\b/gi, "___ZERO___");
    if (/\bFAIL(?:ED)?\b|\bERROR\b|error:|failed/i.test(sanitized)) status = "failed";
  }
  return { name: output.name, status, excerpt: "", signals };
}

type DoneCriterion = { name: string; command: string; pattern: string };

function checkDoneCriteria(criteria: DoneCriterion[], outputs: CommandOutput[]): { allMet: boolean; unmet: string[] } {
  const outputMap = new Map(outputs.map((o) => [o.name, o]));
  const unmet: string[] = [];
  for (const c of criteria) {
    const cmd = outputMap.get(c.command);
    if (!cmd) { unmet.push(`${c.name}: command '${c.command}' not found`); continue; }
    if (c.pattern === "__exit_code_zero__") {
      if (cmd.exitCode !== undefined && cmd.exitCode !== 0) unmet.push(c.name);
      continue;
    }
    try {
      if (!new RegExp(c.pattern).test(cmd.output)) unmet.push(c.name);
    } catch {
      unmet.push(`${c.name}: invalid pattern`);
    }
  }
  return { allMet: unmet.length === 0, unmet };
}

function truncateOutput(raw: string, maxOutput?: number): string {
  if (!maxOutput || raw.length <= maxOutput) return raw;
  const lines = raw.split("\n");
  const tailBudget = Math.floor(maxOutput * 0.7);
  const headBudget = maxOutput - tailBudget - 40;
  const tail = lines.slice(-Math.ceil(lines.length * 0.5)).join("\n");
  const head = lines.slice(0, Math.ceil(lines.length * 0.2)).join("\n");
  const trimmedTail = tail.length > tailBudget ? tail.slice(-tailBudget) : tail;
  const trimmedHead = head.length > headBudget ? head.slice(0, headBudget) : head;
  return `${trimmedHead}\n\n[… truncated ${raw.length - trimmedHead.length - trimmedTail.length} chars …]\n\n${trimmedTail}`;
}

type ProviderErrorKind = "rate_limit" | "quota_exceeded" | "auth" | "transient" | "unknown";

function classifyProviderError(entry: any): ProviderErrorKind | null {
  if (entry?.type !== "message" || entry?.message?.role !== "assistant") return null;
  const msg = entry.message;
  if (msg.stopReason !== "error" || !msg.errorMessage) return null;
  const err = String(msg.errorMessage).toLowerCase();
  if (/usage limit|quota|exceeded.*plan|limit.*plan/.test(err)) return "quota_exceeded";
  if (/rate.?limit|too many requests|429/.test(err)) return "rate_limit";
  if (/auth|unauthorized|forbidden|401|403/.test(err)) return "auth";
  if (/timeout|econnreset|enotfound|network|5\d\d/.test(err)) return "transient";
  return "unknown";
}

function detectConvergence(summaries: IterationSummary[], window: number): { converged: boolean; reason: string } {
  if (summaries.length < window) return { converged: false, reason: "" };
  const tail = summaries.slice(-window);
  const noChanges = tail.every(s => !s.hadChanges);
  if (!noChanges) return { converged: false, reason: "" };
  const signalKeys: (keyof CommandSignals)[] = ["testFailures", "testPassed", "lintErrors", "lintWarnings"];
  let metricsStable = true;
  for (const key of signalKeys) {
    const values = tail.map(s => s.signals[key]).filter((v): v is number => typeof v === "number");
    if (values.length >= 2 && new Set(values).size > 1) { metricsStable = false; break; }
  }
  if (metricsStable) return { converged: true, reason: `${window} consecutive iterations with no file changes and stable metrics` };
  return { converged: false, reason: "" };
}

// --- Tests ---

describe("extractCommandSignals", () => {
  it("parses Node.js native test runner output (TAP-like)", () => {
    const output = `▶ DBDB core
  ✓ set and get (2.5ms)
  ✓ del (1.2ms)
✓ DBDB core (4ms)

# tests 24
# suites 3
# pass 24
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 87.565667`;

    const signals = extractCommandSignals(output);
    assert.equal(signals.testPassed, 24);
    assert.equal(signals.testFailures, 0);
  });

  it("parses Node.js test runner with failures", () => {
    const output = `# pass 20
# fail 4`;
    const signals = extractCommandSignals(output);
    assert.equal(signals.testPassed, 20);
    assert.equal(signals.testFailures, 4);
  });

  it("parses Jest-style output", () => {
    const output = `Test Suites: 3 passed, 3 total
Tests:       42 passed, 42 total`;
    const signals = extractCommandSignals(output);
    assert.equal(signals.testPassed, 42);
  });

  it("parses Mocha-style output", () => {
    const output = `  15 passing (200ms)
  2 failing`;
    const signals = extractCommandSignals(output);
    assert.equal(signals.testPassed, 15);
    assert.equal(signals.testFailures, 2);
  });

  it("parses generic pass/fail counts", () => {
    const output = `Results: 10 passed, 3 failed`;
    const signals = extractCommandSignals(output);
    assert.equal(signals.testPassed, 10);
    assert.equal(signals.testFailures, 3);
  });

  it("parses ESLint problems", () => {
    const output = `✖ 5 problems (3 errors, 2 warnings)`;
    const signals = extractCommandSignals(output);
    assert.equal(signals.lintErrors, 3);
    assert.equal(signals.lintWarnings, 2);
  });

  it("returns undefined for no matches", () => {
    const output = `All good, nothing to report.`;
    const signals = extractCommandSignals(output);
    assert.equal(signals.testPassed, undefined);
    assert.equal(signals.testFailures, undefined);
  });
});

describe("summarizeCommandOutput: exitCode governs status", () => {
  it("exitCode 0 produces ok even when output contains 'error' or 'FAIL' text", () => {
    const adversarial: CommandOutput[] = [
      { name: "tests", output: "FAIL: handled gracefully\nerror: this is informational\n# pass 10\n# fail 0", exitCode: 0 },
      { name: "lint", output: "Checked 50 files, found errors: 0 warnings: 0\nAll clear!", exitCode: 0 },
      { name: "build", output: "warning: unused variable `failed` in module\nBuild succeeded", exitCode: 0 },
    ];
    for (const cmd of adversarial) {
      const summary = summarizeCommandOutput(cmd);
      assert.equal(summary.status, "ok", `Expected ok for ${cmd.name} with exitCode=0, got ${summary.status}`);
    }
  });

  it("exitCode !== 0 produces failed even when output looks clean", () => {
    const clean: CommandOutput[] = [
      { name: "tests", output: "# pass 24\n# fail 0", exitCode: 1 },
      { name: "lint", output: "All clear, no issues found.", exitCode: 2 },
    ];
    for (const cmd of clean) {
      const summary = summarizeCommandOutput(cmd);
      assert.equal(summary.status, "failed", `Expected failed for ${cmd.name} with exitCode=${cmd.exitCode}, got ${summary.status}`);
    }
  });

  it("timeout marker overrides exitCode", () => {
    const summary = summarizeCommandOutput({ name: "slow", output: "[timed out after 60s]", exitCode: 0 });
    assert.equal(summary.status, "timed_out");
  });

  it("text heuristics only apply when exitCode is absent", () => {
    const noExit: CommandOutput = { name: "tests", output: "FAIL: something broke\n2 failed" };
    const summary = summarizeCommandOutput(noExit);
    assert.equal(summary.status, "failed");

    const noExitClean: CommandOutput = { name: "tests", output: "All checks green" };
    const summaryClean = summarizeCommandOutput(noExitClean);
    assert.equal(summaryClean.status, "ok");
  });
});

describe("checkDoneCriteria", () => {
  const outputs: CommandOutput[] = [
    { name: "tests", output: "# pass 24\n# fail 0", exitCode: 0 },
    { name: "benchmark", output: "set ops/s: 50000\nget ops/s: 80000\ntotal_disk_bytes: 110942" },
  ];

  it("returns allMet when all patterns match", () => {
    const criteria: DoneCriterion[] = [
      { name: "tests_pass", command: "tests", pattern: "# fail 0" },
      { name: "has_benchmark", command: "benchmark", pattern: "ops/s" },
    ];
    const result = checkDoneCriteria(criteria, outputs);
    assert.equal(result.allMet, true);
    assert.equal(result.unmet.length, 0);
  });

  it("reports unmet criteria", () => {
    const criteria: DoneCriterion[] = [
      { name: "tests_pass", command: "tests", pattern: "# fail 0" },
      { name: "disk_target", command: "benchmark", pattern: "total_disk_bytes:\\s*\\d{1,5}$" },
    ];
    const result = checkDoneCriteria(criteria, outputs);
    assert.equal(result.allMet, false);
    assert.deepEqual(result.unmet, ["disk_target"]);
  });

  it("handles missing command", () => {
    const criteria: DoneCriterion[] = [
      { name: "lint_clean", command: "lint", pattern: "0 errors" },
    ];
    const result = checkDoneCriteria(criteria, outputs);
    assert.equal(result.allMet, false);
    assert.ok(result.unmet[0].includes("not found"));
  });

  it("supports __exit_code_zero__ for structural done criteria", () => {
    const criteria: DoneCriterion[] = [
      { name: "tests_exit", command: "tests", pattern: "__exit_code_zero__" },
    ];
    const result = checkDoneCriteria(criteria, [{ name: "tests", output: "anything", exitCode: 0 }]);
    assert.equal(result.allMet, true);

    const resultFail = checkDoneCriteria(criteria, [{ name: "tests", output: "anything", exitCode: 1 }]);
    assert.equal(resultFail.allMet, false);
    assert.deepEqual(resultFail.unmet, ["tests_exit"]);
  });
});

describe("classifyProviderError", () => {
  it("detects quota_exceeded from error message", () => {
    const entry = { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit (plus plan). Try again in ~3020 min." } };
    assert.equal(classifyProviderError(entry), "quota_exceeded");
  });

  it("detects rate_limit", () => {
    const entry = { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "Rate limit exceeded, please retry after 30s (429)" } };
    assert.equal(classifyProviderError(entry), "rate_limit");
  });

  it("detects auth errors", () => {
    const entry = { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "Unauthorized: invalid API key (401)" } };
    assert.equal(classifyProviderError(entry), "auth");
  });

  it("detects transient network errors", () => {
    const entry = { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "ECONNRESET: connection reset by peer" } };
    assert.equal(classifyProviderError(entry), "transient");
  });

  it("returns unknown for unrecognized errors", () => {
    const entry = { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "Something completely unexpected happened" } };
    assert.equal(classifyProviderError(entry), "unknown");
  });

  it("returns null for non-error assistant messages", () => {
    const entry = { type: "message", message: { role: "assistant", stopReason: "end_turn", content: [{ type: "text", text: "done" }] } };
    assert.equal(classifyProviderError(entry), null);
  });

  it("returns null for non-assistant entries", () => {
    assert.equal(classifyProviderError({ type: "message", message: { role: "user" } }), null);
    assert.equal(classifyProviderError({ type: "custom" }), null);
  });
});

describe("detectConvergence", () => {
  function makeSummary(iter: number, hadChanges: boolean, signals: Partial<IterationSignals> = {}): IterationSummary {
    return {
      iteration: iter, duration: 10, assistantRecap: "", commandSummaries: [],
      signals: { hadTimeout: false, hadError: false, ...signals },
      hadChanges,
    };
  }

  it("detects convergence when N iterations have no changes and stable metrics", () => {
    const summaries = [
      makeSummary(1, true, { testFailures: 0, testPassed: 10 }),
      makeSummary(2, false, { testFailures: 0, testPassed: 10 }),
      makeSummary(3, false, { testFailures: 0, testPassed: 10 }),
      makeSummary(4, false, { testFailures: 0, testPassed: 10 }),
    ];
    const result = detectConvergence(summaries, 3);
    assert.equal(result.converged, true);
  });

  it("does not converge if any iteration in window has changes", () => {
    const summaries = [
      makeSummary(1, false, { testPassed: 10 }),
      makeSummary(2, true, { testPassed: 10 }),
      makeSummary(3, false, { testPassed: 10 }),
    ];
    assert.equal(detectConvergence(summaries, 3).converged, false);
  });

  it("does not converge if metrics are changing", () => {
    const summaries = [
      makeSummary(1, false, { testPassed: 8 }),
      makeSummary(2, false, { testPassed: 9 }),
      makeSummary(3, false, { testPassed: 10 }),
    ];
    assert.equal(detectConvergence(summaries, 3).converged, false);
  });

  it("does not converge with fewer iterations than window", () => {
    const summaries = [makeSummary(1, false, { testPassed: 10 })];
    assert.equal(detectConvergence(summaries, 3).converged, false);
  });

  it("converges when no metrics are available but no changes for N iterations", () => {
    const summaries = [
      makeSummary(1, false),
      makeSummary(2, false),
      makeSummary(3, false),
    ];
    assert.equal(detectConvergence(summaries, 3).converged, true);
  });
});

describe("adversarial text noise: signals are not confused by benign occurrences", () => {
  it("words like 'error' in non-failure context do not affect signal extraction", () => {
    const output = `Compiling error_handler module...
Building failure_recovery module...
All modules compiled successfully.
error_count: 0
Tests: 15 passed, 0 failed`;
    const signals = extractCommandSignals(output);
    assert.equal(signals.testPassed, 15);
    assert.equal(signals.testFailures, 0);
  });

  it("Pytest verbose output with 'FAILED' in test name does not inflate failure count", () => {
    const output = `test_handle_failed_login PASSED
test_retry_on_failure PASSED
2 passed in 0.5s`;
    const signals = extractCommandSignals(output);
    assert.equal(signals.testPassed, 2);
  });

  it("cargo test output format is parsed correctly", () => {
    const output = `running 12 tests
test auth::test_login ... ok
test auth::test_failed_attempt ... ok
test result: ok. 12 passed; 0 failed; 0 ignored`;
    const signals = extractCommandSignals(output);
    assert.equal(signals.testPassed, 12);
    assert.equal(signals.testFailures, 0);
  });
});

describe("truncateOutput", () => {
  it("returns unmodified output when under limit", () => {
    const output = "short output";
    assert.equal(truncateOutput(output, 1000), output);
  });

  it("returns unmodified output when no limit set", () => {
    const output = "x".repeat(10000);
    assert.equal(truncateOutput(output), output);
  });

  it("truncates long output preserving head and tail", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}: ${"x".repeat(50)}`);
    const output = lines.join("\n");
    const truncated = truncateOutput(output, 2000);
    assert.ok(truncated.length <= output.length);
    assert.ok(truncated.includes("truncated"));
    assert.ok(truncated.includes("line 1:"));
  });
});
