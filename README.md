# pi-ralph

Autonomous coding loops for pi with mid-turn supervision.

This project is a fork of `@lnilluv/pi-ralph-loop` with additional reliability and safety improvements for iterative coding loops.

## Install

```bash
pi install git:https://github.com/clasen/pi-ralph-loop
```

## What's changed in this fork

- Command output injection with `{{ commands.<name> }}` placeholders.
- Session-scoped guardrails (`block_commands`, `protected_files`).
- Cross-iteration memory injected into the next run.
- Mid-turn steering after repeated failures in the same iteration.
- Completion promise support via `<promise>DONE</promise>`.
- Per-iteration timeout to avoid stuck runs.
- Frontmatter input validation before and during loop execution.
- Automatic rollback on regression with optional `git stash` recovery.

## Quick start

### Option A: explicit `RALPH.md`

```md
# my-task/RALPH.md
---
commands:
  - name: tests
    run: npm test -- --runInBand
    timeout: 60
---
Fix failing tests using this output:

{{ commands.tests }}
```

Run `/ralph my-task` in pi.

### Option B: no `RALPH.md` (auto mode)

If `RALPH.md` is missing, `/ralph` auto-detects project context and generates a loop config:

- Detects ecosystem and commands from files like `package.json`, `Cargo.toml`, `pyproject.toml`, or `Makefile`.
- Looks for project docs (`specs.md`, `spec.md`, `TASK.md`, `TODO.md`, and `README*`).
- Injects that documentation as authoritative context so the agent can implement against it.
- Enables safe defaults (including regression rollback and guardrails) that you can later override by adding a `RALPH.md`.

Run `/ralph` from the project root to use this mode.

## How it works

On each iteration, pi-ralph reads `RALPH.md` (or uses auto-generated config if `RALPH.md` is missing), runs the configured commands, injects their output into the prompt through `{{ commands.<name> }}` placeholders, starts a fresh session, sends the prompt, and waits for completion. Failed test output appears in the next iteration, which creates a self-healing loop.

## RALPH.md format

