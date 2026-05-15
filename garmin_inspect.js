'use strict';

require('dotenv').config({ path: '_env' });
const fs = require('fs');
const axios = require('axios');

const API = 'https://connectapi.garmin.com';
const token = fs.existsSync('.garmin_token')
  ? fs.readFileSync('.garmin_token', 'utf8').trim()
  : JSON.parse(process.env.GARMIN_OAUTH2 ?? '{}').access_token;

const headers = {
  Authorization: `Bearer ${token}`,
  'NK': 'NT',
  'DI-Backend': 'connectapi.garmin.com',
};

const date = '2026-05-13';
const working = {};
const failing = [];

async function fetch12(name, path, params = {}) {
  try {
    const resp = await axios.get(`${API}${path}`, { headers, params });
    working[name] = { status: resp.status, url: path, params, data: resp.data };
    console.log(`✅ ${name}`);
  } catch (err) {
    working[name] = { status: err.response?.status ?? 'ERR', url: path, params, error: err.message };
    console.log(`❌ ${name} — ${err.response?.status ?? 'ERR'}`);
  }
}

async function probe(name, path, params = {}) {
  try {
    const resp = await axios.get(`${API}${path}`, { headers, params });
    failing.push({ name, path, params, status: resp.status, note: 'NOW OK', data: resp.data });
  } catch (err) {
    failing.push({ name, path, params, status: err.response?.status ?? 'ERR', body: err.response?.data ?? err.message });
  }
}

