---
"neuro-game-api": minor
---

Implement the `neuro-api-types` package throughout the server: all message types are now imported from (or derived from) `neuro-api-types`, bumped to `^1.0.8`, which fixes its types to match the wire format. New exported types: `GameToServerMessage`, `ActionToSend`, `StartupSessionInfo`, and `IncomingVoicePackets`. Removed the now-unused `json-schema` and `@types/json-schema` devDependencies.

BREAKING CHANGE: `Action` and `OutgoingMessage` are no longer exported by this package; import `Action` and `BaseIncomingMessage` from `neuro-api-types` instead.
