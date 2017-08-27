const fs = require('fs');
const http = require('http');
const { URL } = require('url');

const puppeteer = require('puppeteer');
const sharp = require('sharp');
const pTimeout = require('p-timeout');
const LRU = require('lru-cache');
const cache = LRU({
  max: process.env.CACHE_SIZE || Infinity,
  maxAge: 1000 * 60, // 1 minute
  dispose: (url, page) => {
    console.log('🗑 Disposing ' + url);
    if (page) page.close();
  }
});
setInterval(() => cache.prune(), 1000 * 60); // Prune every minute

const blocked = require('./blocked.json');
const blockedRegExp = new RegExp('(' + blocked.join('|') + ')', 'i');

const truncate = (str, len) => str.length > len ? str.slice(0, len) + '…' : str;

let browser;

require('http').createServer(async (req, res) => {
  if (req.url == '/'){
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public,max-age=31536000',
    });
    res.end(fs.readFileSync('index.html'));
    return;
  }

  if (req.url == '/favicon.ico'){
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url == '/status'){
    res.writeHead(200, {
      'content-type': 'application/json',
    });
    res.end(JSON.stringify({
      pages: cache.keys(),
      process: {
        versions: process.versions,
        memoryUsage: process.memoryUsage(),
      },
    }, null, '\t'));
    return;
  }

  const [_, action, url] = req.url.match(/^\/(screenshot|render|pdf)?\/?(.*)/i) || ['', '', ''];

  if (!url){
    res.writeHead(400, {
      'content-type': 'text/plain',
    });
    res.end('Something is wrong. Missing URL.');
    return;
  }

  if (cache.itemCount > 20){
    res.writeHead(420, {
      'content-type': 'text/plain',
    });
    res.end(`There are ${cache.itemCount} pages in the current instance now. Please try again in few minutes.`);
    return;
  }

  let page;
  try {
    const u = new URL(url);
    const pageURL = u.origin + decodeURIComponent(u.pathname);
    const { searchParams } = u;
    
    page = cache.get(pageURL);
    if (!page) {
      if (!browser) {
        console.log('🚀 Launch browser!');
        browser = await puppeteer.launch(process.env.DEBUG ? {
          headless: false,
          ignoreHTTPSErrors: true,
          args: ['--no-sandbox', '--auto-open-devtools-for-tabs'],
        } : {
          ignoreHTTPSErrors: true,
          args: ['--no-sandbox'],
        });
      }
      page = await browser.newPage();

      const nowTime = +new Date();
      let reqCount = 0;
      await page.setRequestInterceptionEnabled(true);
      page.on('request', (request) => {
        const { url } = request;

        // Skip data URIs
        if (/^data:/i.test(url)){
          request.continue();
          return;
        }

        const seconds = (+new Date() - nowTime) / 1000;
        const shortURL = truncate(url, 70);
        // Abort requests that exceeds 15 seconds
        // Also abort if more than 100 requests
        if (seconds > 15 || reqCount > 100){
          console.log('❌⏳ ' + shortURL);
          request.abort();
        } else if (blockedRegExp.test(url)){
          console.log('❌ ' + shortURL);
          request.abort();
        } else {
          console.log('✅ ' + shortURL);
          request.continue();
          reqCount++;
        }
      });

      console.log('⬇️ Fetching ' + pageURL);
      await page.goto(pageURL, {
        waitUntil: 'networkidle',
      });
    }

    console.log('💥 Perform action: ' + action);

    switch (action){
      case 'render': {
        await pTimeout(page.evaluate(() => {
          // Remove scripts except JSON-LD
          const scripts = document.querySelectorAll('script:not([type="application/ld+json"])');
          scripts.forEach(s => s.parentNode.removeChild(s));

          // Remove import tags
          const imports = document.querySelectorAll('link[rel=import]');
          imports.forEach(i => i.parentNode.removeChild(i));

          // Inject <base> for loading relative resources
          const base = document.createElement('base');
          base.setAttribute('href', location.origin + location.pathname);
          document.head.appendChild(base);
        }), 10 * 1000);

        let content = await page.content();

        // Remove comments
        content = content.replace(/<!--[\s\S]*?-->/g, '');

        res.writeHead(200, {
          'content-type': 'text/html; charset=UTF-8',
          'cache-control': 'public,max-age=31536000',
        });
        res.end(content);
        break;
      }
      case 'pdf': {
        const format = searchParams.get('format') || null;
        const pageRanges = searchParams.get('pageRanges') || null;

        const pdf = await pTimeout(page.pdf({
          format,
          pageRanges,
        }), 10 * 1000);
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'cache-control': 'public,max-age=31536000',
        });
        res.end(pdf, 'binary');
        break;
      }
      default: {
        const width = parseInt(searchParams.get('width'), 10) || 1024;
        const height = parseInt(searchParams.get('height'), 10) || 768;
        const thumbWidth = parseInt(searchParams.get('thumbWidth'), 10) || null;
        const fullPage = searchParams.get('fullPage') == 'true' || false;
        
        await page.setViewport({
          width,
          height,
        });
        const screenshot = await pTimeout(page.screenshot({
          type: 'jpeg',
          fullPage,
        }), 10 * 1000);
    
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'cache-control': 'public,max-age=31536000',
        });

        if (thumbWidth && thumbWidth < width){
          const image = sharp(screenshot).resize(thumbWidth).jpeg({
            quality: 90,
            progressive: true,
          });
          image.pipe(res);
        } else {
          res.end(screenshot, 'binary');
        }
      }
    }

    cache.set(pageURL, page);
  } catch (e) {
    page.close();
    console.error(e);
    const { message = '' } = e;
    res.writeHead(400, {
      'content-type': 'text/plain',
    });
    res.end('Oops. Something is wrong.\n\n' + message);

    // Handle websocket not opened error
    if (/not opened/i.test(message) && browser){
      browser.close();
      browser = null;
    }
  }
}).listen(process.env.PORT || 3000);

process.on('SIGINT', () => {
  if (browser) browser.close();
  process.exit();
});