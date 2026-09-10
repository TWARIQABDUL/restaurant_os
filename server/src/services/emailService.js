const { sendEmail } = require('../config/email');
const fs = require('fs');
const path = require('path');

/**
 * HTML-escape a template value.
 *
 * Template data is not ours: {{customerName}} comes from guest_name on an
 * unauthenticated order, {{reason}} from whatever staff typed. Substituted raw,
 * either one could put working markup — a link, a fake support block, a
 * tracking pixel — into mail our domain signs and sends.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Load an HTML template and replace placeholders.
 */
function renderTemplate(templateName, data) {
  const templatePath = path.join(__dirname, '..', 'templates', `${templateName}.html`);
  const safe = Object.fromEntries(
    Object.entries(data || {}).map(([key, value]) => [key, escapeHtml(value)])
  );

  try {
    let html = fs.readFileSync(templatePath, 'utf-8');

    for (const [key, value] of Object.entries(safe)) {
      // A replacer FUNCTION, not a string: in a string replacement `$&`, `$'`
      // and `$1` are substitution patterns, so a customer named `$'` would
      // splice the rest of the template back into itself.
      html = html.replace(new RegExp(`{{${key}}}`, 'g'), () => value);
    }

    return html;
  } catch {
    // Fallback to a simple text-based email if template is missing
    return `<div style="font-family: Inter, sans-serif; padding: 24px;">
      <h2>${safe.title || 'Restaurant OS'}</h2>
      <p>${safe.message || ''}</p>
      ${safe.details || ''}
    </div>`;
  }
}

/**
 * Send a templated email.
 */
async function sendTemplatedEmail({ to, subject, template, data }) {
  if (!to) return;

  const html = renderTemplate(template, data);
  await sendEmail({ to, subject, html });
}

module.exports = { sendTemplatedEmail, renderTemplate, escapeHtml };
