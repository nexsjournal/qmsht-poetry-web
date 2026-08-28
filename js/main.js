import { smoothstep, getPointID, charForCell } from "./utils.js";
import { clothText } from "./poems.js";
import { chimes } from "./chimes.js";
import { buildPanel } from "./panel.js";
import { initPedestrians } from "./pedestrians.js";

/* ─── 参数（默认值对齐参考站面板截图） ─── */
const CONFIG = {
  width: 564,
  height: 228,
  gridW: 36,
  gridH: 40,
  gravity: 0.2,
  damping: 0.99,
  iterationsPerFrame: 5,
  compressFactor: 0.02,
  stretchFactor: 1.5,
  mouseSize: 5000,
  mouseStrength: 4,
  contain: false,
  chimes: true,
  chimeVolume: 0.28,
  collection: "all",
  /* 过桥行人 */
  pedCount: 3,
  pedDuration: 10,
  pedFadeIn: 1.2,
  pedFadeOut: 0.9,
  pedGapMin: 1,
  pedGapMax: 4
};

/* ─── 场景几何 ─── */
const SCENE_W = 720;
const PAD = 300; // 布帘画布四周留白（摆动不裁切）
const BRIDGE_H = 211;
const CLOTH_GAP = -14; // 负值：诗帘顶端伸入桥图水面之下，水盖住一点点字

const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const bgImg = document.getElementById("bgImg");
const scene = document.getElementById("scene");
const hudFill = document.getElementById("hudFill");

let rafID = 0;
let input = null;
let constraintsArr = [];
let pedestrians = null;

function isUiEvent(e) {
  return !!(
    e.target?.closest?.("#panel") ||
    e.target?.closest?.(".topbar") ||
    e.target?.closest?.(".about") ||
    e.target?.closest?.(".bottom-copy") ||
    e.target?.closest?.(".hud")
  );
}

