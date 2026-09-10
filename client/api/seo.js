// Everything below is interpolated into HTML that we serve from our own
// domain, and every value in it is tenant-controlled — a tenant admin sets the
// SEO fields, and tenant signup is self-serve. So none of it can be trusted as
// markup.

/** Text position: <title>, <h1>, <p>. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Attribute position: content="...", href="...".
 *
 * Same escaping — the quote is what matters here — but kept as its own function
 * so the call site says which context it is in, and so tightening one context
 * later doesn't silently change the other.
 */
const escapeAttr = escapeHtml;

/**
 * A URL safe to put in href/src. Anything that isn't plainly http(s) becomes
 * empty rather than being rendered, which rules out javascript: and data:.
 */
function safeUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return escapeAttr(url.href);
  } catch {
    return '';
  }
}

/**
 * JSON-LD sits inside a <script> block, where the HTML parser looks for the
 * literal string "</script" before the JS parser ever runs. JSON.stringify does
 * not escape '/', so an unescaped tenant name containing </script> closes the
 * block and everything after it becomes markup. Escaping '<' as \u003c is
 * valid JSON, parses back to the same string, and cannot close the block.
 */
function safeJsonLd(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export default async function handler(req, res) {
  // Extract slug from URL. The Vercel rewrite passes the original URL path
  const pathParts = req.url.split('?')[0].split('/').filter(Boolean);
  const slug = pathParts[0];

  // If it's a global route or an asset, just return a generic empty response
  // (though the vercel.json rewrite should theoretically only catch storefront requests)
  if (!slug || ['login', 'register', 'admin', 'manager', 'delivery'].includes(slug) || slug.includes('.')) {
    return res.status(200).send('<html><head><title>Restaurant OS</title></head><body></body></html>');
  }

  try {
    // Determine backend URL from Vercel Environment Variables
    const apiUrl = process.env.VITE_API_URL || 'http://localhost:5000/api';
    
    const fetchRes = await fetch(`${apiUrl}/tenants/public/${encodeURIComponent(slug)}`);
    
    if (!fetchRes.ok) {
      throw new Error('Tenant not found');
    }
    
    const data = await fetchRes.json();
    const tenant = data.tenant;
    const seo = tenant.seo || {};

    // Raw values, for the JSON-LD payload (escaped by safeJsonLd on the way out).
    const rawTitle = seo.seoTitle || tenant.name || 'Restaurant OS';
    const rawDescription = seo.seoDescription || `Order online from ${tenant.name}`;
    const rawKeywords = seo.seoKeywords || '';
    const rawAuthor = seo.author || '';

    // Escaped values, for the HTML.
    const title = escapeHtml(rawTitle);
    const description = escapeHtml(rawDescription);
    const keywords = escapeAttr(rawKeywords);
    const faviconUrl = safeUrl(seo.faviconUrl);
    const themeColor = escapeAttr(seo.themeColor || '#ffffff');
    const twitterHandle = escapeAttr(seo.twitterHandle || '');
    const ogLocale = escapeAttr(seo.ogLocale || 'en_US');
    const author = escapeAttr(rawAuthor);

    const imageUrl = safeUrl(tenant.logo_url) || faviconUrl || '';
    // The host header is attacker-controllable on some proxies, so escape it
    // rather than trusting it into an attribute.
    const currentUrl = escapeAttr(
      `https://${req.headers.host || 'restaurant-os-liart-rho.vercel.app'}/${encodeURIComponent(slug)}`
    );

    // JSON-LD structured data for Google Rich Results
    const jsonLd = safeJsonLd({
      "@context": "https://schema.org",
      "@type": "Restaurant",
      "name": tenant.name,
      "description": rawDescription,
      "url": currentUrl,
      ...(imageUrl && { "image": imageUrl }),
      ...(rawAuthor && { "author": { "@type": "Organization", "name": rawAuthor } }),
      "servesCuisine": rawKeywords || "Food",
      "hasMenu": `${currentUrl}#menu`,
      "potentialAction": {
        "@type": "OrderAction",
        "target": {
          "@type": "EntryPoint",
          "urlTemplate": currentUrl
        },
        "deliveryMethod": "http://purl.org/goodrelations/v1#DeliveryModeDirectDownload"
      }
    });

    // Generate a lightweight HTML page for crawlers
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    ${faviconUrl ? `<link rel="icon" href="${faviconUrl}" />` : ''}
    <meta name="theme-color" content="${themeColor}" />
    <meta name="description" content="${description}" />
    ${keywords ? `<meta name="keywords" content="${keywords}" />` : ''}
    ${author ? `<meta name="author" content="${author}" />` : ''}
    
    <!-- Open Graph tags for social sharing -->
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    ${imageUrl ? `<meta property="og:image" content="${imageUrl}" />` : ''}
    <meta property="og:url" content="${currentUrl}" />
    <meta property="og:type" content="restaurant" />
    <meta property="og:locale" content="${ogLocale}" />
    
    <!-- Twitter Card tags -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    ${imageUrl ? `<meta name="twitter:image" content="${imageUrl}" />` : ''}
    ${twitterHandle ? `<meta name="twitter:site" content="${twitterHandle}" />` : ''}

    <!-- JSON-LD Structured Data for Google Rich Results -->
    <script type="application/ld+json">${jsonLd}</script>
  </head>
  <body>
    <!-- This page is only served to web crawlers. Normal users get the React SPA. -->
    <h1>${title}</h1>
    <p>${description}</p>
  </body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
    return res.status(200).send(html);

  } catch (error) {
    console.error('SEO Generator Error:', error);
    // Fallback to generic tags
    return res.status(200).send(`<!doctype html>
<html>
  <head>
    <title>Restaurant OS</title>
  </head>
  <body></body>
</html>`);
  }
}
