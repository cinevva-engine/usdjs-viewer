import * as THREE from 'three';

export function guessSolidColorFromAssetPath(assetPath: string): THREE.Color | null {
  const p = (assetPath ?? '').replace(/\\/g, '/').toLowerCase();
  const base = p.split('/').pop() ?? '';
  const stem = base.replace(/\.[^.]+$/, '');
  // These corpora often use "global-colors/<name>.jpg" for flat color swatches.
  const named: Record<string, number> = {
    red: 0xcc2a2a,
    blue: 0x2a61cc,
    green: 0x2ecc71,
    white: 0xffffff,
    black: 0x111111,
    grey: 0x808080,
    gray: 0x808080,
    greylight: 0xc7c7c7,
    graylight: 0xc7c7c7,
    greymedium: 0x7f7f7f,
    graymedium: 0x7f7f7f,
    mediumgrey: 0x7f7f7f,
    mediumgray: 0x7f7f7f,
    lightgrey: 0xc7c7c7,
    lightgray: 0xc7c7c7,
  };
  if (stem in named) return new THREE.Color(named[stem]!);

  // Heuristics for common swatch naming
  if (stem.includes('grey') || stem.includes('gray')) {
    if (stem.includes('light')) return new THREE.Color(0xc7c7c7);
    if (stem.includes('dark')) return new THREE.Color(0x404040);
    if (stem.includes('medium')) return new THREE.Color(0x7f7f7f);
    return new THREE.Color(0x808080);
  }
  if (stem.includes('red')) return new THREE.Color(0xcc2a2a);
  if (stem.includes('blue')) return new THREE.Color(0x2a61cc);
  if (stem.includes('green')) return new THREE.Color(0x2ecc71);

  // For other missing textures (window/frontlight/backlight), keep default behavior.
  return null;
}






