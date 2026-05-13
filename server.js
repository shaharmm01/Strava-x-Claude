'use strict';

require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const garmin = require('./garmin');

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.get('/health', (_req, res) => res.status(200).send('OK'));

// Manual briefing trigger: GET /briefing/:secret
app.get('/briefing/:secret', async (req, res) => {
  if (req.params.secret !== process.env.COMPOSIO_WEBHOOK_SECRET) return res.status(401).send('Unauthorized');
  res.status(200).send('Briefing triggered');
  try {
    const recovery = await getActiveRecoverySession();
    if (recovery?.status === 'active') await sendMorningPainCheck();
    const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'Asia/Jerusalem' });
    try {
      const imageBuffer = await generateBriefingImage();
      await sendTelegramPhoto(process.env.TELEGRAM_OWNER_CHAT_ID, imageBuffer, `🌅 Your briefing for ${today} · tap for details`);
      console.log('[briefing] Manual image sent');
    } catch (imgErr) {
      console.error('[briefing] Image failed, falling back to text:', imgErr.message, imgErr.stack);
      const message = await generateMorningBriefing();
      await sendTelegram(process.env.TELEGRAM_OWNER_CHAT_ID, message);
    }
  } catch (err) {
    console.error('[briefing] Manual trigger error:', err.message);
  }
});

// Manual weekly report trigger: GET /weekly/:secret
app.get('/weekly/:secret', async (req, res) => {
  if (req.params.secret !== process.env.COMPOSIO_WEBHOOK_SECRET) return res.status(401).send('Unauthorized');
  res.status(200).send('Weekly report triggered');
  try {
    const message = await generateWeeklyReport();
    await sendTelegram(process.env.TELEGRAM_OWNER_CHAT_ID, message);
    console.log('[weekly] Manual trigger sent');
  } catch (err) {
    console.error('[weekly] Manual trigger error:', err.message);
  }
});

// Manual Garmin sync trigger: GET /sync_garmin/:secret
app.get('/sync_garmin/:secret', async (req, res) => {
  if (req.params.secret !== process.env.COMPOSIO_WEBHOOK_SECRET) return res.status(401).send('Unauthorized');
  res.status(200).send('Garmin sync started');
  try {
    await sendTelegram(process.env.TELEGRAM_OWNER_CHAT_ID, '⌚ Garmin sync started — pulling 30 days of data...');
    const count = await garmin.syncGarminHistory(30);
    await sendTelegram(process.env.TELEGRAM_OWNER_CHAT_ID, `✅ Garmin sync complete — ${count} days synced`);
  } catch (err) {
    console.error('[sync_garmin] Error:', err.message);
    await sendTelegram(process.env.TELEGRAM_OWNER_CHAT_ID, `❌ Garmin sync failed: ${err.message}`).catch(() => {});
  }
});

// Strava OAuth — start the auth flow
app.get('/auth/strava', (_req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    response_type: 'code',
    redirect_uri: `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/auth/strava/callback`,
    approval_prompt: 'force',
    scope: 'activity:read_all,profile:read_all',
  });
  res.redirect(`https://www.strava.com/oauth/authorize?${params}`);
});

// Strava OAuth callback — exchanges code for tokens and stores in Supabase
app.get('/auth/strava/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.status(400).send(`Strava auth error: ${error ?? 'no code'}`);

  const tokenRes = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) return res.status(500).send('Token exchange failed');
  const tokens = await tokenRes.json();

  const { error: dbErr } = await supabase.from('strava_token').upsert({
    id: 1,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
  });
  if (dbErr) return res.status(500).send('Failed to save tokens');

  console.log('[auth] Strava tokens saved to Supabase');
  res.send('Strava connected! You can close this tab.');
});


// Strava webhook verification — Strava GETs this URL with hub.challenge before activating
app.get('/webhook/strava/:secret', (req, res) => {
  if (req.params.secret !== process.env.COMPOSIO_WEBHOOK_SECRET) {
    return res.status(401).send('Unauthorized');
  }
  const challenge = req.query['hub.challenge'];
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  if (mode === 'subscribe' && challenge) {
    console.log('[strava] Hub verification challenge received');
    return res.json({ 'hub.challenge': challenge });
  }
  res.status(200).send('OK');
});

// Strava webhook — shared secret in URL path; accepts both direct Strava events
// and Composio-enriched payloads (which include full activity data inline).
app.post('/webhook/strava/:secret', (req, res) => {
  if (req.params.secret !== process.env.COMPOSIO_WEBHOOK_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  res.status(200).send('OK');

  const payload = req.body;
  console.log('[strava] Webhook received');

  // Direct Strava webhook: { object_type, object_id, aspect_type, owner_id, ... }
  // Composio-enriched: { data: { payload: {...} } } or { payload: {...} }
  const isStravaEvent =
    payload?.object_type === 'activity' && payload?.object_id;

  if (isStravaEvent) {
    if (payload.aspect_type !== 'create') {
      console.log('[strava] Ignoring non-create event:', payload.aspect_type);
      return;
    }
    // Strava only sends the activity ID; fetch the full activity via Strava API
    fetchAndUpsertActivity(payload.object_id).catch((err) =>
      console.error('[strava] Fetch error:', err.message)
    );
    return;
  }

  // Composio-enriched payload includes the full activity object
  const activity =
    payload?.data?.payload ??
    payload?.payload ??
    payload?.data ??
    payload;

  if (!activity?.id) {
    console.log('[strava] No activity id in payload, skipping');
    return;
  }

  upsertActivity(activity).catch((err) =>
    console.error('[strava] Upsert error:', err.message)
  );
});

// Returns a valid Strava access token from Supabase, refreshing if expired.
async function getStravaAccessToken() {
  const { data, error } = await supabase.from('strava_token').select('*').eq('id', 1).single();
  if (error || !data) throw new Error('No Strava token in DB — visit /auth/strava to connect');

  // Use stored token if still valid (5-minute buffer)
  if (Date.now() / 1000 < data.expires_at - 300) return data.access_token;

  const refreshRes = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: data.refresh_token,
    }),
  });
  if (!refreshRes.ok) throw new Error(`Strava token refresh HTTP ${refreshRes.status}`);
  const tokens = await refreshRes.json();

  await supabase.from('strava_token').upsert({
    id: 1,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
  });

  return tokens.access_token;
}

// Fetches the current Strava access token from the Composio connection,
// then retrieves the full activity from the Strava API.
async function fetchAndUpsertActivity(activityId) {
  const accessToken = await getStravaAccessToken();

  const actRes = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!actRes.ok) throw new Error(`Strava API HTTP ${actRes.status}`);
  const activity = await actRes.json();

  await upsertActivity(activity);
}

async function upsertActivity(activity) {
  const { error } = await supabase.from('activities').upsert(
    {
      strava_id: activity.id,
      type: activity.type ?? null,
      distance_m: activity.distance ?? null,
      moving_time_s: activity.moving_time ?? null,
      started_at: activity.start_date ?? null,
      raw: activity,
    },
    { onConflict: 'strava_id' }
  );
  if (error) console.error('[strava] Upsert error:', error.message);
  else console.log('[strava] Upserted activity', activity.id);
}

