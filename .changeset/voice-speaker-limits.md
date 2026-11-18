---
"neuro-game-api": minor
---

Audio for unregistered speaker ids is now dropped, and concurrent registered speakers are capped at 32 by default, per the specification. The cap is configurable via the new `maxSpeakers` option on the `NeuroVoiceServer` inputs.
