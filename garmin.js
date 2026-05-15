'use strict';

require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const BASE = 'https://connectapi.garmin.com';

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeErr(err) {
  let msg = err?.message ?? String(err);
  if (process.env.GARMIN_USERNAME) msg = msg.replace(process.env.GARMIN_USERNAME, '***');
  if (process.env.GARMIN_PASSWORD) msg = msg.replace(process.env.GARMIN_PASSWORD, '***');
  return msg;
}

function fmtSecs(secs) {
  if (!secs) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function fmtRaceTime(secs) {
  if (!secs) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

let _cachedToken = null;

async function getAccessToken() {
  // Plain token string — easiest to set in Railway
  if (process.env.GARMIN_ACCESS_TOKEN) return process.env.GARMIN_ACCESS_TOKEN;

  let oauth2 = {};
  try { oauth2 = JSON.parse(process.env.GARMIN_OAUTH2 ?? '{}'); } catch (_) {}

  const now = Date.now() / 1000;

  if (_cachedToken?.expires_at > now + 60) return _cachedToken.access_token;

  if (oauth2.expires_at > now + 60) {
    _cachedToken = oauth2;
    return oauth2.access_token;
  }

  if (oauth2.refresh_token && (oauth2.refresh_token_expires_at ?? Infinity) > now) {
    try {
      const resp = await axios.post(
        'https://diauth.garmin.com/oauth-service/oauth/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: oauth2.refresh_token,
          client_id: 'GARMIN_CONNECT_MOBILE_ANDROID_DI',
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      _cachedToken = {
        ...oauth2,
        access_token: resp.data.access_token,
        expires_at: now + (resp.data.expires_in ?? 3600) - 60,
      };
      console.log('[garmin] Access token refreshed successfully');
      return _cachedToken.access_token;
    } catch (err) {
      console.error('[garmin] Token refresh failed:', err.message);
    }
  }

  if (!oauth2.access_token) throw new Error('[garmin] No access token — set GARMIN_ACCESS_TOKEN in Railway');
  _cachedToken = oauth2;
  return oauth2.access_token;
}

async function gcGet(path, params = {}) {
  const token = await getAccessToken();
  const resp = await axios.get(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'NK': 'NT',
      'DI-Backend': 'connectapi.garmin.com',
    },
    params,
  });
  return resp.data;
}

// ── Per-Metric Fetchers ───────────────────────────────────────────────────────

async function fetchSleepData(dateStr) {
  try {
    return await gcGet('/sleep-service/sleep/dailySleepData', { date: dateStr });
  } catch (err) {
    console.error('[garmin] fetchSleepData error:', safeErr(err));
    return null;
  }
}

async function fetchHRVData(dateStr) {
  try {
    return await gcGet(`/hrv-service/hrv/${dateStr}`);
  } catch (err) {
    console.error('[garmin] fetchHRVData error:', safeErr(err));
    return null;
  }
}

async function fetchStressData(dateStr) {
  try {
    return await gcGet(`/wellness-service/wellness/dailyStress/${dateStr}`);
  } catch (err) {
    console.error('[garmin] fetchStressData error:', safeErr(err));
    return null;
  }
}

async function fetchTrainingReadiness(dateStr) {
  try {
    const data = await gcGet(`/metrics-service/metrics/trainingreadiness/${dateStr}`);
    return Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
  } catch (err) {
    console.error('[garmin] fetchTrainingReadiness error:', safeErr(err));
    return null;
  }
}

async function fetchTrainingStatus(dateStr) {
  try {
    return await gcGet(`/metrics-service/metrics/trainingstatus/aggregated/${dateStr}`);
  } catch (err) {
    console.error('[garmin] fetchTrainingStatus error:', safeErr(err));
    return null;
  }
}

async function fetchVO2Max(dateStr) {
  try {
    return await gcGet(`/metrics-service/metrics/maxmet/daily/${dateStr}/${dateStr}`);
  } catch (err) {
    console.error('[garmin] fetchVO2Max error:', safeErr(err));
    return null;
  }
}

async function fetchWeightData(dateStr) {
  try {
    const data = await gcGet(`/weight-service/weight/dayview/${dateStr}`);
    return data?.dateWeightList?.[0] ?? data?.totalAverage ?? null;
  } catch (err) {
    console.error('[garmin] fetchWeightData error:', safeErr(err));
    return null;
  }
}

async function fetchHeartRate(dateStr) {
  try {
    return await gcGet('/wellness-service/wellness/dailyHeartRate', { date: dateStr });
  } catch (err) {
    console.error('[garmin] fetchHeartRate error:', safeErr(err));
    return null;
  }
}

async function fetchHydration(dateStr) {
  try {
    return await gcGet(`/usersummary-service/usersummary/hydration/allData/${dateStr}`);
  } catch (err) {
    console.error('[garmin] fetchHydration error:', safeErr(err));
    return null;
  }
}

// ── Storage ───────────────────────────────────────────────────────────────────

async function storeSleep(dateStr, sleep) {
  if (!sleep) return null;
  const dto = sleep.dailySleepDTO ?? {};
  const scores = dto.sleepScores ?? {};
  const row = {
    date: dateStr,
    score: scores?.overall?.value ?? scores?.totalScore ?? null,
    duration_seconds: dto.sleepTimeSeconds ?? null,
    deep_seconds: dto.deepSleepSeconds ?? null,
    light_seconds: dto.lightSleepSeconds ?? null,
    rem_seconds: dto.remSleepSeconds ?? null,
    awake_seconds: dto.awakeSleepSeconds ?? null,
    sleep_start: dto.sleepStartTimestampLocal
      ? new Date(dto.sleepStartTimestampLocal).toISOString() : null,
    sleep_end: dto.sleepEndTimestampLocal
      ? new Date(dto.sleepEndTimestampLocal).toISOString() : null,
    avg_respiration: dto.averageRespirationValue ?? null,
    avg_spo2: dto.averageSpO2Value ?? null,
    min_spo2: dto.lowestSpO2Value ?? null,
    avg_stress: dto.avgSleepStress ?? null,
    hrv_ms: sleep.avgOvernightHrv ?? null,
    hrv_status: sleep.hrvStatus ?? null,
    body_battery_change: sleep.bodyBatteryChange ?? null,
    resting_hr: sleep.restingHeartRate ?? null,
    sleep_score_feedback: dto.sleepScoreFeedback ?? null,
    raw: sleep,
  };
  const { error } = await supabase.from('daily_garmin_sleep').upsert(row);
  if (error) console.error('[garmin] storeSleep error:', error.message);
  return row;
}

async function storeHRV(dateStr, hrv, sleep) {
  const hrv7Day = hrv?.hrvSummary ?? hrv?.lastNight ?? hrv ?? null;
  const row = {
    date: dateStr,
    last_night_ms: hrv7Day?.lastNight ?? hrv7Day?.weeklyAvg ?? sleep?.avgOvernightHrv ?? null,
    last_night_5min_high: hrv7Day?.lastNight5MinHigh ?? null,
    hrv_status: hrv7Day?.status ?? sleep?.hrvStatus ?? null,
    weekly_avg: hrv7Day?.weeklyAvg ?? null,
    baseline_balanced_low: hrv7Day?.balancedLow ?? null,
    baseline_balanced_high: hrv7Day?.balancedHigh ?? null,
    raw: hrv,
  };
  const { error } = await supabase.from('daily_garmin_hrv').upsert(row);
  if (error) console.error('[garmin] storeHRV error:', error.message);
  return row;
}

async function storeBodyBattery(dateStr, bb) {
  if (!bb) return null;
  const list = Array.isArray(bb) ? bb : (bb.bodyBatteryValuesArray ?? bb.bulletinList ?? []);
  const values = list.map(item => Array.isArray(item) ? item[2] : (item.value ?? item.bodyBatteryLevel ?? null)).filter(v => typeof v === 'number');
  const row = {
    date: dateStr,
    morning_value: values.length ? values[0] : null,
    evening_value: values.length ? values[values.length - 1] : null,
    peak_value: values.length ? Math.max(...values) : null,
    lowest_value: values.length ? Math.min(...values) : null,
    charged: bb.charged ?? null,
    drained: bb.drained ?? null,
    raw: bb,
  };
  const { error } = await supabase.from('daily_garmin_body_battery').upsert(row);
  if (error) console.error('[garmin] storeBodyBattery error:', error.message);
  return row;
}

async function storeStress(dateStr, stress) {
  if (!stress) return null;
  const row = {
    date: dateStr,
    avg_stress: stress.avgStressLevel ?? stress.avgStress ?? null,
    max_stress: stress.maxStressLevel ?? stress.maxStress ?? null,
    stress_duration_secs: stress.stressDuration ?? null,
    rest_duration_secs: stress.restDuration ?? null,
    high_stress_mins: stress.highStressDuration ? Math.round(stress.highStressDuration / 60) : null,
    low_stress_mins: stress.lowStressDuration ? Math.round(stress.lowStressDuration / 60) : null,
    raw: stress,
  };
  const { error } = await supabase.from('daily_garmin_stress').upsert(row);
  if (error) console.error('[garmin] storeStress error:', error.message);
  return row;
}

async function storeTraining(dateStr, readiness, trainingStatus, vo2, racePredictions) {
  const rdy = readiness?.trainingReadinessDTO ?? readiness ?? null;
  const ts = trainingStatus?.trainingStatusDTO ?? trainingStatus?.trainingStatus ?? trainingStatus ?? null;
  const vo2val = vo2?.metricsMaxMetData?.[0]?.vo2MaxValue ?? vo2?.[0]?.vo2MaxValue ?? null;
  const fitnessAge = vo2?.metricsMaxMetData?.[0]?.fitnessAge ?? vo2?.[0]?.fitnessAge ?? null;
  const rp = racePredictions?.racePredictions?.[0] ?? racePredictions?.[0] ?? null;

  const row = {
    date: dateStr,
    readiness_score: rdy?.score ?? rdy?.trainingReadinessScore ?? null,
    readiness_classification: rdy?.classification ?? rdy?.readinessDescription ?? null,
    readiness_sleep_score: rdy?.sleepScore ?? null,
    readiness_hrv_status: rdy?.hrvAccuteStress ?? rdy?.hrvStatus ?? null,
    readiness_acl: rdy?.acl ?? null,
    training_status: ts?.latestTrainingStatus ?? ts?.trainingStatus ?? null,
    training_load: ts?.latestTrainingLoad7Days ?? ts?.trainingLoad ?? null,
    training_load_status: ts?.trainingLoadStatus ?? null,
    acl: ts?.acl ?? null,
    ccl: ts?.ccl ?? null,
    vo2max: vo2val,
    fitness_age: fitnessAge,
    recovery_time_hours: ts?.recoveryTime ? ts.recoveryTime / 3600 : (rdy?.recoveryTime ?? null),
    lactate_threshold_hr: ts?.lactateThresholdHeartRate ?? null,
    lactate_threshold_pace: ts?.lactateThresholdSpeed ?? null,
    raw: { readiness, trainingStatus, vo2, racePredictions },
  };
  const { error } = await supabase.from('daily_garmin_training').upsert(row);
  if (error) console.error('[garmin] storeTraining error:', error.message);
  return row;
}

async function storeVitals(dateStr, hr, respiration, spo2, skinTemp, weight, hydration) {
  const hrData = hr?.heartRateValues ?? hr ?? null;
  const hrValues = Array.isArray(hrData) ? hrData.map(v => Array.isArray(v) ? v[1] : v).filter(v => v > 0) : [];
  const row = {
    date: dateStr,
    resting_hr: hr?.restingHeartRate ?? null,
    min_hr: hr?.minHeartRate ?? (hrValues.length ? Math.min(...hrValues) : null),
    max_hr: hr?.maxHeartRate ?? (hrValues.length ? Math.max(...hrValues) : null),
    avg_respiration: respiration?.avgWakingRespirationValue ?? respiration?.averageRespirationValue ?? null,
    sleep_respiration: respiration?.avgSleepRespirationValue ?? null,
    spo2_avg: spo2?.averageSpO2 ?? spo2?.avgSpo2 ?? null,
    spo2_min: spo2?.lowestSpO2 ?? spo2?.minSpo2 ?? null,
    spo2_sleep_avg: spo2?.avgSleepSpO2 ?? null,
    skin_temp_deviation: skinTemp?.temperatureDeviation ?? skinTemp?.skinTempDeviation ?? null,
    weight_kg: weight?.weight ? weight.weight / 1000 : null,
    bmi: weight?.bmi ?? null,
    body_fat_pct: weight?.bodyFat ?? null,
    muscle_mass_kg: weight?.muscleMass ? weight.muscleMass / 1000 : null,
    bone_mass_kg: weight?.boneMass ? weight.boneMass / 1000 : null,
    hydration_intake_ml: hydration?.valueInML ?? (typeof hydration === 'number' ? Math.round(hydration * 29.5735) : null),
    raw: { hr, respiration, spo2, skinTemp, weight, hydration },
  };
  const { error } = await supabase.from('daily_garmin_vitals').upsert(row);
  if (error) console.error('[garmin] storeVitals error:', error.message);
  return row;
}

async function storeActivity(dateStr, summary) {
  if (!summary) return null;
  const row = {
    date: dateStr,
    steps: summary.totalSteps ?? summary.steps ?? null,
    floors_climbed: summary.floorsAscended ?? summary.floors ?? null,
    total_calories: summary.totalKilocalories ?? summary.calories ?? null,
    active_calories: summary.activeKilocalories ?? summary.activeCalories ?? null,
    distance_meters: summary.totalDistanceMeters ?? summary.distance ?? null,
    moderate_intensity_mins: summary.moderateIntensityMinutes ?? null,
    vigorous_intensity_mins: summary.vigorousIntensityMinutes ?? null,
    raw: summary,
  };
  const { error } = await supabase.from('daily_garmin_activity').upsert(row);
  if (error) console.error('[garmin] storeActivity error:', error.message);
  return row;
}

async function storeGear(gearList) {
  if (!Array.isArray(gearList) || !gearList.length) return;
  for (const gear of gearList) {
    const pk = gear.gearPk ?? gear.gearId ?? gear.uuid;
    if (!pk) continue;
    const row = {
      gear_pk: typeof pk === 'string' ? pk.replace(/\D/g, '').slice(0, 18) || 0 : pk,
      gear_type: gear.gearTypeName ?? gear.gearType ?? null,
      display_name: gear.displayName ?? gear.customMakeModel ?? null,
      brand_name: gear.brandName ?? null,
      model_name: gear.modelName ?? null,
      status: gear.gearStatusName ?? gear.status ?? null,
      total_activities: gear.totalActivities ?? null,
      total_distance_meters: gear.totalDistance ?? gear.totalDistanceMeters ?? null,
      last_used_date: gear.dateBegin ?? gear.lastUsedDate ?? null,
      raw: gear,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('garmin_gear').upsert(row);
    if (error) console.error('[garmin] storeGear error:', error.message);
  }
}

async function storeRacePredictions(dateStr, rp) {
  if (!rp) return null;
  const list = rp.racePredictions ?? rp?.metricDescriptors ?? (Array.isArray(rp) ? rp : []);
  const entry = list[0] ?? rp;
  const row = {
    date: dateStr,
    time_5k_secs: entry?.distance5K ?? entry?.time5K ?? entry?.fiveK ?? null,
    time_10k_secs: entry?.distance10K ?? entry?.time10K ?? entry?.tenK ?? null,
    time_half_secs: entry?.distanceHalf ?? entry?.timeHalf ?? entry?.halfMarathon ?? null,
    time_full_secs: entry?.distanceMarathon ?? entry?.timeMarathon ?? entry?.marathon ?? null,
    raw: rp,
  };
  const { error } = await supabase.from('garmin_race_predictions').upsert(row);
  if (error) console.error('[garmin] storeRacePredictions error:', error.message);
  return row;
}

// ── Main Sync ─────────────────────────────────────────────────────────────────

async function syncGarminDay(dateStr) {
  console.log(`[garmin] Syncing ${dateStr}`);

  const [sleep, hrv, stress, readiness, trainingStatus, vo2, weight, hr, hydration] = await Promise.all([
    fetchSleepData(dateStr),
    fetchHRVData(dateStr),
    fetchStressData(dateStr),
    fetchTrainingReadiness(dateStr),
    fetchTrainingStatus(dateStr),
    fetchVO2Max(dateStr),
    fetchWeightData(dateStr),
    fetchHeartRate(dateStr),
    fetchHydration(dateStr),
  ]);

  const dto = sleep?.dailySleepDTO ?? {};

  // SpO2, respiration, and skin temp are nested inside the sleep response
  const spo2 = sleep ? { averageSpO2: dto.averageSpO2Value, lowestSpO2: dto.lowestSpO2Value } : null;
  const respiration = sleep ? { avgWakingRespirationValue: dto.averageRespirationValue, averageRespirationValue: dto.averageRespirationValue } : null;
  const skinTemp = sleep ? { temperatureDeviation: dto.avgSkinTempDeviationC } : null;

  // Body battery timeline lives in the stress response
  const bbData = stress ? { bodyBatteryValuesArray: stress.bodyBatteryValuesArray ?? [], charged: sleep?.bodyBatteryChange ?? null } : null;

  const [storedSleep, storedHRV, storedBB, storedStress, storedTraining,
    storedVitals, storedActivity, storedRace] = await Promise.all([
    storeSleep(dateStr, sleep),
    storeHRV(dateStr, hrv, sleep),
    storeBodyBattery(dateStr, bbData),
    storeStress(dateStr, stress),
    storeTraining(dateStr, readiness, trainingStatus, vo2, null),
    storeVitals(dateStr, hr, respiration, spo2, skinTemp, weight, hydration),
    storeActivity(dateStr, null),
    storeRacePredictions(dateStr, null),
  ]);
  await storeGear([]);

  console.log(`[garmin] Sync complete for ${dateStr}`);
  return {
    sleep: storedSleep,
    hrv: storedHRV,
    bodyBattery: storedBB,
    stress: storedStress,
    training: storedTraining,
    vitals: storedVitals,
    activity: storedActivity,
    race: storedRace,
  };
}

async function syncGarminHistory(days = 30) {
  console.log(`[garmin] Starting ${days}-day historical sync`);
  await getAccessToken();
  let synced = 0;
  for (let i = days; i >= 1; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    try {
      await syncGarminDay(dateStr);
      synced++;
    } catch (err) {
      console.error(`[garmin] History sync failed for ${dateStr}:`, safeErr(err));
    }
    await new Promise(r => setTimeout(r, 800));
  }
  console.log(`[garmin] Historical sync done — ${synced}/${days} days`);
  return synced;
}

// ── Smart Alerts ──────────────────────────────────────────────────────────────

async function runSmartAlerts(data) {
  const alerts = [];
  const { sleep, hrv, bodyBattery, training, vitals } = data ?? {};

  if (training?.readiness_score != null && training.readiness_score < 40) {
    alerts.push(`⚠️ Training readiness ${training.readiness_score}/100 — prioritise rest today. Skip any planned hard sessions.`);
  }

  if (hrv?.hrv_status && ['low', 'poor', 'UNBALANCED'].includes(hrv.hrv_status.toLowerCase())) {
    const twoDaysAgo = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const { data: prev } = await supabase.from('daily_garmin_hrv')
      .select('hrv_status').eq('date', twoDaysAgo).single();
    if (prev?.hrv_status && ['low', 'poor', 'unbalanced'].includes(prev.hrv_status.toLowerCase())) {
      alerts.push(`🔴 HRV ${hrv.hrv_status} for 2 days in a row — possible overtraining. Consider a full rest day and check your sleep.`);
    }
  }

  if (bodyBattery?.morning_value != null && bodyBattery.morning_value < 30) {
    alerts.push(`🔋 Body battery at ${bodyBattery.morning_value}% this morning — move any hard session to tomorrow.`);
  }

  if (sleep?.duration_seconds != null && sleep.duration_seconds < 21600) {
    const hrs = (sleep.duration_seconds / 3600).toFixed(1);
    alerts.push(`😴 Only ${hrs}h sleep last night — downgrade today's training intensity. No hard efforts.`);
  }

  if (vitals?.spo2_min != null && vitals.spo2_min < 90) {
    alerts.push(`🚨 SpO2 dropped to ${vitals.spo2_min}% during the night — this may indicate a health concern. Consider speaking to a doctor.`);
  }

  if (vitals?.skin_temp_deviation != null && vitals.skin_temp_deviation >= 0.5) {
    alerts.push(`🌡️ Skin temp ${vitals.skin_temp_deviation > 0 ? '+' : ''}${vitals.skin_temp_deviation}°C above baseline — possible inflammation or early illness. Reduce training intensity.`);
  }

  if (vitals?.avg_respiration != null) {
    const twoDaysAgo = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const { data: prev } = await supabase.from('daily_garmin_vitals')
      .select('avg_respiration').eq('date', twoDaysAgo).single();
    const baseline = prev?.avg_respiration;
    if (baseline && vitals.avg_respiration > baseline * 1.15) {
      alerts.push(`🫁 Resting respiration elevated (${vitals.avg_respiration.toFixed(1)} vs ${baseline.toFixed(1)} br/min) for 2+ days — possible early illness. Monitor closely.`);
    }
  }

  if (training?.training_status) {
    const status = training.training_status.toLowerCase();
    if (status.includes('overreach')) {
      alerts.push(`📊 Training status: OVERREACHING — your body is accumulating more stress than it can absorb. Take 2–3 easy days immediately.`);
    } else if (status.includes('detrain')) {
      alerts.push(`📊 Training status: DETRAINING — fitness declining due to insufficient training stimulus. Increase training consistency.`);
    }
  }

  if (training?.vo2max != null) {
    const threeWeeksAgo = new Date(Date.now() - 21 * 86400000).toISOString().slice(0, 10);
    const { data: old } = await supabase.from('daily_garmin_training')
      .select('vo2max').gte('date', threeWeeksAgo).not('vo2max', 'is', null)
      .order('date', { ascending: true }).limit(1).single();
    if (old?.vo2max && old.vo2max > training.vo2max + 0.5) {
      alerts.push(`📉 VO2 Max declining for 3+ weeks (${old.vo2max} → ${training.vo2max}) — fitness regression. Review training load and recovery.`);
    }
  }

  const { data: gearRows } = await supabase.from('garmin_gear')
    .select('display_name, brand_name, model_name, total_distance_meters, alerted')
    .ilike('gear_type', '%shoe%');
  for (const shoe of (gearRows ?? [])) {
    const km = (shoe.total_distance_meters ?? 0) / 1000;
    if (km >= 700 && !shoe.alerted) {
      const name = [shoe.brand_name, shoe.model_name, shoe.display_name].filter(Boolean).join(' ') || 'Your shoes';
      alerts.push(`👟 ${name} has ${Math.round(km)}km — time to replace them! (Recommended: 500–700km per pair)`);
      await supabase.from('garmin_gear')
        .update({ alerted: true })
        .ilike('display_name', shoe.display_name ?? '');
    }
  }

  return alerts;
}

// ── Query Functions ───────────────────────────────────────────────────────────

async function getLatestGarminData(dateStr) {
  const [sleep, hrv, bb, stress, training, vitals, activity, race] = await Promise.all([
    supabase.from('daily_garmin_sleep').select('*').eq('date', dateStr).single().then(r => r.data),
    supabase.from('daily_garmin_hrv').select('*').eq('date', dateStr).single().then(r => r.data),
    supabase.from('daily_garmin_body_battery').select('*').eq('date', dateStr).single().then(r => r.data),
    supabase.from('daily_garmin_stress').select('*').eq('date', dateStr).single().then(r => r.data),
    supabase.from('daily_garmin_training').select('*').eq('date', dateStr).single().then(r => r.data),
    supabase.from('daily_garmin_vitals').select('*').eq('date', dateStr).single().then(r => r.data),
    supabase.from('daily_garmin_activity').select('*').eq('date', dateStr).single().then(r => r.data),
    supabase.from('garmin_race_predictions').select('*').order('date', { ascending: false }).limit(1).single().then(r => r.data),
  ]);
  if (!sleep && !hrv && !bb && !training && !vitals && !activity) return null;
  return { sleep, hrv, bodyBattery: bb, stress, training, vitals, activity, race };
}

async function getGarminWeekSummary() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const [sleepRows, hrvRows, bbRows, trainingRows, vitalsRows, activityRows, gear, race, lastWeekTraining] = await Promise.all([
    supabase.from('daily_garmin_sleep').select('*').gte('date', sevenDaysAgo).lte('date', today).then(r => r.data ?? []),
    supabase.from('daily_garmin_hrv').select('*').gte('date', sevenDaysAgo).lte('date', today).order('date').then(r => r.data ?? []),
    supabase.from('daily_garmin_body_battery').select('lowest_value, date').gte('date', sevenDaysAgo).then(r => r.data ?? []),
    supabase.from('daily_garmin_training').select('*').gte('date', sevenDaysAgo).lte('date', today).order('date', { ascending: false }).limit(1).then(r => r.data?.[0] ?? null),
    supabase.from('daily_garmin_vitals').select('resting_hr, avg_respiration').gte('date', sevenDaysAgo).then(r => r.data ?? []),
    supabase.from('daily_garmin_activity').select('steps, moderate_intensity_mins, vigorous_intensity_mins').gte('date', sevenDaysAgo).then(r => r.data ?? []),
    supabase.from('garmin_gear').select('*').ilike('gear_type', '%shoe%').then(r => r.data ?? []),
    supabase.from('garmin_race_predictions').select('*').order('date', { ascending: false }).limit(1).then(r => r.data?.[0] ?? null),
    supabase.from('daily_garmin_training').select('vo2max').gte('date', new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)).lt('date', sevenDaysAgo).not('vo2max', 'is', null).limit(1).then(r => r.data?.[0] ?? null),
  ]);

  const avg = (arr, key) => {
    const vals = arr.map(r => r[key]).filter(v => v != null);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b) / vals.length) : null;
  };

  const avgSleepScore = avg(sleepRows, 'score');
  const avgSleepSecs = avg(sleepRows, 'duration_seconds');
  const poorSleepNights = sleepRows.filter(r => (r.duration_seconds ?? 0) < 25200 || (r.score ?? 100) < 60).length;
  const avgHRV = avg(hrvRows, 'last_night_ms');
  const hrvFirst = hrvRows[0]?.last_night_ms;
  const hrvLast = hrvRows[hrvRows.length - 1]?.last_night_ms;
  const hrvTrend = (hrvFirst && hrvLast) ? (hrvLast > hrvFirst ? '↑ improving' : hrvLast < hrvFirst ? '↓ declining' : '→ stable') : null;
  const lowestBB = bbRows.length ? bbRows.reduce((min, r) => (r.lowest_value ?? 100) < (min.lowest_value ?? 100) ? r : min, bbRows[0]) : null;
  const avgRHR = avg(vitalsRows, 'resting_hr');
  const totalSteps = activityRows.reduce((s, r) => s + (r.steps ?? 0), 0);
  const totalModerate = activityRows.reduce((s, r) => s + (r.moderate_intensity_mins ?? 0), 0);
  const totalVigorous = activityRows.reduce((s, r) => s + (r.vigorous_intensity_mins ?? 0), 0);
  const intensityMins = totalModerate + totalVigorous * 2;

  return {
    avgSleepScore,
    avgSleepHours: avgSleepSecs ? (avgSleepSecs / 3600).toFixed(1) : null,
    poorSleepNights,
    avgHRV,
    hrvTrend,
    lowestBB,
    avgRHR,
    trainingStatus: trainingRows?.training_status ?? null,
    vo2max: trainingRows?.vo2max ?? null,
    vo2maxLastWeek: lastWeekTraining?.vo2max ?? null,
    totalSteps,
    intensityMins,
    gear,
    race,
  };
}

