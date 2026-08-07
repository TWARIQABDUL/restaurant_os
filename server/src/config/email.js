const sgMail = require('@sendgrid/mail');

const apiKey = process.env.SENDGRID_API_KEY;
const emailFrom = process.env.EMAIL_FROM || 'noreply@restaurantos.com';

if (apiKey) {
  sgMail.setApiKey(apiKey);
} else {
  console.warn('SENDGRID_API_KEY not set — emails will be logged to console instead of sent');
}

/**
 * Send an email via SendGrid (or log it if API key is missing).
 */
async function sendEmail({ to, subject, html, text }) {
  const msg = {
    to,
    from: emailFrom,
    subject,
    html: html || text,
    text: text || '',
  };

  if (!apiKey) {
    console.log('[EMAIL - DEV MODE]', JSON.stringify({ to, subject }, null, 2));
    return;
  }

  try {
    await sgMail.send(msg);
    console.log(`Email sent to ${to}: ${subject}`);
  } catch (error) {
    console.error('SendGrid error:', error.response?.body || error.message);
  }
}

module.exports = { sendEmail, emailFrom };
