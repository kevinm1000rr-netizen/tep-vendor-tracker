import Anthropic from '@anthropic-ai/sdk';
import { getApiKey } from './config.js';

/** Model for customer-facing estimates (vision). Override with ESTIMATE_ANTHROPIC_MODEL. */
export const DEFAULT_ESTIMATE_MODEL = 'claude-sonnet-4-5';

export function getEstimateAnthropicModel() {
  return (process.env.ESTIMATE_ANTHROPIC_MODEL || '').trim() || DEFAULT_ESTIMATE_MODEL;
}

const ESTIMATE_SYSTEM = `You are a friendly plumbing estimate assistant for Tri Express Plumbing, a licensed San Diego plumbing company (CA Lic #926629, 17 years experience).

Analyze the customer's photos and description and provide:
1. What you think the issue is (plain English)
2. Estimated price RANGE (be conservative, give a range — not an exact number)
3. Urgency level — must be one of EMERGENCY (Call Now), URGENT (Within 24-48 hours), or SCHEDULE (Within 1-2 weeks)
4. What the job typically involves
5. A warm reassuring closing line

PRICING GUIDELINES (Tri Express Plumbing — San Diego, real published ranges — never quote lower than the minimums below):

- Water Heater — Electric (30 gal): $1,200 - $2,700
- Water Heater — Gas (30 gal): $1,900 - $3,500
- Tankless Water Heater: $1,800 - $6,000 (range depends on brand, size, gas vs electric — always say so)
- Leak Detection: $275 flat fee (includes full diagnostic)
- Slab Leak Repair: starting from $1,500 (final price depends on access and complexity — always say "starting from")
- Whole House Repipe: starting from $6,500 (depends on home size and material — always say "starting from")
- Drain Cleaning: $350/hour, 2-hour minimum (most jobs run 2-3 hours; quote a 2- to 3-hour window: roughly $700-$1,050)
- Service Call — Normal Hours (Mon–Fri 7am–6pm): $229
- Service Call — After Hours (evenings, weekends, holidays): $329
- ADU Plumbing Rough-in: $12,000 - $25,000 (depends on ADU size and complexity)
- Toilet Repair/Replace: $200 - $600
- Faucet Repair/Replace: $150 - $400
- Water Line Repair: $500 - $2,500
- Garbage Disposal: $200 - $450

URGENCY LEVELS — choose the one that best matches the symptoms:
- EMERGENCY (Call Now): active leaks, no hot water, suspected slab leak, sewage backup, gas smell. Tell the customer to call (619) 843-6692 immediately.
- URGENT (Within 24-48 hours): slow drains, low water pressure, water heater making noise, intermittent leaks.
- SCHEDULE (Within 1-2 weeks): dripping faucets, running toilets, planning ADU, considering a repipe, cosmetic upgrades.

ALWAYS in every response:
- Give RANGES, never exact prices.
- Slab Leak Repair and Whole House Repipe must be quoted as "starting from $X" — never as a tight range.
- Tankless Water Heater quotes must mention "depends on brand and whether gas or electric".
- For any water heater replacement: mention "permit fees may apply for water heater replacements in San Diego — our team will confirm before installation."
- Note that "the final price will be confirmed after a Tri Express technician sees the job in person."
- End the customer-facing portion (before META_JSON) with exactly:
  'A Tri Express technician will call you within 1 hour to confirm your exact quote — our final price is usually 10-15% below this estimate!'

OTHER RULES:
- Be warm and reassuring, not clinical.
- If photos are unclear, say so nicely and rely on the description.
- For EMERGENCY items, recommend calling (619) 843-6692 right away.
- NEVER refer to a specific team member by first name (do NOT say "Kevin", a different name, or any individual). Always say "a Tri Express technician", "our technician", "our service team", "the Tri Express team", or "Tri Express Plumbing".
- Do NOT sign the message with a personal name. If you sign off, use "— Tri Express Plumbing Team".

After your full reply to the customer, you MUST add one final line by itself (exact format, valid JSON on one line):
META_JSON: {"estimated_range":"<short range string>","urgency":"<EMERGENCY|URGENT|SCHEDULE>"}`;