// Backfill — fetches up to 200 recent Strava activities and upserts them into Supabase.
// Protected by the same webhook secret: GET /backfill/:secret
app.get('/backfill/:secret', async (req, res) => {
  if (req.params.secret !== process.env.COMPOSIO_WEBHOOK_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  try {
    const accessToken = await getStravaAccessToken();

    let all = [];
    for (let page = 1; page <= 4; page++) {
      const r = await fetch(
        `https://www.strava.com/api/v3/athlete/activities?per_page=50&page=${page}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!r.ok) throw new Error(`Strava activities HTTP ${r.status}`);
      const batch = await r.json();
      if (!batch.length) break;
      all = all.concat(batch);
    }

    await Promise.all(all.map(upsertActivity));
    console.log(`[backfill] Upserted ${all.length} activities`);
    res.json({ upserted: all.length });
  } catch (err) {
    console.error('[backfill] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Manual overtraining check trigger
app.get('/overtraining/:secret', async (req, res) => {
  if (req.params.secret !== process.env.COMPOSIO_WEBHOOK_SECRET) return res.status(401).send('Unauthorized');
  res.status(200).send('Overtraining check triggered');
  try {
    const message = await checkOvertraining();
    await sendTelegram(process.env.TELEGRAM_OWNER_CHAT_ID, message);
  } catch (err) {
    console.error('[overtraining] Manual trigger error:', err.message);
  }
});

// MFP diagnostic: GET /mfp_check/:secret?date=YYYY-MM-DD
// Renders the diary page with Puppeteer and reports what was found
app.get('/mfp_check/:secret', async (req, res) => {
  if (req.params.secret !== process.env.COMPOSIO_WEBHOOK_SECRET) return res.status(401).send('Unauthorized');

  const date = req.query.date ?? new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const username = process.env.MFP_USERNAME;
  const url = `https://www.myfitnesspal.com/reports/printable-diary/${username}?from=${date}&to=${date}`;
  const report = { url, date, error: null };

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('table', { timeout: 15000 }).catch(() => {});
    const html = await page.content();
    const $ = cheerio.load(html);

    report.tableCount = $('table').length;
    report.theadTh = $('thead tr th').map((_, el) => $(el).text().trim()).get();
    const totalsRow = $('tr').filter((_, el) => /^totals$/i.test($(el).find('th, td').first().text().trim())).first();
    report.totalsRowFound = totalsRow.length > 0;
    const cols = totalsRow.find('th, td').map((_, el) => $(el).text().trim().replace(/,/g, '')).get();
    const headers = $('thead tr th').map((_, el) => $(el).text().trim().toLowerCase()).get();
    const getValue = (name) => { const idx = headers.findIndex(h => h.includes(name)); return idx >= 0 && cols[idx] ? parseInt(cols[idx]) || null : null; };
    report.parsed = {
      calories: getValue('calorie') ?? getValue('cal') ?? (cols[1] ? parseInt(cols[1]) : null),
      protein_g: getValue('protein'), carbs_g: getValue('carb'), fat_g: getValue('fat'),
      sodium_mg: getValue('sodium'), sugar_g: getValue('sugar'), fiber_g: getValue('fiber'),
    };
  } catch (err) {
    report.error = err.message;
  } finally {
    await browser.close();
  }

  res.json(report);
});

// Hevy CSV import: POST /import/hevy/:secret
// Body: raw CSV text — curl -X POST "URL/import/hevy/SECRET" -H "Content-Type: text/plain" --data-binary @workout_data.csv
app.post('/import/hevy/:secret', express.text({ type: '*/*', limit: '10mb' }), async (req, res) => {
  if (req.params.secret !== process.env.COMPOSIO_WEBHOOK_SECRET) return res.status(401).send('Unauthorized');
  try {
    const rows = parseHevyCSV(req.body);
    const workouts = groupHevyWorkouts(rows);
    let upserted = 0;
    for (const w of workouts) {
      await supabase.from('hevy_workouts').delete().eq('workout_date', w.workout_date).eq('workout_title', w.title);
      const { error } = await supabase.from('hevy_workouts').insert({
        workout_date: w.workout_date,
        workout_title: w.title,
        start_time: w.start_time,
        end_time: w.end_time,
        exercises: w.exercises,
      });
      if (error) console.error('[hevy] Insert error:', error.message);
      else upserted++;
    }
    console.log(`[hevy] Imported ${upserted} workouts`);
    res.json({ imported: upserted, workouts: workouts.map(w => ({ title: w.title, date: w.workout_date, exercises: w.exercises.length })) });
  } catch (err) {
    console.error('[hevy] Import error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Telegram webhook — verified via X-Telegram-Bot-Api-Secret-Token header
app.post('/webhook/telegram', (req, res) => {
  const token = req.headers['x-telegram-bot-api-secret-token'];
  if (token !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  // Respond 200 immediately so Telegram stops retrying regardless of what follows
  res.status(200).send('OK');

  const update = req.body;
  const msg = update.message ?? update.edited_message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  console.log('[telegram] Message from chat', chatId);

  const text = msg.text ?? '';
  if (/^\/pain\s+/i.test(text)) {
    handlePainLog(chatId, text).catch(err => console.error('[pain] Error:', err.message));
  } else if (/^\/injuries$/i.test(text)) {
    handleInjuries(chatId).catch(err => console.error('[injuries] Error:', err.message));
  } else if (/^\/return$/i.test(text)) {
    handleReturnCommand(chatId).catch(err => console.error('[return] Error:', err.message));
  } else if (/^\/eats_yesterday$/i.test(text)) {
    const d = new Date(Date.now() - 86400000);
    const label = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
    handleEats(chatId, d.toISOString().slice(0, 10), label).catch(err => console.error('[eats] Error:', err.message));
  } else if (/^\/eats$/i.test(text)) {
    const d = new Date();
    const label = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
    handleEats(chatId, d.toISOString().slice(0, 10), label).catch(err => console.error('[eats] Error:', err.message));
  } else if (/^\/nutrition_week$/i.test(text)) {
    handleNutritionWeek(chatId).catch(err => console.error('[nutrition] Error:', err.message));
  } else if (/^\/nutrition_yesterday$/i.test(text)) {
    const d = new Date(Date.now() - 86400000);
    const label = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
    handleNutrition(chatId, d.toISOString().slice(0, 10), label).catch(err => console.error('[nutrition] Error:', err.message));
  } else if (/^\/nutrition$/i.test(text)) {
    const d = new Date();
    const label = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
    handleNutrition(chatId, d.toISOString().slice(0, 10), label).catch(err => console.error('[nutrition] Error:', err.message));
  } else if (/^\/garmin$/i.test(text)) {
    handleGarminSnapshot(chatId).catch(err => console.error('[garmin] Error:', err.message));
  } else if (/^\/sleep$/i.test(text)) {
    handleGarminSleep(chatId).catch(err => console.error('[garmin] Error:', err.message));
  } else if (/^\/readiness$/i.test(text)) {
    handleGarminReadiness(chatId).catch(err => console.error('[garmin] Error:', err.message));
  } else if (/^\/recovery$/i.test(text)) {
    handleGarminRecovery(chatId).catch(err => console.error('[garmin] Error:', err.message));
  } else if (/^\/vo2$/i.test(text)) {
    handleGarminVO2(chatId).catch(err => console.error('[garmin] Error:', err.message));
  } else if (/^\/race$/i.test(text)) {
    handleGarminRace(chatId).catch(err => console.error('[garmin] Error:', err.message));
  } else if (/^\/training$/i.test(text)) {
    handleGarminTraining(chatId).catch(err => console.error('[garmin] Error:', err.message));
  } else if (/^\/shoes$/i.test(text)) {
    handleGarminShoes(chatId).catch(err => console.error('[garmin] Error:', err.message));
  } else if (/^\/garmin_week$/i.test(text)) {
    handleGarminWeek(chatId).catch(err => console.error('[garmin] Error:', err.message));
  } else if (/^\/garmin_status$/i.test(text)) {
    handleGarminStatus(chatId).catch(err => console.error('[garmin] Error:', err.message));
  } else if (/^\/sync_garmin$/i.test(text)) {
    sendTelegram(chatId, '⌚ Starting Garmin sync...').catch(() => {});
    garmin.syncGarminHistory(30)
      .then(count => sendTelegram(chatId, `✅ Garmin sync complete — ${count} days synced`))
      .catch(err => sendTelegram(chatId, `❌ Garmin sync failed: ${err.message}`).catch(() => {}));
  } else {
    getBotState('conversation').then(state => {
      if (state?.step) {
        handleConversationReply(chatId, text, state).catch(err => console.error('[conv] Error:', err.message));
      } else {
        getCoachingResponse(text)
          .then((reply) => sendTelegram(chatId, reply))
          .catch((err) => console.error('[telegram] Handler error:', err.message));
      }
    }).catch(err => {
      console.error('[state] Error:', err.message);
      getCoachingResponse(text).then(r => sendTelegram(chatId, r)).catch(() => {});
    });
  }
});

async function sendTelegram(chatId, text) {
  const r = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    }
  );
  if (!r.ok) console.error('[telegram] sendMessage HTTP', r.status);
}

// ── Garmin command handlers ───────────────────────────────────────────────────

async function handleGarminSnapshot(chatId) {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const data = await garmin.getLatestGarminData(yesterday);
  const msg = garmin.formatGarminSnapshot(data, yesterday);
  await sendTelegram(chatId, msg);
}

async function handleGarminSleep(chatId) {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const data = await garmin.getLatestGarminData(yesterday);
  const msg = garmin.formatSleepDetail(data?.sleep, yesterday);
  await sendTelegram(chatId, msg);
}

async function handleGarminReadiness(chatId) {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const data = await garmin.getLatestGarminData(yesterday);
  const msg = garmin.formatReadiness(data?.training, yesterday);
  await sendTelegram(chatId, msg);
}

async function handleGarminRecovery(chatId) {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const data = await garmin.getLatestGarminData(yesterday);
  const msg = garmin.formatRecovery(data, yesterday);
  await sendTelegram(chatId, msg);
}

async function handleGarminVO2(chatId) {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const data = await garmin.getLatestGarminData(yesterday);
  const msg = garmin.formatVO2(data?.training, yesterday);
  await sendTelegram(chatId, msg);
}

async function handleGarminRace(chatId) {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const data = await garmin.getLatestGarminData(yesterday);
  const msg = garmin.formatRace(data?.race, yesterday);
  await sendTelegram(chatId, msg);
}

async function handleGarminTraining(chatId) {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const data = await garmin.getLatestGarminData(yesterday);
  const msg = garmin.formatTraining(data?.training, yesterday);
  await sendTelegram(chatId, msg);
}

async function handleGarminShoes(chatId) {
  const msg = await garmin.formatShoes();
  await sendTelegram(chatId, msg);
}

async function handleGarminWeek(chatId) {
  const summary = await garmin.getGarminWeekSummary();
  const msg = garmin.formatGarminWeekSummary(summary);
  await sendTelegram(chatId, msg);
}

async function handleGarminStatus(chatId) {
  const { data } = await supabase.from('daily_garmin_sleep').select('date').order('date', { ascending: false }).limit(1);
  const lastSync = data?.[0]?.date;
  if (lastSync) {
    await sendTelegram(chatId, `⌚ Garmin last synced: ${lastSync}\nAll health tables active — use /garmin for today's snapshot`);
  } else {
    await sendTelegram(chatId, '⌚ Garmin: no data yet — trigger /sync_garmin to pull history');
  }
}

function isWeatherQuestion(text) {
  return /\b(when|best time|what time|weather|forecast|today|tomorrow|run today|run tomorrow|should i run)\b/i.test(text);
}

function calculateSunriseSunset() {
  const LAT = parseFloat(process.env.RUNNER_LAT);
  const LON = parseFloat(process.env.RUNNER_LON);

  const n = (Date.now() / 86400000) + 0.0008 + 2440587.5 - 2451545;
  const J = Math.floor(n) - LON / 360;
  const M = (357.5291 + 0.98560028 * J) % 360.0;
  const M_rad = M * Math.PI / 180;
  const C = 1.9148 * Math.sin(M_rad) + 0.02 * Math.sin(2 * M_rad) + 0.0003 * Math.sin(3 * M_rad);
  const gamma = (M + C + 180 + 102.9372) % 360.0;
  const gamma_rad = gamma * Math.PI / 180;
  const J_transit = 2451545 + J + 0.0053 * Math.sin(M_rad) - 0.0069 * Math.sin(2 * gamma_rad);
  const sin_delta = Math.sin(gamma_rad) * Math.sin(23.4397 * Math.PI / 180);
  const cos_delta = Math.cos(Math.asin(sin_delta));
  const cos_omega_0 = (Math.sin(-0.833 * Math.PI / 180) - Math.sin(LAT * Math.PI / 180) * sin_delta) / (Math.cos(LAT * Math.PI / 180) * cos_delta);
  const hi = Math.acos(cos_omega_0);
  const JRise = J_transit - hi / (2 * Math.PI);
  const JSet  = J_transit + hi / (2 * Math.PI);

  return {
    sunrise: new Date((JRise - 0.0008 - 2440587.5) * 86400000),
    sunset:  new Date((JSet  - 0.0008 - 2440587.5) * 86400000),
  };
}

async function getWeatherForecast() {
  const lat = process.env.RUNNER_LAT;
  const lon = process.env.RUNNER_LON;
  const key = process.env.OPENWEATHER_API_KEY;
  const r = await fetch(
    `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${key}&units=metric`
  );
  if (!r.ok) throw new Error(`OpenWeather HTTP ${r.status}`);
  const data = await r.json();

  // Next 48 hours of 3-hour slots (covers today + tomorrow)
  const now = Date.now() / 1000;
  const slots = data.list
    .filter((s) => s.dt > now && s.dt < now + 172800)
    .map((s) => {
      const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const localSec = s.dt + 3 * 3600; // Israel = UTC+3 (summer)
      const ld = new Date(localSec * 1000);
      const label = `${DAYS[ld.getUTCDay()]} ${String(ld.getUTCHours()).padStart(2,'0')}:${String(ld.getUTCMinutes()).padStart(2,'0')}`;
      return `${label}: ${Math.round(s.main.temp)}°C, ${s.weather[0].description}, wind ${Math.round(s.wind.speed)} m/s, humidity ${s.main.humidity}%`;
    })
    .join('\n');

  console.log(`[weather] Fetched ${slots.split('\n').length} slots`);
  return slots || 'No forecast data available';
}

const MONTHS = { january:0, february:1, march:2, april:3, may:4, june:5, july:6, august:7, september:8, october:9, november:10, december:11, jan:0, feb:1, mar:2, apr:3, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

function parseTimeWindow(text) {
  const t = text.toLowerCase();

  // "last week" / "last month"
  if (/last\s+week/.test(t)) return { cutoff: daysAgo(7), label: 'last 7 days' };
  if (/last\s+month/.test(t)) return { cutoff: daysAgo(30), label: 'last 30 days' };

  // "last N days/weeks/months" or "N days/weeks/months ago"
  const rel = t.match(/(\d+)\s+(day|week|month)s?\s+ago/) || t.match(/last\s+(\d+)\s+(day|week|month)s?/);
  if (rel) {
    const n = parseInt(rel[1]);
    const unit = rel[2];
    const days = unit === 'week' ? n * 7 : unit === 'month' ? n * 30 : n;
    return { cutoff: daysAgo(days), label: `last ${days} days` };
  }

  // "since/from/at/on February 3" or "February 3" or "Feb 3"
  const abs = t.match(/(?:since|from|at|on)?\s*([a-z]+)\s+(\d{1,2})/);
  if (abs && MONTHS[abs[1]] !== undefined) {
    const month = MONTHS[abs[1]];
    const day = parseInt(abs[2]);
    const now = new Date();
    let year = now.getFullYear();
    const d = new Date(year, month, day);
    if (d > now) d.setFullYear(year - 1); // if date is in the future, use last year
    return { cutoff: d.toISOString(), label: `since ${abs[1]} ${day}` };
  }

  return { cutoff: daysAgo(14), label: 'last 14 days' };
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

async function getCoachingResponse(userText) {
  const { cutoff, label } = parseTimeWindow(userText);

  const { data: activities, error } = await supabase
    .from('activities')
    .select('type, distance_m, moving_time_s, started_at, raw')
    .gte('started_at', cutoff)
    .order('started_at', { ascending: false });

  if (error) console.error('[coaching] Supabase query error:', error.message);

  let summary = 'No activities in the last 14 days.';
  if (activities?.length) {
    summary = activities
      .map((a) => {
        const date = new Date(a.started_at).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        });
        const distKm = (a.distance_m ?? 0) / 1000;
        const km = distKm.toFixed(2);
        const totalSec = a.moving_time_s ?? 0;
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        const duration = `${mins}:${String(secs).padStart(2, '0')}`;

        let pace = '';
        if (distKm > 0) {
          const ppm = totalSec / distKm;
          const pm = Math.floor(ppm / 60);
          const ps = Math.round(ppm % 60);
          pace = ` @ ${pm}:${String(ps).padStart(2, '0')}/km`;
        }

        const avgHR = a.raw?.average_heartrate ? `avg HR ${Math.round(a.raw.average_heartrate)}/${a.raw.max_heartrate} bpm` : '';

        return `${date}: ${a.type ?? 'Unknown'}, ${km} km, ${duration}${pace}${avgHR ? ', ' + avgHR : ''}`;
      })
      .join('\n');
  }

  let weatherSection = '';
  try {
    const forecast = await getWeatherForecast();
    const { sunrise, sunset } = calculateSunriseSunset();
    const fmt = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
    weatherSection = `\nWeather forecast for ${process.env.RUNNER_LOCATION} (next 48h):\n${forecast}\nSunrise: ${fmt(sunrise)}, Sunset: ${fmt(sunset)}\n`;
    console.log('[weather] Included in prompt');
  } catch (err) {
    console.error('[weather] Forecast error:', err.message);
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1536,
    system:
      "You are an expert endurance coach. Give concrete, personalized advice based on the athlete's recent training and, when provided, local weather conditions. Recommend the best time window to run based on temperature, rain, wind and humidity. Be direct and specific. Use metric units.",
    messages: [
      {
        role: 'user',
        content: `Recent training (${label}):\n${summary}\n${weatherSection}\nAthlete: ${userText}`,
      },
    ],
  });

  return response.content[0].text;
}

async function fetchMFPDiary(dateStr) {
  const username = process.env.MFP_USERNAME;
  const url = `https://www.myfitnesspal.com/reports/printable-diary/${username}?from=${dateStr}&to=${dateStr}`;

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    headless: true,
  });

  let result;
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    console.log(`[mfp] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('[mfp] DOM loaded, waiting for table rows');
    await page.waitForSelector('.MuiTableRow-root', { timeout: 25000 });
    console.log('[mfp] Table rows visible, extracting data');

    result = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      if (!tables.length) return null;

      const getCells = (row) => Array.from(row.querySelectorAll('th, td')).map(c => c.textContent.trim());
      const toInt = (s) => { const n = parseInt(s); return isNaN(n) ? null : n; };

      // Totals row: first cell is "TOTALS" (case-insensitive), first table only
      let totals = null;
      let headers = [];
      for (const row of tables[0].querySelectorAll('tr')) {
        const cells = getCells(row);
        if (!cells.length) continue;
        if (row.classList.contains('MuiTableRow-head')) {
          headers = cells.map(h => h.toLowerCase());
          continue;
        }
        if (/^totals$/i.test(cells[0])) { totals = cells; break; }
      }

      const idx = (name) => headers.findIndex(h => h.includes(name));
      const get = (name) => totals ? toInt(totals[idx(name)]) : null;

      // Food items grouped by meal
      const meals = {};
      let currentMeal = 'Other';
      for (const row of tables[0].querySelectorAll('tr')) {
        if (row.classList.contains('MuiTableRow-head')) continue;
        const cells = getCells(row);
        if (!cells.length || !cells[0]) continue;
        if (/^totals$/i.test(cells[0])) continue;
        const cal = toInt(cells[1]);
        if (cal !== null && cal > 0) {
          if (!meals[currentMeal]) meals[currentMeal] = [];
          meals[currentMeal].push({ name: cells[0], calories: cal, carbs_g: toInt(cells[2]), fat_g: toInt(cells[3]), protein_g: toInt(cells[4]), sodium_mg: toInt(cells[6]), sugar_g: toInt(cells[7]), fiber_g: toInt(cells[8]) });
        } else if (cells.slice(1).every(c => !c || c === '--' || c === '-' || /^0(mg|g)?$/.test(c))) {
          currentMeal = cells[0];
        }
      }

      return {
        calories: get('calorie') ?? get('cal'),
        carbs_g: get('carb'), fat_g: get('fat'), protein_g: get('protein'),
        fiber_g: get('fiber'), sugar_g: get('sugar'), sodium_mg: get('sodium'),
        meals,
      };
    });

    console.log(`[mfp] Extracted: cal=${result?.calories} meals=${Object.keys(result?.meals ?? {}).join(',')}`);
  } finally {
    await browser.close();
  }

  if (!result) return { calories: null, protein_g: null, carbs_g: null, fat_g: null, fiber_g: null, sugar_g: null, sodium_mg: null, raw: { url, date: dateStr, meals: {} } };
  const { meals, ...totals } = result;
  return { ...totals, raw: { url, date: dateStr, meals } };
}

async function storeDailyNutrition(dateStr) {
  try {
    const nutrition = await fetchMFPDiary(dateStr);
    if (!nutrition.calories) { console.log(`[mfp] No data for ${dateStr}`); return null; }
    await supabase.from('nutrition_log').upsert({ date: dateStr, ...nutrition });
    console.log(`[mfp] Stored nutrition for ${dateStr}: ${nutrition.calories} kcal`);
    return nutrition;
  } catch (err) {
    console.error('[mfp] Fetch error:', err.message);
    return null;
  }
}

async function runMFPScrapeWithRetry(dateStr) {
  const result = await storeDailyNutrition(dateStr);
  if (!result) {
    await sendTelegram(process.env.TELEGRAM_OWNER_CHAT_ID, 'MFP scrape failed — check diary is public.');
    console.log('[mfp] Retry scheduled in 30 minutes');
    setTimeout(async () => {
      console.log('[mfp] Retrying scrape for', dateStr);
      await storeDailyNutrition(dateStr);
    }, 30 * 60 * 1000);
  }
}

async function handleNutrition(chatId, dateStr, label) {
  let nutrition = await getStoredNutrition(dateStr);
  if (!nutrition) nutrition = await storeDailyNutrition(dateStr);
  if (!nutrition?.calories) {
    await sendTelegram(chatId, `No nutrition data for ${label}. Make sure your MFP diary is public.`);
    return;
  }
  const lines = [
    `Nutrition — ${label}`,
    `Calories: ${nutrition.calories} kcal`,
    `Protein: ${nutrition.protein_g ?? '—'}g`,
    `Carbs: ${nutrition.carbs_g ?? '—'}g`,
    `Fat: ${nutrition.fat_g ?? '—'}g`,
    `Sodium: ${nutrition.sodium_mg ?? '—'}mg`,
    `Sugar: ${nutrition.sugar_g ?? '—'}g`,
    `Fiber: ${nutrition.fiber_g ?? '—'}g`,
  ];
  await sendTelegram(chatId, lines.join('\n'));
}

async function handleEats(chatId, dateStr, label) {
  let nutrition = await getStoredNutrition(dateStr);
  // Re-scrape if meals missing or predate sodium/sugar/fiber support
  const firstItem = Object.values(nutrition?.raw?.meals ?? {})[0]?.[0];
  if (!nutrition?.raw?.meals || !('sodium_mg' in (firstItem ?? {}))) {
    nutrition = await storeDailyNutrition(dateStr);
  }
  const meals = nutrition?.raw?.meals;
  if (!meals || !Object.keys(meals).length) {
    await sendTelegram(chatId, `No food log for ${label}.`);
    return;
  }

  // Sort meals in standard order
  const MEAL_ORDER = ['breakfast', 'morning snack', 'lunch', 'afternoon snack', 'dinner', 'evening snack', 'snacks'];
  const sortedMeals = Object.entries(meals).sort(([a], [b]) => {
    const ai = MEAL_ORDER.findIndex(m => a.toLowerCase().includes(m));
    const bi = MEAL_ORDER.findIndex(m => b.toLowerCase().includes(m));
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  // Translate all food names to English in one Claude call
  const allNames = sortedMeals.flatMap(([, items]) => items.map(i => i.name));
  let translatedNames = allNames;
  try {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: `Translate these food names to English. Keep brand names, quantities and units as-is. Return only a JSON array of strings in the same order, nothing else.\n${JSON.stringify(allNames)}` }],
    });
    const parsed = JSON.parse(res.content[0].text.replace(/```json|```/g, '').trim());
    if (Array.isArray(parsed) && parsed.length === allNames.length) translatedNames = parsed;
  } catch {}

  const lines = [`Food log — ${label}`];
  let nameIdx = 0;
  for (const [meal, items] of sortedMeals) {
    lines.push(`\n${meal}:`);
    for (const item of items) {
      const name = translatedNames[nameIdx++];
      const parts = [`${item.calories} kcal`, `p ${item.protein_g ?? 0}g`, `c ${item.carbs_g ?? 0}g`, `f ${item.fat_g ?? 0}g`];
      if (item.sodium_mg != null) parts.push(`na ${item.sodium_mg}mg`);
      if (item.sugar_g   != null) parts.push(`su ${item.sugar_g}g`);
      if (item.fiber_g   != null) parts.push(`fi ${item.fiber_g}g`);
      lines.push(`• ${name} — ${parts.join(' - ')}`);
    }
  }
  if (nutrition.calories) lines.push(`\nTotal: ${nutrition.calories} kcal - p ${nutrition.protein_g ?? 0}g - c ${nutrition.carbs_g ?? 0}g - f ${nutrition.fat_g ?? 0}g`);
  await sendTelegram(chatId, lines.join('\n'));
}

async function handleNutritionWeek(chatId) {
  const now = new Date();
  const rows = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
    const row = await getStoredNutrition(d);
    if (row?.calories) rows.push(row);
  }
  if (!rows.length) {
    await sendTelegram(chatId, 'No nutrition data for the past 7 days.');
    return;
  }
  const avg = (key) => Math.round(rows.reduce((s, r) => s + (r[key] ?? 0), 0) / rows.length);
  const lines = [
    `Nutrition — 7-day average (${rows.length} days logged)`,
    `Calories: ${avg('calories')} kcal/day`,
    `Protein: ${avg('protein_g')}g/day`,
    `Carbs: ${avg('carbs_g')}g/day`,
    `Fat: ${avg('fat_g')}g/day`,
    `Sodium: ${avg('sodium_mg')}mg/day`,
    `Sugar: ${avg('sugar_g')}g/day`,
    `Fiber: ${avg('fiber_g')}g/day`,
  ];
  await sendTelegram(chatId, lines.join('\n'));
}

async function getStoredNutrition(dateStr) {
  const { data } = await supabase.from('nutrition_log').select('*').eq('date', dateStr).single();
  return data ?? null;
}

async function fetchTrainingPeaksEmail() {
  const connectionId = process.env.COMPOSIO_GMAIL_CONNECTION_ID;
  if (!connectionId) throw new Error('COMPOSIO_GMAIL_CONNECTION_ID not set');

  const res = await fetch('https://backend.composio.dev/api/v3/actions/GMAIL_FETCH_EMAILS/execute', {
    method: 'POST',
    headers: { 'x-api-key': process.env.COMPOSIO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      connectedAccountId: connectionId,
      input: { user_id: 'me', query: 'from:noreply@trainingpeaks.com newer_than:1d', max_results: 3 },
    }),
  });
  if (!res.ok) throw new Error(`Composio Gmail HTTP ${res.status}`);
  const data = await res.json();
  return data?.data?.messages ?? data?.response?.data?.messages ?? [];
}

async function parseTrainingPeaksEmail(emailBody) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: 'Extract workout details from a TrainingPeaks email. Reply with JSON only, no explanation.',
    messages: [{
      role: 'user',
      content: `Extract from this TrainingPeaks email and return JSON with keys: workout_type, duration_min (integer), distance_km (number or null), hr_zones (string or null), coach_notes (string or null).

Email:
${emailBody.slice(0, 3000)}`,
    }],
  });
  try {
    const text = response.content[0].text.replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchAndStoreTodayPlan() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const messages = await fetchTrainingPeaksEmail();
    if (!messages.length) { console.log('[tp] No TrainingPeaks email found'); return null; }

    const body = messages[0]?.body?.content ?? messages[0]?.snippet ?? messages[0]?.body ?? '';
    const parsed = await parseTrainingPeaksEmail(body);
    if (!parsed) { console.log('[tp] Could not parse email'); return null; }

    await supabase.from('planned_sessions').upsert({ date: today, ...parsed, raw_email: body.slice(0, 5000) });
    console.log(`[tp] Stored plan for ${today}: ${parsed.workout_type}`);
    return parsed;
  } catch (err) {
    console.error('[tp] Error:', err.message);
    return null;
  }
}

async function getTodayPlan() {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase.from('planned_sessions').select('*').eq('date', today).single();
  return data ?? null;
}

function parsePainCommand(input) {
  // "left knee 6/10 sharp after long run"
  const match = input.match(/^(.+?)\s+(\d+)\/10\s*(.*)?$/i);
  if (!match) return null;
  const level = parseInt(match[2]);
  if (level < 1 || level > 10) return null;
  return { body_part: match[1].trim(), pain_level: level, description: match[3]?.trim() || null };
}

async function check3DayWarning(bodyPart) {
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase.from('pain_log').select('date').eq('body_part', bodyPart).gte('date', twoDaysAgo).lte('date', today);
  const uniqueDates = [...new Set((data ?? []).map(r => r.date))];
  return uniqueDates.length >= 3;
}

async function handlePainLog(chatId, text) {
  const input = text.replace(/^\/pain\s+/i, '').trim();
  const parsed = parsePainCommand(input);
  if (!parsed) {
    await sendTelegram(chatId, 'Format: /pain [body part] [level]/10 [description]\nExample: /pain left knee 6/10 sharp after long run');
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const { data: recentActs } = await supabase.from('activities').select('strava_id, raw').order('started_at', { ascending: false }).limit(1);
  const precedingId = recentActs?.[0]?.strava_id ?? null;
  const activityName = recentActs?.[0]?.raw?.name ?? null;

  const { error } = await supabase.from('pain_log').insert({
    date: today,
    logged_at: new Date().toISOString(),
    body_part: parsed.body_part,
    pain_level: parsed.pain_level,
    description: parsed.description,
    preceding_activity_id: precedingId,
  });

  if (error) { await sendTelegram(chatId, 'Failed to log pain — try again.'); return; }

  let reply = `🩹 Logged: ${parsed.body_part} ${parsed.pain_level}/10${parsed.description ? ` — ${parsed.description}` : ''}`;
  if (activityName) reply += `\nPreceding activity: ${activityName}`;

  const warn = await check3DayWarning(parsed.body_part);
  if (warn) reply += `\n\n⚠️ ${parsed.body_part} logged 3 days in a row.`;

  await sendTelegram(chatId, reply);

  // Activate recovery mode if significant pain or 3-day streak
  const shouldActivate = parsed.pain_level >= 6 || warn;
  if (shouldActivate) {
    const existing = await getActiveRecoverySession();
    const alreadyActive = existing && existing.body_part.toLowerCase() === parsed.body_part.toLowerCase();
    if (!alreadyActive) await activateRecoveryMode(chatId, parsed.body_part);
  }
}

async function handleInjuries(chatId) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const { data: active } = await supabase.from('pain_log').select('*').gte('date', sevenDaysAgo).order('date', { ascending: false });
  const { data: history } = await supabase.from('pain_log').select('*').gte('date', thirtyDaysAgo).lt('date', sevenDaysAgo).order('date', { ascending: false });

  const lines = ['🩹 Injury Log'];
  if (active?.length) {
    lines.push('\nActive (last 7 days):');
    for (const r of active) lines.push(`  ${r.date} · ${r.body_part} ${r.pain_level}/10${r.description ? ` — ${r.description}` : ''}`);
  } else {
    lines.push('\nNo active issues in the last 7 days. ✅');
  }
  if (history?.length) {
    lines.push('\nHistory (8–30 days ago):');
    for (const r of history) lines.push(`  ${r.date} · ${r.body_part} ${r.pain_level}/10${r.description ? ` — ${r.description}` : ''}`);
  }
  await sendTelegram(chatId, lines.join('\n'));
}

async function getActivePainSummary() {
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const { data } = await supabase.from('pain_log').select('body_part, pain_level').gte('date', threeDaysAgo);
  if (!data?.length) return null;
  const best = {};
  for (const r of data) {
    if (!best[r.body_part] || r.pain_level > best[r.body_part]) best[r.body_part] = r.pain_level;
  }
  return Object.entries(best).map(([part, lvl]) => `${part} ${lvl}/10`).join(', ');
}

// ── Recovery Mode ─────────────────────────────────────────────────────────────

async function getActiveRecoverySession() {
  const { data } = await supabase.from('recovery_sessions').select('*').in('status', ['intake', 'active', 'returned']).order('created_at', { ascending: false }).limit(1);
  return data?.[0] ?? null;
}

async function getBotState(key) {
  const { data } = await supabase.from('bot_state').select('value').eq('key', key).single();
  return data?.value ?? null;
}

async function setBotState(key, value) {
  await supabase.from('bot_state').upsert({ key, value, updated_at: new Date().toISOString() });
}

function getAlternativeActivities(bodyPart) {
  const bp = (bodyPart ?? '').toLowerCase();
  if (/knee|it.band|quad|hamstring/.test(bp)) return 'Swimming, upper body strength (avoid leg press)';
  if (/soleus|ankle|foot|calf|achilles|shin/.test(bp)) return 'Swimming, upper body strength, seated cycling (low resistance only)';
  if (/hip|glute/.test(bp)) return 'Swimming, upper body strength, easy walking';
  if (/back/.test(bp)) return 'Easy walking, swimming, gentle core work';
  if (/shoulder|arm|elbow/.test(bp)) return 'Cycling, lower body strength, running if pain-free';
  return 'Swimming, cycling, strength training';
}

async function getPainTrend(bodyPart) {
  const { data } = await supabase.from('pain_log').select('pain_level, date').eq('body_part', bodyPart).order('date', { ascending: false }).limit(4);
  if (!data || data.length < 2) return null;
  if (data[0].pain_level < data[1].pain_level) return 'improving';
  if (data[0].pain_level > data[1].pain_level) return 'worsening';
  return 'stable';
}

async function checkGreenLight(bodyPart) {
  const threeDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const { data } = await supabase.from('pain_log').select('pain_level, date').eq('body_part', bodyPart).gte('date', threeDaysAgo);
  if (!data?.length) return false;
  const byDate = {};
  for (const r of data) { if (!byDate[r.date] || r.pain_level > byDate[r.date]) byDate[r.date] = r.pain_level; }
  const dates = Object.keys(byDate).sort().reverse();
  return dates.length >= 3 && dates.slice(0, 3).every(d => byDate[d] < 3);
}

function generateRecoveryRecommendation(painType, worseTiming) {
  if (painType === 'sharp' && worseTiming === 'during') return 'Rest completely — no running or high-impact until pain-free for 48h';
  if (painType === 'sharp') return 'Cross-train only (swim/bike) — no running until pain-free for 48h';
  if (worseTiming === 'during') return 'Cross-train only — switch to swimming or cycling until symptom-free';
  if (painType === 'burning') return 'Reduce volume by 40% — easy pace only, stop if burning returns';
  return 'Reduce volume by 30% — keep all runs easy, monitor closely';
}

function generateReturnPlan(daysOut) {
  if (daysOut >= 14) {
    return 'Week 1: Walk-run intervals — 1 min run / 2 min walk × 20 min, 3×/week\nWeek 2: Easy continuous runs at 50% normal volume\nWeek 3: Build to 75% if pain-free\nWeek 4: Full return — add one quality session only if symptom-free';
  }
  if (daysOut >= 7) {
    return 'Days 1–2: 20–25 min very easy (conversational pace)\nDays 3–4: 30–35 min easy\nDays 5–7: Resume full easy schedule\nWeek 2: Add one moderate session if pain-free';
  }
  return 'Days 1–2: 25–30 min easy (comfortable pace)\nDays 3–4: 35–40 min easy, normal effort\nDay 5+: Resume normal training if fully pain-free';
}

async function activateRecoveryMode(chatId, bodyPart) {
  const { data } = await supabase.from('recovery_sessions').insert({
    body_part: bodyPart,
    status: 'intake',
    started_at: new Date().toISOString().slice(0, 10),
  }).select().single();
  if (!data) return;
  await setBotState('conversation', { step: 'pain_type', session_id: data.id, body_part: bodyPart });
  await sendTelegram(chatId,
    `🔴 Recovery mode activated for ${bodyPart}.\n\nI have 3 quick questions to build your protocol.\n\nQ1/3: What type of pain is it?\nReply: sharp, dull, or burning`
  );
}

async function handleConversationReply(chatId, text, state) {
  const answer = text.trim().toLowerCase();
  const today = new Date().toISOString().slice(0, 10);

  if (state.step === 'morning_pain_check' || state.step === 'evening_pain_check') {
    const level = parseInt(text.trim());
    if (isNaN(level) || level < 1 || level > 10) {
      await sendTelegram(chatId, 'Please reply with a number between 1 and 10.'); return;
    }
    const isEvening = state.step === 'evening_pain_check';
    await supabase.from('pain_log').insert({
      date: today, logged_at: new Date().toISOString(),
      body_part: 'soleus', pain_level: level,
      description: isEvening ? 'evening check-in' : 'morning check-in',
      check_type: isEvening ? 'evening' : 'morning',
    });
    await setBotState('conversation', null);

    if (isEvening) {
      await sendTelegram(chatId, `Noted — soleus ${level}/10 this evening. Rest well tonight.`);
      return;
    }

    // Morning branching
    await checkPainTrend();
    if (level <= 3) {
      await sendTelegram(chatId,
        `Great progress. Light stretching today is enough:\n\n• Bent knee wall stretch — 3 × 45 sec each leg\n• Ankle circles — 20 each direction\n• Foam roll lower calf — 60 sec each leg (avoid shin bone)\n\nKeep the momentum.`
      );
    } else if (level <= 6) {
      await setBotState('conversation', { step: 'strengthening_confirm', pain_level: level });
      await sendTelegram(chatId,
        `Still some discomfort. Strengthening exercises will actually help speed recovery by rebuilding the soleus tissue.\n\nWant to do today's strengthening program?\nReply: yes or no`
      );
    } else {
      await sendTelegram(chatId,
        `High pain today. Skip all strengthening.\n\nGentle stretching only:\n• Bent knee calf stretch against wall — 3 × 45 sec each leg\n• Seated towel soleus stretch — 3 × 45 sec each foot\n• Ankle circles — 20 each direction\n• Foam roll lower calf — 60 sec each leg (avoid shin bone)\n\n🧊 Ice the shin for 15 minutes.\n\nRest as much as possible today.`
      );
      await checkHighPainStreak();
    }
    return;
  }

  if (state.step === 'strengthening_confirm') {
    if (/^y(es)?$/i.test(answer)) {
      await setBotState('conversation', null);
      const strength = SOLEUS_STRENGTHENING.map(e => `• ${e}`).join('\n');
      const stretch = SOLEUS_STRETCHING.map(e => `• ${e}`).join('\n');
      await sendTelegram(chatId,
        `Full program:\n\nStrengthening:\n${strength}\n\n🧊 Ice shin 15 min after strengthening\n\nStretching:\n${stretch}`
      );
    } else if (/^no?$/i.test(answer)) {
      await setBotState('conversation', null);
      const stretch = SOLEUS_STRETCHING.map(e => `• ${e}`).join('\n');
      await sendTelegram(chatId, `Stretching only:\n\n${stretch}`);
    } else {
      await sendTelegram(chatId, 'Reply yes or no.');
    }
    return;
  }

  if (state.step === 'pain_type') {
    const painType = ['sharp', 'dull', 'burning'].find(v => answer.includes(v));
    if (!painType) { await sendTelegram(chatId, 'Please reply with: sharp, dull, or burning'); return; }
    await supabase.from('recovery_sessions').update({ pain_type: painType }).eq('id', state.session_id);
    await setBotState('conversation', { ...state, step: 'duration', pain_type: painType });
    await sendTelegram(chatId, 'Q2/3: How long has it been there?\n(e.g. "since yesterday", "3 days", "2 weeks")');

  } else if (state.step === 'duration') {
    await supabase.from('recovery_sessions').update({ duration_description: text.trim() }).eq('id', state.session_id);
    await setBotState('conversation', { ...state, step: 'worse_timing' });
    await sendTelegram(chatId, 'Q3/3: Does it get worse during or after running?\nReply: during, after, both, or neither');

  } else if (state.step === 'worse_timing') {
    const timing = ['during', 'after', 'both', 'neither'].find(v => answer.includes(v));
    if (!timing) { await sendTelegram(chatId, 'Please reply: during, after, both, or neither'); return; }
    const rec = generateRecoveryRecommendation(state.pain_type, timing);
    await supabase.from('recovery_sessions').update({ worse_timing: timing, recommendation: rec, status: 'active' }).eq('id', state.session_id);
    await setBotState('conversation', null);
    const alts = getAlternativeActivities(state.body_part);
    await sendTelegram(chatId,
      `📋 Recovery Protocol — ${state.body_part}:\n\n${rec}\n\n💪 Alternative activities: ${alts}\n\nLog pain daily with /pain. I'll track your trend and tell you when you can return to running. Type /return when you're ready to start your comeback.`
    );
  }
}

async function handleReturnCommand(chatId) {
  const session = await getActiveRecoverySession();
  if (!session || session.status === 'intake') {
    await sendTelegram(chatId, 'No active recovery session. Log pain first with /pain.'); return;
  }
  if (session.status === 'returned') {
    const returnDay = Math.floor((Date.now() - new Date(session.return_started_at).getTime()) / 86400000) + 1;
    await sendTelegram(chatId, `You're already on Day ${returnDay} of your return plan at ${session.return_volume_pct}% volume. Keep going — stop if pain rises above 3/10.`); return;
  }
  const daysOut = Math.floor((Date.now() - new Date(session.started_at).getTime()) / 86400000);
  const pct = daysOut < 7 ? 60 : daysOut <= 14 ? 40 : 20;
  const plan = generateReturnPlan(daysOut);
  await supabase.from('recovery_sessions').update({ status: 'returned', return_started_at: new Date().toISOString().slice(0, 10), days_out: daysOut, return_volume_pct: pct }).eq('id', session.id);
  await sendTelegram(chatId, `🏃 Return-to-Running Plan\n\n${daysOut} day${daysOut !== 1 ? 's' : ''} out → starting at ${pct}% volume\n\n${plan}\n\nLog your pain after each run with /pain. Stop and rest if pain rises above 3/10.`);
}

async function getRecoveryBriefing(session) {
  const daysElapsed = Math.floor((Date.now() - new Date(session.started_at).getTime()) / 86400000);
  const daysManaging = daysElapsed + 1;

  // Auto-switch to return-to-running after 14-day rest phase
  if (session.status === 'active' && daysElapsed >= 14) {
    const today = new Date().toISOString().slice(0, 10);
    await supabase.from('recovery_sessions').update({
      status: 'returned', return_started_at: today, days_out: daysElapsed, return_volume_pct: 20,
    }).eq('id', session.id);
    session = { ...session, status: 'returned', return_started_at: today, days_out: daysElapsed, return_volume_pct: 20 };
    sendTelegram(process.env.TELEGRAM_OWNER_CHAT_ID,
      `🟢 14-day rest phase complete!\n\nSwitching to return-to-running at 20% volume.\n\n${generateReturnPlan(daysElapsed)}`
    ).catch(() => {});
  }

  const trend = await getPainTrend(session.body_part);
  const greenLight = session.status !== 'returned' ? await checkGreenLight(session.body_part) : false;
  const trendMap = { improving: '📉 Improving', worsening: '📈 Worsening — ease back', stable: '➡️ Stable' };
  const lines = [`🤕 Recovery — Day ${daysManaging} (${session.body_part})`];

  if (session.status === 'active') {
    const daysRemaining = Math.max(0, 14 - daysElapsed);
    lines.push(`⏳ ${daysRemaining} day${daysRemaining !== 1 ? 's' : ''} remaining in no-run phase`);
  }

  if (trend) lines.push(`Pain trend: ${trendMap[trend]}`);
  if (session.recommendation) lines.push(`Protocol: ${session.recommendation}`);
  lines.push(`Today: ${getAlternativeActivities(session.body_part)}`);

  if (session.status === 'returned') {
    const returnDay = Math.floor((Date.now() - new Date(session.return_started_at).getTime()) / 86400000) + 1;
    lines.push(`Return plan: Day ${returnDay} at ${session.return_volume_pct}% volume — walk-run intervals, stop if pain > 3/10`);
  }

  if (greenLight) lines.push(`\n🟢 3 consecutive days below 3/10 — you may be ready to return. Type /return to start your comeback plan.`);
  return lines.join('\n');
}

async function checkOvertraining() {
  const activeRecovery = await getActiveRecoverySession();
  if (activeRecovery?.status === 'active') {
    console.log('[overtraining] Skipping — athlete is in active recovery');
    return null;
  }
  const now = new Date();
  const weekStart  = new Date(now - 7  * 86400000);
  const prevStart  = new Date(now - 14 * 86400000);
  const prev2Start = new Date(now - 21 * 86400000);

  const fetchActs = async (from, to) => {
    let q = supabase.from('activities').select('type, distance_m, moving_time_s, started_at, raw').gte('started_at', from.toISOString());
    if (to) q = q.lt('started_at', to.toISOString());
    const { data } = await q;
    return data ?? [];
  };

  const [thisWeek, prevWeek, prev2Week] = await Promise.all([
    fetchActs(weekStart),
    fetchActs(prevStart, weekStart),
    fetchActs(prev2Start, prevStart),
  ]);

  const flags = [];

  // 1. Weekly run distance increase > 10%
  const runKm = (acts) => acts.filter(a => (a.raw?.sport_type ?? a.type) === 'Run').reduce((s, a) => s + (a.distance_m ?? 0) / 1000, 0);
  const thisKm = runKm(thisWeek), prevKm = runKm(prevWeek);
  if (prevKm > 0 && thisKm > prevKm * 1.1) {
    flags.push(`🚨 Too much too soon: run distance jumped from ${prevKm.toFixed(1)}km to ${thisKm.toFixed(1)}km (+${Math.round((thisKm / prevKm - 1) * 100)}%). Scale back 10–15% next week.`);
  }

  // 2. Easy HR trending UP 2 weeks in a row
  const isEasy = (a) => (a.raw?.sport_type ?? a.type) === 'Run' && a.raw?.average_heartrate && a.raw.average_heartrate < 155;
  const easyAvgHR = (acts) => { const hrs = acts.filter(isEasy).map(a => a.raw.average_heartrate); return hrs.length ? hrs.reduce((a, b) => a + b) / hrs.length : null; };
  const hr0 = easyAvgHR(thisWeek), hr1 = easyAvgHR(prevWeek), hr2 = easyAvgHR(prev2Week);
  if (hr0 && hr1 && hr2 && hr0 > hr1 && hr1 > hr2) {
    flags.push(`🚨 Elevated HR — possible fatigue: easy run HR rising 2 weeks straight (${Math.round(hr2)} → ${Math.round(hr1)} → ${Math.round(hr0)} bpm). Prioritise sleep and easy days.`);
  }

  // 3. 6+ training days, no rest day
  const trainingDays = new Set(thisWeek.map(a => a.started_at.slice(0, 10))).size;
  if (trainingDays >= 6) {
    flags.push(`🚨 No recovery day detected: ${trainingDays} training days this week. Schedule at least 1 full rest day.`);
  }

  // 4. 3+ hard effort runs (score > 10)
  const hardRuns = thisWeek.filter(a => { const s = scoreRun(a); return s && s.score > 10; });
  if (hardRuns.length >= 3) {
    flags.push(`🚨 Too many hard sessions: ${hardRuns.length} high-effort runs this week. Add easy/recovery days between hard efforts.`);
  }

  if (!flags.length) return '✅ Training load looks healthy this week. Keep it up!';
  return `⚠️ Overtraining check — Monday ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}:\n\n${flags.join('\n\n')}`;
}

const SOLEUS_STRENGTHENING = [
  'Bent knee calf raises — 3 × 15 reps (knee bent 45° to target soleus, not gastrocnemius)',
  'Single leg bent knee calf raise — 3 × 10 each leg (slow & controlled)',
  'Seated calf raises with weight on knee — 3 × 20 reps',
  'Soleus wall sit hold — 3 × 45 sec',
  'Toe walking — 3 × 30 sec',
];

const SOLEUS_STRETCHING = [
  'Bent knee calf stretch against wall — 3 × 45 sec each leg (knee stays bent — targets soleus not gastrocnemius)',
  'Seated towel soleus stretch — 3 × 45 sec each foot',
  'Ankle circles — 20 each direction, each ankle',
  'Plantar fascia massage with tennis ball — 2 min each foot',
  'Foam roll lower calf/soleus — 60 sec each leg (avoid direct shin bone pressure)',
];

async function getRehabProgram(session) {
  if (!session || !/soleus/i.test(session.body_part)) return null;

  const daysElapsed = Math.floor((Date.now() - new Date(session.started_at).getTime()) / 86400000);
  const dayNumber = daysElapsed + 1;
  const today = new Date().toISOString().slice(0, 10);

  // Check if pain > 7/10 was logged today
  const { data: todayPain } = await supabase.from('pain_log').select('pain_level').ilike('body_part', '%soleus%').eq('date', today).order('pain_level', { ascending: false }).limit(1);
  const maxPainToday = todayPain?.[0]?.pain_level ?? 0;

  const forcedStretchOnly = maxPainToday > 7;
  const stretchOnly = forcedStretchOnly || dayNumber % 2 === 0;

  const label = forcedStretchOnly
    ? `Day ${dayNumber} — pain logged above 7/10, stretching only today`
    : stretchOnly
      ? `Day ${dayNumber} — micro-recovery day, stretching only`
      : `Day ${dayNumber} — full program`;

  const lines = [`\n💪 Soleus Rehab — ${label}`];

  if (!stretchOnly) {
    lines.push('\nStrengthening:');
    for (const ex of SOLEUS_STRENGTHENING) lines.push(`  • ${ex}`);
    lines.push('\n🧊 Ice shin area for 15 min after strengthening exercises');
    lines.push('\nStretching:');
    for (const ex of SOLEUS_STRETCHING) lines.push(`  • ${ex}`);
  } else {
    lines.push('\nStretching:');
    for (const ex of SOLEUS_STRETCHING) lines.push(`  • ${ex}`);
  }

  return lines.join('\n');
}

// ── Image Briefing ────────────────────────────────────────────────────────────

async function getStructuredWeather() {
  const lat = process.env.RUNNER_LAT;
  const lon = process.env.RUNNER_LON;
  const key = process.env.OPENWEATHER_API_KEY;
  const r = await fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${key}&units=metric`);
  if (!r.ok) return null;
  const data = await r.json();

  const now = Date.now() / 1000;
  const israelOffset = 3 * 3600;
  const toLocalTime = (dt) => {
    const h = Math.floor(((dt + israelOffset) % 86400) / 3600);
    const m = Math.floor(((dt + israelOffset) % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };

  const slots = data.list.filter(s => s.dt > now && s.dt < now + 48 * 3600);
  if (!slots.length) return null;

  const current = slots[0];

  const todaySlots = slots.filter(s => s.dt < now + 14 * 3600);
  const peakSlot = todaySlots.reduce((max, s) => s.main.temp > max.main.temp ? s : max, todaySlots[0] ?? current);

  const candidateSlots = slots.filter(s => {
    const h = ((s.dt + israelOffset) % 86400) / 3600;
    return (h >= 5 && h <= 9) || (h >= 16 && h <= 19);
  });
  const bestSlot = candidateSlots.length
    ? candidateSlots.reduce((best, s) => s.main.temp < best.main.temp ? s : best, candidateSlots[0])
    : slots.reduce((best, s) => s.main.temp < best.main.temp ? s : best, slots[0]);

  const tomorrowSlots = slots.filter(s => s.dt > now + 12 * 3600 && s.dt < now + 36 * 3600);
  const tomorrowPeak = tomorrowSlots.length ? Math.round(Math.max(...tomorrowSlots.map(s => s.main.temp))) : null;

  return {
    current: {
      temp: Math.round(current.main.temp),
      description: current.weather[0].description,
      windSpeed: Math.round(current.wind.speed),
      humidity: current.main.humidity,
    },
    peak: { temp: Math.round(peakSlot.main.temp), time: toLocalTime(peakSlot.dt) },
    bestWindow: {
      start: toLocalTime(bestSlot.dt),
      end: toLocalTime(bestSlot.dt + 5400),
      temp: Math.round(bestSlot.main.temp),
    },
    tomorrow: {
      peak: tomorrowPeak,
      description: tomorrowSlots[0]?.weather[0]?.main ?? null,
      isHot: tomorrowPeak != null && tomorrowPeak > 30,
    },
  };
}

async function getRehabDataStructured(session, painLevel) {
  if (!session || !/soleus/i.test(session.body_part)) return null;
  const today = new Date().toISOString().slice(0, 10);
  const { data: todayPain } = await supabase.from('pain_log')
    .select('pain_level')
    .ilike('body_part', '%soleus%')
    .eq('date', today)
    .order('pain_level', { ascending: false })
    .limit(1);
  const maxPain = todayPain?.[0]?.pain_level ?? painLevel ?? 0;
  const daysElapsed = Math.floor((Date.now() - new Date(session.started_at).getTime()) / 86400000);
  const dayNumber = daysElapsed + 1;
  const stretchOnly = maxPain > 7 || dayNumber % 2 === 0;

  const parseExercise = (ex) => {
    const m = ex.match(/^(.+?)\s+—\s+(.+?)(?:\s+\(|$)/);
    return m ? { name: m[1].trim(), reps: m[2].trim() } : { name: ex, reps: '' };
  };

  return {
    dayNumber,
    stretchOnly,
    label: maxPain > 7 ? 'High pain — stretch only' : stretchOnly ? 'Recovery day — stretch only' : 'Full program',
    strengthening: stretchOnly ? [] : SOLEUS_STRENGTHENING.map(parseExercise),
    stretching: SOLEUS_STRETCHING.map(parseExercise),
  };
}

function calculateReadinessScore(painLevel, recoverySession, garminReadiness) {
  if (garminReadiness?.readiness_score) {
    const s = garminReadiness.readiness_score;
    const cls = garminReadiness.readiness_classification ?? (s >= 70 ? 'Optimal' : s >= 50 ? 'Good' : s >= 30 ? 'Fair' : 'Poor');
    const level = s >= 70 ? 'good' : s >= 55 ? 'moderate' : s >= 40 ? 'caution' : s >= 25 ? 'low' : 'critical';
    return { score: s, description: `${cls} readiness — Garmin Training Readiness`, level };
  }
  if (!recoverySession) return { score: 75, description: 'No active injury — full training load OK', level: 'good' };
  const pain = painLevel ?? 5;
  if (pain <= 2) return { score: 70, description: 'Low pain — light activity OK', level: 'moderate' };
  if (pain <= 4) return { score: 60, description: 'Moderate pain — rehab + cross-train', level: 'caution' };
  if (pain <= 6) return { score: 52, description: 'Significant pain — rest day recommended', level: 'low' };
  return { score: 42, description: 'High pain — full rest, ice & elevate', level: 'critical' };
}

async function getBriefingData() {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const [weatherData, recoverySession, nutrition, plan, garminData] = await Promise.all([
    getStructuredWeather().catch(() => null),
    getActiveRecoverySession(),
    getStoredNutrition(yesterday),
    getTodayPlan().catch(() => null),
    garmin.getLatestGarminData(yesterday).catch(() => null),
  ]);

  let painTrend = null, latestPainLevel = null, rehab = null, crossTraining = null, dayNumber = null;

  if (recoverySession) {
    const { data: painRows } = await supabase.from('pain_log')
      .select('pain_level')
      .ilike('body_part', `%${recoverySession.body_part}%`)
      .order('date', { ascending: false })
      .limit(1);
    latestPainLevel = painRows?.[0]?.pain_level ?? null;
    [painTrend, rehab] = await Promise.all([
      getPainTrend(recoverySession.body_part),
      getRehabDataStructured(recoverySession, latestPainLevel ?? 3),
    ]);
    dayNumber = Math.floor((Date.now() - new Date(recoverySession.started_at).getTime()) / 86400000) + 1;
    crossTraining = getAlternativeActivities(recoverySession.body_part);
  }

  const readiness = calculateReadinessScore(latestPainLevel, recoverySession, garminData?.training);
  const hasRun = !!(plan?.distance_km || plan?.workout_type?.toLowerCase().includes('run'));
  const hydration = hasRun ? 3.5 : 2.5;
  const dateStr = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jerusalem',
  });
  return { dateStr, weather: weatherData, recovery: recoverySession, painTrend, latestPainLevel, rehab, crossTraining, dayNumber, nutrition, readiness, hydration, plan, garminData };
}

function buildBriefingHTML(d) {
  const { dateStr, weather, recovery, painTrend, latestPainLevel, rehab, crossTraining, dayNumber, nutrition, readiness, hydration, garminData } = d;

  const rcColor = { good: '#5BB4FF', moderate: '#7BD8FF', caution: '#FFB450', low: '#FF9A6B', critical: '#FF6B6B' }[readiness.level] ?? '#5BB4FF';
  const rcBg   = { good: 'rgba(91,180,255,0.15)', moderate: 'rgba(123,216,255,0.15)', caution: 'rgba(255,180,80,0.15)', low: 'rgba(255,154,107,0.15)', critical: 'rgba(255,107,107,0.15)' }[readiness.level] ?? 'rgba(91,180,255,0.15)';
  const trendIcon  = { improving: '↓ Improving', worsening: '↑ Worsening', stable: '→ Stable' }[painTrend] ?? '— Unknown';
  const trendColor = { improving: '#A0F0B0', worsening: '#FF6B6B', stable: '#FFB450' }[painTrend] ?? 'rgba(255,255,255,0.55)';

  const crossPills = crossTraining
    ? crossTraining.split(',').map(s => s.replace(/\s*\([^)]*\)/, '').trim()).filter(Boolean)
    : ['Swimming', 'Cycling', 'Strength'];

  const kcal    = nutrition?.calories ?? 0;
  const protein = nutrition?.protein_g ?? 0;
  const carbs   = nutrition?.carbs_g ?? 0;
  const fat     = nutrition?.fat_g ?? 0;
  const totalMacroKcal = protein * 4 + carbs * 4 + fat * 9;
  const proteinPct = totalMacroKcal > 0 ? Math.round((protein * 4 / totalMacroKcal) * 100) : 33;
  const carbsPct   = totalMacroKcal > 0 ? Math.round((carbs * 4 / totalMacroKcal) * 100) : 34;
  const fatPct     = 100 - proteinPct - carbsPct;

  const chipText = dayNumber ? `Day ${dayNumber}/14` : 'Training';
  const israelHour = parseInt(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Jerusalem' }));
  const greeting = israelHour < 12 ? 'Good morning' : 'Good afternoon';

  const exRows = (exList) => exList.map(ex =>
    `<div class="ex-row"><div class="ex-name">${ex.name}</div><div class="ex-reps">${ex.reps}</div></div>`
  ).join('');
  const pills = (list, cls = '') => list.map(p => `<span class="pill ${cls}">${p}</span>`).join('');
  const mfpStatus = nutrition?.calories ? 'dot-green' : 'dot-amber';

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { width:520px; background:linear-gradient(135deg,#061B33 0%,#0A2C52 50%,#0F3A6B 100%); font-family:-apple-system,'Helvetica Neue',Arial,sans-serif; color:#fff; }
.outer { position:relative; width:520px; padding:18px; overflow:hidden; }
.blob-tr { position:absolute; top:-80px; right:-80px; width:300px; height:300px; border-radius:50%; background:radial-gradient(circle,rgba(80,180,255,0.4) 0%,transparent 70%); z-index:0; pointer-events:none; }
.blob-bl { position:absolute; bottom:220px; left:-80px; width:260px; height:260px; border-radius:50%; background:radial-gradient(circle,rgba(120,220,255,0.3) 0%,transparent 70%); z-index:0; pointer-events:none; }
.content { position:relative; z-index:1; }
.card { background:rgba(255,255,255,0.07); border:1px solid rgba(255,255,255,0.12); border-radius:14px; padding:14px 16px; margin-bottom:10px; }
.card-warn { background:rgba(255,180,80,0.08); border-color:rgba(255,180,80,0.4); }
.lbl { font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:1px; color:rgba(255,255,255,0.4); margin-bottom:8px; }
.header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:14px; padding:2px; }
.greeting { font-size:22px; font-weight:700; }
.date-sub { font-size:12px; color:rgba(255,255,255,0.52); margin-top:3px; }
.chip { font-size:11px; font-weight:600; padding:5px 12px; border-radius:20px; background:rgba(91,180,255,0.18); color:#5BB4FF; border:1px solid rgba(91,180,255,0.35); white-space:nowrap; margin-top:2px; }
.rc-row { display:flex; align-items:center; gap:14px; }
.rc-circle { flex-shrink:0; width:70px; height:70px; border-radius:50%; border:3px solid ${rcColor}; background:${rcBg}; display:flex; flex-direction:column; align-items:center; justify-content:center; }
.rc-num { font-size:27px; font-weight:800; color:${rcColor}; line-height:1; }
.rc-unit { font-size:9px; color:rgba(255,255,255,0.38); text-transform:uppercase; letter-spacing:0.5px; }
.rc-desc { font-size:13px; color:rgba(255,255,255,0.78); line-height:1.45; }
.rec-top { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px; }
.rec-title { font-size:14px; font-weight:700; color:#FFB450; }
.pain-big { font-size:34px; font-weight:800; color:#FFB450; line-height:1; }
.pain-sub { font-size:10px; color:rgba(255,255,255,0.38); text-transform:uppercase; }
.trend { font-size:12px; font-weight:500; color:${trendColor}; margin-top:4px; }
.wx-opt { font-size:14px; font-weight:600; color:#fff; margin-bottom:12px; }
.wx-win { font-size:12px; color:#5BB4FF; font-weight:500; }
.wx-grid { display:flex; gap:8px; }
.wx-stat { flex:1; background:rgba(255,255,255,0.05); border-radius:10px; padding:10px; text-align:center; }
.wx-val { font-size:22px; font-weight:700; color:#5BB4FF; }
.wx-lbl { font-size:10px; color:rgba(255,255,255,0.4); text-transform:uppercase; letter-spacing:0.6px; margin-top:3px; }
.ex-sec { font-size:11px; font-weight:600; color:rgba(255,255,255,0.38); text-transform:uppercase; letter-spacing:0.8px; margin:8px 0 4px; }
.ex-row { display:flex; justify-content:space-between; align-items:center; padding:7px 0; border-bottom:1px solid rgba(255,255,255,0.06); }
.ex-row:last-child { border-bottom:none; }
.ex-name { font-size:12.5px; color:rgba(255,255,255,0.82); flex:1; padding-right:8px; line-height:1.3; }
.ex-reps { font-size:11.5px; color:#5BB4FF; font-weight:600; white-space:nowrap; }
.pills { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.pill { font-size:11px; padding:4px 10px; border-radius:12px; background:rgba(255,255,255,0.08); color:rgba(255,255,255,0.72); border:1px solid rgba(255,255,255,0.13); }
.pill-amber { background:rgba(255,180,80,0.15); color:#FFB450; border-color:rgba(255,180,80,0.3); }
.pill-green { background:rgba(160,240,176,0.12); color:#A0F0B0; border-color:rgba(160,240,176,0.25); }
.nutr-top { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px; }
.kcal-big { font-size:32px; font-weight:800; color:#fff; line-height:1; }
.kcal-sub { font-size:10px; color:rgba(255,255,255,0.4); margin-top:2px; }
.nutr-right { text-align:right; }
.nutr-line { font-size:12px; color:rgba(255,255,255,0.6); margin-bottom:3px; }
.nutr-val { color:#7BD8FF; font-weight:600; }
.macro-bar { height:8px; border-radius:4px; overflow:hidden; display:flex; margin-bottom:6px; }
.mp { background:#5BB4FF; width:${proteinPct}%; }
.mc { background:#7BD8FF; width:${carbsPct}%; }
.mf { background:#9EEAFF; width:${fatPct}%; }
.macro-lbls { display:flex; gap:10px; }
.mlbl { font-size:10px; color:rgba(255,255,255,0.48); }
.mlbl b { color:rgba(255,255,255,0.75); }
.sleep-row { display:flex; align-items:center; gap:10px; }
.sleep-icon { font-size:26px; }
.sleep-txt { font-size:13px; color:rgba(255,255,255,0.52); }
.sleep-sub { font-size:11px; color:rgba(255,255,255,0.32); margin-top:2px; }
.gm-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.gm-stat { display:flex; flex-direction:column; }
.gm-val { font-size:18px; font-weight:700; color:#fff; line-height:1.1; }
.gm-lbl { font-size:10px; color:rgba(255,255,255,0.4); margin-top:2px; text-transform:uppercase; letter-spacing:0.5px; }
.gm-badge { display:inline-block; font-size:10px; font-weight:600; padding:2px 8px; border-radius:10px; margin-top:4px; }
.badge-green { background:rgba(160,240,176,0.18); color:#A0F0B0; border:1px solid rgba(160,240,176,0.3); }
.badge-amber { background:rgba(255,180,80,0.18); color:#FFB450; border:1px solid rgba(255,180,80,0.3); }
.badge-red { background:rgba(255,107,107,0.18); color:#FF6B6B; border:1px solid rgba(255,107,107,0.3); }
.badge-blue { background:rgba(91,180,255,0.18); color:#5BB4FF; border:1px solid rgba(91,180,255,0.3); }
.gm-row { display:flex; justify-content:space-between; align-items:center; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.05); }
.gm-row:last-child { border-bottom:none; }
.gm-key { font-size:12px; color:rgba(255,255,255,0.5); }
.gm-v { font-size:12px; font-weight:600; color:rgba(255,255,255,0.85); }
.race-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:4px; }
.race-item { background:rgba(255,255,255,0.05); border-radius:8px; padding:8px 10px; }
.race-dist { font-size:10px; color:rgba(255,255,255,0.4); text-transform:uppercase; letter-spacing:0.5px; }
.race-time { font-size:15px; font-weight:700; color:#7BD8FF; margin-top:2px; }
.tmrw-top { font-size:13px; font-weight:600; color:rgba(255,255,255,0.9); margin-bottom:8px; }
.hyd-big { font-size:32px; font-weight:800; color:#7BD8FF; }
.hyd-sub { font-size:12px; color:rgba(255,255,255,0.46); margin-top:3px; }
.footer { display:flex; flex-wrap:wrap; gap:8px; padding-top:10px; margin-top:4px; border-top:1px solid rgba(255,255,255,0.08); }
.si { display:flex; align-items:center; gap:5px; font-size:10px; color:rgba(255,255,255,0.4); }
.dot { width:5px; height:5px; border-radius:50%; }
.dot-green { background:#A0F0B0; } .dot-amber { background:#FFB450; } .dot-red { background:#FF6B6B; }
</style></head>
<body><div class="outer">
  <div class="blob-tr"></div><div class="blob-bl"></div>
  <div class="content">

    <div class="header">
      <div><div class="greeting">${greeting}, Shahar 👋</div><div class="date-sub">${dateStr}</div></div>
      <div class="chip">${chipText}</div>
    </div>

    <div class="card">
      <div class="lbl">Readiness Score</div>
      <div class="rc-row">
        <div class="rc-circle"><div class="rc-num">${readiness.score}</div><div class="rc-unit">/100</div></div>
        <div class="rc-desc">${readiness.description}</div>
      </div>
    </div>

    <div class="card ${recovery ? 'card-warn' : ''}">
      <div class="lbl">Recovery Status</div>
      ${recovery ? `
      <div class="rec-top">
        <div><div class="rec-title">${recovery.body_part}</div><div class="trend">${trendIcon}</div></div>
        <div style="text-align:right"><div class="pain-big">${latestPainLevel ?? '—'}</div><div class="pain-sub">Pain /10</div></div>
      </div>
      <div class="pills">
        <span class="pill pill-amber">Day ${dayNumber} recovery</span>
        ${recovery.recommendation ? `<span class="pill pill-amber">${recovery.recommendation.split(' — ')[0]}</span>` : ''}
        <span class="pill">${recovery.status}</span>
      </div>` : `
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:22px">✅</span>
        <span style="font-size:13px;color:rgba(255,255,255,0.72)">No active injuries — full training load OK</span>
      </div>`}
    </div>

    <div class="card">
      <div class="lbl">Weather Today</div>
      ${weather ? `
      <div class="wx-opt">Best window: ${weather.bestWindow.start}–${weather.bestWindow.end} <span class="wx-win">${weather.bestWindow.temp}°C</span></div>
      <div class="wx-grid">
        <div class="wx-stat"><div class="wx-val">${weather.current.temp}°</div><div class="wx-lbl">Now</div></div>
        <div class="wx-stat"><div class="wx-val">${weather.peak.temp}°</div><div class="wx-lbl">Peak ${weather.peak.time}</div></div>
        <div class="wx-stat"><div class="wx-val">${weather.current.humidity}%</div><div class="wx-lbl">Humidity</div></div>
      </div>` : `<div style="font-size:13px;color:rgba(255,255,255,0.48)">Weather unavailable</div>`}
    </div>

    <div class="card">
      <div class="lbl" style="margin-bottom:4px">Today's Rehab</div>
      ${rehab ? `
      <div style="font-size:11px;color:rgba(255,255,255,0.48);margin-bottom:6px">${rehab.label}</div>
      ${rehab.strengthening.length ? `<div class="ex-sec">Strengthening</div>${exRows(rehab.strengthening)}` : ''}
      <div class="ex-sec" style="margin-top:${rehab.strengthening.length ? '10px' : '0'}">Stretching</div>
      ${exRows(rehab.stretching)}` : `<div style="font-size:13px;color:rgba(255,255,255,0.48)">No active rehab protocol</div>`}
    </div>

    <div class="card">
      <div class="lbl">Cross-Training Options</div>
      <div class="pills">${pills(crossPills)}</div>
    </div>

    <div class="card">
      <div class="lbl">Yesterday's Nutrition</div>
      ${kcal ? `
      <div class="nutr-top">
        <div><div class="kcal-big">${kcal}</div><div class="kcal-sub">kcal</div></div>
        <div class="nutr-right">
          ${nutrition.sodium_mg ? `<div class="nutr-line">Sodium <span class="nutr-val">${nutrition.sodium_mg}mg</span></div>` : ''}
          ${nutrition.sugar_g  ? `<div class="nutr-line">Sugar <span class="nutr-val">${nutrition.sugar_g}g</span></div>` : ''}
          ${nutrition.fiber_g  ? `<div class="nutr-line">Fiber <span class="nutr-val">${nutrition.fiber_g}g</span></div>` : ''}
        </div>
      </div>
      <div class="macro-bar"><div class="mp"></div><div class="mc"></div><div class="mf"></div></div>
      <div class="macro-lbls">
        <div class="mlbl">Protein <b>${protein}g</b></div>
        <div class="mlbl">Carbs <b>${carbs}g</b></div>
        <div class="mlbl">Fat <b>${fat}g</b></div>
      </div>` : `<div style="font-size:13px;color:rgba(255,255,255,0.48)">No nutrition data — check MFP diary</div>`}
    </div>

    ${garminData ? (() => {
      const sl = garminData.sleep;
      const hr = garminData.hrv;
      const bb = garminData.bodyBattery;
      const tr = garminData.training;
      const vt = garminData.vitals;
      const rc = garminData.race;

      const fmtSec = (s) => { if (!s) return '—'; const h = Math.floor(s/3600), m = Math.floor((s%3600)/60); return `${h}h ${String(m).padStart(2,'0')}m`; };
      const fmtRT = (s) => { if (!s) return '—'; const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60; return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`; };

      const hvBadge = (status) => {
        if (!status) return '';
        const cls = { balanced:'badge-green', positive:'badge-green', good:'badge-green', unbalanced:'badge-amber', poor:'badge-red', low:'badge-red' }[status?.toLowerCase()] ?? 'badge-blue';
        return `<span class="gm-badge ${cls}">${status}</span>`;
      };
      const rdBadge = (score) => {
        if (!score) return '';
        const cls = score >= 70 ? 'badge-green' : score >= 50 ? 'badge-amber' : 'badge-red';
        return `<span class="gm-badge ${cls}">${score}</span>`;
      };
      const tsBadge = (status) => {
        if (!status) return '';
        const cls = { productive:'badge-green', maintaining:'badge-blue', peaking:'badge-green', recovery:'badge-amber', overreaching:'badge-red', detraining:'badge-red' }[status?.toLowerCase()] ?? 'badge-blue';
        return `<span class="gm-badge ${cls}">${status}</span>`;
      };

      return `
    <div class="card">
      <div class="lbl">Sleep</div>
      <div class="gm-grid">
        <div class="gm-stat"><div class="gm-val">${sl?.score ?? '—'}</div><div class="gm-lbl">Sleep Score</div>${hvBadge(sl?.sleep_score_feedback)}</div>
        <div class="gm-stat"><div class="gm-val">${fmtSec(sl?.duration_seconds)}</div><div class="gm-lbl">Duration</div></div>
        <div class="gm-stat"><div class="gm-val">${fmtSec(sl?.deep_seconds)}</div><div class="gm-lbl">Deep</div></div>
        <div class="gm-stat"><div class="gm-val">${fmtSec(sl?.rem_seconds)}</div><div class="gm-lbl">REM</div></div>
      </div>
      ${sl?.avg_respiration || sl?.avg_spo2 ? `<div style="margin-top:8px;display:flex;gap:16px">
        ${sl?.avg_respiration ? `<div class="gm-stat"><div class="gm-val" style="font-size:14px">${sl.avg_respiration.toFixed(1)}</div><div class="gm-lbl">Respiration</div></div>` : ''}
        ${sl?.avg_spo2 ? `<div class="gm-stat"><div class="gm-val" style="font-size:14px">${sl.avg_spo2.toFixed(1)}%</div><div class="gm-lbl">SpO₂</div></div>` : ''}
        ${sl?.resting_hr ? `<div class="gm-stat"><div class="gm-val" style="font-size:14px">${sl.resting_hr}</div><div class="gm-lbl">RHR</div></div>` : ''}
      </div>` : ''}
    </div>

    <div class="card">
      <div class="lbl">Recovery Snapshot</div>
      <div class="gm-grid">
        <div class="gm-stat"><div class="gm-val">${hr?.last_night_ms ? `${Math.round(hr.last_night_ms)}ms` : '—'}</div><div class="gm-lbl">HRV</div>${hvBadge(hr?.hrv_status)}</div>
        <div class="gm-stat"><div class="gm-val">${bb?.morning_value != null ? `${bb.morning_value}%` : '—'}</div><div class="gm-lbl">Body Battery</div>${bb?.morning_value != null ? `<span class="gm-badge ${bb.morning_value >= 60 ? 'badge-green' : bb.morning_value >= 30 ? 'badge-amber' : 'badge-red'}">${bb.charged != null ? `+${bb.charged}` : ''} overnight</span>` : ''}</div>
        <div class="gm-stat"><div class="gm-val">${tr?.readiness_score ?? '—'}</div><div class="gm-lbl">Readiness</div>${rdBadge(tr?.readiness_score)}</div>
        <div class="gm-stat"><div class="gm-val">${vt?.skin_temp_deviation != null ? `${vt.skin_temp_deviation > 0 ? '+' : ''}${vt.skin_temp_deviation.toFixed(1)}°` : '—'}</div><div class="gm-lbl">Skin Temp Δ</div></div>
      </div>
      ${hr?.baseline_balanced_low && hr?.baseline_balanced_high ? `<div style="margin-top:6px;font-size:11px;color:rgba(255,255,255,0.38)">HRV baseline ${Math.round(hr.baseline_balanced_low)}–${Math.round(hr.baseline_balanced_high)}ms</div>` : ''}
    </div>

    <div class="card">
      <div class="lbl">Training Status</div>
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div><div style="font-size:14px;font-weight:600;color:rgba(255,255,255,0.85)">${tr?.training_status ?? '—'}</div>${tsBadge(tr?.training_status)}</div>
        ${tr?.vo2max ? `<div class="gm-stat" style="text-align:right"><div class="gm-val">${tr.vo2max.toFixed(1)}</div><div class="gm-lbl">VO₂ Max</div></div>` : ''}
      </div>
      <div class="gm-row"><span class="gm-key">Training Load</span><span class="gm-v">${tr?.training_load ? `${Math.round(tr.training_load)} (${tr.training_load_status ?? ''})` : '—'}</span></div>
      <div class="gm-row"><span class="gm-key">Recovery Time</span><span class="gm-v">${tr?.recovery_time_hours ? `${Math.round(tr.recovery_time_hours)}h remaining` : '—'}</span></div>
      ${tr?.fitness_age ? `<div class="gm-row"><span class="gm-key">Fitness Age</span><span class="gm-v">${tr.fitness_age}</span></div>` : ''}
    </div>

    ${rc?.time_5k_secs || rc?.time_10k_secs ? `<div class="card">
      <div class="lbl">Race Predictions</div>
      <div class="race-grid">
        ${rc.time_5k_secs   ? `<div class="race-item"><div class="race-dist">5K</div><div class="race-time">${fmtRT(rc.time_5k_secs)}</div></div>` : ''}
        ${rc.time_10k_secs  ? `<div class="race-item"><div class="race-dist">10K</div><div class="race-time">${fmtRT(rc.time_10k_secs)}</div></div>` : ''}
        ${rc.time_half_secs ? `<div class="race-item"><div class="race-dist">Half</div><div class="race-time">${fmtRT(rc.time_half_secs)}</div></div>` : ''}
        ${rc.time_full_secs ? `<div class="race-item"><div class="race-dist">Full</div><div class="race-time">${fmtRT(rc.time_full_secs)}</div></div>` : ''}
      </div>
    </div>` : ''}`;
    })() : `
    <div class="card">
      <div class="lbl">Sleep &amp; Recovery</div>
      <div class="sleep-row">
        <div class="sleep-icon">⌚</div>
        <div><div class="sleep-txt">Garmin syncing...</div><div class="sleep-sub">HRV · sleep stages · recovery score coming soon</div></div>
      </div>
    </div>`}

    <div class="card">
      <div class="lbl">Tomorrow's Outlook</div>
      ${weather?.tomorrow ? `
      <div class="tmrw-top">${weather.tomorrow.isHot ? '🌡️ ' : ''}${weather.tomorrow.description ?? 'Forecast available'}${weather.tomorrow.peak ? ` · Peak ${weather.tomorrow.peak}°C` : ''}</div>
      <div class="pills">
        ${weather.tomorrow.isHot ? '<span class="pill pill-amber">Heat warning</span>' : ''}
        ${weather.tomorrow.description ? `<span class="pill">${weather.tomorrow.description}</span>` : ''}
        ${weather.tomorrow.peak ? `<span class="pill">${weather.tomorrow.peak}°C tomorrow</span>` : ''}
      </div>` : `<div style="font-size:13px;color:rgba(255,255,255,0.48)">Forecast unavailable</div>`}
    </div>

    <div class="card">
      <div class="lbl">Hydration Goal</div>
      <div class="hyd-big">${hydration.toFixed(1)}L</div>
      <div class="hyd-sub">${hydration > 2.5 ? 'Base 2.5L + 1L for planned run' : 'Base daily target — no run planned'}</div>
    </div>

    <div class="footer">
      <div class="si"><div class="dot dot-green"></div>Strava</div>
      <div class="si"><div class="dot dot-green"></div>OpenWeather</div>
      <div class="si"><div class="dot ${mfpStatus}"></div>MFP</div>
      <div class="si"><div class="dot ${garminData ? 'dot-green' : 'dot-amber'}"></div>Garmin</div>
      <div class="si"><div class="dot dot-green"></div>Telegram</div>
    </div>

  </div>
