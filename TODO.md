# TODO

## Features

- **Markdown rendering** in expanded tool result view. Currently plain text.
  Use `Markdown` from `@mariozechner/pi-tui` with a `MarkdownTheme`.

- **`/claude config` slash command** for runtime configuration. Currently
  requires editing JSON and `/reload`.

- **`/claude:btw` command** for ephemeral questions: response displayed but
  not added to LLM context.

- **Audit tool parameter mismatches**: The bash timeout default (120s) was added
  because pi's bash has no default while Claude Code expects one. Other bridged
  tools may have similar mismatches (units, defaults, optional-vs-required params).
  Compare Claude Code's tool schemas against pi's for read, write, edit, grep, find.

## Possible Enhancements

- **AskUserQuestion pi shim** (main provider only): CC never sees
  AskUserQuestion (it's in `DISALLOWED_BUILTIN_TOOLS`), so it can't ask the
  user questions interactively. Port a pi-native version using `ctx.ui.custom()`
  for an option picker with free-text fallback. Not applicable to AskClaude
  subagents (can't interact with user). See `fractary/pi-claude-code`
  `AskUserQuestion.ts` for reference.

- **PlanMode pi shim** (main provider only): Similarly, EnterPlanMode/
  ExitPlanMode are blocked. A pi-native plan mode could use
  `pi.setActiveTools()` to restrict to read-only tools, block destructive bash
  via `tool_call` event, and surface plan approval through pi's TUI. Not
  applicable to AskClaude subagents. See `fractary/pi-claude-code`
  `PlanMode.ts`.

## Architecture Issues

- **Module-level mutable state**: `activeQuery`, `currentPiStream`, `pendingToolCalls`, etc.
  are module-level variables coordinating two async flows. The `queryStateStack` save/restore
  pattern works but is fragile — any new state variable must be manually included in the
  save/restore or reentrant queries corrupt parent state. Consider encapsulating into a
  class instance keyed by session/query ID.

- ~~**Per-turn queries**~~ — investigated and abandoned. The SDK has no supported
  path to inject tool_results externally: resuming a session that ends in
  `user(tool_result)` with a new prompt forces a fresh user turn instead of
  letting the model respond to the tool result. MCP handler blocking is the
  sanctioned mechanism. See `per-turn-queries` branch for the writeup.

## Testing Gaps

- **Structured diagnostics for tests**: Tests currently grep freeform debug log
  strings (e.g. 'Case 1/2/3/4') to verify internal state. Emit these as
  structured NDJSON events or dedicated diagLog entries so tests can query
  without brittle string matching.

## Deferred

- **Session JSONL cleanup**: Track session IDs created during a pi session. On
  `session_shutdown`, delete the JSONL files from `~/.claude/projects/`. Consider
  `persistSession: false` on `query()` to prevent CC from writing its own JSONL
  (we only need the cc-session-io one for seeding resume). Currently sessions
  accumulate indefinitely with no cleanup or reuse.

- **Post-abort rebuild rotates sessionId** (see `Case 4 post-abort` log line).
  Normal Case 4 rebuilds preserve the sessionId by wiping the file in place
  (`deleteSession` + `createSession({sessionId})`). The post-abort path can't
  safely do that: the killed CC subprocess flushes a late `[Request interrupted
  by user]` record during its own cleanup, and if that write lands on the
  freshly-rewritten file it appends an orphan record with a dangling
  `parentUuid`, which breaks CC's parent-uuid chain on the next resume — CC
  silently starts with an empty context and produces a confidently-wrong
  answer. Diagnosed in debug log during branch work, see commit e317461.

  Current fix: post-abort rebuild takes a fresh UUID, so the orphan writes can
  only land on a dead inode. Deterministic, zero-latency, costs one extra UUID
  in the debug log per abort.

  Options to revisit:
  - **Short delay (~500ms) before post-abort rebuild**, keep the UUID stable.
    Overprovisions the observed ~1–2ms race window by 250–500×. Adds visible
    latency on the post-abort turn. Eli's lean: 500ms feels like plenty and
    the UX is fine. Risk: still probabilistic — loaded systems could extend
    subprocess cleanup past the delay and we'd never know until a user hits
    the silent context-loss path.
  - **Drain the aborted query's AsyncGenerator to completion** before
    rebuilding. Iterate `for await (_ of sdkQuery) {}` in the catch handler
    until the generator ends (i.e. subprocess stdout fully closed). Race-free
    and latency-free, but the control flow acrobatics around the SDK's Query
    wrapper are non-obvious — need to confirm re-entering iteration after
    abort is legal, and that stdout close happens strictly after the orphan
    write flushes.
  - **Listen for the ChildProcess `exit` event directly.** Official SDK Query
    interface doesn't expose the child, so this needs either a fork or a
    hacky property access. Rejected unless the SDK grows a hook.

