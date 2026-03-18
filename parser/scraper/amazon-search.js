const { checkCaptcha, checkSession, waitForCaptchaResolution, waitForSessionResolution } = require('./captcha');

/**
 * Wait for page to load and settle.
 * @param {import('playwright').Page} page
 * @param {number} ms
 */
async function waitAndSettle(page, ms = 5000) {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(ms);
  } catch (e) {
    // Timeout is OK, continue
  }
}

/**
 * Handle captcha and session checks. Returns false if unresolvable.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>} true if page is usable
 */
async function ensurePageReady(page) {
  // Check for session/sign-in redirect
  if (await checkSession(page)) {
    console.log('[SC-SEARCH] Session expired, waiting for login...');
    const resolved = await waitForSessionResolution(page);
    if (!resolved) {
      throw new Error('Session expired and was not resolved within timeout');
    }
    await waitAndSettle(page, 3000);
  }

  // Check for captcha
  if (await checkCaptcha(page)) {
    console.log('[SC-SEARCH] Captcha detected, waiting for resolution...');
    const resolved = await waitForCaptchaResolution(page);
    if (!resolved) {
      throw new Error('Captcha was not resolved within timeout');
    }
    await waitAndSettle(page, 3000);
  }

  return true;
}

/**
 * Execute a search query on Seller Central product search.
 * @param {import('playwright').Page} page
 * @param {string} query
 * @returns {Promise<Array>} array of search results
 */
async function executeSearch(page, query) {
  const encodedQuery = encodeURIComponent(query);
  const searchUrl = `https://sellercentral.amazon.com/product-search/keywords/search?q=${encodedQuery}`;

  console.log(`[SC-SEARCH] Navigating to: ${searchUrl}`);

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await waitAndSettle(page, 5000);

  // Check for issues
  await ensurePageReady(page);

  // Extract search results from the page
  const results = await page.evaluate(() => {
    const items = [];

    // Strategy 1: Look for product cards/rows in the search results
    // Seller Central product search typically shows results in a table or card layout

    // Try table rows
    const rows = document.querySelectorAll('tr[data-asin], tr[data-row-key], .product-search-result, [class*="product-row"], [class*="ProductRow"], [class*="search-result"]');
    rows.forEach(row => {
      const asinEl = row.querySelector('[data-asin]') || row;
      const asin = asinEl.getAttribute('data-asin') || asinEl.getAttribute('data-row-key') || '';
      const titleEl = row.querySelector('.product-title, [class*="title"], a, h3, h4, td:nth-child(2)');
      const title = titleEl ? titleEl.textContent.trim() : '';

      if (asin && /^B[0-9A-Z]{9}$/.test(asin)) {
        items.push({ asin, title, salesRank: null });
      }
    });

    // Strategy 2: Look for links containing ASIN patterns
    if (items.length === 0) {
      const links = document.querySelectorAll('a[href*="/dp/"], a[href*="/product/"], a[href*="asin="]');
      const seen = new Set();
      links.forEach(link => {
        const href = link.getAttribute('href') || '';
        let asin = null;

        // Extract ASIN from /dp/ASIN
        const dpMatch = href.match(/\/dp\/([A-Z0-9]{10})/);
        if (dpMatch) asin = dpMatch[1];

        // Extract from asin= param
        if (!asin) {
          const paramMatch = href.match(/asin=([A-Z0-9]{10})/);
          if (paramMatch) asin = paramMatch[1];
        }

        if (asin && !seen.has(asin)) {
          seen.add(asin);
          const title = link.textContent.trim().substring(0, 200);
          items.push({ asin, title, salesRank: null });
        }
      });
    }

    // Strategy 3: Parse from page text/JSON data
    if (items.length === 0) {
      // Look for ASINs in data attributes or scripts
      const allText = document.body.innerHTML;
      const asinPattern = /\b(B[0-9A-Z]{9})\b/g;
      const seen = new Set();
      let match;
      while ((match = asinPattern.exec(allText)) !== null) {
        const asin = match[1];
        // Filter out obvious non-ASINs (all digits, common strings)
        if (!seen.has(asin) && !/^B\d{9}$/.test(asin) || asin.startsWith('B0')) {
          seen.add(asin);
          items.push({ asin, title: '', salesRank: null });
        }
        if (seen.size >= 20) break;
      }
    }

    // Strategy 4: Check for the new Seller Central product search UI
    // which may use React components with data in script tags
    if (items.length === 0) {
      const scripts = document.querySelectorAll('script');
      scripts.forEach(script => {
        const text = script.textContent || '';
        if (text.includes('asin') || text.includes('ASIN') || text.includes('searchResults')) {
          try {
            // Try to find JSON data with ASINs
            const jsonMatches = text.match(/\{[^{}]*"asin"\s*:\s*"([A-Z0-9]{10})"[^{}]*\}/g);
            if (jsonMatches) {
              jsonMatches.forEach(jsonStr => {
                try {
                  const obj = JSON.parse(jsonStr);
                  if (obj.asin) {
                    items.push({
                      asin: obj.asin,
                      title: obj.title || obj.itemName || '',
                      salesRank: obj.salesRank || obj.rank || null,
                    });
                  }
                } catch (e) {
                  // Individual parse failed
                }
              });
            }
          } catch (e) {
            // Script parse failed
          }
        }
      });
    }

    return items;
  });

  return results;
}

