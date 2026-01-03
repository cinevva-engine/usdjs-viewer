import * as THREE from 'three';
import type { SdfPrimSpec, SdfValue } from '@cinevva/usdjs';
import { getPrimProp, getPrimPropAtTime, propHasAnimation, sdfToNumberTuple } from './usdAnim';
import { extractToken } from './materials/valueExtraction';

/**
 * Parse USD matrix4d[] array into THREE.Matrix4 array.
 * USD matrices are stored as nested tuples in row-major order:
 * matrix4d[] = [( (r0c0, r0c1, r0c2, r0c3), (r1c0, r1c1, r1c2, r1c3), (r2c0, r2c1, r2c2, r2c3), (r3c0, r3c1, r3c2, r3c3) ), ...]
 *
 * USD uses row-vector convention where transforms are applied as v' = v * M.
 * Translation is stored in row 4 (indices 12-15 in flattened row-major).
 * Three.js uses column-vector convention where transforms are applied as v' = M * v.
 * Translation is stored in column 4 (indices 12-14 in column-major storage).
 *
 * To convert, we transpose the USD matrix.
 *
 * References:
 * - Autodesk maya-usd transform stack notes (row/col math recap): `https://github.com/autodesk/maya-usd/blob/dev/doc/UsdTransformsStack.md`
 * - three.js Matrix4 conventions: `https://threejs.org/manual/en/matrix-transformations.html`
 */
export function parseMatrix4dArray(v: SdfValue | undefined): THREE.Matrix4[] | null {
    if (!v || typeof v !== 'object') return null;
    // Fast path: packed typed array (flat row-major 16*N)
    if ((v as any).type === 'typedArray' && ((v as any).elementType === 'matrix4d' || (v as any).elementType === 'matrix4f' || (v as any).elementType === 'matrix4h')) {
        const data: any = (v as any).value;
        if (!(data instanceof Float64Array) && !(data instanceof Float32Array)) return null;
        if (data.length < 16 || data.length % 16 !== 0) return null;
        const matrices: THREE.Matrix4[] = [];
        for (let off = 0; off < data.length; off += 16) {
            // USD is row-major row-vector. Convert to Three.js by transposing.
            const m = new THREE.Matrix4();
            m.set(
                data[off + 0]!, data[off + 4]!, data[off + 8]!, data[off + 12]!,
                data[off + 1]!, data[off + 5]!, data[off + 9]!, data[off + 13]!,
                data[off + 2]!, data[off + 6]!, data[off + 10]!, data[off + 14]!,
                data[off + 3]!, data[off + 7]!, data[off + 11]!, data[off + 15]!,
            );
            matrices.push(m);
        }
        return matrices.length ? matrices : null;
    }
    if (v.type !== 'array') return null;
    const matrices: THREE.Matrix4[] = [];
    for (const mat of v.value) {
        if (!mat || typeof mat !== 'object' || mat.type !== 'tuple' || mat.value.length !== 4) continue;
        // Each mat.value is 4 rows, each row is a tuple of 4 numbers
        const rows: number[][] = [];
        for (const row of mat.value) {
            if (!row || typeof row !== 'object' || row.type !== 'tuple' || row.value.length !== 4) {
                rows.push([0, 0, 0, 0]);
                continue;
            }
            const nums = row.value.map((n: any) => (typeof n === 'number' ? n : 0));
            rows.push(nums);
        }
        // Transpose: USD row becomes Three.js column
        // Matrix4.set takes row-by-row in its arguments, so we pass columns from USD as rows
        const m = new THREE.Matrix4();
        m.set(
            rows[0]![0]!, rows[1]![0]!, rows[2]![0]!, rows[3]![0]!,  // Column 0 of USD -> Row 1 of set()
            rows[0]![1]!, rows[1]![1]!, rows[2]![1]!, rows[3]![1]!,  // Column 1 of USD -> Row 2 of set()
            rows[0]![2]!, rows[1]![2]!, rows[2]![2]!, rows[3]![2]!,  // Column 2 of USD -> Row 3 of set()
            rows[0]![3]!, rows[1]![3]!, rows[2]![3]!, rows[3]![3]!   // Column 3 of USD -> Row 4 of set()
        );
        matrices.push(m);
    }
    return matrices.length ? matrices : null;
}

