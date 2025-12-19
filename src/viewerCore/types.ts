import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

export type PrimeTreeNode = {
    key: string;
    label: string;
    children?: PrimeTreeNode[];
    data?: {
        path: string;
        typeName?: string;
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

export type AnimatedObject =
    | { kind: 'xform'; obj: THREE.Object3D; prim: SdfPrimSpec; unitScale: number }
    | { kind: 'points'; geoms: THREE.BufferGeometry[]; prim: SdfPrimSpec; unitScale: number };

export type ViewerCore = {
    getDefaultUsda(): string;
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
};