/* ─── 物理（Verlet 布帘，移植自 marinabudarina/chimes，其物理源自 Liam Egan CodePen） ─── */
class Vec2 {
  constructor(x = 0, y = 0) {
    this.reset(x, y);
  }
  zero() {
    this.reset(0, 0);
  }
  reset(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  clone() {
    return new Vec2(this.x, this.y);
  }
  add(v) {
    this.x += v.x;
    this.y += v.y;
    return this;
  }
  subtract(v) {
    this.x -= v.x;
    this.y -= v.y;
    return this;
  }
  subtractNew(v) {
    return this.clone().subtract(v);
  }
  get lengthSquared() {
    return this.x ** 2 + this.y ** 2;
  }
  get length() {
    return Math.hypot(this.x, this.y);
  }
  get angle() {
    return Math.atan2(this.y, this.x);
  }
}

class Particle {
  constructor({ x, y, pinned, id, char } = {}) {
    this.pos = new Vec2(x, y);
    this.oldPos = new Vec2(x, y);
    this.velocity = new Vec2();
    this.acceleration = new Vec2();
    this.pinned = pinned;
    this.id = id;
    this.char = char;
    this.gravityVec = new Vec2();
  }
  contain() {
    if (this.pinned) return;
    const radius = 4;
    if (this.pos.x < radius) {
      this.pos.x = radius;
      this.oldPos.x = this.pos.x + Math.abs(this.oldPos.x - this.pos.x) * 0.8;
    } else if (this.pos.x > CONFIG.width - radius) {
      this.pos.x = CONFIG.width - radius;
      this.oldPos.x = this.pos.x - Math.abs(this.oldPos.x - this.pos.x) * 0.8;
    }
    if (this.pos.y < radius) {
      this.pos.y = radius;
      this.oldPos.y = this.pos.y + Math.abs(this.oldPos.y - this.pos.y) * 0.8;
    } else if (this.pos.y > CONFIG.height - radius) {
      this.pos.y = CONFIG.height - radius;
      this.oldPos.y = this.pos.y - Math.abs(this.oldPos.y - this.pos.y) * 0.8;
    }
  }
  update(delta) {
    if (this.pinned) {
      this.acceleration.zero();
      return;
    }
    this.velocity.reset(
      (this.pos.x - this.oldPos.x) * CONFIG.damping,
      (this.pos.y - this.oldPos.y) * CONFIG.damping
    );
    this.oldPos.reset(this.pos.x, this.pos.y);
    const dd = delta ** 2;
    this.gravityVec.reset(0, CONFIG.gravity / dd);
    this.applyForce(this.gravityVec);
    this.pos.x += this.velocity.x + this.acceleration.x * dd;
    this.pos.y += this.velocity.y + this.acceleration.y * dd;
    this.acceleration.reset();
  }
  applyForce(v) {
    this.acceleration.add(v);
  }
}

class Constraint {
  constructor({ p1, p2, length, id, compressFactor, stretchFactor, isSpacer = false }) {
    this.p1 = p1;
    this.p2 = p2;
    this.length = length;
    this.id = id;
    this.isSpacer = isSpacer;
    this.compressFactor = compressFactor;
    this.stretchFactor = stretchFactor;
    this.minLength = length * compressFactor;
    this.maxLength = length * stretchFactor;
  }
  solve() {
    const dx = this.p2.pos.x - this.p1.pos.x;
    const dy = this.p2.pos.y - this.p1.pos.y;
    const distance = Math.hypot(dx, dy);
    if (distance === 0) return;

    let targetLength = this.length;
    if (distance < this.minLength) targetLength = this.minLength;
    else if (distance > this.maxLength) targetLength = this.maxLength;
    else return;

    const percent = (targetLength - distance) / distance / 2;
    const offsetX = dx * percent;
    const offsetY = dy * percent;

    if (!this.p1.pinned) {
      this.p1.pos.x -= offsetX;
      this.p1.pos.y -= offsetY;
    }
    if (!this.p2.pinned) {
      this.p2.pos.x += offsetX;
      this.p2.pos.y += offsetY;
    }
  }
}

function updateConstraintRanges() {
  for (const k of constraintsArr) {
    if (k.isSpacer) continue;
    k.minLength = k.length * CONFIG.compressFactor;
    k.maxLength = k.length * CONFIG.stretchFactor;
  }
}

function sizeCanvas(canvas, cssW, cssH) {
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
}

const FONT =
  '"迫真打字油印体", "Songti SC", "STSong", "SimSun", serif';

function main() {
  const width = CONFIG.width;
  const height = CONFIG.height;
  const { gridW, gridH, iterationsPerFrame, compressFactor, stretchFactor } = CONFIG;
  const cellWidth = width / (gridW - 1);
  const cellHeight = height / (gridH - 1);
  const root = document.getElementById("container");
  const canvasW = SCENE_W + PAD * 2;
  const canvasH = height + PAD * 2;
  const fontSize = Math.max(9, Math.min(14, cellHeight * 0.95));
  const roofClearance = Math.ceil(fontSize * 0.7);
  const originX = PAD + (SCENE_W - width) / 2;
  const originY = PAD + roofClearance;

  const fullCode = clothText(CONFIG.collection);
  const charCanvases = {};
  for (const ch of new Set(fullCode)) {
    if (ch === " " || ch === "　") continue;
    const size = Math.ceil(fontSize * 1.35);
    const off = document.createElement("canvas");
    off.width = Math.ceil(size * dpr);
    off.height = Math.ceil(size * dpr);
    off._size = size;
    const octx = off.getContext("2d");
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.font = `400 ${fontSize}px ${FONT}`;
    octx.textAlign = "center";
    octx.textBaseline = "middle";
    octx.fillStyle = "#241f18";
    octx.fillText(ch, size / 2, size / 2);
    charCanvases[ch] = off;
  }

  const c = document.createElement("canvas");
  root.innerHTML = "";
  root.appendChild(c);
  sizeCanvas(c, canvasW, canvasH);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const particles = [];
  constraintsArr = [];
  input = new Input({ c, particles, originX, originY, canvasW, canvasH });

  for (let i = 0; i < gridW; i++) {
    for (let j = 0; j < gridH; j++) {
      const x = i * cellWidth;
      const y = j * cellHeight;
      const id = getPointID(j, i, gridH);
      const pinned = j === 0;
      const char = charForCell(fullCode, i, j, gridW, gridH, "vertical");
      particles.push(new Particle({ x, y, pinned, id, char }));
    }
  }

  for (let i = 0; i < gridW; i++) {
    for (let j = 0; j < gridH; j++) {
      const id = getPointID(j, i, gridH);
      const p = particles[id];

      if (j < gridH - 1) {
        const bottomP = particles[getPointID(j + 1, i, gridH)];
        const constraint = new Constraint({
          p1: p,
          p2: bottomP,
          length: cellHeight,
          id: id + gridW * gridH,
          compressFactor,
          stretchFactor
        });
        constraintsArr.push(constraint);
        p.downConstraint = constraint;
      }

      if (i < gridW - 1) {
        const rightP = particles[getPointID(j, i + 1, gridH)];
        constraintsArr.push(
          new Constraint({
            p1: p,
            p2: rightP,
            length: cellWidth,
            id: id + gridW * gridH * 2,
            compressFactor: 0.6,
            stretchFactor: 4,
            isSpacer: true
          })
        );
      }
    }
  }

  function drawCode() {
    for (const p of particles) {
      if (!p.char || p.char === " " || p.char === "　") continue;
      const img = charCanvases[p.char];
      if (!img) continue;

      let cos = 1;
      let sin = 0;
      const constraint = p.downConstraint;
      if (constraint) {
        const dx = constraint.p2.pos.x - constraint.p1.pos.x;
        const dy = constraint.p2.pos.y - constraint.p1.pos.y;
        const angle = Math.atan2(dy, dx) - Math.PI / 2;
        cos = Math.cos(angle);
        sin = Math.sin(angle);
      }

      const size = img._size;
      const half = size / 2;
      const x = p.pos.x + originX;
      const y = p.pos.y + originY;
      ctx.setTransform(cos * dpr, sin * dpr, -sin * dpr, cos * dpr, x * dpr, y * dpr);
      ctx.drawImage(img, -half, -half, size, size);
    }
  }

  let lastDelta = performance.now();
  function runloop(delta) {
    rafID = requestAnimationFrame(runloop);
    const dt = Math.min(32, Math.max(1, delta - lastDelta));
    lastDelta = delta;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvasW, canvasH);

    for (const p of particles) p.update(dt);
    for (let i = 0; i < iterationsPerFrame; i++) {
      for (let j = 0; j < constraintsArr.length; j++) constraintsArr[j].solve();
    }
    if (CONFIG.contain) for (const p of particles) p.contain();

    drawCode();
  }

