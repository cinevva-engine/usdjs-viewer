<template>
  <div v-if="headless" class="headless-root">
    <div ref="viewportEl" class="viewport viewport-headless"></div>
  </div>

  <Splitter v-else class="viewer-root" layout="horizontal" stateKey="usdjs-viewer:splitter:v1" stateStorage="local">
    <SplitterPanel class="sidebar" :size="28" :minSize="20">
      <div class="sidebar-inner">
        <div class="sidebar-header">
          <div class="title-row">
            <div class="title">usdjs viewer</div>
            <Button label="Render" icon="pi pi-play" size="small" @click="run" />
          </div>

          <div class="controls">
            <div class="control-row">
              <label class="label">Files</label>
              <input class="native-file" type="file" accept=".usda,.usd,.txt" multiple @change="onFilesSelected" />
            </div>

            <div class="control-row">
              <label class="label">Entry</label>
              <Select
                class="grow"
                v-model="entryKey"
                :options="entryOptions"
                optionLabel="label"
                optionValue="value"
                placeholder="Select entry"
                @change="onEntryChanged"
              />
              <Button label="Reset" severity="secondary" size="small" @click="resetToDefault" />
            </div>

            <div class="control-row">
              <label class="label">Corpus</label>
              <Select
                class="grow"
                v-model="corpusGroupId"
                :options="corpusGroups"
                optionLabel="label"
                optionValue="id"
                placeholder="Group"
                @change="onCorpusGroupChanged"
              />
            </div>

            <div class="control-row">
              <label class="label">Sample</label>
              <div class="sample-controls">
                <Select
                  class="grow"
                  v-model="corpusRel"
                  :options="corpusFiles"
                  optionLabel="label"
                  optionValue="value"
                  placeholder="Select sample"
                />
                <Button
                  icon="pi pi-chevron-left"
                  severity="secondary"
                  size="small"
                  aria-label="Previous sample"
                  title="Previous sample"
                  :disabled="!hasPrevSample"
                  @click="prevSample"
                />
                <Button
                  icon="pi pi-chevron-right"
                  severity="secondary"
                  size="small"
                  aria-label="Next sample"
                  title="Next sample"
                  :disabled="!hasNextSample"
                  @click="nextSample"
                />
              </div>
            </div>

            <div class="control-row">
              <label class="label">Compose</label>
              <Checkbox v-model="compose" binary />
              <span class="hint">subLayers / references / payload / variants</span>
            </div>
          </div>
        </div>

        <Tabs class="sidebar-tabs" value="source">
          <TabList>
            <Tab value="source">Source</Tab>
            <Tab value="outliner">Outliner</Tab>
            <Tab value="status">Status</Tab>
          </TabList>
          <TabPanels>
          <TabPanel value="source">
            <div class="source fill">
              <MonacoEditor v-model="sourceText" language="usda" />
            </div>
          </TabPanel>
          <TabPanel value="outliner">
            <Tree
              class="outliner"
              :value="treeNodes"
              selectionMode="single"
              v-model:selectionKeys="selectionKeys"
              @node-select="onNodeSelect"
            />
          </TabPanel>
          <TabPanel value="status">
            <div class="status">{{ status }}</div>
          </TabPanel>
          </TabPanels>
        </Tabs>
      </div>
    </SplitterPanel>

    <SplitterPanel class="viewport-panel" :size="72" :minSize="40">
      <div ref="viewportEl" class="viewport"></div>
      <div v-if="referenceImageUrl" class="reference-image-overlay" title="Reference image">
        <img :src="referenceImageUrl" alt="Reference" @error="onReferenceImageError" />
      </div>
      <!-- Animation Timeline -->
      <div v-if="hasAnimation" class="timeline-overlay">
        <div class="timeline-controls">
          <Button
            :icon="animationPlaying ? 'pi pi-pause' : 'pi pi-play'"
            severity="secondary"
            size="small"
            rounded
            :aria-label="animationPlaying ? 'Pause' : 'Play'"
            @click="togglePlayback"
          />
          <div class="timeline-slider-container">
            <input
              type="range"
              class="timeline-slider"
              :min="animationStartTime"
              :max="animationEndTime"
              :step="0.1"
              :value="animationCurrentTime"
              @input="onTimelineChange"
            />
          </div>
          <span class="timeline-time">{{ formatTime(animationCurrentTime) }} / {{ formatTime(animationEndTime) }}</span>
        </div>
      </div>
    </SplitterPanel>
  </Splitter>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue';

import Splitter from 'primevue/splitter';
import SplitterPanel from 'primevue/splitterpanel';
import Button from 'primevue/button';
import Select from 'primevue/select';
import Checkbox from 'primevue/checkbox';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import Tree from 'primevue/tree';

