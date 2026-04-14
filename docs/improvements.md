### 1. Cross-Iteration Memory is Almost Empty (Critical)

This is the single biggest bottleneck. The `before_agent_start` hook currently injects only this:

```199:201:/Users/martinclasen/.pi/agent/git/github.com/lnilluv/pi-ralph-loop/src/index.ts
        `\n\n## Ralph Loop Context\nIteration ${persisted?.iteration ?? 0}/${persisted?.maxIterations ?? 0}\n\nPrevious iterations:\n${history}\n\nDo not repeat completed work. Check git log for recent changes.`,
```

The "history" is just `Iteration N: Xs` -- duration only. The agent gets **zero information** about what was actually done, what was tried, what failed, or what succeeded. Telling it "don't repeat completed work" without telling it *what* was completed is almost useless.

**Fix:** At the end of each iteration, capture the agent's final assistant message (or a summary of it) and the command outputs (test pass/fail counts, lint errors). Store this as structured data in `iterationSummaries` and inject a meaningful recap into the next iteration's system prompt.

---

### 2. No Progress Signal / Regression Detection (Critical)

The system has no concept of "did we make progress?" between iterations. If tests go from 10 failing to 5 failing, that's great. If they go from 5 to 10, the last change was destructive. Currently, this signal is completely lost.

**Fix:** After running commands each iteration, parse structured output (e.g., test count via `--json` reporters, grep for pass/fail counts). Store per-iteration metrics. Inject a trend line into the prompt: "Iteration 3: 10 failing -> Iteration 4: 5 failing -> Iteration 5: 8 failing (REGRESSION)". On regression, consider auto-reverting or explicitly instructing the agent to undo the last change.

---

### 3. No Automatic Rollback on Regression (High)

When an iteration makes things worse, the loop just continues forward. There's no `git stash` or `git revert` mechanism. The agent in the next iteration has to figure out that things got worse and fix it, wasting an entire iteration (or more).

**Fix:** Add a `rollback_on_regression: true` frontmatter option. Before each iteration, `git stash` or tag the state. After commands run, compare metrics to the previous iteration. If worse, auto-revert and inform the agent: "The previous iteration's changes were reverted because tests regressed from 5 to 10 failures. Try a different approach."

---

### 4. No Git Diff Injection (High)

The agent starts each iteration fresh with no knowledge of what code was changed. The prompt says "check git log" but that relies on the agent spending tokens doing it manually every single iteration.

**Fix:** Add a built-in `{{ git.diff }}` or `{{ git.log }}` placeholder (or an automatic command). Inject `git diff HEAD~1` or `git log --oneline -5` into the prompt automatically. This gives the agent immediate context about recent changes without wasting a tool call.

---

### 5. Command Output Truncation / Summarization (High)

Large test suites can produce megabytes of output. There's no truncation:

```123:126:/Users/martinclasen/.pi/agent/git/github.com/lnilluv/pi-ralph-loop/src/index.ts
      const result = await pi.exec("bash", ["-c", cmd.run], { timeout: cmd.timeout * 1000 });
      results.push(result.killed
        ? { name: cmd.name, output: `[timed out after ${cmd.timeout}s]` }
        : { name: cmd.name, output: (result.stdout + result.stderr).trim() });
```

Dumping 50KB of test output into the prompt wastes context window and drowns the actual signal.

**Fix:** Add a `max_output` option per command (e.g., 4000 chars). Implement smart truncation that preserves the summary section (usually at the end) and failing test details while trimming passing tests. Alternatively, support a `filter` regex per command that extracts only relevant lines.

---

### 6. Stall Detection (Medium-High)

If the agent keeps trying the same fix across iterations (or produces identical diffs), the loop burns iterations without progress. There's no detection for this.

**Fix:** Hash the git diff after each iteration. If the diff is identical or near-identical to a previous iteration, inject a strong signal: "You've tried this exact approach before in iteration N. Try a fundamentally different strategy." After 2-3 identical diffs, consider escalating with a different prompt or stopping.

---

### 7. Adaptive Prompt Escalation (Medium-High)

The prompt is static every iteration -- same template, same instructions. After 5 failed iterations, the agent probably needs different guidance, not the same one for the 6th time.

**Fix:** Support conditional sections in `RALPH.md` based on iteration count or progress. E.g.:

```markdown
{% if ralph.iteration > 5 %}
You've been working on this for {{ralph.iteration}} iterations.
Step back and reconsider the fundamental approach.
{% endif %}
```

Or simpler: support a `escalation_prompt` frontmatter field that replaces the body after N failed iterations.

---

### 8. Mid-Turn Steering is Too Naive (Medium)

The failure detection regex is broad and imprecise:

```207:/Users/martinclasen/.pi/agent/git/github.com/lnilluv/pi-ralph-loop/src/index.ts
    if (!/FAIL|ERROR|error:|failed/i.test(output)) return;
