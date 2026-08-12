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
    
    const fetchRes = await fetch(`${apiUrl}/tenants/public/${slug}`);
    
    if (!fetchRes.ok) {
      throw new Error('Tenant not found');
    }
    
    const data = await fetchRes.json();
    const tenant = data.tenant;
    const seo = tenant.seo || {};

    const title = seo.seoTitle || tenant.name || 'Restaurant OS';
    const description = seo.seoDescription || `Order online from ${tenant.name}`;
    const keywords = seo.seoKeywords || '';
    const faviconUrl = seo.faviconUrl || '';
    const themeColor = seo.themeColor || '#ffffff';
    const twitterHandle = seo.twitterHandle || '';
    const ogLocale = seo.ogLocale || 'en_US';
    const author = seo.author || '';

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
    ${tenant.logo_url ? `<meta property="og:image" content="${tenant.logo_url}" />` : ''}
    <meta property="og:type" content="website" />
    <meta property="og:locale" content="${ogLocale}" />
    
    <!-- Twitter Card tags -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    ${tenant.logo_url ? `<meta name="twitter:image" content="${tenant.logo_url}" />` : ''}
    ${twitterHandle ? `<meta name="twitter:site" content="${twitterHandle}" />` : ''}
  </head>
  <body>
    <!-- This page is only served to web crawlers. Normal users get the React SPA. -->
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
