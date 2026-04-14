import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";

// --- Inlined from src/index.ts (must stay in sync) ---

type CommandDef = { name: string; run: string; timeout: number; maxOutput?: number; signalPatterns?: Record<string, string[]> };
type DoneCriterion = { name: string; command: string; pattern: string };
type Frontmatter = {
  commands: CommandDef[];
  maxIterations: number;
  timeout: number;
  completionPromise?: string;
  rollbackOnRegression: boolean;
  guardrails: { blockCommands: string[]; protectedFiles: string[] };
  doneCriteria?: DoneCriterion[];
  greenStreakLimit: number;
  parallel: boolean;
};
type ParsedRalph = { frontmatter: Frontmatter; body: string };

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
        doneCriteria.push({ name: "tests_green", command: "tests", pattern: "# fail 0|0 failed|0 failing" });
      }
      if (scripts.lint && !seen.has(scripts.lint)) {
        seen.add(scripts.lint);
        commands.push({ name: "lint", run: "npm run lint", timeout: 60, maxOutput: 2000 });
      }
      if (scripts.benchmark && !seen.has(scripts.benchmark)) {
        seen.add(scripts.benchmark);
        commands.push({ name: "benchmark", run: "npm run benchmark", timeout: 600, maxOutput: 6000 });
      } else if (scripts.bench && !seen.has(scripts.bench)) {
        seen.add(scripts.bench);
        commands.push({ name: "benchmark", run: "npm run bench", timeout: 600, maxOutput: 6000 });
      }
    } catch { /* malformed package.json */ }
  } else if (has("Cargo.toml")) {
    ecosystem = "rust";
    commands.push({ name: "tests", run: "cargo test", timeout: 300, maxOutput: 4000 });
    commands.push({ name: "lint", run: "cargo clippy -- -D warnings", timeout: 120, maxOutput: 2000 });
    doneCriteria.push({ name: "tests_green", command: "tests", pattern: "test result: ok" });
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
    doneCriteria.push({ name: "tests_green", command: "tests", pattern: "passed|0 failed" });
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

  const frontmatter: Frontmatter = {
    commands,
    maxIterations: 25,
    timeout: 300,
    rollbackOnRegression: true,
    guardrails: {
      blockCommands: [],
      protectedFiles: specFile ? [specFile] : [],
    },
    doneCriteria: doneCriteria.length ? doneCriteria : undefined,
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

// --- Tests ---

let tmpDir: string;

describe("discoverProject", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ralph-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for empty directory", () => {
    const result = discoverProject(tmpDir);
    assert.equal(result, null);
  });

  it("returns null for nonexistent directory", () => {
    const result = discoverProject(join(tmpDir, "nope"));
    assert.equal(result, null);
  });

  it("discovers Node.js project with test + lint + benchmark", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      scripts: { test: "node --test", lint: "eslint .", benchmark: "node bench.js" }
    }));
    const result = discoverProject(tmpDir);
    assert.ok(result);
    assert.equal(result.ecosystem, "node");
    assert.equal(result.commands.length, 3);
    assert.equal(result.commands[0].name, "tests");
    assert.equal(result.commands[1].name, "lint");
    assert.equal(result.commands[2].name, "benchmark");
    assert.ok(result.doneCriteria.length > 0);
  });

  it("deduplicates commands when lint === test", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      scripts: { test: "node --test", lint: "node --test" }
    }));
    const result = discoverProject(tmpDir);
    assert.ok(result);
    assert.equal(result.commands.length, 1, "should deduplicate identical scripts");
    assert.equal(result.commands[0].name, "tests");
  });

  it("discovers Node.js project with bench script", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      scripts: { test: "jest", bench: "node benchmarks.js" }
    }));
    const result = discoverProject(tmpDir);
    assert.ok(result);
    assert.equal(result.commands.length, 2);
    assert.equal(result.commands[1].run, "npm run bench");
  });

  it("discovers Rust project", () => {
    writeFileSync(join(tmpDir, "Cargo.toml"), "[package]\nname = \"test\"");
    const result = discoverProject(tmpDir);
    assert.ok(result);
    assert.equal(result.ecosystem, "rust");
    assert.equal(result.commands.length, 2);
    assert.equal(result.commands[0].run, "cargo test");
    assert.equal(result.commands[1].run, "cargo clippy -- -D warnings");
  });

  it("discovers Python project with pyproject.toml (pytest + ruff)", () => {
    writeFileSync(join(tmpDir, "pyproject.toml"), "[tool.pytest]\n[tool.ruff]\n");
    const result = discoverProject(tmpDir);
    assert.ok(result);
    assert.equal(result.ecosystem, "python");
    assert.equal(result.commands.length, 2);
    assert.equal(result.commands[0].run, "pytest");
    assert.equal(result.commands[1].run, "ruff check .");
  });

  it("discovers Python project with requirements.txt only", () => {
    writeFileSync(join(tmpDir, "requirements.txt"), "flask\n");
    const result = discoverProject(tmpDir);
    assert.ok(result);
    assert.equal(result.ecosystem, "python");
    assert.equal(result.commands[0].run, "pytest");
  });

  it("discovers Makefile project", () => {
    writeFileSync(join(tmpDir, "Makefile"), "test:\n\tgo test ./...\n");
    const result = discoverProject(tmpDir);
    assert.ok(result);
    assert.equal(result.ecosystem, "make");
    assert.equal(result.commands[0].run, "make test");
  });

  it("finds spec file", () => {
    writeFileSync(join(tmpDir, "specs.md"), "# Spec");
    const result = discoverProject(tmpDir);
    assert.ok(result);
    assert.equal(result.specFile, "specs.md");
  });

  it("finds README when no spec", () => {
    writeFileSync(join(tmpDir, "README.md"), "# Project");
    const result = discoverProject(tmpDir);
    assert.ok(result);
    assert.equal(result.readmeFile, "README.md");
    assert.equal(result.specFile, undefined);
  });

  it("returns non-null with only a spec file (no build system)", () => {
    writeFileSync(join(tmpDir, "TASK.md"), "# Tasks");
    const result = discoverProject(tmpDir);
    assert.ok(result);
    assert.equal(result.specFile, "TASK.md");
    assert.equal(result.commands.length, 0);
  });

  it("handles malformed package.json gracefully", () => {
    writeFileSync(join(tmpDir, "package.json"), "not json {{{");
    writeFileSync(join(tmpDir, "README.md"), "# Hi");
    const result = discoverProject(tmpDir);
    assert.ok(result);
    assert.equal(result.ecosystem, "node");
    assert.equal(result.commands.length, 0);
  });
});