```

This matches things like `"error handling"` in code output or `"previously failed"` in explanatory text. It also misses failures that don't use those words.

**Fix:** Make the failure patterns configurable in `RALPH.md` frontmatter (e.g., `failure_patterns: ["FAIL", "exit code [1-9]"]`). Also consider matching only at the end of output or using exit codes rather than text matching.

---

### 9. No Agent Output Capture Between Iterations (Medium)

The system never reads what the agent actually *said* or *did* (beyond the completion promise check). The only data stored is `{ iteration, duration }`. This means:

- No way to detect if the agent is confused
- No way to carry forward discoveries or partial fixes
- No way to detect if the agent gave up or asked a question

**Fix:** After each iteration, extract key information from the agent's messages: files changed, approach taken, blockers identified. Store a structured summary. This enables both better cross-iteration memory and smarter decision-making about whether to continue.

---

### 10. Completion Promise UX is Fragile (Medium)

The agent needs to emit `<promise>DONE</promise>` -- a specific XML tag in its output. Most agents won't do this naturally unless the prompt explicitly instructs them. And if it's in the prompt, it takes up space every iteration.

**Fix:** Support alternative completion signals: exit code 0 from a specific "check" command, a file sentinel (e.g., `.ralph-done`), or pattern matching in command output (e.g., "All tests passed"). These are more natural and don't require the agent to know about Ralph's internal protocol.

---

### 11. No Parallel Command Execution (Low-Medium)

Commands run sequentially. If you have `tests` (60s) and `lint` (10s) that are independent, you waste 10s.

```119:133:/Users/martinclasen/.pi/agent/git/github.com/lnilluv/pi-ralph-loop/src/index.ts
async function runCommands(commands: CommandDef[], pi: ExtensionAPI): Promise<CommandOutput[]> {
  const results: CommandOutput[] = [];
  for (const cmd of commands) {
    // ...sequential execution
  }
  return results;
}
```

**Fix:** Add a `parallel: true` option in frontmatter. Run independent commands with `Promise.all`.

---

### 12. No Tests for the Extension Itself (Low but Important)

Zero test coverage means regressions in the loop logic (the most critical piece) go undetected. The CI only runs `tsc --noEmit`.

**Fix:** Add unit tests for `parseRalphMd`, `validateFrontmatter`, `resolvePlaceholders`, `runCommands`, and integration tests for the loop state machine.

---

## Summary Table

| Rank | Improvement | Impact | Effort |
|------|------------|--------|--------|
| 1 | Rich cross-iteration memory | Critical | Medium |
| 2 | Progress signal / regression detection | Critical | Medium |
| 3 | Auto-rollback on regression | High | Low |
| 4 | Git diff injection as built-in placeholder | High | Low |
| 5 | Command output truncation | High | Low |
| 6 | Stall detection (repeated diffs) | Medium-High | Low |
| 7 | Adaptive prompt escalation | Medium-High | Medium |
| 8 | Configurable failure patterns | Medium | Low |
| 9 | Agent output capture/analysis | Medium | Medium |
| 10 | Better completion signals | Medium | Low |
| 11 | Parallel command execution | Low-Medium | Low |
| 12 | Test coverage | Low (for users) | Medium |

The highest-ROI cluster is **items 1-5**: they're all about giving the agent *better information* to make decisions. Right now the loop is structurally sound but the agent is essentially blind between iterations -- it gets fresh command output but no memory of what it tried, no progress trends, no diffs, and potentially drowning in raw output. Fixing those 5 things would dramatically reduce wasted iterations.