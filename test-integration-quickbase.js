import axios from 'axios';
import dotenv from 'dotenv';
import { existsSync } from 'fs';

dotenv.config();

async function testDirectAPI() {
  console.log('🔍 Testing Direct QuickBase API Access...\n');

  if (!existsSync('.env')) {
    throw new Error('Missing .env file. Create one by copying env.example to .env, then set QB_REALM, QB_USER_TOKEN, QB_APP_ID, and QB_TEST_TABLE_ID.');
  }

  const requiredEnvVars = ['QB_REALM', 'QB_USER_TOKEN', 'QB_APP_ID', 'QB_TEST_TABLE_ID'];
  const missingEnvVars = requiredEnvVars.filter((name) => !process.env[name] || String(process.env[name]).trim() === '');
  if (missingEnvVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingEnvVars.join(', ')}. Update .env (see env.example) and re-run.`);
  }

  const config = {
    realm: process.env.QB_REALM,
    userToken: process.env.QB_USER_TOKEN,
    appId: process.env.QB_APP_ID,
    leadsTableId: process.env.QB_TEST_TABLE_ID
  };

  console.log('Configuration:');
  console.log(`  Realm: ${config.realm}`);
  console.log(`  App ID: ${config.appId}`);
  console.log(`  Token: ${config.userToken ? '***' + config.userToken.slice(-4) : 'Missing'}`);
  console.log(`  Leads Table ID: ${config.leadsTableId}\n`);

  const baseURL = `https://api.quickbase.com/v1`;
  console.log(`Base URL: ${baseURL}\n`);

  const headers = {
    'QB-Realm-Hostname': config.realm,
    'User-Agent': 'QuickBase-MCP-Test/1.0.0',
    'Authorization': `QB-USER-TOKEN ${config.userToken}`,
    'Content-Type': 'application/json'
  };

  try {
    // Test 1: Get table schema
    console.log('🔧 Test 1: Getting table schema...');
    const schemaResponse = await axios.get(
      `${baseURL}/tables/${config.leadsTableId}?appId=${config.appId}`,
      { headers }
    );
    console.log('✅ Table schema retrieved successfully');
    console.log(`   Table Name: ${schemaResponse.data.name}`);
    console.log(`   Table ID: ${schemaResponse.data.id}`);
    console.log(`   Record Count: ${schemaResponse.data.sizeLimit || 'Unknown'}\n`);

    // Test 2: Get table fields
    console.log('🔧 Test 2: Getting table fields...');
    const fieldsResponse = await axios.get(
      `${baseURL}/fields?tableId=${config.leadsTableId}&appId=${config.appId}`,
      { headers }
    );
    console.log(`✅ Found ${fieldsResponse.data.length} fields`);
    
    // Show first 5 fields
    fieldsResponse.data.slice(0, 5).forEach(field => {
      console.log(`   - ${field.label} (ID: ${field.id}, Type: ${field.fieldType})`);
    });
    console.log('   ...\n');

    // Test 3: Query some records
    console.log('🔧 Test 3: Querying records...');
    const recordsResponse = await axios.post(
      `${baseURL}/records/query`,
      {
        from: config.leadsTableId,
        select: [3, 6, 18], // Record ID, Lead Name, Customer Name
        options: {
          top: 5
        }
      },
      { headers }
    );
    
    console.log(`✅ Found ${recordsResponse.data.data.length} records`);
    recordsResponse.data.data.forEach((record, index) => {
      const recordId = record['3']?.value || 'N/A';
      const leadName = record['6']?.value || 'N/A';
      const customerName = record['18']?.value || 'N/A';
      console.log(`   ${index + 1}. Record ${recordId}: ${leadName} (${customerName})`);
    });

    console.log('\n🎉 All tests passed! QuickBase API access is working correctly.');
    console.log('\n📋 Summary:');
    console.log('   - Table access: ✅');
    console.log('   - Field metadata: ✅');
    console.log('   - Record queries: ✅');
    console.log('\nYour QuickBase MCP server should work correctly with these credentials.');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Status Text:', error.response.statusText);
      console.error('   Data:', JSON.stringify(error.response.data, null, 2));
    }
    
    if (error.response?.status === 401) {
      console.log('\n💡 Suggestion: Check your user token permissions');
    } else if (error.response?.status === 403) {
      console.log('\n💡 Suggestion: Your token may not have access to this app/table');
    } else if (error.response?.status === 404) {
      console.log('\n💡 Suggestion: Check if the table ID or app ID is correct');
    }
  }
}

testDirectAPI().catch(console.error);