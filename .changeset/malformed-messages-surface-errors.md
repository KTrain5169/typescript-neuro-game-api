---
"neuro-game-api": patch
---

Messages missing required fields are no longer silently defaulted to empty values; they now surface through the `onConnectionError` handler like other command errors.
