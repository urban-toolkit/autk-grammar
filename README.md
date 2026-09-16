# autk-grammar

A tool-agnostic grammar for composing urban visual analytics systems.

## Overview

The Urban Grammar defines a declarative specification layer for urban analytics pipelines. Rather than prescribing a specific set of tools, it establishes the conceptual vocabulary (data sources, compute operations, maps, and plots) that any implementation must fulfill. Concrete behavior is provided by adapters: separate packages that wire the grammar to a specific toolkit. This separation lets the same analytical specification run on different technology stacks with no changes to the pipeline logic.

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

## Example gallery

[`gallery/`](gallery/) runs the 49 example specs in this repository and lets you pick which adapter renders each one. Between them they cover OSM and PBF loading, CSV and GeoJSON, GPU compute, colormaps, plots, and two-way interaction between a map and a plot:

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
- `ComputeAdapter`: runs GPU or CPU compute operations on the context
- `MapAdapter`: renders map layers from the context
- `PlotAdapter`: renders plots from the context

Pass instances of all four to `createEngine` via `EngineOptions.adapters`.
