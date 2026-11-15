// client/src/storefront/manualMomo.ts — the USSD code and WhatsApp link for a momo_manual order.
//
// ONE PLACE BUILDS THE ACTUAL LINKS, because CheckoutPage.tsx (right after placing) and TrackPage.tsx
// (a reminder on reload, before it's confirmed) both need to show them, and this touches real money — the
// USSD string and the two should never be free to drift from each other.

/** `*182*1*1*<number>*<amount>#` — MTN Rwanda's "send to a MoMo number" code. */
export function manualMomoUssd(momoNumber: string, total: string): string {
  const digits = momoNumber.replace(/\D/g, '');
  // Whole units only — RWF has no practical use for cents here, and a decimal point would not dial.
  const amount = String(Math.round(Number(total)));
  return `*182*1*1*${digits}*${amount}#`;
}

/** A `tel:` link that opens the dialer with the USSD code pre-filled, ready to press call. */
export function manualMomoTelHref(momoNumber: string, total: string): string {
  return `tel:${encodeURIComponent(manualMomoUssd(momoNumber, total))}`;
}

/** A `wa.me` link that opens a chat with the store's WhatsApp number, pre-filled with the order number. */
export function manualMomoWhatsappHref(whatsapp: string, orderNumber: number): string {
  const digits = whatsapp.replace(/\D/g, '');
  const message = `Hi, here is my payment proof for order #${orderNumber}.`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