  rafID = requestAnimationFrame(runloop);
}

class Input {
  constructor({ c, particles, originX, originY, canvasW, canvasH }) {
    this.c = c;
    this.particles = particles;
    this.originX = originX;
    this.originY = originY;
    this.canvasW = canvasW;
    this.canvasH = canvasH;
    this.mousePos = new Vec2();
    this.grabRadius = 24;
    this.chimeRadiusSq = 55 * 55;
    this.grabbedParticle = null;
    this.bind();
  }
  localPoint(e) {
    const rect = this.c.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * this.canvasW - this.originX,
      y: ((e.clientY - rect.top) / rect.height) * this.canvasH - this.originY
    };
  }
  pointerdown(e) {
    if (inputLocked()) {
      this.pointerup(e);
      return;
    }
    if (isUiEvent(e)) return;
    const { x, y } = this.localPoint(e);
    this.mousePos.reset(x, y);
    for (const p of this.particles) {
      if (this.mousePos.subtractNew(p.pos).length < this.grabRadius) {
        this.grabbedParticle = p;
        this.grabbedParticle.originalPinnedState = this.grabbedParticle.pinned;
        this.grabbedParticle.pinned = true;
        chimes.strike({
          x,
          y,
          particle: p,
          gridW: CONFIG.gridW,
          intensity: 0.85,
          force: true
        });
        break;
      }
    }
  }
  pointerup(e) {
    if (isUiEvent(e) && !this.grabbedParticle) return;
    if (this.grabbedParticle) {
      this.grabbedParticle.pinned = this.grabbedParticle.originalPinnedState;
      this.grabbedParticle = null;
    }
  }
  pointermove(e) {
    if (inputLocked()) {
      this.pointerup(e);
      return;
    }
    if (isUiEvent(e) && !this.grabbedParticle) return;
    const { x, y } = this.localPoint(e);
    this.mousePos.reset(x, y);

    if (this.grabbedParticle) {
      this.grabbedParticle.pos.reset(x, y);
      this.grabbedParticle.oldPos.reset(x, y);
    }

    let nearest = null;
    let nearestLs = Infinity;

    for (const p of this.particles) {
      const diff = this.mousePos.subtractNew(p.pos);
      const ls = diff.lengthSquared;
      if (ls < CONFIG.mouseSize) {
        const a = diff.angle - Math.PI;
        const strength = (smoothstep(CONFIG.mouseSize, -2000, ls) * CONFIG.mouseStrength) / 300;
        p.applyForce(new Vec2(Math.cos(a) * strength, Math.sin(a) * strength));
      }
      if (ls < this.chimeRadiusSq && ls < nearestLs) {
        nearest = p;
        nearestLs = ls;
      }
    }

    if (nearest) {
      const closeness = 1 - nearestLs / this.chimeRadiusSq;
      chimes.strike({
        x,
        y,
        particle: nearest,
        gridW: CONFIG.gridW,
        intensity: 0.2 + closeness * 0.7
      });
    } else {
      chimes.lastParticleId = -1;
    }
  }
  contextmenu(e) {
    e.preventDefault();
  }
  bind() {
    this.pointerdown = this.pointerdown.bind(this);
    this.pointerup = this.pointerup.bind(this);
    this.pointermove = this.pointermove.bind(this);
    this.contextmenu = this.contextmenu.bind(this);
    document.addEventListener("pointerdown", this.pointerdown);
    document.addEventListener("pointerup", this.pointerup);
    document.addEventListener("pointermove", this.pointermove);
    document.addEventListener("contextmenu", this.contextmenu);
  }
  unbind() {
    document.removeEventListener("pointerdown", this.pointerdown);
    document.removeEventListener("pointerup", this.pointerup);
    document.removeEventListener("pointermove", this.pointermove);
    document.removeEventListener("contextmenu", this.contextmenu);
  }
}

