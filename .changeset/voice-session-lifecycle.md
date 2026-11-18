---
"neuro-game-api": patch
---

Voice sessions are now tracked: `voice/stop` ends the session but keeps the socket usable for a fresh `voice/start`, downstream audio (`sendAudio`/`broadcastAudio`) is only sent to connections with an active session, and the server closes the socket after `voice/unavailable`, all per the specification.
