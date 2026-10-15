"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { chooseGrid, tileRect, moveInGrid } = require("../lib/layout");
const { parseAnsi } = require("../lib/ansi");
const { Screen, paintGrid, compactLines, drawTileFrame, paintStatus } = require("../lib/render");

test("layout follows the recommended table", () => {
  assert.deepEqual(chooseGrid(1, 200, 50), { cols: 1, rows: 1 });
  assert.deepEqual(chooseGrid(4, 200, 50), { cols: 2, rows: 2 });
});

test("wide viewports prefer more columns", () => {
  const wide = chooseGrid(8, 300, 40);
  const narrow = chooseGrid(8, 90, 50);
  assert.equal(wide.cols, 4);
  assert.ok(wide.cols > narrow.cols, `wide ${wide.cols} narrow ${narrow.cols}`);
});

test("tiles never smaller than usable", () => {
  const g = chooseGrid(10, 100, 30);
  assert.ok(g.cols * g.rows >= 10);
});

test("tileRect partitions the area", () => {
  const g = { cols: 3, rows: 2 };
  const rects = [0, 1, 2, 3, 4, 5].map((i) => tileRect(i, g, 0, 0, 120, 40));
  assert.equal(rects[0].x, 0);
  assert.equal(rects[1].x, 40);
  assert.equal(rects[3].y, 20);
  assert.equal(rects[5].x, 80);
  assert.equal(rects[5].y, 20);
});

test("1:1 painting anchors to the bottom-left like a terminal", () => {
  const screen = new Screen(20, 6);
  const grid = parseAnsi("ABCDEFGHIJ\nKLMNOPQRST");
  drawTileFrame(screen, { x: 0, y: 0, w: 20, h: 6 }, { label: "api", selected: false, active: false });
  paintGrid(screen, { x: 0, y: 0, w: 20, h: 6 }, grid, "crop");
  // content sits at the bottom of the inner area, starting at col 1
  assert.equal(screen.buf[3][1].ch, "A");
  assert.equal(screen.buf[4][1].ch, "K");
  assert.equal(screen.buf[4][10].ch, "T");
});

test("crop mode anchors the live tail to the bottom, 1:1 readable", () => {
  const screen = new Screen(12, 6);
  const lines = [];
  for (let y = 0; y < 10; y++) {
    lines.push(`ROW-${String(y).padStart(2, "0")}-AAAAAAAAAA`);
  }
  const grid = parseAnsi(lines.join("\n"));
  drawTileFrame(screen, { x: 0, y: 0, w: 12, h: 6 }, { label: "", selected: false, active: false });
  paintGrid(screen, { x: 0, y: 0, w: 12, h: 6 }, grid, "crop");
  // inner rows 1..4 show source rows 6..9 (the last four), unmodified text
  assert.equal(screen.buf[1][1].ch, "R");
  assert.equal(screen.buf[4][1].ch, "R");
  const row = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((x) => screen.buf[4][x].ch).join("");
  assert.ok(row.startsWith("ROW-09"), row);
});

test("fit mode still decimates when explicitly requested", () => {
  const screen = new Screen(20, 8);
  const lines = [];
  for (let y = 0; y < 30; y++) {
    lines.push("X".repeat(94));
  }
  const grid = parseAnsi(lines.join("\n"));
  drawTileFrame(screen, { x: 0, y: 0, w: 20, h: 8 }, { label: "", selected: false, active: false });
  paintGrid(screen, { x: 0, y: 0, w: 20, h: 8 }, grid, "fit");
  for (let y = 1; y < 7; y++) {
    for (let x = 1; x < 19; x++) {
      assert.equal(screen.buf[y][x].ch, "X");
    }
  }
});

test("flush emits only changed cells on the second frame", () => {
  const screen = new Screen(10, 3);
  screen.putText(0, 0, "hello");
  const f1 = screen.flush();
  assert.ok(f1.includes("hello"));
  screen.putText(0, 0, "jello");
  const f2 = screen.flush();
  assert.ok(f2.includes("j"));
  assert.ok(!f2.includes("h"));
  // recomposing the identical frame must not emit anything
  screen.putText(0, 0, "jello");
  const f3 = screen.flush();
  assert.equal(f3, null);
});

