## Contributing

This repo is a viewer app for `@cinevva/usdjs`.

### What to contribute

- minimal repro scenes that demonstrate parsing/composition/viewer issues
- performance fixes (especially load-time and memory/GC pressure)
- viewer correctness fixes (transforms, normals, materials) backed by screenshots or known-good reference output

### Development

```bash
npm i
USDJS_ROOT=/ABS/PATH/TO/cinevva-usdjs npm run dev
```

