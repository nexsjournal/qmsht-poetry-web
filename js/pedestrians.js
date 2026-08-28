/* 过桥行人：状态机（waiting/walk）+ 桥面弧线路径 + 淡入淡出 + 对象池。
   路径（.scene 坐标系，t∈[0,1]，0=左端 1=右端，实测 hongqiao-web.png 栏杆底）：
     x(t) = 54 + 612t
     y(t) = 24 + 70·(2t−1)²
   行人为 DOM <img> 精灵：transform/opacity 走合成器，不碰诗帘 canvas。 */

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
  const cfg = config;
  const SPRITES = [1, 2, 3, 4].map((i) => ({ src: `assets/pedestrians/ped${i}.png`, ok: false, settled: false }));
  SPRITES.forEach((s) => {
    const im = new Image();
    im.onload = () => {
      s.ok = true;
      s.settled = true;
    };
    im.onerror = () => (s.settled = true); // 素材缺失：静默缺席，不阻塞启动
    im.src = s.src;
  });

  const peds = []; // 全部行人对象（含等待重生者），对象池
  let raf = 0;
  let running = false;
  let paused = false;
  let last = 0;
  let clock = 0; // 模块内累计时间（ms），暂停不推进 → 恢复无跳变

  const allSettled = () => SPRITES.every((s) => s.settled);
  const goodSprites = () => SPRITES.filter((s) => s.ok);
  const pickGood = () => {
    const g = goodSprites();
    return g.length ? g[(Math.random() * g.length) | 0] : null;
  };

  function pathPoint(t) {
    const u = 2 * t - 1;
    return { x: 54 + 612 * t, y: 24 + 70 * u * u };
  }

  function makePed() {
    const el = document.createElement("img");
    el.className = "ped";
    el.setAttribute("aria-hidden", "true");
    el.style.opacity = "0";
    container.appendChild(el);
    return {
      el,
      state: "waiting",
      dir: Math.random() < 0.5 ? 1 : -1,
      imgIdx: 0,
      scale: rand(0.9, 1.05),
      t: 0,
      duration: cfg.pedDuration * 1000 * rand(0.8, 1.3), // 过桥 8~14s/人
      spawnAt: 0,
      bobPhase: Math.random() * Math.PI * 2
    };
  }

  function opacityAt(p) {
    const d = p.duration;
    const inStart = 0.05;
    const inEnd = Math.min(0.3, inStart + (cfg.pedFadeIn * 1000) / d);
    const outEnd = 0.98;
    const outStart = Math.max(0.7, outEnd - (cfg.pedFadeOut * 1000) / d);
    const t = p.t;
    if (t < inStart || t >= outEnd) return 0;
    if (t < inEnd) return easeInOut((t - inStart) / (inEnd - inStart));
    if (t > outStart) return 1 - easeInOut((t - outStart) / (outEnd - outStart));
    return 1;
  }

  function scheduleRespawn(p) {
    p.state = "waiting";
    p.spawnAt = clock + rand(cfg.pedGapMin, cfg.pedGapMax) * 1000;
  }

  function trySpawn(p) {
    const activeCount = peds.filter((q) => q.state !== "waiting").length;
    if (activeCount >= cfg.pedCount) return;
    const sprite = pickGood();
    if (!sprite) return; // 素材全缺失：静默不生成
    p.state = "walk";
    p.t = 0;
    p.dir = Math.random() < 0.5 ? 1 : -1; // 换方向
    p.imgIdx = SPRITES.indexOf(sprite); // 换人
    p.scale = rand(0.9, 1.05);
    p.duration = cfg.pedDuration * 1000 * rand(0.8, 1.3);
    p.el.src = sprite.src;
    p.el.style.transform = `translate(0px, 0px) translate(-50%, -100%) scaleX(${p.dir}) scale(${p.scale})`;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(48, now - last);
    last = now;
    clock += dt;

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
      const op = opacityAt(p);
      const { x, y } = pathPoint(p.t);
      const bob = Math.sin((clock / 1000) * Math.PI * 2 * 2 + p.bobPhase) * 0.5; // ~2Hz 步态 bob
      p.el.style.opacity = op.toFixed(3);
      p.el.style.transform = `translate(${x.toFixed(2)}px, ${(y + bob).toFixed(2)}px) translate(-50%, -100%) scaleX(${p.dir}) scale(${p.scale})`;
    }
  }

  function start() {
    if (running || reduceMotion) return;
    if (!allSettled()) {
      // 素材未就绪时延迟重试
      setTimeout(start, 300);
      return;
    }
    if (goodSprites().length === 0) return; // 素材全缺失：行人静默缺席
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
          img: p.imgIdx + 1,
          opacity: p.el.style.opacity,
          x: +pt.x.toFixed(2),
          y: +pt.y.toFixed(2)
        };
      })
  };
}