/* ─── 背景横展：滚轮驱动 t∈[0,1]，0=最右端（春郊起幅），1=最左端（汴城）；进度条自右向左填充 ─── */
let panTarget = 0;
let panCur = 0;
let paintingMode = false;

function inputLocked() {
  return paintingMode;
}
let bgW = 0;
let vw = window.innerWidth;

function measureBg() {
  vw = window.innerWidth;
  bgW = bgImg.offsetWidth || 0;
}

function sceneScale() {
  const s = Math.min(1, (vw - 24) / SCENE_W);
  scene.style.setProperty("--s", s);
}

function panLoop() {
  requestAnimationFrame(panLoop);
  const k = reduceMotion ? 1 : 1 - Math.exp(-0.016 * 3);
  panCur += (panTarget - panCur) * k;
  if (Math.abs(panTarget - panCur) < 0.0004) panCur = panTarget;
  const span = Math.max(1, bgW - vw);
  const tx = -(1 - panCur) * span;
  bgImg.style.transform = `translate3d(${tx.toFixed(1)}px, -50%, 0)`;
  hudFill.style.width = (panCur * 100).toFixed(2) + "%";
}

function setPan(t) {
  panTarget = Math.max(0, Math.min(1, t));
}

window.addEventListener(
  "wheel",
  (e) => {
    if (isUiEvent(e)) return;
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    setPan(panTarget + delta * 0.00045);
  },
  { passive: false }
);

