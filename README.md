## `@cinevva/usdjs-viewer`

`@cinevva/usdjs-viewer` is a browser USD scene viewer built on **Three.js** and **`@cinevva/usdjs`**.

### What it’s for

- Visual validation of parsing/composition behavior (“does this file actually load?”)
- Inspecting stage hierarchy, transforms, and common material setups
- Acting as a reference implementation for downstream integrations

### Status (brutally honest)

This viewer is **practical**, not “complete USD rendering”:

- It is **not Hydra**
- It supports a **subset** of schema interpretation/material models needed for real assets
- It depends on `@cinevva/usdjs` composition capabilities (which are intentionally incomplete)

### Quick start

```bash
npm i
npm run dev
```

### Build

```bash
npm run build
npm run preview
```

### Corpus support (optional)

The built-in sample browser expects a local checkout of the core repo’s corpus so the dev server can serve files via `/__usdjs_corpus`.

Set `USDJS_ROOT` to a local checkout of the core repo (the directory that contains `test/corpus/`):

```bash
USDJS_ROOT=/ABS/PATH/TO/cinevva-usdjs npm run dev
```

If you don’t set `USDJS_ROOT`, the viewer still works (textarea / headless entry), but corpus browsing will fail with an explicit error.

### License

MIT (see `LICENSE`).

