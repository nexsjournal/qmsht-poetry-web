import { smoothstep, getPointID, charForCell } from "./utils.js";
import { clothText } from "./poems.js";
import { chimes } from "./chimes.js";
import { buildPanel } from "./panel.js";

/* ─── 参数（默认值对齐参考站面板截图） ─── */
const CONFIG = {
  /* 布帘默认几何：字号 ≈11px（格子 10.3px），容量 50×32=1600 ≥ 最长集合 1570 字 */
  width: 600,
  height: 320,
  gridW: 50,
  gridH: 32,
  gravity: 0.2,
  damping: 0.99,
  iterationsPerFrame: 5,
  compressFactor: 0.02,
  stretchFactor: 1.08,
  mouseSize: 5000,
  mouseStrength: 4,
  contain: false,
  chimes: true,
  chimeVolume: 0.28,
  /* 诗帘篇目跟随场景：虹桥=清明·寒食，帆船=春江·烟柳（见 swapLayers） */
  collection: "qm"
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
  const fontSize = Math.max(11, Math.min(14, cellHeight * 0.95));
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
  let s = Math.min(1, (vw - 24) / SCENE_W);
  /* 高度预算：诗帘在重力下会垂落到约 stretchFactor+0.05 倍配置高度，
     按「顶栏padding + 底部文案实际占位」反算场景可用高度，
     不够时整体缩小场景（手机/短视口/大屏低窗口），0.3 为下限 */
  const stretch = Math.min(1.3, Math.max(1, CONFIG.stretchFactor + 0.05));
  const totalH = BRIDGE_H + CLOTH_GAP + CONFIG.height * stretch + 12;
  const areaPad = parseFloat(getComputedStyle(document.querySelector(".area")).paddingTop) || 0;
  const copyEl = document.querySelector(".bottom-copy");
  const copyBox = copyEl
    ? copyEl.offsetHeight + (parseFloat(getComputedStyle(copyEl).bottom) || 0)
    : 120;
  const avail = window.innerHeight - areaPad - copyBox - 8;
  if (totalH > avail) s = Math.min(s, Math.max(0.3, avail / totalH));
  scene.style.setProperty("--s", s);
}

/* 诗帘状态：背景自动慢移——从最右端（春郊起幅）缓慢移到最左端（汴城），
   再移回右端，循环往复；单向约 AUTO_PAN_MS（很慢）。
  展画卷状态同样自动移动；用户滚轮/方向键/横拖接管时以手动优先，
  停止操作 AUTO_RESUME_MS 后从当前位置继续自动滚动。 */
const AUTO_PAN_MS = 300000;
const AUTO_RESUME_MS = 3000;
let autoT = 0;
let autoDir = 1;
let lastPanTs = 0;
let lastManualTs = 0;

