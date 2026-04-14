import { parse as parseYaml } from "yaml";
import { minimatch } from "minimatch";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type CommandDef = { name: string; run: string; timeout: number; maxOutput?: number; signalPatterns?: Record<string, string[]>; runEvery?: number };
type DoneCriterion = { name: string; command: string; pattern: string };
type ObjectiveMetric = "test_failures" | "tests_passed" | "lint_errors" | "lint_warnings";
type ObjectiveMode = "minimize" | "maximize";
type ObjectiveDef = { metric: ObjectiveMetric; mode?: ObjectiveMode };
type AcceptanceRule = "non_regression" | "strict_improvement";
type Frontmatter = {
  commands: CommandDef[];
  maxIterations: number;
  minIterations: number;
  timeout: number;
  completionPromise?: string;
  rollbackOnRegression: boolean;
  guardrails: { blockCommands: string[]; protectedFiles: string[] };
  doneCriteria?: DoneCriterion[];
  objective?: ObjectiveDef;
  acceptanceRule: AcceptanceRule;
  greenStreakLimit: number;
  parallel: boolean;
};
type ParsedRalph = { frontmatter: Frontmatter; body: string };
type CommandOutput = { name: string; output: string; exitCode?: number };
type CommandSummaryStatus = "ok" | "failed" | "timed_out" | "error";
type CommandSignals = { testFailures?: number; testPassed?: number; lintErrors?: number; lintWarnings?: number };
type IterationCommandSummary = { name: string; status: CommandSummaryStatus; excerpt: string; signals: CommandSignals };
type IterationSignals = CommandSignals & { hadTimeout: boolean; hadError: boolean };
type IterationSummary = {
  iteration: number;
  duration: number;
  assistantRecap: string;
  commandSummaries: IterationCommandSummary[];
  signals: IterationSignals;
  regressed?: boolean;
  rolledBack?: boolean;
  rollbackDetails?: string;
  hadChanges?: boolean;
  diffFingerprint?: string;
  objectiveValue?: number;
  objectiveAccepted?: boolean;
  objectiveReason?: string;
};
type LoopState = {
  active: boolean;
  ralphPath: string;
  iteration: number;
  maxIterations: number;
  minIterations: number;
  timeout: number;
  completionPromise?: string;
  rollbackOnRegression: boolean;
  stopRequested: boolean;
  iterationSummaries: IterationSummary[];
  guardrails: { blockCommands: string[]; protectedFiles: string[] };
  loopSessionFile?: string;
  diffFingerprints: string[];
  specContent?: string;
};
type PersistedLoopState = {
  active: boolean;
  sessionFile?: string;
  iteration?: number;
  maxIterations?: number;
  minIterations?: number;
  iterationSummaries?: IterationSummary[];
  guardrails?: { blockCommands: string[]; protectedFiles: string[] };
  stopRequested?: boolean;
  specContent?: string;
};

function defaultFrontmatter(): Frontmatter {
  return {
    commands: [],
    maxIterations: 50,
    minIterations: 1,
    timeout: 300,
    rollbackOnRegression: false,
    guardrails: { blockCommands: [], protectedFiles: [] },
    acceptanceRule: "non_regression",
    greenStreakLimit: 0,
    parallel: false,
  };
}

const OBJECTIVE_METRICS: ObjectiveMetric[] = ["test_failures", "tests_passed", "lint_errors", "lint_warnings"];
const ACCEPTANCE_RULES: AcceptanceRule[] = ["non_regression", "strict_improvement"];

function parseObjective(raw: unknown): ObjectiveDef | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string") {
    const metric = raw.trim() as ObjectiveMetric;
    return OBJECTIVE_METRICS.includes(metric) ? { metric } : undefined;
  }
  if (typeof raw !== "object") return undefined;
  const objective = raw as Record<string, unknown>;
  const metric = String(objective.metric ?? "").trim() as ObjectiveMetric;
  if (!OBJECTIVE_METRICS.includes(metric)) return undefined;
  const modeRaw = objective.mode;
  const mode = typeof modeRaw === "string" && (modeRaw === "minimize" || modeRaw === "maximize")
    ? (modeRaw as ObjectiveMode)
    : undefined;
  return { metric, mode };
}

function parseRalphMd(filePath: string): ParsedRalph {
  let raw = readFileSync(filePath, "utf8");
  raw = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: defaultFrontmatter(), body: raw };

  const yaml = (parseYaml(match[1]) ?? {}) as Record<string, any>;
  const commands: CommandDef[] = Array.isArray(yaml.commands)
    ? yaml.commands.map((c: Record<string, any>) => {
        const sp = c.signal_patterns as Record<string, unknown> | undefined;
        const signalPatterns: Record<string, string[]> | undefined = sp && typeof sp === "object"
          ? Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : []]))
          : undefined;
        return {
          name: String(c.name ?? ""),
          run: String(c.run ?? ""),
          timeout: Number(c.timeout ?? 60),
          maxOutput: typeof c.max_output === "number" ? c.max_output : undefined,
          signalPatterns,
          runEvery: typeof c.run_every === "number" && c.run_every > 0 ? c.run_every : undefined,
        };
      })
    : [];
  const guardrails = (yaml.guardrails ?? {}) as Record<string, any>;
  const doneCriteria: DoneCriterion[] | undefined = Array.isArray(yaml.done_criteria)
    ? yaml.done_criteria.map((d: Record<string, any>) => ({
        name: String(d.name ?? ""),
        command: String(d.command ?? ""),
        pattern: String(d.pattern ?? ""),
      }))
    : undefined;
  const objective = parseObjective(yaml.objective);
  const acceptanceRuleRaw = String(yaml.acceptance_rule ?? "non_regression");
  const acceptanceRule: AcceptanceRule = ACCEPTANCE_RULES.includes(acceptanceRuleRaw as AcceptanceRule)
    ? (acceptanceRuleRaw as AcceptanceRule)
    : "non_regression";

  return {
    frontmatter: {
      commands,
      maxIterations: Number(yaml.max_iterations ?? 50),
      minIterations: Number(yaml.min_iterations ?? 1),
      timeout: Number(yaml.timeout ?? 300),
      completionPromise:
        typeof yaml.completion_promise === "string" && yaml.completion_promise.trim() ? yaml.completion_promise : undefined,
      rollbackOnRegression: yaml.rollback_on_regression === true,
      guardrails: {
        blockCommands: Array.isArray(guardrails.block_commands) ? guardrails.block_commands.map((p: unknown) => String(p)) : [],
        protectedFiles: Array.isArray(guardrails.protected_files) ? guardrails.protected_files.map((p: unknown) => String(p)) : [],
      },
      doneCriteria,
      objective,
      acceptanceRule,
      greenStreakLimit: Number(yaml.green_streak_limit ?? 0),
      parallel: yaml.parallel === true,
    },
    body: match[2] ?? "",
  };
}

function validateFrontmatter(fm: Frontmatter, ctx: any): boolean {
  if (!Number.isFinite(fm.maxIterations) || !Number.isInteger(fm.maxIterations) || fm.maxIterations <= 0) {
    ctx.ui.notify("Invalid max_iterations: must be a positive finite integer", "error");
    return false;
  }
  if (!Number.isFinite(fm.timeout) || fm.timeout <= 0) {
    ctx.ui.notify("Invalid timeout: must be a positive finite number", "error");
    return false;
  }
  for (const pattern of fm.guardrails.blockCommands) {
    try { new RegExp(pattern); } catch {
      ctx.ui.notify(`Invalid block_commands regex: ${pattern}`, "error");
      return false;
    }
  }
  for (const cmd of fm.commands) {
    if (!cmd.name.trim()) {
      ctx.ui.notify("Invalid command: name is required", "error");
      return false;
    }
    if (!cmd.run.trim()) {
      ctx.ui.notify(`Invalid command ${cmd.name}: run is required`, "error");
      return false;
    }
    if (!Number.isFinite(cmd.timeout) || cmd.timeout <= 0) {
      ctx.ui.notify(`Invalid command ${cmd.name}: timeout must be positive`, "error");
      return false;
    }
  }
  if (!ACCEPTANCE_RULES.includes(fm.acceptanceRule)) {
    ctx.ui.notify(`Invalid acceptance_rule: must be one of ${ACCEPTANCE_RULES.join(", ")}`, "error");
    return false;
  }
  if (fm.objective && !OBJECTIVE_METRICS.includes(fm.objective.metric)) {
    ctx.ui.notify(`Invalid objective.metric: must be one of ${OBJECTIVE_METRICS.join(", ")}`, "error");
    return false;
  }
  return true;
}

