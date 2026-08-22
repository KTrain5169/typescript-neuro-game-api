<!-- markdownlint-disable -->

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
