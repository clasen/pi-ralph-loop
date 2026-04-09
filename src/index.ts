import { parse as parseYaml } from "yaml";
import { minimatch } from "minimatch";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// --- Types ---

type CommandDef = { name: string; run: string; timeout: number };

type Frontmatter = {
  commands: CommandDef[];
  maxIterations: number;
  guardrails: { blockCommands: string[]; protectedFiles: string[] };
};

type ParsedRalph = { frontmatter: Frontmatter; body: string };
type CommandOutput = { name: string; output: string };

type LoopState = {
  active: boolean;
  ralphPath: string;
  iteration: number;
  maxIterations: number;
  stopRequested: boolean;
  failCount: number;
  iterationSummaries: Array<{ iteration: number; duration: number }>;
  guardrails: { blockCommands: RegExp[]; protectedFiles: string[] };
};

// --- Parsing ---

function defaultFrontmatter(): Frontmatter {
  return { commands: [], maxIterations: 50, guardrails: { blockCommands: [], protectedFiles: [] } };
}

function parseRalphMd(filePath: string): ParsedRalph {
  const raw = readFileSync(filePath, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: defaultFrontmatter(), body: raw };

  const yaml = parseYaml(match[1]) ?? {};
  const commands: CommandDef[] = Array.isArray(yaml.commands)
    ? yaml.commands.map((c: Record<string, unknown>) => ({
        name: String(c.name ?? ""),
        run: String(c.run ?? ""),
        timeout: Number(c.timeout ?? 60),
      }))
    : [];

  const guardrails = yaml.guardrails ?? {};
  return {
    frontmatter: {
      commands,
      maxIterations: Number(yaml.max_iterations ?? 50),
      guardrails: {
        blockCommands: Array.isArray(guardrails.block_commands) ? guardrails.block_commands : [],
        protectedFiles: Array.isArray(guardrails.protected_files) ? guardrails.protected_files : [],
      },
    },
    body: match[2],
  };
}

function resolveRalphPath(args: string, cwd: string): string {
  const target = args.trim() || ".";
  const abs = resolve(cwd, target);
  if (existsSync(abs) && abs.endsWith(".md")) return abs;
  if (existsSync(join(abs, "RALPH.md"))) return join(abs, "RALPH.md");
  throw new Error(`No RALPH.md found at ${abs}`);
}

function resolvePlaceholders(body: string, outputs: CommandOutput[]): string {
  const map = new Map(outputs.map((o) => [o.name, o.output]));
  return body.replace(/\{\{\s*commands\.(\w[\w-]*)\s*\}\}/g, (_, name) => map.get(name) ?? "");
}

function parseGuardrails(fm: Frontmatter): LoopState["guardrails"] {
  return {
    blockCommands: fm.guardrails.blockCommands.map((p) => new RegExp(p)),
    protectedFiles: fm.guardrails.protectedFiles,
  };
}

// --- Command execution ---

async function runCommands(
  commands: CommandDef[],
  cwd: string,
  pi: ExtensionAPI,
): Promise<CommandOutput[]> {
  const results: CommandOutput[] = [];
  for (const cmd of commands) {
    try {
      const result = await pi.exec("bash", ["-c", cmd.run], { timeout: cmd.timeout * 1000 });
      results.push({
        name: cmd.name,
        output: (result.stdout + result.stderr).trim(),
      });
    } catch {
      results.push({ name: cmd.name, output: `[timed out after ${cmd.timeout}s]` });
    }
  }
  return results;
}

// --- Extension ---

let loopState: LoopState = {
  active: false,
  ralphPath: "",
  iteration: 0,
  maxIterations: 50,
  stopRequested: false,
  failCount: 0,
  iterationSummaries: [],
  guardrails: { blockCommands: [], protectedFiles: [] },
};

