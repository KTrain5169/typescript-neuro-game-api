---
"neuro-game-api": patch
---

`NeuroVoiceServer` now uses the voice types from `neuro-api-types` instead of locally defined ones: `IncomingVoicePackets` is the package's `AllOutgoingControlPackets | AudioToServerFrames` union, and `onNewVoiceSession`'s return type is derived from `VoiceReadyMessage`.