(async () => {
  console.log(`\nFetching 12 working endpoints (date: ${date})...\n`);

  await fetch12('1_sleep',              `/sleep-service/sleep/dailySleepData`,                     { date });
  await fetch12('2_heart_rate',         `/wellness-service/wellness/dailyHeartRate`,                { date });
  await fetch12('3_hrv',               `/hrv-service/hrv/${date}`);
  await fetch12('4_stress',            `/wellness-service/wellness/dailyStress/${date}`);
  await fetch12('5_training_status',   `/metrics-service/metrics/trainingstatus/aggregated/${date}`);
  await fetch12('6_training_readiness',`/metrics-service/metrics/trainingreadiness/${date}`);
  await fetch12('7_vo2_max',           `/metrics-service/metrics/maxmet/daily/${date}/${date}`);
  await fetch12('8_activities',        `/activitylist-service/activities/search/activities`,        { startDate: date, limit: 5 });
  await fetch12('9_weight',            `/weight-service/weight/dayview/${date}`);
  await fetch12('10_weight_range',     `/weight-service/weight/range/${date}/${date}`);
  await fetch12('11_hydration',        `/usersummary-service/usersummary/hydration/allData/${date}`);
  await fetch12('12_user_profile',     `/userprofile-service/userprofile/personal-information`);

  const dn = working['2_heart_rate']?.data?.displayName ?? 'me';
  const pk = working['2_heart_rate']?.data?.userProfilePK;

  console.log(`\nProbing 50+ failing variants (displayName=${dn}, userProfilePK=${pk})...\n`);

  // Sleep
  await probe('Sleep Alt',             `/sleep-service/sleep/${date}`);
  await probe('Sleep SpO2',            `/sleep-service/sleep/spo2-data/${date}`);
  await probe('Sleep Movement',        `/sleep-service/sleep/movement/${date}`);
  await probe('Sleep Display',         `/wellness-service/wellness/dailySleep/${dn}/${date}`);
  await probe('Sleep Stats',           `/sleep-service/stats/sleep`,                               { from: date });
  // Heart Rate
  await probe('HR Display',            `/wellness-service/wellness/dailyHeartRate/${dn}`,           { date });
  await probe('HR Zones',              `/usersummary-service/usersummary/heartRate/${date}`);
  await probe('Resting HR',            `/wellness-service/wellness/restingHeartRate`,               { startDate: date, endDate: date });
  // HRV
  await probe('HRV Summary',           `/hrv-service/hrv/getSummaryData`);
  await probe('HRV Weekly',            `/hrv-service/hrv/weekly/${date}`);
  // Body Battery
  await probe('Body Battery Bulletin', `/wellness-service/wellness/bodyBattery/bulletinList`,       { startDate: date, endDate: date });
  await probe('Body Battery Range',    `/wellness-service/wellness/bodyBattery/${date}/${date}`);
  await probe('Body Battery Single',   `/wellness-service/wellness/bodyBattery/${date}`);
  await probe('Body Battery Chart',    `/wellness-service/wellness/bodyBattery/chart/${date}`);
  await probe('Body Battery v2',       `/wellness-service/wellness/bodyBatteryV2/${date}`);
  // Stress
  await probe('Stress Detail',         `/wellness-service/wellness/stressDetails/${dn}/${date}`);
  await probe('Stress Events',         `/wellness-service/wellness/stressEvents/${date}`);
  // Training
  await probe('Training Load',         `/metrics-service/metrics/trainingload/aggregated/${date}/${date}`);
  await probe('Acute Load',            `/metrics-service/metrics/acuteload/aggregated/${date}/${date}`);
  await probe('Recovery Time',         `/metrics-service/metrics/recovery/${date}`);
  await probe('Recovery Advisor',      `/metrics-service/metrics/recoveryadvisor/daily/${date}`);
  await probe('Readiness Camel',       `/metrics-service/metrics/trainingReadiness/${date}`);
  await probe('Readiness Query',       `/metrics-service/metrics/trainingReadiness`,                { calendarDate: date });
  // VO2 / Fitness
  await probe('Fitness Age',           `/metrics-service/metrics/fitnessage/data`);
  await probe('Perf Condition',        `/metrics-service/metrics/performancecondition`);
  // Race Predictions
  await probe('Race Pred Path',        `/metrics-service/metrics/racepredictions/daily/${date}/${date}`);
  await probe('Race Pred No Date',     `/metrics-service/metrics/racepredictions`);
  await probe('Race Pred v2',          `/metrics-service/metrics/racepredictions/v2/${date}`);
  // Daily Activity
  await probe('Activity Me',           `/usersummary-service/usersummary/daily/me`,                 { calendarDate: date });
  await probe('Activity Display',      `/usersummary-service/usersummary/daily/${dn}`,              { calendarDate: date });
  if (pk) await probe('Activity PK',   `/usersummary-service/usersummary/daily/${pk}`,              { calendarDate: date });
  await probe('Steps Range',           `/wellness-service/wellness/dailySteps/${date}/${date}`);
  // Respiration
  await probe('Respiration Path',      `/wellness-service/wellness/respiration/${date}`);
  await probe('Respiration Display',   `/wellness-service/wellness/dailyRespiration/${dn}/${date}`);
  await probe('Avg Respiration',       `/wellness-service/wellness/avgRespiration/${date}`);
  await probe('Respiration v2',        `/wellness-service/wellness/dailyRespiration/${date}`);
  // SpO2
  await probe('Pulse Ox',             `/wellness-service/wellness/pulseOx/${date}`);
  await probe('Daily Pulse Ox',       `/wellness-service/wellness/dailyPulseOx/${date}`);
  await probe('Avg Pulse Ox',         `/wellness-service/wellness/avgPulseOx/${date}`);
  await probe('SpO2 Display',         `/wellness-service/wellness/dailyPulseOx/${dn}/${date}`);
  // Skin Temp
  await probe('Skin Temp Path',       `/wellness-service/wellness/skinTemperature/${date}`);
  await probe('Skin Temp Log',        `/wellness-service/wellness/skinTemperatureLog/${date}/${date}`);
  await probe('Skin Temp Display',    `/wellness-service/wellness/skinTemperatureLog/${dn}/${date}`);
  // Gear
  await probe('Gear Filter',          `/gear-service/gear/filterGear`);
  if (pk) await probe('Gear With PK', `/gear-service/gear/filterGear`,                             { userProfilePK: pk });
  await probe('Gear Stats Running',   `/gear-service/gear/stats/running`);
  await probe('Gear User',            `/gear-service/gear/user/${dn}`);
  // Bonus
  await probe('Cardio Insights',      `/insights-service/cardioInsights/insights/${date}`);
  await probe('Weekly Summary',       `/usersummary-service/usersummary/week/${date}/all`);

  // ── Save everything to file ───────────────────────────────────────────────
  fs.writeFileSync('garmin_raw_responses.json',
    JSON.stringify({ fetched_at: new Date().toISOString(), date, working, failing }, null, 2), 'utf8');
  console.log('✅ Full responses saved to garmin_raw_responses.json\n');

  // ── Field search across all 12 working responses ──────────────────────────
  const raw = JSON.stringify(working).toLowerCase();
  const fieldGroups = {
    'Body Battery':       ['bodybatteryversion','bodybatterystatlist','charged','drained'],
    'Skin Temperature':   ['skintemp','tempdeviation','baseline'],
    'Race Predictions':   ['race5k','race10k','racehalf','racefull','raceprediction','predictedtime'],
    'Gear':              ['gearid','gearname','geardistance','gearuuid'],
    'SpO2':              ['spo2','oxygensaturation','pulseox','avgspsat'],
    'Respiration':        ['respirationrate','avgbreaths','avgwakingrespirationvalue','highestrespirationvalue'],
    'Sleep Coach':        ['sleepneed','sleepdebt','sleepcoach','sleepscore','sleepscorequalifier'],
    'Running Dynamics':   ['groundcontacttime','verticaloscillation','stridelength','cadence'],
    'Recovery':           ['recoverytime','recoveryhours','recoveryadvice','recoveryvalue'],
  };

  console.log('── Fields found inside the 12 working responses ──────────────────');
  for (const [group, fields] of Object.entries(fieldGroups)) {
    console.log(`\n  ${group}:`);
    for (const f of fields) {
      console.log(`    ${raw.includes(f) ? '✅ FOUND' : '❌ absent'} — ${f}`);
    }
  }

  // ── Failing endpoint summary ──────────────────────────────────────────────
  console.log('\n── Failing endpoint results ───────────────────────────────────────');
  for (const f of failing) {
    const tag = f.note ? ` ← ${f.note}` : '';
    console.log(`  HTTP ${String(f.status).padEnd(4)}  ${f.name}${tag}`);
  }

  const newlyWorking = failing.filter(f => f.note === 'NOW OK');
  if (newlyWorking.length) {
    console.log(`\n🎉 Newly discovered working endpoints: ${newlyWorking.map(f => f.name).join(', ')}`);
  }
})();
