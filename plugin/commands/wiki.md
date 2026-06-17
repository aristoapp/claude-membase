---
description: Search, add, update, or delete Membase wiki documents.
argument-hint: search <query> | add <title> -- <markdown>
---

Call exactly one Membase MCP tool matching the user's intent:

- `search_wiki` for search.
- `add_wiki` for creating a stable factual document.
- `update_wiki` for changing an existing wiki document.
- `delete_wiki` only after explicit confirmation.

Use wiki for stable factual documents, references, and project knowledge. Use
memory for personal preferences and decisions. Preserve full document bodies
unless the user explicitly asks to save a summary. If the user names a Project,
pass it as `project`; otherwise leave `project` empty. A Project is the Wiki
filing location and is separate from the document title. After add/update,
report the returned destination, such as `Saved to Project: X`, `Saved to
Basic`, or `Moved to Basic`. Do not store secrets or raw source files.
