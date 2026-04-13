import { parse as parseYaml } from "yaml";
import { minimatch } from "minimatch";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type CommandDef = { name: string; run: string; timeout: number };
type Frontmatter = {
  commands: CommandDef[];
  maxIterations: number;
  timeout: number;
  completionPromise?: string;
  rollbackOnRegression: boolean;
  guardrails: { blockCommands: string[]; protectedFiles: string[] };
};
type ParsedRalph = { frontmatter: Frontmatter; body: string };
type CommandOutput = { name: string; output: string };
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
};
type LoopState = {
  active: boolean;
  ralphPath: string;
  iteration: number;
  maxIterations: number;
  timeout: number;
  completionPromise?: string;
  rollbackOnRegression: boolean;
  stopRequested: boolean;
  iterationSummaries: IterationSummary[];
  guardrails: { blockCommands: string[]; protectedFiles: string[] };
  loopSessionFile?: string;
};
type PersistedLoopState = {
  active: boolean;
  sessionFile?: string;
  iteration?: number;
  maxIterations?: number;
  iterationSummaries?: IterationSummary[];
  guardrails?: { blockCommands: string[]; protectedFiles: string[] };
  stopRequested?: boolean;
};

function defaultFrontmatter(): Frontmatter {
  return { commands: [], maxIterations: 50, timeout: 300, rollbackOnRegression: false, guardrails: { blockCommands: [], protectedFiles: [] } };
}

