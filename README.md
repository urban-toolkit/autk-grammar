# autk-grammar

[![npm version](https://img.shields.io/npm/v/@urban-toolkit/autk-grammar?color=f43f5e&logo=npm&labelColor=111827)](https://www.npmjs.com/package/@urban-toolkit/autk-grammar)

A tool-agnostic grammar for composing urban visual analytics systems.

**Documentation:** [autarkjs.org/grammar](https://autarkjs.org/grammar/) · **Examples:** [autarkjs.org/grammar/examples](https://autarkjs.org/grammar/examples/)

## Overview

autk-grammar defines a declarative specification layer for urban analytics pipelines. Rather than prescribing a specific set of tools, it establishes the conceptual vocabulary (data sources, compute operations, maps, and plots) that any implementation must fulfill. Concrete behavior is provided by adapters: separate packages that wire the grammar to a specific toolkit. This separation lets the same analytical specification run on different technology stacks with no changes to the pipeline logic.

## Packages

| Package | Description |
|---------|-------------|
| [`grammar/`](grammar/) | Core grammar: specs, adapter interfaces, and the engine. Bundled into `@urban-toolkit/autk-grammar`, not published on its own |
| [`@urban-toolkit/autk-grammar`](adapters/autk/) | Adapter implementing the grammar using the [Autark](https://github.com/urban-toolkit/autark) toolkit |

## Usage

Define a spec using the grammar and run it with the Autark adapter:

```ts
import { AutkGrammar, UrbanSpec } from '@urban-toolkit/autk-grammar';

const spec: UrbanSpec = {
  data: [{ type: 'csv', csvFileUrl: 'buildings.csv', outputTableName: 'buildings' }],
  map: { layerRefs: [{ dataRef: 'buildings', isColorMap: true }] },
  plot: { dataRef: 'buildings', mark: 'bar', axis: ['height', 'count'] }
};

const grammar = new AutkGrammar({ map: 'map', plot: 'plot' }); // ids of the map canvas and plot container
await grammar.run(spec);
```

Swapping the adapter changes the underlying tools; the spec stays the same.

## JSON Schema

The grammar's JSON Schema (draft-07) is generated from the TypeScript types in [`grammar/src/types.ts`](grammar/src/types.ts) and ships in the npm package as `build/autk-grammar-schema.json`. Its `$id` is `https://autarkjs.org/schema/autk-grammar/v1.json`, and a spec may name it in a `$schema` field.

```ts
import Ajv from 'ajv';
import schema from '@urban-toolkit/autk-grammar/build/autk-grammar-schema.json' with { type: 'json' };

const validate = new Ajv({ allowUnionTypes: true }).compile(schema);
if (!validate(spec)) console.error(validate.errors);
```

Keys the schema does not name are allowed. `make build` regenerates the schema, and `npm run test:schema` validates every gallery spec against it.

## Example gallery

Browse the examples online, with a live editable spec for each one, at [autarkjs.org/grammar/examples](https://autarkjs.org/grammar/examples/).

To run them locally, use [`gallery/`](gallery/). It runs the 49 example specs in this repository and lets you pick which adapter renders each one. Between them they cover OSM and PBF loading, CSV and GeoJSON, GPU compute, colormaps, plots, and two-way interaction between a map and a plot:

```sh
npm run dev --prefix gallery
```

## Installation

Install the Autark adapter, which includes the core grammar:

```sh
npm install @urban-toolkit/autk-grammar
```

To build your own adapter, work in this repository: the core grammar lives in [`grammar/`](grammar/).

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

### Validate the gallery against the schema

```sh
npm run test:schema
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

An adapter implements four interfaces exported by the core grammar in [`grammar/`](grammar/):

- `DataAdapter`: resolves data sources into a shared context
- `ComputeAdapter`: runs GPU or CPU compute operations on the context. The Autark adapter's `runCompute` and `resolveComputeParams` resolve `fromFeature` uniforms, iteration and multi-line `wglsFunction` bodies into compute parameters
- `MapAdapter`: renders map layers from the context
- `PlotAdapter`: renders plots from the context

Pass instances of all four to `createEngine` via `EngineOptions.adapters`.
