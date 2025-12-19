import * as THREE from 'three';

export type PointInstancerInstance = { pos: THREE.Vector3; rot: THREE.Quaternion; scale: THREE.Vector3 };

export function buildInstancesByProto(opts: {
  positions: Float32Array;
  protoIndices: number[];
  orientations: THREE.Quaternion[] | null;
  scales: Float32Array | null;
  unitScale: number;
  prototypeCount: number;
}): Map<number, Array<PointInstancerInstance>> {
  const { positions, protoIndices, orientations, scales, unitScale, prototypeCount } = opts;

  const numInstances = positions.length / 3;

  // Group instances by prototype index to use InstancedMesh when possible.
  const instancesByProto: Map<number, Array<PointInstancerInstance>> = new Map();
  for (let i = 0; i < numInstances; i++) {
    const protoIdx = protoIndices[i] ?? 0;
    if (protoIdx < 0 || protoIdx >= prototypeCount) {
      console.warn(`PointInstancer protoIndices[${i}] = ${protoIdx} out of range [0, ${prototypeCount})`);
      continue;
    }

    const pos = new THREE.Vector3(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
    if (unitScale !== 1.0) pos.multiplyScalar(unitScale);

    const rot = orientations && orientations[i] ? orientations[i]!.clone() : new THREE.Quaternion();
    const scale = scales && scales.length >= (i + 1) * 3
      ? new THREE.Vector3(scales[i * 3]!, scales[i * 3 + 1]!, scales[i * 3 + 2]!)
      : new THREE.Vector3(1, 1, 1);

    if (!instancesByProto.has(protoIdx)) instancesByProto.set(protoIdx, []);
    instancesByProto.get(protoIdx)!.push({ pos, rot, scale });
  }

  return instancesByProto;
}


