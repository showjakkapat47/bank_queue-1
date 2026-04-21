'use strict';

const net                 = require('net');
const { renderThaiLines } = require('./thaiImageRenderer');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const QRCodeLib           = require('qrcode');
require('dotenv').config();

const RAWBT_HOST    = process.env.RAWBT_HOST    || '192.168.200.103';
const RAWBT_PORT    = parseInt(process.env.RAWBT_PORT    || '9100', 10);
const RAWBT_TIMEOUT = parseInt(process.env.RAWBT_TIMEOUT || '5000', 10);
const LIFF_ID       = process.env.LIFF_ID       || '2007943872-gimLRRti';

const ESC = 0x1B;
const GS  = 0x1D;
const LF  = 0x0A;

const CMD = {
  INIT: Buffer.from([ESC, 0x40]),
  FEED: Buffer.from([ESC, 0x64, 0x05]),
  CUT:  Buffer.from([GS,  0x56, 0x00]),
};

const PAPER_W = 576;

// ── Labels ────────────────────────────────────────────────────────
function getLabels(isEn, ahead, waitTime) {
  return isEn ? {
    category:    'Type:',
    service:     'Service:',
    ahead:       `Queue ahead: ${ahead}`,
    wait:        `Est. wait: ${waitTime} min`,
    noQueue:     'No queue ahead',
    serveNow:    'Ready to serve',
    scanQR:      'Scan QR for queue status',
    keepTicket:  'Please keep this ticket',
    followBoard: 'Follow the display board',
    thankYou:    'Thank you',
  } : {
    category:    'ประเภท:',
    service:     'บริการ:',
    ahead:       `คิวข้างหน้า ${ahead} คิว`,
    wait:        `รอประมาณ ${waitTime} นาที`,
    noQueue:     'ไม่มีคิวรออยู่ข้างหน้า',
    serveNow:    'เข้ารับบริการได้ทันที',
    scanQR:      'สแกน QR เพื่อเช็คสถานะคิว',
    keepTicket:  'โปรดเก็บบัตรคิวนี้ไว้',
    followBoard: 'ติดตามหน้าจอแสดงผล',
    thankYou:    'ขอบคุณที่ใช้บริการ',
  };
}

// ── Build Ticket ──────────────────────────────────────────────────
async function buildTicket(data) {
  const ahead = parseInt(data.ahead_count) || 0;
  const isEn  = data.lang === 'en' || data.lang === 'zh';
  const L     = getLabels(isEn, ahead, data.estimated_wait_time || 0);
  const qrUrl = `https://liff.line.me/${LIFF_ID}?q=${data.queue_number}`;

  // ── Text section ────────────────────────────────────────────────
  const topLines = [
    { text: 'BANK',                    bold: true,  size: 'double', align: 'center' },
    { text: data.shop_name || '',      bold: false, size: 'small',  align: 'center' },
    { text: data.date,                 bold: false, size: 'small',  align: 'center' },
    { text: data.time,                 bold: false, size: 'small',  align: 'center' },
    { text: '--------------------------------', bold: false, size: 'small', align: 'center' },
    { text: data.queue_number || '---',bold: true,  size: 'double', align: 'center' },
    { text: '--------------------------------', bold: false, size: 'small', align: 'center' },
    { text: L.category,                bold: false, size: 'small',  align: 'center' },
    { text: data.category_name || '-', bold: false, size: 'small',  align: 'center' },
    { text: L.service,                 bold: false, size: 'small',  align: 'center' },
    { text: data.service_name  || '-', bold: false, size: 'small',  align: 'center' },
    { text: '--------------------------------', bold: false, size: 'small', align: 'center' },
    ...(ahead > 0
      ? [{ text: L.ahead, bold: true,  size: 'small', align: 'center' },
         { text: L.wait,  bold: false, size: 'small', align: 'center' }]
      : [{ text: L.noQueue,  bold: true,  size: 'small', align: 'center' },
         { text: L.serveNow, bold: false, size: 'small', align: 'center' }]
    ),
    { text: '--------------------------------', bold: false, size: 'small', align: 'center' },
    { text: L.scanQR,                  bold: false, size: 'small', align: 'center' },
  ];

  const topBuf = renderThaiLines(topLines);

  // ── QR Code ─────────────────────────────────────────────────────
  const QR_SIZE = 260;
  const leftPad = Math.floor((PAPER_W - QR_SIZE) / 2);

  const pngBuf = await QRCodeLib.toBuffer(qrUrl, {
    type: 'png', width: QR_SIZE, margin: 3,
    color: { dark: '#000000', light: '#ffffff' },
    errorCorrectionLevel: 'M',
  });

  const qrImg    = await loadImage(pngBuf);
  const qrCanvas = createCanvas(PAPER_W, QR_SIZE);
  const qCtx    = qrCanvas.getContext('2d');
  qCtx.fillStyle = '#ffffff';
  qCtx.fillRect(0, 0, PAPER_W, QR_SIZE);
  qCtx.drawImage(qrImg, leftPad, 0, QR_SIZE, QR_SIZE);

  const qrBuf = encodeToEscPos(qCtx.getImageData(0, 0, PAPER_W, QR_SIZE).data, PAPER_W, QR_SIZE);

  // ── Footer ───────────────────────────────────────────────────────
  const footerBuf = renderThaiLines([
    { text: '',           bold: false, size: 'small', align: 'center' },
    { text: L.keepTicket, bold: false, size: 'small', align: 'center' },
    { text: L.followBoard,bold: false, size: 'small', align: 'center' },
    { text: L.thankYou,   bold: true,  size: 'small', align: 'center' },
  ]);

  return Buffer.concat([CMD.INIT, topBuf, qrBuf, footerBuf, CMD.FEED, CMD.CUT]);
}