</div></body></html>`;
}

async function generateBriefingImage() {
  const data = await getBriefingData();
  const html = buildBriefingHTML(data);

  let browser;
  try {
    if (process.platform === 'linux') {
      const chromium = require('@sparticuz/chromium');
      const puppeteerCore = require('puppeteer-core');
      browser = await puppeteerCore.launch({
        args: chromium.args,
        defaultViewport: { width: 520, height: 1400, deviceScaleFactor: 2 },
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });
    } else {
      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        defaultViewport: { width: 520, height: 1400, deviceScaleFactor: 2 },
      });
    }
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const buffer = await page.screenshot({ type: 'png', fullPage: true });
    console.log('[briefing] Screenshot taken, buffer size:', buffer.length);
    return buffer;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function sendTelegramPhoto(chatId, imageBuffer, caption) {
  const boundary = `----FormBoundary${Date.now().toString(16)}`;
  let head = '';
  head += `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;
  if (caption) head += `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`;
  head += `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="briefing.png"\r\nContent-Type: image/png\r\n\r\n`;

  const body = Buffer.concat([
    Buffer.from(head, 'utf8'),
    imageBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);

  const r = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPhoto`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    }
  );
  if (!r.ok) {
    const text = await r.text();
    console.error('[telegram] sendPhoto HTTP', r.status, text);
    throw new Error(`sendPhoto HTTP ${r.status}`);
  }
}

async function generateMorningBriefing() {
  const [forecast, recoverySession] = await Promise.all([getWeatherForecast(), getActiveRecoverySession()]);
  const { sunrise, sunset } = calculateSunriseSunset();
  const fmt = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
  const todayStr = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const inNoRunPhase = recoverySession?.status === 'active';

  const system = inNoRunPhase
    ? 'You are an expert coach. The athlete is in a strict NO-RUN recovery phase. Do NOT mention running at all. Suggest the best time for alternative training (swimming, cycling, walking, strength) based on the weather. Use metric units. No markdown.'
    : 'You are an expert endurance coach sending a concise daily morning briefing. Use metric units. No markdown, just clean text with line breaks.';

  const userContent = inNoRunPhase
    ? `Today is ${todayStr}.
Location: ${process.env.RUNNER_LOCATION}

Weather forecast (next 48h):
${forecast}

Sunrise: ${fmt(sunrise)}, Sunset: ${fmt(sunset)}

The athlete is in a no-run recovery phase. Give a brief morning briefing for alternative activities only. Include:
1. One-line weather summary for today
2. Best 1-2 hour window for outdoor alternatives (cycling, walking) — or indoor options (pool, gym) if weather is poor
3. Any heat/wind warnings relevant to outdoor alternatives

Keep it under 120 words. Start with today's date. Do NOT mention running.`
    : `Today is ${todayStr}.
Location: ${process.env.RUNNER_LOCATION}

Weather forecast (next 48h):
${forecast}

Sunrise: ${fmt(sunrise)}, Sunset: ${fmt(sunset)}

Generate a morning briefing. Include:
1. One-line weather summary for today
2. Best 1-2 hour window to run today (based on temperature, wind, rain, and daylight)
3. Any heat/rain/wind warnings if relevant

Keep it under 150 words. Start with today's date.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    system,
    messages: [{ role: 'user', content: userContent }],
  });

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const nutrition = await storeDailyNutrition(yesterday);
  let nutritionLine = '';
  if (nutrition?.calories) {
    const parts = [`${nutrition.calories} kcal`, `${nutrition.protein_g ?? 0}g protein`, `${nutrition.carbs_g ?? 0}g carbs`, `${nutrition.fat_g ?? 0}g fat`];
    if (nutrition.sodium_mg) parts.push(`${nutrition.sodium_mg}mg sodium`);
    if (nutrition.sugar_g) parts.push(`${nutrition.sugar_g}g sugar`);
    if (nutrition.fiber_g) parts.push(`${nutrition.fiber_g}g fiber`);
    nutritionLine = `\n\nYesterday: ${parts.join(' · ')}`;
  }

  let planLine = '';
  if (!inNoRunPhase) {
    planLine = '\n\n📋 Coach plan today: Rest day or check TrainingPeaks manually';
    const plan = await getTodayPlan();
    if (plan?.workout_type) {
      const parts = [plan.workout_type];
      if (plan.duration_min) parts.push(`${plan.duration_min} min`);
      if (plan.distance_km)  parts.push(`${plan.distance_km} km`);
      if (plan.coach_notes)  parts.push(plan.coach_notes);
      planLine = `\n\n📋 Coach plan today: ${parts.join(' · ')}`;
    }
  }

  let recoveryLine = '';
  if (recoverySession) {
    recoveryLine = `\n\n${await getRecoveryBriefing(recoverySession)}`;
    if (inNoRunPhase) {
      const rehab = await getRehabProgram(recoverySession);
      if (rehab) recoveryLine += rehab;
    }
  } else {
    const activePain = await getActivePainSummary();
    if (activePain) recoveryLine = `\n\n⚠️ Active pain: ${activePain} — monitor today`;
  }

  const garminData = await garmin.getLatestGarminData(yesterday).catch(() => null);
  let garminLine = '';
  if (garminData?.hrv || garminData?.bodyBattery || garminData?.sleep) {
    const gParts = [];
    if (garminData.hrv?.last_night_ms) gParts.push(`💓 HRV: ${Math.round(garminData.hrv.last_night_ms)}ms (${garminData.hrv.hrv_status ?? '—'})`);
    if (garminData.bodyBattery?.morning_value != null) gParts.push(`🔋 Battery: ${garminData.bodyBattery.morning_value}%`);
    if (garminData.sleep?.duration_seconds) {
      const h = Math.floor(garminData.sleep.duration_seconds / 3600);
      const m = Math.floor((garminData.sleep.duration_seconds % 3600) / 60);
      gParts.push(`😴 Sleep: ${h}h${m > 0 ? `${m}m` : ''}${garminData.sleep.score ? ` score ${garminData.sleep.score}` : ''}`);
    }
    if (gParts.length) garminLine = `\n\n${gParts.join(' · ')}`;
  } else {
    garminLine = '\n\n— Garmin recovery coming soon';
  }
  return `🌅 Morning Briefing\n\n${response.content[0].text}${nutritionLine}${planLine}${recoveryLine}${garminLine}`;
}

function getEffortMultiplier(paceSecPerKm) {
  const m = paceSecPerKm / 60;
  if (m < 4.5) return 2.0;
  if (m < 5.0) return 1.7;
  if (m < 5.5) return 1.4;
  if (m < 6.0) return 1.1;
  return 0.7;
}

function scoreRun(a) {
  const raw = a.raw ?? {};
  const distKm   = (a.distance_m ?? 0) / 1000;
  const avgSpeed = raw.average_speed ?? 0;   // m/s
  const avgHR    = raw.average_heartrate;
  const avgWatts = raw.device_watts ? raw.average_watts : null;

  if (distKm === 0 || avgSpeed === 0) return null;

  const paceSecPerKm = 1000 / avgSpeed;
  const mult = getEffortMultiplier(paceSecPerKm);

  const effortIntensity = avgSpeed * avgSpeed * mult;
  const hrEfficiency    = avgHR ? (avgSpeed / avgHR) * distKm : 0;
  const powerOutput     = avgWatts && avgHR ? (avgWatts / avgHR) * distKm : null;
  const distBonus       = Math.log(Math.max(distKm, 1)) * mult;

  const score = powerOutput !== null
    ? effortIntensity * 0.35 + (hrEfficiency * 15) * 0.35 + powerOutput * 0.20 + distBonus * 0.10
    : effortIntensity * 0.45 + (hrEfficiency * 15) * 0.45 + distBonus * 0.10;

  return { score, distKm, paceSecPerKm, effortIntensity, hrEfficiency, powerOutput, distBonus, hasPower: powerOutput !== null, avgHR, avgSpeed };
}

function bestRunOfWeek(activities) {
  const runs = activities.filter(a => (a.raw?.sport_type ?? a.type) === 'Run');
  if (!runs.length) return null;

  const scored = runs.map(a => ({ a, s: scoreRun(a) })).filter(x => x.s !== null);
  if (!scored.length) return { a: runs[0], s: null };

  scored.sort((x, y) => y.s.score - x.s.score);
  // If top two within 2%, pick the longer one
  if (scored.length > 1 && Math.abs(scored[0].s.score - scored[1].s.score) / scored[0].s.score < 0.02) {
    return scored[0].s.distKm >= scored[1].s.distKm ? scored[0] : scored[1];
  }
  return scored[0];
}

function parseHevyDescription(desc) {
  const lines = desc.split('\n').map(l => l.trim()).filter(Boolean);
  const exercises = [];
  let current = null;
  let sets = [];

  for (const line of lines) {
    if (line === 'Logged with Hevy') continue;
    if (/^Set \d+:/i.test(line)) {
      // e.g. "Set 1: 9 reps" or "Set 1: 9 reps @ 80 kg"
      const match = line.match(/Set \d+:\s*(\d+)\s*reps?(?:\s*@\s*([\d.]+)\s*kg)?/i);
      if (match) sets.push(match[2] ? `${match[1]}×${match[2]}kg` : match[1]);
    } else {
      // New exercise name
      if (current) exercises.push(formatExercise(current, sets));
      current = line;
      sets = [];
    }
  }
  if (current) exercises.push(formatExercise(current, sets));
  return exercises;
}

function formatExercise(name, sets) {
  if (!sets.length) return name;
  // Group identical sets: e.g. "3×80kg" or mixed "9/7/8/7 reps"
  const allHaveWeight = sets.every(s => s.includes('kg'));
  if (allHaveWeight) {
    // Show as "Bench Press: 4 sets · 9×80kg / 7×80kg"
    return `${name}: ${sets.length} sets · ${sets.join(' / ')}`;
  }
  // Body weight — show reps only
  return `${name}: ${sets.length} sets · ${sets.join('/')} reps`;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseHevyDate(dateStr) {
  if (!dateStr) return null;
  const m = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4}),\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const MON = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
  const mo = MON[m[2]];
  if (mo === undefined) return null;
  return new Date(Date.UTC(parseInt(m[3]), mo, parseInt(m[1]), parseInt(m[4]) - 3, parseInt(m[5])));
}

function parseHevyCSV(csvText) {
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const header = parseCSVLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const cols = parseCSVLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = (cols[i] ?? '').trim(); });
    return row;
  });
}

function groupHevyWorkouts(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.title}|${row.start_time}`;
    if (!map.has(key)) {
      const start = parseHevyDate(row.start_time);
      map.set(key, {
        title: row.title,
        start_time: start?.toISOString() ?? null,
        end_time: parseHevyDate(row.end_time)?.toISOString() ?? null,
        workout_date: start?.toISOString().slice(0, 10) ?? null,
        exMap: new Map(),
      });
    }
    const w = map.get(key);
    const ex = row.exercise_title;
    if (!ex) continue;
    if (!w.exMap.has(ex)) w.exMap.set(ex, []);
    w.exMap.get(ex).push({
      set: parseInt(row.set_index) + 1,
      type: row.set_type || 'normal',
      reps: row.reps ? parseInt(row.reps) : null,
      weight_kg: row.weight_kg ? parseFloat(row.weight_kg) : null,
      duration_s: row.duration_seconds ? parseInt(row.duration_seconds) : null,
      distance_km: row.distance_km ? parseFloat(row.distance_km) : null,
    });
  }
  return Array.from(map.values()).map(w => ({
    title: w.title,
    start_time: w.start_time,
    end_time: w.end_time,
    workout_date: w.workout_date,
    exercises: Array.from(w.exMap.entries()).map(([name, sets]) => ({ name, sets })),
  }));
}

