import Anthropic from '@anthropic-ai/sdk';
import { getApiKey, getModel } from './config.js';
import { VENDOR_TENURE_QUALIFICATION_RULES } from './qualification.js';

/** Canonical Tri Express contact lines for every agent email draft. */
export const OUTREACH_FULL_NAME = 'Kevin Morris';
export const OUTREACH_PHONE = '619-843-6692';
export const OUTREACH_EMAIL_ADDR = 'kevin@triexpressplumbing.com';

/** Appended to all agent / AI outreach email bodies (idempotent). */
export const OUTREACH_EMAIL_SIGNATURE_LINE = `${OUTREACH_FULL_NAME} | Tri Express Plumbing | ${OUTREACH_PHONE} | ${OUTREACH_EMAIL_ADDR} | CA Lic #926629 | San Diego County`;

/** B2B outreach only — never promise 24/7, after-hours, or late-night on-call in letters or AI drafts. */
export const OUTREACH_SCHEDULING_PRIORITY_LINE =
  'Same-day and next-day scheduling for priority partners.';
export const OUTREACH_SCHEDULING_HOURS_LINE =
  'Business hours Monday through Friday 7am to 6pm, Saturday by appointment.';

export function appendOutreachEmailSignature(body) {
  const sig = OUTREACH_EMAIL_SIGNATURE_LINE;
  const raw = String(body || '');
  const t = raw.trimEnd();
  if (!t.trim()) return '';
  const lines = t.split(/\r?\n/);
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim() === '') i -= 1;
  if (i >= 0 && lines[i].trim() === sig) return t;
  return `${t}\n\n${sig}`;
}

/** Signature line + fallback so full name, business number, and email appear in stored/UI drafts. */
export function ensureAgentEmailDraftHasContact(body) {
  const t = appendOutreachEmailSignature(body);
  if (!t.trim()) return t;
  const low = t.toLowerCase();
  const hasName = t.includes(OUTREACH_FULL_NAME);
  if (t.includes(OUTREACH_PHONE) && low.includes(OUTREACH_EMAIL_ADDR.toLowerCase()) && hasName) return t;
  return `${t.trimEnd()}\n\n${OUTREACH_FULL_NAME} | ${OUTREACH_PHONE} | ${OUTREACH_EMAIL_ADDR}`;
}

const COMPANY_BLOCK = `Tri Express Plumbing — Chula Vista / San Diego County
California Contractors License #926629 · Serving San Diego County since 2008
Primary contact: ${OUTREACH_FULL_NAME} · Business line ${OUTREACH_PHONE} · ${OUTREACH_EMAIL_ADDR}

Core trades you promote to partners:
- Water heater repair & replacement
- Whole-home repiping
- Leak detection
- Slab leak repair

Proof point: 12-year ongoing relationship with Integrity Restoration (San Diego) — reliable plumbing coordination on restoration jobs (scheduled within the partnership hours below).

Partnership scheduling (outreach must match this; never contradict):
• ${OUTREACH_SCHEDULING_PRIORITY_LINE}
• ${OUTREACH_SCHEDULING_HOURS_LINE}
Do not promise 24/7 availability, after-hours or late-night emergency callouts, Sunday service, or on-call coverage outside these hours.`;

/** Prompt style tuned for Claude Sonnet (default model claude-sonnet-4-6). */
const MODEL_PROMPT_PREFIX = `You are writing for Claude Sonnet: be specific, San Diego–local where it matters, and avoid generic corporate filler. `;

function client() {
  const key = getApiKey();
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set. Add it in Settings or .env.');
  return new Anthropic({ apiKey: key });
}

async function complete(system, user) {
  const anthropic = client();
  const model = getModel();
  const msg = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const block = msg.content.find((b) => b.type === 'text');
  return block?.text?.trim() || '';
}

