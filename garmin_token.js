'use strict';

require('dotenv').config({ path: '_env' });
const { GarminConnect } = require('garmin-connect');
const fs = require('fs');

(async () => {
  const gc = new GarminConnect({
    username: process.env.GARMIN_USERNAME,
    password: process.env.GARMIN_PASSWORD,
  });

  console.log('Logging in to Garmin...');
  await gc.login();

  const tokens = gc.exportToken();
  console.log('\n✅ Login successful! Copy these into Railway:\n');
  console.log('GARMIN_OAUTH1=' + JSON.stringify(tokens.oauth1));
  console.log('GARMIN_OAUTH2=' + JSON.stringify(tokens.oauth2));

  fs.writeFileSync('.garmin_token', tokens.oauth2.access_token, 'utf8');
  console.log('\n✅ Access token saved to .garmin_token (used by garmin_test.js)');
  console.log('\nDone.');
})().catch(err => {
  console.error('❌ Login failed:', err.message);
  process.exit(1);
});
