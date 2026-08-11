const crypto = require('crypto');

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const BASE_URL = process.env.MOMO_BASE_URL || 'https://sandbox.momodeveloper.mtn.com';
const HOST = process.env.MOMO_CALLBACK_HOST || 'localhost';

async function provisionProduct(productName, subscriptionKey) {
  console.log(`\n--- Provisioning keys for ${productName} ---`);
  
  // 1. Generate a new UUID for the API User
  const apiUserId = crypto.randomUUID();
  console.log(`Generated new API User ID: ${apiUserId}`);

  // 2. Create the API User
  console.log('Creating API User on MTN Sandbox...');
  const createRes = await fetch(`${BASE_URL}/v1_0/apiuser`, {
    method: 'POST',
    headers: {
      'X-Reference-Id': apiUserId,
      'Ocp-Apim-Subscription-Key': subscriptionKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      providerCallbackHost: HOST
    })
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Failed to create API User: ${createRes.status} ${createRes.statusText} - ${errText}`);
  }
  console.log('✅ API User created successfully!');

  // 3. Generate API Key
  console.log('Requesting new API Key...');
  const keyRes = await fetch(`${BASE_URL}/v1_0/apiuser/${apiUserId}/apikey`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': subscriptionKey
    }
  });

  if (!keyRes.ok) {
    const errText = await keyRes.text();
    throw new Error(`Failed to generate API Key: ${keyRes.status} ${keyRes.statusText} - ${errText}`);
  }

  const keyData = await keyRes.json();
  const apiKey = keyData.apiKey;
  console.log('✅ API Key generated successfully!');

  return { apiUserId, apiKey };
}

async function main() {
  try {
    const colSubKey = process.env.MOMO_COLLECTION_SUBSCRIPTION_KEY;
    const disSubKey = process.env.MOMO_DISBURSEMENT_SUBSCRIPTION_KEY;

    if (!colSubKey || !disSubKey) {
      throw new Error('Missing MOMO_COLLECTION_SUBSCRIPTION_KEY or MOMO_DISBURSEMENT_SUBSCRIPTION_KEY in .env');
    }

    const collection = await provisionProduct('COLLECTION', colSubKey);
    const disbursement = await provisionProduct('DISBURSEMENT', disSubKey);

    console.log('\n\n=================================================');
    console.log('🎉 SUCCESS! Replace the following lines in your server/.env file:');
    console.log('=================================================\n');
    console.log(`MOMO_COLLECTION_API_USER=${collection.apiUserId}`);
    console.log(`MOMO_COLLECTION_API_KEY=${collection.apiKey}`);
    console.log(`\nMOMO_DISBURSEMENT_API_USER=${disbursement.apiUserId}`);
    console.log(`MOMO_DISBURSEMENT_API_KEY=${disbursement.apiKey}`);
    console.log('\n=================================================');
    console.log('Then restart your server for the changes to take effect!');
    
  } catch (error) {
    console.error('\n❌ PROVISIONING ERROR:', error.message);
  }
}

main();
