'use strict';

const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');

// ── Fonts ─────────────────────────────────────────────────────────
const FONT_DIR = path.join(__dirname, 'fonts');
GlobalFonts.registerFromPath(path.join(FONT_DIR, 'NotoSansThai-Regular.ttf'), 'NotoSansThai');
GlobalFonts.registerFromPath(path.join(FONT_DIR, 'NotoSansThai-Bold.ttf'),    'NotoSansThai');

// ── Constants ─────────────────────────────────────────────────────
const PAPER_W    = 576;  // 80mm @ ~180dpi (72 bytes/row ÷ 8)
const LINE_GAP   = 8;
const MAX_TEXT_W = PAPER_W - 40;
const MARGIN     = 8;

const SIZE_MAP = { small: 20, normal: 28, double: 52 };

// ── Word wrap (ตัดที่ space และ /) ───────────────────────────────
function wrapText(ctx, text, maxWidth) {
  if (!text || ctx.measureText(text).width <= maxWidth) return [text || ''];

  const lines   = [];
  let   current = '';

  for (const token of text.split(/(?=[/ ])/)) {
    const test = current + token;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current.trim());
      current = token;
    } else {
      current = test;
    }
  }
  if (current.trim()) lines.push(current.trim());

  return lines.length ? lines : [text];
}

// ── Render lines → ESC/POS GS v 0 raster buffer ──────────────────
function renderThaiLines(lines) {
  const tmpCtx = createCanvas(PAPER_W, 10).getContext('2d');

  // Expand lines with wrap
  const expanded = [];
  for (const line of lines) {
    const size   = SIZE_MAP[line.size] || SIZE_MAP.normal;
    const weight = line.bold ? 'bold' : 'normal';
    tmpCtx.font  = `${weight} ${size}px NotoSansThai`;
    for (const text of wrapText(tmpCtx, line.text || '', MAX_TEXT_W)) {
      expanded.push({ ...line, text });
    }
  }

  // Measure each line
  const measured = expanded.map(line => {
    const size   = SIZE_MAP[line.size] || SIZE_MAP.normal;
    const weight = line.bold ? 'bold' : 'normal';
    tmpCtx.font  = `${weight} ${size}px NotoSansThai`;
    const m      = tmpCtx.measureText(line.text || ' ');
    const ascent = Math.ceil(m.actualBoundingBoxAscent);
    const descent= Math.ceil(m.actualBoundingBoxDescent);
    return { size, weight, ascent, lh: ascent + descent + LINE_GAP, tw: Math.ceil(m.width) };
  });

  const totalH = LINE_GAP + measured.reduce((s, m) => s + m.lh, 0) + LINE_GAP;

  // Draw
  const canvas = createCanvas(PAPER_W, totalH);
  const ctx    = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PAPER_W, totalH);
  ctx.fillStyle = '#000000';

  let y = LINE_GAP;
  expanded.forEach((line, i) => {
    const { size, weight, ascent, lh, tw } = measured[i];
    ctx.font = `${weight} ${size}px NotoSansThai`;

    let x;
    if (line.align === 'center') {
      x = Math.max(MARGIN, Math.min(Math.round((PAPER_W - tw) / 2), PAPER_W - tw - MARGIN));
    } else if (line.align === 'right') {
      x = PAPER_W - tw - MARGIN;
    } else {
      x = MARGIN;
    }
    if (x < 0) x = 0;

    if (line.text) ctx.fillText(line.text, x, y + ascent);
    y += lh;
  });

  // Encode → ESC/POS raster
  const pixels      = ctx.getImageData(0, 0, PAPER_W, totalH).data;
  const bytesPerRow = PAPER_W / 8;
  const imgBuf      = Buffer.alloc(bytesPerRow * totalH, 0);

  for (let row = 0; row < totalH; row++) {
    for (let col = 0; col < PAPER_W; col++) {
      const idx = (row * PAPER_W + col) * 4;
      const avg = (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3;
      if (avg < 128) imgBuf[row * bytesPerRow + Math.floor(col / 8)] |= (0x80 >> (col % 8));
    }
  }

  const xL = bytesPerRow & 0xFF, xH = (bytesPerRow >> 8) & 0xFF;
  const yL = totalH    & 0xFF,   yH = (totalH     >> 8) & 0xFF;
  return Buffer.concat([Buffer.from([0x1D, 0x76, 0x30, 0x00, xL, xH, yL, yH]), imgBuf]);
}

module.exports = { renderThaiLines };