import { CORPUS_GROUPS } from './corpusRegistry';
import type { PrimeTreeNode, ViewerCore } from './viewerCore';
import { createViewerCore } from './viewerCore';
import MonacoEditor from './components/MonacoEditor.vue';

const viewportEl = ref<HTMLElement | null>(null);
const core = ref<ViewerCore | null>(null);

const headless = new URLSearchParams(window.location.search ?? '').get('headless') === '1';

const status = ref('Ready');
const sourceText = ref('');
const compose = ref(true);
const entryKey = ref('<textarea>');
const entryOptions = ref<Array<{ label: string; value: string }>>([{ label: '<textarea>', value: '<textarea>' }]);

const corpusGroups = computed(() => CORPUS_GROUPS.map((g) => ({ id: g.id, label: `${g.label} (${g.files.length})`, files: g.files })));
const corpusGroupId = ref(CORPUS_GROUPS[0]?.id ?? '');
const corpusRel = ref<string>('');
const corpusFiles = computed(() => {
  const g = CORPUS_GROUPS.find((x) => x.id === corpusGroupId.value) ?? CORPUS_GROUPS[0];
  return (g?.files ?? []).map((rel) => ({ label: rel.split('/').slice(-3).join('/'), value: rel }));
});

const corpusRelIndex = computed(() => {
  const list = corpusFiles.value;
  if (!list.length) return -1;
  if (!corpusRel.value) return -1;
  return list.findIndex((x) => x.value === corpusRel.value);
});

const hasPrevSample = computed(() => corpusFiles.value.length > 0 && (corpusRelIndex.value > 0 || corpusRel.value === ''));
const hasNextSample = computed(() => {
  const list = corpusFiles.value;
  if (!list.length) return false;
  if (!corpusRel.value) return true;
  return corpusRelIndex.value >= 0 && corpusRelIndex.value < list.length - 1;
});

function prevSample() {
  const list = corpusFiles.value;
  if (!list.length) return;
  if (!corpusRel.value) {
    corpusRel.value = list[list.length - 1]!.value;
    return;
  }
  const i = corpusRelIndex.value;
  if (i <= 0) return;
  corpusRel.value = list[i - 1]!.value;
}

function nextSample() {
  const list = corpusFiles.value;
  if (!list.length) return;
  if (!corpusRel.value) {
    corpusRel.value = list[0]!.value;
    return;
  }
  const i = corpusRelIndex.value;
  if (i < 0 || i >= list.length - 1) return;
  corpusRel.value = list[i + 1]!.value;
}

const treeNodes = ref<PrimeTreeNode[]>([]);
const selectionKeys = ref<Record<string, boolean>>({});
// Guard against PrimeVue Tree emitting node-select events when we programmatically
// update selectionKeys in onTree(). Without this, some large stages can trigger
// an accidental run() -> onTree() -> node-select -> run() loop.
const lastSelectedPath = ref<string | null>(null);
const referenceImageUrl = ref<string | null>(null);

