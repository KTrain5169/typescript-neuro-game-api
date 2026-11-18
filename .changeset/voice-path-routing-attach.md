---
"neuro-game-api": minor
---

Voice connections are served on the path `/game/<url-encoded game name>/voice`, per the voice chat specification. A `NeuroVoiceServer` can be attached to a `NeuroServer` — via the new `voiceServer` extra config option or the new `attachVoiceServer()` method (with `detachVoiceServer()` to detach) — to serve voice connections on the same port; without one, voice-path connections are rejected so games can gracefully continue without voice. The unused `voiceApi` option was removed in favor of `voiceServer`.
