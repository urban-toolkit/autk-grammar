# @urban-toolkit/autk-grammar

A declarative grammar for urban visual analytics, running on [Autark](https://autarkjs.org). Describe the data to load, the computations to run, and the maps and plots to draw in one spec, and the grammar wires them together in the browser.

- Documentation: https://autarkjs.org/grammar/
- Examples: https://autarkjs.org/grammar/examples/
- Source: https://github.com/urban-toolkit/autk-grammar

## Installation

```sh
npm install @urban-toolkit/autk-grammar
```

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

## License

MIT
