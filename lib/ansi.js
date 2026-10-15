"use strict";

/**
 * Parse the ANSI text returned by `pane.read --source visible --format ansi`
 * into a cell grid. Each cell keeps its character plus SGR attributes so the
 * overview can reproduce colours and styling when mirroring.
 *
 * Supported control handling:
 * - SGR ( colours, bold, dim, italic, underline, reverse, resets )
 * - \r (carriage return), \t (tab stops every 8 columns), \b (backspace)
 * - other CSI sequences, OSC sequences and charset switches are ignored
 */

const TAB_STOP = 8;

function defaultCell() {
  return {
    ch: " ",
    fg: null, // {kind:"ansi",n} | {kind:"rgb",r,g,b} | null
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    reverse: false,
  };
}

function cloneCell(c) {
  return {
    ch: c.ch,
    fg: c.fg,
    bg: c.bg,
    bold: c.bold,
    dim: c.dim,
    italic: c.italic,
    underline: c.underline,
    reverse: c.reverse,
  };
}

function newAttrState() {
  return {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    reverse: false,
  };
}

function applySgr(state, params) {
  let i = 0;
  if (params.length === 0) params = [0];
  while (i < params.length) {
    const p = params[i];
    if (p === 0) {
      Object.assign(state, newAttrState());
    } else if (p === 1) state.bold = true;
    else if (p === 2) state.dim = true;
    else if (p === 3) state.italic = true;
    else if (p === 4) state.underline = true;
    else if (p === 7) state.reverse = true;
    else if (p === 22) { state.bold = false; state.dim = false; }
    else if (p === 23) state.italic = false;
    else if (p === 24) state.underline = false;
    else if (p === 27) state.reverse = false;
    else if (p >= 30 && p <= 37) state.fg = { kind: "ansi", n: p - 30 };
    else if (p === 38 || p === 48) {
      const target = p === 38 ? "fg" : "bg";
      if (params[i + 1] === 5) {
        state[target] = { kind: "ansi", n: params[i + 2] | 0 };
        i += 2;
      } else if (params[i + 1] === 2) {
        state[target] = {
          kind: "rgb",
          r: params[i + 2] | 0,
          g: params[i + 3] | 0,
          b: params[i + 4] | 0,
        };
        i += 4;
      }
    } else if (p === 39) state.fg = null;
    else if (p === 49) state.bg = null;
    else if (p >= 90 && p <= 97) state.fg = { kind: "ansi", n: p - 90 + 8 };
    else if (p >= 100 && p <= 107) state.bg = { kind: "ansi", n: p - 100 + 8 };
    i += 1;
  }
}

/**
 * @param {string} text
 * @returns {{rows:number, cols:number, cells:Array<Array<object>>, blank:object}}
 */
function parseAnsi(text) {
  const blank = defaultCell();
  const lines = [[]];
  const state = newAttrState();
  let col = 0;
  const chars = Array.from(text);
  let i = 0;

  const putCh = (ch) => {
    const line = lines[lines.length - 1];
    while (line.length < col) line.push(cloneCell(blank));
    const cell = cloneCell(blank);
    cell.ch = ch;
    cell.fg = state.fg;
    cell.bg = state.bg;
    cell.bold = state.bold;
    cell.dim = state.dim;
    cell.italic = state.italic;
    cell.underline = state.underline;
    cell.reverse = state.reverse;
    line[col] = cell;
    col += 1;
  };

  const newline = () => {
    lines.push([]);
    col = 0;
  };

  while (i < chars.length) {
    const ch = chars[i];
    if (ch === "\x1b") {
      // escape sequence: CSI, OSC, or two-char escapes
      if (chars[i + 1] === "[") {
        // CSI: params until final byte @ through ~
        let j = i + 2;
        let paramsStr = "";
        while (j < chars.length && !/[A-Za-z@`~]/.test(chars[j])) {
          paramsStr += chars[j];
          j += 1;
        }
        const final = chars[j];
        if (final === "m") {
          const params = paramsStr
            .split(";")
            .map((s) => (s === "" ? 0 : parseInt(s, 10)))
            .filter((n) => Number.isFinite(n));
          applySgr(state, params);
        }
        // all other CSI sequences are ignored; viewport reads should not
        // contain cursor addressing (verified against protocol 20)
        i = j + 1;
        continue;
      }
      if (chars[i + 1] === "]") {
        // OSC: skip until BEL or ST
        let j = i + 2;
        while (j < chars.length && chars[j] !== "\x07") {
          if (chars[j] === "\x1b" && chars[j + 1] === "\\") {
            j += 1;
            break;
          }
          j += 1;
        }
        i = j + 1;
        continue;
      }
      // two/three-char escape with intermediate bytes (charset select etc.)
      let j = i + 1;
      while (j < chars.length && chars[j] >= "\x20" && chars[j] <= "\x2f") {
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (ch === "\n") {
      newline();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      col = 0;
      i += 1;
      continue;
    }
    if (ch === "\t") {
      col = Math.floor(col / TAB_STOP) * TAB_STOP + TAB_STOP;
      i += 1;
      continue;
    }
    if (ch === "\b") {
      col = Math.max(0, col - 1);
      i += 1;
      continue;
    }
    if (ch < " " || ch === "\x7f") {
      i += 1;
      continue;
    }
    putCh(ch);
    i += 1;
  }

  let cols = 0;
  for (const line of lines) cols = Math.max(cols, line.length);
  return { rows: lines.length, cols, cells: lines, blank };
}

module.exports = { parseAnsi, defaultCell, cloneCell };