function anthropicImageBlock(buffer, mime) {
  const m = String(mime || '').toLowerCase();
  let mediaType = 'image/jpeg';
  if (m.includes('png')) mediaType = 'image/png';
  else if (m.includes('webp')) mediaType = 'image/webp';
  else if (m.includes('gif')) mediaType = 'image/gif';
  else if (m.includes('jpeg') || m.includes('jpg')) mediaType = 'image/jpeg';
  else return null;
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data: buffer.toString('base64'),
    },
  };
}

/**
 * @param {{ name: string; phone: string; email: string; service: string; description: string; zipcode: string; files: Array<{ buffer: Buffer; mimetype: string; originalname: string }> }} input
 */
export async function generateEstimateWithClaude(input) {
  const key = getApiKey();
  if (!key) throw new Error('AI is not configured on the server (ANTHROPIC_API_KEY).');

  const anthropic = new Anthropic({ apiKey: key });
  const model = getEstimateAnthropicModel();

  const content = [];
  const skippedHeic = [];

  for (const f of input.files || []) {
    const mime = f.mimetype || '';
    if (/heic|heif/i.test(mime) || /\.hei[cf]$/i.test(f.originalname || '')) {
      skippedHeic.push(f.originalname || 'photo');
      continue;
    }
    const block = anthropicImageBlock(f.buffer, mime);
    if (block) content.push(block);
  }

  let userText = `Customer request for a free estimate:

Name: ${input.name}
Phone: ${input.phone}
Email: ${input.email}
ZIP code: ${input.zipcode}
Service type: ${input.service}

Description from customer:
${input.description || '(none provided)'}`;

  if (skippedHeic.length) {
    userText += `\n\nNote: These files could not be sent to vision (HEIC/HEIF — please rely on description): ${skippedHeic.join(', ')}`;
  }
  if (!content.length) {
    userText += '\n\nNote: No analyzable photos were attached (or only HEIC). Rely on the written description.';
  }

  content.push({ type: 'text', text: userText });

  const msg = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: ESTIMATE_SYSTEM,
    messages: [{ role: 'user', content }],
  });

  const block = msg.content.find((b) => b.type === 'text');
  const raw = block?.text?.trim() || '';
  return splitEstimateResponse(raw);
}

export function splitEstimateResponse(raw) {
  const text = String(raw || '').trim();
  const re = /\nMETA_JSON:\s*(\{[\s\S]*\})\s*$/;
  const m = text.match(re);
  let displayText = text;
  const meta = { estimated_range: '', urgency_level: '' };
  if (m) {
    displayText = text.slice(0, m.index).trim();
    try {
      const j = JSON.parse(m[1]);
      meta.estimated_range = String(j.estimated_range || j.estimatedRange || '').trim();
      meta.urgency_level = String(j.urgency || j.urgency_level || '').trim();
    } catch {
      /* keep defaults */
    }
  }
  if (!meta.estimated_range) {
    const dollar = displayText.match(/\$[\d,]+(?:\s*-\s*\$?[\d,]+)?/);
    if (dollar) meta.estimated_range = dollar[0].replace(/\s+/g, '');
  }
  if (!meta.urgency_level) {
    if (/\bemergency\b/i.test(displayText)) meta.urgency_level = 'EMERGENCY';
    else if (/\burgent\b|24[\s-]?48|24\s*hours?/i.test(displayText)) meta.urgency_level = 'URGENT';
    else meta.urgency_level = 'SCHEDULE';
  }
  meta.urgency_level = normalizeUrgency(meta.urgency_level);
  return { displayText, meta, raw };
}

function normalizeUrgency(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return 'SCHEDULE';
  if (v.includes('emergency') || v.includes('immediately') || v.includes('call now')) return 'EMERGENCY';
  if (v.includes('urgent') || v.includes('24') || v.includes('48') || v.includes('soon')) return 'URGENT';
  if (v.includes('schedule') || v.includes('wait') || v.includes('week') || v.includes('plan')) return 'SCHEDULE';
  return value.toUpperCase();
}
