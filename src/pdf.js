// A small PDF writer for invoices and receipts: text in Helvetica (built into every PDF reader, so
// nothing is embedded), lines and filled boxes, on US Letter pages. No dependencies.

// Helvetica character widths (1/1000 of the font size) for ASCII 32-126.
const WIDTHS = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
// Characters outside ASCII that the standard (WinAnsi) encoding has.
const WIN_ANSI = { '·': 0xb7, '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, 'é': 0xe9, 'ñ': 0xf1, '©': 0xa9, '×': 0xd7 };

const toBytes = (text) => [...String(text)].map((ch) => {
  const code = ch.charCodeAt(0);
  if (code >= 32 && code <= 126) return code;
  return WIN_ANSI[ch] ?? 63; // '?'
});

function textWidth(text, size, bold = false) {
  const units = toBytes(text).reduce((sum, b) => sum + (b >= 32 && b <= 126 ? WIDTHS[b - 32] : 556), 0);
  return (units * size / 1000) * (bold ? 1.06 : 1);
}

const escape = (bytes) => bytes.map((b) => (b === 40 || b === 41 || b === 92 ? `\\${String.fromCharCode(b)}`
  : b > 126 ? `\\${b.toString(8).padStart(3, '0')}` : String.fromCharCode(b))).join('');
const rgb = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');

function createPdf() {
  const W = 612;
  const H = 792;
  const pages = [];
  let ops = null;
  const newPage = () => { ops = []; pages.push(ops); };
  newPage();

  const doc = {
    width: W,
    height: H,
    newPage,
    textWidth,
    // y counts down from the top of the page.
    text(x, y, str, { size = 10, bold = false, color = '#0e1a2b', align = 'left' } = {}) {
      const w = textWidth(str, size, bold);
      const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
      ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb(color)} rg ${left.toFixed(2)} ${(H - y).toFixed(2)} Td (${escape(toBytes(str))}) Tj ET`);
    },
    // Wraps text to a width; returns the y below it.
    paragraph(x, y, str, width, { size = 10, bold = false, color, leading = 1.35 } = {}) {
      let line = '';
      let yy = y;
      for (const word of String(str).split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (line && textWidth(next, size, bold) > width) {
          doc.text(x, yy, line, { size, bold, color });
          yy += size * leading;
          line = word;
        } else line = next;
      }
      if (line) { doc.text(x, yy, line, { size, bold, color }); yy += size * leading; }
      return yy;
    },
    line(x1, y1, x2, y2, { color = '#d8dee7', width = 1 } = {}) {
      ops.push(`${rgb(color)} RG ${width} w ${x1} ${H - y1} m ${x2} ${H - y2} l S`);
    },
    rect(x, y, w, h, { fill = '#f1f4f8' } = {}) {
      ops.push(`${rgb(fill)} rg ${x} ${H - y - h} ${w} ${h} re f`);
    },
    // The finished file.
    toBuffer() {
      const objects = [];
      const add = (body) => { objects.push(body); return objects.length; };
      const catalog = add(null);
      const pagesObj = add(null);
      const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
      const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
      const kids = pages.map((pageOps) => {
        const stream = pageOps.join('\n');
        const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
        return add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`);
      });
      objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
      objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
      let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
      const offsets = [];
      objects.forEach((body, i) => {
        offsets.push(Buffer.byteLength(out, 'latin1'));
        out += `${i + 1} 0 obj\n${body}\nendobj\n`;
      });
      const xref = Buffer.byteLength(out, 'latin1');
      out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
      out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      return Buffer.from(out, 'latin1');
    },
  };
  return doc;
}

module.exports = { createPdf, textWidth };
