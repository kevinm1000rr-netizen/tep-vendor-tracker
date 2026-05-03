import Anthropic from '@anthropic-ai/sdk';
import { getApiKey, getModel } from './config.js';
import { VENDOR_TENURE_QUALIFICATION_RULES } from './qualification.js';

/** Appended to all agent / AI outreach email bodies (idempotent). */
export const OUTREACH_EMAIL_SIGNATURE_LINE =
  'Kevin Morris | Tri Express Plumbing | 619-843-6692 | kevin@triexpressplumbing.com | CA Lic #926629 | San Diego County';

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

const COMPANY_BLOCK = `Tri Express Plumbing — Chula Vista / San Diego County
California Contractors License #926629 · Serving San Diego County since 2008

Core trades you promote to partners:
- Water heater repair & replacement
- Whole-home repiping
- Leak detection
- Slab leak repair

Proof point: 12-year ongoing relationship with Integrity Restoration (San Diego) — reliable emergency plumbing on restoration jobs.`;

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

export async function generateVendorLetter(vendor, learningBlock = '') {
  const categoryLabel = categoryHuman(vendor.category);
  const pain = categoryPainPoints(vendor.category);
  const system = `${MODEL_PROMPT_PREFIX}You write warm, professional B2B outreach letters for a plumbing company partnering with ${categoryLabel} firms in San Diego. Letters should sound human and local — not generic mail-merge. No clichés like "I hope this finds you well." One page or less. Include clear ask: preferred vendor list / emergency line / single point of contact.`;
  const user = `${COMPANY_BLOCK}

Write an introductory partnership letter TO this organization:

Company: ${vendor.name}
Category: ${categoryLabel}
Contact (if any): ${vendor.contact_person || 'General partnership'}
Phone on file: ${vendor.phone || 'n/a'}
Internal notes: ${vendor.notes || 'none'}

Category-specific value angle (use naturally, don't list as bullets in the letter): ${pain}

Learning / performance hints for this category (use if helpful; do not fabricate metrics):
${learningBlock || 'No extra learning data yet — rely on proof points above.'}

Required proof points to weave in (truthful, do not invent other relationships): 12-year ongoing relationship with Integrity Restoration (San Diego), California Contractors License #926629, San Diego County coverage since 2008.

After the body and sign-off, end the email with this exact final line on its own (do not alter punctuation or spacing): ${OUTREACH_EMAIL_SIGNATURE_LINE}

Output the letter with today's date line, a subject line if email, salutation (use the company or "Partnership team" if no contact), body, brief sign-off, then that signature line.`;

  const text = await complete(system, user);
  return appendOutreachEmailSignature(text);
}

function categoryPainPoints(category) {
  const m = {
    restoration:
      'Emergency response time on water/fire jobs; reliable sub for mitigation partners; fast dispatch on restoration timelines.',
    property_mgmt:
      'Quick turnaround on tenant turnover work; predictable scheduling; volume-friendly pricing for recurring properties.',
    hoa:
      'Reliability and documentation; insurance-friendly repairs; clear communication with boards and managers.',
    contractor:
      'Rough-in scheduling and ADU timelines; coordination on remodel phases; fewer callbacks on plumbing scope.',
  };
  return m[category] || m.restoration;
}

export async function generateFollowUpEmail(vendor, daysSinceSent) {
  const categoryLabel = categoryHuman(vendor.category);
  const system = `${MODEL_PROMPT_PREFIX}You write short, respectful follow-up emails for an established San Diego plumbing contractor. Assume they may be busy; offer value (fast response, licensed, restoration experience). Keep under 200 words unless critical detail needed.`;
  const user = `${COMPANY_BLOCK}

Draft a follow-up email for:
Company: ${vendor.name} (${categoryLabel})
Status: ${vendor.status}
Date originally sent (if any): ${vendor.date_sent || 'unknown'}
Days since first outreach (approx): ${daysSinceSent}
Notes: ${vendor.notes || 'none'}

Include subject line and email body. No attachments mentioned. End the email body with this exact final line on its own: ${OUTREACH_EMAIL_SIGNATURE_LINE}`;

  const text = await complete(system, user);
  return appendOutreachEmailSignature(text);
}

export async function generateCallScript(vendor) {
  const categoryLabel = categoryHuman(vendor.category);
  const system = `${MODEL_PROMPT_PREFIX}You create concise phone call scripts with bullet talking points for a plumbing business owner calling vendor partners. Conversational, confident, not salesy. Include: opener, 3–5 talking points tied to THEIR business type, handling objections briefly, and a clear close (schedule intro / send license & W-9 / add to vendor list).`;
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
  const system = `${MODEL_PROMPT_PREFIX}You are a practical business development coach for a busy plumbing company owner (Kevin) in San Diego. Your job is a monthly vendor-partnership review: prioritize ruthlessly, name specific companies to call this week, explain win rates, and give a short action checklist. Tone: direct, friendly, no corporate jargon. Use markdown headings (##) and bullet lists. Quantify when data exists; otherwise say what's unknown.`;
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
  const system = `${MODEL_PROMPT_PREFIX}You are Kevin's vendor-outreach assistant. Give one tight recommendation: what to do next, in what order, and why it matters this week. Max 120 words. No markdown headings — short paragraphs or bullets.`;
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

outreachEmailDraft: Introductory email FROM Tri Express Plumbing TO this company (subject line + body). Use their category, service area, tenure evidence, and online notes. Sound human and local. Do not invent awards, dates, or licenses not supported by the payload. Tri Express: CA license #926629, Chula Vista / San Diego County, since 2008, water heaters / repiping / leak & slab work, strong restoration partner references. The email must end with this exact final line: ${OUTREACH_EMAIL_SIGNATURE_LINE}`;
  const user = `## Tenure rule (strict)\n${VENDOR_TENURE_QUALIFICATION_RULES}\n\n## Candidate payload\n${JSON.stringify(payload, null, 2)}`;
  const text = await complete(system, user);
  return parseJsonLoose(text);
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