describe("generateDefaultRalph", () => {
  it("generates optimized frontmatter for Node.js project", () => {
    const discovery: ProjectDiscovery = {
      projectName: "my-app",
      specFile: "specs.md",
      commands: [
        { name: "tests", run: "npm test", timeout: 120, maxOutput: 4000 },
        { name: "benchmark", run: "npm run benchmark", timeout: 600, maxOutput: 6000 },
      ],
      doneCriteria: [{ name: "tests_green", command: "tests", pattern: "# fail 0" }],
      ecosystem: "node",
    };
    const result = generateDefaultRalph(discovery);

    assert.equal(result.frontmatter.maxIterations, 25);
    assert.equal(result.frontmatter.rollbackOnRegression, true);
    assert.equal(result.frontmatter.greenStreakLimit, 10);
    assert.equal(result.frontmatter.parallel, true);
    assert.deepEqual(result.frontmatter.guardrails.protectedFiles, ["specs.md"]);
    assert.ok(result.frontmatter.doneCriteria);
    assert.equal(result.frontmatter.doneCriteria!.length, 1);
  });

  it("includes spec reference in body", () => {
    const discovery: ProjectDiscovery = {
      projectName: "proj",
      specFile: "SPEC.md",
      commands: [],
      doneCriteria: [],
      ecosystem: "unknown",
    };
    const result = generateDefaultRalph(discovery);
    assert.ok(result.body.includes("`SPEC.md`"));
  });

  it("includes command placeholders in body", () => {
    const discovery: ProjectDiscovery = {
      projectName: "proj",
      readmeFile: "README.md",
      commands: [
        { name: "tests", run: "npm test", timeout: 120 },
        { name: "lint", run: "npm run lint", timeout: 60 },
      ],
      doneCriteria: [],
      ecosystem: "node",
    };
    const result = generateDefaultRalph(discovery);
    assert.ok(result.body.includes("{{ commands.tests }}"));
    assert.ok(result.body.includes("{{ commands.lint }}"));
    assert.ok(result.body.includes("{{ git.log }}"));
  });

  it("falls back to generic instruction when no spec or readme", () => {
    const discovery: ProjectDiscovery = {
      projectName: "bare",
      commands: [{ name: "tests", run: "make test", timeout: 300 }],
      doneCriteria: [],
      ecosystem: "make",
    };
    const result = generateDefaultRalph(discovery);
    assert.ok(result.body.includes("Analyze the existing codebase"));
  });

  it("sets parallel=false for single command", () => {
    const discovery: ProjectDiscovery = {
      projectName: "solo",
      specFile: "specs.md",
      commands: [{ name: "tests", run: "cargo test", timeout: 300 }],
      doneCriteria: [],
      ecosystem: "rust",
    };
    const result = generateDefaultRalph(discovery);
    assert.equal(result.frontmatter.parallel, false);
  });
});
