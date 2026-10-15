"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { parseAnsi } = require("../lib/ansi");

function cellAt(parsed, x, y) {
  return parsed.cells[y][x];
}

test("plain text fills the grid", () => {
  const p = parseAnsi("hello\nworld");
  assert.equal(p.rows, 2);
  assert.equal(p.cols, 5);
  assert.equal(cellAt(p, 0, 0).ch, "h");
  assert.equal(cellAt(p, 4, 1).ch, "d");
  assert.equal(cellAt(p, 0, 1).fg, null);
});

test("trailing blank cells are default spaces", () => {
  const p = parseAnsi("ab");
  assert.equal(p.cols, 2);
  assert.equal(p.cells[0][5], undefined);
  assert.equal(p.cells[0][1].ch, "b");
});

test("SGR colours and attributes are preserved", () => {
  const p = parseAnsi("\x1b[31mRED\x1b[0m \x1b[1;32mBG\x1b[0m\x1b[2mDIM");
  assert.equal(cellAt(p, 0, 0).fg.kind, "ansi");
  assert.equal(cellAt(p, 0, 0).fg.n, 1);
  assert.equal(cellAt(p, 3, 0).fg, null); // after reset
  assert.equal(cellAt(p, 5, 0).bold, true);
  assert.equal(cellAt(p, 5, 0).fg.n, 2);
  const dim = cellAt(p, 8, 0);
  assert.equal(dim.dim, true);
  assert.equal(dim.bold, false);
});

test("256-colour and truecolour SGR", () => {
  const p = parseAnsi("\x1b[38;5;196mX\x1b[0m\x1b[48;2;10;20;30mY");
  assert.deepStrictEqual(cellAt(p, 0, 0).fg, { kind: "ansi", n: 196 });
  assert.deepStrictEqual(cellAt(p, 1, 0).bg, { kind: "rgb", r: 10, g: 20, b: 30 });
});

test("reverse video and underline", () => {
  const p = parseAnsi("\x1b[4;7mR\x1b[27m");
  assert.equal(cellAt(p, 0, 0).reverse, true);
  assert.equal(cellAt(p, 0, 0).underline, true);
});

test("carriage return overwrites from column 0", () => {
  const p = parseAnsi("aaaa\rXX");
  assert.equal(cellAt(p, 0, 0).ch, "X");
  assert.equal(cellAt(p, 1, 0).ch, "X");
  assert.equal(cellAt(p, 2, 0).ch, "a");
});

test("CRLF line endings from pane.read", () => {
  const p = parseAnsi("one\r\ntwo\r\n");
  assert.equal(p.rows, 3);
  assert.equal(cellAt(p, 0, 1).ch, "t");
});

test("tabs advance to 8-column stops", () => {
  const p = parseAnsi("a\tb");
  assert.equal(cellAt(p, 8, 0).ch, "b");
});

test("non-SGR CSI and OSC sequences are ignored", () => {
  const p = parseAnsi("\x1b[2Ka\x1b]0;title\x07b\x1b(Bc");
  assert.equal(cellAt(p, 0, 0).ch, "a");
  assert.equal(cellAt(p, 1, 0).ch, "b");
  assert.equal(cellAt(p, 2, 0).ch, "c");
});

test("viewport-sized grid parses fast enough for 4 Hz x 8 tiles", () => {
  const rows = [];
  for (let y = 0; y < 40; y++) {
    let line = "";
    for (let x = 0; x < 120; x++) {
      line += (x + y) % 9 === 0 ? "\x1b[3" + ((x + y) % 7) + "m█\x1b[0m" : String.fromCharCode(33 + ((x * 7 + y) % 90));
    }
    rows.push(line);
  }
  const text = rows.join("\r\n");
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 32; i++) parseAnsi(text);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 500, `parsing 32 viewports took ${ms}ms`);
});