// ── Telegram Format Helpers ───────────────────────────────────────────────────

function formatGarminSnapshot(g) {
  if (!g) return '⌚ No Garmin data synced yet. Run /sync_garmin to pull data.';
  const lines = ['⌚ Garmin snapshot\n'];
  if (g.sleep) {
    const hrs = g.sleep.duration_seconds ? (g.sleep.duration_seconds / 3600).toFixed(1) : '—';
    lines.push(`😴 Sleep: ${hrs}h · score ${g.sleep.score ?? '—'} · deep ${fmtSecs(g.sleep.deep_seconds)} · REM ${fmtSecs(g.sleep.rem_seconds)}`);
  }
  if (g.hrv) lines.push(`💓 HRV: ${g.hrv.last_night_ms ? Math.round(g.hrv.last_night_ms) : '—'}ms · ${g.hrv.hrv_status ?? '—'}`);
  if (g.bodyBattery) lines.push(`🔋 Body battery: ${g.bodyBattery.morning_value ?? '—'}% morning · peak ${g.bodyBattery.peak_value ?? '—'}%`);
  if (g.stress) lines.push(`😤 Stress: avg ${g.stress.avg_stress ?? '—'} · high stress ${g.stress.high_stress_mins ?? '—'}min`);
  if (g.training) {
    lines.push(`📊 Readiness: ${g.training.readiness_score ?? '—'}/100 · ${g.training.readiness_classification ?? '—'}`);
    lines.push(`🏃 Training: ${g.training.training_status ?? '—'} · load ${g.training.training_load ? Math.round(g.training.training_load) : '—'}`);
    if (g.training.vo2max) lines.push(`🏆 VO2 Max: ${g.training.vo2max} (fitness age ${g.training.fitness_age ?? '—'})`);
    if (g.training.recovery_time_hours) lines.push(`⏱ Recovery: ${Math.round(g.training.recovery_time_hours)}h remaining`);
  }
  if (g.vitals) {
    if (g.vitals.spo2_avg) lines.push(`🫁 SpO2: ${g.vitals.spo2_avg}% avg · min ${g.vitals.spo2_min ?? '—'}%`);
    if (g.vitals.avg_respiration) lines.push(`💨 Respiration: ${g.vitals.avg_respiration.toFixed(1)} br/min`);
    if (g.vitals.skin_temp_deviation != null) lines.push(`🌡️ Skin temp: ${g.vitals.skin_temp_deviation > 0 ? '+' : ''}${g.vitals.skin_temp_deviation}°C`);
  }
  if (g.activity) lines.push(`👟 Steps: ${(g.activity.steps ?? 0).toLocaleString()} · floors ${g.activity.floors_climbed ?? '—'} · cal ${g.activity.total_calories ?? '—'}`);
  if (g.race) {
    lines.push(`\n🏁 Race predictions:`);
    lines.push(`  5K ${fmtRaceTime(g.race.time_5k_secs)} · 10K ${fmtRaceTime(g.race.time_10k_secs)} · Half ${fmtRaceTime(g.race.time_half_secs)} · Full ${fmtRaceTime(g.race.time_full_secs)}`);
  }
  return lines.join('\n');
}