/**
 * Parse a single USD matrix4d value into THREE.Matrix4.
 * USD matrices are stored as nested tuples in row-major order:
 * matrix4d = ( (r0c0, r0c1, r0c2, r0c3), (r1c0, r1c1, r1c2, r1c3), (r2c0, r2c1, r2c2, r2c3), (r3c0, r3c1, r3c2, r3c3) )
 *
 * USD uses row-vector convention where transforms are applied as v' = v * M.
 * Three.js uses column-vector convention where transforms are applied as v' = M * v.
 * To convert, we transpose the USD matrix.
 *
 * References:
 * - Autodesk maya-usd transform stack notes (row/col math recap): `https://github.com/autodesk/maya-usd/blob/dev/doc/UsdTransformsStack.md`
 * - three.js Matrix4 conventions: `https://threejs.org/manual/en/matrix-transformations.html`
 */
export function parseMatrix4d(v: SdfValue | undefined): THREE.Matrix4 | null {
    if (!v || typeof v !== 'object') return null;
    // Fast path: packed typed array (flat row-major 16)
    if ((v as any).type === 'typedArray' && ((v as any).elementType === 'matrix4d' || (v as any).elementType === 'matrix4f' || (v as any).elementType === 'matrix4h')) {
        const data: any = (v as any).value;
        if (!(data instanceof Float64Array) && !(data instanceof Float32Array)) return null;
        if (data.length !== 16) return null;
        const m = new THREE.Matrix4();
        m.set(
            data[0]!, data[4]!, data[8]!, data[12]!,
            data[1]!, data[5]!, data[9]!, data[13]!,
            data[2]!, data[6]!, data[10]!, data[14]!,
            data[3]!, data[7]!, data[11]!, data[15]!,
        );
        return m;
    }
    if (v.type !== 'tuple' || v.value.length !== 4) return null;

    // Each v.value element is a row (tuple of 4 numbers)
    const rows: number[][] = [];
    for (const row of v.value) {
        if (!row || typeof row !== 'object' || row.type !== 'tuple' || row.value.length !== 4) {
            rows.push([0, 0, 0, 0]);
            continue;
        }
        const nums = row.value.map((n: any) => (typeof n === 'number' ? n : 0));
        rows.push(nums);
    }

    // Transpose: USD row becomes Three.js column
    // Matrix4.set takes row-by-row in its arguments, so we pass columns from USD as rows
    const m = new THREE.Matrix4();
    m.set(
        rows[0]![0]!, rows[1]![0]!, rows[2]![0]!, rows[3]![0]!,  // Column 0 of USD -> Row 1 of set()
        rows[0]![1]!, rows[1]![1]!, rows[2]![1]!, rows[3]![1]!,  // Column 1 of USD -> Row 2 of set()
        rows[0]![2]!, rows[1]![2]!, rows[2]![2]!, rows[3]![2]!,  // Column 2 of USD -> Row 3 of set()
        rows[0]![3]!, rows[1]![3]!, rows[2]![3]!, rows[3]![3]!   // Column 3 of USD -> Row 4 of set()
    );
    return m;
}

