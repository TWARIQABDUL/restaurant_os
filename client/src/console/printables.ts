// client/src/console/printables.ts — milestone 28, from project/PrintExports.dc.html: the two things that leave the screen on paper.
//
//   receiptHtml   the kitchen / counter receipt — "80 mm thermal, black only, no brand colour. Prints from the order drawer."
//   posterHtml    the store QR poster — "A5 or A4, brand colour band"
//
// EACH IS A COMPLETE, SELF-CONTAINED HTML DOCUMENT AS A STRING, printed from a hidden frame (`printHtml`), and not a React tree on the
// page. A receipt has to come out the same on a thermal printer, an office laser and "Save as PDF", on a phone or a counter tablet,
// whatever the console around it looks like — which means no stylesheet of ours, no tokens, and no dependence on the page being
// printed from. That is also why the colours below are literals: a printer has exactly black and white, and the poster's one brand
// colour arrives as DATA (the store's own), the same way a theme's colours do. These strings are not part of the stylesheet the style
// rules govern.
//
// EVERYTHING INTERPOLATED IS ESCAPED. A customer's name, a note and a product name are typed by strangers; in a document written with a
// template string an unescaped `<script>` would run in the merchant's browser. `esc` is the only way a value reaches the markup.

import qrcode from 'qrcode-generator';

export const esc = (v: string | number | null | undefined): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export type ReceiptInput = {
  store: { name: string; address: string | null; phone: string | null; slug: string };
  host: string;
  order: {
    number: number;
    placedAt: string;
    fulfilment: 'delivery' | 'pickup';
    customer: string;
    address: string | null;
    lines: { quantity: number; productName: string; variantLabel: string; optionLabels: string[]; lineTotal: string }[];
    total: string;
    paymentMethod: string;
    paymentStatus: 'unpaid' | 'paid' | 'refunded';
    riderName: string | null;
  };
  timeZone: string;
  currencyCode: string;
};

const METHOD: Record<string, string> = { cash: 'Cash on delivery', mtn_momo: 'MTN MoMo', airtel_money: 'Airtel Money', mpesa: 'M-Pesa' };

/** "23/09/26 13:58" in the STORE's clock, not the printing device's. */
export function receiptStamp(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
  const g = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('day')}/${g('month')}/${g('year')} ${g('hour')}:${g('minute')}`;
}

const grouped = (v: string): string => String(Math.round(Number(v))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function receiptHtml(r: ReceiptInput): string {
  const o = r.order;
  const where = o.fulfilment === 'pickup' ? 'Pickup' : `Delivery${o.address === null ? '' : ` · ${o.address}`}`;
  const lines = o.lines
    .map((l) => `<div class="row"><span>${l.quantity} ${esc(l.productName)}${l.variantLabel === '' ? '' : ` · ${esc(l.variantLabel)}`}</span><span>${grouped(l.lineTotal)}</span></div>${l.optionLabels.map((x) => `<div class="opt">+ ${esc(x)}</div>`).join('')}`)
    .join('');
  const unpaid = o.paymentStatus === 'unpaid';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Order #${o.number}</title><style>
@page{size:80mm auto;margin:4mm}
*{box-sizing:border-box}
body{margin:0;width:72mm;font:12px/1.35 'Courier New',ui-monospace,monospace;color:#000;background:#fff}
.c{text-align:center}.b{font-weight:700}.rule{border-top:1px dashed #000;margin:6px 0}
.row{display:flex;justify-content:space-between;gap:8px}.opt{padding-left:10px}
.total{font-size:15px;font-weight:700}.tag{border:1px solid #000;padding:0 4px;font-weight:700}
</style></head><body>
<div class="c"><div class="b" style="font-size:15px">${esc(r.store.name.toUpperCase())}</div>${r.store.address === null && r.store.phone === null ? '' : `<div>${esc([r.store.address, r.store.phone].filter(Boolean).join(' · '))}</div>`}</div>
<div class="rule"></div>
<div class="row"><span class="b">Order #${o.number}</span><span>${esc(receiptStamp(o.placedAt, r.timeZone))}</span></div>
<div>${esc(where)}</div><div>${esc(o.customer)}</div>
<div class="rule"></div>${lines}<div class="rule"></div>
<div class="row total"><span>TOTAL ${esc(r.currencyCode)}</span><span>${grouped(o.total)}</span></div>
<div class="row"><span>${esc(METHOD[o.paymentMethod] ?? o.paymentMethod)}</span><span class="${unpaid ? 'tag' : 'b'}">${o.paymentStatus === 'refunded' ? 'REFUNDED' : unpaid ? 'UNPAID' : 'PAID'}</span></div>
<div class="rule"></div>
${o.riderName === null ? '' : `<div>Rider: ${esc(o.riderName)}</div>`}
<div class="c" style="margin-top:6px">Thank you! Order again at<br>${esc(r.host)}/${esc(r.store.slug)}</div>
</body></html>`;
}

export type PosterInput = {
  store: { name: string; address: string | null; phone: string | null; slug: string };
  host: string;
  /** Opening hours as one line, e.g. "Mon–Sun 10:00–22:00" — or null when none are set. */
  hours: string | null;
  /** The store's brand colour and the colour that reads on it — both from the compiled theme, so the band is always legible. */
  brand: string;
  onBrand: string;
};

/** The QR code for a URL as an inline SVG (no network, no image file, prints crisp at any size). Error correction M: a poster gets creased. */
export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
}

export function posterHtml(p: PosterInput, svg: string): string {
  const url = `${p.host}/${p.store.slug}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(p.store.name)} — QR poster</title><style>
@page{size:A5 portrait;margin:0}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font-family:'Figtree',system-ui,-apple-system,'Segoe UI',sans-serif;color:#17160F;background:#fff;display:flex;flex-direction:column;width:148mm;min-height:210mm;margin:0 auto}
.band{background:${esc(p.brand)};color:${esc(p.onBrand)};padding:16mm 12mm 12mm;text-align:center;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.band small{display:block;letter-spacing:.18em;font-weight:700;font-size:11pt}
.band strong{display:block;font-size:30pt;line-height:1.05;margin:3mm 0}
.band span{font-size:12pt}
.qr{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5mm;padding:8mm}
.qr svg{width:78mm;height:78mm}
.qr b{font-size:16pt}
.foot{display:flex;justify-content:space-between;padding:6mm 12mm 10mm;font-size:11pt;border-top:1px solid #ccc}
</style></head><body>
<div class="band"><small>ORDER ONLINE</small><strong>${esc(p.store.name)}</strong><span>Scan, order, pay with MoMo. Delivered or ready to collect.</span></div>
<div class="qr" role="img" aria-label="QR code for ${esc(url)}">${svg}<b>${esc(url)}</b></div>
<div class="foot"><span>${esc(p.hours ?? '')}</span><span>${esc(p.store.phone ?? '')}</span></div>
</body></html>`;
}

/** Prints a document from a hidden frame so the page behind it is never part of the paper. Cleans up after itself. */
export function printHtml(html: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  frame.srcdoc = html;
  frame.onload = () => {
    const w = frame.contentWindow;
    if (w === null) return;
    w.focus();
    w.print();
    // Printing is asynchronous in some browsers; removing the frame too soon prints a blank page.
    window.setTimeout(() => frame.remove(), 60_000);
  };
  document.body.appendChild(frame);
}
