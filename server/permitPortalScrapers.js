/**
 * HTML / SPA permit portals without a public API (MaintStar, Energov, eTRAKiT, CivicPlus, etc.).
 * Implementations should be polite (timeouts, low concurrency) and respect robots.txt.
 * Returns the same lead shape as permitCityFeeds / accelaRecordToLead.
 */

/** @returns {Promise<Array<Record<string, unknown>>>} */
export async function scrapeNonAccelaPermitFeeds() {
  console.log(
    '[permit-feeds] Scraper queue (El Cajon, La Mesa, Poway, Coronado, Del Mar, Solana Beach): not implemented yet — add per-portal parsers or headless flows as needed.'
  );
  return [];
}
