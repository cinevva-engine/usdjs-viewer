# Getting Started

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

## Usage Modes

### 1. Drop a File

Drag and drop any `.usd`, `.usda`, `.usdc`, or `.usdz` file onto the viewer.

### 2. Paste USDA

Click the editor button and paste USDA text directly.

### 3. Corpus Browser

Browse curated test files from the USD Working Group, NVIDIA, and FT-Lab samples.

> Requires setting `USDJS_ROOT` environment variable.

## Configuration

### Corpus Support

To browse the test corpus, set `USDJS_ROOT` to your local `@cinevva/usdjs` checkout:

```bash
USDJS_ROOT=/path/to/cinevva-usdjs npm run dev
```

The dev server will serve files from `$USDJS_ROOT/test/corpus/`.

## Building

```bash
# Production build
npm run build

# Preview production build
npm run preview
```

Output goes to `dist/`. The build is a static site that can be deployed anywhere.
