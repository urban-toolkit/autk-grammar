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
| `osm` | `queryArea`, `pbfFileUrl`, `autoLoadLayers`, `tagSets` | OpenStreetMap data for an area, from Overpass or a `.osm.pbf` extract (see [OpenStreetMap areas](#openstreetmap-areas)). `autoLoadLayers.layers` splits it into one table per layer, named `<outputTableName>_<layer>`, and [`tagSets`](#tagsets) adds a table for each set of features chosen by their tags. |
| `csv` | `csvFileUrl` or `csvObject`, `delimiter`, `geometryColumns` | The rows of a CSV file, or of arrays whose first row names the columns. |
| `json` | `jsonFileUrl` or `jsonObject`, `geometryColumns` | The rows of a JSON array. |
| `geojson` | `geojsonFileUrl` or `geojsonObject`, `coordinateFormat`, `layerType` | A FeatureCollection. `layerType` sets how a map draws it, for example `polylines`, or `buildings` for polygons; without it, autk-db reads it from the first feature with a geometry. A feature whose geometry is null is a row without one: a map draws nothing for it, and a plot counts it. |
| `geotiff` | `geotiffFileUrl`, `coordinateFormat`, `maxRasterCells`, `resampleMethod` | A raster read from a GeoTIFF file. |
| `heatmap` | `joinDataRef`, `near`, `grid`, `groupBy` | A raster grid over the workspace's extent, whose cells aggregate the rows of another table. |
| `join` | `dataRef`, `joinDataRef`, `near`, `groupBy` | No new table: it joins the rows of `joinDataRef` onto the features of `dataRef`, in place. |
| `sql` | `query`, `layerType` | The rows of a SQL query over the workspace's tables (see [`sql` sources](#sql-sources)). |
| `update` | `dataRef`, `strategy`, `idColumn`, `geojsonObject` or `jsonObject` | No new table: it replaces or changes the rows of `dataRef` (see [`update` sources](#update-sources)). |
| `drop` | `dataRef` | No new table: it drops `dataRef` (see [`drop` sources](#drop-sources)). |

Every source but `join`, `update` and `drop` names its table with `outputTableName`, and every source takes a `workspace` (see [Workspaces](#workspaces)).

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
| `groupBy` | How the rows combine, as `[{ column, aggregateFn }]`, where `aggregateFn` is `sum`, `avg`, `count`, `min`, `max`, `weighted` or `collect`; a heatmap refuses `collect`, which lists rows, since a cell holds one value. A join writes the result on each root feature: `{ column: 'Unique Key', aggregateFn: 'count' }` writes `sjoin.count.<joinDataRef>`, and `normalize: true` adds the value rescaled from 0 to 1 across the features, under its key with `_norm` added. Without `groupBy`, a join lists the rows each feature matches in `sjoin.matches`. A heatmap has one band per entry, labelled `<aggregateFn>_<joinDataRef>`, which a layer's `getFnv` names as `<aggregateFn>.<joinDataRef>`, for example `count.noise`; without `groupBy`, one band counts the rows. |

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

### Heatmap bands

- **Without `groupBy`,** a heatmap's one band counts the rows near each cell, as `[{ column: '*', aggregateFn: 'count' }]` does: the grammar hands autk-db that count, where autk-db 4.1.1 left to itself drew 0 in every cell.
- **An entry of `groupBy` without `aggregateFn` is refused,** as `collect` is, since a cell holds one value: autk-db would list the column's values near each cell, and 4.1.1 drew that band as 0 in every cell, with no error.
- **`count` and `weighted` bands** are right on every autk-db release.
- **`avg`, `sum`, `min` and `max` bands read 0 in every cell on npm's autk-db 4.1.1,** for any column. Autark's next autk-db release fixes it (our urban-toolkit/autark#132), and Curio's vendored autk-db already carries the fix.

### Heatmap `normalize`

An entry of a heatmap's `groupBy` with `normalize: true` asks for its band's values rescaled from 0 to 1 across the grid's cells, as a join's `normalize` rescales a value across the features. It needs an autk-db with urban-toolkit/autark#132, which also adds `_norm` to the band's label, so a layer names it as `<aggregateFn>.<joinDataRef>_norm`. autk-db 4.1.1 builds the band from the values as they are, under the label it would have without `normalize`. A layer can also name a band by its id, `band_1`, `band_2` and so on, one per entry of `groupBy`, in order.

```ts
{ type: 'heatmap', outputTableName: 'heat', joinDataRef: 'noise', near: { distance: 1000 }, grid: { rows: 20, columns: 20 },
  groupBy: [{ column: 'Unique Key', aggregateFn: 'count', normalize: true }] }
```

### `sql` sources

A `sql` source saves the rows of a query over the tables of its workspace as a new table, `outputTableName`:

| Field | Effect |
|---|---|
| `query` | A `SELECT`, or a `WITH` query that ends in one, in DuckDB's SQL, naming the workspace's tables by their names. autk-db refuses any other statement, and any query in which `insert`, `update`, `delete`, `create`, `alter`, `drop`, `truncate` or `replace` appears as a word, even inside a string; the run's message names the source. |
| `layerType` | How a map draws the new table. The query then returns its geometry in a column named `geometry`, as the workspace's tables hold it, in the workspace's CRS. Without it, the table has no layer type: a plot draws its rows, but a map does not draw it and `grammar.data` does not list it. |

A GeoJSON table keeps each feature's properties in a JSON column, `properties`, which `properties->>'name'` reads as text; a CSV or JSON table keeps a column per field. A query that returns `properties` gives each feature those properties; otherwise each column but `geometry` becomes a property. Saving under a table's own name replaces it.

```ts
await grammar.run({
  data: [
    { type: 'geojson', outputTableName: 'neighborhoods', geojsonFileUrl: 'neighborhoods.geojson' },
    { type: 'csv', outputTableName: 'noise', csvFileUrl: 'noise.csv', geometryColumns: { latColumnName: 'Latitude', longColumnName: 'Longitude' } },
    { type: 'join', dataRef: 'neighborhoods', joinDataRef: 'noise', groupBy: [{ column: 'Unique Key', aggregateFn: 'count' }] },
    {
      type: 'sql',
      outputTableName: 'noisiest',
      query: "SELECT properties->>'ntaname' AS name, CAST(properties->'sjoin'->'count'->>'noise' AS INTEGER) AS complaints, geometry FROM neighborhoods ORDER BY complaints DESC NULLS LAST LIMIT 10",
      layerType: 'polygons',
    },
  ],
  map: { layerRefs: [{ dataRef: 'neighborhoods', color: '#d9d9d9' }, { dataRef: 'noisiest', getFnv: 'complaints' }] },
});
```

### `update` sources

An `update` source replaces or changes the rows of a table already loaded, `dataRef`, with rows given in the spec:

| Field | Effect |
|---|---|
| `strategy` | `replace` swaps every row of the table for the given rows. `update` changes the rows whose `idColumn` value a given row has: in a table with a geometry, each takes the given row's geometry and properties, and no row is added; in a table without one, the given rows replace them, and those that match no row are added. |
| `idColumn` | With `update`, the column that matches a given row to the table's rows: a column such as `month`, or a feature property as `properties.<name>`. |
| `geojsonObject` | The rows of a table with a geometry, as a FeatureCollection. autk-db stores their coordinates as they come, so they are in the workspace's CRS, as `grammar.data` gives a table's features. |
| `jsonObject` | The rows of a table without a geometry, such as a CSV or JSON table loaded without `geometryColumns`, as an array of objects. |

A source gives its rows in `geojsonObject` or in `jsonObject`, not both. The maps and plots after it draw the table's rows as they are now. The run's message names the table when autk-db refuses an update.

```ts
await grammar.run({
  data: [
    { type: 'csv', outputTableName: 'sales', csvObject: [['month', 'total'], ['Jan', 3], ['Feb', 5]] },
    { type: 'update', dataRef: 'sales', strategy: 'update', idColumn: 'month', jsonObject: [{ month: 'Feb', total: 9 }, { month: 'Mar', total: 4 }] },
  ],
  plot: { dataRef: 'sales', mark: 'bar', axis: ['month', 'total'] },  // Jan 3, Feb 9, Mar 4
});
```

### `drop` sources

A `drop` source drops a table, `dataRef`, from its workspace: the sources, compute passes, maps and plots after it no longer find it, and `grammar.data` no longer lists it. It suits a table a spec needs only on the way, such as the rows a join aggregates. The run refuses a drop of a table the workspace does not hold, with a message that names the table.

```ts
data: [
  { type: 'geojson', outputTableName: 'neighborhoods', geojsonFileUrl: 'neighborhoods.geojson' },
  { type: 'csv', outputTableName: 'noise', csvFileUrl: 'noise.csv', geometryColumns: true },
  { type: 'join', dataRef: 'neighborhoods', joinDataRef: 'noise', groupBy: [{ column: 'Unique Key', aggregateFn: 'count' }] },
  { type: 'drop', dataRef: 'noise' },
],
```

### Workspaces

A workspace is an isolated set of tables with its own extent. The first source loaded into a workspace sets its extent, and later sources are cut to it, so two areas that must not clip each other go in two workspaces. A table is found by its name inside its workspace, so two workspaces may hold tables of the same name.

`workspace` names one, on a source (where its table goes), a compute pass (where it reads and writes), a map or a plot (where it reads its tables). An entry without one uses the default workspace.

### `workspaces`

A spec's `workspaces` sets how a workspace stores its tables, one entry per workspace, before the first source loads:

| Field | Effect |
|---|---|
| `name` | The workspace, by the name its entries give as their `workspace`. Without it, the default workspace. |
| `coordinateFormat` | The CRS the workspace stores its tables in, as an EPSG string such as `EPSG:3857`. Each source is transformed to it as it loads, and its maps draw in its units. autk-db's default is `EPSG:3395`, World Mercator, in meters. |
| `precisionGrid` | The grid every stored coordinate is rounded to, in the CRS's units, greater than 0. autk-db's default is 0.01, a centimeter in World Mercator. A geometry the grid collapses is refused as it loads. |

Both fields are required, and a run refuses two entries for one workspace. A workspace without an entry keeps autk-db's defaults. The lengths given in workspace units are in the CRS's units: a `near.distance`, a layer's `width`, a camera's `zoom`. A layer's `pointSize`, in meters, is converted for World Mercator and Web Mercator, and read as planar units in any other CRS.

```ts
await grammar.run({
  workspaces: [{ coordinateFormat: 'EPSG:3857', precisionGrid: 1 }],  // the default workspace, in Web Mercator to the meter
  data: [{ type: 'geojson', outputTableName: 'parcels', geojsonFileUrl: 'parcels.geojson' }],
  map: { layerRefs: [{ dataRef: 'parcels' }] },
});
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

### `tagSets`

An `osm` source's `tagSets` choose features by their tags. Each set becomes a table of one geometry type, named `<outputTableName>_<name>_<type>` and cut to the source's area. Tag sets are read from the Overpass API only: a source with `pbfFileUrl` cannot take them, and the run refuses one that does, with a message that names the source.

| Field | Effect |
|---|---|
| `name` | Names the set's table: a lowercase letter, then up to 31 lowercase letters, digits or `_`. No two sets of a source share a name. |
| `type` | The table's geometry: `points`, the tagged nodes; `polylines`, the open ways and the ways tagged as lines (`highway`, `barrier`, `railway`, `waterway`, or `area=no`); `polygons`, the other closed ways and the multipolygon relations. |
| `tags` | 1 to 64 tags, each `{ key, value }`: a feature is in the set when it has any one of them. Without `value`, the key with any value matches. |

A source takes up to 8 sets, and may leave out `autoLoadLayers` to load its sets alone. A set that matches no feature in the area makes no table. Each feature's properties are its tags.

```ts
await grammar.run({
  data: [{
    type: 'osm',
    outputTableName: 'downtown',
    queryArea: { bbox: [-74.0125, 40.705, -74.008, 40.7085] },
    tagSets: [
      { name: 'cafes', type: 'points', tags: [{ key: 'amenity', value: 'cafe' }] },
      { name: 'paths', type: 'polylines', tags: [{ key: 'highway', value: 'footway' }, { key: 'highway', value: 'path' }] },
    ],
  }],
  map: { layerRefs: [{ dataRef: 'downtown_paths_polylines' }, { dataRef: 'downtown_cafes_points', color: '#8c564b' }] },
});
```

### `forceRefresh`

autk-db keeps the Overpass API's answer for an `osm` source in the browser's cache for 24 hours, by its area, its layers and its tag sets, and a later run of the same source reads it from there. `forceRefresh: true` queries the API again, and caches the new answer. A source with `pbfFileUrl` reads its file each time, and ignores it.

```ts
{ type: 'osm', outputTableName: 'loop', queryArea: { geocodeArea: 'Chicago', areas: ['Loop'] }, autoLoadLayers: { layers: ['roads'] }, forceRefresh: true }
```

### `autoLoadLayers.coordinateFormat`

The CRS of an `osm` source's coordinates, as an EPSG string. It defaults to `EPSG:4326`, the degrees the Overpass API and OpenStreetMap's extracts give, so a source sets it only for data in another CRS. The layers and the tag sets are read in it, and stored in the workspace's CRS.

```ts
{ type: 'osm', outputTableName: 'area', pbfFileUrl: 'area-nad83.osm.pbf', queryArea: { bbox: [-74.02, 40.70, -74.00, 40.72] }, autoLoadLayers: { layers: ['roads'], coordinateFormat: 'EPSG:4269' } }
```

### `osmElements`

A map layer or a plot with `osmElements: true` reads an OpenStreetMap layer table as one feature per OSM element it was built from, rather than one per row. Each feature's properties are the element's tags, its `osm_type` (`node`, `way` or `relation`) and its `osm_id`; in a buildings table, whose parts are elements of their own, also the `building_id` of its building. A part takes only its own tags, so a buildings layer draws only the parts whose tags give their height. A compute pass that changes the table in place leaves autk-db's elements as they were, so they are read without the pass's columns. A table that is not an OSM layer, a surface, and an OSM table an `update` source or an in-place `writeBack` changed are read row by row, as without it.

```ts
map: { layerRefs: [{ dataRef: 'downtown_roads', osmElements: true, getFnv: 'highway', colorMapInterpolator: ColorMapInterpolator.CAT_TABLEAU10 }] },
plot: { dataRef: 'downtown_roads', mark: 'table', axis: ['osm_id', 'highway', 'name'], osmElements: true },
```

## Compute

Each entry of `compute` runs in order, once the sources without [`after`](#after) are loaded. Its `type` is `gpgpu`, the default, or `render`, which run on the GPU with autk-compute, or `windows` or `clusters`, which run on the CPU through autk-core. A run refuses a pass of any other `type`.

A GPGPU pass runs a WGSL function once per feature of a table:

| Field | Effect |
|---|---|
| `dataRef` | The table the function runs over. |
| `attributes` | WGSL variable names, each mapped to a feature property path. |
| `wgslFunction` | The body of the WGSL function. An array of strings is joined with newlines, which keeps long shaders readable in JSON. |
| `outputColumnName`, `outputColumns` | The column the function's result is written to, under `feature.properties.compute`, or the columns of a result of several values. |
| `outputTableName` | A new table that receives the result, so `dataRef` stays as it is and later passes, maps and plots can read both. Without it, the pass writes into `dataRef`. |
| `layerType` | How a map draws the new table. Defaults to the type of `dataRef`. Only used with `outputTableName`. |
| `writeBack` | Also keep the result in autk-db (see [`writeBack`](#writeback)). |

`attributeArrays` and `attributeMatrices` pass more of each feature's values, and `uniforms`, `uniformArrays` and `uniformMatrices` pass values every invocation shares. `uniforms` and `uniformMatrices` can read theirs from a feature of a table (see [Compute helpers](#compute-helpers)).

A pass reads such a `fromFeature` table as an earlier pass wrote it; else, when a GeoJSON source of the run loaded it with its coordinates in its workspace's CRS, as the source gave its features, as a plot reads its table; else as autk-db keeps it. The pass's own `dataRef` is read as autk-db keeps it, as a map draws it.

A batched entry that reads the geometry, with a path that starts with `geometry.`, packs each polygon as a feature of its own: each polygon of a MultiPolygon, and of a GeometryCollection, with the feature's properties, beside which every other batched value of the feature repeats. autk-db keeps each feature of a `buildings` table in its building model, one GeometryCollection per building with each part's tags in `properties.parts`, so each polygon of a building read as autk-db keeps it also takes its part's tags. A path such as `geometry.coordinates.0` then reads every polygon's outer ring, from a source's own features and from autk-db's buildings alike, and `num_features` counts the polygons.

When an attribute reads the geometry of the pass's own table, a MultiLineString is handed to autk-compute as one line of its points, in their order: autk-compute packs a matrix attribute row by row, and a MultiLineString's rows are lines. The pass's result keeps each feature's own geometry.

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
| `writeBack` | Also keep the result in autk-db (see [`writeBack`](#writeback)). |

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

### `windows` passes

A windows pass places the windows of a buildings table in a new table, one point a window, as a render pass's `building-windows` strategy places the viewpoints it renders from: the same autk-core code (`TriangulatorBuildingWithWindows.buildWindowLayout`) on the table read the same way, so the two hold the same points in the same order. It runs on the CPU, with no GPU.

| Field | Effect |
|---|---|
| `dataRef` | The buildings table, read as an earlier pass wrote it, else as autk-db keeps it. |
| `floors` | The rows of windows on each facade, spread evenly up each building's height, as `viewpoints.strategy.floors` places them. autk-core rounds it down and places at least one row. |
| `outputTableName` | The new table. Required. |
| `layerType` | How a map draws it. Defaults to `points`. |
| `writeBack` | Also keep the windows in autk-db (see [`writeBack`](#writeback)). |

The windows are about 6 workspace units apart along each facade, one row a floor, each at the middle of its window: a point `[x, y, z]`, `z` its height above the ground. A building without a height is taken as 20 units high. Each window is a feature whose id is the window's, `windowId`, with these properties:

| Property | Value |
|---|---|
| `sourceFeatureIndex` | The building's row in `dataRef`. |
| `geometryIndex`, `polygonIndex`, `ringIndex`, `edgeIndex` | Where its facade is in the building's geometry: its part, its polygon, its ring (0 the outer one) and its edge. |
| `floorIndex`, `windowIndex` | Its floor, from 0 at the bottom, and its place along the edge. |
| `center`, `normal` | Its middle and the direction its facade faces. |
| `width`, `height`, `buildingHeight` | Its size, and its building's height. |

A run refuses a `floors` that is not a number, and a table autk-core finds no facades in, such as a table of points, naming the pass.

```ts
compute: [{ type: 'windows', dataRef: 'fidi_buildings', floors: 6, outputTableName: 'fidi_windows' }],
map: { layerRefs: [{ dataRef: 'fidi_surface' }, { dataRef: 'fidi_windows', getFnv: 'buildingHeight' }] },
```

### `clusters` passes

A clusters pass gives each row of a table the id of its cluster: rows whose geometries intersect or touch, directly or through other rows, share one, as autk-core's `computeIntersectingClusterIds` finds them. Buildings that share walls fall in one cluster, so do roads that meet. It runs on the CPU, with no GPU.

| Field | Effect |
|---|---|
| `dataRef` | The table, read as an earlier pass wrote it, else as autk-db keeps it. |
| `outputColumnName` | The column the cluster ids are written to, under `feature.properties.compute`, as a GPGPU pass writes its result. |
| `outputTableName` | A new table that receives the rows with their ids, so `dataRef` stays as it is. Without it, the pass writes into `dataRef`. |
| `layerType` | How a map draws the new table. Defaults to the type of `dataRef`. Only used with `outputTableName`. |
| `writeBack` | Also keep the result in autk-db (see [`writeBack`](#writeback)). |

The ids are whole numbers from 0: the first row's cluster is 0, and each other cluster takes the next number in the order of its first row. A row without a geometry, or with an empty one, as a GeoJSON source loads a row whose geometry is null, is in no cluster: its id is `null`. Rows are told apart by their place in the table, not by their feature ids.

```ts
compute: [{ type: 'clusters', dataRef: 'fidi_buildings', outputColumnName: 'block', outputTableName: 'fidi_blocks' }],
map: { layerRefs: [{ dataRef: 'fidi_blocks', getFnv: 'compute.block', colorMapInterpolator: ColorMapInterpolator.CAT_TABLEAU10 }] },
```

### `writeBack`

A pass of any type with `writeBack: true` also keeps its result in autk-db, in the pass's workspace, so that autk-db's own operations read it: a source that runs after compute, such as a join, a heatmap, a `sql` source or an update, and a host that reads autk-db after the run, or runs the passes on a database of its own (see [Compute steps on a host's database](#compute-steps-on-a-hosts-database)). Later passes, maps and plots read the result as they do without it.

- **A new table**, a pass's `outputTableName` (a render or windows pass always has one): autk-db holds every row of the result, with its feature id and its properties, as a layer of the type a map draws it as. autk-db cuts a source it loads to the workspace's extent and crop layer, but not a result written back, so the windows of a building that reaches past the crop layer stay.
- **In place**, a GPGPU or clusters pass without `outputTableName`: each row of autk-db's table takes the result's properties, matched by its feature id. The table keeps its other columns, and each building its parts. autk-db clears its records of an OSM table's elements, as it does on any update, so `osmElements` on that table then gives its rows.
- autk-db puts each coordinate on the workspace's precision grid, as it does for every table, and keeps a point's height. A polygon's ring may then start at another of its vertices.

A run refuses `writeBack` on a raster, and on a new table whose layer type it cannot tell, naming the pass. It also refuses a result autk-db does not then hold row for row.

```ts
compute: [{ type: 'clusters', dataRef: 'fidi_buildings', outputColumnName: 'block', outputTableName: 'fidi_blocks', writeBack: true }],
```

### `after`

A source with `after: 'compute'` runs once every compute pass has run, instead of before them, so it reads what passes kept in autk-db with `writeBack`: a join or a heatmap over a pass's result, a `sql` source that queries it, an update or a drop. Every type of source takes it. The sources with it run in the order of `data`, after all those without it, wherever they stand in `data`; the maps and plots are drawn once they have run.

- **A source after compute that reads a table a pass writes without `writeBack` is refused,** naming both, since autk-db holds that table without the pass's result. A `sql` source's query is not checked.
- **A source that writes a table a pass wrote,** such as a join into it, an update, a `sql` source saved under its name or a drop, changes autk-db's table, and the maps, plots and `grammar.data` then read that table: the pass's columns and the source's together.
- **A join's or a heatmap's `groupBy` reads a compute column by its path,** `compute.<column>`. A join writes an aggregate of it under the key `<joinDataRef>.<column>`, which a layer's `getFnv` reads as a path: `sjoin.max.squares.compute.cluster`.

```ts
await grammar.run({
  data: [
    { type: 'osm', outputTableName: 'fidi', pbfFileUrl: '/data/lower_mnt.osm.pbf', queryArea: { bbox: [-74.0132, 40.7032, -74.0072, 40.7088] }, autoLoadLayers: { layers: ['buildings'] } },
    {
      type: 'sql',
      outputTableName: 'largest_blocks',
      query: "SELECT CAST(properties->'compute'->>'block' AS INTEGER) AS block, CAST(count(*) AS INTEGER) AS buildings FROM fidi_blocks GROUP BY block ORDER BY buildings DESC, block LIMIT 10",
      after: 'compute',
    },
  ],
  compute: [{ type: 'clusters', dataRef: 'fidi_buildings', outputColumnName: 'block', outputTableName: 'fidi_blocks', writeBack: true }],
  plot: { dataRef: 'largest_blocks', mark: 'bar', axis: ['block', 'buildings'], tickFormats: [',~f', ',~f'] },
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
| `pitch` | The tilt from straight down, in degrees, at least 0 and less than 90. At 90 the eye would sit on the ground, edge-on to the flat layers, and the map could not pan, so a run refuses it. |
| `bearing` | The compass heading the view faces, clockwise from north, from 0 to 360 degrees. |
| `center` | The point the view looks at, `[longitude, latitude]` in degrees (see [`camera.center`](#cameracenter)). |
| `motion` | A camera tour the map plays once it is drawn (see [`camera.motion`](#cameramotion)). |

The camera turns around the point the map looks at, `center` or else the one the view that fits the layers sets: the eye moves on a sphere around that point, so the layers stay in view at any pitch and bearing. The view's up direction stays across its line of sight, as autk-map's own tilt leaves it, so the map's pan, tilt and zoom at the cursor carry on from the spec's view as they do from a view the user tilted.

```ts
map: { id: 'downtown', camera: { zoom: 15, pitch: 50, bearing: 30 }, layerRefs: [{ dataRef: 'buildings' }] }
```

### `camera.center`

`center` is the point the view looks at, as `[longitude, latitude]` in degrees (WGS84). The run puts it in the CRS of the map's workspace with autk-db's own transform, as autk-db puts a source's coordinates there, so it names the same place in World Mercator, autk-db's default, and in any CRS a `workspaces` entry sets. The eye then turns around it as `zoom`, `pitch` and `bearing` say; with `center` alone, it looks straight down on it, as high as the view that fits the layers. A run refuses a `center` that is not two numbers in range, and one autk-db's transform gives no point for.

```ts
map: {
  camera: { center: [-74.0110, 40.7069], zoom: 15, pitch: 50, bearing: 30 },  // the New York Stock Exchange
  layerRefs: [{ dataRef: 'fidi_surface' }, { dataRef: 'fidi_buildings' }],
}
```

### `camera.motion`

`motion` is a camera tour: steps the view takes one after another, through autk-core's `CameraMotion`, once the map is drawn, from the view the rest of `camera` sets. Each step is `{ type, amount, seconds, pan? }`, and its `amount` is in the unit of the camera field of the same name:

| `type` | `amount` |
|---|---|
| `zoom` | Zoom levels: each halves the eye's distance from the point the view looks at, and a negative one doubles it. |
| `pitch` | Degrees of tilt, away from straight down when positive. `pan` moves the point the view turns around by that many workspace units during the step, toward the top of the view when positive. |
| `bearing` | Degrees of heading, clockwise when positive: the view turns around the point it looks at. |
| `roll` | Degrees the view turns around its line of sight: the direction at the top of the view turns clockwise when positive. Looking straight down, a roll turns the heading, as `bearing` does; on a tilted view it banks the horizon. |

Each step takes its `seconds`, more than 0, easing in and out, and sets the camera at every animation frame, so the map draws each one. The tour stops when the user drags, scrolls or presses a key on the map, so the map's own pan, tilt and zoom take over from where the tour had the view. `run()` does not wait for the tour: `grammar.tours` holds the tour of each map, in the order of `grammar.maps`, and a tour's `done` settles once its last step ends, or once it is stopped. `destroy()`, and so the next run, stops the tours of its maps.

A run refuses a tour before it draws the map when a step has another `type`, no `amount`, no time, or a `pan` on a step other than `pitch`. The camera's `pitch` and the tour's `pitch` steps add up, in order, to a tilt that stays at least 0 and less than 90 degrees, as `camera.pitch` does: at 90 the line of sight would meet the ground nowhere. A `pitch` step turns the view around its side, so after a `roll` of a tilted view it would also turn the heading: a run refuses a `pitch` step of a banked view until rolls undo the bank.

```ts
map: {
  camera: {
    center: [-74.0110, 40.7069], zoom: 14,
    motion: [
      { type: 'zoom', amount: 1.5, seconds: 2 },
      { type: 'pitch', amount: 55, seconds: 2.5, pan: 150 },
      { type: 'bearing', amount: 90, seconds: 4 },
    ],
  },
  layerRefs: [{ dataRef: 'fidi_surface' }, { dataRef: 'fidi_buildings' }],
}
```

```ts
await grammar.run(spec);
await grammar.tours[0]?.done;  // the tour has ended: the view is where its steps add up to
```

### `terrain`

A map's `terrain` raises its ground to the heights a raster band gives, through autk-map's terrain mode: the ground the raster covers rises to its heights, the map's flat layers are draped over it, and its buildings stand on it. The view fits the raster, and the map's `camera` moves from there.

| Field | Effect |
|---|---|
| `dataRef` | The raster table of heights, in the workspace's units: a `geotiff` source of an elevation model in meters, for example. It is a table of the map's workspace. A cell without a value lies at height 0. |
| `band` | The band of heights, by its id (`band_1`, ...) or its label, as a raster layer's `getFnv` names one. Defaults to the first band. |

A run refuses a `dataRef` that names no raster table of the map's workspace, and a `band` that names none of the bands of a raster of several.

On a map with a terrain, the `camera` looks at the ground: the point it looks at lies at the terrain's height there, and `zoom` sets the eye's distance from that point, so the eye stays above ground high above z = 0. Each step of a camera tour turns the view around the ground its line of sight meets as the step starts. `applyCamera` and `playCameraMotion` measure from the terrain of a map the grammar drew; on a map whose terrain a host raised itself, they measure from z = 0.

autk-map 4.1.1 measures from z = 0 in two places of its own:

- **The ground its layers are draped over:** it finds the part of the terrain its layers' overlay covers with rays to z = 0, so a view close over high ground and tilted far from straight down can draw nothing.
- **Its fit of the view to the terrain:** it also measures from z = 0, so on a small raster high above z = 0, a map without a `camera` can start with its eye under the ground.

```ts
data: [
  { type: 'geojson', outputTableName: 'neighborhoods', geojsonFileUrl: '/data/mnt_neighs.geojson' },
  { type: 'geotiff', outputTableName: 'elevation', geotiffFileUrl: '/data/mnt_dem.tif', coordinateFormat: 'EPSG:3857' },
],
map: { terrain: { dataRef: 'elevation' }, camera: { zoom: 10, pitch: 60, bearing: 30 }, layerRefs: [{ dataRef: 'neighborhoods' }] },
```

### `style`

A map's `style` names one of autk-map's styles, such as `apple`, its default, or `light`, and a name autk-map does not know draws in `apple`. It can also give the colors of a style of the spec's own, each `#rrggbb`: autk-map takes a style only whole, so a run refuses one that lacks any of the nine.

| Color | Effect |
|---|---|
| `background` | The map's background, where no layer is drawn. |
| `surface`, `parks`, `water`, `roads`, `buildings`, `points`, `polylines`, `polygons` | The layers of each of those types. |

A layer with a `color` is drawn in it instead, and a layer colored by value in its scheme.

```ts
map: {
  style: {
    background: '#0b1a2a', surface: '#13263a', parks: '#1f4d3a', water: '#08121d', roads: '#3a5068',
    buildings: '#5b7083', points: '#f2c14e', polylines: '#7f97ad', polygons: '#2a3d52',
  },
  layerRefs: [{ dataRef: 'downtown_surface' }, { dataRef: 'downtown_roads' }, { dataRef: 'downtown_buildings' }],
}
```

### `highlightColor` and `invalidValueColor`

| Key | Effect |
|---|---|
| `highlightColor` | The color of the features the map draws as picked: by the user, by a layer's `pickedComps`, by a link, or by a call such as `highlightOnMap`, `#rrggbb`. autk-map's is `#5dade2`. |
| `invalidValueColor` | The color of the features of a layer colored by value whose value autk-map cannot color, `#rrggbb`: on a layer of numbers, a feature without the value or with one that does not read as a finite number (`null` and an empty string read as 0); on a layer of categories, a feature without the value or with a category outside its `colorMapDomain`. A number outside the scale takes the color of the scale's nearer end. autk-map's is `#ffffff`. |

autk-map keeps both for each map, unlike autk-plot's mark and highlight colors, which are the page's: each map of a spec draws in its own.

```ts
map: { highlightColor: '#ff7f0e', invalidValueColor: '#bfbfbf', layerRefs: [{ dataRef: 'parcels', getFnv: 'value', isPick: true }] }
```

### `showUi`

autk-map puts a menu of the map's layers at the map's top left and a legend at its bottom right. A map with `showUi: false` has neither; its "made with autark" credit stays. Without it, or with `true`, the map shows both.

```ts
map: { showUi: false, layerRefs: [{ dataRef: 'parcels', getFnv: 'area' }] }
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

On a raster layer, `getFnv` names the band to draw: by its id, such as a GeoTIFF's `band_24`, or by its label, such as `count.noise` for a heatmap's `count_noise`. Without it, the layer draws the first band. A run refuses a `getFnv` that names none of the bands of a raster of several, and a raster of one band draws that band.

After a run, `grammar.mapLayer(dataRef)` finds the layer a map draws for a table: the `AutkMap`, the layer's id in it, and the collection the run handed autk-map for it, the last map's when several maps draw the table. `grammar.mapLayers(dataRef)` lists every layer that draws it, in every map. `highlightOnMap`, `clearHighlightOnMap` and a plot's `mapRef` also name layers by their `dataRef` (see [Interactions](#interactions)).

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

### `buildingsZeroHeight`

autk-map leaves out a building part that has no height: none of `height`, `building:height`, `levels` and `building:levels`. A buildings layer with `buildingsZeroHeight: true` draws each such part with a random height of 3 to 7 floors of 3.4 m, from 10.2 to 23.8 m, so a city whose map data gives few heights is not left half empty. The heights are drawn again at each run. A part with one of those keys whose height is not above its minimum, such as `height: 0`, is still left out. Other layers ignore it.

```ts
map: { layerRefs: [{ dataRef: 'downtown_buildings', buildingsZeroHeight: true }] }
```

### `legend`

A map's legend shows the color scale of one layer: the last layer whose colors autk-map set, about the last layer colored by value. A layer with `legend: true` is the one it shows, and on a raster layer, whose legend autk-map hides without a scale of its own, it shows it. Picking stays as the layers' `isPick` sets it: autk-map's own legend choice, `changeActiveLayer`, would also make the layer the only one of the map that picks.

A run refuses `legend` on two layers of a map, on a layer drawn in one color, and on a map whose `showUi` is `false`, which has no legend.

```ts
map: { layerRefs: [{ dataRef: 'income', getFnv: 'median', legend: true }, { dataRef: 'schools', getFnv: 'enrollment', isPick: true }] }
```

### `skippedComps`

A layer's `skippedComps` lists the features it hides, by their positions among those it draws, as `map:picking` events and `highlightOnMap` give them: a filter the map applies as it is drawn. It hides features of every layer of polygons, lines, points or buildings. A run refuses it on a raster layer, and a position that is not a whole number from 0 or is past the last feature the layer draws.

autk-map 4.1.1 can still pick a hidden feature of a points, polygons or buildings layer, and Autark's main a hidden point: its picking pass draws them. The grammar leaves the hidden features out of the picks its `map:picking` events report, and out of the selections it hands the plots linked to the layer. A host that listens to the map's own events (`map.events`) still hears them.

```ts
map: { layerRefs: [{ dataRef: 'parcels', skippedComps: [2, 5] }] }
```

### `widthBy`

A roads layer draws each line as wide as autk-map draws its kind of road, and `width` gives every line one width. A roads layer's `widthBy` is the dot path to each line's own width, relative to `feature.properties`, in the map's planar units: autk-map's widths by feature. A line without a positive number there keeps the width of its kind of road.

autk-map draws every line of a polylines layer at one width, which wins over widths by feature, so a run refuses `widthBy` on a polylines layer: draw the table as roads, with `layerType: 'roads'`. A run also refuses `widthBy` with `width`, and a path that gives no line of the layer a width.

```ts
map: { layerRefs: [{ dataRef: 'segments', layerType: 'roads', widthBy: 'compute.width', getFnv: 'traffic' }] }
```

### `layerType`

A layer draws its table as the table's own type, which its source or compute pass gave it. A layer's `layerType` draws the table as another type of its kind of geometry, in that type's color of the map's style and the way autk-map draws that type:

| Table | `layerType` |
|---|---|
| Polygons, and the surface, parks, water and buildings tables | `polygons`, `surface`, `parks`, `water`, or `buildings`, each feature raised by its `height`, `building:height`, `levels` or `building:levels` |
| Lines, and the roads tables | `polylines`, or `roads`, each line as wide as its kind of road |
| Points | `points` |
| A raster | `raster` |

A run refuses a type of another kind of geometry, for which autk-map would draw nothing. It also refuses a layer whose features autk-map makes nothing of, naming the cause: as `buildings`, features none of which has `height`, `building:height`, `levels` or `building:levels`, the four keys autk-core raises a building part from (or with `buildingsZeroHeight`, none of which has a height above its minimum). A table with no feature to draw is not refused. autk-map draws surface, parks, water and roads layers below every other layer, in that order, whatever the order of `layerRefs`.

```ts
map: {
  layerRefs: [
    { dataRef: 'green_space', layerType: 'parks' },          // a polygons table, in the style's parks color
    { dataRef: 'downtown_buildings', layerType: 'polygons' }, // the footprints, flat
  ],
}
```

## Plots and links

A plot reads only its table's properties, so it also draws a table without a geometry, such as a CSV or JSON table loaded without `geometryColumns`.

A plot's `id` names it: as the `source` of a link, as the `plotId` of its `plot:selection` events, and for `setPlotSelection` and `clearHighlightOnPlot`. Without an id, a plot is known by its `dataRef`, so a run refuses two plots known by one name: two plots of one table without ids, or a plot whose id is the `dataRef` of a plot without one. Give each plot an id.

`links` connect a plot to a layer of a map. Picking on the layer selects the same features in the plot (a pick on another layer of the map does not), and a selection in the plot, by an event its `events` lists, highlights them on the layer. The link makes the layer pickable. A selection passes by the rows each view drew, not by positions: a plot draws its table's rows in the order its source gave them, while a layer draws the rows autk-db holds, which can come in another order, and leaves out the rows without a geometry. Each row is found in the other view by its feature id: a GeoJSON feature's `id`, else the one autk-db gives it, `autk-feature-<index>`.

| Field | Effect |
|---|---|
| `source` | The plot: its `id`, else its `dataRef`. |
| `target` | The map: its `id`. |
| `layer` | The layer of the target map, by its `title`, else its `dataRef`. Defaults to the layer that draws the plot's `dataRef`. |

A run refuses a link that names no plot, map or layer of the spec. A plot's `mapRef` is a shorthand for links: it names the table (`dataRef`) of map layers, and links the plot to every layer that draws it, in every map.

```ts
await grammar.run({
  layout: { type: 'horizontal', gap: 8 },
  data: [/* a table named parcels */],
  map: { id: 'city', layerRefs: [{ dataRef: 'parcels', title: 'Parcels' }] },
  plot: { id: 'sizes', dataRef: 'parcels', mark: 'scatter', axis: ['area', 'perimeter'], events: ['brush'] },
  links: [{ source: 'sizes', target: 'city', layer: 'Parcels' }],
});
```

## Plot styling

Besides its table, mark and columns, a plot takes these keys. The Autark adapter reads them; the deck.gl adapter ignores them.

### `colorMapInterpolator` and `categoricalColorMapInterpolator`

A plot colors its marks by the values of its `color` column: a scatter plot's points, a bar chart's bars, and the lines of parallel coordinates, which a click on an axis's title colors by that axis instead. A heat matrix colors its cells by their values. Line charts and tables color no mark by value. When every value is a number, or a string that reads as one, the marks take the scheme of numbers; otherwise the values are categories, and take the scheme of categories.

| Key | Effect |
|---|---|
| `colorMapInterpolator` | The scheme of numbers: a sequential or diverging `interpolate*` scheme, `interpolateReds` by default. The scale's low end takes its first color and its high end its last: the lowest and highest values, unless `colorMapRange` or `normalization` sets them. |
| `categoricalColorMapInterpolator` | The scheme of categories: a `scheme*` scheme, `schemeObservable10` by default. The categories take its colors in the order they first appear, or in `colorMapDomain`'s order, and those past its last color take that one. |

A run refuses a `scheme*` name as `colorMapInterpolator`, and an `interpolate*` name as `categoricalColorMapInterpolator`.

```ts
plot: { dataRef: 'parcels', mark: 'bar', axis: ['id', 'area'], color: 'landuse', categoricalColorMapInterpolator: ColorMapInterpolator.CAT_SET2 }
```

### `colorMapRange`, `colorMapDomain` and `normalization`

These set the domain of a plot's color scale as they set a map layer's:

| Key | Effect |
|---|---|
| `colorMapRange` | The ends of the scale of numbers, `[low, high]` with low less than high. The plot is colored over this range instead of its own lowest and highest values, so plots and map layers that set the same range color the same value alike. A plot colored by categories ignores it, as a layer with a categorical scheme does, and a plot cannot set both `colorMapRange` and `colorMapDomain`. |
| `colorMapDomain` | The categories the plot is colored over, in order: the first takes the scheme of categories' first color, and so on. The values are read as categories, numbers too, and a mark whose value it does not name is drawn in the mark color. |
| `normalization` | How the ends of the scale of numbers are found: `{ mode: 'minMax' }`, the default, takes the lowest and highest values, and `{ mode: 'percentile', lowerPercentile, upperPercentile }` the values at those percentiles, 2 and 98 when it gives neither, else 0 and 100 for the one it leaves out. |

Parallel coordinates read them for their `color` column, and keep them for any axis a click on its title colors the lines by: under a `colorMapRange`, an axis of categories colors no line.

```ts
map: { layerRefs: [{ dataRef: 'tracts', getFnv: 'income', colorMapInterpolator: ColorMapInterpolator.SEQ_BLUES, colorMapRange: [0, 200000] }] },
plot: { dataRef: 'tracts', mark: 'scatter', axis: ['area', 'income'], color: 'income', colorMapInterpolator: ColorMapInterpolator.SEQ_BLUES, colorMapRange: [0, 200000] },
```

### `tickFormats`

The d3-format specifiers of the tick labels of a plot's axes, `[x, y]`, such as `~s`, `,d`, `.2f` or `.0%`. Without it, `['~s', '~s']`.

| Mark | Reads |
|---|---|
| `scatter` | x for the x axis and y for the y axis. |
| `bar` | x for the x axis's labels that read as numbers, and y for the y axis. |
| `line`, `linechart` | x for the x axis's buckets that read as numbers, and y for the y axis. |
| `parallel-coordinates` | x for every axis of numbers. |
| `heatmatrix`, `table` | Neither. |

A run refuses a list that is not two specifiers d3-format reads.

```ts
plot: { dataRef: 'parcels', mark: 'scatter', axis: ['area', 'share'], tickFormats: [',.0f', '.0%'] }
```

### `axisLabels`

The titles of a plot's axes, in the order of `axis`, in place of the column names: the x and y titles of a scatter plot, a bar chart, a line chart and a heat matrix, each axis's title of parallel coordinates, and a table's column headers. An axis without a title keeps its column's name, and an axis that holds a transform's output, `@transform`, is titled `value`. A run refuses more titles than `axis` has columns, and two titles alike.

```ts
plot: { dataRef: 'parcels', mark: 'bar', axis: ['area', '@transform'], transform: { preset: 'binning-1d' }, axisLabels: ['Area (m²)', 'Parcels'] }
```

### `markColor` and `highlightColor`

| Key | Effect |
|---|---|
| `markColor` | The color of the marks that are neither colored by value nor selected, `#rrggbb`. autk-plot's is `#bfbfbf`. |
| `highlightColor` | The color of the selected marks, and of a table's selected rows, `#rrggbb`. autk-plot's is `#5dade2`. |

autk-plot keeps one mark color and one highlight color for the whole page, which every plot on it reads as it draws and as it shows a selection. So the plots of one spec cannot differ: a run refuses two plots that set different ones, and a plot that sets neither takes the others'. A run sets them for the page, other specs' plots too, and a run whose plots set neither gives back autk-plot's own: each run draws in the colors its spec gives. A run that draws no plot leaves them as they are, and a page whose specs never set them keeps the colors autk-plot has.

```ts
plot: [
  { id: 'heights', dataRef: 'buildings', mark: 'bar', axis: ['id', 'height'], markColor: '#4e79a7', highlightColor: '#e15759' },
  { id: 'areas', dataRef: 'buildings', mark: 'scatter', axis: ['area', 'height'] }, // drawn in the same colors
]
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

An app sets selections with these calls, which take feature ids as the events give them. Each reaches every map that draws the table, or only the map its last argument, `mapId`, names:

| Call | Effect |
|---|---|
| `mapLayers(dataRef, mapId?)` | Every layer that draws the table, each as `{ map, layerId, collection }`: the maps in the spec's order, each map's layers bottom first. `collection` is what the run handed autk-map for the layer: the features of its table that have a geometry, in the table's order, or a raster's one feature. |
| `mapLayer(dataRef, mapId?)` | The last of those: the last map's layer when several maps draw the table. |
| `plotCollection(plotId)` | The collection the run handed the plot (its `id`, else its `dataRef`): the table's rows, in the order it draws them, so the ids of its `plot:selection` events are positions in its features. |
| `highlightOnMap(dataRef, featureIds, mapId?)` | Highlights the features on each of those layers, and selects the same rows in the plots linked to the layers. |
| `clearHighlightOnMap(dataRef, mapId?)` | Clears those highlights, and the linked plots' selections. |
| `setPlotSelection(plotId, featureIds, mapId?)` | Selects the features in the plot (its `id`, else its `dataRef`), and highlights the same rows on the layers it is linked to. |
| `clearHighlightOnPlot(plotId, mapId?)` | Clears the plot's selection, and the highlights on the layers it is linked to. |

`mapId` names one map: a string by its `id`, a number by its index in `map`. The `mapId` of a `map:picking` event names the map it came from, so it can be passed back as it is.

```ts
grammar.highlightOnMap('buildings', [3, 7]);           // every map that draws buildings
grammar.highlightOnMap('buildings', [3, 7], 'after');  // the map whose id is 'after'
grammar.clearHighlightOnMap('buildings', 0);           // the first map
```

### `selection`

A plot's `selection` lists the rows selected as it is drawn, by their feature ids, as `plot:selection` events and `setPlotSelection` give them. The run applies it once the plots and their links exist, as `setPlotSelection` does: the plot draws the rows in its highlight color (a binned plot, the bins that hold them), and the layers it is linked to, by `mapRef` or `links`, highlight the same rows. No `plot:selection` event reports it. A run refuses a feature id that is not a whole number from 0, or one past the plot's last row.

```ts
plot: { id: 'sizes', dataRef: 'parcels', mark: 'scatter', axis: ['area', 'perimeter'], mapRef: 'parcels', selection: [0, 4] }
```

### `pickedComps`

A layer's `pickedComps` lists the features drawn as picked as the map is drawn, in the map's highlight color, as if the user had picked them: their positions among those the layer draws, as `map:picking` events and `highlightOnMap` give them. The run applies it once the plots and their links exist, as `highlightOnMap` does for that one layer: the layer highlights the features, and the plots linked to it select the same rows. No `map:picking` event reports it.

autk-map draws picked features only on the layer of a map that picks, and lets one layer of a map pick: the last that sets `isPick`, unless a link or a plot's `mapRef` makes another layer pick. So a layer with `pickedComps` sets `isPick: true`, and a run refuses `pickedComps` on a layer without it, or on a layer a later layer of its map, a link or a plot's `mapRef` takes picking from. A run also refuses it on a raster layer, on a layer linked to a plot that sets `selection`, and a position that is not a whole number from 0 or is past the last feature the layer draws.

```ts
map: { layerRefs: [{ dataRef: 'parcels', isPick: true, pickedComps: [0, 4] }] }
```

## Page layout

A spec's `layout` says how its maps and plots are arranged on the page. The grammar's run never reads it: the page that hosts the views does, when it makes their canvases and elements, with `arrangeViews(spec)` (see [For hosts](#for-hosts)), so every host arranges a spec's views alike.

| Field | Effect |
|---|---|
| `type` | `vertical`, the default, stacks the views; `horizontal` puts them side by side; `grid` fills `columns` columns, row by row. |
| `columns` | The number of columns of a `grid`, a whole number. Defaults to 2. |
| `gap` | The space between views, in pixels. Defaults to 0. |

Each view has its own pane: the maps first, in the order of `map`, then the plots, in the order of `plot`, as the grammar draws them.

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

`destroy()` releases what the last run made: it stops each map's camera tour, destroys each map (its layers' GPU buffers, its textures, its canvas context, the controls it adds to the page and its event handlers) and clears the grammar's registries, caches and event forwarding. autk-map's maps share one GPU device, which stays for the maps of the next run. `run()` calls it before it starts, so running a new spec on the same instance does not leak the maps of the old one, and its maps and plots draw only its own tables. Call it yourself before the page or the canvases go away. A map whose layers fail to load is destroyed as the run fails, so it leaves nothing on the page.

## JSON Schema

The package ships the grammar's JSON Schema (draft-07) as `@urban-toolkit/autk-grammar/build/autk-grammar-schema.json`, with `$id` `https://autarkjs.org/schema/autk-grammar/v1.json`. Validate a spec with any draft-07 validator:

```ts
import { Ajv } from 'ajv';
import schema from '@urban-toolkit/autk-grammar/build/autk-grammar-schema.json' with { type: 'json' };

const validate = new Ajv({ allowUnionTypes: true }).compile(schema);
if (!validate(spec)) console.error(validate.errors);
```

## Compute helpers

`runCompute(block, layers, run)` runs one `compute` entry against named FeatureCollections with a GPU runner you pass in, for example `params => new AutkComputeEngine().gpgpuPipeline(params)`. It joins a `wgslFunction` written as an array of lines, resolves `fromFeature` uniforms, and drives `iterate: 'all'` (one dispatch per feature, outputs summed) and `iterate: 'batched'` (one dispatch over packed uniform arrays, each polygon a feature of its own when an entry reads the geometry). autk-compute 4 reads each packed array from a read-only storage buffer of its own, so a batched pass packs as many features as its largest array fits in 128 MiB, the storage buffer binding every WebGPU device supports: 4,194,304 with a matrix entry (a bounding box of eight floats per feature), and `maxBatchedFeatures` gives the count for a pass. `resolveComputeParams(block, layers, iterateIndex?)` returns the parameters of a single dispatch without running anything; when an attribute reads the geometry, the table it hands autk-compute holds each MultiLineString as one line of its points, and `runCompute` gives the result each feature's own geometry back.

## For hosts

A host that runs part of a spec itself, a server that loads its tables for example, calls the functions the grammar runs, so it does exactly what `AutkGrammar` does, and a page arranges a spec's views with `arrangeViews`, as every host does:

| Export | Effect |
|---|---|
| `createDataAdapter(targets?, cache?, computeCache?, computeTypes?)` | The data adapter. Its `resolveWorkspaces(db, workspaces)` sets up a spec's `workspaces` before the first source loads, and its `resolveSource(db, source)` loads one `data` entry. Each takes an autk-db database, a new one when `db` is undefined, and returns it. `cache` receives each GeoJSON table and each table a join or an update wrote. `computeCache` and `computeTypes` are the compute adapter's `cache` and `types`: each table a source writes leaves them, so the maps and plots read what a source after compute wrote. |
| `createComputeAdapter(cache?, types?, sources?)` | The compute adapter. Its `resolveCompute(db, pass)` runs one `compute` entry, on the GPU or, for a windows or clusters pass, on the CPU. The results are kept in `cache`, and in autk-db too for a pass with `writeBack`; `types` receives the layer type of each table a pass wrote under its own `outputTableName`. `sources` is the cache `createDataAdapter` fills, from which a pass reads a `fromFeature` table a GeoJSON source loaded in its workspace's CRS. |
| `createComputeSteps()` | A run's workspaces, sources and compute passes, one call at a time, on an autk-db database the host owns: a data adapter and a compute adapter wired to one another as `AutkGrammar` wires its own, and each pass's result as the grammar holds it (see [Compute steps on a host's database](#compute-steps-on-a-hosts-database)). |
| `AutkGrammar`'s options `wrapComputeAdapter` and `wrapDataAdapter` (`AutkGrammarOptions`) | A host's own adapters around the grammar's, which every run of the grammar calls instead: a check around each pass, a kind of source of its own, or a database of its own for the run (see [A host's own adapters around a run's](#a-hosts-own-adapters-around-a-runs)). |
| `AutkGrammar`'s `mapLayers(dataRef, mapId?)` and `plotCollection(plotId)` | What the last run handed each view: each layer's `collection`, the one autk-map was handed for it (the features of its table that have a geometry, or a raster's one), and each plot's collection, its rows (see [Interactions](#interactions)). Each is the collection itself, not a copy, to read and leave as it is; `destroy()` and the next run let them go. |
| `dataPhases(spec)` | The entries of a spec's `data` in the order the grammar runs them: `before`, the sources it runs before the compute passes, and `after`, those it runs after them (see [`after`](#after)). It refuses an `after` other than `'compute'`, and a source after compute that reads a table a pass writes without `writeBack`. A host that loads the data on a server and runs the passes in a browser loads `before` on the server, and runs `after` in the browser once the passes have run, with the compute adapter's caches handed to the data adapter. |
| `enterWorkspace(db, workspace?)` | Makes an entry's workspace (the default one without a name) the one autk-db works in, and switches only when another is current. Every adapter calls it before it reads or writes an entry's tables. |
| `tableKey(workspace, name)` | The key of a table in those caches: its name in the default workspace, `<workspace>/<name>` in another. |
| `applyCamera(map, camera)` | Moves an `AutkMap`'s camera as a map's `camera` says, from the view that fits its layers, and refuses a `pitch` that is not at least 0 and less than 90. The map adapter calls it once the layers are loaded, before the map's first `draw()`. It looks at a `center` that `resolveCameraCenter` put on the map, and refuses any other, so a host's later turns of a map the grammar drew keep its center. |
| `resolveCameraCenter(db, map, center)` | Puts `center`, `[longitude, latitude]` in degrees, in the CRS of the workspace `db` works in, and keeps it with `map` for `applyCamera`. The map adapter calls it once the layers are loaded, with the map's workspace current; a host that builds its own map calls it after `enterWorkspace(db, workspace)`. |
| `playCameraMotion(map, motion)` | Plays a camera tour on an `AutkMap` from the view its camera has now, and returns it as `{ done, stop() }` without waiting for it. A tour played on a map stops the one it was playing, and a drag, a scroll or a key on the map stops it. It refuses a tour as a run does, from the map's own tilt and bank. The map adapter calls it once a map is drawn; a host that frames a map itself and turns it with `applyCamera` calls it after that turn, so the tour starts from the host's view. |
| `arrangeViews(spec)` | Where each view of a spec goes on the page, as its `layout` says: a grid of panes, one per view (see [Arranging the views](#arranging-the-views)). It refuses a `layout` it cannot arrange, with a sentence that names the value. |

`@urban-toolkit/autk-grammar/data` exports `createDataAdapter`, `dataPhases`, `enterWorkspace` and `tableKey` with their types, as an ES module and a CommonJS one. Its code imports `@urban-toolkit/autk-db` alone, never autk-map, autk-plot, autk-compute or autk-core, so it loads where they cannot, such as Node:

```ts
import { createDataAdapter, dataPhases } from '@urban-toolkit/autk-grammar/data';

const adapter = createDataAdapter();
let db: unknown; // the AutkDb the first call creates
if (spec.workspaces) db = await adapter.resolveWorkspaces(db, spec.workspaces);
// The sources after compute run where the passes run, once they have.
for (const source of dataPhases(spec).before) db = await adapter.resolveSource(db, source);
```

The data adapter of either entry notes the coordinate system of each GeoJSON source it puts in its cache, and the two entries keep their notes in one place on the page. So a host may load a spec's tables with the data adapter of `./data` and run its passes with the compute adapter of the main entry, handing it that cache as `sources`: its passes read the sources' features as the grammar's do.

### Compute steps on a host's database

`createComputeSteps()` runs a spec's workspaces, sources and compute passes on an autk-db database the host made and owns, one call at a time, as `AutkGrammar.run` runs them, and draws no map or plot. The steps share their caches as `AutkGrammar`'s adapters do, so a host hands no cache from one adapter to another: a pass reads a `fromFeature` table as a GeoJSON source of the steps gave it, keeps its result in the host's database with `writeBack`, and a source after compute reads it there. A host calls the steps in the order a run takes, and can do work of its own between them, such as a check around each pass:

```ts
import { AutkDb } from '@urban-toolkit/autk-db';
import { createComputeSteps, dataPhases, enterWorkspace } from '@urban-toolkit/autk-grammar';

const db = new AutkDb();
await db.init();
const steps = createComputeSteps();
const { before, after } = dataPhases(spec); // what a run refuses is refused here, before anything runs
if (spec.workspaces) await steps.resolveWorkspaces(db, spec.workspaces);
for (const source of before) await steps.resolveSource(db, source);
for (const pass of spec.compute ?? []) await steps.resolveCompute(db, pass);
for (const source of after) await steps.resolveSource(db, source);

const blocks = steps.computed('fidi_blocks'); // a pass's result: { collection, layerType }
await enterWorkspace(db); // any other table is autk-db's, in the workspace it was made in
const counts = await db.getTable('largest_blocks');
```

| Call | Effect |
|---|---|
| `resolveWorkspaces(db, workspaces)` | Sets up each workspace of a spec's `workspaces`, as a run does before its first source, and leaves the default workspace current. |
| `resolveSource(db, source)` | Loads one `data` entry into `db`, in the entry's workspace: a source before the passes, or one with `after: 'compute'` once they have run. A table it writes leaves `computed`. |
| `resolveCompute(db, pass)` | Runs one `compute` entry on `db`, in the pass's workspace. Its result is kept for `computed` and for later passes, and with `writeBack` in `db` too. |
| `computed(name, workspace?)` | The table as a pass left it, which maps, plots and later passes read before autk-db's table: `collection`, the grammar's own collection rather than a copy, and `layerType`, how a map draws a table a pass wrote under its own `outputTableName`. Undefined when no pass wrote the table, or a source wrote it since: autk-db's table is then the one to read. |

- **Each call takes the host's database and returns it,** and leaves the workspace of the entry it ran current. A call without a database is refused before anything runs.
- **One set of steps runs one spec:** a new run takes `createComputeSteps()` again.
- **The main entry alone exports it,** since a pass runs on autk-compute or autk-core, which `./data` never imports. So a module that runs a spec's passes on its own database takes the main entry only.

### A host's own adapters around a run's

`new AutkGrammar(targets, options)` takes two options. Each is a function from one of the grammar's adapters to the host's own, which every run of the grammar calls instead:

| Option | Effect |
|---|---|
| `wrapComputeAdapter(adapter)` | Returns the compute adapter every pass of every run goes through. A host that checks each pass, in GPU error scopes for example, calls the given adapter's `resolveCompute(context, pass)` inside its check, and returns what that returns. |
| `wrapDataAdapter(adapter)` | Returns the data adapter the `workspaces` and every source of every run go through, those before compute and those after. It keeps `resolveWorkspaces`: `{ ...adapter, resolveSource }` keeps the grammar's. A host that loads a kind of source of its own, such as a raster it holds as bytes, loads it there and hands every other source to the given adapter. |

- **Each function is called once, as the grammar is made,** with the grammar's own adapter, already wired to the grammar's caches, so the maps and plots read what the host's adapters run.
- **Each call of a data adapter takes the run's database,** undefined until the workspaces or the first source make one, and returns the database the run goes on with.
- **A function that returns an adapter without those calls is refused** as the grammar is made. A grammar made without the options runs as before.

A host that keeps the run's database in hand, to read its tables or to end its worker, hands the grammar's data adapter its own database where it is given none:

```ts
import { AutkDb } from '@urban-toolkit/autk-db';
import { AutkGrammar } from '@urban-toolkit/autk-grammar';

const db = new AutkDb();
await db.init();
const grammar = new AutkGrammar({ map: 'map' }, {
  wrapDataAdapter: (adapter) => ({
    resolveWorkspaces: (context, workspaces) => adapter.resolveWorkspaces(context ?? db, workspaces),
    resolveSource: (context, source) => adapter.resolveSource(context ?? db, source),
  }),
  wrapComputeAdapter: (adapter) => ({
    resolveCompute: async (context, pass) => {
      console.time(`pass over ${pass.type ?? 'gpgpu'}`);
      try { return await adapter.resolveCompute(context, pass); }
      finally { console.timeEnd(`pass over ${pass.type ?? 'gpgpu'}`); }
    },
  }),
});
await grammar.run(spec); // db holds the run's tables, and stays in the host's hands whether the run ends or fails
```

### Instead of `AutkGrammar`'s private fields

A host that reached into an `AutkGrammar` for its adapters, its caches, its database or what its views were handed calls these instead, and the grammar's fields stay its own:

| What the host did | Instead |
|---|---|
| Read `dataAdapter` to load a spec's sources on a database of its own | `createComputeSteps()`, then `steps.resolveWorkspaces(db, workspaces)` and `steps.resolveSource(db, source)`. |
| Read `computeAdapter` to run a spec's passes there | `steps.resolveCompute(db, pass)`. The steps have the compute adapter's shape, so a host that checks each pass wraps them. |
| Read `_computeCache` | `steps.computed(name, workspace)?.collection`, and `steps.computed(name, workspace) !== undefined` for whether a pass's result is held. |
| Read `_computeTypes` | `steps.computed(name, workspace)?.layerType`. |
| Replaced `computeAdapter` to wrap the passes of a run | `new AutkGrammar(targets, { wrapComputeAdapter })`. |
| Replaced `dataAdapter` to wrap the sources of a run | `new AutkGrammar(targets, { wrapDataAdapter })`. |
| Read the run's database from `grammarEngine.context` | Its own database, handed to the grammar's data adapter through `wrapDataAdapter`, as above. |
| Read `_exports` for the features a run handed a map | `grammar.mapLayer(dataRef, mapId)?.collection`, what the run handed autk-map for the layer, and `grammar.plotCollection(plotId)` for a plot. |

### Arranging the views

`arrangeViews(spec)` returns:

| Field | Value |
|---|---|
| `type` | `vertical`, `horizontal` or `grid`: the `layout`'s, else `vertical`. |
| `rows` | The rows of panes. |
| `columns` | The columns of panes: 1 for `vertical`, one per view for `horizontal`, and `layout.columns`, else 2, for `grid`. |
| `gap` | The space between neighboring panes, in pixels: `layout.gap`, else 0. |
| `panes` | One pane per view, in the order the grammar draws the views: the maps in the order of `map`, then the plots in the order of `plot`. |

Each pane has:

| Field | Value |
|---|---|
| `kind` | `map` or `plot`, which is also the target list, `map` or `plot`, that names the element the view draws in. |
| `index` | The view's position among the views of its kind: its element is entry `index` of that target list. |
| `id` | The view's `id`, when it has one. |
| `key` | The name the grammar knows the view by: its `id`, else a map's index or a plot's `dataRef`. A map's is the `mapId` of its `map:picking` events, a plot's the `plotId` of its `plot:selection` events. |
| `row` | The pane's row, from 0 at the top. |
| `column` | The pane's column, from 0 at the left. |

A host makes an element for each pane (a canvas for a map, a div for a plot), places it on a grid of `rows` by `columns`, `gap` pixels apart, and names it in the targets. Each map's canvas goes in a positioned pane of its own, since autk-map adds its controls to the canvas's parent:

```ts
import { AutkGrammar, arrangeViews } from '@urban-toolkit/autk-grammar';

const { rows, columns, gap, panes } = arrangeViews(spec);
Object.assign(container.style, {
  display: 'grid', gap: `${gap}px`,
  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
});
const targets: { map: string[]; plot: string[] } = { map: [], plot: [] };
for (const pane of panes) {
  const cell = document.createElement('div');
  Object.assign(cell.style, { position: 'relative', gridRow: `${pane.row + 1}`, gridColumn: `${pane.column + 1}` });
  const element = document.createElement(pane.kind === 'map' ? 'canvas' : 'div');
  element.id = `${pane.kind}-${pane.index}`;
  Object.assign(element.style, { width: '100%', height: '100%' });
  cell.appendChild(element);
  container.appendChild(cell);
  targets[pane.kind][pane.index] = element.id;
}
await new AutkGrammar(targets).run(spec);
```

## License

MIT
