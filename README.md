# @cinevva/usdjs-viewer

A browser-based USD scene viewer built on **Three.js** and **@cinevva/usdjs**.

---

## What It Does

- **Visual validation**: See if your USD files actually load and render correctly
- **Hierarchy inspection**: Browse the prim tree, transforms, and materials
- **Reference implementation**: See how to integrate `@cinevva/usdjs` with Three.js

---

## Status (Honest Assessment)

This viewer is **practical**, not "complete USD rendering":

| What Works | What Doesn't |
|------------|--------------|
| ✅ Basic geometry (meshes, transforms) | ❌ Not a Hydra implementation |
| ✅ UsdPreviewSurface materials | ❌ Complex material networks |
| ✅ Common texture setups | ❌ Procedural textures |
| ✅ Simple skeletal animation | ❌ Full UsdSkel parity |
| ✅ Variants and references | ❌ Every composition edge case |

If you need production-grade USD rendering, use Pixar's tools or a WASM-based viewer.

---

## Quick Start

```bash
# Clone and install
git clone https://github.com/cinevva-engine/usdjs-viewer
cd usdjs-viewer
npm install

# Development server
npm run dev
```

Open `http://localhost:5173` in your browser.

---

## Usage Modes

### 1. Drop a File

Drag and drop any `.usd`, `.usda`, `.usdc`, or `.usdz` file onto the viewer.

### 2. Paste USDA

Click the editor button and paste USDA text directly.

### 3. Corpus Browser

Browse curated test files from the USD Working Group, NVIDIA, and FT-Lab samples.

> Requires setting `USDJS_ROOT` (see below).

---

## Configuration

### Corpus Support

To browse the test corpus, set `USDJS_ROOT` to your local `@cinevva/usdjs` checkout:

```bash
USDJS_ROOT=/path/to/cinevva-usdjs npm run dev
```

The dev server will serve files from `$USDJS_ROOT/test/corpus/`.

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `USDJS_ROOT` | Path to core repo for corpus serving |

---

## Integration Guide

### Using as a Component

The viewer's core logic can be extracted for custom integrations:

```typescript
import { createViewerCore } from '@cinevva/usdjs-viewer/viewerCore';

// Initialize with a canvas
const core = createViewerCore(canvas, {
    width: 800,
    height: 600,
});

// Load a USD file
const buffer = await fetch('/model.usdz').then(r => r.arrayBuffer());
await core.loadUsdz(buffer, 'model.usdz');

// Start render loop
function animate() {
    requestAnimationFrame(animate);
    core.render();
}
animate();
```

### Programmatic API

The viewer exposes automation APIs on `window` for testing:

```javascript
// Load a file
await window.__usdjsViewerCore.loadUrl('/path/to/file.usda');

// Get render stats
const stats = window.__usdjsRender.getStats();

// Screenshot (for headless testing)
const dataUrl = window.__usdjsRender.screenshot();
```

---

## Architecture

```
src/
├── viewerCore/
│   ├── createViewerCore.ts   # Main viewer logic
│   ├── usdParse.ts           # USD → Three.js conversion
│   ├── usdTree.ts            # Scene graph building
│   ├── usdSkeleton.ts        # Skeletal animation
│   ├── usdAnim.ts            # Animation handling
│   ├── resolver.ts           # Asset resolution
│   └── types.ts              # Type definitions
├── components/               # Vue UI components
├── App.vue                   # Main application
└── main.ts                   # Entry point
```

### Key Design Decisions

1. **Three.js, not Hydra**: We use Three.js because it's browser-native and widely understood
2. **Practical schema support**: We implement what real files need, not the full spec
3. **Viewer automation**: APIs exposed for headless testing via `@cinevva/usdjs-renderer`

---

## Building

```bash
# Production build
npm run build

# Preview production build
npm run preview
```

Output goes to `dist/`. The build is a static site that can be deployed anywhere.

---

## Development

### Tech Stack

- **Vue 3** + Composition API
- **Vite** for bundling
- **Three.js** for 3D rendering
- **PrimeVue** for UI components
- **Monaco Editor** for USDA editing

### Dev Commands

```bash
npm run dev      # Start dev server
npm run build    # Production build
npm run preview  # Preview production build
```

---

## Troubleshooting

### "Module not found: @cinevva/usdjs"

The viewer expects `@cinevva/usdjs` to be installed. If you're developing locally:

```bash
npm install ../cinevva-usdjs  # or wherever your core repo is
```

### Corpus browser shows errors

Make sure `USDJS_ROOT` points to the core repo and the corpus has been fetched:

```bash
cd /path/to/cinevva-usdjs
npm run corpus:fetch
```

### Textures not loading

Check the browser console for CORS errors. The dev server proxies `/__usdjs_corpus` but external URLs may need proper CORS headers.

---

## Related Packages

| Package | Purpose |
|---------|---------|
| **@cinevva/usdjs** | Core parsing and composition |
| **@cinevva/usdjs-renderer** | Headless PNG rendering |

---

## License

MIT. See [LICENSE](./LICENSE).
