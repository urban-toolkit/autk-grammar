# The Urban Grammar

A tool-agnostic grammar for composing urban visual analytics systems.

## Overview

The Urban Grammar defines a declarative specification layer for urban analytics pipelines. Rather than prescribing a specific set of tools, it establishes the conceptual vocabulary — data sources, compute operations, maps, and plots — that any implementation must fulfill. Concrete behavior is provided by adapters: separate packages that wire the grammar to a specific toolkit. This separation lets the same analytical specification run on different technology stacks with no changes to the pipeline logic.

## Packages

| Package | Description |
|---------|-------------|
| [`@urban-toolkit/the-urban-grammar`](grammar/) | Core grammar: specs, adapter interfaces, and the engine |
| [`@urban-toolkit/autk-grammar`](adapters/autk/) | Adapter implementing the grammar using the [Autark](https://github.com/urban-toolkit/autark) toolkit |

## Usage

Define a spec using the grammar, instantiate adapters of your choice, and run the engine:

```ts
import { createEngine, UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import { createAutkAdapters } from '@urban-toolkit/autk-grammar';

const spec: UrbanSpec = {
  data: [{ type: 'csv', csvFileUrl: 'buildings.csv', outputTableName: 'buildings' }],
  map: { layerRefs: [{ dataRef: 'buildings', isColorMap: true }] },
  plot: { dataRef: 'buildings', mark: 'bar', axis: ['height', 'count'] }
};

const engine = createEngine({ spec, adapters: createAutkAdapters() });
await engine.run();
```

Swapping the adapter changes the underlying tools; the spec stays the same.

## Installation

Install the core grammar and an adapter:

```sh
npm install @urban-toolkit/the-urban-grammar
npm install @urban-toolkit/autk-grammar
```

Or install only the core if you are building your own adapter:

```sh
npm install @urban-toolkit/the-urban-grammar
```

## Development

### Dependencies

- [Node.js](https://nodejs.org/) v22+
- [GNU Make](https://www.gnu.org/software/make/)

**Windows**
```sh
winget install GnuWin32.Make
```

**macOS**
```sh
brew install make
```

**Linux**
```sh
apt-get install build-essential
```

### Building

```sh
npm install
make build
```

### Run gallery of examples

```sh
npm run dev --prefix gallery
```

### Makefile reference

| Command | Description |
|---------|-------------|
| `make build` | Build all packages |
| `make lint` | Lint all packages |
| `make typecheck` | Typecheck all packages |
| `make install` | Install dependencies for all packages |
| `make clean` | Remove all build output |

## Writing an Adapter

An adapter implements four interfaces exported by `@urban-toolkit/the-urban-grammar`:

- `DataAdapter` — resolves data sources into a shared context
- `ComputeAdapter` — runs GPU or CPU compute operations on the context
- `MapAdapter` — renders map layers from the context
- `PlotAdapter` — renders plots from the context

Pass instances of all four to `createEngine` via `EngineOptions.adapters`.
