import path from 'path';
import multer from 'multer';
import { ROOT } from './paths.js';
import { generateEstimateWithClaude } from './estimateAi.js';
import { insertCustomerLead } from './db.js';
import { sendSMS } from './sms.js';
import { getEstimateSmsTo, getCrmLeadsUrl } from './config.js';

const SERVICE_TYPES = new Set([
  'Water Heater Repair/Replace',
  'Leak Detection',
  'Repiping',
  'Drain Cleaning',
  'Slab Leak',
  'ADU Plumbing',
  'Tankless Water Heater',
  'Emergency Service',
  'Other',
]);

const CALL_TIME_OPTIONS = new Set(['morning', 'afternoon', 'evening', 'asap']);

const CALL_TIME_HUMAN = {
  morning: 'Morning (8am–12pm)',
  afternoon: 'Afternoon (12pm–5pm)',
  evening: 'Evening (5pm–7pm)',
  asap: 'ASAP – Emergency',
};

/** Rough San Diego County + adjacent service ZIP prefixes */
function isLikelyServiceZip(zip) {
  const z = String(zip || '').replace(/\D/g, '').slice(0, 5);
  if (z.length !== 5) return false;
  const p = z.slice(0, 3);
  const ok = new Set([
    '919',
    '920',
    '921',
    '922',
    '925',
    '926',
    '928',
    '930',
    '931',
    '932',
    '934',
    '935',
    '936',
    '940',
  ]);
  return ok.has(p);
}

/**
 * Normalize a US phone string to Twilio-friendly E.164.
 * Returns null if the input doesn't yield a 10/11-digit US number.
 */
function toE164US(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (raw.startsWith('+')) {
    const digits = raw.replace(/\D/g, '');
    return digits.length >= 10 ? `+${digits}` : null;
  }
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 3 },
  fileFilter(_req, file, cb) {
    const name = String(file.originalname || '');
    const mime = String(file.mimetype || '').toLowerCase();
    const extOk = /\.(jpe?g|png|heic|heif|webp)$/i.test(name);
    const mimeOk = /image\/(jpeg|jpg|png|heic|heif|webp)/i.test(mime);
    if (extOk || mimeOk) return cb(null, true);
    cb(new Error('Photos must be JPG, PNG, HEIC, or WebP.'));
  },
});

const uploadAnalyze = upload.array('photos', 3);
const uploadSubmit = upload.array('photos', 3);

function runUpload(mw) {
  return (req, res, next) => {
    mw(req, res, (err) => {
      if (err) {
        const msg = err.message || 'Upload failed';
        const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(code).json({ error: msg });
      }
      next();
    });
  };
}

function requireFields(body, keys) {
  const missing = keys.filter((k) => !String(body[k] ?? '').trim());
  if (missing.length) throw new Error(`Missing: ${missing.join(', ')}`);
}

/**
 * Owner SMS body — alert to ALERT_PHONE / ESTIMATE_SMS_TO.
 */
