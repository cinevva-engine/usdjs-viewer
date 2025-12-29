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

        <Tabs class="sidebar-tabs" v-model:value="activeTab">
          <TabList>
            <Tab value="source">Source</Tab>
            <Tab value="outliner">Outliner</Tab>
            <Tab value="status">Status</Tab>
            <Tab value="scene">Scene</Tab>
          </TabList>
          <TabPanels>
          <TabPanel value="source">
            <div class="source fill">
              <MonacoEditor v-model="sourceText" language="usda" />
            </div>
          </TabPanel>
          <TabPanel value="outliner">
            <div class="outliner-panel">
            <Tree
              class="outliner"
              :value="treeNodes"
              selectionMode="single"
              v-model:selectionKeys="selectionKeys"
              @node-select="onNodeSelect"
                @nodeSelect="onNodeSelect"
              />
              <div v-if="selectedPrimProps" class="prim-properties">
                <div class="properties-header">Prim Properties</div>
                <div class="properties-scroll">
                  <div class="properties-content">
                    <!-- Editable Transform Properties -->
                    <div v-if="selectedPrimProps._translate" class="property-row">
                      <div class="property-key">translate:</div>
                      <div class="property-value vector3-value">
                        <InputNumber
                          class="vector3-input"
                          :modelValue="selectedPrimProps._translate.x"
                          :minFractionDigits="1"
                          :maxFractionDigits="3"
                          :step="0.1"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimPropertyEdit('xformOp:translate', 'x', v)"
                        />
                        <InputNumber
                          class="vector3-input"
                          :modelValue="selectedPrimProps._translate.y"
                          :minFractionDigits="1"
                          :maxFractionDigits="3"
                          :step="0.1"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimPropertyEdit('xformOp:translate', 'y', v)"
                        />
                        <InputNumber
                          class="vector3-input"
                          :modelValue="selectedPrimProps._translate.z"
                          :minFractionDigits="1"
                          :maxFractionDigits="3"
                          :step="0.1"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimPropertyEdit('xformOp:translate', 'z', v)"
                        />
                      </div>
                    </div>
                    <div v-if="selectedPrimProps._rotate" class="property-row">
                      <div class="property-key">rotate:</div>
                      <div class="property-value vector3-value">
                        <InputNumber
                          class="vector3-input"
                          :modelValue="selectedPrimProps._rotate.x"
                          :minFractionDigits="1"
                          :maxFractionDigits="1"
                          :step="1"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimPropertyEdit('xformOp:rotateXYZ', 'x', v)"
                        />
                        <InputNumber
                          class="vector3-input"
                          :modelValue="selectedPrimProps._rotate.y"
                          :minFractionDigits="1"
                          :maxFractionDigits="1"
                          :step="1"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimPropertyEdit('xformOp:rotateXYZ', 'y', v)"
                        />
                        <InputNumber
                          class="vector3-input"
                          :modelValue="selectedPrimProps._rotate.z"
                          :minFractionDigits="1"
                          :maxFractionDigits="1"
                          :step="1"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimPropertyEdit('xformOp:rotateXYZ', 'z', v)"
                        />
                      </div>
                    </div>
                    <div v-if="selectedPrimProps._scale" class="property-row">
                      <div class="property-key">scale:</div>
                      <div class="property-value vector3-value">
                        <InputNumber
                          class="vector3-input"
                          :modelValue="selectedPrimProps._scale.x"
                          :minFractionDigits="1"
                          :maxFractionDigits="3"
                          :step="0.1"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimPropertyEdit('xformOp:scale', 'x', v)"
                        />
                        <InputNumber
                          class="vector3-input"
                          :modelValue="selectedPrimProps._scale.y"
                          :minFractionDigits="1"
                          :maxFractionDigits="3"
                          :step="0.1"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimPropertyEdit('xformOp:scale', 'y', v)"
                        />
                        <InputNumber
                          class="vector3-input"
                          :modelValue="selectedPrimProps._scale.z"
                          :minFractionDigits="1"
                          :maxFractionDigits="3"
                          :step="0.1"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimPropertyEdit('xformOp:scale', 'z', v)"
                        />
                      </div>
                    </div>
                    <!-- Visibility -->
                    <div v-if="selectedPrimProps._visibility !== undefined" class="property-row">
                      <div class="property-key">visibility:</div>
                      <div class="property-value">
                        <Select
                          :modelValue="selectedPrimProps._visibility"
                          :options="['inherited', 'invisible']"
                          @update:modelValue="(v) => onPrimScalarEdit('visibility', v)"
                        />
                      </div>
                    </div>
                    <!-- Light Intensity -->
                    <div v-if="selectedPrimProps._intensity !== undefined" class="property-row">
                      <div class="property-key">intensity:</div>
                      <div class="property-value">
                        <InputNumber
                          :modelValue="selectedPrimProps._intensity"
                          :minFractionDigits="0"
                          :maxFractionDigits="1"
                          :step="100"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimScalarEdit('intensity', v)"
                        />
                      </div>
                    </div>
                    <!-- Light Color -->
                    <div v-if="selectedPrimProps._color" class="property-row">
                      <div class="property-key">color:</div>
                      <div class="property-value vector3-value">
                        <InputNumber
                          class="vector3-input"
                          :modelValue="selectedPrimProps._color.r"
                          :minFractionDigits="2"
                          :maxFractionDigits="3"
                          :min="0"
                          :max="1"
                          :step="0.1"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimColorEdit('color', 'r', v)"
                        />
                        <InputNumber
                          class="vector3-input"
                          :modelValue="selectedPrimProps._color.g"
                          :minFractionDigits="2"
                          :maxFractionDigits="3"
                          :min="0"
                          :max="1"
                          :step="0.1"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimColorEdit('color', 'g', v)"
                        />
                        <InputNumber
                          class="vector3-input"
                          :modelValue="selectedPrimProps._color.b"
                          :minFractionDigits="2"
                          :maxFractionDigits="3"
                          :min="0"
                          :max="1"
                          :step="0.1"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimColorEdit('color', 'b', v)"
                        />
                      </div>
                    </div>
                    <!-- Light Angle (DistantLight) -->
                    <div v-if="selectedPrimProps._angle !== undefined" class="property-row">
                      <div class="property-key">angle:</div>
                      <div class="property-value">
                        <InputNumber
                          :modelValue="selectedPrimProps._angle"
                          :minFractionDigits="1"
                          :maxFractionDigits="2"
                          :step="0.1"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimScalarEdit('angle', v)"
                        />
                      </div>
                    </div>
                    <!-- Light Radius (SphereLight) -->
                    <div v-if="selectedPrimProps._radius !== undefined" class="property-row">
                      <div class="property-key">radius:</div>
                      <div class="property-value">
                        <InputNumber
                          :modelValue="selectedPrimProps._radius"
                          :minFractionDigits="1"
                          :maxFractionDigits="2"
                          :min="0"
                          :step="0.1"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimScalarEdit('radius', v)"
                        />
                      </div>
                    </div>
                    <!-- RectAreaLight Width/Height -->
                    <div v-if="selectedPrimProps._width !== undefined" class="property-row">
                      <div class="property-key">width:</div>
                      <div class="property-value">
                        <InputNumber
                          :modelValue="selectedPrimProps._width"
                          :minFractionDigits="1"
                          :maxFractionDigits="2"
                          :min="0"
                          :step="0.1"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimScalarEdit('width', v)"
                        />
                      </div>
                    </div>
                    <div v-if="selectedPrimProps._height !== undefined" class="property-row">
                      <div class="property-key">height:</div>
                      <div class="property-value">
                        <InputNumber
                          :modelValue="selectedPrimProps._height"
                          :minFractionDigits="1"
                          :maxFractionDigits="2"
                          :min="0"
                          :step="0.1"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimScalarEdit('height', v)"
                        />
                      </div>
                    </div>
                    <!-- Cube size -->
                    <div v-if="selectedPrimProps._size !== undefined" class="property-row">
                      <div class="property-key">size:</div>
                      <div class="property-value">
                        <InputNumber
                          :modelValue="selectedPrimProps._size"
                          :minFractionDigits="1"
                          :maxFractionDigits="2"
                          :min="0.01"
                          :step="0.1"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimScalarEdit('size', v)"
                        />
                      </div>
                    </div>
                    <!-- Axis (Cylinder/Cone/Capsule) -->
                    <div v-if="selectedPrimProps._axis !== undefined" class="property-row">
                      <div class="property-key">axis:</div>
                      <div class="property-value">
                        <Select
                          :modelValue="selectedPrimProps._axis"
                          :options="['X', 'Y', 'Z']"
                          @update:modelValue="(v) => onPrimScalarEdit('axis', v)"
                        />
                      </div>
                    </div>
                    <!-- Light exposure -->
                    <div v-if="selectedPrimProps._exposure !== undefined" class="property-row">
                      <div class="property-key">exposure:</div>
                      <div class="property-value">
                        <InputNumber
                          :modelValue="selectedPrimProps._exposure"
                          :minFractionDigits="1"
                          :maxFractionDigits="2"
                          :step="0.5"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimScalarEdit('exposure', v)"
                        />
                      </div>
                    </div>
                    <!-- Spotlight shaping cone angle -->
                    <div v-if="selectedPrimProps._shapingConeAngle !== undefined" class="property-row">
                      <div class="property-key">cone angle:</div>
                      <div class="property-value">
                        <InputNumber
                          :modelValue="selectedPrimProps._shapingConeAngle"
                          :minFractionDigits="1"
                          :maxFractionDigits="1"
                          :min="0"
                          :max="180"
                          :step="5"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimScalarEdit('shaping:cone:angle', v)"
                        />
                      </div>
                    </div>
                    <!-- Spotlight shaping cone softness -->
                    <div v-if="selectedPrimProps._shapingConeSoftness !== undefined" class="property-row">
                      <div class="property-key">cone softness:</div>
                      <div class="property-value">
                        <InputNumber
                          :modelValue="selectedPrimProps._shapingConeSoftness"
                          :minFractionDigits="2"
                          :maxFractionDigits="2"
                          :min="0"
                          :max="1"
                          :step="0.05"
                          mode="decimal"
                          @update:modelValue="(v) => onPrimScalarEdit('shaping:cone:softness', v)"
                        />
                      </div>
                    </div>
                    <!-- Mesh doubleSided -->
                    <div v-if="selectedPrimProps._doubleSided !== undefined" class="property-row">
                      <div class="property-key">doubleSided:</div>
                      <div class="property-value">
                        <Checkbox
                          :modelValue="selectedPrimProps._doubleSided"
                          :binary="true"
                          @update:modelValue="(v) => onPrimScalarEdit('doubleSided', v)"
                        />
                      </div>
                    </div>
                    <!-- Other Properties (read-only) -->
                    <div v-for="(value, key) in filteredPrimProps" :key="key" class="property-row">
                      <div class="property-key">{{ key }}:</div>
                      <div class="property-value">{{ value }}</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </TabPanel>
          <TabPanel value="status">
            <div class="status">{{ status }}</div>
          </TabPanel>
          <TabPanel value="scene">
            <div class="scene-panel">
              <div class="scene-toolbar">
                <button class="refresh-btn" @click="refreshSceneTree" title="Refresh tree (to show loaded textures)">↻ Refresh</button>
              </div>
              <Tree
                ref="sceneTreeRef"
                class="scene-tree"
                :value="threeTreeNodes"
                selectionMode="single"
                v-model:selectionKeys="threeSelectionKeys"
                v-model:expandedKeys="threeExpandedKeys"
                @node-select="onThreeNodeSelect"
                @nodeSelect="onThreeNodeSelect"
                @node-expand="onThreeNodeExpand"
                @nodeExpand="onThreeNodeExpand"
              />
              <div v-if="selectedThreeObjectProps" class="scene-properties">
                <div class="properties-header">Properties</div>
                <div class="properties-scroll">
                  <!-- Texture image preview -->
                  <div v-if="selectedIsTexture && selectedThreeObjectProps.imageUrl" class="texture-preview">
                    <img :src="selectedThreeObjectProps.imageUrl" alt="Texture preview" class="texture-preview-img" />
                    <div class="texture-preview-info">
                      {{ selectedThreeObjectProps.imageWidth }}×{{ selectedThreeObjectProps.imageHeight }}
                    </div>
                  </div>
                  <div class="properties-content">
                  <div v-for="prop in flattenedProperties" :key="prop.path" class="property-row">
                    <div class="property-key">{{ prop.path }}:</div>
                    <template v-if="prop.isVector3">
                      <div class="property-value vector3-value">
                        <InputNumber
                          class="vector3-input"
                          :modelValue="prop.rawValue.x"
                          :minFractionDigits="1"
                          :maxFractionDigits="3"
                          :step="0.1"
                          mode="decimal"
                          showButtons
                          buttonLayout="stacked"
                          @update:modelValue="(v) => onPropertyEdit(prop.path + '.x', v)"
                        />
                        <InputNumber
                          class="vector3-input"
                          :modelValue="prop.rawValue.y"
                          :minFractionDigits="1"
                          :maxFractionDigits="3"
                          :step="0.1"
                          mode="decimal"
                          showButtons
                          buttonLayout="stacked"
                          @update:modelValue="(v) => onPropertyEdit(prop.path + '.y', v)"
                        />
                        <InputNumber
                          class="vector3-input"
                          :modelValue="prop.rawValue.z"
                          :minFractionDigits="1"
                          :maxFractionDigits="3"
                          :step="0.1"
                          mode="decimal"
                          showButtons
                          buttonLayout="stacked"
                          @update:modelValue="(v) => onPropertyEdit(prop.path + '.z', v)"
                        />
                      </div>
                    </template>
                    <template v-else-if="prop.isVector2">
                      <div class="property-value vector2-value">
                        <InputNumber
                          class="vector2-input"
                          :modelValue="prop.rawValue.x"
                          :minFractionDigits="1"
                          :maxFractionDigits="3"
                          :step="0.1"
                          mode="decimal"
                          showButtons
                          buttonLayout="stacked"
                          @update:modelValue="(v) => onPropertyEdit(prop.path + '.x', v)"
                        />
                        <InputNumber
                          class="vector2-input"
                          :modelValue="prop.rawValue.y"
                          :minFractionDigits="1"
                          :maxFractionDigits="3"
                          :step="0.1"
                          mode="decimal"
                          showButtons
                          buttonLayout="stacked"
                          @update:modelValue="(v) => onPropertyEdit(prop.path + '.y', v)"
                        />
                      </div>
                    </template>
                    <template v-else-if="prop.isColor">
                      <div class="property-value color-value">
                        <input
                          type="color"
                          class="color-picker"
                          :value="prop.displayValue"
                          @input="(e) => onPropertyEdit(prop.path, (e.target as HTMLInputElement).value)"
                        />
                        <span class="color-hex">{{ prop.displayValue }}</span>
                      </div>
                    </template>
                    <template v-else-if="prop.isBool">
                      <div class="property-value bool-value">
                        <Checkbox
                          :modelValue="prop.rawValue"
                          :binary="true"
                          @update:modelValue="(v) => onPropertyEdit(prop.path, v)"
                        />
                      </div>
                    </template>
                    <template v-else-if="prop.isNumber">
                      <div class="property-value number-value">
                        <InputNumber
                          class="number-input"
                          :modelValue="prop.rawValue"
                          :minFractionDigits="0"
                          :maxFractionDigits="3"
                          :step="0.1"
                          mode="decimal"
                          @update:modelValue="(v) => onPropertyEdit(prop.path, v)"
                        />
                      </div>
                    </template>
                    <template v-else-if="prop.isString">
                      <div class="property-value string-value">
                        <InputText
                          class="string-input"
                          :modelValue="prop.rawValue"
                          @update:modelValue="(v) => onPropertyEdit(prop.path, v)"
                        />
                      </div>
                    </template>
                    <template v-else-if="prop.isEnum && prop.enumOptions">
                      <div class="property-value enum-value">
                        <Select
                          class="enum-select"
                          :modelValue="prop.rawValue"
                          :options="prop.enumOptions"
                          optionLabel="label"
                          optionValue="value"
                          @update:modelValue="(v) => onPropertyEdit(prop.path, v)"
                        />
                      </div>
                    </template>
                    <template v-else-if="prop.editable">
                      <div
                        class="property-value editable"
                        :contenteditable="true"
                        @blur="(e) => onPropertyEdit(prop.path, (e.target as HTMLElement).textContent)"
                        @keydown.enter.prevent="(e) => { (e.target as HTMLElement).blur() }"
                      >{{ prop.displayValue }}</div>
                    </template>
                    <template v-else>
                      <div class="property-value">{{ prop.displayValue }}</div>
                    </template>
                  </div>
                </div>
                </div>
              </div>
            </div>
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
import { onMounted, onBeforeUnmount, ref, watch, computed, nextTick } from 'vue';

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
import InputNumber from 'primevue/inputnumber';
import InputText from 'primevue/inputtext';

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