/** First line exactly; optional following lines with reason — no generic letter. */
export const MANUAL_RESEARCH_LETTER_PREFIX = 'MANUAL_RESEARCH_REQUIRED';

export function isManualResearchLetterOutput(text) {
  return String(text || '').trim().startsWith(MANUAL_RESEARCH_LETTER_PREFIX);
}

export function getManualResearchLetterReason(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  const rest = lines.slice(1).join('\n').trim();
  const m = rest.match(/^reason:\s*(.+)$/im);
  if (m) return m[1].trim();
  return rest || 'Not enough verifiable, company-specific facts in the research package to write a personalized letter.';
}

export async function generateVendorLetter(vendor, learningBlock = '', researchBrief = '') {
  const categoryLabel = categoryHuman(vendor.category);
  const angle = categoryOutreachAngle(vendor);
  const system = `${MODEL_PROMPT_PREFIX}You write **fully personalized** B2B partnership letters (Tri Express Plumbing → one recipient company). Each letter must read as written for **that** company only — no boilerplate that could apply to any firm.

Rules:
- Open by using the **recipient company name** naturally in the first or second sentence.
- Include **at least two** concrete, citable specifics drawn **only** from the research package and CRM facts (e.g. geography/service area, portfolio scale if evidenced, tenure, a paraphrased public review theme about water/plumbing/building maintenance — never quote reviews you cannot tie to a URL in the package).
- Tie Tri Express services to **their** operational pain (not a generic list).
- **Never** use vague phrases like "your industry" without naming what they do, or "companies like yours" without a specific hook.
- If the research package does **not** contain enough verifiable specifics to meet the bar above, **do not** write a partnership letter. Output **only**:
  ${MANUAL_RESEARCH_LETTER_PREFIX}
  Reason: <one short sentence>

Category voice (weave naturally; do not label as bullets in the letter): ${angle}

Mandatory Tri Express facts (must appear in body or closing, truthfully): **Tri Express Plumbing** has served **San Diego County since 2008**; **California Contractors License #926629** (or "CA Lic #926629"); 12-year ongoing relationship with **Integrity Restoration** (San Diego) as one reference — do not invent other client names.

**Scheduling (strict):** Any sentence about availability must reflect only: **${OUTREACH_SCHEDULING_PRIORITY_LINE}** and **${OUTREACH_SCHEDULING_HOURS_LINE}**. Do **not** mention 24/7, after-hours, overnight, late-night, all-hours hotlines, or emergency service outside those hours.

Signature: sign as **${OUTREACH_FULL_NAME}**; include **${OUTREACH_PHONE}** and **${OUTREACH_EMAIL_ADDR}** in the body; final line must be **exactly**: ${OUTREACH_EMAIL_SIGNATURE_LINE}

No clichés ("I hope this finds you well"). One page or less. Clear ask: preferred vendor / dedicated partnership contact / single point of contact during the hours above.`;
  const rb =
    (researchBrief && String(researchBrief).trim()) ||
    '(No external research run — use only CRM fields; if too thin, use MANUAL_RESEARCH_REQUIRED.)';
  const user = `${COMPANY_BLOCK}

## Research package (primary source for personalization — do not invent facts not supported here)
${rb}

---

Write an introductory partnership letter **to ${vendor.name}**.

CRM fields:
Category: ${categoryLabel}
Contact (if any): ${vendor.contact_person || 'General partnership'}
Phone on file: ${vendor.phone || 'n/a'}
Website: ${vendor.website || 'n/a'}
Address: ${vendor.address || 'n/a'}
Internal notes: ${vendor.notes || 'none'}

Learning / performance hints (secondary):
${learningBlock || 'None.'}

Output: today's date line, \`Subject: ...\` line, salutation, body, brief sign-off, then the exact signature line ${OUTREACH_EMAIL_SIGNATURE_LINE} on its own final line.`;

  const text = await complete(system, user);
  const raw = String(text || '').trim();
  if (isManualResearchLetterOutput(raw)) return raw;
  return ensureAgentEmailDraftHasContact(raw);
}

