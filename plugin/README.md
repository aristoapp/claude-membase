# Membase

Run `/membase:login` after installing this plugin.

The plugin connects Claude Code to Membase Cloud. It does not store a local
memory database.

By default the SessionStart hook injects only minimal routing guidance and
project/account status. Set `sessionStartContext` to `profile` to also inject
Membase profile settings, or `off` to disable SessionStart context.
