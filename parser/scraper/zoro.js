const https = require('https');
const http = require('http');

/**
 * Make an HTTP(S) GET request and return { statusCode, headers, body }.
 * Follows redirects up to maxRedirects.
 */
function httpGet(url, maxRedirects = 10) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      return reject(new Error('Too many redirects'));
    }

    const proto = url.startsWith('https') ? https : http;

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
      },
      timeout: 30000,
    };

    const req = proto.get(url, options, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith('/')) {
          const parsed = new URL(url);
          redirectUrl = `${parsed.protocol}//${parsed.host}${redirectUrl}`;
        } else if (!redirectUrl.startsWith('http')) {
          const parsed = new URL(url);
          redirectUrl = `${parsed.protocol}//${parsed.host}/${redirectUrl}`;
        }
        res.resume();
        return httpGet(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          url, // final URL after redirects
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('HTTP request timed out'));
    });
  });
}

/**
 * Extract text between two markers in an HTML string.
 * Returns the first match or defaultValue.
 */
function extractBetween(html, before, after, defaultValue = null) {
  const startIdx = html.indexOf(before);
  if (startIdx === -1) return defaultValue;
  const contentStart = startIdx + before.length;
  const endIdx = html.indexOf(after, contentStart);
  if (endIdx === -1) return defaultValue;
  return html.substring(contentStart, endIdx).trim();
}

/**
 * Extract an attribute value from an HTML tag.
 * Looks for: attrName="value" or attrName='value'
 */
function extractAttr(html, tagSubstring, attrName) {
  const tagIdx = html.indexOf(tagSubstring);
  if (tagIdx === -1) return null;

  // Go backwards to find tag start
  let tagStart = tagIdx;
  while (tagStart > 0 && html[tagStart] !== '<') tagStart--;

  // Find tag end
  const tagEnd = html.indexOf('>', tagIdx);
  if (tagEnd === -1) return null;

  const tagHtml = html.substring(tagStart, tagEnd + 1);

  // Find attribute
  const attrPatterns = [
    new RegExp(`${attrName}="([^"]*)"`, 'i'),
    new RegExp(`${attrName}='([^']*)'`, 'i'),
  ];

  for (const pattern of attrPatterns) {
    const match = tagHtml.match(pattern);
    if (match) return match[1];
  }

  return null;
}

/**
 * Strip HTML tags from a string.
 */
function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Parse Zoro product page HTML and extract product data.
 */