function resolveRalphPath(args: string, cwd: string): string | null {
  const target = args.trim() || ".";
  const abs = resolve(cwd, target);
  if (existsSync(abs) && abs.endsWith(".md")) return abs;
  if (existsSync(join(abs, "RALPH.md"))) return join(abs, "RALPH.md");
  return null;
}

type ProjectDiscovery = {
  projectName: string;
  specFile?: string;
  readmeFile?: string;
  commands: CommandDef[];
  doneCriteria: DoneCriterion[];
  ecosystem: "node" | "rust" | "python" | "make" | "unknown";
};

const SPEC_CANDIDATES = ["specs.md", "SPECS.md", "spec.md", "SPEC.md", "TASK.md", "TODO.md", "task.md"];
const README_CANDIDATES = ["README.md", "readme.md", "Readme.md", "README.rst", "README.txt"];

const MAX_SPEC_INJECT = 6000;

function readSpecContent(cwd: string): string | undefined {
  let files: string[];
  try { files = readdirSync(cwd); } catch { return undefined; }
  const specName = SPEC_CANDIDATES.find((f) => files.includes(f));
  const target = specName ?? README_CANDIDATES.find((f) => files.includes(f));
  if (!target) return undefined;
  try {
    const raw = readFileSync(join(cwd, target), "utf8").trim();
    if (!raw) return undefined;
    if (raw.length <= MAX_SPEC_INJECT) return raw;
    return raw.slice(0, MAX_SPEC_INJECT) + `\n\n[… truncated, read \`${target}\` for the full spec]`;
  } catch { return undefined; }
}

function discoverProject(cwd: string): ProjectDiscovery | null {
  const projectName = basename(cwd);
  let files: string[];
  try { files = readdirSync(cwd); } catch { return null; }
  const has = (name: string) => files.includes(name);

  const specFile = SPEC_CANDIDATES.find((f) => has(f));
  const readmeFile = README_CANDIDATES.find((f) => has(f));

  const commands: CommandDef[] = [];
  const doneCriteria: DoneCriterion[] = [];
  let ecosystem: ProjectDiscovery["ecosystem"] = "unknown";

  if (has("package.json")) {
    ecosystem = "node";
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
      const scripts = (pkg.scripts ?? {}) as Record<string, string>;
      const seen = new Set<string>();

      if (scripts.test && !seen.has(scripts.test)) {
        seen.add(scripts.test);
        commands.push({ name: "tests", run: "npm test", timeout: 120, maxOutput: 4000 });
      }
      if (scripts.lint && !seen.has(scripts.lint)) {
        seen.add(scripts.lint);
        commands.push({ name: "lint", run: "npm run lint", timeout: 60, maxOutput: 2000 });
      }
      if (scripts.benchmark && !seen.has(scripts.benchmark)) {
        seen.add(scripts.benchmark);
        commands.push({ name: "benchmark", run: "npm run benchmark", timeout: 600, maxOutput: 6000, runEvery: 3 });
      } else if (scripts.bench && !seen.has(scripts.bench)) {
        seen.add(scripts.bench);
        commands.push({ name: "benchmark", run: "npm run bench", timeout: 600, maxOutput: 6000, runEvery: 3 });
      }
    } catch { /* malformed package.json, still continue */ }
  } else if (has("Cargo.toml")) {
    ecosystem = "rust";
    commands.push({ name: "tests", run: "cargo test", timeout: 300, maxOutput: 4000 });
    commands.push({ name: "lint", run: "cargo clippy -- -D warnings", timeout: 120, maxOutput: 2000 });
  } else if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    ecosystem = "python";
    if (has("pyproject.toml")) {
      try {
        const toml = readFileSync(join(cwd, "pyproject.toml"), "utf8");
        if (toml.includes("pytest")) {
          commands.push({ name: "tests", run: "pytest", timeout: 300, maxOutput: 4000 });
        }
        if (toml.includes("ruff")) {
          commands.push({ name: "lint", run: "ruff check .", timeout: 60, maxOutput: 2000 });
        }
      } catch { /* continue */ }
    }
    if (commands.length === 0) {
      commands.push({ name: "tests", run: "pytest", timeout: 300, maxOutput: 4000 });
    }
  } else if (has("Makefile") || has("makefile")) {
    ecosystem = "make";
    commands.push({ name: "tests", run: "make test", timeout: 300, maxOutput: 4000 });
    commands.push({ name: "lint", run: "make lint", timeout: 60, maxOutput: 2000 });
  }

  if (!specFile && !readmeFile && commands.length === 0) return null;

  return { projectName, specFile, readmeFile, commands, doneCriteria, ecosystem };
}


