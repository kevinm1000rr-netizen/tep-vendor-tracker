/**
 * Tri Express vendor list: "10+ years in business" — evidence required before treating as qualified.
 * (Used in agent tasks, AI prompts, and UI copy.)
 */
export const VENDOR_TENURE_QUALIFICATION_RULES = `A company qualifies **only** if Kevin can confirm **at least one** of:
- The **website** says **"since 2015"** or an **earlier** year (e.g. "Since 2014", "Since 2010").
- The **website** says **"10+ years"**.
- The **website** says **"over 10 years"**.
- **BBB**, profile, or another **credible source** shows a **founded date of 2015 or earlier**.

If none of the above can be found, **do not** add or treat the company as meeting the tenure rule.`;

export const VENDOR_TENURE_QUALIFICATION_SHORT =
  'Qualify only with: site “since 2015” or earlier year, site “10+ years” / “over 10 years”, or BBB/source founded ≤2015.';
