# Membase for Claude Code

Persistent memory for Claude Code using Membase. This plugin adds Membase
recall, save, and wiki workflows while storing data in Membase Cloud.

## Install

```bash
claude plugin marketplace add aristoapp/claude-membase
claude plugin install membase@membase-plugins
```

Then run:

```text
/membase:login
```

## How It Works

```text
Claude Code
  -> Membase plugin
  -> Membase Cloud
```

The plugin runs locally with Claude Code. It does not store a local memory
database. Memories and wiki documents are saved to your Membase account.

## Privacy

Auto-capture is opt-in during `/membase:login`. Summary capture stores bounded
Claude Code tool summaries and Claude-provided compact summaries. It does not
save raw transcript tails. Captures avoid secrets, `.env` values, private key
blocks, raw source files, long terminal output, and content wrapped in
`<private>` or `<membase-private>`.

Session start context is controlled by the `sessionStartContext` plugin setting:
`minimal` injects connection/project status and routing guidance, `profile` also
injects the Membase profile settings payload, and `off` disables session-start
context injection. Recent memories are not injected at session start; use
`membase://recent` only when latest/recent context is explicitly needed.

## Development

```bash
bun install
bun run check
bun run verify
```

For local dogfood:

```bash
claude plugin marketplace add .
claude plugin install membase@membase-plugins
```