/**
 * Try to get ASIN by clicking on a search result (if ASIN is not visible in list).
 * @param {import('playwright').Page} page
 * @param {number} resultIndex - 0-based index of the result to click
 * @returns {Promise<string|null>} ASIN or null
 */
async function getAsinFromDetail(page, resultIndex) {
  try {
    // Click on the result row/link
    const clickTargets = await page.$$('.product-search-result a, [class*="product-row"] a, [class*="search-result"] a, tr td a');

    if (resultIndex >= clickTargets.length) return null;

    await clickTargets[resultIndex].click();
    await waitAndSettle(page, 3000);
    await ensurePageReady(page);

    // Extract ASIN from the detail view
    const asin = await page.evaluate(() => {
      // From URL
      const urlMatch = window.location.href.match(/\/dp\/([A-Z0-9]{10})/);
      if (urlMatch) return urlMatch[1];

      const asinMatch = window.location.href.match(/asin=([A-Z0-9]{10})/);
      if (asinMatch) return asinMatch[1];

      // From page content
      const text = document.body.innerText;
      const textMatch = text.match(/ASIN\s*:?\s*([A-Z0-9]{10})/);
      if (textMatch) return textMatch[1];

      // From data attributes
      const el = document.querySelector('[data-asin]');
      if (el) return el.getAttribute('data-asin');

      return null;
    });

    // Go back to search results
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await waitAndSettle(page, 2000);

    return asin;
  } catch (err) {
    console.error(`[SC-SEARCH] Error getting ASIN from detail: ${err.message}`);
    return null;
  }
}

/**
 * Search Seller Central for a product using Zoro data.
 * Uses multiple search strategies:
 * 1. Brand + MfrNo
 * 2. UPC
 * 3. Brand + first 3 title words
 *
 * @param {import('playwright').Page} page - Playwright page connected via CDP
 * @param {Object} zoroData - Product data from Zoro scraper
 * @param {string} zoroData.brand
 * @param {string} zoroData.mfrNo
 * @param {string} zoroData.upc
 * @param {string} zoroData.title
 * @returns {Promise<Array<{asin: string, title: string, salesRank: string|null}>>}
 */
async function searchSellerCentral(page, zoroData) {
  if (!zoroData) {
    console.log('[SC-SEARCH] No Zoro data provided');
    return [];
  }

  const brand = (zoroData.brand || '').trim();
  const mfrNo = (zoroData.mfrNo || '').trim();
  const upc = (zoroData.upc || '').trim();
  const title = (zoroData.title || '').trim();

  // Build search queries in order of priority
  const queries = [];

  // Strategy 1: Brand + MfrNo (most specific)
  if (brand && mfrNo) {
    queries.push({
      label: 'Brand + MfrNo',
      query: `${brand} ${mfrNo}`,
    });
  } else if (mfrNo) {
    queries.push({
      label: 'MfrNo only',
      query: mfrNo,
    });
  }

  // Strategy 2: UPC (very specific)
  if (upc) {
    queries.push({
      label: 'UPC',
      query: upc,
    });
  }

  // Strategy 3: Brand + first 3 words of title
  if (brand && title) {
    const titleWords = title
      .replace(/[,\-()\/\\]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && w.toLowerCase() !== brand.toLowerCase())
      .slice(0, 3)
      .join(' ');

    if (titleWords) {
      queries.push({
        label: 'Brand + Title keywords',
        query: `${brand} ${titleWords}`,
      });
    }
  }

  // Strategy 4: MfrNo alone (if not already tried)
  if (mfrNo && brand) {
    queries.push({
      label: 'MfrNo alone',
      query: mfrNo,
    });
  }

  if (queries.length === 0) {
    console.log('[SC-SEARCH] No viable search queries could be formed from Zoro data');
    return [];
  }

  // Execute queries in order until we get results
  for (const { label, query } of queries) {
    console.log(`[SC-SEARCH] Strategy: ${label} -> "${query}"`);

    try {
      const results = await executeSearch(page, query);

      if (results && results.length > 0) {
        console.log(`[SC-SEARCH] Found ${results.length} results with strategy: ${label}`);

        // If results have no ASINs, try clicking to get them
        const enrichedResults = [];
        for (let i = 0; i < Math.min(results.length, 5); i++) {
          const r = results[i];
          if (r.asin) {
            enrichedResults.push(r);
          } else {
            // Try to get ASIN by clicking into detail
            console.log(`[SC-SEARCH] Result ${i} has no ASIN, attempting detail click...`);
            const detailAsin = await getAsinFromDetail(page, i);
            if (detailAsin) {
              enrichedResults.push({
                asin: detailAsin,
                title: r.title,
                salesRank: r.salesRank,
              });
            }
          }
        }

        if (enrichedResults.length > 0) {
          return enrichedResults;
        }
      }

      console.log(`[SC-SEARCH] No results with strategy: ${label}`);

      // Small delay between strategies to avoid rate limiting
      await page.waitForTimeout(2000);

    } catch (err) {
      console.error(`[SC-SEARCH] Error with strategy ${label}: ${err.message}`);

      // If it's a session/captcha issue, don't continue
      if (err.message.includes('Session expired') || err.message.includes('Captcha')) {
        throw err;
      }
    }
  }

  console.log('[SC-SEARCH] All strategies exhausted, no results found');
  return [];
}

module.exports = { searchSellerCentral };