/** Category-specific partnership angles (user-requested hooks). */
function categoryOutreachAngle(vendor) {
  const cat = vendor.category;
  const name = String(vendor.name || '').toLowerCase();
  const hotelish = /hotel|resort|inn|suites|lodg|hospitality|marriott|hilton|hyatt|ihg|wyndham/.test(name);
  if (cat === 'property_mgmt') {
    return `**Property managers:** prompt coordination on **tenant-reported** leaks and fixtures during scheduled windows; **${OUTREACH_SCHEDULING_PRIORITY_LINE}** **${OUTREACH_SCHEDULING_HOURS_LINE}** — no after-hours or 24/7 promises; turnover-unit hot water and fixture work at volume.`;
  }
  if (cat === 'hoa') {
    return `**HOAs / community managers:** **common-area** maintenance (pools, clubhouses, irrigation), reserve-friendly documentation, and **code compliance** on mechanical/plumbing for boards; **${OUTREACH_SCHEDULING_PRIORITY_LINE}** **${OUTREACH_SCHEDULING_HOURS_LINE}**`;
  }
  if (cat === 'restoration') {
    return `**Restoration partners:** urgent **water-damage** plumbing coordinated with dry-out/mitigation timelines; **${OUTREACH_SCHEDULING_PRIORITY_LINE}** **${OUTREACH_SCHEDULING_HOURS_LINE}** — do not imply midnight or all-night dispatch.`;
  }
  if (cat === 'contractor' && hotelish) {
    return `**Hotels / hospitality:** engineering-friendly **scheduled** visits and phased shutoffs for **minimal guest disruption**; domestic hot water and public restrooms — **${OUTREACH_SCHEDULING_PRIORITY_LINE}** **${OUTREACH_SCHEDULING_HOURS_LINE}** (no 24/7 or overnight-on-call claims).`;
  }
  if (cat === 'contractor') {
    return `**Facilities / commercial / institutional:** align with what the research shows (schools, clinics, senior living, offices) — recurring drain/water-heater/kitchen mechanical work and reliable CM coordination; **${OUTREACH_SCHEDULING_PRIORITY_LINE}** **${OUTREACH_SCHEDULING_HOURS_LINE}**.`;
  }
  return `Emphasize licensed, local San Diego County coverage and predictable partnership communication; **${OUTREACH_SCHEDULING_PRIORITY_LINE}** **${OUTREACH_SCHEDULING_HOURS_LINE}**.`;
}

export async function generateFollowUpEmail(vendor, daysSinceSent, researchBrief = '') {
  const categoryLabel = categoryHuman(vendor.category);
  const angle = categoryOutreachAngle(vendor);
  const system = `${MODEL_PROMPT_PREFIX}You write **personalized** short follow-up emails to **one** company (${vendor.name}). Under ~220 words. No generic template.

If the research package lacks enough verifiable specifics for a tailored follow-up, output only:
${MANUAL_RESEARCH_LETTER_PREFIX}
Reason: <short>

Otherwise: reference something specific from the research; tie to ${angle} Tri Express (since 2008, CA Lic #926629). Availability wording only: **${OUTREACH_SCHEDULING_PRIORITY_LINE}** **${OUTREACH_SCHEDULING_HOURS_LINE}** — never 24/7, after-hours, or late-night promises. Include ${OUTREACH_FULL_NAME}, ${OUTREACH_PHONE}, ${OUTREACH_EMAIL_ADDR} in the body; final line exactly ${OUTREACH_EMAIL_SIGNATURE_LINE}.`;
  const rb =
    (researchBrief && String(researchBrief).trim()) ||
    '(No external research — CRM only; if too thin, use MANUAL_RESEARCH_REQUIRED.)';
  const user = `${COMPANY_BLOCK}

## Research package
${rb}

Follow-up context:
Company: ${vendor.name} (${categoryLabel})
Status: ${vendor.status}
Date originally sent (if any): ${vendor.date_sent || 'unknown'}
Days since first outreach (approx): ${daysSinceSent}
Notes: ${vendor.notes || 'none'}

Subject + body; no attachments.`;

  const text = await complete(system, user);
  const raw = String(text || '').trim();
  if (isManualResearchLetterOutput(raw)) return raw;
  return ensureAgentEmailDraftHasContact(raw);
}