function formatSleepDetail(g) {
  if (!g?.sleep) return '😴 No sleep data available.';
  const s = g.sleep;
  const hrs = s.duration_seconds ? (s.duration_seconds / 3600).toFixed(1) : '—';
  const lines = [
    `😴 Sleep breakdown\n`,
    `Duration: ${hrs}h (${fmtSecs(s.duration_seconds)})`,
    `Score: ${s.score ?? '—'}/100${s.sleep_score_feedback ? ` — ${s.sleep_score_feedback}` : ''}`,
    `\nStages:`,
    `  Deep:  ${fmtSecs(s.deep_seconds)}`,
    `  REM:   ${fmtSecs(s.rem_seconds)}`,
    `  Light: ${fmtSecs(s.light_seconds)}`,
    `  Awake: ${fmtSecs(s.awake_seconds)}`,
  ];
  if (s.sleep_start) lines.push(`\nBedtime: ${new Date(s.sleep_start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' })}`);
  if (s.sleep_end) lines.push(`Wake: ${new Date(s.sleep_end).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' })}`);
  if (s.avg_respiration) lines.push(`\nRespiration: ${s.avg_respiration.toFixed(1)} br/min`);
  if (s.avg_spo2) lines.push(`SpO2: ${s.avg_spo2}% avg${s.min_spo2 ? ` · min ${s.min_spo2}%` : ''}`);
  if (s.avg_stress) lines.push(`Overnight stress: ${Math.round(s.avg_stress)}`);
  if (s.hrv_ms) lines.push(`HRV: ${Math.round(s.hrv_ms)}ms (${s.hrv_status ?? '—'})`);
  return lines.join('\n');
}

