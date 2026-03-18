const { chromium } = require('playwright');
const { execSync } = require('child_process');
const db = require('./db');
const config = require('./config.json');
const { scrapeZoro } = require('./scraper/zoro');
const { searchSellerCentral } = require('./scraper/amazon-search');
const { extractAmazonProduct, parsePrice, isOversized, sellerIsBrand } = require('./scraper/amazon-extract');
const { downloadImage } = require('./scraper/images');
const { checkCaptcha, checkSession } = require('./scraper/captcha');
const path = require('path');
const fs = require('fs');

// Initialize DB (async, called in mainLoop)

// Worker state
let browser = null;
let page = null;
let isRunning = false;

// ============================================================
// LOGGING
// ============================================================

/**
 * Write a log entry to console, to the daily log file, and to the item's log field in DB.
 * @param {number|null} jobId
 * @param {number|null} itemId
 * @param {'INFO'|'WARN'|'ERROR'} level
 * @param {string} message
 */
function log(jobId, itemId, level, message) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] [${level}] [job:${jobId || '-'}] [item:${itemId || '-'}] ${message}`;

  // Console
  console.log(entry);

  // File
  try {
    const logDir = path.resolve(__dirname, config.paths.logs);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const today = ts.split('T')[0];
    fs.appendFileSync(path.join(logDir, `parser-${today}.log`), entry + '\n');
  } catch (e) {
    // Don't crash on log write failure
  }

  // DB (append to item's log field)
  if (itemId) {
    try {
      const item = db.getItem(itemId);
      if (item) {
        const shortTs = ts.substring(11, 19);
        const existing = item.log || '';
        db.updateItem(itemId, { log: existing + `[${shortTs}] ${message}\n` });
      }
    } catch (e) {
      // Don't crash on DB log write failure
    }
  }
}

// ============================================================
// BROWSER CONNECTION
// ============================================================

/**
 * Connect to Chrome via CDP (remote debugging protocol).
 * Chrome is running on the Windows VPS with --remote-debugging-port=9223.
 */
async function connectBrowser() {
  if (browser) {
    try { await browser.close(); } catch (e) {}
    browser = null;
    page = null;
  }

  log(null, null, 'INFO', `Connecting to CDP: ${config.cdpEndpoint}`);
  browser = await chromium.connectOverCDP(config.cdpEndpoint);

  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('No browser context found');

  page = ctx.pages()[0];
  if (!page) throw new Error('No browser page found');

  log(null, null, 'INFO', 'Connected to browser successfully');
  return page;
}

// ============================================================
// TIMING / DELAY
// ============================================================

/**
 * Calculate delay between items based on job speed (items/hour).
 * Adds +/- 30% jitter to avoid detection patterns.
 * @param {number} speed - items per hour
 * @returns {number} delay in milliseconds
 */
function getDelay(speed) {
  if (!speed || speed <= 0) speed = config.defaultSpeed || 50;
  const baseDelay = Math.floor(3600000 / speed); // ms per item
  const jitter = baseDelay * 0.3 * (Math.random() * 2 - 1); // +/- 30%
  return Math.max(1000, Math.floor(baseDelay + jitter)); // minimum 1 second
}

// ============================================================
// AI ANALYSIS
// ============================================================

/**
 * Run AI analysis using Claude Code CLI.
 * Model fallback chain: opus-4-6 -> sonnet-4-6 -> sonnet-4-5
 * @param {Object} zoroData
 * @param {Object} amazonData
 * @returns {{model: string, result: string}}
 */
function runAIAnalysis(zoroData, amazonData) {
  const models = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20251001'];

  const prompt = buildAnalysisPrompt(zoroData, amazonData);

  for (const model of models) {
    try {
      log(null, null, 'INFO', `AI: trying model ${model}`);
      const result = execSync(
        `claude -p "${prompt.replace(/"/g, '\\"')}" --model ${model} --max-turns 1`,
        { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 }
      );
      return { model, result: result.trim() };
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('rate') || msg.includes('limit') || msg.includes('overloaded')) {
        log(null, null, 'WARN', `AI: rate limited on ${model}, trying next...`);
        continue;
      }
      log(null, null, 'ERROR', `AI: error with ${model}: ${msg.substring(0, 200)}`);
      continue;
    }
  }

  return { model: 'none', result: 'AI analysis unavailable - all models rate limited' };
}