export function applyXformOps(obj: THREE.Object3D, prim: SdfPrimSpec, time?: number, unitScale = 1.0) {
    // OpenUSD note: metersPerUnit is a stage metric and should not be baked into xform evaluation.
    // XformOps compose purely from authored values. Keep `unitScale` for legacy call sites but
    // do not apply it to xformOp matrices.
    void unitScale;
    // Helper to get property value, optionally at a specific time
    const getVal = time !== undefined
        ? (name: string) => getPrimPropAtTime(prim, name, time)
        : (name: string) => getPrimProp(prim, name);

    const readXformOpOrder = (): string[] => {
        const dv: any = getVal('xformOpOrder');
        if (!dv || typeof dv !== 'object' || dv.type !== 'array' || !Array.isArray(dv.value)) return [];
        const out: string[] = [];
        for (const el of dv.value) {
            const token = extractToken(el);
            if (token) out.push(token);
        }
        return out;
    };

    const order = readXformOpOrder();

    const vec3For = (opName: string): [number, number, number] | null => {
        const t = sdfToNumberTuple(getVal(opName), 3);
        if (!t) return null;
        return [t[0]!, t[1]!, t[2]!];
    };

    const scalarFor = (opName: string): number | null => {
        const v = getVal(opName);
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };

    const isTranslateLike = (opName: string): boolean => {
        // Most translations are authored as `xformOp:translate:*`.
        return (
            opName.startsWith('xformOp:translate')
        );
    };

    const matrixForOp = (opName: string): THREE.Matrix4 | null => {
        // Matrix op
        if (opName.startsWith('xformOp:transform')) {
            const m = parseMatrix4d(getVal(opName));
            if (!m) return null;
            return m;
        }

        // Translate-like ops (translate/pivots/offsets)
        if (isTranslateLike(opName)) {
            const v = vec3For(opName);
            if (!v) return null;
            return new THREE.Matrix4().makeTranslation(v[0], v[1], v[2]);
        }

        // Scale
        if (opName.startsWith('xformOp:scale')) {
            const v = vec3For(opName);
            if (!v) return null;
            return new THREE.Matrix4().makeScale(v[0], v[1], v[2]);
        }

        // Rotations
        if (opName.startsWith('xformOp:rotateXYZ')) {
            const v = vec3For(opName);
            if (!v) return null;
            const e = new THREE.Euler(
                THREE.MathUtils.degToRad(v[0]),
                THREE.MathUtils.degToRad(v[1]),
                THREE.MathUtils.degToRad(v[2]),
                'XYZ'
            );
            return new THREE.Matrix4().makeRotationFromEuler(e);
        }
        if (opName.startsWith('xformOp:rotateX')) {
            const d = scalarFor(opName);
            if (d === null) return null;
            return new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(d));
        }
        if (opName.startsWith('xformOp:rotateY')) {
            const d = scalarFor(opName);
            if (d === null) return null;
            return new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(d));
        }
        if (opName.startsWith('xformOp:rotateZ')) {
            const d = scalarFor(opName);
            if (d === null) return null;
            return new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(d));
        }

        return null;
    };

    // Compose xformOpOrder in USD's native convention (row-vectors, row-major).
    // Then convert once to Three.js (column-vectors) by transposing.
    //
    // This avoids subtle left/right multiplication and Euler-order mistakes, and is required
    // for complex stacks with pivots + !invert! + matrix ops (e.g. complex_transform.usda).
    type UsdRows4 = [number[], number[], number[], number[]]; // each row length 4

    const usdIdentityRows = (): UsdRows4 => ([
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
    ]);

    const usdRowsToThreeMatrix = (rows: UsdRows4): THREE.Matrix4 => {
        // USD rows are row-major for row-vector convention.
        // Convert to Three column-vector matrix by transposing.
        const m = new THREE.Matrix4();
        m.set(
            rows[0][0], rows[1][0], rows[2][0], rows[3][0],
            rows[0][1], rows[1][1], rows[2][1], rows[3][1],
            rows[0][2], rows[1][2], rows[2][2], rows[3][2],
            rows[0][3], rows[1][3], rows[2][3], rows[3][3],
        );
        return m;
    };

    const threeMatrixToUsdRows = (mCol: THREE.Matrix4): UsdRows4 => {
        // Three's `elements` is column-major: e[col*4 + row]
        // USD uses row-vector convention, so its matrix is the TRANSPOSE of the Three/column-vector matrix.
        // If mCol is:
        //   [ m11 m12 m13 m14
        //     m21 m22 m23 m24
        //     m31 m32 m33 m34
        //     m41 m42 m43 m44 ]
        // then USD rows should be:
        //   [ m11 m21 m31 m41
        //     m12 m22 m32 m42
        //     m13 m23 m33 m43
        //     m14 m24 m34 m44 ]
        const e = mCol.elements;
        return [
            [e[0], e[1], e[2], e[3]],
            [e[4], e[5], e[6], e[7]],
            [e[8], e[9], e[10], e[11]],
            [e[12], e[13], e[14], e[15]],
        ];
    };

    const usdMulRows = (a: UsdRows4, b: UsdRows4): UsdRows4 => {
        // Standard matrix multiply for row-major storage: out = a * b
        const out: UsdRows4 = usdIdentityRows();
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
                out[r][c] =
                    a[r][0]! * b[0][c]! +
                    a[r][1]! * b[1][c]! +
                    a[r][2]! * b[2][c]! +
                    a[r][3]! * b[3][c]!;
            }
        }
        return out;
    };

    const usdInvertRows = (rows: UsdRows4): UsdRows4 | null => {
        // Convert to Three, invert there, then transpose back to USD rows.
        const mCol = usdRowsToThreeMatrix(rows);
        const det = mCol.determinant();
        if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
        const invCol = mCol.clone().invert();
        return threeMatrixToUsdRows(invCol);
    };

    const readUsdMatrixRows = (v: SdfValue | undefined): UsdRows4 | null => {
        if (!v || typeof v !== 'object' || v.type !== 'tuple' || v.value.length !== 4) return null;
        const rows: number[][] = [];
        for (const row of v.value) {
            if (!row || typeof row !== 'object' || row.type !== 'tuple' || row.value.length !== 4) return null;
            const nums = row.value.map((n: any) => (typeof n === 'number' ? n : 0));
            rows.push(nums);
        }
        return [rows[0]!, rows[1]!, rows[2]!, rows[3]!];
    };

    const usdTranslateRows = (tx: number, ty: number, tz: number): UsdRows4 => {
        const m = usdIdentityRows();
        // Row-vector translation: translation lives in last row (row 4).
        m[3][0] = tx;
        m[3][1] = ty;
        m[3][2] = tz;
        return m;
    };

    const usdScaleRows = (sx: number, sy: number, sz: number): UsdRows4 => ([
        [sx, 0, 0, 0],
        [0, sy, 0, 0],
        [0, 0, sz, 0],
        [0, 0, 0, 1],
    ]);

    // Row-vector rotation matrices (right-handed).
    // These are constructed directly (instead of deriving from Three.js) to match OpenUSD behavior.
    const usdRotateXRows = (deg: number): UsdRows4 => {
        const t = THREE.MathUtils.degToRad(deg);
        const c = Math.cos(t);
        const s = Math.sin(t);
        return [
            [1, 0, 0, 0],
            [0, c, s, 0],
            [0, -s, c, 0],
            [0, 0, 0, 1],
        ];
    };

    const usdRotateYRows = (deg: number): UsdRows4 => {
        const t = THREE.MathUtils.degToRad(deg);
        const c = Math.cos(t);
        const s = Math.sin(t);
        return [
            [c, 0, -s, 0],
            [0, 1, 0, 0],
            [s, 0, c, 0],
            [0, 0, 0, 1],
        ];
    };

    const usdRotateZRows = (deg: number): UsdRows4 => {
        const t = THREE.MathUtils.degToRad(deg);
        const c = Math.cos(t);
        const s = Math.sin(t);
        return [
            [c, s, 0, 0],
            [-s, c, 0, 0],
            [0, 0, 1, 0],
            [0, 0, 0, 1],
        ];
    };

    const usdRotateXYZRows = (degX: number, degY: number, degZ: number): UsdRows4 => {
        // Match OpenUSD: rotateXYZ composes as X then Y then Z for row-vectors: M = Rx * Ry * Rz
        const rx = usdRotateXRows(degX);
        const ry = usdRotateYRows(degY);
        const rz = usdRotateZRows(degZ);
        return usdMulRows(usdMulRows(rx, ry), rz);
    };

    const usdRowsForOp = (opName: string): UsdRows4 | null => {
        // Matrix op: already in USD row-major.
        if (opName.startsWith('xformOp:transform')) {
            const rows = readUsdMatrixRows(getVal(opName));
            if (!rows) return null;
            return rows;
        }

        // Translate-like ops (translate/pivots/offsets)
        if (isTranslateLike(opName)) {
            const v = vec3For(opName);
            if (!v) return null;
            return usdTranslateRows(v[0], v[1], v[2]);
        }

        if (opName.startsWith('xformOp:scale')) {
            const v = vec3For(opName);
            if (!v) return null;
            return usdScaleRows(v[0], v[1], v[2]);
        }

        if (opName.startsWith('xformOp:rotateXYZ')) {
            const v = vec3For(opName);
            if (!v) return null;
            return usdRotateXYZRows(v[0], v[1], v[2]);
        }
        if (opName.startsWith('xformOp:rotateX')) {
            const d = scalarFor(opName);
            if (d === null) return null;
            return usdRotateXRows(d);
        }
        if (opName.startsWith('xformOp:rotateY')) {
            const d = scalarFor(opName);
            if (d === null) return null;
            return usdRotateYRows(d);
        }
        if (opName.startsWith('xformOp:rotateZ')) {
            const d = scalarFor(opName);
            if (d === null) return null;
            return usdRotateZRows(d);
        }
        return null;
    };

    // NOTE: do not use a TRS fast-path: even "simple" stacks must match OpenUSD's row-vector
    // composition rules exactly, and going through a single matrix path avoids subtle Euler
    // order/sign differences across conventions.

    // If xformOpOrder is present, honor it by composing a full matrix stack.
    // Compose in USD convention (row-vectors) and transpose once into Three.
    if (order.length) {
        let composedRows: UsdRows4 = usdIdentityRows();
        let any = false;
        const invertPrefix = '!invert!';
        const resetToken = '!resetXformStack!';
        const areInverseTokens = (a: string, b: string): boolean =>
            (invertPrefix + a) === b || (invertPrefix + b) === a;

        for (let i = 0; i < order.length; i++) {
            const token = order[i]!;
            // OpenUSD: "!resetXformStack!" clears the currently accreted ops.
            // (It is meaningful even if it doesn't appear first; the last occurrence wins.)
            if (token === resetToken) {
                composedRows = usdIdentityRows();
                any = true;
                continue;
            }

            // OpenUSD: if two adjacent tokens are inverses of each other, skip BOTH.
            // Pixar detects this while iterating in reverse (most-local -> least-local).
            // Since we iterate forward, we must look ahead so we don't apply the first op and
            // then only skip the second.
            const nextToken = i + 1 < order.length ? order[i + 1]! : null;
            if (nextToken && areInverseTokens(token, nextToken)) {
                i++; // skip the paired inverse token too
                continue;
            }

            let invert = false;
            let opName = token;
            if (opName.startsWith('!invert!')) {
                invert = true;
                opName = opName.slice('!invert!'.length);
            }
            const rows = usdRowsForOp(opName);
            if (!rows) continue;
            const rowsToApply = invert ? usdInvertRows(rows) : rows;
            if (!rowsToApply) continue;
            // For the usd-wg-assets `complex_transform.usda` stack, treating `xformOpOrder` as
            // an outer-to-inner stack matches the reference renders: compose by pre-multiplying.
            // (This is also consistent with how the simple stack `["translate","rotate","scale"]`
            // is commonly interpreted as T * R * S.)
            composedRows = usdMulRows(rowsToApply, composedRows);
            any = true;
        }

        if (any) {
            const composed = usdRowsToThreeMatrix(composedRows);
            obj.matrixAutoUpdate = false;
            obj.matrix.copy(composed);
            // Keep position/quaternion/scale roughly in-sync for tooling/inspection.
            // NOTE: This decomposition cannot represent shear, but the authoritative transform
            // remains in `obj.matrix` since `matrixAutoUpdate=false`.
            composed.decompose(obj.position, obj.quaternion, obj.scale);
            obj.matrixWorldNeedsUpdate = true;
            return;
        }
    }

    // No xformOpOrder (or nothing resolved from it).
    // Fallback 1: apply any authored matrix transform op as a full transform.
    const tryApplyAnyMatrixTransform = (): boolean => {
        const candidates: string[] = [];
        if (prim.properties) {
            for (const k of prim.properties.keys()) if (k.startsWith('xformOp:transform')) candidates.push(k);
        }
        // Prefer the canonical name if present.
        candidates.sort((a, b) => (a === 'xformOp:transform' ? -1 : b === 'xformOp:transform' ? 1 : a.localeCompare(b)));
        for (const k of candidates) {
            const m = matrixForOp(k);
            if (!m) continue;
            obj.matrixAutoUpdate = false;
            obj.matrix.copy(m);
            m.decompose(obj.position, obj.quaternion, obj.scale);
            obj.matrixWorldNeedsUpdate = true;
            return true;
        }
        return false;
    };
    if (tryApplyAnyMatrixTransform()) return;

    // Fallback 2: approximate with Three.js TRS (T * R * S) using common op names (including suffixed ops if present).
    obj.matrixAutoUpdate = true;

    const findOpName = (prefix: string, fallback: string): string => {
        for (const opName of order) if (opName.startsWith(prefix)) return opName;
        return fallback;
    };

    const tName = findOpName('xformOp:translate', 'xformOp:translate');
    const rName = findOpName('xformOp:rotateXYZ', 'xformOp:rotateXYZ');
    const sName = findOpName('xformOp:scale', 'xformOp:scale');

    const t = vec3For(tName);
    const s = vec3For(sName);

    obj.position.set(0, 0, 0);
    obj.rotation.set(0, 0, 0);
    obj.quaternion.identity();
    obj.scale.set(1, 1, 1);

    if (t) obj.position.set(t[0], t[1], t[2]);
    if (s) obj.scale.set(s[0], s[1], s[2]);

    const rXYZ = vec3For(rName);
    if (rXYZ) {
        obj.rotation.set(
            THREE.MathUtils.degToRad(rXYZ[0]),
            THREE.MathUtils.degToRad(rXYZ[1]),
            THREE.MathUtils.degToRad(rXYZ[2]),
            'XYZ'
        );
        obj.updateMatrix();
        return;
    }

    // Support ordered axis rotations (rotateX/Y/Z), including suffixed ones listed in xformOpOrder.
    const axisX = new THREE.Vector3(1, 0, 0);
    const axisY = new THREE.Vector3(0, 1, 0);
    const axisZ = new THREE.Vector3(0, 0, 1);
    const q = new THREE.Quaternion();
    let anyRot = false;
    const applyAxis = (axis: THREE.Vector3, degrees: number) => {
        const qq = new THREE.Quaternion();
        qq.setFromAxisAngle(axis, THREE.MathUtils.degToRad(degrees));
        q.multiply(qq);
        anyRot = true;
    };

    for (const opToken of order) {
        const opName = opToken.startsWith('!invert!') ? opToken.slice('!invert!'.length) : opToken;
        if (!opName.startsWith('xformOp:rotate')) continue;
        if (opName.startsWith('xformOp:rotateX')) {
            const d = scalarFor(opName);
            if (d !== null) applyAxis(axisX, d);
        } else if (opName.startsWith('xformOp:rotateY')) {
            const d = scalarFor(opName);
            if (d !== null) applyAxis(axisY, d);
        } else if (opName.startsWith('xformOp:rotateZ')) {
            const d = scalarFor(opName);
            if (d !== null) applyAxis(axisZ, d);
        } else if (opName.startsWith('xformOp:rotateXYZ')) {
            const vv = vec3For(opName);
            if (vv) {
                const e = new THREE.Euler(
                    THREE.MathUtils.degToRad(vv[0]),
                    THREE.MathUtils.degToRad(vv[1]),
                    THREE.MathUtils.degToRad(vv[2]),
                    'XYZ'
                );
                const qq = new THREE.Quaternion().setFromEuler(e);
                q.multiply(qq);
                anyRot = true;
            }
        }
    }

    if (anyRot) obj.quaternion.copy(q);
    obj.updateMatrix();
}

/**
 * Check if a prim has any animated xform properties
 */
export function primHasAnimatedXform(prim: SdfPrimSpec): boolean {
    if (
        propHasAnimation(prim, 'xformOp:translate') ||
        propHasAnimation(prim, 'xformOp:rotateXYZ') ||
        propHasAnimation(prim, 'xformOp:scale') ||
        propHasAnimation(prim, 'xformOp:transform')
    ) return true;

    // Catch any animated xformOp, including suffixed ops like:
    // - `xformOp:translate:foo.timeSamples`
    // - `xformOp:rotateX:zoomedIn.timeSamples` (usd-wg-assets teapot camera)
    // - `xformOp:transform:edit7.timeSamples`
    if (prim.properties) {
        for (const [k, spec] of prim.properties.entries()) {
            if (!k.startsWith('xformOp:')) continue;
            if (k === 'xformOpOrder') continue;
            if (spec.timeSamples && spec.timeSamples.size > 0) return true;
        }
    }
    return false;
}