// Persistent UI state keys
const STORAGE_KEY_ACTIVE_TAB = 'usdjs-viewer:activeTab';
const STORAGE_KEY_SELECTED_PATH = 'usdjs-viewer:selectedPath';

// Active tab persistence
const activeTab = ref<string>(localStorage.getItem(STORAGE_KEY_ACTIVE_TAB) ?? 'source');

const corpusGroups = computed(() => CORPUS_GROUPS.map((g) => ({ id: g.id, label: `${g.label} (${g.files.length})`, files: g.files })));
const corpusGroupId = ref(CORPUS_GROUPS[0]?.id ?? '');
const corpusRel = ref<string>('');
const corpusFiles = computed(() => {
  const g = CORPUS_GROUPS.find((x) => x.id === corpusGroupId.value) ?? CORPUS_GROUPS[0];
  const list = (g?.files ?? []).map((rel) => ({ label: rel.split('/').slice(-3).join('/'), value: rel }));

  // If the current value came from URL hash (or manual typing) but isn't in the curated list,
  // inject it so PrimeVue Select can still display the actual selected path instead of
  // appearing "stuck" on the previously recognized option.
  if (corpusRel.value && !list.some((x) => x.value === corpusRel.value)) {
    list.unshift({
      label: `[hash] ${corpusRel.value.split('/').slice(-3).join('/')}`,
      value: corpusRel.value,
    });
  }
  return list;
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
const threeTreeNodes = ref<PrimeTreeNode[]>([]);
const selectionKeys = ref<Record<string, boolean>>({});
const threeSelectionKeys = ref<Record<string, boolean>>({});
const threeExpandedKeys = ref<Record<string, boolean>>({});
const selectedThreeObjectProps = ref<Record<string, any> | null>(null);
const selectedThreeObjectUuid = ref<string | null>(null);
const selectedIsMaterial = ref(false);
const selectedIsTexture = ref(false);
const sceneTreeRef = ref<InstanceType<typeof Tree> | null>(null);
const selectedPrimProps = ref<Record<string, any> | null>(null);
const selectedPrimPath = ref<string | null>(null);

// Filter out internal transform properties from display
const filteredPrimProps = computed(() => {
  const props = selectedPrimProps.value;
  if (!props) return {};
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(props)) {
    // Skip internal transform properties (shown in editable inputs)
    if (key.startsWith('_')) continue;
    result[key] = value;
  }
  return result;
});

// Handle prim property edits (incremental update)
function onPrimPropertyEdit(propName: string, component: 'x' | 'y' | 'z', value: number | null) {
  if (!selectedPrimPath.value || !selectedPrimProps.value || !core.value) return;
  
  // Get the current transform values
  const rawKey = propName === 'xformOp:translate' ? '_translate' 
    : propName === 'xformOp:rotateXYZ' ? '_rotate' 
    : propName === 'xformOp:scale' ? '_scale' 
    : null;
  if (!rawKey) return;
  
  const current = selectedPrimProps.value[rawKey] ?? { x: 0, y: 0, z: 0 };
  const newValue = { ...current, [component]: value ?? 0 };
  
  // Apply the change incrementally
  const success = core.value.setPrimProperty(selectedPrimPath.value, propName, newValue);
  if (success) {
    // Update local state to reflect the change
    selectedPrimProps.value = {
      ...selectedPrimProps.value,
      [rawKey]: newValue,
    };
  }
}

// Handle scalar prim property edits (visibility, intensity, angle, etc.)
function onPrimScalarEdit(propName: string, value: any) {
  if (!selectedPrimPath.value || !selectedPrimProps.value || !core.value) return;
  
  // Apply the change incrementally
  const success = core.value.setPrimProperty(selectedPrimPath.value, propName, value);
  if (success) {
    // Map property name to internal key
    const rawKey = `_${propName}`;
    // Update local state to reflect the change
    selectedPrimProps.value = {
      ...selectedPrimProps.value,
      [rawKey]: value,
    };
  }
}

// Handle color prim property edits (r, g, b components)
function onPrimColorEdit(propName: string, component: 'r' | 'g' | 'b', value: number | null) {
  if (!selectedPrimPath.value || !selectedPrimProps.value || !core.value) return;
  
  const rawKey = `_${propName}`;
  const current = selectedPrimProps.value[rawKey] ?? { r: 1, g: 1, b: 1 };
  const newValue = { ...current, [component]: value ?? 0 };
  
  // Apply the change incrementally
  const success = core.value.setPrimProperty(selectedPrimPath.value, propName, newValue);
  if (success) {
    // Update local state to reflect the change
    selectedPrimProps.value = {
      ...selectedPrimProps.value,
      [rawKey]: newValue,
    };
  }
}

// Editable properties list
const EDITABLE_PROPS = new Set([
  'name', 'visible', 'castShadow', 'receiveShadow', 'frustumCulled', 'renderOrder',
  'position.x', 'position.y', 'position.z',
  'rotation.x', 'rotation.y', 'rotation.z',
  'scale.x', 'scale.y', 'scale.z',
  // Direct material properties (when material node is selected)
  'color', 'opacity', 'metalness', 'roughness', 'emissive', 'emissiveIntensity',
  'wireframe', 'transparent', 'depthTest', 'depthWrite',
  // Light properties
  'intensity', 'angle', 'penumbra', 'decay', 'distance', 'width', 'height',
  'groundColor', 'shadowBias', 'shadowNormalBias', 'shadowRadius',
  'target.x', 'target.y', 'target.z',
  'shadowMapSize.x', 'shadowMapSize.y',
  'shadowCamera.left', 'shadowCamera.right', 'shadowCamera.top', 'shadowCamera.bottom',
  'shadowCamera.near', 'shadowCamera.far', 'shadowCamera.fov',
  // Texture properties
  'flipY', 'generateMipmaps', 'premultiplyAlpha',
]);

// Color properties (use color picker)
const COLOR_PROPS = new Set([
  'color', 'emissive', 'groundColor',
]);

// Boolean properties (use checkbox)
const BOOL_PROPS = new Set([
  'visible', 'castShadow', 'receiveShadow', 'frustumCulled',
  'wireframe', 'transparent', 'depthTest', 'depthWrite',
  // Texture properties
  'flipY', 'generateMipmaps', 'premultiplyAlpha',
]);

// Numeric properties (use InputNumber)
const NUMBER_PROPS = new Set([
  'renderOrder',
  'opacity', 'metalness', 'roughness', 'emissiveIntensity',
  // Light properties
  'intensity', 'angle', 'penumbra', 'decay', 'distance', 'width', 'height',
  'shadowBias', 'shadowNormalBias', 'shadowRadius',
  // Shadow camera (individual values when shadowCamera object is flattened)
  'shadowCamera.left', 'shadowCamera.right', 'shadowCamera.top', 'shadowCamera.bottom',
  'shadowCamera.near', 'shadowCamera.far', 'shadowCamera.fov',
]);

// String properties (use InputText)
const STRING_PROPS = new Set(['name', 'material.type', 'type']);

// Enum properties (use Select dropdown)
const ENUM_PROPS: Record<string, Array<{ label: string; value: string }>> = {
  wrapS: [
    { label: 'RepeatWrapping', value: 'RepeatWrapping' },
    { label: 'ClampToEdgeWrapping', value: 'ClampToEdgeWrapping' },
    { label: 'MirroredRepeatWrapping', value: 'MirroredRepeatWrapping' },
  ],
  wrapT: [
    { label: 'RepeatWrapping', value: 'RepeatWrapping' },
    { label: 'ClampToEdgeWrapping', value: 'ClampToEdgeWrapping' },
    { label: 'MirroredRepeatWrapping', value: 'MirroredRepeatWrapping' },
  ],
  magFilter: [
    { label: 'NearestFilter', value: 'NearestFilter' },
    { label: 'LinearFilter', value: 'LinearFilter' },
  ],
  minFilter: [
    { label: 'NearestFilter', value: 'NearestFilter' },
    { label: 'NearestMipmapNearest', value: 'NearestMipmapNearest' },
    { label: 'NearestMipmapLinear', value: 'NearestMipmapLinear' },
    { label: 'LinearFilter', value: 'LinearFilter' },
    { label: 'LinearMipmapNearest', value: 'LinearMipmapNearest' },
    { label: 'LinearMipmapLinear', value: 'LinearMipmapLinear' },
  ],
  colorSpace: [
    { label: 'sRGB', value: 'sRGB' },
    { label: 'Linear sRGB', value: 'Linear sRGB' },
    { label: 'None', value: 'None' },
  ],
  side: [
    { label: 'FrontSide', value: 'FrontSide' },
    { label: 'BackSide', value: 'BackSide' },
    { label: 'DoubleSide', value: 'DoubleSide' },
  ],
};

// Convert number to hex color string
function toHexColor(value: number): string {
  return '#' + value.toString(16).padStart(6, '0');
}

// Vector3 properties (use triple input)
const VECTOR3_PROPS = new Set(['position', 'scale', 'rotation', 'target']);
// Vector2 properties (use double input) - for texture properties and shadow map size
const VECTOR2_PROPS = new Set(['repeat', 'offset', 'center', 'shadowMapSize']);

// Flatten properties for display
const flattenedProperties = computed(() => {
  const props = selectedThreeObjectProps.value;
  if (!props) return [];
  
  const result: Array<{ path: string; displayValue: string; editable: boolean; isColor: boolean; isBool: boolean; isVector2: boolean; isVector3: boolean; isNumber: boolean; isString: boolean; isEnum: boolean; enumOptions: Array<{ label: string; value: string }> | null; rawValue: any }> = [];
  
  // Keys that should be flattened into individual properties
  const FLATTEN_KEYS = ['light', 'shadowCamera'];
  
  // Keys to skip (shown separately in UI)
  const SKIP_KEYS = ['imageUrl', 'imageWidth', 'imageHeight'];
  
  function flatten(obj: any, prefix = '') {
    for (const [key, value] of Object.entries(obj)) {
      // Skip image-related properties for textures (shown in preview)
      if (SKIP_KEYS.includes(key)) continue;
      
      const path = prefix ? `${prefix}.${key}` : key;
      
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        // For position/scale/rotation, show as single vector3 row
        if (VECTOR3_PROPS.has(key)) {
          result.push({
            path,
            displayValue: `${value.x}, ${value.y}, ${value.z}`,
            editable: true,
            isColor: false,
            isBool: false,
            isVector2: false,
            isVector3: true,
            isNumber: false,
            isString: false,
            isEnum: false,
            enumOptions: null,
            rawValue: value,
          });
        } else if (VECTOR2_PROPS.has(key)) {
          // For repeat/offset/center (texture), show as vector2 row
          result.push({
            path,
            displayValue: `${value.x}, ${value.y}`,
            editable: true,
            isColor: false,
            isBool: false,
            isVector2: true,
            isVector3: false,
            isNumber: false,
            isString: false,
            isEnum: false,
            enumOptions: null,
            rawValue: value,
          });
        } else if (FLATTEN_KEYS.includes(key)) {
          // For rotation/light, flatten into individual values
          flatten(value, path);
        } else {
          // For other nested objects, show as JSON
          result.push({
            path,
            displayValue: JSON.stringify(value),
            editable: false,
            isColor: false,
            isBool: false,
            isVector2: false,
            isVector3: false,
            isNumber: false,
            isString: false,
            isEnum: false,
            enumOptions: null,
            rawValue: value,
          });
        }
      } else {
        const isColor = COLOR_PROPS.has(path);
        const isBool = BOOL_PROPS.has(path);
        const isNumber = NUMBER_PROPS.has(path);
        const isString = STRING_PROPS.has(path);
        // Check enum options by key first, then by full path (for nested properties like material.side)
        const enumOptions = ENUM_PROPS[key] ?? ENUM_PROPS[path] ?? null;
        const isEnum = enumOptions !== null;
        result.push({
          path,
          displayValue: isColor && typeof value === 'number' ? toHexColor(value) : formatPropertyValue(value),
          editable: EDITABLE_PROPS.has(path) || isEnum,
          isColor,
          isBool,
          isVector2: false,
          isVector3: false,
          isNumber,
          isString,
          isEnum,
          enumOptions,
          rawValue: value,
        });
      }
    }
  }
  
  flatten(props);
  return result;
});
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
  if (group) {
    corpusGroupId.value = group.id;
  } else {
    // Heuristic: map common corpora by path prefix even when the curated list doesn't include the file.
    if (rel.startsWith('test/corpus/external/usd-wg-assets/')) corpusGroupId.value = 'usdwg';
    if (rel.startsWith('test/corpus/external/ft-lab-sample-usd/')) corpusGroupId.value = 'ftlab';
  }
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
  
  // Build tree immediately
  const treeData = c.getThreeSceneTree();
  // eslint-disable-next-line no-console
  console.log('[Scene Tree] Built tree with', treeData.length, 'roots:', treeData);
  threeTreeNodes.value = treeData;
  // Clear selection when scene changes
  threeSelectionKeys.value = {};
  selectedThreeObjectProps.value = null;
  selectedThreeObjectUuid.value = null;
  
  // Refresh tree after delay to catch async-loaded textures
  setTimeout(() => {
    const refreshedTree = c.getThreeSceneTree();
    threeTreeNodes.value = refreshedTree;
    // eslint-disable-next-line no-console
    console.log('[Scene Tree] Refreshed tree after texture load delay');
  }, 1500);
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
  try {
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
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    status.value = `Error loading corpus: ${corpusRel.value}\n${msg}`;
    // eslint-disable-next-line no-console
    console.error(e);
  }
}