export async function generateCallScript(vendor) {
  const categoryLabel = categoryHuman(vendor.category);
  const system = `${MODEL_PROMPT_PREFIX}You create concise phone call scripts with bullet talking points for a plumbing business owner calling vendor partners. Conversational, confident, not salesy. Include: opener, 3–5 talking points tied to THEIR business type, handling objections briefly, and a clear close (schedule intro / send license & W-9 / add to vendor list).

**Availability on calls:** If you mention when Tri Express can work or take calls, use only: **${OUTREACH_SCHEDULING_PRIORITY_LINE}** **${OUTREACH_SCHEDULING_HOURS_LINE}**. Never promise 24/7, after-hours, overnight, or late-night emergency availability.`;
  const user = `${COMPANY_BLOCK}

Create a call script for Tri Express calling:
Company: ${vendor.name}
Category: ${categoryLabel}
Contact hint: ${vendor.contact_person || 'ask for vendor partnerships or ops'}
Notes: ${vendor.notes || 'none'}

Format: sections with short bullets (Opener, Value for them, Tri Express proof points, Ask, If voicemail).`;

  return complete(system, user);
}

export async function monthlyStrategicReview(snapshot) {
  const system = `${MODEL_PROMPT_PREFIX}You are a practical business development coach for a busy plumbing company owner (Kevin) in San Diego. Your job is a monthly vendor-partnership review: prioritize ruthlessly, name specific companies to call this week, explain win rates, and give a short action checklist. Tone: direct, friendly, no corporate jargon. Use markdown headings (##) and bullet lists. Quantify when data exists; otherwise say what's unknown.

When suggesting **outreach or positioning** for partners, availability is only: **${OUTREACH_SCHEDULING_PRIORITY_LINE}** **${OUTREACH_SCHEDULING_HOURS_LINE}** — never recommend 24/7, after-hours, or late-night on-call promises.`;
  const user = `Here is the current vendor tracker snapshot (JSON). Analyze and produce a monthly strategic report.

${JSON.stringify(snapshot, null, 2)}

When you recommend **new** companies to add, apply this tenure rule (do not loosen it):
${VENDOR_TENURE_QUALIFICATION_RULES}

Include:
1. Executive summary (5 sentences max)
2. **Prioritize this month** — table or numbered list of top 5–8 targets with one-line why
3. **Overdue / stale** — who to re-touch first
4. **Win rate by category** — use counts provided; comment on differences
5. **This week's calls** — exactly 3 companies to call with reason
6. **30-day focus** — one paragraph "Focus on X because…"

End with a boxed checklist Kevin can print.`;

  return complete(system, user);
}

