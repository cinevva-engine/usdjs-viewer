import type { SdfPrimSpec } from '@cinevva/usdjs';
import { extractToken } from './materials/valueExtraction';

export function extractJointOrderNames(prim: SdfPrimSpec | null | undefined): string[] | null {
    if (!prim?.properties) return null;
    const v: any = prim.properties.get('skel:jointOrder')?.defaultValue;
    if (!v || typeof v !== 'object' || v.type !== 'array' || !Array.isArray(v.value)) return null;
    const names = v.value
        .map((x: any) => extractToken(x))
        .filter((x: any) => typeof x === 'string') as string[];
    return names.length ? names : null;
}

export function buildJointOrderIndexToBoneIndex(jointNames: string[], jointOrderNames: string[] | null): number[] | null {
    if (!jointOrderNames || jointOrderNames.length === 0) return null;
    const nameToIdx = new Map<string, number>();
    for (let i = 0; i < jointNames.length; i++) nameToIdx.set(jointNames[i]!, i);
    return jointOrderNames.map((n) => nameToIdx.get(n) ?? 0);
}