function formatHevyExercise(ex) {
  const sets = ex.sets ?? [];
  if (!sets.length) return ex.name;
  const allWeighted = sets.every(s => s.weight_kg);
  if (allWeighted) {
    return `${ex.name}: ${sets.length} sets · ${sets.map(s => `${s.reps}×${s.weight_kg}kg`).join(' / ')}`;
  }
  return `${ex.name}: ${sets.length} sets · ${sets.map(s => s.reps ?? '?').join('/')} reps`;
}

async function getHevyWorkoutsForRange(from) {
  const { data } = await supabase.from('hevy_workouts').select('*').gte('workout_date', from.toISOString().slice(0, 10));
  return data ?? [];
}

async function generateWeeklyReport() {
  const now = new Date();
  const weekStart   = new Date(now - 7  * 86400000);
  const w1Start     = new Date(now - 14 * 86400000);
  const w2Start     = new Date(now - 21 * 86400000);
  const w3Start     = new Date(now - 28 * 86400000);
  const w4Start     = new Date(now - 35 * 86400000);

  const fetchActs = async (from, to) => {
    let q = supabase.from('activities').select('type, distance_m, moving_time_s, started_at, raw').gte('started_at', from.toISOString());
    if (to) q = q.lt('started_at', to.toISOString());
    const { data } = await q;
    return data ?? [];
  };

  const [thisWeek, week1, week2, week3, week4, hevyWorkouts] = await Promise.all([
    fetchActs(weekStart),
    fetchActs(w1Start, weekStart),
    fetchActs(w2Start, w1Start),
    fetchActs(w3Start, w2Start),
    fetchActs(w4Start, w3Start),
    getHevyWorkoutsForRange(weekStart),
  ]);

  const hevyByDate = {};
  for (const h of hevyWorkouts) {
    hevyByDate[h.workout_date] = hevyByDate[h.workout_date] ?? [];
    hevyByDate[h.workout_date].push(h);
  }

  const fmtTime = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h > 0 ? `${h}h ${m}m` : `${m}m`; };
  const fmtPace = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  const avgOfArr = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b) / arr.length) : null;

  // ── Totals ──
  const totalSec = thisWeek.reduce((s, a) => s + (a.moving_time_s ?? 0), 0);
  const totalCal = thisWeek.reduce((s, a) => s + (a.raw?.calories ?? 0), 0);

  // ── Per activity type ──
  const byType = {};
  for (const a of thisWeek) {
    const t = a.raw?.sport_type ?? a.type ?? 'Unknown';
    if (!byType[t]) byType[t] = [];
    byType[t].push(a);
  }

  // ── Easy run HR trend ──
  const isEasyRun = (a) => (a.raw?.sport_type ?? a.type) === 'Run' && a.raw?.average_heartrate && a.raw.average_heartrate < 155;
  const easyHRAvg = (acts) => avgOfArr(acts.filter(isEasyRun).map(a => a.raw.average_heartrate).filter(Boolean));
  const thisAvgHR  = easyHRAvg(thisWeek);
  const lastAvgHR  = easyHRAvg(week1);
  const prev2AvgHR = easyHRAvg(week2);
  const easyThis   = thisWeek.filter(isEasyRun);
  const lowestHR   = easyThis.length ? Math.round(Math.min(...easyThis.map(a => a.raw.average_heartrate))) : null;
  const highestHR  = easyThis.length ? Math.round(Math.max(...easyThis.map(a => a.raw?.max_heartrate ?? 0).filter(Boolean))) : null;

  // ── Best run scoring ──
  const best = bestRunOfWeek(thisWeek);
  const pastBests = [week1, week2, week3, week4].map(w => bestRunOfWeek(w)).filter(x => x?.s);
  const thisScore = best?.s?.score ?? 0;
  const isBestInMonth = pastBests.length > 0 && pastBests.every(x => thisScore > x.s.score);

  // ── Build report ──
  const lines = [];
  const weekLabel = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Jerusalem' });
  lines.push(`📊 Weekly Report — w/e ${weekLabel}`);
  lines.push(`⏱ Total active time: ${fmtTime(totalSec)} | 🔥 ${totalCal} kcal`);
  lines.push('');

  const typeLabel = { Run: '🏃 Runs', Ride: '🚴 Rides', Swim: '🏊 Swims', Walk: '🚶 Walks', Hike: '🥾 Hikes', WeightTraining: 'Strength Training 🏋️', Tennis: '🎾 Tennis', Yoga: '🧘 Yoga', Workout: '💪 Workout' };

  for (const [type, acts] of Object.entries(byType).sort()) {
    const label  = typeLabel[type] ?? `🏅 ${type}`;
    const sec    = acts.reduce((s, a) => s + (a.moving_time_s ?? 0), 0);
    const cal    = acts.reduce((s, a) => s + (a.raw?.calories ?? 0), 0);
    const hrActs = acts.filter(a => a.raw?.has_heartrate && a.raw?.average_heartrate);
    const avgHR  = avgOfArr(hrActs.map(a => a.raw.average_heartrate));
    lines.push(`${label}: ${acts.length}x | ${fmtTime(sec)}${cal > 0 ? ` | ${cal} kcal` : ''}${avgHR ? ` | avg HR ${avgHR} bpm` : ''}`);

    // For strength sessions, show per-session exercise breakdown from hevy_workouts (or fall back to Strava description)
    if (type === 'WeightTraining') {
      for (const a of acts) {
        const date = new Date(a.started_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        const actDate = new Date(a.started_at).toISOString().slice(0, 10);
        const sessionName = a.raw?.name ?? 'Strength session';
        lines.push(`  ${date} · ${sessionName}`);
        const hevyForDay = hevyByDate[actDate] ?? [];
        const hevyMatch = hevyForDay.find(h => h.workout_title === sessionName) ?? hevyForDay[0];
        if (hevyMatch?.exercises?.length) {
          for (const ex of hevyMatch.exercises) lines.push(`  └ ${formatHevyExercise(ex)}`);
        } else {
          const desc = a.raw?.description ?? '';
          if (desc.includes('Logged with Hevy')) {
            for (const ex of parseHevyDescription(desc)) lines.push(`  └ ${ex}`);
          }
        }
      }
    }
  }

  // ── Best run ──
  lines.push('');
  if (best) {
    const br = best.a, bs = best.s;
    const date = new Date(br.started_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Jerusalem' });
    if (bs) {
      lines.push(`⭐ Best run: ${date} · ${bs.distKm.toFixed(1)}km · ${fmtPace(bs.paceSecPerKm)}/km · HR ${bs.avgHR ?? '—'}bpm · Score ${bs.score.toFixed(1)}`);

      // Compare to past 4 weeks
      const comparisons = pastBests.map((x, i) => {
        const diff = bs.score - x.s.score;
        return `${diff > 0 ? '+' : ''}${diff.toFixed(1)} vs ${i + 1}w ago`;
      });
      if (comparisons.length) lines.push(`   ↳ ${comparisons.join(' | ')}`);
      if (isBestInMonth) lines.push(`   🏆 Best performance score in the past month`);
    } else {
      const date2 = new Date(br.started_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Jerusalem' });
      lines.push(`⭐ Best run: ${date2} · ${((br.distance_m ?? 0) / 1000).toFixed(1)}km`);
    }
  } else {
    lines.push(`⭐ No runs recorded this week`);
  }

  // ── PRs (fully independent of score) ──
  const runsWithPRs = thisWeek.filter(a => (a.raw?.sport_type ?? a.type) === 'Run' && (a.raw?.pr_count ?? 0) > 0);
  if (runsWithPRs.length) {
    lines.push('');
    lines.push(`🎯 PRs this week:`);
    for (const r of runsWithPRs) {
      const d = new Date(r.started_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Jerusalem' });
      const km = ((r.distance_m ?? 0) / 1000).toFixed(1);
      const pace = r.raw?.average_speed ? fmtPace(1000 / r.raw.average_speed) : '—';
      lines.push(`   ${r.raw?.pr_count} PR${r.raw.pr_count > 1 ? 's' : ''} — ${r.raw?.name ?? 'Run'} on ${d} (${km}km, ${pace}/km)`);
    }
  }

  // ── Easy run HR ──
  lines.push('');
  lines.push('💓 Easy run HR:');
  if (thisAvgHR && easyThis.length) {
    lines.push(`${easyThis.length} run${easyThis.length > 1 ? 's' : ''} · avg ${thisAvgHR} · low ${lowestHR} · high ${highestHR} bpm`);
    const trendParts = [];
    if (lastAvgHR)  trendParts.push(`${thisAvgHR - lastAvgHR > 0 ? '+' : ''}${thisAvgHR - lastAvgHR} bpm vs last week`);
    if (prev2AvgHR) trendParts.push(`${thisAvgHR - prev2AvgHR > 0 ? '+' : ''}${thisAvgHR - prev2AvgHR} bpm vs 2 weeks ago`);
    if (trendParts.length) lines.push(`📈 ${trendParts.join(' | ')}`);
    if (lastAvgHR) {
      const diff = thisAvgHR - lastAvgHR;
      if (diff < -2)     lines.push(`✅ HR trending down — fitness improving`);
      else if (diff > 3) lines.push(`⚠️ HR trending up — monitor sleep & recovery`);
      else               lines.push(`➡️ HR stable week over week`);
    }
  } else {
    lines.push('No easy runs this week');
  }

  // ── Weekly nutrition from MFP ──
  const nutritionRows = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
    const row = await getStoredNutrition(d);
    if (row?.calories) nutritionRows.push(row);
  }
  if (nutritionRows.length) {
    const avg = (key) => Math.round(nutritionRows.reduce((s, r) => s + (r[key] ?? 0), 0) / nutritionRows.length);
    lines.push('');
    lines.push(`🍽 Nutrition (${nutritionRows.length}-day avg): ${avg('calories')} kcal · ${avg('protein_g')}g protein · ${avg('carbs_g')}g carbs · ${avg('fat_g')}g fat · ${avg('sodium_mg')}mg sodium · ${avg('sugar_g')}g sugar · ${avg('fiber_g')}g fiber`);
  }

  // ── Garmin weekly summary ──
  try {
    const gWeek = await garmin.getGarminWeekSummary();
    if (gWeek) {
      lines.push('');
      lines.push('⌚ Garmin (7-day):');
      if (gWeek.avg_sleep_duration || gWeek.avg_sleep_score) {
        const durStr = gWeek.avg_sleep_duration ? (() => { const h = Math.floor(gWeek.avg_sleep_duration/3600), m = Math.floor((gWeek.avg_sleep_duration%3600)/60); return `${h}h${m > 0 ? `${m}m` : ''}`; })() : null;
        lines.push(`  😴 Sleep: avg ${durStr ?? '—'} · score ${gWeek.avg_sleep_score ?? '—'} · poor nights: ${gWeek.poor_sleep_nights ?? 0}`);
      }
      if (gWeek.avg_hrv) lines.push(`  💓 HRV: avg ${Math.round(gWeek.avg_hrv)}ms · trend ${gWeek.hrv_trend ?? '→'}`);
      if (gWeek.lowest_body_battery != null) lines.push(`  🔋 Body battery: lowest ${gWeek.lowest_body_battery}%${gWeek.lowest_battery_day ? ` on ${gWeek.lowest_battery_day}` : ''}`);
      if (gWeek.avg_rhr) lines.push(`  ❤️ RHR: avg ${Math.round(gWeek.avg_rhr)} bpm${gWeek.rhr_delta != null ? ` (${gWeek.rhr_delta > 0 ? '+' : ''}${Math.round(gWeek.rhr_delta)} vs last week)` : ''}`);
      if (gWeek.avg_vo2max) lines.push(`  📈 VO₂ Max: ${gWeek.avg_vo2max.toFixed(1)}${gWeek.vo2max_delta != null ? ` (${gWeek.vo2max_delta >= 0 ? '+' : ''}${gWeek.vo2max_delta.toFixed(1)} vs last week)` : ''}`);
      if (gWeek.training_status) lines.push(`  🏋️ Training: ${gWeek.training_status}`);
      if (gWeek.total_steps) lines.push(`  👟 Steps: ${gWeek.total_steps.toLocaleString()} · intensity ${gWeek.total_intensity_mins ?? 0}min / 150min WHO target`);
      if (gWeek.primary_shoe) lines.push(`  👟 ${gWeek.primary_shoe.name}: ${Math.round((gWeek.primary_shoe.distance_m ?? 0) / 1000)}km${(gWeek.primary_shoe.distance_m ?? 0) > 600000 ? ' ⚠️ approaching 700km' : ''}`);
      if (gWeek.race_5k || gWeek.race_10k) lines.push(`  🏁 Race predictions: ${gWeek.race_5k ? `5K ${gWeek.race_5k}` : ''} ${gWeek.race_10k ? `· 10K ${gWeek.race_10k}` : ''}`);
    }
  } catch (gErr) {
    console.error('[weekly] Garmin section error:', gErr.message);
  }

  lines.push('');
  lines.push('📋 TrainingPeaks: coming soon');

  return lines.join('\n');
}

async function sendMorningPainCheck() {
  await setBotState('conversation', { step: 'morning_pain_check' });
  await sendTelegram(process.env.TELEGRAM_OWNER_CHAT_ID,
    `Good morning Shahar 🌅\n\nHow is the soleus today?\n\nReply with a number 1 to 10\n(1 = no pain, 10 = severe pain)`
  );
}

async function checkPainTrend() {
  const sevenDaysAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const { data } = await supabase.from('pain_log')
    .select('date, pain_level')
    .ilike('body_part', '%soleus%')
    .eq('check_type', 'morning')
    .gte('date', sevenDaysAgo)
    .order('date', { ascending: true });
  if (!data || data.length < 2) return;

  // 5-day consecutive decrease
  if (data.length >= 5) {
    const last5 = data.slice(-5);
    if (last5.every((r, i) => i === 0 || r.pain_level < last5[i - 1].pain_level)) {
      await sendTelegram(process.env.TELEGRAM_OWNER_CHAT_ID,
        '💪 Strong recovery trend — your body is responding to the program. Keep going.'
      );
      return;
    }
  }

  // 2 consecutive days increasing
  if (data.length >= 3) {
    const last3 = data.slice(-3);
    if (last3[2].pain_level > last3[1].pain_level && last3[1].pain_level > last3[0].pain_level) {
      await sendTelegram(process.env.TELEGRAM_OWNER_CHAT_ID,
        '⚠️ Pain trending up — back off all strengthening for 48 hours and message your physio.'
      );
    }
  }
}

async function checkHighPainStreak() {
  const threeDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const { data } = await supabase.from('pain_log')
    .select('date, pain_level')
    .ilike('body_part', '%soleus%')
    .eq('check_type', 'morning')
    .gte('date', threeDaysAgo)
    .order('date', { ascending: true });
  if (!data || data.length < 3) return;
  if (data.slice(-3).every(r => r.pain_level > 7)) {
    await sendTelegram(process.env.TELEGRAM_OWNER_CHAT_ID,
      '🚨 Pain above 7/10 for 3 days in a row. Please contact your physio.'
    );
  }
}

// MFP nightly scrape at 11:30pm Israel time — captures full day before bed
cron.schedule('30 23 * * *', async () => {
  const today = new Date().toISOString().slice(0, 10);
  console.log('[mfp] Nightly scrape for', today);
  await runMFPScrapeWithRetry(today);
}, { timezone: 'Asia/Jerusalem' });

// Weekly report every Saturday at 9:00pm Israel time
cron.schedule('0 21 * * 6', async () => {
  console.log('[weekly] Sending weekly report');
  try {
    const message = await generateWeeklyReport();
    await sendTelegram(process.env.TELEGRAM_OWNER_CHAT_ID, message);
    console.log('[weekly] Sent successfully');
  } catch (err) {
    console.error('[weekly] Error:', err.message);
  }
}, { timezone: 'Asia/Jerusalem' });

// Fetch TrainingPeaks email at 6:00am so it's ready for the 7am briefing
cron.schedule('0 6 * * *', async () => {
  console.log('[tp] Fetching daily TrainingPeaks plan');
  await fetchAndStoreTodayPlan();
}, { timezone: 'Asia/Jerusalem' });

// Overtraining check every Monday at 8:00am Israel time
cron.schedule('0 8 * * 1', async () => {
  console.log('[overtraining] Running Monday check');
  try {
    const message = await checkOvertraining();
    if (message) await sendTelegram(process.env.TELEGRAM_OWNER_CHAT_ID, message);
    console.log('[overtraining] Done');
  } catch (err) {
    console.error('[overtraining] Error:', err.message);
  }
}, { timezone: 'Asia/Jerusalem' });

// Daily Garmin sync at 6:30am Israel time — yesterday's data
cron.schedule('30 6 * * *', async () => {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  console.log('[garmin-cron] Syncing', yesterday);
  try {
    const data = await garmin.syncGarminDay(yesterday);
    const alerts = await garmin.runSmartAlerts(data);
    for (const alert of alerts) {
      await sendTelegram(process.env.TELEGRAM_OWNER_CHAT_ID, alert).catch(() => {});
    }
    console.log('[garmin-cron] Done, alerts sent:', alerts.length);
  } catch (err) {
    console.error('[garmin-cron] Error:', err.message);
  }
}, { timezone: 'Asia/Jerusalem' });

// Daily briefing at 7:00am Israel time
cron.schedule('0 7 * * *', async () => {
  console.log('[briefing] Sending morning briefing');
  try {
    const recovery = await getActiveRecoverySession();
    if (recovery?.status === 'active') await sendMorningPainCheck();
    const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'Asia/Jerusalem' });
    try {
      const imageBuffer = await generateBriefingImage();
      await sendTelegramPhoto(process.env.TELEGRAM_OWNER_CHAT_ID, imageBuffer, `🌅 Your briefing for ${today} · tap for details`);
      console.log('[briefing] Image sent successfully');
    } catch (imgErr) {
      console.error('[briefing] Image generation failed, falling back to text:', imgErr.message, imgErr.stack);
      const message = await generateMorningBriefing();
      await sendTelegram(process.env.TELEGRAM_OWNER_CHAT_ID, message);
      console.log('[briefing] Text fallback sent');
    }
  } catch (err) {
    console.error('[briefing] Error:', err.message);
  }
}, { timezone: 'Asia/Jerusalem' });

// Evening soleus check-in at 9:00pm every day during recovery
cron.schedule('0 21 * * *', async () => {
  try {
    const recovery = await getActiveRecoverySession();
    if (recovery?.status === 'active') {
      await setBotState('conversation', { step: 'evening_pain_check' });
      await sendTelegram(process.env.TELEGRAM_OWNER_CHAT_ID,
        `🌙 Evening check-in\n\nHow does the soleus feel after today?\nReply with a number 1 to 10`
      );
      console.log('[evening_check] Sent');
    }
  } catch (err) {
    console.error('[evening_check] Error:', err.message);
  }
}, { timezone: 'Asia/Jerusalem' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
