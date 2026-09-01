<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

interface Particle {
  x: number;
  y: number;
  depth: number;
  radius: number;
  vx: number;
  vy: number;
  phase: number;
  twinkle: number;
  sprite: number;
}

const canvas = ref<HTMLCanvasElement | null>(null);
const spriteSize = 32;
const palette = [
  [226, 255, 255],
  [126, 232, 237],
  [174, 247, 249],
  [244, 239, 184],
] as const;
let context: CanvasRenderingContext2D | null = null;
let particles: Particle[] = [];
let sprites: HTMLCanvasElement[] = [];
let frame = 0;
let resizeFrame = 0;
let lastFrame = 0;
let width = 0;
let height = 0;
let reducedMotion: MediaQueryList | null = null;

function particleSprite(): number {
  const chance = Math.random();
  return chance > .955 ? 3 : chance > .72 ? 1 : chance > .48 ? 2 : 0;
}

function buildSprites(): void {
  sprites = palette.map(([red, green, blue]) => {
    const sprite = document.createElement("canvas");
    sprite.width = spriteSize;
    sprite.height = spriteSize;
    const spriteContext = sprite.getContext("2d");
    if (!spriteContext) return sprite;
    const center = spriteSize / 2;
    const glow = spriteContext.createRadialGradient(center, center, 0, center, center, center);
    glow.addColorStop(0, `rgba(${red}, ${green}, ${blue}, 1)`);
    glow.addColorStop(.1, `rgba(${red}, ${green}, ${blue}, .94)`);
    glow.addColorStop(.24, `rgba(${red}, ${green}, ${blue}, .44)`);
    glow.addColorStop(.52, `rgba(${red}, ${green}, ${blue}, .12)`);
    glow.addColorStop(1, `rgba(${red}, ${green}, ${blue}, 0)`);
    spriteContext.fillStyle = glow;
    spriteContext.fillRect(0, 0, spriteSize, spriteSize);
    return sprite;
  });
}

function createParticle(): Particle {
  const depth = .16 + Math.random() * .84;
  return {
    x: Math.random() * width,
    y: Math.random() * height,
    depth,
    radius: .3 + depth * depth * (1.65 + Math.random() * 1.35),
    vx: (Math.random() - .5) * (5 + depth * 14),
    vy: -(7 + Math.random() * 18) * (.4 + depth),
    phase: Math.random() * Math.PI * 2,
    twinkle: .55 + Math.random() * 1.7,
    sprite: particleSprite(),
  };
}

function resetScene(): void {
  const target = Math.round(Math.min(120, Math.max(width < 640 ? 36 : 72, width * height / 10_000)));
  particles = Array.from({ length: target }, createParticle);
  if (canvas.value) {
    canvas.value.dataset.particles = String(target);
  }
}

function resize(): void {
  const element = canvas.value;
  if (!element) return;
  width = window.innerWidth;
  height = window.innerHeight;
  const ratio = Math.min(window.devicePixelRatio || 1, 1.25);
  element.width = Math.round(width * ratio);
  element.height = Math.round(height * ratio);
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  // 不加 `desynchronized`：它是给画笔类应用压输入延迟的低延迟画布，这层装饰画布用不上，
  // 代价却是刷新首帧的白闪 —— 低延迟画布走独立的 swap chain，与挂载时新建的其余合成层
  // （两条帘幕、#app::before 的透视网格）一起分配时，首帧会拿到未初始化的缓冲。
  // 二分实测（docs/09 §7）：同一份产物只改这一个标志位，白闪即消失；GPU 合成路径上才复现，
  // 软件合成与嵌套合成都看不到，本机自动抓帧因此一直抓不到它。
  context = element.getContext("2d", { alpha: true });
  if (context) {
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.imageSmoothingEnabled = true;
  }
  resetScene();
  if (reducedMotion?.matches) draw(0, 0);
}

function queueResize(): void {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(resize);
}

