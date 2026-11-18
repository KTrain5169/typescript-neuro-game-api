---
"neuro-game-api": minor
---

BREAKING CHANGE: Removed the dead `BaseNeuroServer` abstract class. It was empty, unused, and exported nothing of value; extend `NeuroServer` instead if you were referencing it.
