---
layout: home

hero:
  name: "@cinevva/usdjs-viewer"
  text: Browser USD Viewer
  tagline: Three.js-based viewer for visual validation and debugging of USD scenes.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/cinevva-engine/usdjs-viewer

features:
  - icon: 🎨
    title: Three.js Rendering
    details: Renders USD scenes using Three.js with practical schema support for meshes, materials, and transforms.
  - icon: 🔍
    title: Scene Inspection
    details: Browse the prim hierarchy, inspect properties, and debug composition results.
  - icon: 📝
    title: USDA Editor
    details: Edit USDA text directly with Monaco editor and see changes in real-time.
  - icon: 🧪
    title: Corpus Browser
    details: Browse curated test files from USD-WG, NVIDIA, and community assets.
---

## What It Does

- **Visual validation**: See if your USD files actually load and render correctly
- **Hierarchy inspection**: Browse the prim tree, transforms, and materials
- **Reference implementation**: See how to integrate `@cinevva/usdjs` with Three.js

## Honest Assessment

This viewer is **practical**, not "complete USD rendering":

| What Works | What Doesn't |
|------------|--------------|
| ✅ Basic geometry (meshes, transforms) | ❌ Not a Hydra implementation |
| ✅ UsdPreviewSurface materials | ❌ Complex material networks |
| ✅ Common texture setups | ❌ Procedural textures |
| ✅ Simple skeletal animation | ❌ Full UsdSkel parity |

## Related

- **[@cinevva/usdjs](https://cinevva-engine.github.io/usdjs/)** — Core parsing and composition
- **[@cinevva/usdjs-renderer](https://cinevva-engine.github.io/usdjs-renderer/)** — Headless PNG rendering
