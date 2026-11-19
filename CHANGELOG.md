<!-- markdownlint-disable -->

## 0.7.0

### Minor Changes

- 4d8fc71: Implement the `neuro-api-types` package throughout the server: all message types are now imported from (or derived from) `neuro-api-types`, bumped to `^1.0.8`, which fixes its types to match the wire format. New exported types: `GameToServerMessage`, `ActionToSend`, `StartupSessionInfo`, and `IncomingVoicePackets`. Removed the now-unused `json-schema` and `@types/json-schema` devDependencies.

  BREAKING CHANGE: `Action` and `OutgoingMessage` are no longer exported by this package; import `Action` and `BaseIncomingMessage` from `neuro-api-types` instead.

- 4d8fc71: BREAKING CHANGE: Removed the dead `BaseNeuroServer` abstract class. It was empty, unused, and exported nothing of value; extend `NeuroServer` instead if you were referencing it.
- 4d8fc71: Added a `NeuroServer.sendSpeechFinished()` helper for the `speech_finished` message, using the `SpeechFinishedMessage` type from `neuro-api-types`.
- 4d8fc71: `speech/started` and `speech/ended` messages are now dispatched to new `onSpeechStarted` and `onSpeechEnded` event handlers, instead of being logged as unknown commands.
- 4d8fc71: Voice connections are served on the path `/game/<url-encoded game name>/voice`, per the voice chat specification. A `NeuroVoiceServer` can be attached to a `NeuroServer` — via the new `voiceServer` extra config option or the new `attachVoiceServer()` method (with `detachVoiceServer()` to detach) — to serve voice connections on the same port; without one, voice-path connections are rejected so games can gracefully continue without voice. The unused `voiceApi` option was removed in favor of `voiceServer`.
- 4d8fc71: Added `NeuroVoiceServer.sendCancelled()` for the `voice/cancelled` control message.
- 4d8fc71: `NeuroVoiceServer` is now functional out of the box: it wires its own WebSocket server (if spawned) and handles connections, messages, binary audio frames and connection teardown itself. `handle()` remains available for external wiring.
- 4d8fc71: Audio for unregistered speaker ids is now dropped, and concurrent registered speakers are capped at 32 by default, per the specification. The cap is configurable via the new `maxSpeakers` option on the `NeuroVoiceServer` inputs.

### Patch Changes

- 4d8fc71: `onActionsForce` now receives the action force's `silent` parameter as its last argument.
- 4d8fc71: Messages missing required fields are no longer silently defaulted to empty values; they now surface through the `onConnectionError` handler like other command errors.
- 4d8fc71: The server no longer sends `actions/reregister_all` to new connections on connect. The command is only an API proposal (not part of the specification), so it was non-compliant noise; `NeuroServer.requestReregisterAll()` remains available for explicit use.
- 4d8fc71: Fixed `onStartup` firing twice when passed in the `NeuroServer` constructor's extra configs.
- 4d8fc71: The Randy example now JSON-stringifies action data before sending it, as the spec requires.
- 4d8fc71: Fixed the startup acknowledgement to match the spec wire format: it is now sent as `{ "command": "startup", "data": { "session": { "sessionId", "characterId", "displayName" } } }`. Previously it was sent as a bare `{ characterId, displayName, sessionId }` object with no `command` field, which spec-compliant game clients silently ignored.
- 4d8fc71: A `startup` message now clears all previously registered actions for that game only, per the specification.
- 4d8fc71: A `startup` message without a game name is now ignored instead of registering the connection under a game named `unknown`.
- 4d8fc71: `NeuroVoiceServer.connections` is now keyed by connection id instead of game name, so multiple connections no longer overwrite each other.
- 4d8fc71: `NeuroVoiceServer` now uses the voice types from `neuro-api-types` instead of locally defined ones: `IncomingVoicePackets` is the package's `AllOutgoingControlPackets | AudioToServerFrames` union, and `onNewVoiceSession`'s return type is derived from `VoiceReadyMessage`.
- 4d8fc71: Voice sessions are now tracked: `voice/stop` ends the session but keeps the socket usable for a fresh `voice/start`, downstream audio (`sendAudio`/`broadcastAudio`) is only sent to connections with an active session, and the server closes the socket after `voice/unavailable`, all per the specification.

## 0.6.0

### Minor Changes

- 1e1cb63: make action force handlers return action data to execute
- 1e1cb63: Remove the old `commandHandlers` property, as well as remove teh `onCommandHandlerError` error handler property

  It was kinda useless anyways ngl

### Patch Changes

- 3e8223e: Allow event handlers to return promises

## 0.5.0

### Minor Changes

- 37f597a: Deprecate "registerCommandHandler" and make new "registerEventHandler" instead.

## 0.4.5

### Patch Changes

- 10b77ea: CI please work

## 0.4.4

### Patch Changes

- d5d3c2c: fixing CI once more

## 0.4.3

### Patch Changes

- 03a51dd: CI fix pt 2

## 0.4.2

### Patch Changes

- 0517b0b: CI broke so new patch versioon to add new features added in 0.4.1

## 0.4.1

### Patch Changes

- 30a9bb7: add a proper method to register command handlers
- 95b0311: fix tsdown being in prod deps

## 0.4.0

### Minor Changes

- 5f9aeed: The `startup` command handler can now return an object containing the characterId and the displayName. If this object is returned, the connection will be sent back a startup acknowledgement packet, with the session ID automatically filled.
- e999c22: BREAKING CHANGE: `onStartup` in the `NeuroServer` constructor is now moved to `extraConfigs`

# neuro-game-api

## 0.3.0

### Minor Changes

- ab296b1: Pass new priority level parameter on action forces to the action force handler, defaults to low

## 0.2.0

### Minor Changes

- 18a8962: You can now register error handlers using `NeuroServer.setErrorHandlers`.

### Patch Changes

- 18a8962: You can now toggle whether or not you want to detect dead connections

## 0.1.3

### Patch Changes

- bcb4827: Move tslib dependency to devDependencies

## 0.1.2

### Patch Changes

- 8fe4c38: Migrated to new repository.
  Remove unused import.

## 0.1.0

### Minor Changes

- 3c8fac3: A new server-side version of the Neuro Game API is published on npm!

  It's still in early versions but it is able to be used properly.

  Please give feedback at the repository!