function drawParticle(particle: Particle, now: number): void {
  if (!context) return;
  const pulse = .58 + Math.sin(now * .001 * particle.twinkle + particle.phase) * .32;
  const alpha = Math.max(.12, pulse) * (.38 + particle.depth * .62);
  const size = 5 + particle.radius * 5.2;
  context.globalAlpha = alpha;
  context.drawImage(sprites[particle.sprite]!, particle.x - size / 2, particle.y - size / 2, size, size);
}

function draw(now: number, delta: number): void {
  if (!context) return;
  context.clearRect(0, 0, width, height);
  for (const particle of particles) {
    if (delta) {
      particle.x += (particle.vx + Math.sin(now * .00028 + particle.phase) * 5.2 * particle.depth) * delta;
      particle.y += particle.vy * delta;
      if (particle.y < -18) particle.y = height + 18;
      if (particle.x < -18) particle.x = width + 18;
      if (particle.x > width + 18) particle.x = -18;
    }
    drawParticle(particle, now);
  }
  context.globalAlpha = 1;
}

function animate(now: number): void {
  const delta = Math.min((now - lastFrame) / 1000 || 0, .04);
  lastFrame = now;
  draw(now, delta);
  frame = requestAnimationFrame(animate);
}

function start(): void {
  cancelAnimationFrame(frame);
  lastFrame = performance.now();
  if (reducedMotion?.matches) {
    draw(lastFrame, 0);
    return;
  }
  frame = requestAnimationFrame(animate);
}

function visibilityChanged(): void {
  if (document.hidden) cancelAnimationFrame(frame);
  else start();
}

onMounted(() => {
  reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  buildSprites();
  resize();
  start();
  window.addEventListener("resize", queueResize, { passive: true });
  document.addEventListener("visibilitychange", visibilityChanged);
  reducedMotion.addEventListener("change", start);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  cancelAnimationFrame(resizeFrame);
  window.removeEventListener("resize", queueResize);
  document.removeEventListener("visibilitychange", visibilityChanged);
  reducedMotion?.removeEventListener("change", start);
});
</script>

<template>
  <div class="ambient-scene" aria-hidden="true">
    <span class="ambient-curtain curtain-a" />
    <span class="ambient-curtain curtain-c" />
    <canvas ref="canvas" />
  </div>
</template>

<style scoped>
.ambient-scene {
  position: fixed;
  z-index: -1;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  contain: strict;
}
.ambient-scene::after {
  content: "";
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(90deg, transparent 0 18%, rgba(1, 8, 11, .13) 22% 25%, transparent 29% 43%);
  opacity: .42;
}
canvas {
  position: absolute;
  z-index: 2;
  inset: 0;
  display: block;
  opacity: .86;
}
.ambient-curtain {
  position: absolute;
  z-index: 1;
  top: -18%;
  bottom: -8%;
  width: max(260px, 28vw);
  background: linear-gradient(90deg, transparent 0 9%, rgba(91, 226, 234, .025) 20%, rgba(91, 226, 234, .14) 45%, rgba(178, 252, 253, .12) 54%, rgba(91, 226, 234, .03) 77%, transparent 100%);
  transform: skewX(-4deg);
  transform-origin: center top;
  will-change: transform, opacity;
}
.curtain-a { left: -12%; animation: curtain-a 18s ease-in-out infinite alternate; }
.curtain-c { right: -10%; width: max(280px, 31vw); animation: curtain-c 21s ease-in-out -7s infinite alternate; }
@keyframes curtain-a {
  from { opacity: .3; transform: translate3d(-4vw, -1%, 0) skewX(-5deg) scaleX(.78); }
  to { opacity: .82; transform: translate3d(18vw, 1%, 0) skewX(3deg) scaleX(1.2); }
}
@keyframes curtain-c {
  from { opacity: .25; transform: translate3d(5vw, 2%, 0) skewX(-2deg) scaleX(.75); }
  to { opacity: .76; transform: translate3d(-20vw, -1%, 0) skewX(5deg) scaleX(1.15); }
}
@media (prefers-reduced-motion: reduce) {
  .ambient-curtain { animation: none; }
  .ambient-curtain { opacity: .38; }
}
</style>
