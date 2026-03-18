/**
 * Captcha and session detection utilities for Amazon parsing.
 */

/**
 * Check if the current page is showing a CAPTCHA challenge.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function checkCaptcha(page) {
  try {
    const url = page.url();

    // URL-based detection
    if (url.includes('captcha') || url.includes('challenge') || url.includes('validateCaptcha')) {
      return true;
    }

    // Content-based detection
    const hasCaptcha = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const captchaKeywords = [
        'Type the characters',
        'Enter the characters',
        'solve this puzzle',
        'verify you are a human',
        'robot check',
        'Sorry, we just need to make sure you\'re not a robot',
        'To discuss automated access',
        'automated access to',
        'captcha',
      ];
      for (const keyword of captchaKeywords) {
        if (text.toLowerCase().includes(keyword.toLowerCase())) {
          return true;
        }
      }

      // Check for captcha image
      const captchaImg = document.querySelector('img[src*="captcha"]') ||
                         document.querySelector('#captchacharacters') ||
                         document.querySelector('form[action*="captcha"]') ||
                         document.querySelector('input[name="captchacharacters"]');
      if (captchaImg) return true;

      return false;
    });

    return hasCaptcha;
  } catch (err) {
    // If page is in an unusual state, assume captcha
    console.error('checkCaptcha error:', err.message);
    return false;
  }
}

/**
 * Check if the current page is a sign-in / session expired redirect.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function checkSession(page) {
  try {
    const url = page.url();

    // URL-based detection
    if (
      url.includes('/ap/signin') ||
      url.includes('/ap/') ||
      url.includes('signin.aws') ||
      url.includes('sellercentral.amazon.com/signin') ||
      url.includes('www.amazon.com/ap/signin') ||
      url.includes('/gp/sign-in')
    ) {
      return true;
    }

    // Content-based detection
    const isSignIn = await page.evaluate(() => {
      const title = document.title || '';
      if (
        title.includes('Sign In') ||
        title.includes('Sign-In') ||
        title.includes('Amazon Sign In') ||
        title.includes('Login')
      ) {
        return true;
      }

      // Check for sign-in form elements
      const signInForm = document.querySelector('#ap_email') ||
                         document.querySelector('#ap_password') ||
                         document.querySelector('input[name="email"][type="email"]') ||
                         document.querySelector('form[name="signIn"]');
      if (signInForm) return true;

      return false;
    });

    return isSignIn;
  } catch (err) {
    console.error('checkSession error:', err.message);
    return false;
  }
}

/**
 * Wait for captcha to be solved manually (poll every 5 seconds).
 * @param {import('playwright').Page} page
 * @param {number} timeoutMs - max wait time (default 5 minutes)
 * @returns {Promise<boolean>} true if captcha was resolved, false if timeout
 */
async function waitForCaptchaResolution(page, timeoutMs = 300000) {
  const start = Date.now();
  console.log('[CAPTCHA] Captcha detected. Waiting for manual resolution...');

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 5000));

    const stillCaptcha = await checkCaptcha(page);
    if (!stillCaptcha) {
      console.log('[CAPTCHA] Captcha resolved.');
      return true;
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[CAPTCHA] Still waiting... (${elapsed}s elapsed)`);
  }

  console.log('[CAPTCHA] Timeout waiting for captcha resolution.');
  return false;
}

/**
 * Wait for session/sign-in to be resolved manually.
 * @param {import('playwright').Page} page
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForSessionResolution(page, timeoutMs = 300000) {
  const start = Date.now();
  console.log('[SESSION] Sign-in page detected. Waiting for manual login...');

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 5000));

    const stillSignIn = await checkSession(page);
    if (!stillSignIn) {
      console.log('[SESSION] Login completed.');
      return true;
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[SESSION] Still waiting for login... (${elapsed}s elapsed)`);
  }

  console.log('[SESSION] Timeout waiting for login.');
  return false;
}

module.exports = {
  checkCaptcha,
  checkSession,
  waitForCaptchaResolution,
  waitForSessionResolution,
};
