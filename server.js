'use strict';

require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.get('/health', (_req, res) => res.status(200).send('OK'));

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
      const d = new Date(s.dt * 1000);
      const label = d.toLocaleString('en-GB', {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Jerusalem',
      });
      return `${label}: ${Math.round(s.main.temp)}°C, ${s.weather[0].description}, wind ${Math.round(s.wind.speed)} m/s, humidity ${s.main.humidity}%`;
    })
    .join('\n');

  console.log(`[weather] Fetched ${slots.split('\n').length} slots`);
  return slots || 'No forecast data available';
}

function parseWindowDays(text) {
  const t = text.toLowerCase();
  if (/last\s+week/.test(t)) return 7;
  if (/last\s+month/.test(t)) return 30;
  const match = t.match(/last\s+(\d+)\s+(day|week|month)s?/);
  if (match) {
    const n = parseInt(match[1]);
    if (match[2] === 'week') return n * 7;
    if (match[2] === 'month') return n * 30;
    return n;
  }
  return 14;
}

async function getCoachingResponse(userText) {
  const days = parseWindowDays(userText);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data: activities, error } = await supabase
    .from('activities')
    .select('type, distance_m, moving_time_s, started_at')
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

        return `${date}: ${a.type ?? 'Unknown'}, ${km} km, ${duration}${pace}`;
      })
      .join('\n');
  }

  let weatherSection = '';
  try {
    const forecast = await getWeatherForecast();
    weatherSection = `\nWeather forecast for ${process.env.RUNNER_LOCATION} (next 48h):\n${forecast}\n`;
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
        content: `Recent training (last ${days} days):\n${summary}\n${weatherSection}\nAthlete: ${userText}`,
      },
    ],
  });

  return response.content[0].text;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
