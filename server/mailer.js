import nodemailer from 'nodemailer';
import {
  getSmtpHost,
  getSmtpPort,
  getSmtpUser,
  getSmtpPass,
  getSmtpFromName,
  getKevinFromEmail,
  isSmtpConfigured,
} from './config.js';

export function createMailTransport() {
  if (!isSmtpConfigured()) {
    throw new Error('SMTP is not configured. Add SMTP settings in Settings or .env.');
  }
  const port = getSmtpPort();
  return nodemailer.createTransport({
    host: getSmtpHost(),
    port,
    secure: port === 465,
    auth: {
      user: getSmtpUser(),
      pass: getSmtpPass(),
    },
    tls: {
      minVersion: 'TLSv1.2',
    },
  });
}

/**
 * @param {{ to: string; toName?: string; subject: string; text: string; html?: string }} opts
 */
export async function sendTransactionalEmail(opts) {
  const transport = createMailTransport();
  const fromEmail = getKevinFromEmail();
  const fromName = getSmtpFromName();
  const from = fromName ? `"${fromName.replace(/"/g, '')}" <${fromEmail}>` : fromEmail;
  const to =
    opts.toName && opts.toName.trim()
      ? `"${String(opts.toName).replace(/"/g, '')}" <${opts.to}>`
      : opts.to;
  const info = await transport.sendMail({
    from,
    to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html || undefined,
  });
  return { messageId: info.messageId || info.response || '' };
}
