---
"neuro-game-api": patch
---

The server no longer sends `actions/reregister_all` to new connections on connect. The command is only an API proposal (not part of the specification), so it was non-compliant noise; `NeuroServer.requestReregisterAll()` remains available for explicit use.