function onNodeSelect(e: any) {
  const node: PrimeTreeNode | undefined = e?.node;
  if (!node) return;
  const nextPath: string | null = node.data?.path ?? null;
  // If the selection didn't actually change, skip
  if (nextPath === lastSelectedPath.value) return;
  lastSelectedPath.value = nextPath;
  
  // Fetch prim properties for display in the properties panel
  if (nextPath && core.value) {
    selectedPrimProps.value = core.value.getPrimProperties(nextPath);
  } else {
    selectedPrimProps.value = null;
  }
  // Note: We don't call run() here - just update the properties panel.
  // The scene is already rendered; selecting a prim just shows its properties.
}

function refreshSceneTree() {
  if (!core.value) return;
  const refreshedTree = core.value.getThreeSceneTree();
  threeTreeNodes.value = refreshedTree;
  // eslint-disable-next-line no-console
  console.log('[Scene Tree] Manual refresh - found textures:', 
    JSON.stringify(refreshedTree, (k, v) => k === 'children' && v ? `[${v.length} children]` : v, 2).slice(0, 500));
}

function onThreeNodeSelect(e: any) {
  const node: PrimeTreeNode | undefined = e?.node;
  if (!node || !core.value) {
    selectedThreeObjectProps.value = null;
    selectedThreeObjectUuid.value = null;
    return;
  }
  const key = String(node.key);
  
  // eslint-disable-next-line no-console
  console.log('[Scene Tree] Node selected, key:', key, 'isTexture:', core.value.isTextureKey(key), 'isMaterial:', core.value.isMaterialKey(key));
  
  let props: Record<string, any> | null = null;
  
  // Check if it's a texture node
  if (core.value.isTextureKey(key)) {
    props = core.value.getTextureProperties(key);
    // eslint-disable-next-line no-console
    console.log('[Scene Tree] Selected texture:', { key, propsFound: !!props, props });
  }
  // Check if it's a material node  
  else if (core.value.isMaterialKey(key)) {
    props = core.value.getMaterialProperties(key);
    // eslint-disable-next-line no-console
    console.log('[Scene Tree] Selected material:', { key, propsFound: !!props, props });
  }
  // Regular object
  else {
    props = core.value.getThreeObjectProperties(key);
    // eslint-disable-next-line no-console
    console.log('[Scene Tree] Selected object:', { key, propsFound: !!props, props });
  }
  
  selectedThreeObjectProps.value = props;
  selectedThreeObjectUuid.value = key;
  
  // Scroll selected node into view after properties panel expands
  nextTick(() => {
    scrollSelectedNodeIntoView(key);
  });
}

