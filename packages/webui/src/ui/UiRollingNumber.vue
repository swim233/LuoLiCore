<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const props = withDefaults(defineProps<{
  value: number;
  ready?: boolean;
  animate?: boolean;
  prefix?: string;
  suffix?: string;
  fractionDigits?: number;
  duration?: number;
}>(), {
  ready: true,
  animate: true,
  prefix: '',
  suffix: '',
  fractionDigits: 0,
  duration: 1200,
});

const current = ref(0);
let frame = 0;
let played = false;

const normalizedTarget = computed(() => Number.isFinite(props.value) ? Math.max(0, props.value) : 0);
const digits = computed(() => Math.min(8, Math.max(0, Math.trunc(props.fractionDigits))));
const format = (value: number): string => {
  const number = digits.value ? value.toFixed(digits.value) : String(Math.round(value));
  return `${props.prefix}${number}${props.suffix}`;
};
const targetText = computed(() => format(normalizedTarget.value));
const currentText = computed(() => format(current.value));
const characters = computed(() => [...currentText.value].map((value, index) => ({ value, index, digit: /\d/.test(value) })));
const widthStyle = computed(() => ({ '--rolling-characters': String(Math.max(1, targetText.value.length)) }));
const reducedMotion = (): boolean => typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function cancel(): void {
  if (!frame) return;
  window.cancelAnimationFrame(frame);
  frame = 0;
}

function start(target: number): void {
  cancel();
  if (!props.animate || reducedMotion() || target === 0 || props.duration <= 0) {
    current.value = target;
    return;
  }
  current.value = 0;
  const startedAt = performance.now();
  const advance = (now: number): void => {
    const progress = Math.min(1, Math.max(0, (now - startedAt) / props.duration));
    const eased = 1 - Math.pow(1 - progress, 4);
    current.value = target * eased;
    if (progress < 1) frame = window.requestAnimationFrame(advance);
    else { current.value = target; frame = 0; }
  };
  frame = window.requestAnimationFrame(advance);
}

watch([() => props.ready, normalizedTarget], ([ready, target]) => {
  if (!ready) {
    if (!played) current.value = 0;
    return;
  }
  if (!played) {
    played = true;
    start(target);
    return;
  }
  cancel();
  current.value = target;
}, { immediate: true });

onBeforeUnmount(cancel);
</script>

<template>
  <span class="rolling-number" :style="widthStyle" :data-current-value="currentText" :data-target-value="targetText">
    <span class="sr-only">{{ targetText }}</span>
    <span class="rolling-number-visual" aria-hidden="true">
      <template v-for="character in characters" :key="character.index">
        <span v-if="character.digit" class="rolling-digit">
          <Transition name="rolling-digit">
            <span :key="character.value" class="rolling-digit-glyph">{{ character.value }}</span>
          </Transition>
        </span>
        <span v-else class="rolling-symbol">{{ character.value }}</span>
      </template>
    </span>
  </span>
</template>

<style scoped>
.rolling-number {
  display: inline-flex;
  min-width: calc(var(--rolling-characters) * .62em);
  justify-content: flex-end;
  font: inherit;
  font-variant-numeric: tabular-nums;
  line-height: 1.08;
}
.rolling-number-visual { display: inline-flex; align-items: baseline; perspective: 8em; }
.rolling-digit {
  position: relative;
  display: inline-grid;
  width: .62em;
  height: 1.08em;
  place-items: center;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 13%, #000 87%, transparent);
  mask-image: linear-gradient(to bottom, transparent, #000 13%, #000 87%, transparent);
}
.rolling-digit-glyph { grid-area: 1 / 1; line-height: 1.08; }
.rolling-symbol { line-height: 1.08; }
.rolling-digit-enter-active,
.rolling-digit-leave-active {
  transition: opacity 110ms ease, transform 140ms cubic-bezier(.22, .61, .36, 1);
  will-change: opacity, transform;
}
.rolling-digit-leave-active { position: absolute; inset: 0; display: grid; place-items: center; }
.rolling-digit-enter-from { opacity: 0; transform: translateY(72%) rotateX(-42deg); }
.rolling-digit-leave-to { opacity: 0; transform: translateY(-72%) rotateX(42deg); }
@media (prefers-reduced-motion: reduce) {
  .rolling-digit-enter-active,
  .rolling-digit-leave-active { transition: none; }
}
</style>