export async function suggestNewVendors(existingVendors) {
  const names = existingVendors.map((v) => v.name).join('; ');
  const system = `${MODEL_PROMPT_PREFIX}You help a San Diego plumbing contractor research **additional** vendor partners. You cannot browse the live web. Only list candidates Kevin could **realistically qualify** using the evidence rules below—do not claim a company meets the rule unless one of those specific proofs could apply.`;
  const user = `Companies already in the CRM — **do not** repeat these names:\n${names}\n\n## Tenure rule (strict)\n${VENDOR_TENURE_QUALIFICATION_RULES}\n\nOnly suggest organizations where Kevin has a **clear path** to check the website or BBB/source for one of the phrases/dates above. If you are unsure, put them under a final section **"Needs manual check — not yet qualified"** instead of the main list.\n\nReturn **markdown** with **5–10** San Diego County **research targets** across:\n- Restoration / emergency rebuild\n- Residential property management\n- HOA / community management\n- ADU / remodel / design-build\n\nFor each **main-list** candidate include:\n- **Name** and **category**\n- **Why** they might fit Tri Express (water heater, repiping, leak/slab work on their jobs)\n- **Which qualification rule** you expect Kevin to confirm (quote the exact type of proof: "since YYYY" on site, "10+ years" / "over 10 years" on site, or BBB/founded date ≤2015)\n- **Where to look** (homepage, About, footer, BBB profile URL pattern — no fabricated URLs)\n- **Next step** if the proof is not found (drop or keep in "needs manual check")\n\nKeep bullets tight; Kevin is busy.`;

  return complete(system, user);
}

export async function generateTaskRecommendation(taskRow, vendorRow) {
  const system = `${MODEL_PROMPT_PREFIX}You are Kevin's vendor-outreach assistant. Give one tight recommendation: what to do next, in what order, and why it matters this week. Max 120 words. No markdown headings — short paragraphs or bullets.

If your advice mentions how Tri Express shows up for partners, availability is only: **${OUTREACH_SCHEDULING_PRIORITY_LINE}** **${OUTREACH_SCHEDULING_HOURS_LINE}** — never suggest 24/7 or after-hours promises.`;
  const payload = {
    taskTitle: taskRow.title,
    taskDescription: taskRow.description,
    priority: taskRow.priority,
    dueDate: taskRow.due_date,
    vendor:
      vendorRow &&
      (vendorRow.name
        ? {
            name: vendorRow.name,
            category: vendorRow.category,
            status: vendorRow.status,
            email: vendorRow.email,
            phone: vendorRow.phone,
            website: vendorRow.website,
            yearsInBusiness: vendorRow.years_in_business,
            address: vendorRow.address,
            notes: vendorRow.notes,
          }
        : null),
  };
  const user = `Task:\n${JSON.stringify(payload, null, 2)}`;
  return complete(system, user);
}

function categoryHuman(c) {
  const m = {
    restoration: 'Restoration / emergency rebuild',
    property_mgmt: 'Residential property management',
    hoa: 'HOA / community association management',
    contractor: 'ADU / remodel / design-build contractor',
  };
  return m[c] || c;
}

function stripJsonFence(text) {
  let t = String(text || '').trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)```$/im);
  if (m) t = m[1].trim();
  return t;
}

export function parseJsonLoose(text) {
  const t = stripJsonFence(text);
  try {
    return JSON.parse(t);
  } catch {
    const i = t.indexOf('{');
    const j = t.lastIndexOf('}');
    if (i >= 0 && j > i) return JSON.parse(t.slice(i, j + 1));
    throw new Error('Model did not return valid JSON');
  }
}

/**
 * Decide if a Maps/search candidate meets tenure rules; draft outreach email if so.
 * @returns {Promise<{
 *   qualifies: boolean,
 *   evidenceSummary?: string,
 *   evidenceUrls?: Array<{ url: string, title: string }>,
 *   yearsInBusiness?: string,
 *   contactPerson?: string,
 *   email?: string,
 *   phone?: string,
 *   website?: string,
 *   address?: string,
 *   onlineNotes?: string,
 *   outreachEmailDraft?: string
 * }>}
 */
export async function qualifyProspectFromResearch(payload) {
  const system = `${MODEL_PROMPT_PREFIX}You evaluate San Diego County B2B vendor partners for a plumbing contractor. Output **only valid JSON** (no markdown, no code fences).

JSON shape:
{"qualifies":boolean,"evidenceSummary":string,"evidenceUrls":[{"url":string,"title":string}],"yearsInBusiness":string,"contactPerson":string,"email":string,"phone":string,"website":string,"address":string,"onlineNotes":string,"outreachEmailDraft":string}