function scrollSelectedNodeIntoView(uuid: string) {
  // eslint-disable-next-line no-console
  console.log('[Scene Tree] Scrolling to selected node:', uuid);
  
  // Find the selected node in the tree by its data-key attribute or aria-selected
  const treeEl = sceneTreeRef.value?.$el as HTMLElement | undefined;
  // eslint-disable-next-line no-console
  console.log('[Scene Tree] Tree element:', treeEl);
  if (!treeEl) return;
  
  // PrimeVue Tree marks selected nodes with aria-selected="true" or p-tree-node-selected class
  const selectedNode = treeEl.querySelector('.p-tree-node-selected, [aria-selected="true"]') as HTMLElement | null;
  // eslint-disable-next-line no-console
  console.log('[Scene Tree] Found selected node:', selectedNode);
  if (selectedNode) {
    selectedNode.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function onThreeNodeExpand(e: any) {
  // eslint-disable-next-line no-console
  console.log('[Scene Tree] Node expand event:', e);
  const node = e?.node;
  if (!node?.key) return;
  
  // Wait for DOM to update with expanded children
  nextTick(() => {
    scrollToExpandedNodeChildren(node.key);
  });
}

function scrollToExpandedNodeChildren(nodeKey: string) {
  // eslint-disable-next-line no-console
  console.log('[Scene Tree] Scrolling to expanded node children:', nodeKey);
  
  const treeEl = sceneTreeRef.value?.$el as HTMLElement | undefined;
  if (!treeEl) return;
  
  // Find nodes and scroll the last visible one into view
  // This ensures newly expanded children are visible
  const allTreeNodes = treeEl.querySelectorAll('.p-tree-node-content');
  if (allTreeNodes.length > 0) {
    const lastNode = allTreeNodes[allTreeNodes.length - 1] as HTMLElement;
    lastNode.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function onPropertyEdit(path: string, newValue: string | boolean | number | null) {
  if (!core.value || !selectedThreeObjectUuid.value || newValue === null) return;
  
  // Handle different value types
  const finalValue = typeof newValue === 'string' ? newValue.trim() : newValue;
  // eslint-disable-next-line no-console
  console.log('[Scene Tree] Editing property:', path, '=', finalValue, 'isTexture:', selectedIsTexture.value, 'isMaterial:', selectedIsMaterial.value);
  
  let success: boolean;
  if (selectedIsTexture.value) {
    success = core.value.setTextureProperty(selectedThreeObjectUuid.value, path, finalValue);
  } else if (selectedIsMaterial.value) {
    success = core.value.setMaterialProperty(selectedThreeObjectUuid.value, path, finalValue);
  } else {
    success = core.value.setThreeObjectProperty(selectedThreeObjectUuid.value, path, finalValue);
  }
  
  if (success) {
    // Refresh properties to show updated values
    let props: Record<string, any> | null;
    if (selectedIsTexture.value) {
      props = core.value.getTextureProperties(selectedThreeObjectUuid.value);
    } else if (selectedIsMaterial.value) {
      props = core.value.getMaterialProperties(selectedThreeObjectUuid.value);
    } else {
      props = core.value.getThreeObjectProperties(selectedThreeObjectUuid.value);
    }
    selectedThreeObjectProps.value = props;
  }
}

function formatPropertyValue(value: any): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return `[${value.map(formatPropertyValue).join(', ')}]`;
    }
    // Format objects nicely
    const entries = Object.entries(value).map(([k, v]) => `${k}: ${formatPropertyValue(v)}`);
    return `{ ${entries.join(', ')} }`;
  }
  if (typeof value === 'number') {
    // Format numbers with reasonable precision
    return Number.isInteger(value) ? String(value) : value.toFixed(3);
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  return String(value);
}

// Handle click on viewport to pick object and switch to Scene tab
function onViewportClickWithTabSwitch(e: MouseEvent) {
  if (!core.value || !viewportEl.value) return;
  
  // Get the canvas element
  const canvas = viewportEl.value.querySelector('canvas');
  if (!canvas || e.target !== canvas) return;
  
  // Convert mouse coordinates to normalized device coordinates (-1 to +1)
  const rect = canvas.getBoundingClientRect();
  const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  
  // Perform raycast
  const hitUuid = core.value.raycastAtNDC(ndcX, ndcY);
  
  if (hitUuid) {
    // eslint-disable-next-line no-console
    console.log('[Scene Pick] Hit object:', hitUuid);
    
    // Switch to Scene tab
    activeTab.value = 'scene';
    
    // Get ancestor UUIDs to expand parent nodes
    const ancestors = core.value.getAncestorUuids(hitUuid);
    
    // Expand all ancestor nodes
    const newExpandedKeys = { ...threeExpandedKeys.value };
    for (const ancestorUuid of ancestors) {
      newExpandedKeys[ancestorUuid] = true;
    }
    threeExpandedKeys.value = newExpandedKeys;
    
    // Select the hit object
    threeSelectionKeys.value = { [hitUuid]: true };
    
    // Scroll to the selected node after DOM updates
    nextTick(() => {
      scrollSelectedNodeIntoView(hitUuid);
    });
  }
}

function cDefaultUsda() {
  return core.value?.getDefaultUsda() ?? '';
}

// Restore selected path from localStorage if it exists in the current tree
function restoreSelectedPath() {
  const savedPath = localStorage.getItem(STORAGE_KEY_SELECTED_PATH);
  if (!savedPath || !core.value) return;
  
  // Check if the path exists in the current tree by searching recursively
  function findPath(nodes: PrimeTreeNode[]): boolean {
    for (const node of nodes) {
      if (node.data?.path === savedPath) return true;
      if (node.children && findPath(node.children)) return true;
    }
    return false;
  }
  
  if (findPath(treeNodes.value)) {
    lastSelectedPath.value = savedPath;
    selectionKeys.value = { [savedPath]: true };
    void core.value.setSelectedPath(savedPath);
  }
}

watch(compose, () => void run());

// Persist active tab to localStorage
watch(activeTab, (tab) => {
  localStorage.setItem(STORAGE_KEY_ACTIVE_TAB, tab);
});

// Persist selected node path to localStorage
watch(lastSelectedPath, (path) => {
  if (path) {
    localStorage.setItem(STORAGE_KEY_SELECTED_PATH, path);
  } else {
    localStorage.removeItem(STORAGE_KEY_SELECTED_PATH);
  }
});

// Watch for outliner selection changes (USD prims)
watch(selectionKeys, (newKeys) => {
  const selectedKeys = Object.keys(newKeys).filter(k => newKeys[k]);
  if (selectedKeys.length > 0 && core.value) {
    const path = selectedKeys[0]!;
    selectedPrimPath.value = path;
    selectedPrimProps.value = core.value.getPrimProperties(path);
    // Update lastSelectedPath to keep it in sync (for persistence)
    lastSelectedPath.value = path;
  } else {
    selectedPrimPath.value = null;
    selectedPrimProps.value = null;
  }
}, { deep: true });

// Watch for scene tree selection changes
watch(threeSelectionKeys, (newKeys) => {
  // eslint-disable-next-line no-console
  console.log('[Scene Tree] Selection keys changed:', newKeys);
  const selectedKeys = Object.keys(newKeys).filter(k => newKeys[k]);
  if (selectedKeys.length > 0 && core.value) {
    const key = selectedKeys[0]!;
    
    // Check if this is a texture or material node
    const isTexture = core.value.isTextureKey(key);
    const isMaterial = !isTexture && core.value.isMaterialKey(key);
    selectedIsMaterial.value = isMaterial;
    selectedIsTexture.value = isTexture;
    
    let props: Record<string, any> | null;
    if (isTexture) {
      props = core.value.getTextureProperties(key);
      // eslint-disable-next-line no-console
      console.log('[Scene Tree] Loading texture props for:', key, props);
    } else if (isMaterial) {
      props = core.value.getMaterialProperties(key);
      // eslint-disable-next-line no-console
      console.log('[Scene Tree] Loading material props for:', key, props);
    } else {
      props = core.value.getThreeObjectProperties(key);
      // eslint-disable-next-line no-console
      console.log('[Scene Tree] Loading object props for:', key, props);
    }
    
    selectedThreeObjectProps.value = props;
    selectedThreeObjectUuid.value = key;
    
    // Scroll selected node into view after properties panel expands
    nextTick(() => {
      scrollSelectedNodeIntoView(key);
    });
  } else {
    selectedThreeObjectProps.value = null;
    selectedThreeObjectUuid.value = null;
    selectedIsMaterial.value = false;
    selectedIsTexture.value = false;
  }
}, { deep: true });

// Watch for scene tree expansion changes
let prevExpandedKeys: Record<string, boolean> = {};
watch(threeExpandedKeys, (newKeys) => {
  // Find newly expanded keys
  const newlyExpanded = Object.keys(newKeys).filter(k => newKeys[k] && !prevExpandedKeys[k]);
  // eslint-disable-next-line no-console
  console.log('[Scene Tree] Expanded keys changed:', { newKeys, newlyExpanded });
  
  if (newlyExpanded.length > 0) {
    // Scroll to show children of newly expanded node
    nextTick(() => {
      scrollToExpandedNodeChildren(newlyExpanded[0]!);
    });
  }
  
  prevExpandedKeys = { ...newKeys };
}, { deep: true });

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
let unlistenViewportClick: (() => void) | null = null;
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
  
  // Add click listener on viewport for picking objects (with Scene tab switch)
  viewportEl.value.addEventListener('click', onViewportClickWithTabSwitch);
  unlistenViewportClick = () => viewportEl.value?.removeEventListener('click', onViewportClickWithTabSwitch);

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
  
  // Restore selected node from localStorage
  restoreSelectedPath();

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
  unlistenViewportClick?.();
  unlistenViewportClick = null;
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
  overflow: auto;
}

.scene-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.outliner-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.outliner-panel .outliner {
  flex: 1 1 60%;
  min-height: 0;
  overflow: auto;
  border-bottom: 1px solid var(--p-surface-200);
}

:deep(.outliner .p-tree) {
  height: 100%;
  overflow: auto;
}

.prim-properties {
  flex: 0 0 40%;
  min-height: 150px;
  max-height: 40%;
  display: flex;
  flex-direction: column;
  border-top: 1px solid #333;
  overflow: hidden;
  background: #1a1a1a;
}

.scene-toolbar {
  display: flex;
  padding: 4px 8px;
  background: #1a1a1a;
  border-bottom: 1px solid #333;
}

.refresh-btn {
  padding: 2px 8px;
  font-size: 11px;
  background: #333;
  color: #ccc;
  border: 1px solid #555;
  border-radius: 3px;
  cursor: pointer;
}

.refresh-btn:hover {
  background: #444;
  color: #fff;
}

.scene-tree {
  flex: 1 1 60%;
  min-height: 0;
  overflow: auto;
  border-bottom: 1px solid var(--p-surface-200);
}

:deep(.scene-tree .p-tree) {
  height: 100%;
  overflow: auto;
}

/* Dim hidden objects in the tree */
:deep(.tree-node-hidden) {
  opacity: 0.45;
}

.scene-properties {
  flex: 0 0 40%;
  min-height: 150px;
  max-height: 40%;
  display: flex;
  flex-direction: column;
  border-top: 1px solid #333;
  overflow: hidden;
  background: #1a1a1a;
}

.properties-header {
  flex-shrink: 0;
  padding: 8px 12px;
  font-weight: 600;
  font-size: 12px;
  background: #222;
  border-bottom: 1px solid #333;
  color: #e0e0e0;
}

.properties-scroll {
  flex: 1 1 0;
  min-height: 0;
  overflow: auto;
  background: #1a1a1a;
}

.properties-content {
  padding: 8px 12px;
  font-size: 11px;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: #d0d0d0;
}

.texture-preview {
  padding: 12px;
  background: #111;
  border-bottom: 1px solid #333;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.texture-preview-img {
  max-width: 100%;
  max-height: 450px;
  object-fit: contain;
  border: 1px solid #444;
  border-radius: 4px;
  background: repeating-conic-gradient(#333 0% 25%, #222 0% 50%) 50% / 16px 16px;
}

.texture-preview-info {
  font-size: 11px;
  color: #888;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
}

.property-row {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
  word-break: break-word;
}

.property-key {
  font-weight: 600;
  color: #818cf8;
  min-width: 120px;
  flex-shrink: 0;
}

.property-value {
  color: #d0d0d0;
  flex: 1;
  padding: 2px 6px;
  border: 1px solid transparent;
}

.property-value.editable {
  cursor: text;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.05);
  transition: all 0.15s ease;
  outline: none;
}

.property-value.editable:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: #444;
}