function formatReadiness(g) {
  if (!g?.training) return '⚡ No readiness data available.';
  const t = g.training;
  const lines = [
    `⚡ Training Readiness\n`,
    `Score: ${t.readiness_score ?? '—'}/100`,
    `Classification: ${t.readiness_classification ?? '—'}`,
    `\nContributing factors:`,
  ];
  if (t.readiness_sleep_score != null) lines.push(`  Sleep score: ${t.readiness_sleep_score}`);
  if (t.readiness_hrv_status) lines.push(`  HRV status: ${t.readiness_hrv_status}`);
  if (t.readiness_acl != null) lines.push(`  Acute load: ${Math.round(t.readiness_acl)}`);
  if (g.hrv?.last_night_ms) lines.push(`\nHRV: ${Math.round(g.hrv.last_night_ms)}ms · ${g.hrv.hrv_status ?? '—'}`);
  if (g.hrv?.weekly_avg) lines.push(`HRV 7-day avg: ${Math.round(g.hrv.weekly_avg)}ms`);
  return lines.join('\n');
}

function formatRecovery(g) {
  if (!g) return '🔋 No recovery data available.';
  const lines = ['🔋 Recovery snapshot\n'];
  if (g.bodyBattery) {
    lines.push(`Body battery: ${g.bodyBattery.morning_value ?? '—'}% (charged +${g.bodyBattery.charged ?? '—'} overnight)`);
    lines.push(`Peak: ${g.bodyBattery.peak_value ?? '—'}% · Lowest: ${g.bodyBattery.lowest_value ?? '—'}%`);
  }
  if (g.training?.recovery_time_hours != null) lines.push(`\nRecovery time: ${Math.round(g.training.recovery_time_hours)}h remaining`);
  if (g.stress) {
    lines.push(`\nStress today:`);
    lines.push(`  Avg: ${g.stress.avg_stress ?? '—'} · High stress: ${g.stress.high_stress_mins ?? '—'}min`);
    lines.push(`  Rest & recovery: ${g.stress.low_stress_mins ?? '—'}min`);
  }
  return lines.join('\n');
}

