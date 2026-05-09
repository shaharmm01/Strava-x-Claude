'use strict';
const axios = require('axios');
const cheerio = require('cheerio');

const USERNAME = 'zivshahar01';
const DATE = '2026-05-08';

async function debug() {
  const url = `https://www.myfitnesspal.com/reports/printable_diary/${USERNAME}?from=${DATE}&to=${DATE}`;
  console.log('Fetching:', url);

  let html;
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 10000,
      maxRedirects: 5,
    });
    console.log('\nHTTP status:', res.status);
    console.log('Final URL:', res.request?.res?.responseUrl ?? '(no redirect)');
    html = res.data;
  } catch (err) {
    console.error('Request failed:', err.message);
    if (err.response) {
      console.log('HTTP status:', err.response.status);
      console.log('Response body (first 2000 chars):\n', String(err.response.data).slice(0, 2000));
    }
    return;
  }

  console.log('\n--- First 3000 chars of HTML ---');
  console.log(String(html).slice(0, 3000));

  const $ = cheerio.load(html);

  console.log('\n--- Page title ---');
  console.log($('title').text());

  console.log('\n--- All table rows with class "total" or "bottom" ---');
  $('tr.total, tr.bottom').each((i, el) => {
    console.log(`  [${i}] classes="${$(el).attr('class')}" text="${$(el).text().replace(/\s+/g, ' ').trim().slice(0, 120)}"`);
  });

  console.log('\n--- thead th headers ---');
  $('thead tr th').each((i, el) => {
    console.log(`  [${i}] "${$(el).text().trim()}"`);
  });

  console.log('\n--- All tr containing "Total" ---');
  $('tr').filter((_, el) => $(el).text().includes('Total')).each((i, el) => {
    console.log(`  [${i}] classes="${$(el).attr('class')}" text="${$(el).text().replace(/\s+/g, ' ').trim().slice(0, 150)}"`);
  });

  console.log('\n--- All tables found ---');
  $('table').each((i, el) => {
    console.log(`  table[${i}] class="${$(el).attr('class')}" rows=${$(el).find('tr').length}`);
  });
}

debug().catch(console.error);
