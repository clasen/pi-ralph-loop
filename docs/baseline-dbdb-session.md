# Baseline: dbdb-js Session Analysis

Session: `2026-04-14T04:47–05:20 UTC` (~33 min)
Model: `gpt-5.4` (openai-codex)
Config: `max_iterations: 50`, no rollback, no guardrails, no completion_promise

## Iteration Metrics

| Iter | Duration | Changes | Regressed | Signals Parsed | Commands Status |
|-----:|--------:|:-------:|:---------:|:--------------:|:----------------|
| 1 | 120s | yes | no | **none** | all failed (bootstrap) |
| 2 | 96s | yes | no | **none** | all ok |
| 3 | 33s | yes | no | **none** | all ok |
| 4 | 57s | yes | no | **none** | all ok |
| 5 | 52s | yes | no | **none** | all ok |
| 6 | 70s | yes | no | **none** | all ok |
| 7 | 69s | yes | no | **none** | all ok |
| 8 | 63s | yes | no | **none** | all ok |
| 9 | 63s | yes | no | **none** | all ok |
| 10 | 65s | yes | no | **none** | all ok |
| 11 | 80s | yes | no | **none** | all ok |
| 12 | 53s | yes | no | **none** | all ok |
| 13 | 51s | yes | no | **none** | all ok |
| 14 | 59s | yes | no | **none** | all ok |
| 15 | 72s | yes | no | **none** | all ok |
| 16 | 87s | yes | no | **none** | all ok |
| 17 | 70s | yes | no | **none** | all ok |
| 18 | 81s | yes | no | **none** | all ok |
| 19 | 69s | yes | no | **none** | all ok |
| 20 | 72s | yes | no | **none** | all ok |
| 21 | 112s | yes | no | **none** | all ok |
| 22 | 82s | yes | no | **none** | all ok |
| 23 | 98s | yes | no | **none** | all ok |
| 24 | 68s | yes | no | **none** | all ok |
| 25 | 60s | yes | no | **none** | all ok |
| 26 | 95s | yes | no | **none** | all ok |
| 27 | 94s | yes | no | **none** | all ok |
| 28 | 12s | **no** | no | **none** | all ok |

**Total: 28 iterations, 2002s (~33 min)**

## Critical Findings

### 1. Signal extraction was completely blind

All `testFailures`, `testPassed`, `lintErrors` fields are `undefined` across every iteration.

**Root cause:** Node.js native test runner outputs `# pass 24` / `# fail 0` (TAP-like),
but `extractCommandSignals` only matches `(\d+) passed` / `(\d+) failed` (Jest/Vitest style).

**Impact:** Regression detection, trend lines, and all quantitative feedback were non-functional.
The loop operated entirely on text-matching heuristics (`FAIL`/`ERROR` in output) for ok/failed status.

### 2. Duplicate verification commands

`lint_node` (`npm run lint`) produced identical output to `tests_node` (`npm test`) — both ran
`node --test test/*.test.js`. Every iteration paid for two equivalent executions.

### 3. State entry bloat

58 `ralph-loop-state` entries were written. By iteration 28, each entry was ~42KB because
`iterationSummaries` carries all 28 recap strings (each ~800 chars). Session file: 2.9 MB.

### 4. One wasted empty iteration

Iteration 28 ran (12s) with all-green checks and no changes, only to trigger auto-completion.
The check happens at the *start* of the next iteration rather than at the *end* of the current one.

### 5. No definition-of-done tied to spec

The loop stopped because of convergence (no changes), not because spec objectives were verified.
The spec requires: benchmark comparison vs DeepBase SQLite, disk footprint comparison, bounded RSS,
crash recovery verification — none of which were gated in the loop.

### 6. Micro-iteration pattern

Iterations 6–27 each addressed a single narrow concern (one invariant check, one validation rule).
The agent never batched related improvements or planned a systematic pass. This burned ~22 iterations
on incremental hardening that could have been ~5–8 with broader per-iteration scope.

## Spec Coverage at Termination

| Spec Requirement | Status |
|:-----------------|:-------|
| DeepBase-compatible API | Partial (core ops implemented, edge cases unclear) |
| Benchmark vs SQLite baseline | **Not done** (no DeepBase SQLite comparison) |
| Disk footprint comparison | **Not done** |
| Bounded RSS on large datasets | **Not done** |
| WAL / crash recovery | Implemented but not stress-tested |
| 30-point technical checklist | Partially covered (~18/30 addressed) |