function buildOwnerSmsBody({
  name,
  phone,
  service,
  zip,
  estimatedRange,
  callTimeHuman,
  description,
  crmUrl,
}) {
  const desc100 = String(description || '').slice(0, 100);
  return [
    '🔧 NEW ESTIMATE LEAD!',
    `Name: ${name}`,
    `Phone: ${phone}`,
    `Service: ${service}`,
    `ZIP: ${zip}`,
    `Estimate: ${estimatedRange || 'see CRM'}`,
    `Call time: ${callTimeHuman}`,
    `Description: ${desc100}`,
    crmUrl ? `View in CRM: ${crmUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Customer confirmation SMS — sent to the phone number the customer entered.
 */
function buildCustomerSmsBody({ name, service }) {
  const firstName = String(name || '').trim().split(/\s+/)[0] || name;
  return [
    `Hi ${firstName}! Tri Express Plumbing received your estimate request for ${service}.`,
    'A technician will call you within 1 hour to confirm your exact quote.',
    'Questions? Call us: (619) 843-6692',
    'CA Lic #926629',
  ].join('\n');
}

/**
 * @param {import('express').Express} app
 */
export function registerEstimateRoutes(app) {
  app.get('/estimate-widget.html', (_req, res) => {
    res.sendFile(path.join(ROOT, 'estimate-widget.html'));
  });

  app.post('/api/estimate/analyze', runUpload(uploadAnalyze), async (req, res) => {
    try {
      const { name, phone, email, service, description, zipcode } = req.body || {};
      requireFields({ name, phone, email, service, zipcode }, ['name', 'phone', 'email', 'service', 'zipcode']);
      if (!SERVICE_TYPES.has(String(service).trim())) {
        return res.status(400).json({ error: 'Invalid service type.' });
      }
      const zip = String(zipcode).trim();
      if (!/^\d{5}$/.test(zip)) {
        return res.status(400).json({ error: 'Please enter a valid 5-digit ZIP code.' });
      }
      if (!isLikelyServiceZip(zip)) {
        return res.status(400).json({
          error:
            'That ZIP may be outside our primary San Diego County service area. Call (619) 843-6692 and we will confirm.',
        });
      }
      const files = (req.files || []).map((f) => ({
        buffer: f.buffer,
        mimetype: f.mimetype,
        originalname: f.originalname,
      }));
      const { displayText, meta } = await generateEstimateWithClaude({
        name: String(name).trim(),
        phone: String(phone).trim(),
        email: String(email).trim(),
        service: String(service).trim(),
        description: String(description || '').trim(),
        zipcode: zip,
        files,
      });
      res.json({
        ok: true,
        estimateText: displayText,
        estimated_range: meta.estimated_range || '',
        urgency_level: meta.urgency_level || '',
      });
    } catch (e) {
      console.error('[estimate/analyze]', e);
      res.status(500).json({ error: e.message || 'Estimate failed' });
    }
  });

  app.post('/api/estimate/submit', runUpload(uploadSubmit), async (req, res) => {
    console.log('[estimate-submit] endpoint hit', {
      hasBody: !!req.body,
      keys: Object.keys(req.body || {}),
      contentType: req.headers['content-type'],
      origin: req.headers.origin || req.headers.referer || '(none)',
      photos: (req.files || []).length,
    });
    console.log('[estimate-submit] ALERT_PHONE:', process.env.ALERT_PHONE);
    console.log('[estimate-submit] TWILIO_FROM_NUMBER:', process.env.TWILIO_FROM_NUMBER);
    console.log(
      '[estimate-submit] TWILIO_MESSAGING_SERVICE_SID:',
      (process.env.TWILIO_MESSAGING_SERVICE_SID || '').slice(0, 8) + '…'
    );
    console.log('[estimate-submit] TWILIO_ACCOUNT_SID:', (process.env.TWILIO_ACCOUNT_SID || '').slice(0, 6) + '…');
    try {
      const {
        name,
        phone,
        email,
        service,
        description,
        zipcode,
        call_time_preference,
        ai_estimate,
      } = req.body || {};
      requireFields(
        { name, phone, email, service, zipcode, call_time_preference, ai_estimate },
        ['name', 'phone', 'email', 'service', 'zipcode', 'call_time_preference', 'ai_estimate']
      );
      if (!SERVICE_TYPES.has(String(service).trim())) {
        return res.status(400).json({ error: 'Invalid service type.' });
      }
      const pref = String(call_time_preference).trim().toLowerCase();
      if (!CALL_TIME_OPTIONS.has(pref)) {
        return res.status(400).json({ error: 'Invalid call time preference.' });
      }
      const zip = String(zipcode).trim();
      if (!/^\d{5}$/.test(zip)) {
        return res.status(400).json({ error: 'Invalid ZIP code.' });
      }
      const estimateFull = String(ai_estimate).trim();
      if (estimateFull.length < 20) {
        return res.status(400).json({ error: 'AI estimate text is missing or too short.' });
      }

      const metaMatch = estimateFull.match(/\nMETA_JSON:\s*\{[\s\S]*\}\s*$/);
      const estimateForDisplay = metaMatch ? estimateFull.slice(0, metaMatch.index).trim() : estimateFull;
      let estimated_range = '';
      let urgency_level = '';
      if (metaMatch) {
        try {
          const j = JSON.parse(metaMatch[0].replace(/^\nMETA_JSON:\s*/, '').trim());
          estimated_range = String(j.estimated_range || j.estimatedRange || '').trim();
          urgency_level = String(j.urgency || j.urgency_level || '').trim();
        } catch {
          /* ignore */
        }
      }
      if (!estimated_range) {
        const m = estimateForDisplay.match(/\$[\d,]+(?:\s*-\s*\$?[\d,]+)?/);
        if (m) estimated_range = m[0].replace(/\s+/g, '');
      }
      if (!urgency_level) urgency_level = '—';

      const files = req.files || [];
      const photosCount = files.length;
      const cleanName = String(name).trim();
      const cleanPhone = String(phone).trim();
      const cleanEmail = String(email).trim();
      const cleanService = String(service).trim();
      const cleanDescription = String(description || '').trim();

      console.log('[estimate] Submission received:', {
        name: cleanName,
        phone: cleanPhone,
        email: cleanEmail,
        service: cleanService,
        zip,
        photos: photosCount,
        callTime: pref,
      });

      const row = await insertCustomerLead({
        name: cleanName,
        phone: cleanPhone,
        email: cleanEmail,
        service_type: cleanService,
        description: cleanDescription,
        zipcode: zip,
        ai_estimate: estimateFull,
        estimated_range,
        urgency_level,
        photos_count: photosCount,
        call_time_preference: pref,
        status: 'new',
      });

      const callTimeHuman = CALL_TIME_HUMAN[pref];
      const crmUrl = getCrmLeadsUrl();

      const notifications = {
        ownerSms: { ok: false, reason: 'pending' },
        customerSms: { ok: false, reason: 'pending' },
      };

      // 1. Owner alert SMS
      try {
        const smsTo = getEstimateSmsTo();
        console.log('[estimate-submit] sending owner SMS to:', smsTo, '(env ALERT_PHONE:', process.env.ALERT_PHONE, ')');
        const smsBody = buildOwnerSmsBody({
          name: cleanName,
          phone: cleanPhone,
          service: cleanService,
          zip,
          estimatedRange: estimated_range,
          callTimeHuman,
          description: cleanDescription,
          crmUrl,
        });
        const smsResult = await sendSMS(smsBody, {
          alertType: 'ai_estimate_lead',
          eventKey: `customer_lead:${row.id}`,
          to: smsTo,
        });
        console.log('[estimate-submit] Twilio owner result:', JSON.stringify(smsResult));
        notifications.ownerSms = smsResult;
      } catch (e) {
        console.error('[estimate-submit] Twilio owner error:', e?.message || e);
        notifications.ownerSms = { ok: false, error: e?.message || String(e) };
      }

      // 2. Customer confirmation SMS — to the phone they entered
      try {
        const customerTo = toE164US(cleanPhone);
        console.log('[estimate-submit] sending customer SMS to:', customerTo, '(raw:', cleanPhone, ')');
        if (!customerTo) {
          notifications.customerSms = { ok: false, reason: 'invalid_phone', input: cleanPhone };
          console.warn('[estimate-submit] customer phone could not be normalized to E.164');
        } else {
          const customerBody = buildCustomerSmsBody({ name: cleanName, service: cleanService });
          const customerResult = await sendSMS(customerBody, {
            alertType: 'ai_estimate_customer',
            eventKey: `customer_confirm:${row.id}`,
            to: customerTo,
          });
          console.log('[estimate-submit] Twilio customer result:', JSON.stringify(customerResult));
          notifications.customerSms = customerResult;
        }
      } catch (e) {
        console.error('[estimate-submit] Twilio customer error:', e?.message || e);
        notifications.customerSms = { ok: false, error: e?.message || String(e) };
      }

      const customerMessagePref = {
        morning: 'during the morning (8am–12pm)',
        afternoon: 'during the afternoon (12pm–5pm)',
        evening: 'in the evening (5pm–7pm)',
        asap: 'right away — a Tri Express technician will prioritize your call',
      }[pref];

      res.json({
        ok: true,
        leadId: row.id,
        message: `Perfect! A Tri Express technician will call you ${customerMessagePref}. We just sent you a confirmation text!`,
        notifications,
      });
    } catch (e) {
      console.error('[estimate/submit]', e);
      res.status(500).json({ error: e.message || 'Submit failed' });
    }
  });

  app.post('/api/estimate/test-notifications', async (req, res) => {
    const result = { ownerSms: null, customerSms: null };
    const stamp = new Date().toISOString();
    const eventKey = `test:${Date.now()}`;
    const crmUrl = getCrmLeadsUrl();
    const customerPhoneOverride = String(req.body?.customer_phone || '').trim();

    // Owner test SMS
    try {
      const smsTo = getEstimateSmsTo();
      console.log('[estimate/test] Sending owner SMS to:', smsTo);
      const smsResult = await sendSMS(
        [
          '🔧 Tri Express Alert: notification test',
          `Stamp: ${stamp}`,
          `From: /api/estimate/test-notifications`,
          `CRM: ${crmUrl}`,
        ].join('\n'),
        { alertType: 'ai_estimate_test', eventKey, to: smsTo }
      );
      console.log('[estimate/test] Owner SMS result:', smsResult);
      result.ownerSms = smsResult;
    } catch (e) {
      console.error('[estimate/test] Owner SMS error:', e?.message || e);
      result.ownerSms = { ok: false, error: e?.message || String(e) };
    }

    // Optional customer test SMS if `customer_phone` provided
    if (customerPhoneOverride) {
      try {
        const customerTo = toE164US(customerPhoneOverride);
        console.log('[estimate/test] Sending customer SMS to:', customerTo);
        if (!customerTo) {
          result.customerSms = { ok: false, reason: 'invalid_phone', input: customerPhoneOverride };
        } else {
          const customerResult = await sendSMS(
            buildCustomerSmsBody({ name: 'Test Customer', service: 'Drain Cleaning' }),
            {
              alertType: 'ai_estimate_customer_test',
              eventKey: `customer_test:${eventKey}`,
              to: customerTo,
            }
          );
          console.log('[estimate/test] Customer SMS result:', customerResult);
          result.customerSms = customerResult;
        }
      } catch (e) {
        console.error('[estimate/test] Customer SMS error:', e?.message || e);
        result.customerSms = { ok: false, error: e?.message || String(e) };
      }
    }

    res.json({
      ok: true,
      stamp,
      smsTo: getEstimateSmsTo(),
      result,
    });
  });
}
