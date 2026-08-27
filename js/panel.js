// 自绘控制面板（仿 marinabudarina/chimes 的 Tweakpane 布局：文件夹 + 方块滑杆 + 数字框）
import { COLLECTIONS } from "./poems.js";

const fmt = {
  int: (v) => String(Math.round(v)),
  f2: (v) => Number(v).toFixed(2),
  f3: (v) => Number(v).toFixed(3)
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function makeSlider(parent, { key, label, min, max, step, digits }) {
  const row = el("div", "prow");
  const lab = el("span", "plabel", label);
  const input = document.createElement("input");
  input.type = "range";
  input.min = min;
  input.max = max;
  input.step = step;
  input.value = parent[key];
  input.setAttribute("aria-label", label);
  const out = el("output", "pval", fmt[digits](parent[key]));
  row.append(lab, input, out);
  return { row, input, out };
}

export function buildPanel({ anchor, config, onRebuild, onCollection, onFeel }) {
  const panel = el("aside", "panel");
  panel.id = "panel";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "参数面板");

  panel.hidden = true;
  const head = el("header", "phead");
  const title = el("span", "ptitle", "音律");
  const headToggle = el("button", "pcollapse", "▾");
  headToggle.type = "button";
  headToggle.setAttribute("aria-expanded", "true");
  headToggle.setAttribute("aria-label", "折叠面板");
  head.append(title, headToggle);

  const body = el("div", "pbody");

  // ── 篇目 ──
  const f1 = el("section", "pfolder is-open");
  const f1h = el("h3", "pfolder-h", "篇目");
  const selWrap = el("div", "prow");
  const selLab = el("span", "plabel", "诗选");
  const sel = document.createElement("select");
  sel.setAttribute("aria-label", "诗选");
  for (const c of COLLECTIONS) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.label;
    sel.appendChild(o);
  }
  sel.value = config.collection || "all";
  selWrap.append(selLab, sel);
  f1.append(f1h, selWrap);
  body.appendChild(f1);
  sel.addEventListener("change", () => {
    config.collection = sel.value;
    onCollection(sel.value);
  });

  // ── 布帘 ──
  const f2 = el("section", "pfolder is-open");
  f2.appendChild(el("h3", "pfolder-h", "布帘"));
  const clothDefs = [
    { key: "width", label: "宽度", min: 100, max: 800, step: 1, digits: "int" },
    { key: "height", label: "高度", min: 80, max: 700, step: 1, digits: "int" },
    { key: "gridW", label: "列数", min: 2, max: 200, step: 1, digits: "int" },
    { key: "gridH", label: "行数", min: 2, max: 100, step: 1, digits: "int" }
  ];
  for (const d of clothDefs) {
    const { row, input, out } = makeSlider(config, d);
    input.addEventListener("input", () => {
      config[d.key] = Number(input.value);
      out.value = fmt[d.digits](config[d.key]);
    });
    input.addEventListener("change", onRebuild);
    f2.appendChild(row);
  }
  const rebuildBtn = el("button", "pbtn", "重建布帘");
  rebuildBtn.type = "button";
  rebuildBtn.addEventListener("click", onRebuild);
  f2.appendChild(rebuildBtn);
  body.appendChild(f2);

  // ── 动效与声音 ──
  const f3 = el("section", "pfolder is-open");
  f3.appendChild(el("h3", "pfolder-h", "动效与声音"));
  const feelDefs = [
    { key: "gravity", label: "重力", min: 0, max: 2, step: 0.05, digits: "f2" },
    { key: "damping", label: "阻尼", min: 0.5, max: 1.02, step: 0.001, digits: "f3" },
    { key: "iterationsPerFrame", label: "精度", min: 1, max: 20, step: 1, digits: "int" },
    { key: "stretchFactor", label: "拉伸", min: 1.0, max: 2.0, step: 0.01, digits: "f2" },
    { key: "compressFactor", label: "压缩", min: 0.01, max: 1.0, step: 0.01, digits: "f2" },
    { key: "mouseSize", label: "触碰半径", min: 100, max: 10000, step: 1, digits: "int" },
    { key: "mouseStrength", label: "触碰力度", min: 1, max: 10, step: 1, digits: "int" }
  ];
  for (const d of feelDefs) {
    const { row, input, out } = makeSlider(config, d);
    input.addEventListener("input", () => {
      config[d.key] = Number(input.value);
      out.value = fmt[d.digits](config[d.key]);
      onFeel();
    });
    f3.appendChild(row);
  }

  const chimeRow = el("div", "prow");
  const chimeChk = document.createElement("input");
  chimeChk.type = "checkbox";
  chimeChk.className = "pchk";
  chimeChk.checked = config.chimes;
  chimeChk.setAttribute("aria-label", "风铃");
  chimeChk.addEventListener("change", () => {
    config.chimes = chimeChk.checked;
  });
  chimeRow.append(el("span", "plabel", "风铃"), chimeChk);
  f3.appendChild(chimeRow);

  const vol = makeSlider(config, { key: "chimeVolume", label: "音量", min: 0, max: 1, step: 0.01, digits: "f2" });
  vol.input.addEventListener("input", () => {
    config.chimeVolume = Number(vol.input.value);
    vol.out.value = fmt.f2(config.chimeVolume);
    onFeel();
  });
  f3.appendChild(vol.row);

  const boundsRow = el("div", "prow");
  const boundsChk = document.createElement("input");
  boundsChk.type = "checkbox";
  boundsChk.className = "pchk";
  boundsChk.checked = config.contain;
  boundsChk.setAttribute("aria-label", "边界约束");
  boundsRow.append(el("span", "plabel", "边界约束"), boundsChk);
  f3.appendChild(boundsRow);
  body.appendChild(f3);

  panel.append(head, body);
  anchor.appendChild(panel);

  const setPanelOpen = (open) => {
    panel.hidden = !open;
    panelToggle?.setAttribute("aria-expanded", String(open));
  };
  let panelToggle = null;
  headToggle.addEventListener("click", () => {
    const open = head.getAttribute("aria-expanded") === "true";
    head.setAttribute("aria-expanded", String(!open));
    body.classList.toggle("is-collapsed", open);
    headToggle.textContent = open ? "▾" : "▸";
  });
  for (const f of [f1, f2, f3]) {
    f.querySelector(".pfolder-h").addEventListener("click", () => {
      f.classList.toggle("is-open");
    });
  }

  return {
    panel,
    setPanelOpen,
    get panelToggle() {
      return panelToggle;
    },
    setPanelToggle(btn) {
      panelToggle = btn;
    }
  };
}
