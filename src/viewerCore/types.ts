import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

export type PrimeTreeNode = {
    key: string;
    label: string;
    children?: PrimeTreeNode[];
    styleClass?: string;
    data?: {
        // USD Outliner nodes use `path`/`typeName`.
        // Three.js Scene Tree nodes use custom flags (isTexture/isMaterial/...) and keys.
        path?: string;
        typeName?: string;
        [key: string]: any;
    };
};

export type SceneNode = {
    path: string;
    typeName?: string;
    prim: SdfPrimSpec;
    children: SceneNode[];
};

export type AnimationState = {
    playing: boolean;
    currentTime: number;
    startTime: number;
    endTime: number;
    framesPerSecond: number;
};

export type ThreeDebugInfo = {
    content: {
        objectCount: number;
        meshCount: number;
        skinnedMeshCount: number;
        pointsCount: number;
        lineCount: number;
        meshes: Array<{
            name: string;
            visible: boolean;
            frustumCulled: boolean;
            materialType: string;
            geometry: {
                positionCount: number;
                indexCount: number;
                drawRange: { start: number; count: number };
                groups: number;
                boundingSphereRadius: number | null;
            };
        }>;
    };
    render: {
        calls: number;
        triangles: number;
        points: number;
        lines: number;
    };
    camera: {
        position: [number, number, number];
        target: [number, number, number];
        near: number;
        far: number;
        fov: number;
    };
    scene: {
        backgroundType: string;
        hasEnvironment: boolean;
        environmentIntensity: number | null;
    };
};

export type TextureCacheEntryInfo = {
    cacheKey: string;
    url: string;
    baseRequests: number;
    cloneRequests: number;
    progressiveStage: 'init' | 'preview' | 'full' | 'failed' | null;
    progressiveClonesLive: number | null;
    resolved: boolean;
    baseId: number | null;
    width: number | null;
    height: number | null;
    estimatedBytes: number | null;
};

export type GpuResourcesInfo = {
    renderer: {
        memory: {
            textures: number;
            geometries: number;
        };
        render: {
            calls: number;
            triangles: number;
            points: number;
            lines: number;
        };
        programs: number | null;
    };
    textures: {
        totalUnique: number;
        totalEstimatedBytes: number;
        list: Array<{
            uuid: string;
            name: string;
            width: number | null;
            height: number | null;
            estimatedBytes: number | null;
            sourceUrl: string | null;
        }>;
    };
    geometries: {
        totalUnique: number;
        totalBytes: number;
        list: Array<{
            uuid: string;
            name: string;
            attributesBytes: number;
            indexBytes: number;
            totalBytes: number;
        }>;
    };
    textureCache: {
        entries: TextureCacheEntryInfo[];
    };
};

export type AnimatedObject =
    | { kind: 'xform'; obj: THREE.Object3D; prim: SdfPrimSpec; unitScale: number }
    | { kind: 'points'; geoms: THREE.BufferGeometry[]; prim: SdfPrimSpec; unitScale: number };

export type ViewerCore = {
    getDefaultUsda(): string;
    getEmptyUsda(): string;
    getEntryKey(): string;
    getCompose(): boolean;
    getEntryOptions(): Array<{ label: string; value: string }>;
    getEntryText(entryKey: string): string | null;
    getReferenceImageUrl(): string | null;

    setTextarea(text: string): void;
    setEntryKey(key: string): void;
    setCompose(v: boolean): void;
    setSelectedPath(path: string | null): Promise<void>;

    loadLocalFiles(files: FileList): Promise<void>;
    /**
     * Programmatic alternative to `loadLocalFiles` intended for automation / headless rendering.
     * Paths should be the same strings you expect USD composition to resolve to (via `resolveAssetPath`).
     */
    loadTextFiles(files: Array<{ path: string; text: string }>): void;
    loadCorpusEntry(rel: string): Promise<void>;
    restoreLastOpened(): Promise<boolean>;

    run(): Promise<void>;
    dispose(): void;

    // Animation controls
    getAnimationState(): AnimationState;
    setAnimationTime(time: number): void;
    setAnimationPlaying(playing: boolean): void;
    hasAnimation(): boolean;

    // Debugging / introspection (for diagnosing "empty scene" vs "rendered but invisible")
    getThreeDebugInfo(): ThreeDebugInfo;
    // GPU resources inspector (textures, geometries, renderer memory stats, texture cache stats)
    getGpuResourcesInfo(): GpuResourcesInfo;

    // Three.js scene tree (UI exploration / debugging)
    getThreeSceneTree(): PrimeTreeNode[];
    findThreeObjectByUuid(uuid: string): THREE.Object3D | null;
    getThreeObjectProperties(uuid: string): Record<string, any> | null;
    setThreeObjectProperty(uuid: string, path: string, value: any): boolean;
    isPropertyEditable(path: string): boolean;

    // Material support
    isMaterialKey(key: string): boolean;
    getMaterialProperties(key: string): Record<string, any> | null;
    setMaterialProperty(key: string, path: string, value: any): boolean;

    // Texture support
    isTextureKey(key: string): boolean;
    getTextureProperties(key: string): Record<string, any> | null;
    setTextureProperty(key: string, path: string, value: any): boolean;
    findTextureByUuid(uuid: string): THREE.Texture | null;

    // Raycasting for picking objects in the scene
    /**
     * Perform raycasting at the given normalized device coordinates (-1 to 1).
     * Returns the UUID of the first hit object, or null if nothing was hit.
     */
    raycastAtNDC(ndcX: number, ndcY: number): string | null;

    /**
     * Get the ancestor UUIDs of an object (from root to parent, excluding the object itself).
     * Useful for expanding tree nodes to reveal a selected object.
     */
    getAncestorUuids(uuid: string): string[];

    // USD prim properties
    getPrimProperties(path: string): Record<string, any> | null;
    /**
     * Set a USD prim property and update the Three.js scene incrementally.
     * Supported properties: xformOp:translate, xformOp:rotateXYZ, xformOp:scale
     */
    setPrimProperty(path: string, propName: string, value: any): boolean;
};


