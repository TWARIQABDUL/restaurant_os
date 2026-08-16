export default async function handler(req, res) {
  const host = req.headers.host || 'restaurant-os-liart-rho.vercel.app';
  const baseUrl = `https://${host}`;
  const apiUrl = process.env.VITE_API_URL || 'http://localhost:5000/api';

  try {
    // Fetch all public tenant slugs from the backend
    const fetchRes = await fetch(`${apiUrl}/tenants/public`);
    let tenantUrls = '';

    if (fetchRes.ok) {
      const data = await fetchRes.json();
      const tenants = data.tenants || [];

      tenantUrls = tenants.map(tenant => `
  <url>
    <loc>${baseUrl}/${tenant.slug}</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>`).join('');
    }

    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>${tenantUrls}
</urlset>`;

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    return res.status(200).send(sitemap);

  } catch (error) {
    console.error('Sitemap generation error:', error);

    // Minimal fallback sitemap with just the homepage
    const fallback = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`;

    res.setHeader('Content-Type', 'application/xml');
    return res.status(200).send(fallback);
  }
}
