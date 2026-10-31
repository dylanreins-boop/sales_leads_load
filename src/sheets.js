// Reads spreadsheets people upload: Excel (.xlsx) and CSV. Returns the first sheet as rows of text.
// No libraries: an .xlsx file is a zip of XML files, unpacked here with Node's zlib.
const zlib = require('node:zlib');

// ---- zip ----
function unzip(buf) {
  // The end-of-central-directory record is in the last 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip file');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    files.set(name, () => {
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`unsupported zip compression (${method})`);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const xmlText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
// All the <t> text inside a piece of XML (rich text in Excel is split into runs).
const textOf = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1])).join('')
  || (/<t(?:\s[^>]*)?\/>/.test(xml) ? '' : '');

const colIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

// Excel stores dates as days since 1899-12-30. Styles say which numbers are dates.
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
function dateStyles(stylesXml) {
  if (!stylesXml) return new Set();
  const custom = new Map([...stylesXml.matchAll(/<numFmt\s[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)].map((m) => [Number(m[1]), xmlText(m[2])]));
  const isDate = (id) => BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && /[dmyh]/i.test(custom.get(id).replace(/"[^"]*"|\[[^\]]*\]/g, '')));
  const xfs = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] || '';
  const out = new Set();
  [...xfs.matchAll(/<xf\s([^>]*?)\/?>/g)].forEach((m, i) => {
    const id = Number(m[1].match(/numFmtId="(\d+)"/)?.[1] ?? 0);
    if (isDate(id)) out.add(i);
  });
  return out;
}
function excelDate(serial) {
  const ms = Math.round((Number(serial) - 25569) * 86400000);
  const d = new Date(ms);
  // Serial dates have no time zone; keep the same wall-clock date and time.
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()).toISOString();
}

function readXlsx(buf) {
  const files = unzip(buf);
  const read = (name) => (files.has(name) ? files.get(name)().toString('utf8') : null);
  // The first sheet in the workbook's order.
  const workbook = read('xl/workbook.xml') || '';
  const rels = read('xl/_rels/workbook.xml.rels') || '';
  const firstId = workbook.match(/<sheet\s[^>]*r:id="([^"]+)"/)?.[1];
  let target = firstId && rels.match(new RegExp(`<Relationship\\s[^>]*Id="${firstId}"[^>]*Target="([^"]+)"`))?.[1]
    || rels.match(new RegExp(`<Relationship\\s[^>]*Target="([^"]+)"[^>]*Id="${firstId}"`))?.[1];
  if (target) target = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const sheet = read(target) || read('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('no worksheet found');
  const shared = [...(read('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const dates = dateStyles(read('xl/styles.xml'));

  const rows = [];
  for (const row of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const r = Number(row[1].match(/\br="(\d+)"/)?.[1] ?? rows.length + 1) - 1;
    const cells = [];
    let next = 0;
    for (const c of row[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const col = ref ? colIndex(ref) : next;
      next = col + 1;
      const type = attrs.match(/\bt="(\w+)"/)?.[1];
      const style = Number(attrs.match(/\bs="(\d+)"/)?.[1] ?? -1);
      const inner = c[2] || '';
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textOf(inner);
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else if (v != null) value = type !== 'str' && dates.has(style) && /^-?\d+(\.\d+)?$/.test(v) ? excelDate(v) : xmlText(v);
      cells[col] = value;
    }
    rows[r] = Array.from(cells, (x) => x ?? '');
  }
  return Array.from(rows, (x) => x ?? []);
}

// CSV (or tab/semicolon separated), quotes and line breaks inside quotes included.
function readCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0];
  const counts = [',', '\t', ';'].map((d) => [d, firstLine.split(d).length]);
  const delim = counts.sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Picks the reader from the file's contents (zip = Excel), not just its name.
function readSheet(buf, name = '') {
  if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) return readXlsx(buf);
  if (/\.xls$/i.test(name) || (buf[0] === 0xd0 && buf[1] === 0xcf)) {
    throw new Error('That is an old Excel file (.xls). In Excel choose File > Save As > Excel Workbook (.xlsx) or CSV, then upload that.');
  }
  return readCsv(buf.toString('utf8'));
}

module.exports = { readSheet, readXlsx, readCsv, unzip };
