import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

export function getAxisRotation(getPrimProp: (prim: SdfPrimSpec, name: string) => any, prim: SdfPrimSpec): THREE.Euler {
  const axisVal = getPrimProp(prim, 'axis');
  const axis = typeof axisVal === 'string' ? axisVal : 'Y';
  // Three.js primitives are oriented along Y by default
  if (axis === 'X') return new THREE.Euler(0, 0, -Math.PI / 2);
  if (axis === 'Z') return new THREE.Euler(Math.PI / 2, 0, 0);
  return new THREE.Euler(0, 0, 0); // Y axis (default)
}

export function renderBasicUsdPrimitive(opts: {
  typeName: string;
  prim: SdfPrimSpec;
  container: THREE.Object3D;
  unitScale: number;
  getPrimProp: (prim: SdfPrimSpec, name: string) => any;
  resolveMaterial: (prim: SdfPrimSpec) => THREE.Material;
  applyPrimitiveDefaults: (mat: THREE.Material, prim: SdfPrimSpec) => void;
}): boolean {
  const { typeName, prim, container, unitScale, getPrimProp, resolveMaterial, applyPrimitiveDefaults } = opts;

  if (typeName === 'Sphere') {
    const radiusVal = getPrimProp(prim, 'radius');
    const radius = (typeof radiusVal === 'number' ? radiusVal : 1) * unitScale;
    const geo = new THREE.SphereGeometry(radius, 24, 16);
    const mat = resolveMaterial(prim);
    applyPrimitiveDefaults(mat, prim);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    container.add(mesh);
    return true;
  }
  if (typeName === 'Cube') {
    const sizeVal = getPrimProp(prim, 'size');
    const size = (typeof sizeVal === 'number' ? sizeVal : 1) * unitScale;
    const geo = new THREE.BoxGeometry(size, size, size);
    const mat = resolveMaterial(prim);
    applyPrimitiveDefaults(mat, prim);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    container.add(mesh);
    return true;
  }
  if (typeName === 'Cylinder') {
    const radiusVal = getPrimProp(prim, 'radius');
    const heightVal = getPrimProp(prim, 'height');
    const radius = (typeof radiusVal === 'number' ? radiusVal : 1) * unitScale;
    const height = (typeof heightVal === 'number' ? heightVal : 2) * unitScale;
    const geo = new THREE.CylinderGeometry(radius, radius, height, 24, 1);
    const mat = resolveMaterial(prim);
    applyPrimitiveDefaults(mat, prim);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Apply axis rotation
    const axisRotation = getAxisRotation(getPrimProp, prim);
    mesh.rotation.copy(axisRotation);
    container.add(mesh);
    return true;
  }
  if (typeName === 'Cone') {
    const radiusVal = getPrimProp(prim, 'radius');
    const heightVal = getPrimProp(prim, 'height');
    const radius = (typeof radiusVal === 'number' ? radiusVal : 1) * unitScale;
    const height = (typeof heightVal === 'number' ? heightVal : 2) * unitScale;
    const geo = new THREE.ConeGeometry(radius, height, 24, 1);
    const mat = resolveMaterial(prim);
    applyPrimitiveDefaults(mat, prim);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Apply axis rotation
    const axisRotation = getAxisRotation(getPrimProp, prim);
    mesh.rotation.copy(axisRotation);
    container.add(mesh);
    return true;
  }
  if (typeName === 'Capsule') {
    const radiusVal = getPrimProp(prim, 'radius');
    const heightVal = getPrimProp(prim, 'height');
    const radius = (typeof radiusVal === 'number' ? radiusVal : 0.5) * unitScale;
    const height = (typeof heightVal === 'number' ? heightVal : 1) * unitScale;
    // Three.js CapsuleGeometry: (radius, length, capSegments, radialSegments)
    // Note: Three.js 'length' is the cylinder portion, USD 'height' is also cylinder portion
    const geo = new THREE.CapsuleGeometry(radius, height, 8, 16);
    const mat = resolveMaterial(prim);
    applyPrimitiveDefaults(mat, prim);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Apply axis rotation
    const axisRotation = getAxisRotation(getPrimProp, prim);
    mesh.rotation.copy(axisRotation);
    container.add(mesh);
    return true;
  }

  return false;
}