```md
---
commands:
  - name: tests
    run: npm test -- --runInBand
    timeout: 90
  - name: lint
    run: npm run lint
    timeout: 60
max_iterations: 25
timeout: 300
completion_promise: "DONE"
rollback_on_regression: true
objective:
  metric: test_failures
  mode: minimize
acceptance_rule: non_regression
guardrails:
  block_commands:
    - "rm\\s+-rf\\s+/"
    - "git\\s+push"
  protected_files:
    - ".env*"
    - "**/secrets/**"
---
You are fixing flaky tests in the auth module.

<!-- This comment is stripped before sending to the agent -->

Latest test output:
{{ commands.tests }}

Latest lint output:
{{ commands.lint }}

Iteration {{ ralph.iteration }} of {{ ralph.name }}.
Apply the smallest safe fix and explain why it works.
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `commands` | array | `[]` | Commands to run each iteration |
| `commands[].name` | string | required | Key for `{{ commands.<name> }}` |
| `commands[].run` | string | required | Shell command |
| `commands[].timeout` | number | `60` | Seconds before kill |
| `commands[].run_every` | number | — | Run only every N iterations (always runs on iteration 1 and last) |
| `max_iterations` | number | `50` | Stop after N iterations |
| `timeout` | number | `300` | Per-iteration timeout in seconds; stops the loop if the agent is stuck |
| `completion_promise` | string | — | Agent signals completion by sending `<promise>DONE</promise>`; loop breaks on match |
| `rollback_on_regression` | boolean | `false` | Auto-revert working tree via `git stash` when metrics regress between iterations |
| `objective` | string/object | — | Objective metric used to accept/reject each iteration (`test_failures`, `tests_passed`, `lint_errors`, `lint_warnings`) |
| `objective.metric` | string | required if `objective` is set | Metric to optimize |
| `objective.mode` | string | metric default | `minimize` or `maximize`; defaults depend on metric |
| `acceptance_rule` | string | `non_regression` | `non_regression` (allow equal) or `strict_improvement` (must improve) |
| `guardrails.block_commands` | string[] | `[]` | Regex patterns to block in bash |
| `guardrails.protected_files` | string[] | `[]` | Glob patterns to block writes |

### Placeholders

| Placeholder | Description |
|-------------|-------------|
| `{{ commands.<name> }}` | Output from the named command |
| `{{ ralph.iteration }}` | Current 1-based iteration number |
| `{{ ralph.name }}` | Directory name containing the RALPH.md |

HTML comments (`<!-- ... -->`) are stripped from the prompt body after placeholder resolution, so you can annotate your RALPH.md freely.

## Commands

- `/ralph <path>`: Start from a `RALPH.md` file/directory, or auto-detect project config when `RALPH.md` is absent.
- `/ralph-stop`: Request a graceful stop after the current iteration.

## Pi-only features

### Guardrails

`guardrails.block_commands` and `guardrails.protected_files` come from RALPH frontmatter. The extension enforces them in the `tool_call` hook — but only for sessions created by the loop, so they don't leak into unrelated conversations. Matching bash commands are blocked, and writes/edits to protected file globs are denied.

### Cross-iteration memory

After each iteration, the extension stores a short summary with iteration number and duration. In `before_agent_start`, it injects that history into the system prompt so the next run can avoid repeating completed work.

### Mid-turn steering

In the `tool_result` hook, bash outputs are scanned for failure patterns. After three or more failures in the same iteration, the extension appends a stop-and-think warning to push root-cause analysis before another retry.

### Completion promise

When `completion_promise` is set (e.g., `"DONE"`), the loop scans the agent's messages for `<promise>DONE</promise>` after each iteration. If found, the loop stops early — the agent signals it's finished rather than relying solely on `max_iterations`.

### Iteration timeout

Each iteration has a configurable timeout (default 300 seconds). If the agent is stuck and doesn't become idle within the timeout, the loop stops with a warning. This prevents runaway iterations from running forever.

### Provider error handling

When the model returns an error (quota exceeded, rate limit, auth failure, network issue), the extension classifies it and applies the appropriate recovery policy:

- **quota_exceeded**: pauses the loop immediately (no more iterations wasted).
- **rate_limit / transient**: retries with exponential backoff (up to 2 retries).
- **auth / unknown**: stops the loop.

### Convergence detection

After `min_iterations`, if the last N iterations (default 3) produced no file changes and all tracked metrics are stable, the loop stops automatically. This prevents wasting iterations when the task is effectively done.

### Adaptive command scheduling

Commands with `run_every: N` only execute on matching iterations (always on iteration 1 and the last). In auto-mode, benchmarks default to `run_every: 3` to reduce overhead on iterations focused on correctness.

### Automatic rollback on regression

When `rollback_on_regression: true` is set, the extension creates a `git stash` snapshot before each iteration (starting from iteration 2). After the agent finishes, metrics are compared to the previous iteration. If a regression is detected (more test failures, fewer tests passing, or more lint errors), the working tree is automatically reverted to the pre-iteration state and the stash is consumed. The next iteration's system prompt explicitly tells the agent that the changes were rolled back and why, so it can try a different approach instead of building on broken code.

Requirements: the project must be inside a git repository. If git is unavailable or the stash operation fails, the loop continues normally with a warning — it never breaks the loop.

### Objective-based acceptance (minimal autoresearch behavior)

Use `objective` + `acceptance_rule` to enforce a single primary metric for keep/reject decisions:

- Example objective: minimize `test_failures` or maximize `tests_passed`.
- `non_regression`: keep equal-or-better iterations.
- `strict_improvement`: require strict improvement each iteration (after baseline).

If `rollback_on_regression: true` is enabled, an iteration that fails the objective acceptance rule is also rolled back automatically.

### Input validation

The extension validates `RALPH.md` frontmatter before starting and on each re-parse: `max_iterations` must be a positive integer, `timeout` must be positive, `block_commands` regexes must compile, and commands must have non-empty names and run strings with positive timeouts.

## Comparison table

| Feature | **@clasen/pi-ralph-loop** | **@lnilluv/pi-ralph-loop** | pi-ralph | pi-ralph-wiggum |
|---------|--------------------------|---------------------------|----------|-----------------|
| Command output injection | ✓ | ✓ | ✗ | ✗ |
| Fresh-context sessions | ✓ | ✓ | ✓ | ✗ |
| Mid-turn guardrails | ✓ | ✓ | ✗ | ✗ |
| Cross-iteration memory | ✓ | ✓ | ✗ | ✗ |
| Mid-turn steering | ✓ | ✓ | ✗ | ✗ |
| Live prompt editing | ✗ | ✓ | ✗ | ✗ |
| Completion promise | ✓ | ✓ | ✗ | ✗ |
| Iteration timeout | ✓ | ✓ | ✗ | ✗ |
| Session-scoped hooks | ✓ | ✓ | ✗ | ✗ |
| Input validation | ✓ | ✓ | ✗ | ✗ |
| Auto-rollback on regression | ✓ | ✓ | ✗ | ✗ |
| Setup required | auto | RALPH.md | config | RALPH.md |

## License

MIT
# CI provenance test
