"use strict";

/**
 * Grid layout chooser.
 *
 * Candidate layouts are constrained by the recommended table; the aspect
 * ratio of the available area decides between wide/narrow variants and picks
 * the candidate whose tiles best match a terminal's typical cell aspect
 * (source cols : rows vs tile cols : rows, with cells ~2x taller than wide).
 */

/** recommended candidates per space count, ordered wide-screen first */
const CANDIDATES = {
  1: [[1, 1]],
  2: [[2, 1], [1, 2]],
  3: [[2, 2], [1, 3], [3, 1]],
  4: [[2, 2], [4, 1], [1, 4]],
  5: [[3, 2], [2, 3]],
  6: [[3, 2], [2, 3]],
  7: [[3, 3], [4, 2], [2, 4]],
  8: [[4, 2], [3, 3], [2, 4]],
  9: [[3, 3]],
};

/** typical terminal cell aspect: width/height of one character cell */
const CELL_ASPECT = 0.5;

/**
 * @param {number} n number of tiles
 * @param {number} areaW overview width in cells
 * @param {number} areaH overview height in cells
 * @param {number} [sourceAspect] average mirrored viewport aspect (cols/rows)
 * @returns {{cols:number, rows:number}}
 */
function chooseGrid(n, areaW, areaH, sourceAspect = (94 * CELL_ASPECT) / 30) {
  const cands = CANDIDATES[n] || [[Math.ceil(Math.sqrt(n)), Math.ceil(n / Math.ceil(Math.sqrt(n)))]];
  let best = null;
  let bestScore = Infinity;
  for (const [cols, rows] of cands) {
    const tileW = areaW / cols;
    const tileH = areaH / rows;
    if (tileW < 10 || tileH < 6) continue; // unusably small tiles
    // pixel-ish aspect of a tile compared to the source viewport aspect
    const tileAspect = (tileW * CELL_ASPECT) / tileH;
    // prefer layouts that use the space (fewer empty slots) and match aspect
    const wasted = cols * rows - n;
    const aspectErr = Math.abs(Math.log(tileAspect / sourceAspect));
    const score = aspectErr + wasted * 0.12;
    if (score < bestScore) {
      bestScore = score;
      best = { cols, rows };
    }
  }
  return best || { cols: 1, rows: n };
}

/**
 * Tile rectangle for index i in a grid, with gutter/border accounting.
 * @returns {{x:number,y:number,w:number,h:number}}
 */
function tileRect(i, grid, areaX, areaY, areaW, areaH) {
  const col = i % grid.cols;
  const row = Math.floor(i / grid.cols);
  const w = Math.floor(areaW / grid.cols);
  const h = Math.floor(areaH / grid.rows);
  return { x: areaX + col * w, y: areaY + row * h, w, h };
}

/**
 * Arrow-key navigation in a row-major grid of n tiles. Left/right step
 * through the tiles in reading order, up/down move one row within the same
 * column. Both wrap around; moving down into a gap of a partly filled last
 * row lands on the last tile.
 * @returns {number} the new tile index
 */
function moveInGrid(idx, n, cols, dx, dy) {
  if (n <= 0) return 0;
  cols = Math.max(1, Math.min(cols, n));
  if (dx) return (idx + dx + n) % n;
  if (!dy) return idx;
  const lastRow = Math.floor((n - 1) / cols);
  const row = Math.floor(idx / cols);
  const col = idx % cols;
  if (dy > 0) {
    if (idx + cols < n) return idx + cols;
    return row < lastRow ? n - 1 : col;
  }
  if (idx - cols >= 0) return idx - cols;
  const bottom = lastRow * cols + col;
  return bottom < n ? bottom : Math.max(0, bottom - cols);
}

module.exports = { chooseGrid, tileRect, moveInGrid, CANDIDATES, CELL_ASPECT };
