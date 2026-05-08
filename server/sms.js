import {
  getTwilioAccountSid,
  getTwilioAuthToken,
  getTwilioFromNumber,
  getTwilioMessagingServiceSid,
  getAlertPhone,
} from './config.js';
import { markSmsSent, wasSmsSentToday } from './db.js';
import twilio from 'twilio';

function getTwilioConfig() {
  const accountSid = getTwilioAccountSid();
  const authToken = getTwilioAuthToken();
  const from = getTwilioFromNumber();
  const messagingServiceSid = getTwilioMessagingServiceSid();
  const to = getAlertPhone();
  return { accountSid, authToken, from, messagingServiceSid, to };
}

/**
 * Build the Twilio sender argument. Messaging Service SID is preferred when configured
 * (recommended for A2P 10DLC and toll-free routing); FROM number is the fallback.
 */
function buildSenderPayload(messagingServiceSid, from) {
  if (messagingServiceSid) return { messagingServiceSid };
  if (from) return { from };
  return null;
}

export async function sendSMS(message, { alertType = 'general', eventKey = '', to: toOverride } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const type = String(alertType || 'general');
  const key = String(eventKey || '');
  try {
    if (await wasSmsSentToday(type, key, today)) {
      console.log(`[sms] skipped duplicate ${type}:${key} (${today})`);
      return { ok: true, skipped: true, reason: 'duplicate_today' };
    }
    const { accountSid, authToken, from, messagingServiceSid } = getTwilioConfig();
    const to = (toOverride || '').trim() || getAlertPhone();
    const sender = buildSenderPayload(messagingServiceSid, from);
    console.log(`[sms] attempting send`, {
      type,
      key,
      to,
      sender: messagingServiceSid
        ? `messagingServiceSid:${messagingServiceSid.slice(0, 6)}…`
        : from
          ? `from:${from}`
          : '(none)',
      sidPrefix: (accountSid || '').slice(0, 6),
      tokenSet: Boolean(authToken),
    });
    if (!accountSid || !authToken || !sender || !to) {
      console.log('[sms] skipped missing Twilio configuration', {
        hasSid: !!accountSid,
        hasToken: !!authToken,
        hasSender: !!sender,
        hasTo: !!to,
      });
      return { ok: false, skipped: true, reason: 'missing_config' };
    }
    const client = twilio(accountSid, authToken);
    const tw = await client.messages.create({
      ...sender,
      to,
      body: String(message || '').slice(0, 1500),
    });
    await markSmsSent(type, key, today);
    console.log(`[sms] sent ${type}:${key}`, { sid: tw?.sid || '', status: tw?.status || '' });
    return { ok: true, skipped: false, sid: tw?.sid || '', status: tw?.status || '' };
  } catch (e) {
    const errMsg = e?.message || String(e);
    const errCode = e?.code || '';
    const errMore = e?.moreInfo || e?.more_info || '';
    console.error('[sms] error', { code: errCode, message: errMsg, moreInfo: errMore });
    return { ok: false, skipped: false, reason: 'exception', error: errMsg, code: errCode, moreInfo: errMore };
  }
}

export async function sendTestSMS() {
  try {
    const { accountSid, authToken, from, messagingServiceSid, to } = getTwilioConfig();
    const sender = buildSenderPayload(messagingServiceSid, from);
    if (!accountSid || !authToken || !sender || !to) {
      return {
        success: false,
        error:
          'Missing Twilio config: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID (or TWILIO_FROM_NUMBER), ALERT_PHONE',
      };
    }
    const client = twilio(accountSid, authToken);
    const twilioResponse = await client.messages.create({
      ...sender,
      to,
      body: '✅ Tri Express SMS Test - Working!',
    });
    console.log('[sms:test] Twilio response', twilioResponse);
    return { success: true, messageId: twilioResponse?.sid || '' };
  } catch (e) {
    const error = e?.message || String(e);
    console.error('[sms:test] error', error);
    return { success: false, error };
  }
}