function panLoop(ts) {
  requestAnimationFrame(panLoop);
  if (lastPanTs) {
    const dt = Math.min(64, ts - lastPanTs);
    /* 诗帘态：始终自动；展画卷态：手动操作期间暂停，3 秒后从当前位置恢复 */
    if (!paintingMode || ts - lastManualTs > AUTO_RESUME_MS) {
      autoT += (autoDir * dt) / AUTO_PAN_MS;
      if (autoT >= 1) {
        autoT = 1;
        autoDir = -1;
      } else if (autoT <= 0) {
        autoT = 0;
        autoDir = 1;
      }
      panTarget = autoT;
    }
  }
  lastPanTs = ts;
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

/* 手动展卷（滚轮/方向键/横拖）：以手动位置为准，自动相位同步到当前位置，
   停止操作 AUTO_RESUME_MS 后自动滚动从这里继续，不跳变 */
function manualPan(t) {
  setPan(t);
  autoT = panTarget;
  lastManualTs = performance.now();
}

window.addEventListener(
  "wheel",
  (e) => {
    if (isUiEvent(e)) return;
    /* 诗帘状态背景自动慢移，滚轮仅展画卷状态可接管 */
    if (!paintingMode) return;
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    manualPan(panTarget + delta * 0.00045);
  },
  { passive: false }
);

window.addEventListener("keydown", (e) => {
  if (!paintingMode) return;
  if (e.key === "ArrowRight") manualPan(panTarget - 0.04);
  if (e.key === "ArrowLeft") manualPan(panTarget + 0.04);
});

/* 触屏横拖展卷（不在布帘/UI 上时） */
let touchPan = null;
window.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "touch") return;
  if (isUiEvent(e) || e.target.closest(".strings")) return;
  if (!paintingMode) return; // 诗帘状态背景自动慢移，横拖仅展画卷状态
  touchPan = { x: e.clientX, t: panTarget };
});
window.addEventListener("pointermove", (e) => {
  if (!touchPan || e.pointerType !== "touch") return;
  const span = Math.max(1, bgW - vw);
  manualPan(touchPan.t - (e.clientX - touchPan.x) / span);
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
  /* 布帘高度变化会影响场景总高（短视口下的缩放上限） */
  sceneScale();
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

/* 面板展开/收起时同步 body 类：右侧切换按钮让位到面板左边，永不被遮挡。
   用 MutationObserver 监听 hidden 属性（toggle 事件不响应程序化修改） */
new MutationObserver(() => {
  document.body.classList.toggle("panel-open", !panelApi.panel.hidden);
}).observe(panelApi.panel, { attributes: true, attributeFilter: ["hidden"] });

/* ─── 展画卷 / 回诗帘 ─── */
const viewBtn = document.getElementById("viewBtn");
const scrollHint = document.querySelector(".scroll-hint");

/* 展画卷背景音（汴河）：进入展画卷自动播放，回诗帘暂停（保留进度，再进续播） */
const bgm = new Audio("assets/bianhe.mp3");
bgm.loop = true;
bgm.volume = 0.5;

function setPainting(on) {
  paintingMode = on;
  document.body.dataset.mode = on ? "painting" : "poem";
  viewBtn.textContent = on ? "回诗帘" : "展画卷";
  viewBtn.setAttribute("aria-pressed", String(on));
  if (on) {
    /* 背景归位最右端（春郊起幅），随后自动慢移，用户滚动可随时接管 */
    panTarget = 0;
    autoT = 0;
    autoDir = 1;
    lastManualTs = 0;
    bgm.play().catch(() => {});
    panelApi.setPanelOpen(false);
    panelBtn.setAttribute("aria-expanded", "false");
    if (!aboutModal.hidden) setAboutOpen(false);
  } else {
    bgm.pause();
    /* 回诗帘：自动慢移从当前位置接续，不跳变 */
    autoT = panCur;
  }
}
viewBtn.addEventListener("click", () => setPainting(!paintingMode));

/* ─── 场景切换：左右双按钮常显，顺序循环 ────────────────────────
   （过渡仿 chimes 参考站：场景横滑离场 → 换图 → 反向滑入）
   顺序：虹桥 → 帆船 → 城楼 → 虹桥…（SCENE_ORDER，末页自动轮转回第一页）
   - 左按钮=上一张（新图从左侧进场），右按钮=下一张（新图从右侧进场），两边始终同时显示
   - 每张大图底部对齐同一基线（CSS 中各自 bottom 校准）
   - 每张图配自己的诗帘篇目
   新增图片：SCENE_ORDER 加一项 + SCENE_META 加一项 + HTML 加一层 + CSS 加一条基线，
   左右按钮与循环顺序自动适配。
────────────────────────────────────────────────────────────── */
const SWAP_MS = 780;
const SWAP_EASE = "cubic-bezier(0.42, 0, 1, 1)";
const SCENE_ORDER = ["bridge", "boat", "tower", "person"];
const SCENE_META = {
  bridge: { name: "虹桥", icon: "assets/selector-bridge.png", collection: "qm" },
  boat: { name: "帆船", icon: "assets/selector-boat.png", collection: "ch" },
  tower: { name: "城楼", icon: "assets/selector-tower.png", collection: "tq" },
  person: { name: "人物", icon: "assets/selector-person.png", collection: "all" }
};
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const prevBtnIcon = document.getElementById("prevBtnIcon");
const prevBtnLabel = document.getElementById("prevBtnLabel");
const nextBtnIcon = document.getElementById("nextBtnIcon");
const nextBtnLabel = document.getElementById("nextBtnLabel");
/* A/B 双缓冲图层：每张场景图在两层里各有一套，切换时旧层滑出、新层同时滑入 */
const SLIDE_KEYS = ["back", "boat", "tower", "person", "front", "shadow"];
const SLIDE_VIS = {
  bridge: ["back", "front", "shadow"],
  boat: ["boat"], // 船自带水面，不带地面阴影
  tower: ["tower", "shadow"],
  person: ["person", "shadow"]
};
function readSlide(el) {
  const s = { el };
  s.back = el.querySelector(".bridge__back");
  s.boat = el.querySelector(".bridge__boat");
  s.tower = el.querySelector(".bridge__tower");
  s.person = el.querySelector(".bridge__person");
  s.front = el.querySelector(".bridge-front");
  s.shadow = el.querySelector(".bridge-shadow");
  return s;
}
const slides = [
  readSlide(document.getElementById("slideA")),
  readSlide(document.getElementById("slideB"))
];
let activeSlide = 0;
function setLayer(slide, id) {
  const vis = SLIDE_VIS[id];
  for (const k of SLIDE_KEYS) slide[k].hidden = !vis.includes(k);
}
const bottomCopy = document.getElementById("bottomCopy");
let sceneIdx = 0;
let swapping = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 取第 i 个场景（负数/越界自动轮转） */
const sceneAt = (i) => SCENE_ORDER[((i % SCENE_ORDER.length) + SCENE_ORDER.length) % SCENE_ORDER.length];

/* 预加载全部图标与大图，切换时不闪白 */
[
  ...Object.values(SCENE_META).map((m) => m.icon),
  "assets/chenglou-web.png",
  "assets/renwu-web.png"
].forEach((src) => {
  const im = new Image();
  im.src = src;
});

/* 双按钮常显：左=上一张，右=下一张（循环） */
function updateNav() {
  const prevMeta = SCENE_META[sceneAt(sceneIdx - 1)];
  const nextMeta = SCENE_META[sceneAt(sceneIdx + 1)];
  prevBtnIcon.src = prevMeta.icon;
  prevBtnLabel.textContent = prevMeta.name;
  prevBtn.setAttribute("aria-label", `上一张：${prevMeta.name}`);
  nextBtnIcon.src = nextMeta.icon;
  nextBtnLabel.textContent = nextMeta.name;
  nextBtn.setAttribute("aria-label", `下一张：${nextMeta.name}`);
  document.body.dataset.scene = sceneAt(sceneIdx);
}

/* 新图走到一半时更新诗帘与按钮（每张图配自己的诗帘：qm/ch/tq/全卷） */
function swapCurtain() {
  const id = sceneAt(sceneIdx);
  document.body.dataset.scene = id;
  CONFIG.collection = SCENE_META[id].collection;
  panelApi.panel.querySelector("select").value = CONFIG.collection;
  rerender();
  updateNav();
}

async function goScene(delta) {
  if (swapping) return;
  swapping = true;
  prevBtn.disabled = true;
  nextBtn.disabled = true;
  const targetIdx = (sceneIdx + delta + SCENE_ORDER.length) % SCENE_ORDER.length;
  /* delta=+1（右按钮·下一张）：新图从右进场 → 旧层向左滑出（dir=-1）
     delta=-1（左按钮·上一张）：新图从左进场 → 旧层向右滑出（dir=+1）
     滑出距离按视口动态计算：场景半宽(360) + 视口半宽(场景坐标) + 余量，
     宽屏下场景居中、两侧有大片空白，固定值会残留旧图 */
  const dir = -delta;
  const s = Math.min(1, (vw - 24) / 720);
  const SLIDE_OUT = Math.ceil(360 + vw / (2 * s) + 60);
  const trans = `transform ${SWAP_MS}ms ${SWAP_EASE}`;
  const fromS = slides[activeSlide];
  const toS = slides[1 - activeSlide];

  /* 新图放入空闲层，置于进场侧屏外；旧层与新层同时滑动（重叠可见） */
  setLayer(toS, sceneAt(targetIdx));
  toS.el.style.visibility = "visible";
  fromS.el.style.transition = "none";
  toS.el.style.transition = "none";
  fromS.el.style.transform = "translateX(0px)";
  toS.el.style.transform = `translateX(${-SLIDE_OUT * dir}px)`;
  toS.el.style.zIndex = 6;

  bottomCopy.classList.add("is-dipping");
  void toS.el.offsetWidth;
  fromS.el.style.transition = trans;
  toS.el.style.transition = trans;
  fromS.el.style.transform = `translateX(${SLIDE_OUT * dir}px)`;
  toS.el.style.transform = "translateX(0px)";

  await sleep(SWAP_MS * 0.5);

  /* 新图走到一半：诗帘/按钮/场景数据同步切换 */
  sceneIdx = targetIdx;
  swapCurtain();

  await sleep(SWAP_MS * 0.5);
  fromS.el.style.zIndex = "";
  /* 旧层彻底隐藏：杜绝宽屏/缩放下任何残留 */
  fromS.el.style.visibility = "hidden";
  activeSlide = 1 - activeSlide;
  bottomCopy.classList.remove("is-dipping");
  swapping = false;
  prevBtn.disabled = false;
  nextBtn.disabled = false;
}
prevBtn.addEventListener("click", () => goScene(-1));
nextBtn.addEventListener("click", () => goScene(1));
updateNav();

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
}

bgImg.addEventListener("load", measureBg);
init();

/* 调试钩子（控制台可读） */
window.__qmsht = {
  config: CONFIG,
  getPan: () => panTarget,
  getPanCur: () => panCur,
  chimes,
  get sceneId() {
    return sceneAt(sceneIdx);
  },
  goScene,
  getBgm: () => ({ playing: !bgm.paused, time: bgm.currentTime, dur: bgm.duration })
};
