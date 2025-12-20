import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

export function applyUsdTransform2dToTexture(tex: THREE.Texture, transform2d: SdfPrimSpec) {
    // Match the UsdPreviewSurface proposal definition of UsdTransform2d:
    //
    //   result = in * scale * rotate + translation
    //
    // (rotation is counter-clockwise in degrees around the origin).
    //
    // Three's `repeat/rotation/offset` helpers correspond to `rotate(scale(in)) + offset`,
    // which differs from the above when sx != sy depending on convention. To avoid ambiguity,
    // build the UV transform matrix explicitly.
    const readFloat2 = (name: string): [number, number] | null => {
        const dv: any = transform2d.properties?.get(name)?.defaultValue;
        if (!dv || typeof dv !== 'object' || dv.type !== 'tuple') return null;
        const [x, y] = dv.value ?? [];
        if (typeof x !== 'number' || typeof y !== 'number') return null;
        return [x, y];
    };

    const s = readFloat2('inputs:scale') ?? [1, 1];
    const t = readFloat2('inputs:translation') ?? [0, 0];

    const rotDeg = transform2d.properties?.get('inputs:rotation')?.defaultValue;
    const theta = typeof rotDeg === 'number' ? THREE.MathUtils.degToRad(rotDeg) : 0;
    const c = Math.cos(theta);
    const sn = Math.sin(theta);

    const sx = s[0];
    const sy = s[1];
    const tx = t[0];
    const ty = t[1];

    // USD defines UsdTransform2d in row-vector form:
    //
    //   result = in * scale * rotate + translation
    //
    // For row-vectors, a CCW rotation by theta uses:
    //   [  c  s ]
    //   [ -s  c ]
    //
    // Converting to Three's column-vector shader convention yields:
    //   u' = (sx*c) * u + (-sy*s) * v + tx
    //   v' = (sx*s) * u + ( sy*c) * v + ty
    tex.matrixAutoUpdate = false;
    tex.matrix.set(
        sx * c,
        -sy * sn,
        tx,
        sx * sn,
        sy * c,
        ty,
        0,
        0,
        1,
    );
    tex.needsUpdate = true;
}

export function applyWrapMode(tex: THREE.Texture, wrapS?: string, wrapT?: string) {
    const mapWrap = (v?: string) => {
        if (v === 'repeat') return THREE.RepeatWrapping;
        if (v === 'mirror') return THREE.MirroredRepeatWrapping;
        // USD default is "black" (clamp-to-border); Three doesn't support border color,
        // so clamp-to-edge is the closest approximation.
        return THREE.ClampToEdgeWrapping;
    };
    tex.wrapS = mapWrap(wrapS);
    tex.wrapT = mapWrap(wrapT);
}

export function cloneTexturePreserveParams(src: THREE.Texture): THREE.Texture {
    // DataTexture (e.g. EXRLoader) needs a DataTexture clone path.
    if ((src as any).isDataTexture && (src as any).image?.data) {
        const img: any = (src as any).image;
        const data = img.data as ArrayBufferView;
        const w = img.width as number;
        const h = img.height as number;
        const dt = new THREE.DataTexture(data as any, w, h, (src as any).format, (src as any).type);
        const tex = dt as unknown as THREE.Texture;
        tex.colorSpace = src.colorSpace;
        tex.wrapS = src.wrapS;
        tex.wrapT = src.wrapT;
        tex.repeat.copy(src.repeat);
        tex.offset.copy(src.offset);
        tex.rotation = src.rotation;
        tex.center.copy(src.center);
        tex.flipY = src.flipY;
        (tex as any).generateMipmaps = (src as any).generateMipmaps;
        (tex as any).minFilter = (src as any).minFilter;
        (tex as any).magFilter = (src as any).magFilter;
        (tex as any).anisotropy = (src as any).anisotropy;
        (tex as any).premultiplyAlpha = (src as any).premultiplyAlpha;
        (tex as any).unpackAlignment = (src as any).unpackAlignment;
        tex.needsUpdate = true;
        return tex;
    }

    const tex = new THREE.Texture((src as any).image);
    tex.colorSpace = src.colorSpace;
    tex.wrapS = src.wrapS;
    tex.wrapT = src.wrapT;
    tex.repeat.copy(src.repeat);
    tex.offset.copy(src.offset);
    tex.rotation = src.rotation;
    tex.center.copy(src.center);
    tex.flipY = src.flipY;
    tex.needsUpdate = true;
    return tex;
}

export function alphaToGreenAlphaMap(src: THREE.Texture): THREE.Texture | null {
    // Three's alphaMap samples the GREEN channel. If our source texture carries the cutout
    // in its real alpha channel, convert it into green so alphaTest works as expected.
    const img: any = (src as any).image;
    if (!img) return null;

    // If the loader already produced ImageData, we can rewrite quickly.
    const w: number = img.width;
    const h: number = img.height;
    if (!w || !h) return null;

    try {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true } as any) as CanvasRenderingContext2D | null;
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h);
        const d = data.data;
        // Move alpha into green and set alpha to 255 (opaque); shader uses .g for alphaMap anyway.
        let hasNonOpaqueAlpha = false;
        for (let i = 0; i < d.length; i += 4) {
            const a = d[i + 3]!;
            if (a !== 255) hasNonOpaqueAlpha = true;
            d[i + 1] = a;
            d[i + 3] = 255;
        }
        // If there's no meaningful alpha channel, don't convert (keeps RGB-driven masks working).
        if (!hasNonOpaqueAlpha) return null;
        ctx.putImageData(data, 0, 0);
        const out = cloneTexturePreserveParams(src);
        (out as any).image = canvas;
        out.colorSpace = THREE.NoColorSpace;
        out.needsUpdate = true;
        return out;
    } catch {
        return null;
    }
}


