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
    // Timeout is OK
  }
}

/**
 * Handle captcha and session checks.
 * @param {import('playwright').Page} page
 * @param {string} retryUrl - URL to navigate to after resolving captcha/session
 */
async function ensurePageReady(page, retryUrl) {
  if (await checkCaptcha(page)) {
    console.log('[AMZ-EXTRACT] Captcha detected, waiting for resolution...');
    const resolved = await waitForCaptchaResolution(page);
    if (!resolved) throw new Error('Captcha was not resolved within timeout');
    if (retryUrl) {
      await page.goto(retryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await waitAndSettle(page, 5000);
    }
  }

  if (await checkSession(page)) {
    console.log('[AMZ-EXTRACT] Session expired, waiting for login...');
    const resolved = await waitForSessionResolution(page);
    if (!resolved) throw new Error('Session expired and was not resolved');
    if (retryUrl) {
      await page.goto(retryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await waitAndSettle(page, 5000);
    }
  }
}

/**
 * Scroll down the page incrementally to trigger lazy loading of images and content.
 * @param {import('playwright').Page} page
 */
async function scrollPage(page) {
  await page.evaluate(async () => {
    const distance = 500;
    const delay = 300;
    const maxScroll = Math.min(document.body.scrollHeight, 15000);

    let scrolled = 0;
    while (scrolled < maxScroll) {
      window.scrollBy(0, distance);
      scrolled += distance;
      await new Promise(r => setTimeout(r, delay));
    }

    // Scroll back to top
    window.scrollTo(0, 0);
  });
}

/**
 * Extract ALL product data from an Amazon product page (amazon.com/dp/ASIN).
 * This is a comprehensive dump of everything visible on the page:
 * title, brand, price, seller, availability, rating, reviews,
 * all product details, feature bullets, images, badges, BSR, categories,
 * variations, frequently bought together, A+ content detection, etc.
 *
 * @param {import('playwright').Page} page - Playwright page connected via CDP
 * @param {string} asin - Amazon ASIN to extract
 * @returns {Promise<Object>} Full product data object
 */
async function extractAmazonProduct(page, asin) {
  if (!asin) throw new Error('ASIN is required');

  const url = `https://www.amazon.com/dp/${asin}`;
  console.log(`[AMZ-EXTRACT] Navigating to: ${url}`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await waitAndSettle(page, 5000);

    // Check for captcha/session issues
    await ensurePageReady(page, url);

    // Scroll down to load all lazy content (images, below-fold sections)
    console.log('[AMZ-EXTRACT] Scrolling page to load lazy content...');
    await scrollPage(page);
    await page.waitForTimeout(2000);

    // Extract everything from the DOM
    console.log('[AMZ-EXTRACT] Extracting product data...');
    const data = await page.evaluate((inputAsin) => {
      const result = {
        asin: inputAsin,
        url: window.location.href,
        title: null,
        brand: null,
        byline: null,
        price: null,
        priceWas: null,
        listPrice: null,
        pricePer: null,
        coupon: null,
        soldBy: null,
        shipsFrom: null,
        sellerLink: null,
        merchantInfo: null,
        availability: null,
        maxQty: null,
        rating: null,
        reviewCount: null,
        answeredQuestions: null,
        featureBullets: [],
        description: null,
        details: {},
        images: [],
        bsr: null,
        bsrCategories: [],
        categories: [],
        badges: {
          amazonChoice: false,
          bestSeller: false,
          prime: false,
          smallBusiness: false,
          minorityOwned: false,
          climatePledge: false,
          limitedDeal: false,
          coupon: false,
          subscribe: false,
        },
        variations: [],
        frequentlyBoughtTogether: [],
        otherSellers: null,
        fromTheManufacturer: false,
        aPlus: false,
        videoCount: 0,
      };

      // --- Helpers ---
      function getText(selector) {
        const el = document.querySelector(selector);
        return el ? el.textContent.trim() : '';
      }

      function getAttr(selector, attr) {
        const el = document.querySelector(selector);
        return el ? el.getAttribute(attr) : null;
      }

      // ============================================================
      // TITLE
      // ============================================================
      result.title = getText('#productTitle') ||
                     getText('#title span') ||
                     getText('#title') ||
                     getText('h1.product-title-word-break') ||
                     getText('h1[data-automation-id="title"]') ||
                     getText('h1');

      // ============================================================
      // BRAND / BYLINE
      // ============================================================
      result.byline = getText('#bylineInfo') ||
                      getText('a#bylineInfo') ||
                      getText('#brand') ||
                      getText('.po-brand .a-span9 .a-size-base');

      // Extract just the brand name (strip "Brand:", "Visit the X Store", etc.)
      if (result.byline) {
        result.brand = result.byline
          .replace(/^(?:Brand|Visit|Shop)\s*:?\s*/i, '')
          .replace(/\s*(?:Store|Shop)$/i, '')
          .replace(/^Visit the\s*/i, '')
          .trim();
      }
      // Fallback brand sources
      if (!result.brand) {
        result.brand = getText('.po-brand .a-span9 span') ||
                       getText('#productOverview_feature_div .po-brand .a-span9 span');
      }

      // ============================================================
      // PRICE
      // ============================================================
      // Buy box price (main price)
      const priceWhole = getText('.a-price .a-price-whole');
      const priceFraction = getText('.a-price .a-price-fraction');
      if (priceWhole) {
        result.price = `$${priceWhole.replace(/[.,\s]$/, '')}.${priceFraction || '00'}`;
      }
      if (!result.price) {
        // Try various price selectors
        const priceSelectors = [
          '#corePrice_feature_div .a-price .a-offscreen',
          '#priceblock_ourprice',
          '#priceblock_dealprice',
          '#priceblock_saleprice',
          '#price_inside_buybox',
          '.a-price .a-offscreen',
          '#tp_price_block_total_price_ww .a-offscreen',
          '#newBuyBoxPrice',
        ];
        for (const sel of priceSelectors) {
          const p = getText(sel);
          if (p && p.includes('$')) {
            result.price = p.replace(/\s+/g, '').trim();
            break;
          }
        }
      }
      // Ensure $ prefix
      if (result.price && !result.price.startsWith('$') && /^\d/.test(result.price)) {
        result.price = '$' + result.price;
      }

      // Was price (strikethrough / list price)
      const wasEl = document.querySelector('.a-text-price .a-offscreen, .basisPrice .a-offscreen');
      if (wasEl) result.priceWas = wasEl.textContent.trim();
      result.listPrice = getText('.basisPrice .a-offscreen') || result.priceWas || '';

      // Price per unit
      result.pricePer = getText('#pricePerUnit') || getText('.a-price-per-unit');

      // Coupon
      const couponEl = document.querySelector('#couponBadgeRegularVpc, #vpcButton, [data-csa-c-content-id*="coupon"]');
      if (couponEl) {
        result.coupon = couponEl.textContent.trim().replace(/\s+/g, ' ');
        result.badges.coupon = true;
      }

      // ============================================================
      // SELLER INFO
      // ============================================================
      // Tabular buybox layout
      const tbColumns = document.querySelectorAll('#tabular-buybox .tabular-buybox-container .tabular-buybox-column');
      for (let i = 0; i < tbColumns.length - 1; i++) {
        const label = (tbColumns[i].textContent || '').trim().toLowerCase();
        const valueEl = tbColumns[i + 1];
        const value = (valueEl.textContent || '').trim();
        if (label.includes('sold by')) {
          result.soldBy = value;
          const link = valueEl.querySelector('a');
          if (link) result.sellerLink = link.textContent.trim();
        }
        if (label.includes('ships from')) {
          result.shipsFrom = value;
        }
      }

      // Alternative tabular buybox (text-based)
      if (!result.soldBy) {
        const tbRows = document.querySelectorAll('#tabular-buybox .tabular-buybox-text');
        for (let i = 0; i < tbRows.length - 1; i++) {
          const txt = tbRows[i].textContent.trim();
          if (txt.includes('Sold by') && tbRows[i + 1]) {
            result.soldBy = tbRows[i + 1].textContent.trim();
          }
          if (txt.includes('Ships from') && tbRows[i + 1]) {
            result.shipsFrom = tbRows[i + 1].textContent.trim();
          }
        }
      }

      // Seller profile link
      if (!result.sellerLink) {
        result.sellerLink = getText('#sellerProfileTriggerId') || '';
      }

      // Merchant info fallback
      result.merchantInfo = getText('#merchant-info');
      if (!result.soldBy && result.merchantInfo) {
        const soldMatch = result.merchantInfo.match(/(?:sold|Sold)\s+by\s+(.+?)(?:\.|Ships|$)/i);
        if (soldMatch) result.soldBy = soldMatch[1].trim();
        const shipsMatch = result.merchantInfo.match(/Ships\s+from\s+(.+?)(?:\.|$)/i);
        if (shipsMatch && !result.shipsFrom) result.shipsFrom = shipsMatch[1].trim();
      }

      // ============================================================
      // AVAILABILITY & QUANTITY
      // ============================================================
      result.availability = getText('#availability span') || getText('#availability') ||
                            getText('#outOfStock span') || getText('#availabilityInsideBuyBox_feature_div span');
      if (result.availability) {
        result.availability = result.availability.replace(/\s+/g, ' ').trim();
      }

      // Max quantity from dropdown
      const qtyOptions = document.querySelectorAll('#quantity option, #a-autoid-0-dropdown option, select#quantity option');
      if (qtyOptions.length > 0) {
        result.maxQty = qtyOptions[qtyOptions.length - 1].value || qtyOptions[qtyOptions.length - 1].textContent.trim();
      }
      if (!result.maxQty) {
        const qtyText = getText('#quantityDropdownContainer');
        if (qtyText) {
          const qtyMatch = qtyText.match(/(\d+)/);
          if (qtyMatch) result.maxQty = qtyMatch[1];
        }
      }

      // ============================================================
      // RATING & REVIEWS
      // ============================================================
      const ratingText = getText('#acrPopover .a-icon-alt') ||
                         getText('[data-hook="rating-out-of-text"]') ||
                         getText('.a-icon-star .a-icon-alt') ||
                         getText('#acrPopover .a-size-base');
      if (ratingText) {
        const ratingMatch = ratingText.match(/([\d.]+)/);
        if (ratingMatch) result.rating = ratingMatch[1];
      }

      const reviewText = getText('#acrCustomerReviewText') ||
                         getText('[data-hook="total-review-count"]') ||
                         getText('#acrCustomerReviewLink span');
      if (reviewText) {
        result.reviewCount = reviewText.replace(/[^0-9,()]/g, '').trim();
      }

      // Answered questions
      result.answeredQuestions = getText('#askATFLink span');

      // ============================================================
      // FEATURE BULLETS
      // ============================================================
      const bulletEls = document.querySelectorAll('#feature-bullets li span.a-list-item, #feature-bullets ul li span');
      bulletEls.forEach(el => {
        const text = el.textContent.trim();
        if (text && text.length > 5 && text.length < 1000 &&
            !text.includes('Make sure this fits') &&
            !text.includes('Click \'See more\'')) {
          result.featureBullets.push(text);
        }
      });

      // ============================================================
      // PRODUCT DESCRIPTION
      // ============================================================
      result.description = getText('#productDescription p') ||
                           getText('#productDescription span') ||
                           getText('#productDescription') ||
                           getText('#productDescription_feature_div');
      if (result.description) {
        result.description = result.description.replace(/\s+/g, ' ').trim();
        if (result.description.length > 2000) result.description = result.description.substring(0, 2000);
      }

      // ============================================================
      // PRODUCT DETAILS (all key-value pairs from all tables)
      // ============================================================

      // Technical Details / Additional Information tables (th+td format)
      const detailRows = document.querySelectorAll(
        '#productDetails_techSpec_section_1 tr, ' +
        '#productDetails_detailBullets_sections1 tr, ' +
        '#productDetails_db_sections tr, ' +
        '.prodDetTable tr, ' +
        '#prodDetails tr'
      );
      detailRows.forEach(row => {
        const th = row.querySelector('th');
        const td = row.querySelector('td');
        if (th && td) {
          const key = th.textContent.replace(/\u200E/g, '').replace(/\s+/g, ' ').trim().replace(/\s*:\s*$/, '');
          let val = td.textContent.replace(/\u200E/g, '').replace(/\s+/g, ' ').trim();
          if (val.length > 500) val = val.substring(0, 500);
          if (key && val && key.length < 100 && !val.startsWith('Click here') && !val.startsWith('Would you like')) {
            result.details[key] = val;
          }
        }
      });

      // Detail bullets format (span.a-text-bold + adjacent span)
      const bulletDetails = document.querySelectorAll('#detailBulletsWrapper_feature_div li, #detailBullets_feature_div li');
      bulletDetails.forEach(li => {
        const spans = li.querySelectorAll('span span');
        if (spans.length >= 2) {
          const key = spans[0].textContent.replace(/\u200E/g, '').replace(/[:\s]+$/g, '').replace(/\s+/g, ' ').trim();
          let val = spans[1].textContent.replace(/\u200E/g, '').replace(/\s+/g, ' ').trim();
          if (val.length > 500) val = val.substring(0, 500);
          if (key && val && key.length < 100) {
            result.details[key] = val;
          }
        }
        // Single-span variant (bold key, remaining text is value)
        if (spans.length < 2) {
          const boldSpan = li.querySelector('.a-text-bold');
          if (boldSpan) {
            const key = boldSpan.textContent.replace(/\u200E/g, '').replace(/[:\s]+$/g, '').replace(/\s+/g, ' ').trim();
            const fullText = li.textContent.replace(/\u200E/g, '').replace(/\s+/g, ' ').trim();
            const val = fullText.replace(boldSpan.textContent, '').replace(/^\s*[:]\s*/, '').trim();
            if (key && val && key.length < 100 && val.length > 0 && val.length < 500) {
              result.details[key] = val;
            }
          }
        }
      });

      // Product Overview section (quick specs above the fold)
      const overviewRows = document.querySelectorAll('#productOverview_feature_div tr, #productOverview_feature_div .a-row');
      overviewRows.forEach(row => {
        const labelEl = row.querySelector('.a-span3 span, td:first-child span, .po-break-word .a-size-base:first-child');
        const valueEl = row.querySelector('.a-span9 span, td:last-child span, .po-break-word .a-size-base:last-child');
        if (labelEl && valueEl) {
          const key = labelEl.textContent.trim();
          const val = valueEl.textContent.trim();
          if (key && val && key !== val) {
            result.details[key] = val;
          }
        }
      });

      // Important Information section
      const infoSection = document.querySelector('#important-information');
      if (infoSection) {
        const infoText = infoSection.textContent.replace(/\s+/g, ' ').trim();
        if (infoText.length > 10) {
          result.details['Important Information'] = infoText.substring(0, 1000);
        }
      }

      // ============================================================
      // BSR (Best Sellers Rank)
      // ============================================================
      // From details table
      const bsrKey = Object.keys(result.details).find(k =>
        k.toLowerCase().includes('best sellers rank') ||
        k.toLowerCase().includes('amazon best sellers rank')
      );
      if (bsrKey) {
        result.bsr = result.details[bsrKey];
      }

      // Fallback: dedicated BSR elements
      if (!result.bsr) {
        const bsrEls = document.querySelectorAll('#SalesRank, #detailBulletsWrapper_feature_div li');
        bsrEls.forEach(el => {
          const text = el.textContent;
          if (text.includes('Best Sellers Rank') || text.includes('Amazon Best Sellers Rank')) {
            result.bsr = text
              .replace(/.*(?:Best Sellers Rank|Amazon Best Sellers Rank)/i, '')
              .replace(/[\n\r]+/g, ' ')
              .replace(/\s+/g, ' ')
              .replace(/^[\s:#]+/, '')
              .trim();
          }
        });
      }

      // Also check the detail rows we already parsed
      if (!result.bsr) {
        detailRows.forEach(row => {
          const text = row.textContent || '';
          if (text.includes('Best Sellers Rank')) {
            const td = row.querySelector('td');
            if (td) {
              result.bsr = td.textContent.replace(/\s+/g, ' ').trim();
            }
          }
        });
      }

      // Parse BSR categories
      if (result.bsr) {
        const bsrPattern = /#([\d,]+)\s+in\s+([^(#\n]+)/g;
        let bsrMatch;
        while ((bsrMatch = bsrPattern.exec(result.bsr)) !== null) {
          result.bsrCategories.push({
            rank: parseInt(bsrMatch[1].replace(/,/g, '')),
            category: bsrMatch[2].trim().replace(/\s*\(.*$/, ''),
          });
        }
      }

      // ============================================================
      // CATEGORIES (breadcrumbs)
      // ============================================================
      const breadcrumbs = document.querySelectorAll('#wayfinding-breadcrumbs_container li a, .a-subheader .a-breadcrumb a');
      breadcrumbs.forEach(a => {
        const cat = a.textContent.trim();
        if (cat && cat.length > 1) {
          result.categories.push(cat);
        }
      });
      // Also add categories from BSR
      if (result.bsr) {
        const bsrLinks = document.querySelectorAll('#SalesRank a, #productDetails_detailBullets_sections1 a');
        bsrLinks.forEach(a => {
          const cat = a.textContent.trim();
          if (cat && cat.length > 1 && !result.categories.includes(cat)) {
            result.categories.push(cat);
          }
        });
      }

      // ============================================================
      // IMAGES
      // ============================================================
      // Main image (high resolution)
      const mainImg = document.querySelector('#landingImage, #imgBlkFront, #ebooksImgBlkFront');
      if (mainImg) {
        const hiRes = mainImg.getAttribute('data-old-hires');
        const dynamicImg = mainImg.getAttribute('data-a-dynamic-image');
        const src = mainImg.getAttribute('src');

        if (hiRes && hiRes.startsWith('http')) {
          result.images.push(hiRes);
        } else if (dynamicImg) {
          try {
            const imgObj = JSON.parse(dynamicImg);
            const urls = Object.keys(imgObj);
            // Sort by resolution (largest first)
            urls.sort((a, b) => {
              const aRes = imgObj[a] ? imgObj[a][0] * imgObj[a][1] : 0;
              const bRes = imgObj[b] ? imgObj[b][0] * imgObj[b][1] : 0;
              return bRes - aRes;
            });
            urls.forEach(u => {
              if (u.startsWith('http') && !result.images.includes(u)) {
                result.images.push(u);
              }
            });
          } catch (e) {
            if (src && src.startsWith('http')) result.images.push(src);
          }
        } else if (src && src.startsWith('http')) {
          result.images.push(src);
        }
      }

      // Thumbnail images -> full-size
      const thumbs = document.querySelectorAll(
        '#altImages .a-button-thumbnail img, ' +
        '#imageBlock_feature_div .imageThumbnail img, ' +
        '.regularAltImageViewLayout img'
      );
      thumbs.forEach(img => {
        let src = img.getAttribute('src') || '';
        // Convert thumbnail URL to full-size by removing size suffix
        src = src.replace(/\._[A-Z]{2}\d+_\./, '.');
        src = src.replace(/\._[A-Z]+\d+,\d+_\./, '.');
        src = src.replace(/\._[A-Z0-9_,]+_\./, '.');

        if (src.startsWith('http') && !src.includes('play-button') && !src.includes('video') && !result.images.includes(src)) {
          result.images.push(src);
        }
      });

      // Color/variant images with data-old-hires
      const hiResImgs = document.querySelectorAll('.imgTagWrapper img[data-old-hires], #imageBlock img[data-old-hires]');
      hiResImgs.forEach(img => {
        const hiRes = img.getAttribute('data-old-hires');
        if (hiRes && hiRes.startsWith('http') && !result.images.includes(hiRes)) {
          result.images.push(hiRes);
        }
      });

      // ============================================================
      // BADGES
      // ============================================================
      const pageText = document.body.innerText || '';

      // Amazon's Choice
      const acBadge = document.querySelector('#acBadge_feature_div, .ac-badge-wrapper, [data-csa-c-content-id="ac-badge"]');
      if (acBadge && (acBadge.textContent || '').includes('Choice')) {
        result.badges.amazonChoice = true;
      }
      if (!result.badges.amazonChoice && pageText.includes("Amazon's Choice")) {
        result.badges.amazonChoice = true;
      }

      // Best Seller
      const bsBadge = document.querySelector('.p13n-best-seller-badge, #zeitgeistBadge_feature_div, i.p13n-best-seller-badge');
      if (bsBadge) result.badges.bestSeller = true;
      if (!result.badges.bestSeller && pageText.includes('Best Seller') && !pageText.match(/Best Sellers? Rank/)) {
        result.badges.bestSeller = true;
      }
      if (result.bsr && result.bsr.includes('#1 ')) {
        result.badges.bestSeller = true;
      }

      // Prime
      const primeIcon = document.querySelector('#primeIcon, .a-icon-prime, #buyboxPrimeIcon, i[class*="prime"], i.a-icon-prime');
      if (primeIcon) result.badges.prime = true;
      if (!result.badges.prime && document.querySelector('#prime-widget')) {
        result.badges.prime = true;
      }

      // Small Business
      const smallBiz = document.querySelector('[data-csa-c-content-id="small-business-badge"], .small-business-badge');
      if (smallBiz) result.badges.smallBusiness = true;
      if (!result.badges.smallBusiness && (pageText.includes('Small Business') || pageText.includes('small business'))) {
        result.badges.smallBusiness = true;
      }

      // Minority-Owned / Black-Owned / Women-Owned / Veteran-Owned
      const minorityKeywords = [
        'minority-owned', 'Minority Owned', 'Minority-Owned',
        'black-owned', 'Black Owned', 'Black-Owned',
        'women-owned', 'Women Owned', 'Women-Owned',
        'veteran-owned', 'Veteran Owned', 'Veteran-Owned',
        'hispanic-owned', 'Hispanic Owned',
        'LGBTQ-owned', 'LGBTQ Owned',
      ];
      for (const kw of minorityKeywords) {
        if (pageText.includes(kw)) {
          result.badges.minorityOwned = true;
          break;
        }
      }
      const diversityBadge = document.querySelector('[data-csa-c-content-id*="diversity"], [class*="diversity"], [class*="minority"]');
      if (diversityBadge) result.badges.minorityOwned = true;

      // Climate Pledge Friendly
      const climateBadge = document.querySelector('#climatePledgeFriendly, [data-csa-c-content-id*="climate"]');
      if (climateBadge) result.badges.climatePledge = true;
      if (!result.badges.climatePledge && pageText.includes('Climate Pledge')) {
        result.badges.climatePledge = true;
      }

      // Limited Time Deal
      const dealBadge = document.querySelector('#dealBadge_feature_div, .dealBadge, [data-csa-c-content-id*="deal"]');
      if (dealBadge) result.badges.limitedDeal = true;

      // Subscribe & Save
      if (pageText.includes('Subscribe & Save') || pageText.includes('Subscribe &amp; Save')) {
        result.badges.subscribe = true;
      }

      // ============================================================
      // VARIATIONS (size, color, style options)
      // ============================================================
      const varSelectors = [
        '#variation_size_name li',
        '#variation_color_name li',
        '#variation_style_name li',
        '#variation_pattern_name li',
        '.swatchAvailable',
        '.twisterSlotDiv',
      ];
      varSelectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(li => {
          const text = li.textContent.trim().replace(/\s+/g, ' ');
          const isSelected = li.classList.contains('swatchSelect') ||
                             !!li.querySelector('.a-button-selected') ||
                             li.getAttribute('aria-checked') === 'true';
          if (text && text.length < 100 && text.length > 0) {
            result.variations.push({
              text: text,
              selected: isSelected,
            });
          }
        });
      });

      // Also check variation dropdowns (option elements)
      const varDropdowns = document.querySelectorAll(
        '#variation_size_name select option, ' +
        '#variation_color_name select option, ' +
        '#variation_style_name select option, ' +
        '.swatchSelect option'
      );
      varDropdowns.forEach(opt => {
        const val = opt.textContent.trim();
        if (val && !val.includes('Select') && val.length < 100) {
          result.variations.push({
            text: val,
            selected: opt.selected,
          });
        }
      });

      // ============================================================
      // FREQUENTLY BOUGHT TOGETHER
      // ============================================================
      const fbtItems = document.querySelectorAll('#sims-fbt .a-spacing-small .a-link-normal, #sims-fbt a[href*="/dp/"]');
      const fbtSeen = new Set();
      fbtItems.forEach(a => {
        const href = a.getAttribute('href') || '';
        const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})/);
        if (asinMatch && !fbtSeen.has(asinMatch[1])) {
          fbtSeen.add(asinMatch[1]);
          result.frequentlyBoughtTogether.push({
            asin: asinMatch[1],
            title: a.textContent.trim().substring(0, 200),
          });
        }
      });

      // ============================================================
      // OTHER SELLERS
      // ============================================================
      result.otherSellers = getText('#olp-upd-new a, #olp_feature_div a, #buybox-see-all-buying-choices a');

      // ============================================================
      // A+ CONTENT / FROM THE MANUFACTURER
      // ============================================================
      const aplusContent = document.querySelector('#aplus_feature_div, #aplus, .aplus-v2, #aplusProductDescription_feature_div');
      if (aplusContent && aplusContent.innerHTML.length > 200) {
        result.aPlus = true;
      }

      const fromMfr = document.querySelector('#dpx-btf-content, #dpx-aplus-product-description_feature_div');
      if (fromMfr && fromMfr.innerHTML.length > 200) {
        result.fromTheManufacturer = true;
      }

      // ============================================================
      // VIDEOS
      // ============================================================
      const videoThumbs = document.querySelectorAll(
        '.videoThumbnail, ' +
        '[class*="video-thumb"], ' +
        '.vse-vw-dp-container, ' +
        '#altImages .videoThumbnail'
      );
      result.videoCount = videoThumbs.length;
      // Check image strip for video indicators
      const videoInStrip = document.querySelectorAll('#altImages [class*="video"], .imageThumbnail .videoThumbnail');
      if (videoInStrip.length > result.videoCount) {
        result.videoCount = videoInStrip.length;
      }

      return result;
    }, asin);

    // Post-processing: extract weight and dimensions from details
    data.weight = extractField(data.details, ['Item Weight', 'Weight', 'Package Weight']);
    data.dimensions = extractField(data.details, [
      'Product Dimensions', 'Item Dimensions LxWxH', 'Item Dimensions', 'Package Dimensions', 'Dimensions',
    ]);

    console.log(`[AMZ-EXTRACT] Extracted: "${(data.title || '').substring(0, 60)}..." | Price: ${data.price} | Rating: ${data.rating}`);
    console.log(`[AMZ-EXTRACT] Details: ${Object.keys(data.details).length} keys | Images: ${data.images.length} | Bullets: ${data.featureBullets.length}`);
    console.log(`[AMZ-EXTRACT] BSR: ${data.bsr ? data.bsr.substring(0, 80) : 'N/A'} | Seller: ${data.soldBy || 'N/A'}`);

    return data;

  } catch (err) {
    console.error(`[AMZ-EXTRACT] Error extracting ${asin}: ${err.message}`);
    throw err;
  }
}