function parseProductPage(html, pageUrl) {
  const result = {
    title: null,
    brand: null,
    mfrNo: null,
    upc: null,
    price: null,
    qty: null,
    imageUrl: null,
    url: pageUrl,
  };

  // --- Title ---
  // Try <h1> tag first
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    result.title = stripTags(h1Match[1]);
  }
  // Fallback: og:title
  if (!result.title) {
    const ogTitle = extractAttr(html, 'og:title', 'content');
    if (ogTitle) result.title = stripTags(ogTitle);
  }
  // Fallback: <title> tag
  if (!result.title) {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) result.title = stripTags(titleMatch[1]).replace(/\s*[-|].*$/, '');
  }

  // --- Brand ---
  // Look for brand in structured data or product details
  const brandPatterns = [
    /itemprop="brand"[^>]*content="([^"]+)"/i,
    /itemprop="brand"[^>]*>\s*<[^>]*itemprop="name"[^>]*content="([^"]+)"/i,
    /"brand"\s*:\s*"([^"]+)"/i,
    /"brand"\s*:\s*\{\s*"name"\s*:\s*"([^"]+)"/i,
    /Brand\s*<\/(?:dt|th|td|span|div)[^>]*>\s*<(?:dd|td|span|div)[^>]*>\s*(?:<[^>]*>)*\s*([^<]+)/i,
    /Manufacturer\s*<\/(?:dt|th|td|span|div)[^>]*>\s*<(?:dd|td|span|div)[^>]*>\s*(?:<[^>]*>)*\s*([^<]+)/i,
  ];

  for (const pattern of brandPatterns) {
    const match = html.match(pattern);
    if (match) {
      result.brand = stripTags(match[1]);
      break;
    }
  }

  // --- MfrNo (Manufacturer Part Number) ---
  const mfrPatterns = [
    /Mfr\.?\s*#\s*:?\s*(?:<[^>]*>)*\s*([A-Za-z0-9\-_.\/]+)/i,
    /MPN\s*:?\s*(?:<[^>]*>)*\s*([A-Za-z0-9\-_.\/]+)/i,
    /Manufacturer\s*(?:Part|Model)\s*(?:Number|No\.?|#)\s*:?\s*(?:<[^>]*>)*\s*([A-Za-z0-9\-_.\/]+)/i,
    /"mpn"\s*:\s*"([^"]+)"/i,
    /"model"\s*:\s*"([^"]+)"/i,
    /itemprop="mpn"[^>]*content="([^"]+)"/i,
    /Mfr\.\s*Model\s*#?\s*:?\s*(?:<[^>]*>)*\s*([A-Za-z0-9\-_.\/]+)/i,
  ];

  for (const pattern of mfrPatterns) {
    const match = html.match(pattern);
    if (match) {
      result.mfrNo = stripTags(match[1]);
      break;
    }
  }

  // --- UPC ---
  const upcPatterns = [
    /UPC\s*:?\s*(?:<[^>]*>)*\s*(\d{12,14})/i,
    /"gtin(?:12|13|14)?"\s*:\s*"(\d{12,14})"/i,
    /itemprop="gtin(?:12|13|14)?"[^>]*content="(\d{12,14})"/i,
    /UNSPSC\s*:?\s*(?:<[^>]*>)*\s*(\d+)/i,
  ];

  for (const pattern of upcPatterns) {
    const match = html.match(pattern);
    if (match) {
      result.upc = match[1];
      break;
    }
  }

  // --- Price ---
  // Prefer the original/list price (before discount), not the sale price.
  // Look for "Was $X.XX", strikethrough prices, or original-price markers first.
  let regularPrice = null;
  let anyPrice = null;

  // 1. "Was $X.XX" or "Was: $X.XX" patterns (original price before discount)
  const wasMatch = html.match(/Was\s*:?\s*\$\s*([\d,]+\.\d{2})/i);
  if (wasMatch) {
    regularPrice = parseFloat(wasMatch[1].replace(/,/g, ''));
  }

  // 2. Strikethrough / line-through price (original price that's been crossed out)
  if (!regularPrice) {
    const strikePatterns = [
      /<(?:s|strike|del)[^>]*>\s*\$?\s*([\d,]+\.\d{2})\s*<\/(?:s|strike|del)>/i,
      /text-decoration\s*:\s*line-through[^>]*>\s*\$?\s*([\d,]+\.\d{2})/i,
      /line-through[^>]*>\s*\$?\s*([\d,]+\.\d{2})/i,
      /class="[^"]*(?:original|regular|list|was|old|strike)[^"]*price[^"]*"[^>]*>\s*\$?\s*([\d,]+\.\d{2})/i,
      /class="[^"]*price[^"]*(?:original|regular|list|was|old|strike)[^"]*"[^>]*>\s*\$?\s*([\d,]+\.\d{2})/i,
    ];
    for (const pattern of strikePatterns) {
      const match = html.match(pattern);
      if (match) {
        regularPrice = parseFloat(match[1].replace(/,/g, ''));
        if (regularPrice > 0) break;
      }
    }
  }

  // 3. Fall back to any price on the page
  const pricePatterns = [
    /"price"\s*:\s*"?([\d,.]+)"?/i,
    /itemprop="price"[^>]*content="([\d,.]+)"/i,
    /class="[^"]*price[^"]*"[^>]*>\s*\$?([\d,.]+)/i,
    /\$\s*([\d,]+\.\d{2})\s*(?:\/\s*each)?/i,
  ];

  for (const pattern of pricePatterns) {
    const match = html.match(pattern);
    if (match) {
      anyPrice = parseFloat(match[1].replace(/,/g, ''));
      if (anyPrice > 0) break;
    }
  }

  // Use regular/list price if found, otherwise fall back to whatever price is on the page
  result.price = (regularPrice && regularPrice > 0) ? regularPrice : anyPrice;

  // --- Qty (Pack Size) ---
  // Extract the number of items per unit of sale, NOT availability/stock status.
  // Default to 1 (sold individually) if no pack info found.
  let packQty = null;

  // 1. Check the product title for pack-size patterns
  const titleText = result.title || '';
  const titleQtyPatterns = [
    /\bPK[- ]?(\d+)\b/i,                     // PK-4, PK 4, PK4
    /\b(\d+)[- ]?(?:PK|Pk)\b/,               // 4-PK, 4 Pk, 4PK
    /\bPack\s+of\s+(\d+)\b/i,                // Pack of 4
    /\b(\d+)[- ]?Pack\b/i,                   // 4-Pack, 4 Pack, 4Pack
    /\bBox\s+of\s+(\d+)\b/i,                 // Box of 12
    /\b(\d+)\s*\/\s*(?:Pack|Pk|Box)\b/i,     // 12/Pack, 12/Pk, 12/Box
    /\b(\d+)\s*(?:per|\/)\s*(?:pack|pk|box|case|set)\b/i, // 12 per pack
  ];

  for (const pattern of titleQtyPatterns) {
    const match = titleText.match(pattern);
    if (match) {
      packQty = parseInt(match[1], 10);
      if (packQty > 0) break;
    }
  }

  // 2. Check product specs/details for "Quantity" or "Package Quantity"
  if (!packQty) {
    const specQtyPatterns = [
      /(?:Package\s+)?Quantity\s*<\/(?:dt|th|td|span|div)[^>]*>\s*<(?:dd|td|span|div)[^>]*>\s*(?:<[^>]*>)*\s*(\d+)/i,
      /(?:Package\s+)?Quantity\s*:?\s*(?:<[^>]*>)*\s*(\d+)/i,
      /Items\s*(?:per|in)\s*(?:Package|Pack|Each)\s*<\/(?:dt|th|td|span|div)[^>]*>\s*<(?:dd|td|span|div)[^>]*>\s*(?:<[^>]*>)*\s*(\d+)/i,
      /Items\s*(?:per|in)\s*(?:Package|Pack|Each)\s*:?\s*(?:<[^>]*>)*\s*(\d+)/i,
    ];

    for (const pattern of specQtyPatterns) {
      const match = html.match(pattern);
      if (match) {
        packQty = parseInt(match[1], 10);
        if (packQty > 0) break;
      }
    }
  }

  // 3. Check for "Sold in packs of X" or similar text
  if (!packQty) {
    const soldInPatterns = [
      /Sold\s+in\s+(?:packs|boxes|sets|cases)\s+of\s+(\d+)/i,
      /Comes\s+in\s+(?:a\s+)?(?:pack|box|set|case)\s+of\s+(\d+)/i,
      /(\d+)\s+(?:per|in\s+a?)\s+(?:pack|box|set|case)\b/i,
    ];

    for (const pattern of soldInPatterns) {
      const match = html.match(pattern);
      if (match) {
        packQty = parseInt(match[1], 10);
        if (packQty > 0) break;
      }
    }
  }

  // 4. Default to 1 if no pack info found
  result.qty = (packQty && packQty > 0) ? packQty : 1;

  // --- Image URL ---
  // og:image meta tag
  const ogImage = extractAttr(html, 'og:image', 'content');
  if (ogImage && ogImage.startsWith('http')) {
    result.imageUrl = ogImage;
  }

  // Fallback: look for main product image
  if (!result.imageUrl) {
    const imgPatterns = [
      /itemprop="image"[^>]*(?:content|src)="([^"]+)"/i,
      /"image"\s*:\s*"(https?:\/\/[^"]+)"/i,
      /<img[^>]*class="[^"]*(?:product|hero|main)[^"]*"[^>]*src="([^"]+)"/i,
      /<img[^>]*src="(https?:\/\/[^"]*zoro[^"]*\/product[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
    ];

    for (const pattern of imgPatterns) {
      const match = html.match(pattern);
      if (match && match[1].startsWith('http')) {
        result.imageUrl = match[1];
        break;
      }
    }
  }

  return result;
}