.property-value.editable:focus {
  background: rgba(99, 102, 241, 0.15);
  border-color: #818cf8;
  color: #fff;
}

.property-value.vector3-value {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  flex-wrap: wrap;
}

.vector3-input {
  flex: 1 1 100px;
  min-width: 100px;
}

:deep(.vector3-input.p-inputnumber) {
  width: 100%;
}

:deep(.vector3-input .p-inputnumber-input) {
  width: 100%;
}

.property-value.vector2-value {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  flex-wrap: wrap;
}

.vector2-input {
  flex: 1 1 100px;
  min-width: 100px;
}

:deep(.vector2-input.p-inputnumber) {
  width: 100%;
}

:deep(.vector2-input .p-inputnumber-input) {
  width: 100%;
}

.property-value.number-value {
  display: flex;
  flex: 1;
}

.number-input {
  flex: 1;
  min-width: 0;
}

:deep(.number-input.p-inputnumber) {
  width: 100%;
}

:deep(.number-input .p-inputnumber-input) {
  width: 100%;
}

.property-value.string-value {
  display: flex;
  flex: 1;
}

.string-input {
  flex: 1;
  min-width: 0;
  width: 100%;
}

.property-value.enum-value {
  display: flex;
  flex: 1;
}

.enum-select {
  flex: 1;
  min-width: 0;
  width: 100%;
}

:deep(.enum-select.p-select) {
  width: 100%;
}


.property-value.color-value {
  display: flex;
  align-items: center;
  gap: 8px;
}

.color-picker {
  width: 32px;
  height: 24px;
  padding: 0;
  border: 1px solid #444;
  border-radius: 3px;
  cursor: pointer;
  background: transparent;
}

.color-picker::-webkit-color-swatch-wrapper {
  padding: 2px;
}

.color-picker::-webkit-color-swatch {
  border: none;
  border-radius: 2px;
}

.color-hex {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: #d0d0d0;
}

.property-value.bool-value {
  display: flex;
  align-items: center;
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