/**
 * Extract a field from the details object, trying multiple possible key names.
 * @param {Object} details
 * @param {string[]} keys - possible key names (case-insensitive partial match)
 * @returns {string}
 */
function extractField(details, keys) {
  if (!details) return '';
  for (const key of keys) {
    for (const detailKey of Object.keys(details)) {
      if (detailKey.toLowerCase().includes(key.toLowerCase())) {
        return details[detailKey];
      }
    }
  }
  return '';
}

/**
 * Parse a price string like "$44.85" or "$1,234.56" to a number.
 * @param {string} priceStr
 * @returns {number|null}
 */
function parsePrice(priceStr) {
  if (!priceStr) return null;
  const cleaned = priceStr.replace(/[^0-9.,]/g, '').replace(/,/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Check if item is oversized based on dimensions string.
 * Oversized = volume > 550 cubic inches.
 * @param {string} dimensionsStr
 * @returns {boolean}
 */
function isOversized(dimensionsStr) {
  if (!dimensionsStr) return false;
  const match = dimensionsStr.match(/([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)/);
  if (!match) return false;
  const volume = parseFloat(match[1]) * parseFloat(match[2]) * parseFloat(match[3]);
  return volume > 550;
}

/**
 * Check if seller name matches brand name (seller IS the brand).
 * @param {string} sellerName
 * @param {string} brandName
 * @returns {boolean}
 */
function sellerIsBrand(sellerName, brandName) {
  if (!sellerName || !brandName) return false;
  const s = sellerName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const b = brandName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!s || !b) return false;
  return s.includes(b) || b.includes(s);
}

module.exports = {
  extractAmazonProduct,
  parsePrice,
  isOversized,
  sellerIsBrand,
};
