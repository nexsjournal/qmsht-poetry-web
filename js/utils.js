export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function getPointID(row, col, gridH) {
  return col * gridH + row;
}

/** 竖排右起取字：第 i 列（0=最左）、第 j 行（0=顶），越界取模。 */
export function charForCell(text, i, j, gridW, gridH, writing = "vertical") {
  if (!text || !text.length) return " ";
  let index;
  if (writing === "vertical") {
    const colFromRight = gridW - 1 - i;
    index = colFromRight * gridH + j;
  } else {
    index = j * gridW + i;
  }
  return text[index % text.length] || " ";
}
