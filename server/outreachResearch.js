/**
 * Assembles a research brief for personalized outreach (Google Places + Serp organic).
 */

import * as ext from './externalSearch.js';

function hostnameFromWebsite(web) {
  if (!web || typeof web !== 'string') return '';
  try {
    const u = web.match(/^https?:\/\//i) ? web : `https://${web.trim()}`;
    return new URL(u).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * @param {Record<string, unknown>} vendor — row from vendors table
 * @param {{ googlePlacesKey?: string, serpKey?: string }} keys
 * @returns {Promise<string>} Markdown-style brief for the letter model (facts only; model must not invent beyond this).
 */
export async function buildOutreachResearchBrief(vendor, { googlePlacesKey = '', serpKey = '' } = {}) {
  const parts = [];
  parts.push('## CRM record (use only as hints; verify in snippets below)');
  parts.push(
    JSON.stringify(
      {
        company: vendor.name,
        category: vendor.category,
        website: vendor.website || '',
        address: vendor.address || '',
        phone: vendor.phone || '',
        contact_person: vendor.contact_person || '',
        years_in_business: vendor.years_in_business || '',
        notes: vendor.notes || '',
      },
      null,
      2
    )
  );

  if (googlePlacesKey) {
    try {
      const q = `${vendor.name} ${String(vendor.address || '').slice(0, 140)} San Diego County`.trim().slice(0, 280);
      const found = await ext.googleFindPlaceId(q, googlePlacesKey);
      if (found?.place_id) {
        const det = await ext.googlePlaceDetails(found.place_id, googlePlacesKey);
        parts.push('\n## Google Places (official listing — cite only what appears here)');
        parts.push(
          JSON.stringify(
            {
              name: det?.name,
              formatted_address: det?.formatted_address,
              formatted_phone_number: det?.formatted_phone_number,
              website: det?.website,
              editorial_summary: det?.editorial_summary?.overview || det?.editorial_summary,
              business_status: det?.business_status,
              maps_url: det?.url,
            },
            null,
            2
          )
        );
      } else {
        parts.push('\n## Google Places: no single match for text search (do not invent a listing).');
      }
    } catch (e) {
      parts.push(`\n## Google Places error: ${e.message || e}`);
    }
  } else {
    parts.push('\n## Google Places: not configured (no GOOGLE_PLACES_API_KEY).');
  }

  if (serpKey) {
    const name = String(vendor.name || '').trim();
    const host = hostnameFromWebsite(vendor.website);
    const queries = [
      `"${name}" San Diego reviews plumbing leak toilet water damage`,
      `"${name}" units properties managed portfolio apartments`,
      host ? `site:${host} about services` : null,
    ].filter(Boolean);

    parts.push('\n## Public web snippets (SerpApi organic — only cite facts supported by a line below)');
    for (const q of queries.slice(0, 3)) {
      try {
        const org = await ext.serpGoogleOrganic(q, serpKey, 5);
        parts.push(`\n### Search: ${q}\n`);
        if (!org.length) parts.push('(no results)\n');
        for (const o of org) {
          parts.push(`- **${(o.title || '').slice(0, 200)}**\n  URL: ${o.link}\n  Snippet: ${(o.snippet || '').slice(0, 420)}\n`);
        }
      } catch (e) {
        parts.push(`\n### Search failed: ${q} — ${e.message || e}\n`);
      }
    }
  } else {
    parts.push('\n## Serp organic: not configured (no SERPAPI_API_KEY).');
  }

  return parts.join('\n');
}
