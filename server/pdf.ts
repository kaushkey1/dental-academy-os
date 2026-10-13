import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { origin } from './config.ts';
import type { Row } from './db.ts';
export async function certificatePdf(cert: Row, tenant: Row) {
  const doc = await PDFDocument.create(),
    page = doc.addPage([842, 595]);
  const font = await doc.embedFont(StandardFonts.Helvetica),
    serif = await doc.embedFont(StandardFonts.TimesRoman);
  const color = rgb(0.09, 0.3, 0.26),
    s = cert.snapshot;
  const clean = (v: any) => String(v).replace(/[^\x20-\x7E]/g, ' ');
  const center = (v: any, y: number, size: number, f = font) => {
    const value = clean(v);
    const fit = Math.min(size, 710 / Math.max(1, f.widthOfTextAtSize(value, 1)));
    page.drawText(value, {
      x: (842 - f.widthOfTextAtSize(value, fit)) / 2,
      y,
      size: fit,
      font: f,
      color,
    });
  };
  page.drawRectangle({ x: 24, y: 24, width: 794, height: 547, borderColor: color, borderWidth: 1 });
  center(s.sample ? 'SAMPLE CERTIFICATE - NOT VALID FOR CREDIT' : s.academy, 520, 14);
  center('Certificate of Completion', 448, 36, serif);
  center('Presented to', 397, 12);
  center(s.name, 348, 32, serif);
  center('for completing', 304, 12);
  center(s.program, 268, 24, serif);
  center(
    `${s.credits} ${s.creditType} credits  |  ${s.kind === 'course' ? 'Self-study' : s.venue}`,
    226,
    13,
  );
  center(
    new Date(s.date).toLocaleDateString('en-GB', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
    198,
    12,
  );
  center(s.framework?.accreditation || '', 169, 11);
  center(cert.serial, 80, 10);
  const png = await QRCode.toBuffer(`${origin}/verify/${tenant.slug}/${cert.verification_code}`, {
    width: 100,
    margin: 1,
  });
  const qr = await doc.embedPng(png);
  page.drawImage(qr, { x: 690, y: 54, width: 78, height: 78 });
  doc.setTitle('Certificate - ' + clean(s.program));
  return doc.save();
}
