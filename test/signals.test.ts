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

type DoneCriterion = { name: string; command: string; pattern: string };
type CommandOutput = { name: string; output: string; exitCode?: number };

function checkDoneCriteria(criteria: DoneCriterion[], outputs: CommandOutput[]): { allMet: boolean; unmet: string[] } {
  const outputMap = new Map(outputs.map((o) => [o.name, o.output]));
  const unmet: string[] = [];
  for (const c of criteria) {
    const text = outputMap.get(c.command);
    if (!text) { unmet.push(`${c.name}: command '${c.command}' not found`); continue; }
    try {
      if (!new RegExp(c.pattern).test(text)) unmet.push(c.name);
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
