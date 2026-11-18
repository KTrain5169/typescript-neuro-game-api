---
"neuro-game-api": minor
---

`NeuroVoiceServer` is now functional out of the box: it wires its own WebSocket server (if spawned) and handles connections, messages, binary audio frames and connection teardown itself. `handle()` remains available for external wiring.