qualifies: true **only** if the tenure rule below is clearly satisfied by evidence in the payload (Maps listing, URLs, snippets). If uncertain, false.

outreachEmailDraft: Introductory email FROM Tri Express Plumbing TO this company (subject line + body), written on behalf of **${OUTREACH_FULL_NAME}**. **Personalize:** cite at least **two** concrete specifics from the payload only (maps fields, snippets, company name/address). No generic template. If the payload does **not** support two verifiable specifics, set **outreachEmailDraft** to the empty string \`""\` and append to **onlineNotes** (new line): \`Outreach draft: needs manual research (insufficient public specifics).\` Tri Express: CA license #926629, San Diego County since 2008; Integrity Restoration reference is allowed. **Scheduling in the draft:** use only **${OUTREACH_SCHEDULING_PRIORITY_LINE}** and **${OUTREACH_SCHEDULING_HOURS_LINE}** — never 24/7, after-hours, late-night, overnight, or Sunday coverage. The draft (when non-empty) must include **${OUTREACH_FULL_NAME}**, **${OUTREACH_PHONE}**, and **${OUTREACH_EMAIL_ADDR}** in the body and end with this exact final line: ${OUTREACH_EMAIL_SIGNATURE_LINE}`;
  const user = `## Tenure rule (strict)\n${VENDOR_TENURE_QUALIFICATION_RULES}\n\n## Candidate payload\n${JSON.stringify(payload, null, 2)}`;
  const text = await complete(system, user);
  const out = parseJsonLoose(text);
  if (out && typeof out.outreachEmailDraft === 'string' && out.outreachEmailDraft.trim()) {
    out.outreachEmailDraft = ensureAgentEmailDraftHasContact(out.outreachEmailDraft);
  }
  return out;
}

/**
 * Discovery triage for auto-registry: San Diego County, established operators, recurring-plumbing fit.
 */