const HASH_PREFIX_CORPUS = '#corpus=';
function readCorpusHash(): string | null {
  const h = window.location.hash ?? '';
  if (!h.startsWith(HASH_PREFIX_CORPUS)) return null;
  const raw = h.slice(HASH_PREFIX_CORPUS.length);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function normalizeCorpusPathForUi(path: string): string {
  // Our hash may contain `packages/usdjs/...` (preferred). The corpus dropdown values are relative to `packages/usdjs/`.
  return path.startsWith('packages/usdjs/') ? path.slice('packages/usdjs/'.length) : path;
}

async function loadFromHash() {
  const hashPath = readCorpusHash();
  if (!hashPath) return false;
  const rel = normalizeCorpusPathForUi(hashPath);
  if (!rel) return false;
  if (corpusRel.value === rel) return true;
  corpusRel.value = rel;
  const group = CORPUS_GROUPS.find((g) => g.files.includes(rel));
  if (group) corpusGroupId.value = group.id;
  await loadCorpus();
  return true;
}

// Animation state
const hasAnimation = ref(false);
const animationPlaying = ref(false);
const animationCurrentTime = ref(0);
const animationStartTime = ref(0);
const animationEndTime = ref(0);
let animationUpdateInterval: number | null = null;

function syncEntryOptions() {
  const c = core.value;
  if (!c) return;
  entryOptions.value = c.getEntryOptions();
}

function syncAnimationState() {
  const c = core.value;
  if (!c) return;
  hasAnimation.value = c.hasAnimation();
  const state = c.getAnimationState();
  animationPlaying.value = state.playing;
  animationCurrentTime.value = state.currentTime;
  animationStartTime.value = state.startTime;
  animationEndTime.value = state.endTime;
}

function togglePlayback() {
  const c = core.value;
  if (!c) return;
  const newPlaying = !animationPlaying.value;
  c.setAnimationPlaying(newPlaying);
  animationPlaying.value = newPlaying;
  
  // Start/stop animation state polling
  if (newPlaying) {
    startAnimationPolling();
  } else {
    stopAnimationPolling();
  }
}

function onTimelineChange(e: Event) {
  const c = core.value;
  if (!c) return;
  const input = e.target as HTMLInputElement;
  const time = parseFloat(input.value);
  c.setAnimationTime(time);
  animationCurrentTime.value = time;
}

function formatTime(time: number): string {
  return time.toFixed(1);
}

function startAnimationPolling() {
  if (animationUpdateInterval !== null) return;
  animationUpdateInterval = window.setInterval(() => {
    const c = core.value;
    if (!c) return;
    const state = c.getAnimationState();
    animationCurrentTime.value = state.currentTime;
    if (!state.playing) {
      stopAnimationPolling();
      animationPlaying.value = false;
    }
  }, 50); // Update UI at ~20fps
}

function stopAnimationPolling() {
  if (animationUpdateInterval !== null) {
    clearInterval(animationUpdateInterval);
    animationUpdateInterval = null;
  }
}

async function run() {
  const c = core.value;
  if (!c) return;
  // Stop any existing animation playback
  stopAnimationPolling();
  c.setAnimationPlaying(false);
  
  c.setCompose(compose.value);
  c.setEntryKey(entryKey.value);
  c.setTextarea(sourceText.value);
  await c.run();
  // Update reference image URL after running
  referenceImageUrl.value = c.getReferenceImageUrl();
  // Sync animation state
  syncAnimationState();
}

function onReferenceImageError() {
  // Hide reference image if it fails to load
  referenceImageUrl.value = null;
}

function resetToDefault() {
  sourceText.value = cDefaultUsda();
  entryKey.value = '<textarea>';
  selectionKeys.value = {};
  void run();
}

function onFilesSelected(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = input.files;
  if (!files || files.length === 0) return;
  void core.value?.loadLocalFiles(files).then(() => {
    syncEntryOptions();
  });
}

function onEntryChanged() {
  // If entry points to an external file, sync the textarea for quick edits (same behavior as before).
  const c = core.value;
  if (!c) return;
  const maybeText = c.getEntryText(entryKey.value);
  if (maybeText != null) sourceText.value = maybeText;
  void run().then(() => {
    // Update reference image URL after running
    referenceImageUrl.value = c.getReferenceImageUrl() ?? null;
  });
}

function onCorpusGroupChanged() {
  corpusRel.value = '';
}

async function loadCorpus() {
  if (!corpusRel.value) return;
  status.value = `Loading corpus… ${corpusRel.value}`;
  await core.value?.loadCorpusEntry(corpusRel.value);
  syncEntryOptions();
  // loadCorpusEntry already sets the entryKey with the full path, so get it from core
  entryKey.value = core.value?.getEntryKey() ?? `[corpus]${corpusRel.value}`;
  const maybeText = core.value?.getEntryText(entryKey.value);
  if (maybeText != null) sourceText.value = maybeText;
  await run();
  // Update reference image URL
  referenceImageUrl.value = core.value?.getReferenceImageUrl() ?? null;
}

function onNodeSelect(e: any) {
  const node: PrimeTreeNode | undefined = e?.node;
  if (!node) return;
  const nextPath: string | null = node.data?.path ?? null;
  // If the selection didn't actually change, don't re-run (prevents feedback loops).
  if (nextPath === lastSelectedPath.value) return;
  lastSelectedPath.value = nextPath;
  void core.value?.setSelectedPath(nextPath).then(() => run());
}

function cDefaultUsda() {
  return core.value?.getDefaultUsda() ?? '';
}

watch(compose, () => void run());

const isInit = ref(true);
watch(
  corpusRel,
  (rel) => {
    if (isInit.value) return;
    if (!rel) return;
    void loadCorpus();
  },
  { flush: 'post' }
);

let unlistenHash: (() => void) | null = null;
onMounted(async () => {
  if (!viewportEl.value) return;
  const c = createViewerCore({
    viewportEl: viewportEl.value,
    onStatus: (s) => (status.value = s),
    onTree: (nodes, selectedPath) => {
      treeNodes.value = nodes;
      // Keep selection in sync
      selectionKeys.value = selectedPath ? { [selectedPath]: true } : {};
      lastSelectedPath.value = selectedPath ?? null;
    },
  });
  core.value = c;
  sourceText.value = c.getDefaultUsda();

  if (!headless) {
    // Hash is the single source of truth for corpus loading.
    // If no hash is present, we just render the default textarea scene.
    await loadFromHash();

    const onHashChange = () => {
      if (isInit.value) return;
      void loadFromHash();
    };
    window.addEventListener('hashchange', onHashChange);
    unlistenHash = () => window.removeEventListener('hashchange', onHashChange);
  }

  isInit.value = false;
  if (!core.value?.getEntryKey()?.startsWith?.('[corpus]')) {
    await run();
  }
  // Update reference image URL after initial run
  referenceImageUrl.value = c.getReferenceImageUrl() ?? null;

  // Automation / headless rendering hook (Playwright).
  (window as any).__usdjsViewerCore = c;
  (window as any).__usdjsRender = async (args: {
    entryPath: string;
    textFiles?: Array<{ path: string; text: string }>;
    compose?: boolean;
  }) => {
    const cc = core.value;
    if (!cc) throw new Error('usdjs viewer core not initialized');
    if (args.textFiles?.length) cc.loadTextFiles(args.textFiles);
    cc.setCompose(args.compose ?? true);
    cc.setEntryKey(args.entryPath);
    // keep textarea in sync for debugging (not strictly required)
    const maybeText = cc.getEntryText(args.entryPath);
    if (maybeText != null) cc.setTextarea(maybeText);
    await cc.run();
    return true;
  };
});

onBeforeUnmount(() => {
  stopAnimationPolling();
  unlistenHash?.();
  unlistenHash = null;
  core.value?.dispose();
  core.value = null;
});
</script>

<style scoped>
.headless-root {
  height: 100%;
  width: 100%;
}

.viewport-headless {
  height: 100%;
  width: 100%;
}

.viewer-root {
  height: 100%;
}

.sidebar {
  overflow: hidden;
}

.sidebar-inner {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-width: 260px;
  /* Allow inner flex children to shrink without overflowing horizontally */
  overflow: hidden;
}

.sidebar-header {
  padding: 12px;
  border-bottom: 1px solid var(--p-surface-200);
}

.title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.title {
  font-weight: 700;
  letter-spacing: 0.3px;
}

.controls {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.control-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0; /* Allow flex children to shrink below content size */
}

.label {
  width: 64px;
  font-size: 12px;
  opacity: 0.85;
}

.hint {
  font-size: 12px;
  opacity: 0.75;
}

.native-file {
  flex: 1;
  font-size: 12px;
}

.grow {
  flex: 1;
  min-width: 0; /* Allow flex item to shrink below content size */
}

.sample-controls {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Ensure PrimeVue Select components can shrink */
:deep(.grow .p-select) {
  min-width: 0;
}

:deep(.grow .p-select .p-select-label) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* PrimeVue Tabs content wrapper */
:deep(.p-tabpanels) {
  padding: 0;
  flex: 1;
  min-height: 0;
  display: flex;
  min-width: 0;
  overflow: hidden;
}

:deep(.p-tabpanel) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.source {
  width: 100%;
  flex: 1;
  min-height: 0;
  max-width: 100%;
  overflow: hidden;
}

.outliner {
  flex: 1;
  min-height: 0;
}

.status {
  padding: 12px;
  white-space: pre-wrap;
  font-size: 12px;
}

.viewport-panel {
  background: #0b0b0b;
  position: relative;
}

.viewport {
  height: 100%;
  width: 100%;
  position: relative;
}

.reference-image-overlay {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 100;
  background: rgba(0, 0, 0, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  padding: 8px;
  max-width: 300px;
  max-height: 300px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.reference-image-overlay img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  border-radius: 4px;
}

.fill {
  height: 100%;
  width: 100%;
}

/* Animation Timeline */
.timeline-overlay {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  background: rgba(15, 15, 26, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  padding: 10px 16px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(8px);
}

.timeline-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.timeline-slider-container {
  width: 200px;
}

.timeline-slider {
  width: 100%;
  height: 6px;
  -webkit-appearance: none;
  appearance: none;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  cursor: pointer;
}

.timeline-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #6366f1;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(99, 102, 241, 0.4);
  transition: transform 0.15s ease;
}

.timeline-slider::-webkit-slider-thumb:hover {
  transform: scale(1.2);
}

.timeline-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border: none;
  border-radius: 50%;
  background: #6366f1;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(99, 102, 241, 0.4);
}

.timeline-time {
  font-size: 12px;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: rgba(255, 255, 255, 0.75);
  min-width: 80px;
  text-align: right;
}
</style>


