# TODO

## Features

- **Markdown rendering** in expanded tool result view. Currently plain text.
  Use `Markdown` from `@mariozechner/pi-tui` with a `MarkdownTheme`.

- **Persistent AskClaude session**: reuse the same Claude Code session across
  calls so context accumulates (plan → implement → review). The SDK supports
  session resume. Tradeoff: `disallowedTools` is per-query but the session
  accumulates all prior tool outputs.

- **`/claude config` slash command** for runtime configuration. Currently
  requires editing JSON and `/reload`.

- **`/claude:btw` command** for ephemeral questions: response displayed but
  not added to LLM context.

## Deferred

- **Session JSONL cleanup**: Track session IDs created during a pi session. On
  `session_shutdown`, delete the JSONL files from `~/.claude/projects/`. Consider
  `persistSession: false` on `query()` to prevent CC from writing its own JSONL
  (we only need the cc-session-io one for seeding resume). Currently sessions
  accumulate indefinitely with no cleanup or reuse.

- **Case 4 session reuse**: `syncSharedSession` Case 4 creates a fresh session
  every time there are missed messages (e.g., user switched providers mid-conversation).
  Ideally we'd overwrite the existing JSONL with new contents under the same session
  ID, but cc-session-io's API is append-only with auto-generated UUIDs. Would need
  either a `clear()` method upstream or manual file deletion + reconstruction.
  Low priority — the cleanup task above is more impactful.

## Probably not

- **Stream lifecycle state machine**: Turn state uses four implicit flags
  (`currentPiStream`, `turnStarted`, `turnSawStreamEvent`, `turnSawToolCall`).
  An explicit state enum would be tidier in theory, but the interleaving of SDK
  generator, pi streams, and MCP tool calls is inherently complex — a state enum
  would likely coexist with the stream reference anyway, just moving complexity
  around. The per-turn flags are well-commented and consistent. The tool result
  synchronization was refactored to symmetric queues (2026-03-29), eliminating
  the `toolCallDetected` callback and DEFERRED path that caused deadlocks.
