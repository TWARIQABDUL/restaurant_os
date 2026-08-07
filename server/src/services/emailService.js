const { sendEmail } = require('../config/email');
const fs = require('fs');
const path = require('path');

/**
 * Load an HTML template and replace placeholders.
 */
function renderTemplate(templateName, data) {
  const templatePath = path.join(__dirname, '..', 'templates', `${templateName}.html`);

  try {
    let html = fs.readFileSync(templatePath, 'utf-8');

    for (const [key, value] of Object.entries(data)) {
      html = html.replace(new RegExp(`{{${key}}}`, 'g'), value || '');
    }

    return html;
  } catch {
    // Fallback to a simple text-based email if template is missing
    return `<div style="font-family: Inter, sans-serif; padding: 24px;">
      <h2>${data.title || 'Restaurant OS'}</h2>
      <p>${data.message || ''}</p>
      ${data.details || ''}
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

module.exports = { sendTemplatedEmail, renderTemplate };
