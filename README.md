# TypeScript Neuro Game API

A TypeScript/JavaScript API implementation of the Neuro Game API server. This implementation is based on the [official implementation of the Neuro Game API](https://github.com/VedalAI/neuro-sdk/blob/main/API/SPECIFICATION.md) and was inspired by [CoolCat467's server-side implementation in the Python SDK](https://github.com/CoolCat467/Neuro-API/blob/main/src/neuro_api/server.py).

> [!NOTE]
> If you are trying to build an integration for Neuro, you're looking for the [`neuro-game-sdk` package](https://github.com/AriesAlex/typescript-neuro-game-sdk) instead.
> This package is for server-side implementations of the Neuro API.

## Installation & Usage

Install the API:

```bash
# npm
npm install neuro-game-api
# yarn
yarn add neuro-game-api
# pnpm
pnpm add neuro-game-api
```

Then, use it in your scripts like so:

```ts
import { NeuroServer } from 'neuro-game-api'

const NEURO_SERVER_HOST = 'localhost'
const NEURO_SERVER_PORT = 8000

const server = new NeuroServer(NEURO_SERVER_HOST, NEURO_SERVER_PORT, extraConfigs /* extra configs that are kinda unused for now */)
```

## Examples

The `examples/` directory has example implementations of the Neuro Game API. Please refer to that.
