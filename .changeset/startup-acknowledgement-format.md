---
"neuro-game-api": patch
---

Fixed the startup acknowledgement to match the spec wire format: it is now sent as `{ "command": "startup", "data": { "session": { "sessionId", "characterId", "displayName" } } }`. Previously it was sent as a bare `{ characterId, displayName, sessionId }` object with no `command` field, which spec-compliant game clients silently ignored.