export async function qualifyDiscoveryProspect(payload) {
  const system = `${MODEL_PROMPT_PREFIX}You triage **commercial plumbing partnership** targets for Tri Express (San Diego County) from SerpApi Maps + organic snippets. Output **only valid JSON** (no markdown, no code fences).

JSON shape:
{"qualifies":boolean,"evidenceSummary":string,"evidenceUrls":[{"url":string,"title":string}],"yearsInBusiness":string,"contactPerson":string,"email":string,"phone":string,"website":string,"address":string,"onlineNotes":string,"outreachEmailDraft":string}

**Pre-screened by code (trust these booleans):** mapsListing.reviews ≥ 10, listing has a website URL, San Diego County search context.

**qualifies — true only if ALL are satisfied:**

1) **Geography:** Clearly serves or is located in **San Diego County** (or immediate border work into SD County). Reject if clearly LA/OC/Inland Empire-only with no SD tie.

2) **Business age — 5+ years operating:** Defensible evidence the operating company (not a random new DBA) has been active **≥ ~5 years** — e.g. "since 2020" or **earlier** founding year, "over 5 years", "6+ years", BBB founded ≤2020, news/About copy with long tenure, or **organic snippets** that state longevity. **Reviews count alone is not enough** for business age.

3) **Online presence — ≥ ~3 years:** The business has a **meaningful public web footprint for ≥ ~3 years** — e.g. snippet shows **copyright / “site ©” year ≤ 2023**, blog or press from **2023 or earlier**, "since 2022" on the **web** side, or multiple dated pages; **reject** if every signal suggests the **brand or site launched within the last ~36 months** with no contrary evidence.

4) **Vertical fit (use payload.category, prospect_subtype, search_focus, companyName, maps type):**
   - **property_mgmt / 50+ units:** Evidence the manager handles **large residential portfolios** (many units, multifamily, "portfolio", "communities", class-A apartments) — not a single-family handyman.
   - **property_mgmt / commercial_re_manager:** **Commercial** building or asset property management (office, retail, medical office, industrial) — recurring maintenance plumbing.
   - **hoa:** **HOA / community association management** firms (not restaurants, not unrelated retail).
   - **restoration / franchise_***:** Only **ServPro, ServiceMaster Restore, or Paul Davis** branded locations (name or official branding matches); reject independent mom-pop shops for these rows.
   - **contractor / hotel|school_district|healthcare|senior_living:** Operating **hotel/resort**, **K–12 district or large school facilities**, **hospital/medical campus**, or **senior living / skilled nursing** with ongoing facilities — **priority** where **recurring drain/water heater/restroom/kitchen** work is plausible.

5) **Recurring plumbing priority:** In **onlineNotes**, first line must be exactly one of: \`Recurring plumbing fit: high\`, \`Recurring plumbing fit: medium\`, or \`Recurring plumbing fit: low\` — then one sentence why (e.g. turnover units, guest towers, cafeterias, clinical sinks).

**false** if any requirement fails, wrong vertical, residential-only PM when subtype expects 50+ scale without evidence, spam, or insufficient evidence for (2)–(4).

**Tenure evidence:** Cite sources in evidenceSummary. yearsInBusiness: short human string.

Fill **phone**, **website**, **address** from mapsListing when present. **Email** only if a snippet clearly shows one (do not guess).

outreachEmailDraft: introductory email (subject + body) from **${OUTREACH_FULL_NAME}** at Tri Express. **Personalize** with at least **two** specifics from the payload (maps, snippets, category, search_focus). If you cannot, set **outreachEmailDraft** to \`""\` and append to **onlineNotes**: \`Outreach draft: needs manual research (insufficient public specifics).\` **Scheduling:** only **${OUTREACH_SCHEDULING_PRIORITY_LINE}** and **${OUTREACH_SCHEDULING_HOURS_LINE}** — no 24/7, after-hours, late-night, overnight, or Sunday promises. When non-empty, include **${OUTREACH_FULL_NAME}**, **${OUTREACH_PHONE}**, **${OUTREACH_EMAIL_ADDR}** in the body and end with: ${OUTREACH_EMAIL_SIGNATURE_LINE}`;
  const focus = payload.search_focus ? `\nSearch focus:\n${payload.search_focus}\n` : '';
  const user = `Discovery row — category=${payload.category}${payload.prospect_subtype ? ` subtype=${payload.prospect_subtype}` : ''}\n${focus}\nPayload JSON:\n${JSON.stringify(payload, null, 2)}`;
  const text = await complete(system, user);
  const out = parseJsonLoose(text);
  if (out && typeof out.outreachEmailDraft === 'string' && out.outreachEmailDraft.trim()) {
    out.outreachEmailDraft = ensureAgentEmailDraftHasContact(out.outreachEmailDraft);
  }
  return out;
}

/**
 * Propose CRM fields from search snippets (only with explicit source URLs from the list).
 */
export async function extractVendorFieldsFromSnippets(vendor, snippets) {
  const system = `${MODEL_PROMPT_PREFIX}You extract CRM field values ONLY when a snippet or title clearly supports the value and the sourceUrl is one of the provided URLs. Output **only JSON**:

{"suggestions":[{"field":"phone"|"email"|"website"|"address"|"contact_person"|"years_in_business","value":string,"sourceUrl":string,"sourceTitle":string}]}

field must be exactly one of those six snake_case strings. Do not invent emails. years_in_business: quote evidence like "since 2010" only when explicit. Omit unsupported fields.`;
  const user = `Vendor:\n${JSON.stringify({ name: vendor.name, category: vendor.category }, null, 2)}\n\nSnippets (title, url, snippet):\n${JSON.stringify(snippets, null, 2)}`;
  const text = await complete(system, user);
  return parseJsonLoose(text);
}