/**
 * Build the analysis prompt from parsed data.
 */
function buildAnalysisPrompt(zoroData, amazonData) {
  const amazonPrice = parsePrice(amazonData.price);
  const zoroPrice = zoroData.price;
  const zoroQty = parseInt(zoroData.qty) || 1;
  const amazonQty = parseInt(amazonData.maxQty) || parseInt(amazonData.availability) || 1;
  const effectiveCost = (zoroPrice && amazonQty && zoroQty) ? (zoroPrice * (amazonQty / zoroQty)) : null;
  const margin = (amazonPrice && effectiveCost) ? (((amazonPrice - effectiveCost) / amazonPrice) * 100).toFixed(1) : 'N/A';
  const referralFee = amazonPrice ? (amazonPrice * 0.15).toFixed(2) : 'N/A';

  return `Ты — аналитик товаров для продажи на Amazon. Проанализируй данные ниже и ответь СТРОГО в формате JSON. Отвечай на русском языке.

=== ДАННЫЕ ПОСТАВЩИКА (ZORO) ===
- Название: ${zoroData.title || 'N/A'}
- Бренд: ${zoroData.brand || 'N/A'}
- MFR номер: ${zoroData.mfrNo || 'N/A'}
- UPC: ${zoroData.upc || 'N/A'}
- Цена: $${zoroData.price || 'N/A'}
- Кол-во в упаковке: ${zoroQty}
- URL изображения: ${zoroData.imageUrl || 'N/A'}

=== ДАННЫЕ AMAZON ===
- ASIN: ${amazonData.asin}
- Название: ${amazonData.title || 'N/A'}
- Бренд: ${amazonData.brand || 'N/A'}
- Цена: ${amazonData.price || 'N/A'}
- Кол-во в упаковке: ${amazonQty}
- Продавец (BuyBox): ${amazonData.soldBy || amazonData.sellerLink || 'N/A'}
- Рейтинг: ${amazonData.rating || 'N/A'}
- Кол-во отзывов: ${amazonData.reviewCount || 'N/A'}
- BSR: ${amazonData.bsr || 'N/A'}
- Размеры: ${amazonData.dimensions || 'N/A'}
- Вес: ${amazonData.weight || 'N/A'}
- Бейджи: ${JSON.stringify(amazonData.badges || {})}
- Описание/буллеты: ${(amazonData.featureBullets || []).slice(0, 3).join('; ') || 'N/A'}
- Детали: ${JSON.stringify(amazonData.details || {}).substring(0, 500)}

=== ЧАСТЬ 4: СРАВНЕНИЕ ТОВАРОВ ===
Сравни UPC, бренд, MFR номер, цвет, размер, комплектацию между Zoro и Amazon.
Определи совпадения и несовпадения.

=== ЧАСТЬ 5: СРАВНЕНИЕ ФОТО ===
Если доступны URL изображений, сравни визуально товары. Совпадает ли внешний вид?

=== ЧАСТЬ 6: АНАЛИЗ ЦЕНЫ И МАРЖИ ===
- Цена Amazon: ${amazonData.price || 'N/A'}
- Себестоимость (Zoro): $${zoroPrice || 'N/A'}
- Эффективная стоимость (с учётом кол-ва): $${effectiveCost ? effectiveCost.toFixed(2) : 'N/A'}
- Комиссия Amazon (referral ~15%): $${referralFee}
- Примерная стоимость FBA/FBM: оцени по весу/размерам
- Маржа: ${margin}%

=== ЧАСТЬ 7: ИТОГОВЫЙ ВЕРДИКТ ===
Дай финальную рекомендацию: ЗАХОДИТЬ или НЕ ЗАХОДИТЬ, с подробным объяснением.

Ответь СТРОГО в формате JSON (без markdown, без \`\`\`):
{
  "photo_match": "Да/Нет/Частично",
  "comparison": "подробный текст о том что совпадает и что нет (UPC, бренд, MFR, цвет, размер, комплектация)",
  "recommendation": "ЗАХОДИТЬ/НЕ ЗАХОДИТЬ",
  "reason": "подробное объяснение причины рекомендации"
}`;
}

// ============================================================
// ITEM PROCESSING
// ============================================================

/**
 * Process a single item through the full pipeline:
 * Zoro scrape -> Seller Central search -> Amazon extract -> AI analysis -> save results.
 * @param {Object} item - queue item from DB
 */
