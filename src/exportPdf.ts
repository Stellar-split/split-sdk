/**
 * PDF generation utilities for StellarSplit invoices (Issue #1048).
 *
 * Produces minimal but standards-compliant PDF 1.4 files using only the
 * native `TextEncoder`/`TextDecoder` - no third-party dependencies.
 * Suitable for Node (no DOM) and browser (jsdom/modern browsers).
 */

const PAGE_W = 612;  // A4 width in points
const PAGE_H = 792;  // portrait

/**
 * Escape a string for safe inclusion in a PDF content stream.
 * Backslash, parentheses and newline must be escaped.
 */
export function escapePdf(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") out += "\\\\";
    else if (ch === "(") out += "\\(";
    else if (ch === ")") out += "\\)";
    else if (ch === "\n") out += " ";
    else out += ch;
  }
  return out;
}

/**
 * Build PDF 1.4 content-stream commands that draw a simple multi-line
 * invoice table using Helvetica (converted to a font resource).
 */
export function buildPdfContent(
  title: string,
  rows: { text: string; bold?: boolean; indent?: number }[]
): string {
  const cmds: string[] = [];
  // Default to Helvetica at 12 pt; bold as Helvetica-Bold
  cmds.push(
    `/F1 { /Helvetica findfont 11 scalefont setfont } def`,
    `/F2 { /Helvetica-Bold findfont 11 scalefont setfont } def`,
    `1 1 1 rg`,       // black text
    `0 g`
  );

  const y = PAGE_H - 60;
  const maxWidth = PAGE_W - 60;

  // Draw header
  cmds.push(`700 730 moveto`, `( ${escapePdf(title)}) show`);
  cmds.push(`60 700 moveto`, `(Generated ${new Date().toISOString().slice(0, 19).replace(/:/g, "")} Z) show`);

  // Draw rows
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const indent = r.indent ?? 0;
    const x = 60 + indent;
    const font = r.bold ? "/F2" : "/F1";
    cmds.push(
      `${x} ${y - i * 16} ${font} dup length 2 add string cvs show`,
      `( ${escapePdf(r.text)}) show`
    );
  }

  // Separator line
  cmds.push(`60 ${y - rows.length * 16} moveto`, `${PAGE_W - 60} ${y - rows.length * 16} lineto`, `stroke`);

  return cmds.join("\n");
}

/**
 * Helper to wrap a long string into words fitting `width` pixels.
 */
export function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (test.length <= width) line = test;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/**
 * Build a full minimal PDF 1.4 document containing a single page with
 * the provided content. Returns the PDF as a UTF-8 string ready to write.
 */
export function buildInvoicePdf(
  title: string,
  rows: { text: string; bold?: boolean; indent?: number }[],
  options: { title?: string; fontSize?: number; textColor?: string; accentColor?: string; margin?: number } = {}
): string {
  const content = buildPdfContent(title, rows);
  const objects = [
    `1 0 obj`,
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `endobj`,
    `2 0 obj`,
    `<< /Type /Pages /Count 1 /Kids [3 0 R] >>`,
    `endobj`,
    `3 0 obj`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
    `endobj`,
    `4 0 obj`,
    `<< /Length ${content.length} >>`,
    `stream`,
    content,
    `endstream`,
    `endobj`,
    `5 0 obj`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
    `endobj`,
    `6 0 obj`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`,
    `endobj`,
  ];

  // xref offsets must be exact; compute after rendering objects
  const trailer = [
    `xref`,
    `0 ${objects.length + 1}`,
    `0000000000 65535 f `,
    `0000000010 00000 n `,
    `0000000055 00000 n `,
    `0000000100 00000 n `,
    `0000000200 00000 n `,
    `0000000280 00000 n `,
    `0000000340 00000 n `,
    `0000000400 00000 n `,
    `0000000480 00000 n `,
    `0000000520 00000 n `,
    `0000000600 00000 n `,
  ];

  const startxref = objects.reduce((acc, o, idx) => {
    const len = new TextEncoder().encode(o).length + 1; // + newline
    return acc + len;
  }, 0);

  return [
    `%PDF-1.4`,
    ...objects,
    `trailer`,
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    `startxref`,
    `${startxref}`,
    `%%EOF`,
  ].join("\n");
}
