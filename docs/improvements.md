## Improvements roadmap

This document tracks what has already been implemented and what should come next to make `pi-ralph-loop` closer to an `autoresearch`-style optimization loop.

## Already implemented (current baseline)

- Rich cross-iteration memory injected into the next run.
- Progress signal extraction from command outputs (tests/lint counters).
- Regression detection and optional auto-rollback (`rollback_on_regression`).
- Built-in `{{ git.log }}` and `{{ git.diff }}` placeholders.
- Command output truncation (`max_output`) to protect context budget.
- Stall and repeated-diff detection to avoid infinite loops.
- Parallel command execution (`parallel: true`).
- Done criteria (`done_criteria`) and completion promise support.
- Minimal objective-based acceptance:
  - `objective.metric`: `test_failures` | `tests_passed` | `lint_errors` | `lint_warnings`
  - `objective.mode`: `minimize` or `maximize`
  - `acceptance_rule`: `non_regression` or `strict_improvement`
  - If objective acceptance fails and rollback is enabled, the iteration is reverted.
- **Exit-code-first command status**: `exitCode` governs command status when available; text heuristics are a legacy fallback only when `exitCode` is absent.
- **Convergence-based early stop**: if N consecutive iterations produce no file changes and metrics are stable, the loop stops automatically (after `minIterations`).
- **Objective-met early stop**: if the configured objective reaches optimal value (e.g. `test_failures == 0`) with all commands green, the loop stops.
- **Provider error taxonomy**: assistant errors are classified (`quota_exceeded`, `rate_limit`, `auth`, `transient`, `unknown`) with per-type recovery policies (pause/retry with backoff/stop) instead of blind retries.
- **Adaptive command scheduling**: `run_every: N` on a command skips it on non-matching iterations (always runs on iteration 1 and the last). Auto-mode sets `run_every: 3` for benchmarks.
- **Iteration-scoped completion promise**: `<promise>DONE</promise>` matching is restricted to the current iteration's entries, preventing false completions from historical messages.
- **Structural done criteria**: `__exit_code_zero__` pattern in `done_criteria` checks `exitCode === 0` instead of text matching.

## Why objective acceptance is the minimal high-impact step

The biggest practical gain from `autoresearch` is strict keep/reject decisions tied to one primary metric. This avoids "looks good" iterations that do not improve the optimization target.

The current objective implementation intentionally stays small:

- no schema migration,
- no new files or external services,
- no behavior changes unless objective fields are configured.

## Next recommended implementation (Phase 2)

### 1) Experiment ledger on disk (highest ROI)

Persist each iteration in `./.ralph/experiments.jsonl` with:

- timestamp, iteration, command outputs hash,
- objective value and acceptance decision,
- rollback decision and reason,
- git commit/diff fingerprint.

Benefits: auditability, easier offline analysis, and reproducible optimization history.

### 2) Per-command objective source

Allow objective to optionally target one command only:

```yaml
objective:
  metric: test_failures
  command: tests
  mode: minimize
```

This prevents metric mixing when multiple commands emit similar counters.

### 3) Explicit explore/exploit policy

Add optional strategy fields to avoid local minima:

- `strategy.mode: exploit|explore|mixed`
- `strategy.explore_every: N`

On explore iterations, instruct the agent to try a meaningfully different approach; on exploit iterations, request the smallest safe improvement.

### 4) Structured signal adapters

Support parser presets for common tools (`jest`, `pytest`, `ruff`, `eslint`, etc.) so metrics come from stable structured patterns instead of generic regex only.

### 5) Prompt escalation rules

Add simple escalation triggers (e.g. 4 stalled iterations) to switch instructions from "keep fixing" to "rethink approach and propose alternative hypotheses".

## Suggested execution order

1. Experiment ledger.
2. Objective `command` scoping.
3. Explore/exploit strategy.
4. Structured signal adapters.
5. Escalation rules.
