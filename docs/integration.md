# Integration Guide

## Using as a Component

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

## Programmatic API

The viewer exposes automation APIs on `window` for testing:

```javascript
// Load a file
await window.__usdjsViewerCore.loadUrl('/path/to/file.usda');

// Get render stats
const stats = window.__usdjsRender.getStats();

// Screenshot (for headless testing)
const dataUrl = window.__usdjsRender.screenshot();
```

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

## Tech Stack

- **Vue 3** + Composition API
- **Vite** for bundling
- **Three.js** for 3D rendering
- **PrimeVue** for UI components
- **Monaco Editor** for USDA editing
