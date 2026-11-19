# Browser tests

These tests run gallery example specs through the grammar in Chrome with WebGPU, and check the results: loaded tables, spatial joins, GPU compute values, linked plots, and that each map canvas was actually drawn. They run the adapter and grammar **source** against whichever Autark packages are installed.

A map draws on demand, and Chrome can read an idle WebGPU canvas back as transparent, so a test reads a map canvas in the animation frame that draws the map: `window.readMap` asks the map for one frame (`requestRender()`) and reads the canvas in an animation frame callback registered after the map's own. `requestRender()` does nothing for a map whose `draw()` never ran, so such a map reads back blank.

CI (`.github/workflows/e2e.yml`) runs them on every pull request and every push to `main`, twice:

- **locked**: the Autark versions in `package-lock.json`.
- **latest**: the newest `@urban-toolkit/autk-*` releases on npm. A failure here while `locked` passes means a new Autark release broke the grammar.

## Running locally

```sh
npm install
npm run test:e2e
```

The tests need a Chrome with WebGPU. They use the system Chrome when it is installed; otherwise point `CHROME_PATH` at a Chrome binary.

## Adding a test

`tests/app/main.ts` exposes `window.runExample(name)`, which runs `gallery/src/examples/<name>.ts` and returns the tables it produced, `window.runSpec(spec)`, which does the same for a spec the test builds and destroys the previous run's grammar first, `window.runAgain(spec)`, which runs a spec on the last run's grammar, as a host that keeps one does, `window.runInPanes(spec, width, height)`, which runs a spec in the panes the gallery hub builds for a spec with a layout (`gallery/src/views.ts`) and returns each pane's box, `window.exampleSpec(name)`, which returns an example's spec so a test can run it changed (the test process cannot import an example that names a grammar enum, since it never builds the grammar), `window.valueAt(table, index, path)` to read a feature property, `window.featureExtents(table)` for each feature's extent in workspace coordinates (World Mercator meters), and `window.readMap(canvasId)`, which returns a map canvas as a PNG data URL. `window.mapLayers(canvasId)` returns what autk-map holds for each layer of a map (id, colors, outline, line width, point size, color map, highlighted ids), `window.drawnRows(canvasId, layerId)` the properties of the feature a vector layer draws at each of its positions, read from the collection autk-map was handed, `window.rasterCells(canvasId, layerId)` a raster layer's cell values and colors, and `window.legend()` the legend's title and labels; `window.schemeColor(value, interpolator, domain)` and `window.domainLabels(domain)` give autk-core's color and labels to compare them with. For plots, `window.plotMarks(target)` returns the marks the plots in an element draw, each with the row autk-plot binds to it and its computed fill and stroke, `window.plotTicks(target, selector)` the tick labels of the axes a selector finds there (`#axisX`, `#axisY`, or parallel coordinates' `.autkBrush`), each as the tick's value and its text, `window.plotAxisTitles(target)` the axis titles, and `window.plotStyle()` the mark and highlight colors autk-plot holds for the page; `window.runBeside(spec)` runs a spec on a second grammar of the page, `window.besideGrammar`, whose plots draw in `#beside`, as a page that shows two specs does. Add a case to `tests/grammar.spec.ts` that runs an example and checks what it should produce; `expectDrawn(page, canvasId)` checks that a map drew.
