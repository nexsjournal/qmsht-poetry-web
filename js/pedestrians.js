/* 过桥行人：状态机（waiting/walk）+ 桥面弧线路径 + 4 帧步行循环 + 淡入淡出 + 对象池。
   路径（.scene 坐标系，t∈[0,1]，0=左端 1=右端，实测 hongqiao-web.png 桥面顶板）：
     x(t) = 54 + 612t
     y(t) = 33.5 + 67.8·(2t−1)²
   精灵为 4 帧淡彩步行循环（朝右），~150ms 换帧；朝左行走时 scaleX(-1)。
   图层：桥后层(z3) < 行人(z4) < 近侧栏杆前层(z5)，栏杆自然遮挡腿部。
   transform/opacity/src 更新均不触发布局，开销可忽略。 */

const CHARACTERS = [
  ["ped1_f0.png", "ped1_f1.png", "ped1_f2.png", "ped1_f3.png"],
  ["ped2_f0.png", "ped2_f1.png", "ped2_f2.png", "ped2_f3.png"],
  ["ped3_f0.png", "ped3_f1.png", "ped3_f2.png", "ped3_f3.png"],
  ["ped4_f0.png", "ped4_f1.png", "ped4_f2.png", "ped4_f3.png"]
];

function rand(a, b) {
  return a + Math.random() * (b - a);
}
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function easeInOut(t) {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

export function initPedestrians({ container, config, reduceMotion }) {
  if (!container) return { pause() {}, resume() {}, destroy() {}, debug: () => [] };
  if (reduceMotion) return { pause() {}, resume() {}, destroy() {}, debug: () => [] };

  const cfg = config;
  /* ── 素材预加载：4 角色 × 4 帧 ── */
  const FRAMES = CHARACTERS.map((names) => {
    const list = names.map((n) => ({
      src: `assets/pedestrians/${n}`,
      ok: false,
      settled: false
    }));
    list.forEach((s) => {
      const im = new Image();
      im.onload = () => {
        s.ok = true;
        s.settled = true;
      };
      im.onerror = () => (s.settled = true);
      im.src = s.src;
    });
    return list;
  });
  const allSettled = () => FRAMES.every((f) => f.every((s) => s.settled));
  const goodChars = () => FRAMES.map((f, i) => (f.every((s) => s.ok) ? i : -1)).filter((i) => i >= 0);

  /* ── 路径（.scene 坐标） ── */
  const X0 = 54;
  const X1 = 666;
  const Y_ARCH = 33.5; // 拱顶桥面
  const Y_DROP = 67.8; // 两端相对拱顶下坠
  function pathPoint(t) {
    const u = 2 * t - 1;
    return { x: X0 + (X1 - X0) * t, y: Y_ARCH + Y_DROP * u * u };
  }

  const peds = []; // 行人对象池
  let raf = 0;
  let running = false;
  let paused = false;
  let last = 0;
  let clock = 0; // 模块时间轴（ms），暂停时冻结 → 恢复无跳变
  let frameIdx = 0; // 全局步态帧号（4 帧循环）
  const FRAME_MS = 150;

  function makePed() {
    const el = document.createElement("img");
    el.className = "ped";
    el.setAttribute("aria-hidden", "true");
    el.style.opacity = "0";
    container.appendChild(el);
    return {
      el,
      state: "waiting",
      dir: 1,
      charIdx: 0,
      t: 0,
      duration: cfg.pedDuration * 1000,
      scale: 1,
      spawnAt: 0
    };
  }

  function opacityAt(p) {
    const d = p.duration;
    const inStart = 0.05; // 脚踏上桥端 5% 后开始淡入（不凭空弹出）
    const inEnd = Math.min(0.3, inStart + (cfg.pedFadeIn * 1000) / d);
    const outEnd = 0.98;
    const outStart = Math.max(0.7, outEnd - (cfg.pedFadeOut * 1000) / d);
    const t = p.t;
    if (t < inStart || t >= outEnd) return 0;
    if (t < inEnd) return easeInOut((t - inStart) / (inEnd - inStart));
    if (t > outStart) return 1 - easeInOut((t - outStart) / (outEnd - outStart));
    return 1;
  }

  function trySpawn(p) {
    if (peds.filter((q) => q.state !== "waiting").length >= cfg.pedCount) return;
    const chars = goodChars();
    if (!chars.length) return; // 素材全缺失：静默不生成
    p.state = "walk";
    p.t = 0;
    p.dir = Math.random() < 0.5 ? 1 : -1; // 换方向（精灵朝右，dir=-1 时水平翻转）
    p.charIdx = chars[(Math.random() * chars.length) | 0]; // 换人
    p.scale = rand(0.92, 1.05); // 微缩放
    p.duration = cfg.pedDuration * 1000 * rand(0.8, 1.3); // 过桥 8~14s/人
    p.el.src = FRAMES[p.charIdx][frameIdx].src;
    render(p);
  }

  function scheduleRespawn(p) {
    p.state = "waiting";
    p.spawnAt = clock + rand(cfg.pedGapMin, cfg.pedGapMax) * 1000;
  }

  function render(p) {
    const { x, y } = pathPoint(p.t);
    p.el.style.opacity = opacityAt(p).toFixed(3);
    // 精灵脚底中心对齐路径点；dir=-1 朝左翻转
    p.el.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) translate(-50%, -100%) scaleX(${p.dir}) scale(${p.scale.toFixed(3)})`;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(48, now - last);
    last = now;
    clock += dt;
    frameIdx = Math.floor(clock / FRAME_MS) % 4;

    for (const p of peds) {
      if (p.state === "waiting") {
        if (clock >= p.spawnAt) trySpawn(p);
        continue;
      }
      p.t += dt / p.duration;
      if (p.t >= 0.98) {
        scheduleRespawn(p);
        p.el.style.opacity = "0";
        continue;
      }
      const src = FRAMES[p.charIdx][frameIdx].src;
      if (p.el.src !== src) p.el.src = src; // ~150ms 换帧（浏览器缓存，无解码成本）
      render(p);
    }
  }

  function start() {
    if (running) return;
    if (!allSettled()) {
      setTimeout(start, 300);
      return;
    }
    if (!goodChars().length) return; // 素材全缺失：行人静默缺席
    running = true;
    last = performance.now();
    for (let i = 0; i < cfg.pedCount; i++) {
      const p = makePed();
      p.spawnAt = i * 1400 + rand(0, 800); // 错峰上桥
      peds.push(p);
    }
    raf = requestAnimationFrame(frame);
  }

  function pause() {
    if (paused || !running) return;
    paused = true;
    cancelAnimationFrame(raf);
    container.classList.add("pedestrians--paused");
  }

  function resume() {
    if (!paused || !running) return;
    paused = false;
    container.classList.remove("pedestrians--paused");
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function destroy() {
    cancelAnimationFrame(raf);
    running = false;
    for (const p of peds) p.el.remove();
    peds.length = 0;
  }

  start();

  return {
    pause,
    resume,
    destroy,
    debug: () =>
      peds.map((p) => {
        const pt = pathPoint(p.t);
        return {
          state: p.state,
          dir: p.dir,
          t: +p.t.toFixed(3),
          char: p.charIdx + 1,
          frame: frameIdx,
          opacity: p.el.style.opacity,
          x: +pt.x.toFixed(2),
          y: +pt.y.toFixed(2)
        };
      })
  };
}
