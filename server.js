'use strict';

require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');

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
    const message = await generateMorningBriefing();
    await sendTelegram(process.env.TELEGRAM_OWNER_CHAT_ID, message);
    console.log('[briefing] Manual trigger sent');
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

  getCoachingResponse(msg.text)
    .then((reply) => sendTelegram(chatId, reply))
    .catch((err) => console.error('[telegram] Handler error:', err.message));
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
  const url = `https://www.myfitnesspal.com/food/diary/zivshahar01?date=${dateStr}`;
  const { data: html } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 10000,
  });

  const $ = cheerio.load(html);

  // MFP totals row is in the bottom of the diary table
  const totalsRow = $('tr.total').last();
  const cols = totalsRow.find('td').map((_, el) => $(el).text().trim().replace(/,/g, '')).get();

  // Column order: Calories, Carbs, Fat, Protein, Sodium, Sugar (may vary)
  // Find the header row to map columns correctly
  const headers = $('thead tr th').map((_, el) => $(el).text().trim().toLowerCase()).get();

  const getValue = (name) => {
    const idx = headers.findIndex(h => h.includes(name));
    return idx >= 0 && cols[idx] ? parseInt(cols[idx]) || null : null;
  };

  const calories = getValue('calories') ?? (cols[1] ? parseInt(cols[1]) : null);
  const carbs    = getValue('carb');
  const fat      = getValue('fat');
  const protein  = getValue('protein');
  const fiber    = getValue('fiber');
  const sugar    = getValue('sugar');

  return { calories, protein_g: protein, carbs_g: carbs, fat_g: fat, fiber_g: fiber, sugar_g: sugar, raw: { url, date: dateStr } };
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

async function generateMorningBriefing() {
  const forecast = await getWeatherForecast();
  const { sunrise, sunset } = calculateSunriseSunset();
  const fmt = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    system: 'You are an expert endurance coach sending a concise daily morning briefing. Use metric units. No markdown, just clean text with line breaks.',
    messages: [{
      role: 'user',
      content: `Today is ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.
Location: ${process.env.RUNNER_LOCATION}

Weather forecast (next 48h):
${forecast}

Sunrise: ${fmt(sunrise)}, Sunset: ${fmt(sunset)}

Generate a morning briefing. Include:
1. One-line weather summary for today
2. Best 1-2 hour window to run today (based on temperature, wind, rain, and daylight)
3. Any heat/rain/wind warnings if relevant

Keep it under 150 words. Start with today's date.`,
    }],
  });

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const nutrition = await storeDailyNutrition(yesterday);
  let nutritionLine = '';
  if (nutrition?.calories) {
    nutritionLine = `\n\n🍽 Yesterday's nutrition: ${nutrition.calories} kcal · P ${nutrition.protein_g}g · C ${nutrition.carbs_g}g · F ${nutrition.fat_g}g`;
  }

  const plan = await getTodayPlan();
  let planLine = '\n\n📋 Coach plan today: Rest day or check TrainingPeaks manually';
  if (plan?.workout_type) {
    const parts = [plan.workout_type];
    if (plan.duration_min) parts.push(`${plan.duration_min} min`);
    if (plan.distance_km)  parts.push(`${plan.distance_km} km`);
    if (plan.coach_notes)  parts.push(plan.coach_notes);
    planLine = `\n\n📋 Coach plan today: ${parts.join(' · ')}`;
  }

  return `🌅 Morning Briefing\n\n${response.content[0].text}${nutritionLine}${planLine}\n\n— Garmin recovery coming soon`;
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

  const [thisWeek, week1, week2, week3, week4] = await Promise.all([
    fetchActs(weekStart),
    fetchActs(w1Start, weekStart),
    fetchActs(w2Start, w1Start),
    fetchActs(w3Start, w2Start),
    fetchActs(w4Start, w3Start),
  ]);

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

  const typeEmoji = { Run: '🏃', Ride: '🚴', Swim: '🏊', Walk: '🚶', Hike: '🥾', WeightTraining: '🏋️', Tennis: '🎾', Yoga: '🧘', Workout: '💪' };
  for (const [type, acts] of Object.entries(byType).sort()) {
    const emoji  = typeEmoji[type] ?? '🏅';
    const sec    = acts.reduce((s, a) => s + (a.moving_time_s ?? 0), 0);
    const cal    = acts.reduce((s, a) => s + (a.raw?.calories ?? 0), 0);
    const hrActs = acts.filter(a => a.raw?.has_heartrate && a.raw?.average_heartrate);
    const avgHR  = avgOfArr(hrActs.map(a => a.raw.average_heartrate));
    lines.push(`${emoji} ${type}: ${acts.length}x | ${fmtTime(sec)}${cal > 0 ? ` | ${cal} kcal` : ''}${avgHR ? ` | avg HR ${avgHR} bpm` : ''}`);
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
    const avgCal  = Math.round(nutritionRows.reduce((s, r) => s + r.calories, 0) / nutritionRows.length);
    const avgProt = Math.round(nutritionRows.reduce((s, r) => s + (r.protein_g ?? 0), 0) / nutritionRows.length);
    const avgCarb = Math.round(nutritionRows.reduce((s, r) => s + (r.carbs_g ?? 0), 0) / nutritionRows.length);
    const avgFat  = Math.round(nutritionRows.reduce((s, r) => s + (r.fat_g ?? 0), 0) / nutritionRows.length);
    lines.push('');
    lines.push(`🍽 Nutrition (${nutritionRows.length}-day avg): ${avgCal} kcal · P ${avgProt}g · C ${avgCarb}g · F ${avgFat}g`);
  }

  lines.push('');
  lines.push('📋 TrainingPeaks: coming soon');

  return lines.join('\n');
}

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

// Daily briefing at 7:00am Israel time
cron.schedule('0 7 * * *', async () => {
  console.log('[briefing] Sending morning briefing');
  try {
    const message = await generateMorningBriefing();
    await sendTelegram(process.env.TELEGRAM_OWNER_CHAT_ID, message);
    console.log('[briefing] Sent successfully');
  } catch (err) {
    console.error('[briefing] Error:', err.message);
  }
}, { timezone: 'Asia/Jerusalem' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