window.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") setPan(panTarget - 0.04);
  if (e.key === "ArrowLeft") setPan(panTarget + 0.04);
});

/* 触屏横拖展卷（不在布帘/UI 上时） */
let touchPan = null;
window.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "touch") return;
  if (isUiEvent(e) || e.target.closest(".strings")) return;
  touchPan = { x: e.clientX, t: panTarget };
});
window.addEventListener("pointermove", (e) => {
  if (!touchPan || e.pointerType !== "touch") return;
  const span = Math.max(1, bgW - vw);
  setPan(touchPan.t - (e.clientX - touchPan.x) / span);
});
window.addEventListener("pointerup", () => (touchPan = null));

window.addEventListener("resize", () => {
  measureBg();
  sceneScale();
});

/* ─── 面板 ─── */
function rerender() {
  if (input) input.unbind();
  cancelAnimationFrame(rafID);
  main();
}

const panelApi = buildPanel({
  anchor: document.getElementById("panelAnchor"),
  config: CONFIG,
  onRebuild: rerender,
  onCollection: (id) => {
    CONFIG.collection = id;
    rerender();
  },
  onFeel: () => {
    chimes.setVolume(CONFIG.chimeVolume);
    chimes.enabled = CONFIG.chimes;
    updateConstraintRanges();
  }
});

const panelBtn = document.getElementById("panelBtn");
panelBtn.addEventListener("click", () => {
  const open = panelApi.panel.hidden;
  panelApi.setPanelOpen(open);
  panelBtn.setAttribute("aria-expanded", String(open));
});

/* ─── 展画卷 / 回诗帘 ─── */
const viewBtn = document.getElementById("viewBtn");
const scrollHint = document.querySelector(".scroll-hint");
function setPainting(on) {
  paintingMode = on;
  document.body.dataset.mode = on ? "painting" : "poem";
  viewBtn.textContent = on ? "回诗帘" : "展画卷";
  viewBtn.setAttribute("aria-pressed", String(on));
  if (on) {
    panelApi.setPanelOpen(false);
    panelBtn.setAttribute("aria-expanded", "false");
    if (!aboutModal.hidden) setAboutOpen(false);
  }
  /* 行人：展画卷整体淡出并冻结，回诗帘原样恢复（不重置 t，无跳变） */
  if (pedestrians) (on ? pedestrians.pause() : pedestrians.resume());
}
viewBtn.addEventListener("click", () => setPainting(!paintingMode));

/* ─── About ─── */
const aboutModal = document.getElementById("aboutModal");
const aboutBtn = document.getElementById("aboutBtn");
function setAboutOpen(open) {
  aboutModal.hidden = !open;
  aboutModal.setAttribute("aria-hidden", String(open));
  aboutBtn?.setAttribute("aria-expanded", String(open));
  if (open) document.getElementById("aboutClose")?.focus();
}
aboutBtn.addEventListener("click", (e) => {
  e.preventDefault();
  setAboutOpen(true);
});
document.getElementById("aboutClose").addEventListener("click", () => setAboutOpen(false));
aboutModal.querySelector(".about__backdrop").addEventListener("click", () => setAboutOpen(false));
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !aboutModal.hidden) setAboutOpen(false);
});

/* ─── 启动：等字体就绪再烘焙字符 ─── */
async function init() {
  measureBg();
  sceneScale();
  try {
    await document.fonts.load(`400 9px "迫真打字油印体"`);
  } catch (_) {
    /* 字体失败则用回退字体 */
  }
  main();
  requestAnimationFrame(panLoop);
  pedestrians = initPedestrians({
    container: document.getElementById("pedestrians"),
    config: CONFIG,
    reduceMotion
  });
  if (paintingMode) pedestrians.pause(); // 初始化晚于模式切换的兜底
}

bgImg.addEventListener("load", measureBg);
init();

/* 调试钩子（控制台可读） */
window.__qmsht = {
  config: CONFIG,
  getPan: () => panTarget,
  getPanCur: () => panCur,
  chimes,
  ped: () => (pedestrians ? pedestrians.debug() : null)
};
