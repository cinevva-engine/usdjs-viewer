<template>
  <div ref="root" class="monaco-root"></div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { registerUsdaLanguage } from '../monaco/usdaLanguage';

const props = defineProps<{
  modelValue: string;
  language?: string;
  readOnly?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
}>();

const root = ref<HTMLElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let model: monaco.editor.ITextModel | null = null;
let suppress = false;

onMounted(() => {
  if (!root.value) return;

  // Minimal Monaco worker setup for Vite.
  // We only need the editor worker for plaintext-like usage.
  (self as any).MonacoEnvironment = {
    getWorker() {
      return new (EditorWorker as any)();
    },
  };

  // Register USDA language (custom Monarch tokenizer).
  registerUsdaLanguage(monaco);

  model = monaco.editor.createModel(props.modelValue ?? '', props.language ?? 'plaintext');
  editor = monaco.editor.create(root.value, {
    model,
    theme: 'vs-dark',
    readOnly: props.readOnly ?? false,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 12,
    tabSize: 2,
    automaticLayout: true,
    wordWrap: 'on',
  });

  editor.onDidChangeModelContent(() => {
    if (!model) return;
    if (suppress) return;
    emit('update:modelValue', model.getValue());
  });
});

watch(
  () => props.modelValue,
  (next) => {
    if (!model) return;
    const cur = model.getValue();
    if (next === cur) return;
    suppress = true;
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next ?? '' }], () => null);
    suppress = false;
  }
);

watch(
  () => props.language,
  (lang) => {
    if (!model) return;
    if (!lang) return;
    monaco.editor.setModelLanguage(model, lang);
  }
);

watch(
  () => props.readOnly,
  (ro) => {
    editor?.updateOptions({ readOnly: ro ?? false });
  }
);

onBeforeUnmount(() => {
  editor?.dispose();
  editor = null;
  model?.dispose();
  model = null;
});
</script>

<style scoped>
.monaco-root {
  height: 100%;
  width: 100%;
  /* Ensure it can actually expand inside flex layouts */
  flex: 1;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
}
</style>


