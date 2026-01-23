# 🎯 Agent Loop Stop Hook (Ralph Wiggum in 38 lines)

Create your own MCP tools that leverage this stop-hook to work as Ralph Wiggum.

## Quick Start

```bash
# The agent automatically decides max-iterations based on prompt difficulty.
*agent-loop "refactor code for performance"

# Run 5 improvement cycles
*agent-loop "improve code quality" --max-iterations 5

# Run until task is done
*agent-loop "fix tests" --completion-promise "TESTS_PASSING" --max-iterations 20
```

When the loop is active, exiting the CLI will automatically restart it with your prompt for the next iteration.

## How It Works

The hook checks if `.claude/agent-loop.local.md` exists when you exit:
- If **no** state file → Normal exit
- If **state file exists** → Check if loop should continue
  - Max iterations reached? → Exit & cleanup
  - Promise detected in output? → Exit & cleanup
  - Otherwise → Re-feed prompt, increment iteration

## State File Format

```yaml
---
iteration: 2  # auto count by stop hook
max_iterations: 5
completion_promise: "DONE"
---
your original task prompt
```

The hook automatically updates the state file.

## Execution Flow

```
┌──────────────────────────────────────────┐
│  SESSION EXIT ATTEMPTED                  │
│  (User tries to exit CLI)                │
└──────────────────────┬───────────────────┘
                       │
                       ▼
           ┌──────────────────────────────┐
           │ STATE FILE EXISTS?           │
           │ .claude/agent-loop.local.md  │
           └────┬─────────────────┬───────┘
                │                 │
            NOT FOUND            FOUND
                │                 │
                ▼                 ▼
            [✓ EXIT]      ┌──────────────────┐
                          │ PARSE STATE FILE │
                          │ Extract:         │
                          │ • iteration      │
                          │ • max_iterations │
                          │ • promise        │
                          └──┬────────┬──────┘
                             │        │
                          VALID    INVALID
                             │        │
                             ▼        ▼
                        [CONTINUE] [✓ EXIT]
                             │    (cleanup)
                             ▼
               ┌─────────────────────────────┐
               │ CHECK TERMINATION CONDITIONS│
               │ • Max iterations reached?   │
               │ • Promise in output?        │
               └──┬──────────────┬───────────┘
                  │              │
                YES             NO
                  │              │
                  ▼              ▼
              [✓ EXIT]     ┌──────────────────┐
             (cleanup)    │ CHECK FOR PROMISE│
                          │ <promise>TEXT    │
                          │ </promise>       │
                          └──┬────────┬──────┘
                             │        │
                          FOUND    NOT FOUND
                             │        │
                             ▼        ▼
                        [✓ EXIT]  ┌────────────┐
                      (matched)   │ CONTINUE   │
                                  │ • Increment│
                                  │   iteration│
                                  │ • Re-feed  │
                                  │   prompt   │
                                  └────────────┘
```

## Usage Modes

| Mode | Command | Use Case |
|------|---------|----------|
| **Max Iterations** | `*agent-loop "task" --max-iterations 5` | Fixed number of refinement passes |
| **Completion Promise** | `*agent-loop "task" --completion-promise "DONE"` | Run until goal is reached |

## How Agent Uses Completion Promise

To exit early, output the exact promise text in `<promise>` tags:

```
I've completed the task.

<promise>DONE</promise>
```

The loop detects this and exits immediately.

## Key Points

- ✅ Loop state is tracked in `.claude/agent-loop.local.md`
- ✅ Only one loop can be active at a time
- ✅ Safe cleanup on exit (state file always deleted)
- ✅ Promise text must match exactly (case-sensitive)
- ✅ No external dependencies (bash + standard tools)

## FAQ

**Q: Can agent exit early?**

A: Yes, output `<promise>TEXT</promise>` matching your completion_promise.

**Q: What if I delete the state file?**

A: Loop exits cleanly. Start a new loop anytime.

**Q: What if something goes wrong?**

A: The hook always cleans up the state file and exits safely.

---

**Version:** 2026-01
