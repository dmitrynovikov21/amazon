const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

/**
 * Download an image from URL and save to filepath.
 * Follows redirects (301, 302, 303, 307, 308).
 * @param {string} url
 * @param {string} filepath
 * @param {number} maxRedirects
 * @returns {Promise<void>}
 */
function downloadImage(url, filepath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      return reject(new Error('Too many redirects while downloading image'));
    }

    // Ensure parent directory exists
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const proto = url.startsWith('https') ? https : http;

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Encoding': 'identity',
      },
      timeout: 30000,
    };

    const req = proto.get(url, options, (response) => {
      const statusCode = response.statusCode;

      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
        let redirectUrl = response.headers.location;
        // Handle relative redirects
        if (redirectUrl.startsWith('/')) {
          const parsed = new URL(url);
          redirectUrl = `${parsed.protocol}//${parsed.host}${redirectUrl}`;
        }
        response.resume(); // consume response to free memory
        return downloadImage(redirectUrl, filepath, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
      }

      if (statusCode !== 200) {
        response.resume();
        return reject(new Error(`Failed to download image: HTTP ${statusCode} from ${url}`));
      }

      const file = fs.createWriteStream(filepath);

      response.pipe(file);

      file.on('finish', () => {
        file.close(() => {
          // Verify file is not empty
          const stats = fs.statSync(filepath);
          if (stats.size === 0) {
            fs.unlinkSync(filepath);
            return reject(new Error('Downloaded image is empty'));
          }
          resolve();
        });
      });

      file.on('error', (err) => {
        // Clean up partial file
        fs.unlink(filepath, () => {}); // ignore unlink error
        reject(err);
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Image download timed out'));
    });
  });
}

module.exports = { downloadImage };
