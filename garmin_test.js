'use strict';

require('dotenv').config({ path: '_env' });
const axios = require('axios');

const API = 'https://connectapi.garmin.com';
const fs = require('fs');
const token = process.env.GARMIN_ACCESS_TOKEN
  ?? (fs.existsSync('.garmin_token') ? fs.readFileSync('.garmin_token', 'utf8').trim() : null)
  ?? JSON.parse(process.env.GARMIN_OAUTH2 ?? '{}').access_token;

const headers = {
  Authorization: `Bearer ${token}`,
  'NK': 'NT',
  'DI-Backend': 'connectapi.garmin.com',
};

const date = '2026-05-13';

let pass = 0, fail = 0;

async function test(name, path, params = {}) {
  try {
    const resp = await axios.get(`${API}${path}`, { headers, params });
    const data = resp.data ?? {};
    const keys = Object.keys(Array.isArray(data) ? (data[0] ?? {}) : data).slice(0, 5);
    console.log(`✅  ${name.padEnd(32)} HTTP ${resp.status}  keys: [${keys.join(', ')}]`);
    pass++;
    return resp.data;
  } catch (err) {
    console.log(`❌  ${name.padEnd(32)} HTTP ${err.response?.status ?? 'ERR'}  ${err.response?.data?.message ?? err.message}`);
    fail++;
    return null;
  }
}

