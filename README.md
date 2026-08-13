# Is it built?

## Run

```bash
bun run scan       # refresh site/state.json and regenerate site/index.html
bun run dev        # serve site/ locally (no data refresh)
```

or through the flake:

```bash
nix run . -- --config config.json --data site/state.json
```

The scanner uses only Bun's built-in APIs (fetch, Bun.file) and the standard
library; there are no npm dependencies. Tests run with `bun test tests/`.