function formatVO2(g) {
  if (!g?.training?.vo2max) return '🏆 No VO2 Max data available yet.';
  const t = g.training;
  return [
    `🏆 VO2 Max\n`,
    `Current: ${t.vo2max}`,
    `Fitness age: ${t.fitness_age ?? '—'}`,
    `Training status: ${t.training_status ?? '—'}`,
  ].join('\n');
}

function formatRace(g) {
  if (!g?.race) return '🏁 No race predictions available yet.';
  const r = g.race;
  return [
    `🏁 Race Predictions\n`,
    `5K:           ${fmtRaceTime(r.time_5k_secs)}`,
    `10K:          ${fmtRaceTime(r.time_10k_secs)}`,
    `Half (21.1K): ${fmtRaceTime(r.time_half_secs)}`,
    `Full (42.2K): ${fmtRaceTime(r.time_full_secs)}`,
  ].join('\n');
}

function formatTraining(g) {
  if (!g?.training) return '📊 No training status data available.';
  const t = g.training;
  const lines = [
    `📊 Training Status\n`,
    `Status: ${t.training_status ?? '—'}`,
    `7-day load: ${t.training_load ? Math.round(t.training_load) : '—'} (${t.training_load_status ?? '—'})`,
  ];
  if (t.acl != null && t.ccl != null) lines.push(`Acute/chronic ratio: ${(t.acl / t.ccl).toFixed(2)} (${Math.round(t.acl)} / ${Math.round(t.ccl)})`);
  if (t.recovery_time_hours != null) lines.push(`Recovery: ${Math.round(t.recovery_time_hours)}h remaining`);
  if (t.vo2max) lines.push(`\nVO2 Max: ${t.vo2max} (fitness age ${t.fitness_age ?? '—'})`);
  if (t.lactate_threshold_hr) lines.push(`LT heart rate: ${t.lactate_threshold_hr} bpm`);
  return lines.join('\n');
}

