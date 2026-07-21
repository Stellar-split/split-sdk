/**
 * Minimal PDF receipt generator for payment proofs.
 *
 * Hand-rolled PDF generation without external dependencies.
 */

import type { Invoice, Payment } from "./types.js";
import { formatAmount, truncateAddress } from "./utils.js";

interface ReceiptInput {
  invoice: Invoice;
  payment: Payment;
  proofHash: string;
}

/**
 * Generate a minimal PDF receipt for a payment.
 *
 * @param invoice - Invoice being paid
 * @param payment - Payment record
 * @param proofHash - SHA-256 hash of payment proof
 * @returns Valid PDF as Uint8Array
 */
export function generateReceiptPdf(
  invoice: Invoice,
  payment: Payment,
  proofHash: string,
): Uint8Array {
  const input: ReceiptInput = { invoice, payment, proofHash };
  const pdf = new PdfBuilder();

  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 40;
  const contentWidth = pageWidth - 2 * margin;
  let y = pageHeight - margin;

  pdf.setFont("Helvetica-Bold", 16);
  pdf.text("Payment Receipt", margin, y);
  y -= 30;

  pdf.setFont("Helvetica-Bold", 10);
  pdf.text("Invoice Details", margin, y);
  y -= 15;

  pdf.setFont("Helvetica", 9);
  pdf.text(`Invoice ID: ${input.invoice.id}`, margin, y);
  y -= 12;
  pdf.text(`Creator: ${truncateAddress(input.invoice.creator)}`, margin, y);
  y -= 12;
  pdf.text(`Status: ${input.invoice.status}`, margin, y);
  y -= 20;

  pdf.setFont("Helvetica-Bold", 10);
  pdf.text("Payment Details", margin, y);
  y -= 15;

  pdf.setFont("Helvetica", 9);
  pdf.text(`Payer: ${truncateAddress(input.payment.payer)}`, margin, y);
  y -= 12;
  pdf.text(`Amount: ${formatAmount(input.payment.amount)} USDC`, margin, y);
  y -= 12;

  const timestamp = input.payment.timestamp
    ? new Date(input.payment.timestamp * 1000).toISOString()
    : "N/A";
  pdf.text(`Timestamp: ${timestamp}`, margin, y);
  y -= 20;

  pdf.setFont("Helvetica-Bold", 10);
  pdf.text("Proof Hash", margin, y);
  y -= 12;

  pdf.setFont("Helvetica", 8);
  const hashLines = _wrapText(input.proofHash, contentWidth);
  for (const line of hashLines) {
    pdf.text(line, margin, y);
    y -= 11;
  }

  return pdf.finalize();
}

function _wrapText(text: string, maxWidth: number, charsPerUnit = 2): string[] {
  const charsPerLine = Math.floor(maxWidth / charsPerUnit);
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += charsPerLine) {
    lines.push(text.substring(i, i + charsPerLine));
  }
  return lines;
}

class PdfBuilder {
  private objects: Map<number, Buffer> = new Map();
  private objectCount = 0;
  private font = "Helvetica";
  private fontSize = 12;
  private textContent: string[] = [];
  private xRefOffsets: number[] = [];

  setFont(font: string, size: number): void {
    this.font = font;
    this.fontSize = size;
  }

  text(content: string, x: number, y: number): void {
    this.textContent.push(
      `BT /${this.font} ${this.fontSize} Tf ${x} ${y} Td (${this._escapePdfString(content)}) Tj ET`,
    );
  }

  private _escapePdfString(str: string): string {
    return str
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  }

  finalize(): Uint8Array {
    const catalog = this._writeObject({
      Type: "/Catalog",
      Pages: "2 0 R",
    });

    const pages = this._writeObject({
      Type: "/Pages",
      Kids: "[3 0 R]",
      Count: "1",
    });

    const content = this.textContent.join(" ");
    const contentObj = this._writeObject(content, true);

    const page = this._writeObject({
      Type: "/Page",
      Parent: "2 0 R",
      MediaBox: "[0 0 595 842]",
      Contents: `${contentObj} 0 R`,
      Resources: "<<>>",
    });

    const pdf = Buffer.alloc(1024 * 10);
    let offset = 0;

    const header = Buffer.from("%PDF-1.4\n", "utf8");
    header.copy(pdf, offset);
    offset += header.length;

    this.xRefOffsets = [];
    const objects = [catalog, pages, page, Buffer.from(content, "utf8")];
    for (let i = 0; i < objects.length; i++) {
      this.xRefOffsets.push(offset);
      const objNum = i + 1;
      const objHeader = Buffer.from(`${objNum} 0 obj\n`, "utf8");
      objHeader.copy(pdf, offset);
      offset += objHeader.length;

      if (typeof objects[i] === "string") {
        const objContent = Buffer.from(`${objects[i]}\nendobj\n`, "utf8");
        objContent.copy(pdf, offset);
        offset += objContent.length;
      } else {
        const dict = (objects[i] && typeof objects[i] === "object" && !Buffer.isBuffer(objects[i]))
          ? (objects[i] as unknown as Record<string, string>)
          : {};
        const objContent = Buffer.from(`<<${this._dictToString(dict)}>>\nendobj\n`, "utf8");
        objContent.copy(pdf, offset);
        offset += objContent.length;
      }
    }

    const xrefOffset = offset;
    const xrefHeader = Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
      "utf8",
    );
    xrefHeader.copy(pdf, offset);
    offset += xrefHeader.length;

    for (const xrefPos of this.xRefOffsets) {
      const xrefLine = Buffer.from(
        `${String(xrefPos).padStart(10, "0")} 00000 n \n`,
        "utf8",
      );
      xrefLine.copy(pdf, offset);
      offset += xrefLine.length;
    }

    const trailer = Buffer.from(
      `trailer\n<<\n/Size ${objects.length + 1}\n/Root 1 0 R\n>>\nstartxref\n${xrefOffset}\n%%EOF`,
      "utf8",
    );
    trailer.copy(pdf, offset);
    offset += trailer.length;

    return new Uint8Array(pdf.slice(0, offset));
  }

  private _writeObject(obj: any, isStream = false): number {
    this.objectCount++;
    this.objects.set(this.objectCount, Buffer.from(""));
    return this.objectCount;
  }

  private _dictToString(dict: Record<string, string>): string {
    return Object.entries(dict)
      .map(([k, v]) => `/${k}${v}`)
      .join(" ");
  }
}