(async () => {
  console.log(`\nGarmin 54-endpoint sweep  (date: ${date})\n`);

  // ── Bootstrap: extract displayName + userProfilePK from HR ──────────────
  let displayName = 'me';
  let userProfilePK = null;
  try {
    const hr = await axios.get(`${API}/wellness-service/wellness/dailyHeartRate`, { headers, params: { date } });
    displayName   = hr.data?.displayName   ?? hr.data?.userId ?? 'me';
    userProfilePK = hr.data?.userProfilePK ?? null;
    console.log(`[bootstrap] displayName=${displayName}  userProfilePK=${userProfilePK}\n`);
  } catch (e) {
    console.log(`[bootstrap] HR fetch failed — using defaults. ${e.message}\n`);
  }

  // ── SLEEP (6) ─────────────────────────────────────────────────────────────
  console.log('── Sleep ────────────────────────────────────────────────────────');
  await test('Sleep Daily',         `/sleep-service/sleep/dailySleepData`,              { date });
  await test('Sleep Alt',           `/sleep-service/sleep/${date}`);
  await test('Sleep SpO2',          `/sleep-service/sleep/spo2-data/${date}`);
  await test('Sleep Movement',      `/sleep-service/sleep/movement/${date}`);
  await test('Sleep Display',       `/wellness-service/wellness/dailySleep/${displayName}/${date}`);
  await test('Sleep Stats',         `/sleep-service/stats/sleep`,                       { from: date });

  // ── HEART RATE (4) ────────────────────────────────────────────────────────
  console.log('\n── Heart Rate ───────────────────────────────────────────────────');
  await test('Daily HR',            `/wellness-service/wellness/dailyHeartRate`,         { date });
  await test('HR Display',          `/wellness-service/wellness/dailyHeartRate/${displayName}`, { date });
  await test('HR Zones',            `/usersummary-service/usersummary/heartRate/${date}`);
  await test('Resting HR',          `/wellness-service/wellness/restingHeartRate`,       { startDate: date, endDate: date });

  // ── HRV (3) ───────────────────────────────────────────────────────────────
  console.log('\n── HRV ──────────────────────────────────────────────────────────');
  await test('HRV Daily',           `/hrv-service/hrv/${date}`);
  await test('HRV Summary',         `/hrv-service/hrv/getSummaryData`);
  await test('HRV Weekly',          `/hrv-service/hrv/weekly/${date}`);

  // ── BODY BATTERY (3) ──────────────────────────────────────────────────────
  console.log('\n── Body Battery ─────────────────────────────────────────────────');
  await test('Body Battery Bulletin',`/wellness-service/wellness/bodyBattery/bulletinList`, { startDate: date, endDate: date });
  await test('Body Battery Range',  `/wellness-service/wellness/bodyBattery/${date}/${date}`);
  await test('Body Battery Single', `/wellness-service/wellness/bodyBattery/${date}`);

  // ── STRESS (3) ────────────────────────────────────────────────────────────
  console.log('\n── Stress ───────────────────────────────────────────────────────');
  await test('Daily Stress',        `/wellness-service/wellness/dailyStress/${date}`);
  await test('Stress Detail',       `/wellness-service/wellness/stressDetails/${displayName}/${date}`);
  await test('Stress Events',       `/wellness-service/wellness/stressEvents/${date}`);

  // ── TRAINING STATUS (3) ───────────────────────────────────────────────────
  console.log('\n── Training Status ──────────────────────────────────────────────');
  await test('Training Status',     `/metrics-service/metrics/trainingstatus/aggregated/${date}`);
  await test('Training Load',       `/metrics-service/metrics/trainingload/aggregated/${date}/${date}`);
  await test('Acute Load',          `/metrics-service/metrics/acuteload/aggregated/${date}/${date}`);

  // ── TRAINING READINESS (3) ────────────────────────────────────────────────
  console.log('\n── Training Readiness ───────────────────────────────────────────');
  await test('Readiness Path',      `/metrics-service/metrics/trainingReadiness/${date}`);
  await test('Readiness Query',     `/metrics-service/metrics/trainingReadiness`,        { calendarDate: date });
  await test('Readiness Lower',     `/metrics-service/metrics/trainingreadiness/${date}`);

  // ── VO2 MAX & FITNESS (3) ─────────────────────────────────────────────────
  console.log('\n── VO2 Max & Fitness ────────────────────────────────────────────');
  await test('VO2 Max',             `/metrics-service/metrics/maxmet/daily/${date}/${date}`);
  await test('Fitness Age',         `/metrics-service/metrics/fitnessage/data`);
  await test('Perf Condition',      `/metrics-service/metrics/performancecondition`);

  // ── RACE PREDICTIONS (2) ──────────────────────────────────────────────────
  console.log('\n── Race Predictions ─────────────────────────────────────────────');
  await test('Race Pred Path',      `/metrics-service/metrics/racepredictions/daily/${date}/${date}`);
  await test('Race Pred No Date',   `/metrics-service/metrics/racepredictions`);

  // ── DAILY ACTIVITY / STEPS (4) ───────────────────────────────────────────
  console.log('\n── Daily Activity / Steps ───────────────────────────────────────');
  await test('Activity Me',         `/usersummary-service/usersummary/daily/me`,         { calendarDate: date });
  await test('Activity Display',    `/usersummary-service/usersummary/daily/${displayName}`, { calendarDate: date });
  await test('Steps Range',         `/wellness-service/wellness/dailySteps/${date}/${date}`);
  await test('Activities List',     `/activitylist-service/activities/search/activities`, { startDate: date, limit: 5 });

  // ── RESPIRATION (3) ───────────────────────────────────────────────────────
  console.log('\n── Respiration ──────────────────────────────────────────────────');
  await test('Respiration Path',    `/wellness-service/wellness/respiration/${date}`);
  await test('Respiration Display', `/wellness-service/wellness/dailyRespiration/${displayName}/${date}`);
  await test('Avg Respiration',     `/wellness-service/wellness/avgRespiration/${date}`);

  // ── SPO2 (3) ──────────────────────────────────────────────────────────────
  console.log('\n── SpO2 ─────────────────────────────────────────────────────────');
  await test('Pulse Ox',            `/wellness-service/wellness/pulseOx/${date}`);
  await test('Daily Pulse Ox',      `/wellness-service/wellness/dailyPulseOx/${date}`);
  await test('Avg Pulse Ox',        `/wellness-service/wellness/avgPulseOx/${date}`);

  // ── SKIN TEMPERATURE (2) ─────────────────────────────────────────────────
  console.log('\n── Skin Temperature ─────────────────────────────────────────────');
  await test('Skin Temp Path',      `/wellness-service/wellness/skinTemperature/${date}`);
  await test('Skin Temp Log',       `/wellness-service/wellness/skinTemperatureLog/${date}/${date}`);

  // ── WEIGHT (3) ───────────────────────────────────────────────────────────
  console.log('\n── Weight ───────────────────────────────────────────────────────');
  await test('Weight Day View',     `/weight-service/weight/dayview/${date}`);
  await test('Weight Alt',          `/weight-service/weight/${date}`);
  await test('Weight Range',        `/weight-service/weight/range/${date}/${date}`);

  // ── HYDRATION (2) ────────────────────────────────────────────────────────
  console.log('\n── Hydration ────────────────────────────────────────────────────');
  await test('Hydration All',       `/usersummary-service/usersummary/hydration/allData/${date}`);
  await test('Hydration Daily',     `/usersummary-service/usersummary/hydration/${date}`);

  // ── GEAR (3) ─────────────────────────────────────────────────────────────
  console.log('\n── Gear ─────────────────────────────────────────────────────────');
  await test('Gear Filter',         `/gear-service/gear/filterGear`);
  if (userProfilePK) {
    await test('Gear With PK',      `/gear-service/gear/filterGear`,                    { userProfilePK });
  }
  await test('Gear Stats Running',  `/gear-service/gear/stats/running`);

  // ── BONUS (3) ────────────────────────────────────────────────────────────
  console.log('\n── Bonus ────────────────────────────────────────────────────────');
  await test('Cardio Insights',     `/insights-service/cardioInsights/insights/${date}`);
  await test('User Profile',        `/userprofile-service/userprofile/personal-information`);
  await test('Weekly Summary',      `/usersummary-service/usersummary/week/${date}/all`);

  console.log(`\n${'─'.repeat(65)}`);
  console.log(`Result: ${pass} ✅  ${fail} ❌  (${pass + fail} total)\n`);
})();