function parseRalphMd(filePath: string): ParsedRalph {
  let raw = readFileSync(filePath, "utf8");
  raw = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: defaultFrontmatter(), body: raw };

  const yaml = (parseYaml(match[1]) ?? {}) as Record<string, any>;
  const commands: CommandDef[] = Array.isArray(yaml.commands)
    ? yaml.commands.map((c: Record<string, any>) => ({ name: String(c.name ?? ""), run: String(c.run ?? ""), timeout: Number(c.timeout ?? 60) }))
    : [];
  const guardrails = (yaml.guardrails ?? {}) as Record<string, any>;

  return {
    frontmatter: {
      commands,
      maxIterations: Number(yaml.max_iterations ?? 50),
      timeout: Number(yaml.timeout ?? 300),
      completionPromise:
        typeof yaml.completion_promise === "string" && yaml.completion_promise.trim() ? yaml.completion_promise : undefined,
      rollbackOnRegression: yaml.rollback_on_regression === true,
      guardrails: {
        blockCommands: Array.isArray(guardrails.block_commands) ? guardrails.block_commands.map((p: unknown) => String(p)) : [],
        protectedFiles: Array.isArray(guardrails.protected_files) ? guardrails.protected_files.map((p: unknown) => String(p)) : [],
      },
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
  return true;
}

function resolveRalphPath(args: string, cwd: string): string {
  const target = args.trim() || ".";
  const abs = resolve(cwd, target);
  if (existsSync(abs) && abs.endsWith(".md")) return abs;
  if (existsSync(join(abs, "RALPH.md"))) return join(abs, "RALPH.md");
  throw new Error(`No RALPH.md found at ${abs}`);
}

function resolvePlaceholders(body: string, outputs: CommandOutput[], ralph: { iteration: number; name: string }): string {
  const map = new Map(outputs.map((o) => [o.name, o.output]));
  return body
    .replace(/\{\{\s*commands\.(\w[\w-]*)\s*\}\}/g, (_, name) => map.get(name) ?? "")
    .replace(/\{\{\s*ralph\.iteration\s*\}\}/g, String(ralph.iteration))
    .replace(/\{\{\s*ralph\.name\s*\}\}/g, ralph.name);
}

const MAX_ASSISTANT_RECAP = 800;
const MAX_COMMAND_EXCERPT = 220;
const MAX_CONTEXT_ITERATIONS = 5;

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

function extractCommandSignals(output: string): CommandSignals {
  return {
    testFailures: extractCount(output, [/\b(\d+)\s+failed\b/gi, /\bfailures?:\s*(\d+)\b/gi]),
    testPassed: extractCount(output, [/\b(\d+)\s+passed\b/gi, /\bpasses?:\s*(\d+)\b/gi]),
    lintErrors: extractCount(output, [/\b(\d+)\s+errors?\b/gi]),
    lintWarnings: extractCount(output, [/\b(\d+)\s+warnings?\b/gi]),
  };
}

function summarizeCommandOutput(output: CommandOutput): IterationCommandSummary {
  const trimmed = output.output.trim();
  const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
  const excerpt = truncateText(normalizeWhitespace(lines.slice(Math.max(0, lines.length - 6)).join(" ")), MAX_COMMAND_EXCERPT);

  let status: CommandSummaryStatus = "ok";
  if (/^\[timed out after \d+s\]$/i.test(trimmed)) status = "timed_out";
  else if (/^\[error:/i.test(trimmed)) status = "error";
  else if (/\bFAIL(?:ED)?\b|\bERROR\b|error:|failed/i.test(trimmed)) status = "failed";

  return {
    name: output.name,
    status,
    excerpt,
    signals: extractCommandSignals(trimmed),
  };
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
      return `- Iteration ${summary.iteration} (${summary.duration}s)${regressionLabel}\n  - recap: ${recap}\n  - ${aggregateLine}\n  - commands: ${commandLine}${rollbackNote}`;
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

function latestAssistantRecap(entries: any[], startIndex: number): string {
  for (let i = entries.length - 1; i >= startIndex; i--) {
    const text = extractAssistantText(entries[i]);
    if (text) return truncateText(text, MAX_ASSISTANT_RECAP);
  }
  return "";
}

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

async function runCommands(commands: CommandDef[], pi: ExtensionAPI): Promise<CommandOutput[]> {
  const results: CommandOutput[] = [];
  for (const cmd of commands) {
    try {
      const result = await pi.exec("bash", ["-c", cmd.run], { timeout: cmd.timeout * 1000 });
      results.push(result.killed
        ? { name: cmd.name, output: `[timed out after ${cmd.timeout}s]` }
        : { name: cmd.name, output: (result.stdout + result.stderr).trim() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ name: cmd.name, output: `[error: ${message}]` });
    }
  }
  return results;
}

function defaultLoopState(): LoopState {
  return { active: false, ralphPath: "", iteration: 0, maxIterations: 50, timeout: 300, completionPromise: undefined, rollbackOnRegression: false, stopRequested: false, iterationSummaries: [], guardrails: { blockCommands: [], protectedFiles: [] }, loopSessionFile: undefined };
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
    const summaries = (persisted?.iterationSummaries ?? []).map(normalizeIterationSummary).filter((s) => s.iteration > 0);
    if (summaries.length === 0) return;
    const history = buildIterationContext(summaries);
    const trendLine = buildTrendLine(summaries);
    const regression = detectRegression(summaries);

    let contextBlock = `\n\n## Ralph Loop Context\nIteration ${persisted?.iteration ?? 0}/${persisted?.maxIterations ?? 0}\n\nPrevious iteration recap:\n${history}`;

    if (trendLine) {
      contextBlock += `\n\nProgress trend:\n${trendLine}`;
    }

    const lastSummary = summaries[summaries.length - 1];
    if (lastSummary?.rolledBack) {
      contextBlock += `\n\n⚠️ AUTOMATIC ROLLBACK: The previous iteration's changes were automatically reverted because of regression (${lastSummary.rollbackDetails ?? regression.details.join("; ")}). The working tree is back to the state BEFORE that iteration. Try a fundamentally different approach.`;
    } else if (regression.regressed) {
      contextBlock += `\n\n⚠️ REGRESSION DETECTED: ${regression.details.join("; ")}. The last iteration made things WORSE. Consider reverting your last changes (for example with git restore or by resetting the last commit) and trying a different approach.`;
    }

    contextBlock += `\n\nUse this recap to avoid repeating failed approaches and continue from the best progress made so far.`;

    return { systemPrompt: event.systemPrompt + contextBlock };
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    if (!isLoopSession(ctx) || event.toolName !== "bash") return;
    const output = event.content.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text ?? "" : "")).join("");
    if (!/FAIL|ERROR|error:|failed/i.test(output)) return;

    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;

    const next = (failCounts.get(sessionFile) ?? 0) + 1;
    failCounts.set(sessionFile, next);
    if (next >= 3) {
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: "\n\n⚠️ ralph: 3+ failures this iteration. Stop and describe the root cause before retrying." },
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
    description: "Start an autonomous ralph loop from a RALPH.md file",
    handler: async (args: string, ctx: any) => {
      if (loopState.active) {
        ctx.ui.notify("A ralph loop is already running. Use /ralph-stop first.", "warning");
        return;
      }

      let name: string;
      try {
        const ralphPath = resolveRalphPath(args ?? "", ctx.cwd);
        const { frontmatter } = parseRalphMd(ralphPath);
        if (!validateFrontmatter(frontmatter, ctx)) return;
        name = basename(dirname(ralphPath));
        loopState = {
          active: true,
          ralphPath,
          iteration: 0,
          maxIterations: frontmatter.maxIterations,
          timeout: frontmatter.timeout,
          completionPromise: frontmatter.completionPromise,
          rollbackOnRegression: frontmatter.rollbackOnRegression,
          stopRequested: false,
          iterationSummaries: [],
          guardrails: { blockCommands: frontmatter.guardrails.blockCommands, protectedFiles: frontmatter.guardrails.protectedFiles },
          loopSessionFile: undefined,
        };
      } catch (err) {
        ctx.ui.notify(String(err), "error");
        return;
      }
      ctx.ui.notify(`Ralph loop started: ${name} (max ${loopState.maxIterations} iterations)`, "info");
      loopState.loopSessionFile = ctx.sessionManager.getSessionFile();
      if (loopState.loopSessionFile) failCounts.set(loopState.loopSessionFile, 0);
      persistLoopState(pi, {
        active: true,
        sessionFile: loopState.loopSessionFile,
        iteration: loopState.iteration,
        maxIterations: loopState.maxIterations,
        iterationSummaries: loopState.iterationSummaries,
        guardrails: { blockCommands: loopState.guardrails.blockCommands, protectedFiles: loopState.guardrails.protectedFiles },
        stopRequested: false,
      });

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
          const { frontmatter: fm, body: rawBody } = parseRalphMd(loopState.ralphPath);
          if (!validateFrontmatter(fm, ctx)) {
            ctx.ui.notify(`Invalid RALPH.md on iteration ${i}, stopping loop`, "error");
            break;
          }

          loopState.maxIterations = fm.maxIterations;
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

          const outputs = await runCommands(fm.commands, pi);
          let body = resolvePlaceholders(rawBody, outputs, { iteration: i, name });
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
            iterationSummaries: loopState.iterationSummaries,
            guardrails: { blockCommands: loopState.guardrails.blockCommands, protectedFiles: loopState.guardrails.protectedFiles },
            stopRequested,
          });

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
          const commandSummaries = outputs.map(summarizeCommandOutput);
          const entriesAfterIteration = ctx.sessionManager.getEntries();
          const assistantRecap = latestAssistantRecap(entriesAfterIteration, iterationEntryStart);
          const signals = aggregateSignals(commandSummaries);
          const tentativeSummary: IterationSummary = {
            iteration: i,
            duration: elapsed,
            assistantRecap,
            commandSummaries,
            signals,
          };
          const regression = detectRegression([...loopState.iterationSummaries, tentativeSummary]);
          tentativeSummary.regressed = regression.regressed;

          if (regression.regressed && snapshotCreated && loopState.rollbackOnRegression) {
            const rb = await rollbackToSnapshot(pi, i);
            if (rb.ok) {
              tentativeSummary.rolledBack = true;
              tentativeSummary.rollbackDetails = regression.details.join("; ");
              ctx.ui.notify(`Iteration ${i}: REGRESSION rolled back (${regression.details.join("; ")})`, "warning");
            } else {
              ctx.ui.notify(`Iteration ${i}: rollback failed (${rb.output}); continuing with regressed state`, "warning");
            }
          } else if (regression.regressed) {
            ctx.ui.notify(`Iteration ${i}: REGRESSION detected (${regression.details.join("; ")})`, "warning");
          }

          if (snapshotCreated && !tentativeSummary.rolledBack) {
            await dropSnapshot(pi, i);
          }

          const summary = tentativeSummary;
          loopState.iterationSummaries.push(summary);
          const persistedBeforeFinalPersist = readPersistedLoopState(ctx);
          const stopRequestedAfterSummary =
            loopState.stopRequested || Boolean(persistedBeforeFinalPersist?.active && persistedBeforeFinalPersist.stopRequested);
          loopState.stopRequested = stopRequestedAfterSummary;
          persistLoopState(pi, {
            active: true,
            sessionFile: loopState.loopSessionFile,
            iteration: loopState.iteration,
            maxIterations: loopState.maxIterations,
            iterationSummaries: loopState.iterationSummaries,
            guardrails: { blockCommands: loopState.guardrails.blockCommands, protectedFiles: loopState.guardrails.protectedFiles },
            stopRequested: stopRequestedAfterSummary,
          });
          pi.appendEntry("ralph-iteration", { iteration: i, duration: elapsed, summary, ralphPath: loopState.ralphPath });

          if (timedOut) {
            ctx.ui.notify(`Iteration ${i} timed out after ${fm.timeout}s, stopping loop`, "warning");
            break;
          }

          const persistedAfter = readPersistedLoopState(ctx);
          if (persistedAfter?.active && persistedAfter.stopRequested) {
            loopState.stopRequested = true;
            ctx.ui.notify("Ralph loop stopping after current iteration…", "info");
            break;
          }

          if (fm.completionPromise) {
            const entries = ctx.sessionManager.getEntries();
            for (const entry of entries) {
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