// ── ESC/POS raster encoder ────────────────────────────────────────
function encodeToEscPos(pixels, w, h) {
  const bytesPerRow = w / 8;
  const imgBuf = Buffer.alloc(bytesPerRow * h, 0);

  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const idx = (row * w + col) * 4;
      const avg = (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3;
      if (avg < 128) imgBuf[row * bytesPerRow + Math.floor(col / 8)] |= (0x80 >> (col % 8));
    }
  }

  const xL = bytesPerRow & 0xFF, xH = (bytesPerRow >> 8) & 0xFF;
  const yL = h & 0xFF,           yH = (h >> 8) & 0xFF;
  return Buffer.concat([Buffer.from([0x1D, 0x76, 0x30, 0x00, xL, xH, yL, yH]), imgBuf]);
}

// ── TCP Send ──────────────────────────────────────────────────────
function sendToRawBT(buf) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled  = false;

    const done = err => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve({ success: true });
    };

    socket.setTimeout(RAWBT_TIMEOUT);
    socket.connect(RAWBT_PORT, RAWBT_HOST, () => {
      console.log(`🔌 TCP connected → ${RAWBT_HOST}:${RAWBT_PORT}`);
      socket.write(buf, err => { if (err) return done(err); setTimeout(() => done(null), 600); });
    });
    socket.on('timeout', () => done(new Error('RawBT timeout')));
    socket.on('error',   err => done(new Error('RawBT error: ' + err.message)));
  });
}

// ── Public API ────────────────────────────────────────────────────
async function printQueueTicket(queueData) {
  try {
    const data = {
      queue_number:        String(queueData.queue_number         || 'TEST'),
      shop_name:           String(queueData.shop_name            || 'ระบบคิวธนาคาร'),
      category_name:       String(queueData.category_name        || '-'),
      service_name:        String(queueData.service_name         || '-'),
      date:                String(queueData.date  || new Date().toLocaleDateString('th-TH')),
      time:                String(queueData.time  || new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })),
      ahead_count:         parseInt(queueData.ahead_count)         || 0,
      estimated_wait_time: parseInt(queueData.estimated_wait_time) || 0,
      lang:                queueData.lang || 'th',
    };

    console.log('🖼️  Rendering ticket:', data.queue_number);
    const buf = await buildTicket(data);
    await sendToRawBT(buf);
    console.log('🖨️  Printed:', data.queue_number);
    return { success: true, message: `พิมพ์สำเร็จ: ${data.queue_number}` };
  } catch (err) {
    console.error('❌ printQueueTicket error:', err.message);
    return { success: false, error: err.message };
  }
}

async function testPrinter() {
  return printQueueTicket({
    queue_number:        'TEST',
    shop_name:           'ทดสอบระบบ',
    category_name:       'ฝาก / ถอน / โอน',
    service_name:        'ทดสอบการพิมพ์',
    date:                new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' }),
    time:                new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
    ahead_count:         3,
    estimated_wait_time: 15,
  });
}

function checkPrinter() {
  return new Promise(resolve => {
    const socket = new net.Socket();
    socket.setTimeout(3000);
    socket.connect(RAWBT_PORT, RAWBT_HOST, () => {
      socket.destroy();
      resolve({ success: true, online: true, host: RAWBT_HOST, port: RAWBT_PORT });
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ success: false, online: false, host: RAWBT_HOST, port: RAWBT_PORT, message: 'timeout' }); });
    socket.on('error',   err => resolve({ success: false, online: false, host: RAWBT_HOST, port: RAWBT_PORT, message: err.message }));
  });
}

module.exports = { printQueueTicket, testPrinter, checkPrinter };