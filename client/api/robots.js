export default function handler(req, res) {
  const host = req.headers.host || 'restaurant-os-liart-rho.vercel.app';

  const robots = `User-agent: *
Allow: /

# Disallow dashboard/admin routes
Disallow: /admin
Disallow: /manager
Disallow: /delivery
Disallow: /super-admin
Disallow: /login
Disallow: /register

Sitemap: https://${host}/sitemap.xml
`;

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
  return res.status(200).send(robots);
}