/**
 * Parse Zoro search results page and return URLs of matching products.
 */
function parseSearchResults(html) {
  const results = [];

  // Look for product links in search results
  const linkPatterns = [
    /href="(\/[^"]*\/i\/[^"]+)"/gi,
    /href="(\/product[^"]+)"/gi,
    /data-href="(\/[^"]+)"/gi,
  ];

  for (const pattern of linkPatterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const href = match[1];
      // Filter out non-product links
      if (href && !href.includes('/search') && !href.includes('/cart') && !href.includes('/account')) {
        const fullUrl = `https://www.zoro.com${href}`;
        if (!results.includes(fullUrl)) {
          results.push(fullUrl);
        }
      }
    }
  }

  return results;
}

/**
 * Try to extract JSON-LD structured data from the page.
 */
function extractJsonLd(html) {
  const results = [];
  const pattern = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1].trim());
      results.push(data);
    } catch (e) {
      // Skip malformed JSON-LD
    }
  }

  return results;
}

/**
 * Enhance product data from JSON-LD structured data if available.
 */
function enrichFromJsonLd(product, jsonLdList) {
  for (const data of jsonLdList) {
    const item = data['@type'] === 'Product' ? data : null;
    if (!item) continue;

    if (!product.title && item.name) product.title = item.name;
    if (!product.brand && item.brand) {
      product.brand = typeof item.brand === 'string' ? item.brand : item.brand.name;
    }
    if (!product.mfrNo && item.mpn) product.mfrNo = item.mpn;
    if (!product.mfrNo && item.model) product.mfrNo = item.model;
    if (!product.upc && item.gtin12) product.upc = item.gtin12;
    if (!product.upc && item.gtin13) product.upc = item.gtin13;
    if (!product.imageUrl && item.image) {
      product.imageUrl = typeof item.image === 'string' ? item.image : (Array.isArray(item.image) ? item.image[0] : item.image.url);
    }

    // Extract pack quantity from JSON-LD if not already set from title/specs
    if (product.qty === 1) {
      // Check for quantity-related properties in JSON-LD
      const jsonQty = item.quantity || item.packageQuantity || item.numberOfItems
        || (item.additionalProperty && Array.isArray(item.additionalProperty)
          && item.additionalProperty.find(p => /quantity|pack/i.test(p.name || ''))
          && parseInt(item.additionalProperty.find(p => /quantity|pack/i.test(p.name || '')).value, 10));
      if (jsonQty && parseInt(jsonQty, 10) > 0) {
        product.qty = parseInt(jsonQty, 10);
      }
    }

    if (item.offers) {
      const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
      if (!product.price && offer.price) {
        product.price = parseFloat(offer.price);
      }
      // Do NOT overwrite qty with availability — qty is pack size, not stock status
    }
  }

  return product;
}

