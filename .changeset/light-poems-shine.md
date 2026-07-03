---
"neuro-game-api": minor
---

- The `startup` command handler can now return an object containing the characterId and the displayName. If this object is returned, the connection will be sent back a startup acknowledgement packet, with the ession ID automatically filled.
- BREAKING CHANGE: `onStartup` in the `NeuroServer` constructor is now moved to `extraConfigs`
