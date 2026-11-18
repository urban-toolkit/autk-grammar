# @urban-toolkit/autk-grammar

A declarative grammar for urban visual analytics, running on [Autark](https://autarkjs.org). Describe the data to load, the computations to run, and the maps and plots to draw in one spec, and the grammar wires them together in the browser.

- Documentation: https://autarkjs.org/grammar/
- Examples: https://autarkjs.org/grammar/examples/
- Source: https://github.com/urban-toolkit/autk-grammar

## Installation

```sh
npm install @urban-toolkit/autk-grammar
```

It runs on Autark 4.1.1: `@urban-toolkit/autk-core`, `autk-db`, `autk-map`, `autk-plot` and `autk-compute` 4.1.1 or a later 4.x, installed with it.

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

## Data sources

Each entry of `data` loads or builds one table, in order. Its `type` selects its fields:

| `type` | Fields | Table |
|---|---|---|
| `osm` | `queryArea`, `pbfFileUrl`, `autoLoadLayers` | OpenStreetMap data for an area, from Overpass or a `.osm.pbf` extract (see [OpenStreetMap areas](#openstreetmap-areas)). `autoLoadLayers.layers` splits it into one table per layer, named `<outputTableName>_<layer>`. |
| `csv` | `csvFileUrl` or `csvObject`, `delimiter`, `geometryColumns` | The rows of a CSV file, or of arrays whose first row names the columns. |
| `json` | `jsonFileUrl` or `jsonObject`, `geometryColumns` | The rows of a JSON array. |
| `geojson` | `geojsonFileUrl` or `geojsonObject`, `coordinateFormat`, `layerType` | A FeatureCollection. `layerType` sets how a map draws it, for example `polylines`, or `buildings` for polygons; without it, autk-db reads it from the first feature's geometry. |
| `geotiff` | `geotiffFileUrl`, `coordinateFormat`, `maxRasterCells`, `resampleMethod` | A raster read from a GeoTIFF file. |
| `heatmap` | `joinDataRef`, `near`, `grid`, `groupBy` | A raster grid over the workspace's extent, whose cells aggregate the rows of another table. |
| `join` | `dataRef`, `joinDataRef`, `near`, `groupBy` | No new table: it joins the rows of `joinDataRef` onto the features of `dataRef`, in place. |

Every source but `join` names its table with `outputTableName`, and every source takes a `workspace` (see [Workspaces](#workspaces)).

A `geotiff` source:

| Field | Effect |
|---|---|
| `geotiffFileUrl` | The file's URL, relative to the page or absolute. Its first image is read: each of its bands becomes a band of the table (`band_1`, `band_2`, ...), and the file's no-data value reads as no value. A rotated or sheared grid is refused. |
| `coordinateFormat` | The file's CRS, as an EPSG string. Defaults to `EPSG:4326`. |
| `maxRasterCells` | The most cells to decode: a larger raster is downsampled to fit. Defaults to 1,000,000. |
| `resampleMethod` | How a larger raster is downsampled: `nearest` or `bilinear`, the default. |

A map layer draws the band of a raster table that its `getFnv` names, else the first band.

A `join` or a `heatmap` source:

| Field | Effect |
|---|---|
| `dataRef` | A join's root table, which receives the joined rows. |
| `joinDataRef` | The table whose rows are joined onto the root table, or aggregated into a heatmap's cells. |
| `near` | `{ distance, useCentroid }`, with `distance` in workspace units. A join takes the rows within `distance` of each root feature instead of those that intersect it. A heatmap, which needs it, gives each cell the rows within `distance` of the cell's center. With `useCentroid`, the default, distances run between centroids: a root feature's and a row's, or a cell's center and a row's centroid. With `false`, they run between the geometries' nearest points, so features that touch are 0 apart. |
| `grid` | A heatmap's cells: `{ rows, columns }`, over the extent of the workspace. |
| `groupBy` | How the rows combine, as `[{ column, aggregateFn }]`, where `aggregateFn` is `sum`, `avg`, `count`, `min`, `max`, `weighted` or `collect`. A join writes the result on each root feature: `{ column: 'Unique Key', aggregateFn: 'count' }` writes `sjoin.count.<joinDataRef>`, and `normalize: true` adds the value rescaled from 0 to 1 across the features, under its key with `_norm` added. Without `groupBy`, a join lists the rows each feature matches in `sjoin.matches`. A heatmap has one band per entry, labelled `<aggregateFn>_<joinDataRef>`, which a layer's `getFnv` names as `<aggregateFn>.<joinDataRef>`, for example `count.noise`; without `groupBy`, one band counts the rows. |

```ts
await grammar.run({
  data: [
    { type: 'geojson', outputTableName: 'neighborhoods', geojsonFileUrl: 'neighborhoods.geojson' },
    { type: 'csv', outputTableName: 'noise', csvFileUrl: 'noise.csv', geometryColumns: { latColumnName: 'Latitude', longColumnName: 'Longitude' } },
    { type: 'join', dataRef: 'neighborhoods', joinDataRef: 'noise', groupBy: [{ column: 'Unique Key', aggregateFn: 'count' }] },
    { type: 'heatmap', outputTableName: 'heat', joinDataRef: 'noise', near: { distance: 1000 }, grid: { rows: 20, columns: 20 } },
  ],
  map: { layerRefs: [{ dataRef: 'neighborhoods', getFnv: 'sjoin.count.noise' }, { dataRef: 'heat', opacity: 0.5 }] },
});
```

### Workspaces

A workspace is an isolated set of tables with its own extent. The first source loaded into a workspace sets its extent, and later sources are cut to it, so two areas that must not clip each other go in two workspaces. A table is found by its name inside its workspace, so two workspaces may hold tables of the same name.

`workspace` names one, on a source (where its table goes), a compute pass (where it reads and writes), a map or a plot (where it reads its tables). An entry without one uses the default workspace.

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

## Compute

Each entry of `compute` runs on the GPU with autk-compute, in order, once the data is loaded. Its `type` is `gpgpu`, the default, or `render`.

A GPGPU pass runs a WGSL function once per feature of a table:

| Field | Effect |
|---|---|
| `dataRef` | The table the function runs over. |
| `attributes` | WGSL variable names, each mapped to a feature property path. |
| `wgslFunction` | The body of the WGSL function. An array of strings is joined with newlines, which keeps long shaders readable in JSON. |
| `outputColumnName`, `outputColumns` | The column the function's result is written to, under `feature.properties.compute`, or the columns of a result of several values. |
| `outputTableName` | A new table that receives the result, so `dataRef` stays as it is and later passes, maps and plots can read both. Without it, the pass writes into `dataRef`. |
| `layerType` | How a map draws the new table. Defaults to the type of `dataRef`. Only used with `outputTableName`. |

`attributeArrays` and `attributeMatrices` pass more of each feature's values, and `uniforms`, `uniformArrays` and `uniformMatrices` pass values every invocation shares. `uniforms` and `uniformMatrices` can read theirs from a feature of a table (see [Compute helpers](#compute-helpers)).

A render pass renders tables on the GPU from each viewpoint, in several directions, and counts what each frame shows: a visibility or sky-view metric. Its result is a new table: the viewpoints' features, with the metrics in `feature.properties.compute.render`: `sampleCount`, the frames rendered from the feature, and `classes` or `objects`.

| Field | Effect |
|---|---|
| `outputTableName` | The new table. Required. |
| `layerType` | How a map draws it. Defaults to the type of the viewpoints table, or to `points` with the `building-windows` strategy, whose result holds one point per window. |
| `layers` | The tables drawn into the frames: `{ id, dataRef, type, objectIdProperty }`. `id` names the layer in the pass, `type` sets how it is drawn (`surface`, `parks`, `water`, `roads`, `buildings`, `polygons` or `polylines`: a render pass draws no points, and a run refuses any other type), and `objectIdProperty` names the property that holds an object's id. |
| `viewpoints.dataRef` | The table whose features the frames are rendered from. |
| `viewpoints.strategy` | `{ type: 'centroid' }`, the default: a viewpoint at each feature's centroid. `{ type: 'building-windows', floors }`: windows along each building's facades, `floors` rows of them up its height, each looking out from the facade and 30 degrees to either side. The result then holds one point per window instead of the table's features. |
| `viewpoints.sampling` | With `centroid`, the directions each viewpoint looks in: `directions` of them (1 by default), evenly spaced around the horizon, the first at `azimuthOffsetDeg` degrees counterclockwise from east (0 by default), all at `pitchDeg` degrees above the horizontal (0 by default). |
| `aggregation` | `{ type: 'classes' }` writes the share of each feature's frame pixels that each layer type covers, from 0 to 1. `includeBackground: true` also counts the pixels no layer covers, such as the sky, as one more class, `backgroundLayerType` (`background` by default). `{ type: 'objects' }` writes, for each object seen, the share of the feature's frames that show it. |
| `camera` | The lens of the frames: `fov`, the field of view of each square frame in degrees (90 by default), and `clip: { near, far }`, the nearest and farthest distances drawn, in workspace units (1 and 5000 by default). Unlike a map's `camera`, it sets no position or direction: `viewpoints` does. |
| `tileSize` | The size of each frame in pixels, a multiple of 8. Defaults to 64. |

```ts
await grammar.run({
  data: [/* a buildings table named buildings, and a points table named sensors */],
  compute: [{
    type: 'render',
    outputTableName: 'skyView',
    layers: [{ id: 'buildings', dataRef: 'buildings', type: 'buildings' }],
    viewpoints: { dataRef: 'sensors', sampling: { directions: 8, pitchDeg: 30 } },
    aggregation: { type: 'classes', includeBackground: true },
  }],
  map: { layerRefs: [{ dataRef: 'buildings' }, { dataRef: 'skyView', getFnv: 'compute.render.classes.background' }] },
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

A map's `id` names it as the `target` of a link (see [Plots and links](#plots-and-links)). No two maps or plots of a spec share an id, and an id is never empty.

A map's `camera` moves its view from the one that fits its layers:

| Option | Effect |
|---|---|
| `zoom` | The eye's distance from the point the view looks at: `10000 / 2^(zoom - 10)` workspace units, so each step halves it. Without it, the distance of the view that fits the layers. |
| `pitch` | The tilt from straight down, from 0 to 90 degrees. |
| `bearing` | The compass heading the view faces, clockwise from north, from 0 to 360 degrees. |

The camera turns around the point the map looks at, which the view that fits the layers sets: the eye moves on a sphere around that point, so the layers stay in view at any pitch and bearing.

```ts
map: { id: 'downtown', camera: { zoom: 15, pitch: 50, bearing: 30 }, layerRefs: [{ dataRef: 'buildings' }] }
```

## Layer styling

Besides `dataRef`, a layer of `map.layerRefs` takes these styling options:

| Option | Effect |
|---|---|
| `title` | The layer's id in its map, which its legend shows as its title. Without a title, the id is the `dataRef`. Two layers of one map cannot have the same id. |
| `color` | The layer's color, `#rrggbb`. The layer is drawn in it rather than by its `getFnv` value, unless `isColorMap` is `true`. |
| `stroke` | A polygon layer's outline: its color, `#rrggbb`, or `false` for none. |
| `width` | The width of a polylines or roads layer's lines, in the map's planar units (autk-map's `polylinesWidth`). |
| `pointSize` | The radius of each point of a points layer, in meters on the ground. The adapter converts it to the workspace's planar units at the middle of the layer, where World Mercator stretches a meter by about 1.34 at Chicago, and passes it as autk-map's `pointSize`. Without it, autk-map draws each point with a radius of 64 planar units, about 48 m at Chicago. Other layers ignore it. |
| `colorMapInterpolator` | The color scheme. A raster layer's cells and its legend's labels follow it. |
| `colorMapRange` | The ends of the color scale, `[low, high]` with low less than high. The layer is colored over this range instead of its own lowest and highest values, so layers that set the same range, in one map or in maps side by side, color the same value alike. Raster and vector layers. A categorical scheme ignores it, and a layer cannot set both `colorMapRange` and `colorMapDomain`. On a raster layer, a `transferFunction` still sets opacity from the layer's own values. |
| `colorMapCenter` | On a raster layer, the value at the middle of the color scale. With `colorMapRange`, the scale runs from the range's low through the center to its high (a sequential scheme keeps only the ends). Without it, the scale runs from the center less the farthest value's distance to it, to the center plus that distance. |
| `colorMapReverse` | On a raster layer, runs the color scale from the highest value to the lowest, or from `colorMapRange`'s high to its low. |
| `transferFunction` | On a raster layer, how opaque its cells are by value: autk-map's transfer function (`mode`, `opacityMin`, `opacityMax`, `gamma`, `zeroCenter`). `{ opacityMin: 1, opacityMax: 1 }` draws every cell with a value fully opaque. |

After a run, `grammar.mapLayer(dataRef)` finds the layer a map draws for a table: the `AutkMap` and the layer's id in it. `highlightOnMap`, `clearHighlightOnMap` and a plot's `mapRef` also name a layer by its `dataRef`.

```ts
await grammar.run({
  data: [/* tables named routes and parcels, a points table named fixes, and a heatmap raster named change */],
  map: {
    layerRefs: [
      { dataRef: 'parcels', color: '#4e79a7', stroke: false },
      { dataRef: 'routes', title: 'Fastest route', color: '#e15759', width: 30 },
      { dataRef: 'fixes', title: 'GPS fixes', color: '#f28e2b', pointSize: 2 }, // discs 4 m across
      { dataRef: 'change', title: 'Change', colorMapInterpolator: ColorMapInterpolator.DIV_RED_BLUE, colorMapCenter: 0, colorMapReverse: true },
    ],
  },
});
const { map, layerId } = grammar.mapLayer('routes')!; // layerId is 'Fastest route'
map.updateRenderInfo(layerId, { opacity: 0.5 });
```

## Plots and links

A plot's `id` names it: as the `source` of a link, as the `plotId` of its `plot:selection` events, and for `setPlotSelection` and `clearHighlightOnPlot`. Without an id, a plot is known by its `dataRef`, so two plots of one table need ids to be told apart.

`links` connect a plot to a layer of a map. Picking on the layer selects the same features in the plot (a pick on another layer of the map does not), and a selection in the plot, by an event its `events` lists, highlights them on the layer. The link makes the layer pickable.

| Field | Effect |
|---|---|
| `source` | The plot: its `id`, else its `dataRef`. |
| `target` | The map: its `id`. |
| `layer` | The layer of the target map, by its `title`, else its `dataRef`. Defaults to the layer that draws the plot's `dataRef`. |

A run refuses a link that names no plot, map or layer of the spec. A plot's `mapRef` is a shorthand for a link: it names the table (`dataRef`) of a map layer, and links the plot to the layer that draws it, if a map does.

```ts
await grammar.run({
  layout: { type: 'horizontal', gap: 8 },
  data: [/* a table named parcels */],
  map: { id: 'city', layerRefs: [{ dataRef: 'parcels', title: 'Parcels' }] },
  plot: { id: 'sizes', dataRef: 'parcels', mark: 'scatter', axis: ['area', 'perimeter'], events: ['brush'] },
  links: [{ source: 'sizes', target: 'city', layer: 'Parcels' }],
});
```

## Interactions

A layer with `isPick` and a plot with `events` report what the user selects on `grammar.interactions`: `map:picking` and `plot:selection` give feature ids, the positions of the selected features among those the layer or the plot draws (a map layer leaves out features without a geometry). Every map of the spec reports its picks, though several draw one table. To link a selection to other tables, name the columns whose values identify those rows with `selectFields` on the layer or the plot, for example `selectFields: ['nta2020']`. The grammar does not read it; the events still report feature ids, and the app reads the key values from those rows.

| Event | Field | Value |
|---|---|---|
| `map:picking` | `mapId` | The map the pick was made on: its `id`, else its index in `map` (0 for a single map). |
| `map:picking` | `layerId` | The picked layer's id in its map: its `title`, else its `dataRef`. |
| `map:picking` | `selection` | The picked features' ids. |
| `plot:selection` | `plotId` | The plot: its `id`, else its `dataRef`. |
| `plot:selection` | `event` | The interaction: `click`, `brush`, `brushX` or `brushY`. |
| `plot:selection` | `selection` | The selected features' ids. |

```ts
grammar.interactions.on('map:picking', ({ mapId, layerId, selection }) => { /* feature ids */ });
grammar.interactions.on('plot:selection', ({ plotId, event, selection }) => { /* feature ids */ });
```

## Page layout

A spec's `layout` says how its maps and plots are arranged on the page. The grammar never reads it: the page that hosts the views does, when it makes their canvases and elements.

| Field | Effect |
|---|---|
| `type` | `vertical`, the default, stacks the views; `horizontal` puts them side by side; `grid` fills `columns` columns. |
| `columns` | The number of columns of a `grid`. Defaults to 2. |
| `gap` | The space between views, in pixels. |

The constructor names the elements the views draw in, by id:

| Target | Effect |
|---|---|
| `map` | The canvas a map draws on, or a list of ids, one canvas per entry of `map`, in order. |
| `plot` | The element the plots draw in, or a list of ids, one element per entry of `plot`, in order. With one id, every plot draws in that element. |
| `db` | An element that lists the loaded tables after each data source. |

```ts
const grammar = new AutkGrammar({ map: ['before', 'after'], plot: ['heights', 'areas'] });
```

## Lifecycle

`destroy()` releases what the last run made: it destroys each map (its layers' GPU buffers, its textures, its canvas context, the controls it adds to the page and its event handlers) and clears the grammar's registries, caches and event forwarding. autk-map's maps share one GPU device, which stays for the maps of the next run. `run()` calls it before it starts, so running a new spec on the same instance does not leak the maps of the old one. Call it yourself before the page or the canvases go away.

## JSON Schema

The package ships the grammar's JSON Schema (draft-07) as `@urban-toolkit/autk-grammar/build/autk-grammar-schema.json`, with `$id` `https://autarkjs.org/schema/autk-grammar/v1.json`. Validate a spec with any draft-07 validator:

```ts
import { Ajv } from 'ajv';
import schema from '@urban-toolkit/autk-grammar/build/autk-grammar-schema.json' with { type: 'json' };

const validate = new Ajv({ allowUnionTypes: true }).compile(schema);
if (!validate(spec)) console.error(validate.errors);
```

## Compute helpers

`runCompute(block, layers, run)` runs one `compute` entry against named FeatureCollections with a GPU runner you pass in, for example `params => new AutkComputeEngine().gpgpuPipeline(params)`. It joins a `wgslFunction` written as an array of lines, resolves `fromFeature` uniforms, and drives `iterate: 'all'` (one dispatch per feature, outputs summed) and `iterate: 'batched'` (one dispatch over packed uniform arrays). autk-compute 4 reads each packed array from a read-only storage buffer of its own, so a batched pass packs as many features as its largest array fits in 128 MiB, the storage buffer binding every WebGPU device supports: 4,194,304 with a matrix entry (a bounding box of eight floats per feature), and `maxBatchedFeatures` gives the count for a pass. `resolveComputeParams(block, layers, iterateIndex?)` returns the parameters of a single dispatch without running anything.

## For hosts

A host that runs part of a spec itself, a server that loads its tables for example, calls the functions the grammar runs, so it does exactly what `AutkGrammar` does:

| Export | Effect |
|---|---|
| `createDataAdapter(targets?, cache?)` | The data adapter. Its `resolveSource(db, source)` loads one `data` entry into an autk-db database, a new one when `db` is undefined, and returns it. `cache` receives each GeoJSON table and each table a join wrote. |
| `createComputeAdapter(cache?, types?)` | The compute adapter. Its `resolveCompute(db, pass)` runs one `compute` entry on the GPU. The results are kept only in `cache`, and `types` receives the layer type of each table a pass wrote under its own `outputTableName`. |
| `enterWorkspace(db, workspace?)` | Makes an entry's workspace (the default one without a name) the one autk-db works in, and switches only when another is current. Every adapter calls it before it reads or writes an entry's tables. |
| `tableKey(workspace, name)` | The key of a table in those caches: its name in the default workspace, `<workspace>/<name>` in another. |
| `applyCamera(map, camera)` | Moves an `AutkMap`'s camera as a map's `camera` says, from the view that fits its layers. The map adapter calls it once the layers are loaded, before the map's first `draw()`. |

`@urban-toolkit/autk-grammar/data` exports `createDataAdapter`, `enterWorkspace` and `tableKey` with their types, as an ES module and a CommonJS one. Its code imports `@urban-toolkit/autk-db` alone, never autk-map, autk-plot, autk-compute or autk-core, so it loads where they cannot, such as Node:

```ts
import { createDataAdapter } from '@urban-toolkit/autk-grammar/data';

const adapter = createDataAdapter();
let db: unknown; // the AutkDb the first source creates
for (const source of spec.data ?? []) db = await adapter.resolveSource(db, source);
```

## License

MIT