export default function (pi: ExtensionAPI) {
  // Guardrails: block dangerous tool calls during loop
  pi.on("tool_call", async (event) => {
    if (!loopState.active) return;

    if (event.toolName === "bash") {
      const cmd = (event.input as { command?: string }).command ?? "";
      for (const pattern of loopState.guardrails.blockCommands) {
        if (pattern.test(cmd)) {
          return { block: true, reason: `ralph: blocked (${pattern.source})` };
        }
      }
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const filePath = (event.input as { path?: string }).path ?? "";
      for (const glob of loopState.guardrails.protectedFiles) {
        if (minimatch(filePath, glob, { matchBase: true })) {
          return { block: true, reason: `ralph: ${filePath} is protected` };
        }
      }
    }
  });

  // Cross-iteration memory: inject context into system prompt
  pi.on("before_agent_start", async (event) => {
    if (!loopState.active || loopState.iterationSummaries.length === 0) return;

    const history = loopState.iterationSummaries
      .map((s) => `- Iteration ${s.iteration}: ${s.duration}s`)
      .join("\n");

    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Ralph Loop Context\nIteration ${loopState.iteration}/${loopState.maxIterations}\n\nPrevious iterations:\n${history}\n\nDo not repeat completed work. Check git log for recent changes.`,
    };
  });

  // Mid-turn steering: warn after repeated failures
  pi.on("tool_result", async (event) => {
    if (!loopState.active || event.toolName !== "bash") return;

    const output = event.content
      .map((c: { type: string; text?: string }) => (c.type === "text" ? c.text ?? "" : ""))
      .join("");

    if (/FAIL|ERROR|error:|failed/i.test(output)) {
      loopState.failCount++;
    }

    if (loopState.failCount >= 3) {
      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text: "\n\n⚠️ ralph: 3+ failures this iteration. Stop and describe the root cause before retrying.",
          },
        ],
      };
    }
  });

  // /ralph command: start the loop
  pi.registerCommand("ralph", {
    description: "Start an autonomous ralph loop from a RALPH.md file",
    handler: async (args, ctx) => {
      if (loopState.active) {
        ctx.ui.notify("A ralph loop is already running. Use /ralph-stop first.", "warning");
        return;
      }

      let ralphPath: string;
      try {
        ralphPath = resolveRalphPath(args ?? "", ctx.cwd);
      } catch (err) {
        ctx.ui.notify(String(err), "error");
        return;
      }

      const { frontmatter } = parseRalphMd(ralphPath);
      loopState = {
        active: true,
        ralphPath,
        iteration: 0,
        maxIterations: frontmatter.maxIterations,
        stopRequested: false,
        failCount: 0,
        iterationSummaries: [],
        guardrails: parseGuardrails(frontmatter),
      };

      const name = basename(dirname(ralphPath));
      ctx.ui.notify(`Ralph loop started: ${name} (max ${loopState.maxIterations} iterations)`, "info");

      for (let i = 1; i <= loopState.maxIterations; i++) {
        if (loopState.stopRequested) break;

        loopState.iteration = i;
        loopState.failCount = 0;
        const iterStart = Date.now();

        // Re-parse every iteration (live editing support)
        const { frontmatter: fm, body } = parseRalphMd(loopState.ralphPath);
        loopState.maxIterations = fm.maxIterations;
        loopState.guardrails = parseGuardrails(fm);

        // Run commands and resolve placeholders
        const outputs = await runCommands(fm.commands, ctx.cwd, pi);
        const header = `[ralph: iteration ${i}/${loopState.maxIterations}]\n\n`;
        const prompt = header + resolvePlaceholders(body, outputs);

        // Fresh session
        ctx.ui.setStatus("ralph", `🔁 ${name}: iteration ${i}/${loopState.maxIterations}`);
        await ctx.newSession();

        // Send prompt and wait for agent to finish
        pi.sendUserMessage(prompt);
        await ctx.waitForIdle();

        // Record iteration
        const elapsed = Math.round((Date.now() - iterStart) / 1000);
        loopState.iterationSummaries.push({ iteration: i, duration: elapsed });
        pi.appendEntry("ralph-iteration", { iteration: i, duration: elapsed, ralphPath: loopState.ralphPath });

        ctx.ui.notify(`Iteration ${i} complete (${elapsed}s)`, "info");
      }

      loopState.active = false;
      ctx.ui.setStatus("ralph", undefined);
      const total = loopState.iterationSummaries.reduce((a, s) => a + s.duration, 0);
      ctx.ui.notify(
        `Ralph loop done: ${loopState.iteration} iterations, ${total}s total`,
        "info",
      );
    },
  });

  // /ralph-stop command: graceful stop
  pi.registerCommand("ralph-stop", {
    description: "Stop the ralph loop after the current iteration",
    handler: async (_args, ctx) => {
      if (!loopState.active) {
        ctx.ui.notify("No active ralph loop", "warning");
        return;
      }
      loopState.stopRequested = true;
      ctx.ui.notify("Ralph loop stopping after current iteration…", "info");
    },
  });
}