function generateDefaultRalph(discovery: ProjectDiscovery): ParsedRalph {
  const { specFile, readmeFile, commands, doneCriteria } = discovery;

  const hasTests = commands.some(c => c.name === "tests");
  const autoObjective: ObjectiveDef | undefined = hasTests
    ? { metric: "test_failures", mode: "minimize" }
    : undefined;

  const frontmatter: Frontmatter = {
    commands,
    maxIterations: 25,
    minIterations: 3,
    timeout: 300,
    rollbackOnRegression: true,
    guardrails: {
      blockCommands: [],
      protectedFiles: specFile ? [specFile] : [],
    },
    doneCriteria: doneCriteria.length ? doneCriteria : undefined,
    objective: autoObjective,
    acceptanceRule: "non_regression",
    greenStreakLimit: 10,
    parallel: commands.length > 1,
  };

  const sections: string[] = [];
  sections.push("# Autonomous Implementation Loop\n");

  const docRef = specFile ?? readmeFile;
  if (docRef) {
    sections.push(`You are implementing this project per \`${docRef}\`. Read it carefully for requirements and design constraints.\n`);
  } else {
    sections.push("Analyze the existing codebase to understand the project structure, then work on improving it.\n");
  }

  if (commands.length > 0) {
    sections.push("## Feedback\n");
    for (const cmd of commands) {
      const label = cmd.name.charAt(0).toUpperCase() + cmd.name.slice(1);
      sections.push(`### ${label}\n\n{{ commands.${cmd.name} }}\n`);
    }
  }

  sections.push("## Recent Changes\n\n{{ git.log }}\n");

  sections.push(`## Iteration {{ ralph.iteration }}

Each iteration:

1. Review the feedback above (tests, lint, benchmarks)
2. Identify the highest-priority failure or gap
3. Batch related changes together -- do not make one micro-fix per iteration
4. Verify all checks pass before committing
5. Commit with a descriptive message

### Priority order

1. Failing tests or broken functionality
2. Missing requirements from the spec${specFile ? ` (\`${specFile}\`)` : ""}
3. Performance and correctness verification
4. Edge cases and hardening

Focus on correctness and spec compliance over micro-optimizations.`);

  return { frontmatter, body: sections.join("\n") };
}

function resolvePlaceholders(body: string, outputs: CommandOutput[], ralph: { iteration: number; name: string }, gitContext?: { diff: string; log: string }): string {
  const map = new Map(outputs.map((o) => [o.name, o.output]));
  return body
    .replace(/\{\{\s*commands\.(\w[\w-]*)\s*\}\}/g, (_, name) => map.get(name) ?? "")
    .replace(/\{\{\s*ralph\.iteration\s*\}\}/g, String(ralph.iteration))
    .replace(/\{\{\s*ralph\.name\s*\}\}/g, ralph.name)
    .replace(/\{\{\s*git\.diff\s*\}\}/g, gitContext?.diff ?? "")
    .replace(/\{\{\s*git\.log\s*\}\}/g, gitContext?.log ?? "");
}

const MAX_ASSISTANT_RECAP = 800;
const MAX_COMMAND_EXCERPT = 220;
const MAX_CONTEXT_ITERATIONS = 5;
const MAX_PERSIST_SUMMARIES = 10;
const STALL_THRESHOLD = 3;
const CONVERGENCE_WINDOW = 3;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function extractAssistantText(entry: any): string {
  if (entry?.type !== "message" || entry?.message?.role !== "assistant") return "";
  const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
  const joined = blocks.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("\n");
  return normalizeWhitespace(joined);
}

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

const DEFAULT_SIGNAL_PATTERNS: Record<string, RegExp[]> = {
  testFailures: [
    /\b(\d+)\s+failed\b/gi,
    /\bfailures?:\s*(\d+)\b/gi,
    /# fail\s+(\d+)/gi,                    // Node.js test runner / TAP
    /Tests:\s+(\d+)\s+failed/gi,           // Jest
    /(\d+)\s+failing\b/gi,                 // Mocha
  ],
  testPassed: [
    /\b(\d+)\s+passed\b/gi,
    /\bpasses?:\s*(\d+)\b/gi,
    /# pass\s+(\d+)/gi,                    // Node.js test runner / TAP
    /Tests:\s+(\d+)\s+passed/gi,           // Jest
    /(\d+)\s+passing\b/gi,                 // Mocha
  ],
  lintErrors: [
    /(\d+)\s+problems?\b/gi,              // ESLint "N problems" (general, matched first)
    /\b(\d+)\s+errors?\b/gi,
    /\berrors?:\s*(\d+)\b/gi,
  ],
  lintWarnings: [
    /\b(\d+)\s+warnings?\b/gi,
    /\bwarnings?:\s*(\d+)\b/gi,
  ],
};

const OBJECTIVE_META: Record<ObjectiveMetric, { signalKey: keyof CommandSignals; label: string; defaultMode: ObjectiveMode }> = {
  test_failures: { signalKey: "testFailures", label: "test failures", defaultMode: "minimize" },
  tests_passed: { signalKey: "testPassed", label: "tests passed", defaultMode: "maximize" },
  lint_errors: { signalKey: "lintErrors", label: "lint errors", defaultMode: "minimize" },
  lint_warnings: { signalKey: "lintWarnings", label: "lint warnings", defaultMode: "minimize" },
};

function buildSignalPatterns(custom?: Record<string, string[]>): Record<string, RegExp[]> {
  if (!custom) return DEFAULT_SIGNAL_PATTERNS;
  const merged = { ...DEFAULT_SIGNAL_PATTERNS };
  for (const [key, patterns] of Object.entries(custom)) {
    if (key in merged) {
      const compiled = patterns.map((p) => { try { return new RegExp(p, "gi"); } catch { return null; } }).filter((r): r is RegExp => r !== null);
      if (compiled.length) merged[key as keyof typeof merged] = compiled;
    }
  }
  return merged;
}

function extractCommandSignals(output: string, customPatterns?: Record<string, string[]>): CommandSignals {
  const patterns = buildSignalPatterns(customPatterns);
  return {
    testFailures: extractCount(output, patterns.testFailures),
    testPassed: extractCount(output, patterns.testPassed),
    lintErrors: extractCount(output, patterns.lintErrors),
    lintWarnings: extractCount(output, patterns.lintWarnings),
  };
}

function summarizeCommandOutput(output: CommandOutput, cmdDef?: CommandDef): IterationCommandSummary {
  const trimmed = output.output.trim();
  const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
  const excerpt = truncateText(normalizeWhitespace(lines.slice(Math.max(0, lines.length - 6)).join(" ")), MAX_COMMAND_EXCERPT);
  const signals = extractCommandSignals(trimmed, cmdDef?.signalPatterns);

  let status: CommandSummaryStatus = "ok";
  if (/^\[timed out after \d+s\]$/i.test(trimmed)) {
    status = "timed_out";
  } else if (/^\[error:/i.test(trimmed)) {
    status = "error";
  } else if (output.exitCode !== undefined) {
    status = output.exitCode === 0 ? "ok" : "failed";
  }
  // No exitCode available (legacy/fallback): use text heuristics as last resort
  else {
    const sanitized = trimmed.replace(/\b(fail(?:ed|ures?|s)?)\s*[:=]?\s*0\b/gi, "___ZERO___");
    if (/\bFAIL(?:ED)?\b|\bERROR\b|error:|failed/i.test(sanitized)) status = "failed";
  }

  return { name: output.name, status, excerpt, signals };
}

function aggregateSignals(commandSummaries: IterationCommandSummary[]): IterationSignals {
  let testFailures = 0;
  let testPassed = 0;
  let lintErrors = 0;
  let lintWarnings = 0;
  let hasTestFailures = false;
  let hasTestPassed = false;
  let hasLintErrors = false;
  let hasLintWarnings = false;
  let hadTimeout = false;
  let hadError = false;

  for (const cmd of commandSummaries) {
    if (cmd.status === "timed_out") hadTimeout = true;
    if (cmd.status === "error") hadError = true;

    if (typeof cmd.signals.testFailures === "number") {
      testFailures += cmd.signals.testFailures;
      hasTestFailures = true;
    }
    if (typeof cmd.signals.testPassed === "number") {
      testPassed += cmd.signals.testPassed;
      hasTestPassed = true;
    }
    if (typeof cmd.signals.lintErrors === "number") {
      lintErrors += cmd.signals.lintErrors;
      hasLintErrors = true;
    }
    if (typeof cmd.signals.lintWarnings === "number") {
      lintWarnings += cmd.signals.lintWarnings;
      hasLintWarnings = true;
    }
  }

  return {
    testFailures: hasTestFailures ? testFailures : undefined,
    testPassed: hasTestPassed ? testPassed : undefined,
    lintErrors: hasLintErrors ? lintErrors : undefined,
    lintWarnings: hasLintWarnings ? lintWarnings : undefined,
    hadTimeout,
    hadError,
  };
}

function normalizeIterationSummary(summary: any): IterationSummary {
  if (!summary || typeof summary !== "object") {
    return { iteration: 0, duration: 0, assistantRecap: "", commandSummaries: [], signals: { hadTimeout: false, hadError: false }, regressed: false };
  }

  const commandSummaries = Array.isArray(summary.commandSummaries)
    ? summary.commandSummaries.map((cmd: any) => ({
        name: String(cmd?.name ?? "command"),
        status: cmd?.status === "failed" || cmd?.status === "timed_out" || cmd?.status === "error" ? cmd.status : "ok",
        excerpt: String(cmd?.excerpt ?? ""),
        signals: {
          testFailures: typeof cmd?.signals?.testFailures === "number" ? cmd.signals.testFailures : undefined,
          testPassed: typeof cmd?.signals?.testPassed === "number" ? cmd.signals.testPassed : undefined,
          lintErrors: typeof cmd?.signals?.lintErrors === "number" ? cmd.signals.lintErrors : undefined,
          lintWarnings: typeof cmd?.signals?.lintWarnings === "number" ? cmd.signals.lintWarnings : undefined,
        },
      }))
    : [];

  const normalized: IterationSummary = {
    iteration: typeof summary.iteration === "number" ? summary.iteration : 0,
    duration: typeof summary.duration === "number" ? summary.duration : 0,
    assistantRecap: typeof summary.assistantRecap === "string" ? summary.assistantRecap : "",
    commandSummaries,
    signals: {
      testFailures: typeof summary.signals?.testFailures === "number" ? summary.signals.testFailures : undefined,
      testPassed: typeof summary.signals?.testPassed === "number" ? summary.signals.testPassed : undefined,
      lintErrors: typeof summary.signals?.lintErrors === "number" ? summary.signals.lintErrors : undefined,
      lintWarnings: typeof summary.signals?.lintWarnings === "number" ? summary.signals.lintWarnings : undefined,
      hadTimeout: Boolean(summary.signals?.hadTimeout),
      hadError: Boolean(summary.signals?.hadError),
    },
    regressed: typeof summary.regressed === "boolean" ? summary.regressed : false,
    rolledBack: typeof summary.rolledBack === "boolean" ? summary.rolledBack : false,
    rollbackDetails: typeof summary.rollbackDetails === "string" ? summary.rollbackDetails : undefined,
    hadChanges: typeof summary.hadChanges === "boolean" ? summary.hadChanges : undefined,
    diffFingerprint: typeof summary.diffFingerprint === "string" ? summary.diffFingerprint : undefined,
    objectiveValue: typeof summary.objectiveValue === "number" ? summary.objectiveValue : undefined,
    objectiveAccepted: typeof summary.objectiveAccepted === "boolean" ? summary.objectiveAccepted : undefined,
    objectiveReason: typeof summary.objectiveReason === "string" ? summary.objectiveReason : undefined,
  };

  if (!normalized.commandSummaries.length && !summary.signals) {
    normalized.signals = { hadTimeout: false, hadError: false };
  }
  return normalized;
}

function buildIterationContext(summaries: IterationSummary[]): string {
  const recent = summaries.slice(-MAX_CONTEXT_ITERATIONS);
  return recent
    .map((summary) => {
      const recap = summary.assistantRecap
        ? truncateText(normalizeWhitespace(summary.assistantRecap), MAX_ASSISTANT_RECAP)
        : "No assistant recap captured.";
      const aggregateParts: string[] = [];
      if (typeof summary.signals.testFailures === "number") aggregateParts.push(`tests_failed=${summary.signals.testFailures}`);
      if (typeof summary.signals.testPassed === "number") aggregateParts.push(`tests_passed=${summary.signals.testPassed}`);
      if (typeof summary.signals.lintErrors === "number") aggregateParts.push(`lint_errors=${summary.signals.lintErrors}`);
      if (typeof summary.signals.lintWarnings === "number") aggregateParts.push(`lint_warnings=${summary.signals.lintWarnings}`);
      if (summary.signals.hadTimeout) aggregateParts.push("had_timeout=true");
      if (summary.signals.hadError) aggregateParts.push("had_error=true");
      const aggregateLine = aggregateParts.length ? `signals: ${aggregateParts.join(", ")}` : "signals: none detected";

      const commandLine = summary.commandSummaries.length
        ? summary.commandSummaries
            .map((cmd) => {
              const parts = [`${cmd.name}=${cmd.status}`];
              if (typeof cmd.signals.testFailures === "number") parts.push(`failed=${cmd.signals.testFailures}`);
              if (typeof cmd.signals.lintErrors === "number") parts.push(`lintErrors=${cmd.signals.lintErrors}`);
              return parts.join(" ");
            })
            .join("; ")
        : "no commands";

      const regressionLabel = summary.rolledBack
        ? " ⚠️ REGRESSED & ROLLED BACK"
        : summary.regressed ? " ⚠️ REGRESSED" : "";
      const rollbackNote = summary.rolledBack
        ? `\n  - rollback: changes reverted automatically (${summary.rollbackDetails ?? "regression detected"})`
        : "";
      const changesNote = summary.hadChanges === false ? " [no file changes]" : "";
      return `- Iteration ${summary.iteration} (${summary.duration}s)${regressionLabel}${changesNote}\n  - recap: ${recap}\n  - ${aggregateLine}\n  - commands: ${commandLine}${rollbackNote}`;
    })
    .join("\n");
}

type RegressionResult = { regressed: boolean; details: string[] };

function buildTrendLine(summaries: IterationSummary[]): string {
  if (summaries.length < 2) return "";
  const metrics: { key: keyof CommandSignals; label: string; regressionDir: "up" | "down" }[] = [
    { key: "testFailures", label: "Test failures", regressionDir: "up" },
    { key: "testPassed", label: "Tests passed", regressionDir: "down" },
    { key: "lintErrors", label: "Lint errors", regressionDir: "up" },
    { key: "lintWarnings", label: "Lint warnings", regressionDir: "up" },
  ];
  const lines: string[] = [];
  for (const m of metrics) {
    const values = summaries
      .map((s) => ({ iter: s.iteration, val: s.signals[m.key] }))
      .filter((v): v is { iter: number; val: number } => v.val !== undefined);
    if (values.length < 2) continue;
    const trend = values.map((v) => `${v.val}`).join(" -> ");
    const last = values[values.length - 1].val;
    const prev = values[values.length - 2].val;
    const regressed = m.regressionDir === "up" ? last > prev : last < prev;
    lines.push(`${m.label}: ${trend}${regressed ? " (REGRESSION)" : ""}`);
  }
  return lines.length ? lines.join("\n") : "";
}

function detectRegression(summaries: IterationSummary[]): RegressionResult {
  if (summaries.length < 2) return { regressed: false, details: [] };
  const curr = summaries[summaries.length - 1].signals;
  const prev = summaries[summaries.length - 2].signals;
  const details: string[] = [];

  if (typeof curr.testFailures === "number" && typeof prev.testFailures === "number" && curr.testFailures > prev.testFailures)
    details.push(`test failures increased: ${prev.testFailures} -> ${curr.testFailures}`);
  if (typeof curr.testPassed === "number" && typeof prev.testPassed === "number" && curr.testPassed < prev.testPassed)
    details.push(`tests passing decreased: ${prev.testPassed} -> ${curr.testPassed}`);
  if (typeof curr.lintErrors === "number" && typeof prev.lintErrors === "number" && curr.lintErrors > prev.lintErrors)
    details.push(`lint errors increased: ${prev.lintErrors} -> ${curr.lintErrors}`);

  return { regressed: details.length > 0, details };
}

type ConvergenceResult = { converged: boolean; reason: string };

function detectConvergence(summaries: IterationSummary[], window: number): ConvergenceResult {
  if (summaries.length < window) return { converged: false, reason: "" };
  const tail = summaries.slice(-window);

  const noChanges = tail.every(s => !s.hadChanges);
  if (!noChanges) return { converged: false, reason: "" };

  const signalKeys: (keyof CommandSignals)[] = ["testFailures", "testPassed", "lintErrors", "lintWarnings"];
  let metricsStable = true;
  for (const key of signalKeys) {
    const values = tail.map(s => s.signals[key]).filter((v): v is number => typeof v === "number");
    if (values.length >= 2) {
      const unique = new Set(values);
      if (unique.size > 1) { metricsStable = false; break; }
    }
  }

  if (metricsStable) {
    return { converged: true, reason: `${window} consecutive iterations with no file changes and stable metrics` };
  }
  return { converged: false, reason: "" };
}

type ObjectiveEvaluation = { value?: number; accepted: boolean; reason: string };

function evaluateObjective(summaries: IterationSummary[], objective: ObjectiveDef, rule: AcceptanceRule): ObjectiveEvaluation {
  const meta = OBJECTIVE_META[objective.metric];
  const mode = objective.mode ?? meta.defaultMode;
  const current = summaries[summaries.length - 1];
  const currentVal = current?.signals[meta.signalKey];

  if (typeof currentVal !== "number") {
    return { accepted: true, reason: `objective "${objective.metric}" unavailable in current outputs` };
  }

  for (let i = summaries.length - 2; i >= 0; i--) {
    const prevVal = summaries[i].signals[meta.signalKey];
    if (typeof prevVal !== "number") continue;
    if (mode === "minimize") {
      if (rule === "strict_improvement") {
        const accepted = currentVal < prevVal;
        return {
          value: currentVal,
          accepted,
          reason: accepted
            ? `${meta.label} improved: ${prevVal} -> ${currentVal}`
            : `${meta.label} did not strictly improve: ${prevVal} -> ${currentVal}`,
        };
      }
      const accepted = currentVal <= prevVal;
      return {
        value: currentVal,
        accepted,
        reason: accepted
          ? `${meta.label} non-regression: ${prevVal} -> ${currentVal}`
          : `${meta.label} regressed: ${prevVal} -> ${currentVal}`,
      };
    }

    if (rule === "strict_improvement") {
      const accepted = currentVal > prevVal;
      return {
        value: currentVal,
        accepted,
        reason: accepted
          ? `${meta.label} improved: ${prevVal} -> ${currentVal}`
          : `${meta.label} did not strictly improve: ${prevVal} -> ${currentVal}`,
      };
    }
    const accepted = currentVal >= prevVal;
    return {
      value: currentVal,
      accepted,
      reason: accepted
        ? `${meta.label} non-regression: ${prevVal} -> ${currentVal}`
        : `${meta.label} regressed: ${prevVal} -> ${currentVal}`,
    };
  }

  return { value: currentVal, accepted: true, reason: `objective baseline initialized at ${currentVal}` };
}

function latestAssistantRecap(entries: any[], startIndex: number): string {
  for (let i = entries.length - 1; i >= startIndex; i--) {
    const text = extractAssistantText(entries[i]);
    if (text) return truncateText(text, MAX_ASSISTANT_RECAP);
  }
  return "";
}

type ProviderErrorKind = "rate_limit" | "quota_exceeded" | "auth" | "transient" | "unknown";
type ProviderErrorPolicy = "pause" | "retry" | "stop";

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

const PROVIDER_ERROR_POLICIES: Record<ProviderErrorKind, ProviderErrorPolicy> = {
  quota_exceeded: "pause",
  rate_limit: "retry",
  auth: "stop",
  transient: "retry",
  unknown: "stop",
};

const MAX_PROVIDER_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 15_000;

const STASH_PREFIX = "ralph-snapshot-iter-";

async function gitExec(pi: ExtensionAPI, args: string): Promise<{ ok: boolean; output: string }> {
  try {
    const result = await pi.exec("git", args.split(/\s+/), { timeout: 15_000 });
    if (result.killed) return { ok: false, output: "[git timed out]" };
    return { ok: true, output: (result.stdout + result.stderr).trim() };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

async function isGitRepo(pi: ExtensionAPI): Promise<boolean> {
  const { ok } = await gitExec(pi, "rev-parse --is-inside-work-tree");
  return ok;
}

async function createSnapshot(pi: ExtensionAPI, iteration: number): Promise<boolean> {
  const label = `${STASH_PREFIX}${iteration}`;
  const { ok } = await gitExec(pi, `stash push -u -m ${label}`);
  if (!ok) return false;
  const { ok: applyOk } = await gitExec(pi, "stash apply");
  if (!applyOk) {
    await gitExec(pi, "stash pop");
    return false;
  }
  return true;
}

async function findSnapshotStashIndex(pi: ExtensionAPI, iteration: number): Promise<number> {
  const label = `${STASH_PREFIX}${iteration}`;
  const { ok, output } = await gitExec(pi, "stash list --oneline");
  if (!ok || !output) return -1;
  const lines = output.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    if (lines[idx].includes(label)) return idx;
  }
  return -1;
}

async function rollbackToSnapshot(pi: ExtensionAPI, iteration: number): Promise<{ ok: boolean; output: string }> {
  const idx = await findSnapshotStashIndex(pi, iteration);
  if (idx < 0) return { ok: false, output: `snapshot for iteration ${iteration} not found in stash` };
  await gitExec(pi, "reset --hard");
  const { ok, output } = await gitExec(pi, `stash apply stash@{${idx}}`);
  if (!ok) return { ok: false, output };
  await gitExec(pi, `stash drop stash@{${idx}}`);
  return { ok: true, output: "" };
}

async function dropSnapshot(pi: ExtensionAPI, iteration: number): Promise<void> {
  const idx = await findSnapshotStashIndex(pi, iteration);
  if (idx >= 0) await gitExec(pi, `stash drop stash@{${idx}}`);
}

async function getWorkingTreeFingerprint(pi: ExtensionAPI): Promise<string> {
  const head = await gitExec(pi, "rev-parse HEAD");
  const status = await gitExec(pi, "status --porcelain");
  return `${head.ok ? head.output.trim() : ""}|${status.ok ? status.output.trim() : ""}`;
}

async function getDiffFingerprint(pi: ExtensionAPI): Promise<string> {
  const diff = await gitExec(pi, "diff HEAD~1 --stat");
  if (!diff.ok || !diff.output.trim()) return "";
  let hash = 0;
  for (let j = 0; j < diff.output.length; j++) {
    hash = ((hash << 5) - hash + diff.output.charCodeAt(j)) | 0;
  }
  return hash.toString(36);
}

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

async function runCommands(commands: CommandDef[], pi: ExtensionAPI, parallel = false): Promise<CommandOutput[]> {
  const execute = async (cmd: CommandDef): Promise<CommandOutput> => {
    try {
      const result = await pi.exec("bash", ["-c", cmd.run], { timeout: cmd.timeout * 1000 });
      if (result.killed) return { name: cmd.name, output: `[timed out after ${cmd.timeout}s]` };
      const raw = (result.stdout + result.stderr).trim();
      return { name: cmd.name, output: truncateOutput(raw, cmd.maxOutput), exitCode: result.exitCode ?? undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { name: cmd.name, output: `[error: ${message}]` };
    }
  };

  if (parallel) {
    return Promise.all(commands.map(execute));
  }
  const results: CommandOutput[] = [];
  for (const cmd of commands) results.push(await execute(cmd));
  return results;
}

function defaultLoopState(): LoopState {
  return { active: false, ralphPath: "", iteration: 0, maxIterations: 50, minIterations: 1, timeout: 300, completionPromise: undefined, rollbackOnRegression: false, stopRequested: false, iterationSummaries: [], guardrails: { blockCommands: [], protectedFiles: [] }, loopSessionFile: undefined, diffFingerprints: [] };
}

function readPersistedLoopState(ctx: any): PersistedLoopState | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === "ralph-loop-state") {
      return typeof entry.data === "object" && entry.data ? (entry.data as PersistedLoopState) : undefined;
    }
  }
  return undefined;
}

function persistLoopState(pi: ExtensionAPI, data: PersistedLoopState) {
  pi.appendEntry("ralph-loop-state", data);
}

let loopState: LoopState = defaultLoopState();

export default function (pi: ExtensionAPI) {
  const failCounts = new Map<string, number>();
  let onAgentEnd: (() => void) | undefined;

  const isLoopSession = (ctx: any): boolean => {
    const state = readPersistedLoopState(ctx);
    const sessionFile = ctx.sessionManager.getSessionFile();
    return state?.active === true && state.sessionFile === sessionFile;
  };

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!isLoopSession(ctx)) return;
    const persisted = readPersistedLoopState(ctx);
    if (!persisted) return;

    if (event.toolName === "bash") {
      const cmd = (event.input as { command?: string }).command ?? "";
      for (const pattern of persisted.guardrails?.blockCommands ?? []) {
        try {
          if (new RegExp(pattern).test(cmd)) return { block: true, reason: `ralph: blocked (${pattern})` };
        } catch {
          // ignore malformed persisted regex
        }
      }
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const filePath = (event.input as { path?: string }).path ?? "";
      for (const glob of persisted.guardrails?.protectedFiles ?? []) {
        if (minimatch(filePath, glob, { matchBase: true })) return { block: true, reason: `ralph: ${filePath} is protected` };
      }
    }
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (!isLoopSession(ctx)) return;
    const persisted = readPersistedLoopState(ctx);

    let contextBlock = "";

    const spec = persisted?.specContent ?? loopState.specContent;
    if (spec) {
      contextBlock += `\n\n## Project Specification (authoritative)\nThe following is the project specification. All design decisions, language choices, and success criteria come from this document. Follow it strictly.\n\n${spec}`;
    }

    const summaries = (persisted?.iterationSummaries ?? []).map(normalizeIterationSummary).filter((s) => s.iteration > 0);
    if (summaries.length > 0) {
      const history = buildIterationContext(summaries);
      const trendLine = buildTrendLine(summaries);
      const regression = detectRegression(summaries);

      contextBlock += `\n\n## Ralph Loop Context\nIteration ${persisted?.iteration ?? 0}/${persisted?.maxIterations ?? 0}\n\nPrevious iteration recap:\n${history}`;

      if (trendLine) {
        contextBlock += `\n\nProgress trend:\n${trendLine}`;
      }

      const lastSummary = summaries[summaries.length - 1];
      if (lastSummary?.rolledBack) {
        contextBlock += `\n\n⚠️ AUTOMATIC ROLLBACK: The previous iteration's changes were automatically reverted because of regression (${lastSummary.rollbackDetails ?? regression.details.join("; ")}). The working tree is back to the state BEFORE that iteration. Try a fundamentally different approach.`;
      } else if (regression.regressed) {
        contextBlock += `\n\n⚠️ REGRESSION DETECTED: ${regression.details.join("; ")}. The last iteration made things WORSE. Consider reverting your last changes (for example with git restore or by resetting the last commit) and trying a different approach.`;
      }
      if (lastSummary?.objectiveAccepted === false) {
        contextBlock += `\n\n⚠️ OBJECTIVE MISSED: ${lastSummary.objectiveReason ?? "the configured objective acceptance rule was not met"}.`;
      } else if (lastSummary?.objectiveReason) {
        contextBlock += `\n\nObjective status: ${lastSummary.objectiveReason}`;
      }

      const recentFps = summaries.filter(s => s.diffFingerprint).map(s => s.diffFingerprint!);
      const fpSet = new Set<string>();
      const repeated = new Set<string>();
      for (const fp of recentFps) { if (fpSet.has(fp)) repeated.add(fp); fpSet.add(fp); }
      if (repeated.size > 0) {
        contextBlock += `\n\n⚠️ REPEATED APPROACH: Some iterations produced identical diffs. Avoid repeating the same strategy. Try a fundamentally different approach.`;
      }

      contextBlock += `\n\nUse this recap to avoid repeating failed approaches and continue from the best progress made so far.`;
    }

    if (contextBlock) {
      return { systemPrompt: event.systemPrompt + contextBlock };
    }
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    if (!isLoopSession(ctx) || event.toolName !== "bash") return;

    const exitCode = typeof event.exitCode === "number" ? event.exitCode : undefined;
    const isFailure = exitCode !== undefined ? exitCode !== 0 : false;
    if (!isFailure) return;

    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;

    const next = (failCounts.get(sessionFile) ?? 0) + 1;
    failCounts.set(sessionFile, next);
    if (next >= 3) {
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: "\n\n⚠️ ralph: 3+ non-zero exit codes this iteration. Stop and describe the root cause before retrying." },
        ],
      };
    }
  });

  pi.on("agent_end", async (_event: any, ctx: any) => {
    if (!loopState.active || !onAgentEnd) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile === loopState.loopSessionFile) {
      const resolve = onAgentEnd;
      onAgentEnd = undefined;
      resolve();
    }
  });

  pi.registerCommand("ralph", {
    description: "Start an autonomous ralph loop (uses RALPH.md if available, otherwise auto-detects project config)",
    handler: async (args: string, ctx: any) => {
      if (loopState.active) {
        ctx.ui.notify("A ralph loop is already running. Use /ralph-stop first.", "warning");
        return;
      }

      let name: string;
      let isGenerated = false;
      const specContent = readSpecContent(ctx.cwd);

      try {
        const ralphPath = resolveRalphPath(args ?? "", ctx.cwd);
        if (ralphPath) {
          const { frontmatter } = parseRalphMd(ralphPath);
          if (!validateFrontmatter(frontmatter, ctx)) return;
          name = basename(dirname(ralphPath));
          loopState = {
            active: true,
            ralphPath,
            iteration: 0,
            maxIterations: frontmatter.maxIterations,
            minIterations: frontmatter.minIterations,
            timeout: frontmatter.timeout,
            completionPromise: frontmatter.completionPromise,
            rollbackOnRegression: frontmatter.rollbackOnRegression,
            stopRequested: false,
            iterationSummaries: [],
            guardrails: { blockCommands: frontmatter.guardrails.blockCommands, protectedFiles: frontmatter.guardrails.protectedFiles },
            loopSessionFile: undefined,
            diffFingerprints: [],
            specContent,
          };
        } else {
          const discovery = discoverProject(ctx.cwd);
          if (!discovery) {
            ctx.ui.notify("No RALPH.md found and no project files detected (no package.json, Cargo.toml, Makefile, specs, or README). Create a RALPH.md to configure the loop.", "error");
            return;
          }
          const generated = generateDefaultRalph(discovery);
          if (!validateFrontmatter(generated.frontmatter, ctx)) return;
          name = discovery.projectName;
          isGenerated = true;
          loopState = {
            active: true,
            ralphPath: "",
            iteration: 0,
            maxIterations: generated.frontmatter.maxIterations,
            minIterations: generated.frontmatter.minIterations,
            timeout: generated.frontmatter.timeout,
            completionPromise: generated.frontmatter.completionPromise,
            rollbackOnRegression: generated.frontmatter.rollbackOnRegression,
            stopRequested: false,
            iterationSummaries: [],
            guardrails: { blockCommands: generated.frontmatter.guardrails.blockCommands, protectedFiles: generated.frontmatter.guardrails.protectedFiles },
            loopSessionFile: undefined,
            diffFingerprints: [],
            specContent,
          };
        }
      } catch (err) {
        ctx.ui.notify(String(err), "error");
        return;
      }
      if (isGenerated) {
        ctx.ui.notify(`No RALPH.md found. Using auto-detected config for "${name}". Create a RALPH.md to customize.`, "info");
      }
      ctx.ui.notify(`Ralph loop started: ${name} (max ${loopState.maxIterations} iterations, min ${loopState.minIterations})`, "info");
      const providerRetryCounts = new Map<string, number>();
      loopState.loopSessionFile = ctx.sessionManager.getSessionFile();
      if (loopState.loopSessionFile) failCounts.set(loopState.loopSessionFile, 0);
      persistLoopState(pi, {
        active: true,
        sessionFile: loopState.loopSessionFile,
        iteration: loopState.iteration,
        maxIterations: loopState.maxIterations,
        minIterations: loopState.minIterations,
        iterationSummaries: loopState.iterationSummaries,
        guardrails: { blockCommands: loopState.guardrails.blockCommands, protectedFiles: loopState.guardrails.protectedFiles },
        stopRequested: false,
        specContent: loopState.specContent,
      });

      if (!await isGitRepo(pi)) {
        await gitExec(pi, "init");
        await gitExec(pi, "add -A");
        await gitExec(pi, "commit -m initial");
        ctx.ui.notify("Initialized git repo for change tracking", "info");
      }

      try {
        iterationLoop: for (let i = 1; i <= loopState.maxIterations; i++) {
          if (loopState.stopRequested) break;
          const persistedBefore = readPersistedLoopState(ctx);
          if (persistedBefore?.active && persistedBefore.stopRequested) {
            loopState.stopRequested = true;
            ctx.ui.notify("Ralph loop stopping after current iteration…", "info");
            break;
          }

          loopState.iteration = i;
          const iterStart = Date.now();
          let fm: Frontmatter;
          let rawBody: string;
          if (loopState.ralphPath) {
            // Hot-swap: if the file was deleted mid-loop, fall back to discovery
            if (!existsSync(loopState.ralphPath)) {
              const discovery = discoverProject(ctx.cwd);
              if (!discovery) { ctx.ui.notify(`RALPH.md removed and no project files found, stopping loop`, "error"); break; }
              const gen = generateDefaultRalph(discovery);
              fm = gen.frontmatter;
              rawBody = gen.body;
              loopState.ralphPath = "";
            } else {
              const parsed = parseRalphMd(loopState.ralphPath);
              fm = parsed.frontmatter;
              rawBody = parsed.body;
            }
          } else {
            // Generated mode: check if a RALPH.md appeared (hot-swap in)
            const ralphPath = resolveRalphPath("", ctx.cwd);
            if (ralphPath) {
              const parsed = parseRalphMd(ralphPath);
              fm = parsed.frontmatter;
              rawBody = parsed.body;
              loopState.ralphPath = ralphPath;
              ctx.ui.notify(`Iteration ${i}: found RALPH.md, switching to file-based config`, "info");
            } else {
              const discovery = discoverProject(ctx.cwd);
              if (!discovery) { ctx.ui.notify(`No project files found on iteration ${i}, stopping loop`, "error"); break; }
              const gen = generateDefaultRalph(discovery);
              fm = gen.frontmatter;
              rawBody = gen.body;
            }
          }
          if (!validateFrontmatter(fm, ctx)) {
            ctx.ui.notify(`Invalid config on iteration ${i}, stopping loop`, "error");
            break;
          }

          loopState.maxIterations = fm.maxIterations;
          loopState.minIterations = fm.minIterations;
          loopState.timeout = fm.timeout;
          loopState.completionPromise = fm.completionPromise;
          loopState.rollbackOnRegression = fm.rollbackOnRegression;
          loopState.guardrails = { blockCommands: fm.guardrails.blockCommands, protectedFiles: fm.guardrails.protectedFiles };

          let snapshotCreated = false;
          if (loopState.rollbackOnRegression && i > 1) {
            const isRepo = await isGitRepo(pi);
            if (isRepo) {
              snapshotCreated = await createSnapshot(pi, i);
              if (!snapshotCreated) {
                ctx.ui.notify(`Iteration ${i}: could not create git snapshot; rollback disabled for this iteration`, "warning");
              }
            } else {
              ctx.ui.notify(`Iteration ${i}: not a git repo; rollback_on_regression requires git`, "warning");
            }
          }

          const scheduledCommands = fm.commands.filter(cmd =>
            !cmd.runEvery || i === 1 || i % cmd.runEvery === 0 || i === fm.maxIterations
          );
          const skippedCommands = fm.commands.filter(cmd =>
            cmd.runEvery && i !== 1 && i % cmd.runEvery !== 0 && i !== fm.maxIterations
          );
          const outputs = await runCommands(scheduledCommands, pi, fm.parallel);
          for (const skipped of skippedCommands) {
            outputs.push({ name: skipped.name, output: `[skipped: runs every ${skipped.runEvery} iterations]`, exitCode: 0 });
          }
          let gitContext: { diff: string; log: string } | undefined;
          if (rawBody.includes("{{ git.diff") || rawBody.includes("{{ git.log")) {
            const isRepo = await isGitRepo(pi);
            if (isRepo) {
              const [diffResult, logResult] = await Promise.all([
                gitExec(pi, "diff HEAD~1"),
                gitExec(pi, "log --oneline -5"),
              ]);
              gitContext = { diff: diffResult.ok ? diffResult.output : "", log: logResult.ok ? logResult.output : "" };
            }
          }
          let body = resolvePlaceholders(rawBody, outputs, { iteration: i, name }, gitContext);
          body = body.replace(/<!--[\s\S]*?-->/g, "");
          const prompt = `[ralph: iteration ${i}/${loopState.maxIterations}]\n\n${body}`;

          ctx.ui.setStatus("ralph", `🔁 ${name}: iteration ${i}/${loopState.maxIterations}`);
          loopState.loopSessionFile = ctx.sessionManager.getSessionFile();
          if (loopState.loopSessionFile) failCounts.set(loopState.loopSessionFile, 0);
          const persistedBeforeSummaryPersist = readPersistedLoopState(ctx);
          const stopRequested = loopState.stopRequested || Boolean(persistedBeforeSummaryPersist?.active && persistedBeforeSummaryPersist.stopRequested);
          loopState.stopRequested = stopRequested;
          persistLoopState(pi, {
            active: true,
            sessionFile: loopState.loopSessionFile,
            iteration: loopState.iteration,
            maxIterations: loopState.maxIterations,
            minIterations: loopState.minIterations,
            iterationSummaries: loopState.iterationSummaries,
            guardrails: { blockCommands: loopState.guardrails.blockCommands, protectedFiles: loopState.guardrails.protectedFiles },
            stopRequested,
            specContent: loopState.specContent,
          });

          const fingerprintBefore = await isGitRepo(pi) ? await getWorkingTreeFingerprint(pi) : "";

          const iterationEntryStart = ctx.sessionManager.getEntries().length;
          const agentDone = new Promise<void>((resolve) => { onAgentEnd = resolve; });
          if (ctx.isIdle()) {
            pi.sendUserMessage(prompt);
          } else {
            pi.sendUserMessage(prompt, { deliverAs: "followUp" });
          }

          const timeoutMs = fm.timeout * 1000;
          let timedOut = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              agentDone,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  timedOut = true;
                  reject(new Error("timeout"));
                }, timeoutMs);
              }),
            ]);
          } catch {
            // timedOut flag distinguishes timeout from other errors
          }
          if (timer) clearTimeout(timer);
          onAgentEnd = undefined;

          const elapsed = Math.round((Date.now() - iterStart) / 1000);
          const fingerprintAfter = fingerprintBefore ? await getWorkingTreeFingerprint(pi) : "";
          const hadChanges = Boolean(fingerprintBefore && fingerprintAfter && fingerprintBefore !== fingerprintAfter);

          const commandSummaries = outputs.map((o, idx) => summarizeCommandOutput(o, fm.commands[idx]));
          const entriesAfterIteration = ctx.sessionManager.getEntries();
          const assistantRecap = latestAssistantRecap(entriesAfterIteration, iterationEntryStart);
          const signals = aggregateSignals(commandSummaries);
          let diffFp = "";
          if (hadChanges && await isGitRepo(pi)) {
            diffFp = await getDiffFingerprint(pi);
          }

          const tentativeSummary: IterationSummary = {
            iteration: i,
            duration: elapsed,
            assistantRecap,
            commandSummaries,
            signals,
            hadChanges,
            diffFingerprint: diffFp || undefined,
          };
          const regression = detectRegression([...loopState.iterationSummaries, tentativeSummary]);
          tentativeSummary.regressed = regression.regressed;
          let objectiveEvaluation: ObjectiveEvaluation | undefined;
          if (fm.objective) {
            objectiveEvaluation = evaluateObjective([...loopState.iterationSummaries, tentativeSummary], fm.objective, fm.acceptanceRule);
            tentativeSummary.objectiveValue = objectiveEvaluation.value;
            tentativeSummary.objectiveAccepted = objectiveEvaluation.accepted;
            tentativeSummary.objectiveReason = objectiveEvaluation.reason;
          }

          const shouldRollback = snapshotCreated && loopState.rollbackOnRegression
            && (regression.regressed || objectiveEvaluation?.accepted === false);
          const rollbackReason = [
            ...(regression.regressed ? regression.details : []),
            ...(objectiveEvaluation?.accepted === false ? [objectiveEvaluation.reason] : []),
          ].join("; ");

          if (shouldRollback) {
            const rb = await rollbackToSnapshot(pi, i);
            if (rb.ok) {
              tentativeSummary.rolledBack = true;
              tentativeSummary.rollbackDetails = rollbackReason;
              ctx.ui.notify(`Iteration ${i}: changes rolled back (${rollbackReason})`, "warning");
            } else {
              ctx.ui.notify(`Iteration ${i}: rollback failed (${rb.output}); continuing with current state`, "warning");
            }
          } else if (regression.regressed) {
            ctx.ui.notify(`Iteration ${i}: REGRESSION detected (${regression.details.join("; ")})`, "warning");
          } else if (objectiveEvaluation?.accepted === false) {
            ctx.ui.notify(`Iteration ${i}: objective acceptance failed (${objectiveEvaluation.reason})`, "warning");
          }

          if (snapshotCreated && !tentativeSummary.rolledBack) {
            await dropSnapshot(pi, i);
          }

          const summary = tentativeSummary;
          loopState.iterationSummaries.push(summary);
          if (diffFp) loopState.diffFingerprints.push(diffFp);
          const persistedBeforeFinalPersist = readPersistedLoopState(ctx);
          const stopRequestedAfterSummary =
            loopState.stopRequested || Boolean(persistedBeforeFinalPersist?.active && persistedBeforeFinalPersist.stopRequested);
          loopState.stopRequested = stopRequestedAfterSummary;
          const compactSummaries = loopState.iterationSummaries.slice(-MAX_PERSIST_SUMMARIES);
          persistLoopState(pi, {
            active: true,
            sessionFile: loopState.loopSessionFile,
            iteration: loopState.iteration,
            maxIterations: loopState.maxIterations,
            minIterations: loopState.minIterations,
            iterationSummaries: compactSummaries,
            guardrails: { blockCommands: loopState.guardrails.blockCommands, protectedFiles: loopState.guardrails.protectedFiles },
            stopRequested: stopRequestedAfterSummary,
            specContent: loopState.specContent,
          });
          pi.appendEntry("ralph-iteration", { iteration: i, duration: elapsed, summary, ralphPath: loopState.ralphPath });

          if (timedOut) {
            ctx.ui.notify(`Iteration ${i} timed out after ${fm.timeout}s, stopping loop`, "warning");
            break;
          }

          // Provider error detection: classify and apply recovery policy
          const entriesForErrorCheck = ctx.sessionManager.getEntries();
          let providerErrorKind: ProviderErrorKind | null = null;
          for (let ei = entriesForErrorCheck.length - 1; ei >= iterationEntryStart; ei--) {
            providerErrorKind = classifyProviderError(entriesForErrorCheck[ei]);
            if (providerErrorKind) break;
          }
          if (providerErrorKind) {
            const policy = PROVIDER_ERROR_POLICIES[providerErrorKind];
            if (policy === "pause") {
              ctx.ui.notify(`Iteration ${i}: provider error (${providerErrorKind}) — pausing loop. Resume with /ralph when ready.`, "warning");
              break;
            } else if (policy === "stop") {
              ctx.ui.notify(`Iteration ${i}: provider error (${providerErrorKind}) — stopping loop.`, "error");
              break;
            } else if (policy === "retry") {
              const retryKey = `provider_retry_${providerErrorKind}`;
              const retryCount = (providerRetryCounts.get(retryKey) ?? 0) + 1;
              providerRetryCounts.set(retryKey, retryCount);
              if (retryCount > MAX_PROVIDER_RETRIES) {
                ctx.ui.notify(`Iteration ${i}: provider error (${providerErrorKind}) persisted after ${MAX_PROVIDER_RETRIES} retries — stopping.`, "error");
                break;
              }
              ctx.ui.notify(`Iteration ${i}: transient provider error (${providerErrorKind}), retrying after backoff (attempt ${retryCount}/${MAX_PROVIDER_RETRIES})…`, "warning");
              await new Promise(r => setTimeout(r, RATE_LIMIT_BACKOFF_MS * retryCount));
              loopState.iterationSummaries.pop();
              i--;
              continue;
            }
          } else {
            providerRetryCounts.clear();
          }

          const persistedAfter = readPersistedLoopState(ctx);
          if (persistedAfter?.active && persistedAfter.stopRequested) {
            loopState.stopRequested = true;
            ctx.ui.notify("Ralph loop stopping after current iteration…", "info");
            break;
          }

          if (fm.completionPromise) {
            const entries = ctx.sessionManager.getEntries();
            for (let ei = iterationEntryStart; ei < entries.length; ei++) {
              const entry = entries[ei];
              if (entry.type === "message" && entry.message?.role === "assistant") {
                const text = entry.message.content?.filter((b: any) => b.type === "text")?.map((b: any) => b.text)?.join("") ?? "";
                const match = text.match(/<promise>([^<]+)<\/promise>/);
                if (match && fm.completionPromise && match[1].trim() === fm.completionPromise.trim()) {
                  ctx.ui.notify(`Completion promise matched on iteration ${i}`, "info");
                  break iterationLoop;
                }
              }
            }
          }

          // Done criteria: re-run commands post-iteration for accurate verification (skipped until min_iterations reached)
          if (fm.doneCriteria?.length && i >= fm.minIterations) {
            const verifyOutputs = await runCommands(fm.commands, pi, fm.parallel);
            const verifySummaries = verifyOutputs.map((o, idx) => summarizeCommandOutput(o, fm.commands[idx]));
            const { allMet, unmet } = checkDoneCriteria(fm.doneCriteria, verifyOutputs);
            if (allMet && verifySummaries.every(cs => cs.status === "ok")) {
              ctx.ui.notify(`Iteration ${i}: all done criteria verified after agent work — loop complete`, "info");
              break iterationLoop;
            }
            if (unmet.length) {
              ctx.ui.notify(`Iteration ${i}: unmet criteria: ${unmet.join(", ")}`, "info");
            }
          }

          // Auto-completion: all commands green + no changes = task done (skipped until min_iterations reached)
          if (!hadChanges && !assistantRecap && commandSummaries.every(cs => cs.status === "ok") && i >= fm.minIterations) {
            const hadPriorWork = loopState.iterationSummaries.slice(0, -1).some(s => s.hadChanges || s.assistantRecap);
            if (hadPriorWork) {
              ctx.ui.notify(`Iteration ${i}: all checks pass, no changes needed — loop complete`, "info");
              break iterationLoop;
            }
          }

          // Diff repetition: same diff fingerprint as a previous iteration
          if (diffFp && loopState.diffFingerprints.slice(0, -1).includes(diffFp)) {
            const prevIter = loopState.iterationSummaries.find((s, idx) => idx < loopState.iterationSummaries.length - 1 && s.diffFingerprint === diffFp);
            ctx.ui.notify(`Iteration ${i}: repeated approach (same diff as iteration ${prevIter?.iteration ?? "?"}), stopping`, "warning");
            break iterationLoop;
          }

          // Green streak limit: too many consecutive all-green iterations with changes suggests diminishing returns
          if (fm.greenStreakLimit > 0) {
            const recentGreen = loopState.iterationSummaries.slice(-fm.greenStreakLimit);
            if (recentGreen.length >= fm.greenStreakLimit && recentGreen.every(s =>
              s.hadChanges && !s.regressed && s.commandSummaries.every(cs => cs.status === "ok")
            )) {
              ctx.ui.notify(`Iteration ${i}: ${fm.greenStreakLimit} consecutive green iterations — consider the task complete or refine RALPH.md`, "warning");
              break iterationLoop;
            }
          }

          // Convergence detection: no changes + metrics plateau over a window
          if (i >= fm.minIterations) {
            const convergence = detectConvergence(loopState.iterationSummaries, CONVERGENCE_WINDOW);
            if (convergence.converged) {
              ctx.ui.notify(`Iteration ${i}: converged — ${convergence.reason}`, "info");
              break iterationLoop;
            }
          }

          // Objective-met early stop: if objective is configured and current value is optimal, stop
          if (fm.objective && i >= fm.minIterations && objectiveEvaluation?.accepted !== false) {
            const meta = OBJECTIVE_META[fm.objective.metric];
            const mode = fm.objective.mode ?? meta.defaultMode;
            const currentVal = summary.signals[meta.signalKey];
            if (typeof currentVal === "number") {
              const isOptimal = mode === "minimize" ? currentVal === 0 : false;
              if (isOptimal && commandSummaries.every(cs => cs.status === "ok")) {
                ctx.ui.notify(`Iteration ${i}: objective "${fm.objective.metric}" reached optimal value (${currentVal}) — loop complete`, "info");
                break iterationLoop;
              }
            }
          }

          // Stall detection: N consecutive iterations with no changes and no recap
          const tail = loopState.iterationSummaries.slice(-STALL_THRESHOLD);
          if (tail.length >= STALL_THRESHOLD && tail.every(s => !s.hadChanges && !s.assistantRecap)) {
            ctx.ui.notify(`Ralph loop auto-stopping: ${STALL_THRESHOLD} consecutive iterations with no changes or progress`, "warning");
            break iterationLoop;
          }

          ctx.ui.notify(`Iteration ${i} complete (${elapsed}s)`, "info");
        }

        const total = loopState.iterationSummaries.reduce((a, s) => a + s.duration, 0);
        ctx.ui.notify(`Ralph loop done: ${loopState.iteration} iterations, ${total}s total`, "info");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Ralph loop failed: ${message}`, "error");
      } finally {
        failCounts.clear();
        onAgentEnd = undefined;
        loopState.active = false;
        loopState.stopRequested = false;
        loopState.loopSessionFile = undefined;
        loopState.diffFingerprints = [];
        ctx.ui.setStatus("ralph", undefined);
        persistLoopState(pi, { active: false });
      }
    },
  });

  pi.registerCommand("ralph-stop", {
    description: "Stop the ralph loop after the current iteration",
    handler: async (_args: string, ctx: any) => {
      const persisted = readPersistedLoopState(ctx);
      if (!persisted?.active) {
        if (!loopState.active) {
          ctx.ui.notify("No active ralph loop", "warning");
          return;
        }
        loopState.stopRequested = true;
        ctx.ui.notify("Ralph loop stopping after current iteration…", "info");
        return;
      }
      loopState.stopRequested = true;
      persistLoopState(pi, { ...persisted, stopRequested: true });
      ctx.ui.notify("Ralph loop stopping after current iteration…", "info");
    },
  });
}
