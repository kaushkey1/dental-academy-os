import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { indiaStates } from '../src/billing-fields.ts';
import type { Row } from './db.ts';
const regularBytes = readFileSync(resolve('assets/fonts/DejaVuSans.ttf'));
const boldBytes = readFileSync(resolve('assets/fonts/DejaVuSans-Bold.ttf'));
const characters = new Set((fontkit as any).create(regularBytes).characterSet as number[]);
export function unsupportedBillingText(value: unknown): boolean {
  if (typeof value === 'string')
    return [...value].some(
      (c) => !['\n', '\r', '\t'].includes(c) && !characters.has(c.codePointAt(0)!),
    );
  if (Array.isArray(value)) return value.some(unsupportedBillingText);
  if (value && typeof value === 'object') return Object.values(value).some(unsupportedBillingText);
  return false;
}
export async function billingPdf(s: Row) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setCreationDate(new Date(s.issuedAt));
  doc.setModificationDate(new Date(s.issuedAt));
  doc.setTitle(`${s.title} ${s.number}`);
  doc.setAuthor(s.supplier.legalName);
  doc.setProducer('Dental Academy OS billing renderer v' + (s.rendererVersion || 1));
  const regular = await doc.embedFont(regularBytes, { subset: true }),
    bold = await doc.embedFont(boldBytes, { subset: true });
  const navy = rgb(0.08, 0.15, 0.3),
    blue = rgb(0.16, 0.34, 0.77),
    gray = rgb(0.36, 0.4, 0.47),
    pale = rgb(0.93, 0.95, 0.99);
  const width = 595.28,
    height = 841.89,
    margin = 44,
    inner = width - 2 * margin;
  let page = doc.addPage([width, height]),
    y = height - 44;
  const money = (v: number) =>
    `${s.currency} ${(v / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const date = (v: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: s.timezone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date(v));
  const wrap = (v: unknown, size: number, font: PDFFont, w: number) => {
    const lines: string[] = [];
    for (const paragraph of String(v ?? '')
      .replace(/\r/g, '')
      .split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/)) {
        if (font.widthOfTextAtSize((line ? line + ' ' : '') + word, size) <= w) {
          line += (line ? ' ' : '') + word;
          continue;
        }
        if (line) lines.push(line);
        line = '';
        for (const ch of word) {
          if (font.widthOfTextAtSize(line + ch, size) > w) {
            lines.push(line);
            line = '';
          }
          line += ch;
        }
      }
      lines.push(line);
    }
    return lines;
  };
  const newPage = () => {
    page = doc.addPage([width, height]);
    y = height - 44;
    header(true);
  };
  const room = (n: number) => {
    if (y - n < 67) newPage();
  };
  const text = (value: unknown, size = 10, font = regular, color = navy, w = inner, x = margin) => {
    for (const line of wrap(value, size, font, w)) {
      room(size + 7);
      page.drawText(line, { x, y: y - size, size, font, color });
      y -= size + 5;
    }
  };
  const header = (continuation = false) => {
    if (s.sample) {
      page.drawRectangle({ x: 0, y: height - 26, width, height: 26, color: pale });
      page.drawText('SAMPLE DOCUMENT - NOT VALID FOR ACCOUNTING OR TAX CREDIT', {
        x: margin,
        y: height - 17,
        font: bold,
        size: 8,
        color: blue,
      });
    }
    if (continuation) {
      text(`${s.title}  |  ${s.number}  |  continued`, 10, bold);
      y -= 12;
    }
  };
  const rule = () => {
    room(16);
    y -= 6;
    page.drawLine({
      start: { x: margin, y },
      end: { x: width - margin, y },
      thickness: 0.7,
      color: rgb(0.82, 0.86, 0.91),
    });
    y -= 12;
  };
  const row = (label: string, value: string, strong = false) => {
    const font = strong ? bold : regular;
    room(24);
    page.drawText(label, { x: margin, y: y - 11, size: 10, font, color: navy });
    page.drawText(value, {
      x: width - margin - font.widthOfTextAtSize(value, 11),
      y: y - 11,
      size: 11,
      font,
      color: navy,
    });
    y -= 24;
  };
  header();
  text(s.title, 27, bold, blue);
  text(s.number, 12, bold);
  text(`Issued ${date(s.issuedAt)} | Financial year ${s.financialYearLabel}`, 9, regular, gray);
  y -= 12;
  const supplier = s.supplier,
    buyer = s.recipient;
  text('FROM', 8, bold, gray);
  text(supplier.legalName, 13, bold);
  text(
    [
      supplier.address,
      `${supplier.city}, ${indiaStates[supplier.state] || supplier.state} ${supplier.postalCode}`,
      supplier.country === 'IN' ? 'India' : 'United States',
    ].join('\n'),
    9,
  );
  text(supplier.email, 9);
  if (supplier.gstin) text(`Supplier GSTIN: ${supplier.gstin}`, 9);
  y -= 12;
  text(
    s.kind === 'invoice'
      ? 'BILL TO'
      : s.kind === 'refund_receipt'
        ? 'RETURNED TO'
        : ['credit_note', 'cancellation_statement'].includes(s.kind)
          ? 'ISSUED TO'
          : 'RECEIVED FROM',
    8,
    bold,
    gray,
  );
  text(buyer.name, 12, bold);
  if (buyer.address)
    text(
      [
        buyer.address,
        [buyer.city, indiaStates[buyer.state] || buyer.state, buyer.postalCode]
          .filter(Boolean)
          .join(', '),
        buyer.country === 'IN' ? 'India' : buyer.country === 'US' ? 'United States' : '',
      ]
        .filter(Boolean)
        .join('\n'),
      9,
    );
  if (buyer.gstin) text(`Buyer GSTIN: ${buyer.gstin}`, 9);
  rule();
  text(s.offeringTitle, 12, bold);
  text(`Order ${s.orderId} | Booked ${date(s.orderCreatedAt)}`, 8, regular, gray);
  if (s.context?.ticket) text(`Ticket: ${s.context.ticket} | Quantity: ${s.quantity}`, 9);
  if (s.context?.startsAt)
    text(
      `Workshop starts ${date(s.context.startsAt)}${s.context.venue ? ' | ' + s.context.venue : ''}`,
      9,
    );
  if (s.kind === 'invoice') {
    if (s.context?.tax.enabled) {
      text(
        `SAC: ${supplier.sac} | Place of supply: ${indiaStates[buyer.state] || buyer.state} (${buyer.state})`,
        9,
      );
      text('Reverse charge: No | Original for recipient', 9);
    }
    y -= 10;
    room(270);
    row('Subtotal', money(s.subtotal));
    if (s.discount) row('Discount', '-' + money(s.discount));
    row(s.context?.tax.enabled ? 'Taxable value' : 'Net value', money(s.subtotal - s.discount));
    for (const tax of s.taxLines)
      row(
        `${tax.name} (${s.context.taxRateBps / (tax.name === 'IGST' ? 100 : 200)}%)`,
        money(tax.amount),
      );
    rule();
    row('Invoice total', money(s.total), true);
    row('Applied payments at this payment record', money(s.paid));
    row('Balance at this payment record', money(s.remaining), true);
    text(
      'This invoice covers the full booking. Later payment receipts settle this invoice and do not add another sale.',
      9,
      regular,
      gray,
    );
  } else if (['credit_note', 'cancellation_statement'].includes(s.kind)) {
    y -= 12;
    if (s.originalInvoice)
      text(
        `Original invoice: ${s.originalInvoice.number} | Issued ${date(s.originalInvoice.issuedAt)}`,
        10,
        bold,
      );
    text(`Reason: ${s.cancellation.reason}`, 9);
    rule();
    for (const line of s.cancellation.lines) row(`Credited ${line.name}`, money(line.amount));
    row(
      s.kind === 'credit_note' ? 'Credit note total' : 'Booking value cancelled',
      money(s.cancellation.credit),
      true,
    );
    row('Amount retained for the cancelled booking', money(s.cancellation.retained));
    row('Refund approved from applied payments', money(s.cancellation.appliedRefund));
    if (s.cancellation.excess) row('Additional excess to return', money(s.cancellation.excess));
    row('Total refund obligation', money(s.cancellation.totalRefund), true);
    row('Remaining amount due from buyer', money(0));
    text(
      'Cancellation approval releases the booking and waives its unpaid balance. This document records the adjustment; it does not confirm that a refund reached the buyer. Separate refund confirmations record actual returns.',
      9,
      regular,
      gray,
    );
    if (s.kind === 'cancellation_statement')
      text('This is a booking cancellation statement, not a tax credit note.', 9, regular, gray);
  } else if (s.kind === 'refund_receipt') {
    y -= 12;
    row(
      s.refundKind === 'cancellation' ? 'Cancellation refund confirmed' : 'Excess payment returned',
      money(s.payment.amount),
      true,
    );
    text(
      `Confirmed ${date(s.payment.receivedAt)} | Method: ${String(s.payment.method).replaceAll('_', ' ')}`,
      9,
    );
    text(`Refund reference: ${s.payment.reference}`, 9);
    text(`Original payment: ${s.originalPaymentReference}`, 9);
    if (s.invoiceNumber) text(`Related invoice: ${s.invoiceNumber}`, 10, bold);
    rule();
    row('Booking total', money(s.total));
    row('Applied payments preserved', money(s.paid));
    text(
      s.refundKind === 'cancellation'
        ? 'This confirms one returned payment for the cancelled booking. Review its cancellation credit note or statement and any other refund confirmations for the full outcome.'
        : 'This confirms the return of an excess payment. It does not cancel the booking or reduce its invoice. This is not a tax credit note.',
      9,
      regular,
      gray,
    );
    text(
      'For provider refunds, bank posting time depends on the original payment method. Contact the academy with the refund reference if the return is not visible.',
      9,
      regular,
      gray,
    );
  } else {
    y -= 12;
    row('Amount received', money(s.payment.amount), true);
    text(
      `Received ${date(s.payment.receivedAt)} | Method: ${String(s.payment.method).replaceAll('_', ' ')}`,
      9,
    );
    text(`Payment reference: ${s.payment.reference}`, 9);
    text(
      s.payment.applied
        ? 'Recorded against this order.'
        : 'Awaiting reconciliation: this payment has not been applied to the order.',
      10,
      bold,
    );
    if (s.payment.bookingStatus === 'review_required')
      text('Booking confirmation is awaiting academy review. Do not pay again.', 9);
    if (s.invoiceNumber) text(`Related invoice: ${s.invoiceNumber}`, 10, bold);
    rule();
    room(175);
    text('ORDER TOTALS AT THIS PAYMENT RECORD', 8, bold, gray);
    row('Full order total', money(s.total));
    if (s.tax) for (const tax of s.taxLines) row(`Included order ${tax.name}`, money(tax.amount));
    row('Applied payments', money(s.paid));
    row('Remaining order balance', money(s.remaining));
    text(
      'Evidence of payment only. This receipt is not an additional tax invoice and does not itself confirm a seat, course access or tax credit.',
      9,
      regular,
      gray,
    );
  }
  y -= 12;
  text(`Billing questions: ${supplier.email}`, 9, regular, gray);
  const pages = doc.getPages();
  pages.forEach((p, index) => {
    p.drawText(`${s.number}  |  Page ${index + 1} of ${pages.length}`, {
      x: margin,
      y: 35,
      size: 8,
      font: regular,
      color: gray,
    });
  });
  return doc.save();
}
