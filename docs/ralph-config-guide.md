# RALPH.md Configuration Guide

## Recommended configuration for large spec-driven tasks

```yaml
---
max_iterations: 30
timeout: 300
rollback_on_regression: true
green_streak_limit: 10
parallel: true

commands:
  - name: tests
    run: npm test
    timeout: 120
    max_output: 4000

  - name: lint
    run: npx eslint src/ --format compact
    timeout: 60
    max_output: 2000

  - name: benchmark
    run: node benchmark.js
    timeout: 600
    max_output: 6000

done_criteria:
  - name: tests_green
    command: tests
    pattern: "# fail 0"
  - name: benchmark_complete
    command: benchmark
    pattern: "ops/s"
  - name: no_lint_errors
    command: lint
    pattern: "^$|0 errors"

guardrails:
  block_commands:
    - "rm -rf /"
    - "git push"
  protected_files:
    - "RALPH.md"
    - "specs.md"
---
```

## Key settings explained

### `green_streak_limit`

Stops the loop after N consecutive iterations where all commands pass and
changes were made. Prevents the agent from endlessly adding micro-refinements
when the core task is done.

**Recommendation:** Set to 8-12 for large tasks, 3-5 for small focused tasks.
Set to 0 (default) to disable.

### `done_criteria`

Explicit gates tied to your spec. Each criterion checks a command's output
against a regex pattern. The loop stops only when **all** criteria match and
all commands pass.

Use this to connect the loop to real acceptance criteria instead of relying
on convergence heuristics.

### `max_output` per command

Limits the raw output injected into the prompt. Preserves the head (first
~30%) and tail (~70%) of the output, which is where summaries and errors
typically appear.

**Recommendation:** 2000-6000 chars depending on verbosity. Without this,
a noisy test suite can fill the context window and drown the signal.

### `parallel`

Runs commands concurrently via `Promise.all`. Use when commands are
independent (e.g., tests and lint don't share state).

### `rollback_on_regression`

Creates a git stash snapshot before each iteration. If test counts regress,
automatically reverts to the snapshot and tells the agent to try a different
approach.

### `signal_patterns` per command

Override the default regex patterns for extracting metrics from a specific
command's output. Useful for non-standard test runners.

```yaml
commands:
  - name: tests
    run: cargo test
    timeout: 120
    signal_patterns:
      testPassed: ["(\\d+) passed"]
      testFailures: ["(\\d+) failed"]
```

## Common pitfalls to avoid

1. **Don't duplicate commands** -- if `npm run lint` runs the same tests as
   `npm test`, you're paying for two executions per iteration with no new signal.

2. **Set `max_iterations` conservatively** -- 50 iterations is rarely needed.
   20-30 is usually sufficient. Pair with `green_streak_limit` to exit early.

3. **Use `{{ git.diff }}` and `{{ git.log }}`** in your prompt body to give
   the agent context about recent changes without wasting a tool call:

   ```markdown
   ## Recent changes
   {{ git.log }}

   ## Last diff
   {{ git.diff }}
   ```

4. **Write specific `done_criteria`** -- "all tests pass" is necessary but
   not sufficient. Add criteria for benchmark results, coverage, specific
   output patterns that prove spec compliance.

## Template for spec-driven tasks

```markdown
---
max_iterations: 25
timeout: 300
rollback_on_regression: true
green_streak_limit: 8

commands:
  - name: tests
    run: npm test
    timeout: 120
    max_output: 4000
  - name: benchmark
    run: node benchmark.js
    timeout: 300
    max_output: 6000

done_criteria:
  - name: tests_pass
    command: tests
    pattern: "# fail 0"
  - name: benchmark_targets
    command: benchmark
    pattern: "ALL TARGETS MET"
---

# Task Loop

You are implementing [project name] per `specs.md`.

## Test Results
{{ commands.tests }}

## Benchmark Results
{{ commands.benchmark }}

## Recent Changes
{{ git.log }}

## Iteration {{ ralph.iteration }}

1. Review test and benchmark output
2. Identify the highest-priority gap vs specs.md
3. Implement the fix — batch related changes together
4. Verify tests pass before committing
5. Commit with a descriptive message

Focus on spec compliance, not micro-optimizations.
```
