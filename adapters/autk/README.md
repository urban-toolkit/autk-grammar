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

## OpenStreetMap areas

An `osm` source's `queryArea` names the area to load in one of two ways, never both:

| Area | Effect |
|---|---|
| `{ geocodeArea, areas }` | The boundaries named in `areas` inside the region `geocodeArea`, for example `{ geocodeArea: 'Chicago', areas: ['Loop'] }`. |
| `{ bbox }` | A box, `[west, south, east, north]` in degrees (WGS84). The box is the whole area: no boundary is read. Each layer is cut to the box, except buildings, which are kept or dropped whole. |

A box needs west less than east and south less than north, and cannot cross the antimeridian. The run refuses any other box, and a `queryArea` with both, with a message that names the source.

```ts
await grammar.run({
  data: [{
    type: 'osm',
    outputTableName: 'downtown',
    pbfFileUrl: 'chicago_downtown.osm.pbf',
    queryArea: { bbox: [-87.66415, 41.858, -87.61232, 41.89966] },
    autoLoadLayers: { layers: ['roads', 'buildings'] },
  }],
  map: { layerRefs: [{ dataRef: 'downtown_roads' }, { dataRef: 'downtown_buildings' }] },
});
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

## Layer styling

Besides `dataRef`, a layer of `map.layerRefs` takes these styling options:

| Option | Effect |
|---|---|
| `title` | The layer's id in its map, which its legend shows as its title. Without a title, the id is the `dataRef`. Two layers of one map cannot have the same id. |
| `color` | The layer's color, `#rrggbb`. The layer is drawn in it rather than by its `getFnv` value, unless `isColorMap` is `true`. |
| `stroke` | A polygon layer's outline: its color, `#rrggbb`, or `false` for none. |
| `width` | The width of a polylines or roads layer's lines, in the map's planar units (autk-map's `polylinesWidth`). |
| `colorMapInterpolator` | The color scheme. A raster layer's cells and its legend's labels follow it. |
| `colorMapCenter` | On a raster layer, the value at the middle of the color scale. The scale then runs from the center less the farthest value's distance to it, to the center plus that distance. |
| `colorMapReverse` | On a raster layer, runs the color scale from the highest value to the lowest. |
| `transferFunction` | On a raster layer, how opaque its cells are by value: autk-map's transfer function (`mode`, `opacityMin`, `opacityMax`, `gamma`, `zeroCenter`). `{ opacityMin: 1, opacityMax: 1 }` draws every cell with a value fully opaque. |

After a run, `grammar.mapLayer(dataRef)` finds the layer a map draws for a table: the `AutkMap` and the layer's id in it. `highlightOnMap`, `clearHighlightOnMap` and a plot's `mapRef` also name a layer by its `dataRef`.

```ts
await grammar.run({
  data: [/* tables named routes and parcels, and a heatmap raster named change */],
  map: {
    layerRefs: [
      { dataRef: 'parcels', color: '#4e79a7', stroke: false },
      { dataRef: 'routes', title: 'Fastest route', color: '#e15759', width: 30 },
      { dataRef: 'change', title: 'Change', colorMapInterpolator: ColorMapInterpolator.DIV_RED_BLUE, colorMapCenter: 0, colorMapReverse: true },
    ],
  },
});
const { map, layerId } = grammar.mapLayer('routes')!; // layerId is 'Fastest route'
map.updateRenderInfo(layerId, { opacity: 0.5 });
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