async function processItem(item) {
  const itemId = item.id;
  const jobId = item.job_id;
  const sku = item.sku;

  log(jobId, itemId, 'INFO', `Start processing SKU: ${sku}`);
  db.updateItem(itemId, { status: 'parsing' });

  try {
    // ================================================================
    // STEP 1: ZORO SCRAPING
    // ================================================================
    log(jobId, itemId, 'INFO', 'Step 1: Scraping Zoro...');
    const zoroData = await scrapeZoro(sku);

    if (!zoroData) {
      log(jobId, itemId, 'WARN', 'SKU not found on Zoro');
      db.updateItem(itemId, {
        status: 'error',
        error_message: 'Product not found on Zoro',
      });
      return;
    }

    log(jobId, itemId, 'INFO', `Zoro: ${zoroData.brand || '?'} / ${zoroData.mfrNo || '?'} / $${zoroData.price || '?'}`);

    // Save Zoro data to DB
    db.updateItem(itemId, {
      zoro_brand: zoroData.brand || null,
      zoro_mfr_no: zoroData.mfrNo || null,
      zoro_upc: zoroData.upc || null,
      zoro_title: zoroData.title || null,
      zoro_price: zoroData.price || null,
      zoro_qty: zoroData.qty || null,
      zoro_url: zoroData.url || null,
    });

    // Download Zoro image
    if (zoroData.imageUrl) {
      try {
        const imgDir = path.resolve(__dirname, config.paths.images, String(jobId), sku);
        if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
        const imgPath = path.join(imgDir, 'zoro-main.jpg');
        await downloadImage(zoroData.imageUrl, imgPath);
        db.updateItem(itemId, { zoro_image_main: `${jobId}/${sku}/zoro-main.jpg` });
        log(jobId, itemId, 'INFO', 'Zoro image downloaded');
      } catch (e) {
        log(jobId, itemId, 'WARN', `Zoro image download failed: ${e.message}`);
      }
    }

    // ================================================================
    // STEP 2: SELLER CENTRAL SEARCH
    // ================================================================
    log(jobId, itemId, 'INFO', 'Step 2: Searching Seller Central...');

    if (!page) {
      await connectBrowser();
    }

    let searchResults;
    try {
      searchResults = await searchSellerCentral(page, zoroData);
    } catch (err) {
      // If browser connection lost, try reconnecting once
      if (err.message.includes('Target closed') || err.message.includes('Connection closed') ||
          err.message.includes('Session closed') || err.message.includes('Browser has been closed')) {
        log(jobId, itemId, 'WARN', 'Browser connection lost, reconnecting...');
        await connectBrowser();
        searchResults = await searchSellerCentral(page, zoroData);
      } else {
        throw err;
      }
    }

    log(jobId, itemId, 'INFO', `Seller Central: found ${searchResults.length} results`);

    if (!searchResults || searchResults.length === 0) {
      log(jobId, itemId, 'WARN', 'Not found on Amazon Seller Central');
      db.updateItem(itemId, {
        status: 'done',
        competitor_amazon: 'Не найден',
        recommendation: 'ЗАХОДИТЬ',
        ai_recommendation_reason: 'Товар не найден на Amazon - нет конкурентов',
      });
      return;
    }

    // ================================================================
    // STEP 3: AMAZON PRODUCT EXTRACTION
    // ================================================================
    // Sort by sales rank (lower = more popular), pick the best match
    const sortedResults = searchResults
      .filter(r => r.asin)
      .sort((a, b) => {
        if (a.salesRank && b.salesRank) return a.salesRank - b.salesRank;
        if (a.salesRank) return -1;
        if (b.salesRank) return 1;
        return 0;
      });

    if (sortedResults.length === 0) {
      log(jobId, itemId, 'WARN', 'No valid ASINs in search results');
      db.updateItem(itemId, {
        status: 'done',
        competitor_amazon: 'Не найден',
        recommendation: 'ЗАХОДИТЬ',
        ai_recommendation_reason: 'ASIN не удалось получить из результатов',
      });
      return;
    }

    const bestResult = sortedResults[0];
    log(jobId, itemId, 'INFO', `Step 3: Extracting ASIN ${bestResult.asin}...`);

    // Small delay before navigating to Amazon product page
    await page.waitForTimeout(3000);

    let amazonData;
    try {
      amazonData = await extractAmazonProduct(page, bestResult.asin);
    } catch (err) {
      // Retry on browser connection issues
      if (err.message.includes('Target closed') || err.message.includes('Connection closed') ||
          err.message.includes('Session closed')) {
        log(jobId, itemId, 'WARN', 'Browser connection lost during extract, reconnecting...');
        await connectBrowser();
        amazonData = await extractAmazonProduct(page, bestResult.asin);
      } else {
        throw err;
      }
    }

    if (!amazonData) {
      log(jobId, itemId, 'ERROR', `Failed to extract Amazon data for ASIN ${bestResult.asin}`);
      db.updateItem(itemId, {
        asin: bestResult.asin,
        status: 'error',
        error_message: `Failed to extract Amazon data for ${bestResult.asin}`,
      });
      return;
    }

    // Parse prices
    const amazonPrice = parsePrice(amazonData.price);
    const zoroPrice = zoroData.price;

    // Parse quantities as numbers
    const zoroQty = parseInt(zoroData.qty) || 1;
    const amazonQty = parseInt(amazonData.maxQty) || parseInt(amazonData.availability) || 1;

    // Calculate margin accounting for qty difference:
    // If Amazon sells pack of 6 and Zoro sells individually,
    // we need to buy 6 from Zoro to fulfill 1 Amazon order
    let marginPercent = null;
    let effectiveCost = null;
    if (amazonPrice && zoroPrice && amazonPrice > 0) {
      effectiveCost = zoroPrice * (amazonQty / zoroQty);
      marginPercent = Math.round(((amazonPrice - effectiveCost) / amazonPrice) * 100 * 10) / 10;
    }

    // Determine seller-is-brand: check if buybox seller name contains the brand name (case insensitive)
    const seller = amazonData.soldBy || amazonData.sellerLink || '';
    const brand = zoroData.brand || amazonData.brand || '';
    const isSellerBrand = sellerIsBrand(seller, brand);

    // competitor_amazon: use the value from amazon-extract.js directly
    // amazonData now returns competitor_amazon as "Да"/"Нет"/"Нет конкурента"
    // Determine if Amazon itself is selling (for hard rule)
    const sellerLower = seller.toLowerCase();
    const isAmazonSeller = sellerLower.includes('amazon.com') || sellerLower === 'amazon';
    // Use "Да" if Amazon sells, "Нет" if there's a 3P seller, "Нет конкурента" if no seller
    let competitorAmazon = 'Нет';
    if (isAmazonSeller) {
      competitorAmazon = 'Да';
    } else if (!seller || seller.trim() === '') {
      competitorAmazon = 'Нет конкурента';
    }

    // Oversized check
    const dims = amazonData.dimensions || amazonData.details?.['Product Dimensions'] ||
                 amazonData.details?.['Item Dimensions LxWxH'] || '';
    let oversizedStatus = 'Нет';
    const dimMatch = dims.match(/([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)/);
    if (dimMatch) {
      const volume = parseFloat(dimMatch[1]) * parseFloat(dimMatch[2]) * parseFloat(dimMatch[3]);
      if (volume > 550) oversizedStatus = 'Да';
      else if (volume > 450) oversizedStatus = 'Пограничный';
    }

    // Minority-owned badge
    const minorityOwned = amazonData.badges?.minorityOwned ? 'Да' : 'Нет';

    // Save all Amazon data to DB
    db.updateItem(itemId, {
      asin: bestResult.asin,
      amazon_title: amazonData.title || null,
      amazon_price: amazonPrice,
      amazon_seller: seller || null,
      amazon_qty: amazonQty,
      amazon_rating: parseFloat(amazonData.rating) || null,
      amazon_review_count: parseInt((amazonData.reviewCount || '').replace(/[^0-9]/g, '')) || null,
      amazon_bsr: amazonData.bsr || null,
      amazon_weight: amazonData.weight || amazonData.details?.['Item Weight'] || null,
      amazon_dimensions: dims || null,
      amazon_url: amazonData.url || null,
      competitor_amazon: competitorAmazon,
      seller_is_brand: isSellerBrand ? 'Да' : 'Нет',
      is_oversized: oversizedStatus,
      is_minority_owned: minorityOwned,
      margin_percent: marginPercent,
    });

    log(jobId, itemId, 'INFO',
      `Amazon: $${amazonPrice || '?'} | Margin: ${marginPercent || '?'}% | Effective cost: $${effectiveCost || '?'} | Seller: ${seller || '?'} | Oversized: ${oversizedStatus}`);

    // Download Amazon main image
    if (amazonData.images?.[0]) {
      try {
        const imgDir = path.resolve(__dirname, config.paths.images, String(jobId), sku);
        if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
        const imgPath = path.join(imgDir, 'amz-main.jpg');
        await downloadImage(amazonData.images[0], imgPath);
        db.updateItem(itemId, { amazon_image_main: `${jobId}/${sku}/amz-main.jpg` });
        log(jobId, itemId, 'INFO', 'Amazon image downloaded');
      } catch (e) {
        log(jobId, itemId, 'WARN', `Amazon image download failed: ${e.message}`);
      }
    }

    // ================================================================
    // STEP 4: AI ANALYSIS + RULE-BASED DECISION
    // ================================================================
    log(jobId, itemId, 'INFO', 'Step 4: Running analysis...');

    let recommendation = 'РУЧНАЯ ПРОВЕРКА';
    let aiResult = { model: 'rules', result: '' };

    // Hard rules first (these override AI)
    if (competitorAmazon === 'Да') {
      // Amazon sells this product itself -> hard НЕ ЗАХОДИТЬ
      recommendation = 'НЕ ЗАХОДИТЬ';
      aiResult.result = 'Amazon продает этот товар сам (competitor_amazon = Да)';
    } else if (zoroQty > amazonQty) {
      // Supplier qty is bigger than Amazon qty -> НЕ ЗАХОДИТЬ
      recommendation = 'НЕ ЗАХОДИТЬ';
      aiResult.result = `Кол-во у поставщика больше чем на Amazon (Zoro: ${zoroQty}, Amazon: ${amazonQty})`;
    } else if (marginPercent !== null && marginPercent < 20) {
      recommendation = 'НЕ ЗАХОДИТЬ';
      aiResult.result = `Маржа слишком низкая: ${marginPercent}% (эффективная стоимость: $${effectiveCost?.toFixed(2)})`;
    } else if (oversizedStatus === 'Да') {
      recommendation = 'НЕ ЗАХОДИТЬ';
      aiResult.result = 'Габаритный товар (объем > 550 куб. дюймов)';
    } else if (parseFloat(amazonData.rating) > 0 && parseFloat(amazonData.rating) < 3.5) {
      recommendation = 'НЕ ЗАХОДИТЬ';
      aiResult.result = `Низкий рейтинг: ${amazonData.rating}`;
    } else if (isSellerBrand) {
      recommendation = 'НЕ ЗАХОДИТЬ';
      aiResult.result = 'Продавец является брендом - риск IP жалоб';
    } else {
      // All hard rules passed -> try AI analysis for a more nuanced verdict
      try {
        aiResult = runAIAnalysis(zoroData, amazonData);
        // Parse JSON response from AI
        let aiJson = null;
        try {
          // Try to extract JSON from the response (may have surrounding text)
          const jsonMatch = aiResult.result.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            aiJson = JSON.parse(jsonMatch[0]);
          }
        } catch (parseErr) {
          log(jobId, itemId, 'WARN', `AI JSON parse failed: ${parseErr.message}`);
        }

        if (aiJson && aiJson.recommendation) {
          if (aiJson.recommendation.includes('НЕ ЗАХОДИТЬ')) {
            recommendation = 'НЕ ЗАХОДИТЬ';
          } else if (aiJson.recommendation.includes('ЗАХОДИТЬ')) {
            recommendation = 'ЗАХОДИТЬ';
          }
          // Store structured fields
          aiResult.photoMatch = aiJson.photo_match || null;
          aiResult.comparison = aiJson.comparison || null;
          aiResult.reason = aiJson.reason || null;
          aiResult.result = aiJson.reason || aiResult.result;
        } else {
          // Fallback: try to parse old format or keywords
          if (aiResult.result.includes('НЕ ЗАХОДИТЬ')) {
            recommendation = 'НЕ ЗАХОДИТЬ';
          } else if (aiResult.result.includes('ЗАХОДИТЬ')) {
            recommendation = 'ЗАХОДИТЬ';
          } else {
            recommendation = 'ЗАХОДИТЬ'; // Default if all rules passed
          }
        }
      } catch (e) {
        log(jobId, itemId, 'WARN', `AI analysis failed: ${e.message}`);
        recommendation = 'ЗАХОДИТЬ'; // Default if AI unavailable but rules passed
        aiResult = { model: 'fallback-rules', result: 'AI недоступен, базовые правила пройдены -> ЗАХОДИТЬ' };
      }
    }

    // Save final results
    db.updateItem(itemId, {
      status: 'done',
      recommendation,
      ai_model: aiResult.model || null,
      ai_photo_match: aiResult.photoMatch || null,
      ai_analysis: (aiResult.comparison || aiResult.result || '').substring(0, 2000),
      ai_recommendation_reason: (aiResult.reason || aiResult.result || '').substring(0, 500),
      updated_at: new Date().toISOString(),
    });

    log(jobId, itemId, 'INFO', `DONE: ${recommendation} (model: ${aiResult.model})`);

  } catch (err) {
    log(jobId, itemId, 'ERROR', `Error: ${err.message}`);

    const retries = (item.retries || 0) + 1;
    if (retries < 3) {
      db.updateItem(itemId, {
        status: 'pending',
        retries,
        error_message: err.message,
      });
      log(jobId, itemId, 'INFO', `Will retry (attempt ${retries}/3)`);
    } else {
      db.updateItem(itemId, {
        status: 'error',
        retries,
        error_message: err.message,
      });
      log(jobId, itemId, 'ERROR', `Max retries reached (${retries}/3), marking as error`);
    }
  }
}