/**
 * Scrape Zoro.com for a given SKU.
 * 1. Search for the SKU
 * 2. If redirected to product page, parse it
 * 3. If search results, take the first result
 * 4. Parse product page for full data
 *
 * @param {string} sku - The Zoro SKU to search for
 * @returns {Promise<Object|null>} Product data or null if not found
 */
async function scrapeZoro(sku) {
  if (!sku || typeof sku !== 'string') {
    return null;
  }

  const cleanSku = sku.trim().replace(/[^a-zA-Z0-9\-_.]/g, '');
  if (!cleanSku) return null;

  const searchUrl = `https://www.zoro.com/search?q=${encodeURIComponent(cleanSku)}`;
  console.log(`[ZORO] Searching: ${searchUrl}`);

  let response;
  try {
    response = await httpGet(searchUrl);
  } catch (err) {
    console.error(`[ZORO] HTTP error: ${err.message}`);
    return null;
  }

  if (response.statusCode !== 200) {
    console.error(`[ZORO] HTTP ${response.statusCode}`);
    return null;
  }

  const html = response.body;
  const finalUrl = response.url;

  // Check if we landed on a product page (redirect from search)
  const isProductPage = finalUrl.includes('/i/') || finalUrl.match(/\/[A-Za-z0-9\-]+\/[A-Z0-9]+\/?$/);

  let productHtml = html;
  let productUrl = finalUrl;

  if (!isProductPage) {
    // We're on search results page — find the first product link
    console.log('[ZORO] Got search results page, looking for first product...');

    const productLinks = parseSearchResults(html);

    if (productLinks.length === 0) {
      console.log('[ZORO] No products found in search results');
      return null;
    }

    console.log(`[ZORO] Found ${productLinks.length} products, fetching first: ${productLinks[0]}`);

    try {
      const productResponse = await httpGet(productLinks[0]);
      if (productResponse.statusCode !== 200) {
        console.error(`[ZORO] Product page HTTP ${productResponse.statusCode}`);
        return null;
      }
      productHtml = productResponse.body;
      productUrl = productResponse.url;
    } catch (err) {
      console.error(`[ZORO] Error fetching product page: ${err.message}`);
      return null;
    }
  }

  // Parse the product page
  let product = parseProductPage(productHtml, productUrl);

  // Try to enrich from JSON-LD structured data
  const jsonLdData = extractJsonLd(productHtml);
  if (jsonLdData.length > 0) {
    product = enrichFromJsonLd(product, jsonLdData);
  }

  // Validate we got minimum required data
  if (!product.title && !product.brand && !product.mfrNo) {
    console.log('[ZORO] Could not extract product data — likely not a valid product page');
    return null;
  }

  console.log(`[ZORO] Parsed: ${product.brand || '?'} / ${product.mfrNo || '?'} / $${product.price || '?'}`);

  return product;
}

module.exports = { scrapeZoro };
