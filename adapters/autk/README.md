# @urban-toolkit/autk-grammar

A declarative grammar for urban visual analytics, running on [Autark](https://autarkjs.org). Describe the data to load, the computations to run, and the maps and plots to draw in one spec, and the grammar wires them together in the browser.

- Documentation: https://autarkjs.org/grammar/
- Examples: https://autarkjs.org/grammar/examples/
- Source: https://github.com/urban-toolkit/autk-grammar

## Installation

```sh
npm install @urban-toolkit/autk-grammar
```

It runs on Autark 4.1: `@urban-toolkit/autk-core`, `autk-db`, `autk-map`, `autk-plot` and `autk-compute` 4.1 or a later 4.x, installed with it.

## Usage

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

## Maps

Each map draws on demand: one frame once its layers are loaded, then one each time it changes. `grammar.maps` holds the `AutkMap` of each `map` entry of the last run, in order. Between frames a map canvas can read back empty, so to read a map's pixels (for example with `canvas.toDataURL()`), call its `requestRender()` and read in a `requestAnimationFrame` callback registered after that call:

```ts
const map = grammar.maps[0];
map.requestRender();
requestAnimationFrame(() => {
  const png = map.canvas.toDataURL('image/png');
});
```

## Interactions

A layer with `isPick` and a plot with `events` report what the user selects on `grammar.interactions`: `map:picking` and `plot:selection` give feature ids, the positions of the selected features among those the layer or the plot draws (a map layer leaves out features without a geometry). To link a selection to other tables, name the columns whose values identify those rows with `selectFields` on the layer or the plot, for example `selectFields: ['nta2020']`. The grammar does not read it; the events still report feature ids, and the app reads the key values from those rows.

```ts
grammar.interactions.on('map:picking', ({ layerId, selection }) => { /* feature ids */ });
grammar.interactions.on('plot:selection', ({ plotId, event, selection }) => { /* feature ids */ });
```

## JSON Schema

The package ships the grammar's JSON Schema (draft-07) as `@urban-toolkit/autk-grammar/build/autk-grammar-schema.json`, with `$id` `https://autarkjs.org/schema/autk-grammar/v1.json`. Validate a spec with any draft-07 validator:

```ts
import { Ajv } from 'ajv';
import schema from '@urban-toolkit/autk-grammar/build/autk-grammar-schema.json' with { type: 'json' };

const validate = new Ajv({ allowUnionTypes: true }).compile(schema);
if (!validate(spec)) console.error(validate.errors);
```

## Compute helpers

`runCompute(block, layers, run)` runs one `compute` entry against named FeatureCollections with a GPU runner you pass in, for example `params => new AutkComputeEngine().gpgpuPipeline(params)`. It joins a `wglsFunction` written as an array of lines, resolves `fromFeature` uniforms, and drives `iterate: 'all'` (one dispatch per feature, outputs summed) and `iterate: 'batched'` (one dispatch over packed uniform arrays). autk-compute 4 reads each packed array from a read-only storage buffer of its own, so a batched pass packs as many features as its largest array fits in 128 MiB, the storage buffer binding every WebGPU device supports: 4,194,304 with a matrix entry (a bounding box of eight floats per feature), and `maxBatchedFeatures` gives the count for a pass. `resolveComputeParams(block, layers, iterateIndex?)` returns the parameters of a single dispatch without running anything.

## License

MIT