// ============================================================
// MAIN WORKER LOOP
// ============================================================

/**
 * Main worker loop.
 * Continuously checks for running jobs, picks the next pending item, and processes it.
 * Respects job speed settings for pacing.
 */
async function mainLoop() {
  log(null, null, 'INFO', 'Worker starting...');
  await db.init();
  log(null, null, 'INFO', 'Database initialized');
  isRunning = true;

  // Connect to browser on startup
  try {
    await connectBrowser();
  } catch (err) {
    log(null, null, 'ERROR', `Initial browser connection failed: ${err.message}`);
    log(null, null, 'INFO', 'Will retry connection when a job starts...');
  }

  while (isRunning) {
    try {
      // Find running jobs
      const jobs = db.getJobs().filter(j => j.status === 'running');

      if (jobs.length === 0) {
        // No active jobs -- wait and poll again
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      // Process each running job
      for (const job of jobs) {
        // Re-check job status (might have been paused/stopped via UI)
        const currentJob = db.getJob(job.id);
        if (!currentJob || currentJob.status !== 'running') continue;

        // Get next pending item for this job
        const item = db.getNextPending(job.id);

        if (!item) {
          // All items processed -- mark job as done
          log(job.id, null, 'INFO', `Job ${job.id} complete - all items processed`);
          db.updateJobStatus(job.id, 'done');
          continue;
        }

        // Ensure browser is connected
        if (!page) {
          try {
            await connectBrowser();
          } catch (err) {
            log(job.id, null, 'ERROR', `Browser connection failed: ${err.message}`);
            await new Promise(r => setTimeout(r, 10000));
            continue;
          }
        }

        // Process the item
        await processItem(item);

        // Re-check job status after processing (might have been stopped)
        const updatedJob = db.getJob(job.id);
        if (!updatedJob || updatedJob.status !== 'running') {
          log(job.id, null, 'INFO', `Job ${job.id} is no longer running (status: ${updatedJob?.status})`);
          break;
        }

        // Delay between items based on speed setting
        const delay = getDelay(updatedJob.speed || config.defaultSpeed);
        log(job.id, null, 'INFO', `Waiting ${Math.round(delay / 1000)}s before next item...`);
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (err) {
      log(null, null, 'ERROR', `Main loop error: ${err.message}`);
      // Brief pause before continuing
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown() {
  log(null, null, 'INFO', 'Worker shutting down...');
  isRunning = false;

  if (browser) {
    try { await browser.close(); } catch (e) {}
    browser = null;
    page = null;
  }

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ============================================================
// START
// ============================================================

mainLoop().catch(err => {
  log(null, null, 'ERROR', `Worker crashed: ${err.message}`);
  console.error(err);
  process.exit(1);
});