test("status text renders centred", () => {
  const screen = new Screen(20, 5);
  drawTileFrame(screen, { x: 0, y: 0, w: 20, h: 5 }, { label: "", selected: false, active: false });
  paintStatus(screen, { x: 0, y: 0, w: 20, h: 5 }, "Pane closed");
  const row = screen.buf[2].map((c) => c.ch).join("");
  assert.ok(row.includes("Pane closed"), row);
});

test("selected tiles use double-line border", () => {
  const screen = new Screen(12, 4);
  drawTileFrame(screen, { x: 0, y: 0, w: 12, h: 4 }, { label: "api", selected: true, active: false });
  assert.equal(screen.buf[0][0].ch, "╔");
  assert.equal(screen.buf[0][11].ch, "╗");
  assert.equal(screen.buf[3][0].ch, "╚");
});

test("arrow keys move through the grid", () => {
  // 2x2 grid with 4 tiles: 0 1 / 2 3
  assert.equal(moveInGrid(0, 4, 2, 0, 1), 2); // down
  assert.equal(moveInGrid(2, 4, 2, 0, -1), 0); // up
  assert.equal(moveInGrid(2, 4, 2, 0, 1), 0); // down wraps to the top
  assert.equal(moveInGrid(1, 4, 2, 0, -1), 3); // up wraps to the bottom
  assert.equal(moveInGrid(1, 4, 2, 1, 0), 2); // right continues on the next row
  assert.equal(moveInGrid(0, 4, 2, -1, 0), 3); // left wraps to the last tile
});

test("arrow keys handle a partly filled last row", () => {
  // 3 tiles in a 2x2 grid: 0 1 / 2 _
  assert.equal(moveInGrid(1, 3, 2, 0, 1), 2); // down into the gap lands on the last tile
  assert.equal(moveInGrid(1, 3, 2, 0, -1), 1); // up from the gap column stays in it
  assert.equal(moveInGrid(0, 3, 2, 0, -1), 2);
  assert.equal(moveInGrid(0, 1, 1, 0, 1), 0); // single tile
});

const lineText = (cells) => cells.map((c) => c.ch).join("");

test("compact view collapses blank rows and trims the edges", () => {
  const grid = parseAnsi("\n\nfirst\n\n\n\nsecond   \n\n");
  assert.deepEqual(compactLines(grid, 20).map(lineText), ["first", "", "second"]);
});

test("compact view wraps long lines but cuts rules", () => {
  const grid = parseAnsi("abcdefghij\n" + "─".repeat(30));
  assert.deepEqual(compactLines(grid, 4).map(lineText), ["abcd", "efgh", "ij", "────"]);
});

test("compact painting shows the live tail of the wrapped lines", () => {
  const screen = new Screen(8, 4);
  paintGrid(screen, { x: 0, y: 0, w: 8, h: 4 }, parseAnsi("one\n\n\ntwo\nthree"), "compact");
  assert.equal(lineText(screen.buf[1].slice(1, 7)).trimEnd(), "two");
  assert.equal(lineText(screen.buf[2].slice(1, 7)).trimEnd(), "three");
});

test("agent state colours the tile border", () => {
  const screen = new Screen(10, 4);
  drawTileFrame(screen, { x: 0, y: 0, w: 10, h: 4 }, { label: "", selected: false, active: false, status: "blocked" });
  assert.deepEqual(screen.buf[1][0].fg, { kind: "ansi", n: 1 });
});

test("compact view wraps at word boundaries", () => {
  const grid = parseAnsi("the quick brown fox");
  assert.deepEqual(compactLines(grid, 10).map(lineText), ["the quick", "brown fox"]);
});

test("agent state shows as a sidebar-style dot before the label", () => {
  const screen = new Screen(30, 4);
  drawTileFrame(screen, { x: 0, y: 0, w: 30, h: 4 }, { label: "api", selected: false, active: false, status: "done" });
  assert.equal(screen.buf[0][3].ch, "●");
  assert.deepEqual(screen.buf[0][3].fg, { kind: "ansi", n: 6 });
  assert.equal(lineText(screen.buf[0].slice(5, 8)), "api");
});