async function formatShoes() {
  const { data: gear } = await supabase.from('garmin_gear').select('*').order('total_distance_meters', { ascending: false });
  if (!gear?.length) return '👟 No gear found. Make sure your shoes are added in Garmin Connect.';
  const lines = ['👟 Gear & Shoes\n'];
  for (const g of gear) {
    const km = Math.round((g.total_distance_meters ?? 0) / 1000);
    const name = [g.brand_name, g.model_name, g.display_name].filter(Boolean).join(' ') || 'Unknown gear';
    const warn = km >= 700 ? ' 🚨 REPLACE NOW' : km >= 600 ? ' ⚠️ approaching limit' : '';
    lines.push(`${g.gear_type ?? 'Gear'}: ${name}`);
    lines.push(`  ${km}km · ${g.total_activities ?? '—'} activities · ${g.status ?? 'active'}${warn}`);
  }
  return lines.join('\n');
}

async function formatGarminWeekSummary() {
  const summary = await getGarminWeekSummary();
  const lines = ['📊 Garmin — past 7 days\n'];
  if (summary.avgSleepHours) lines.push(`😴 Sleep: avg ${summary.avgSleepHours}h · score ${summary.avgSleepScore ?? '—'} · poor nights: ${summary.poorSleepNights}`);
  if (summary.avgHRV) lines.push(`💓 HRV: avg ${summary.avgHRV}ms · ${summary.hrvTrend ?? '—'}`);
  if (summary.lowestBB) lines.push(`🔋 Lowest body battery: ${summary.lowestBB.lowest_value}% on ${summary.lowestBB.date}`);
  if (summary.avgRHR) lines.push(`❤️ Avg RHR: ${summary.avgRHR} bpm`);
  if (summary.trainingStatus) lines.push(`📈 Training status: ${summary.trainingStatus}`);
  if (summary.vo2max) {
    const change = summary.vo2maxLastWeek ? ` (${summary.vo2max > summary.vo2maxLastWeek ? '+' : ''}${(summary.vo2max - summary.vo2maxLastWeek).toFixed(1)} vs last week)` : '';
    lines.push(`🏆 VO2 Max: ${summary.vo2max}${change}`);
  }
  if (summary.totalSteps) lines.push(`👟 Steps: ${summary.totalSteps.toLocaleString()}`);
  if (summary.intensityMins != null) lines.push(`⚡ Intensity: ${summary.intensityMins}min / 150min WHO target`);
  if (summary.race) lines.push(`🏁 Race: 5K ${fmtRaceTime(summary.race.time_5k_secs)} · 10K ${fmtRaceTime(summary.race.time_10k_secs)}`);
  if (summary.gear?.length) {
    for (const g of summary.gear) {
      const km = Math.round((g.total_distance_meters ?? 0) / 1000);
      const name = [g.brand_name, g.model_name, g.display_name].filter(Boolean).join(' ') || 'Shoes';
      if (km >= 600) lines.push(`👟 ${name}: ${km}km${km >= 700 ? ' 🚨 replace!' : ' ⚠️ nearing limit'}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  syncGarminDay,
  syncGarminHistory,
  getLatestGarminData,
  getGarminWeekSummary,
  runSmartAlerts,
  formatGarminSnapshot,
  formatSleepDetail,
  formatReadiness,
  formatRecovery,
  formatVO2,
  formatRace,
  formatTraining,
  formatShoes,
  formatGarminWeekSummary,
  fmtSecs,
  fmtRaceTime,
};
