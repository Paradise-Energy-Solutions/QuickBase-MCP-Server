#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.stdoutMuted = false;
rl._writeToOutput = function _writeToOutput(stringToWrite) {
  if (this.stdoutMuted) {
    if (stringToWrite.includes('\n') || stringToWrite.includes('\r')) {
      this.output.write(stringToWrite.replace(/[^\r\n]/g, ''));
    } else {
      this.output.write('*');
    }
    return;
  }
  this.output.write(stringToWrite);
};

function question(prompt, { mask = false } = {}) {
  return new Promise((resolve) => {
    rl.stdoutMuted = mask;
    rl.question(prompt, (answer) => {
      rl.stdoutMuted = false;
      resolve(answer);
    });
  });
}

async function collectApps() {
  const apps = [];
  console.log('\n📱 QuickBase App Registration:');
  console.log('   You must register at least one app.');
  console.log('   To find an App ID: open the app in QuickBase — the URL will be');
  console.log('   https://<realm>/db/<appId>  (e.g. bxxxxxxxxx)\n');

  let addAnother = true;
  while (addAnother) {
    const appNum = apps.length + 1;
    console.log(`   App #${appNum}:`);
    const appId = (await question(`     App ID (e.g. bxxxxxxxxx): `)).trim();
    const appName = (await question(`     App Name (human-readable label): `)).trim();
    const readOnlyRaw = (await question(`     Read-only? Blocks all writes. (Y/n, default Y): `)).trim().toLowerCase();
    const allowDestructiveRaw = (await question(`     Allow destructive (delete) operations? (y/N, default N): `)).trim().toLowerCase();

    if (!appId || !appName) {
      console.log('   ⚠️  App ID and Name are required — skipping this entry.\n');
    } else {
      const readOnly = readOnlyRaw === 'n' ? false : true;
      const allowDestructive = allowDestructiveRaw === 'y' ? true : false;
      apps.push({ appId, appName, readOnly, allowDestructive });
      console.log(`   ✅ Registered: ${appName} (${appId})  readOnly=${readOnly}  allowDestructive=${allowDestructive}\n`);
    }

    const continueAdding = (await question('   Add another app? (y/N): ')).trim().toLowerCase();
    addAnother = continueAdding === 'y';
  }

  return apps;
}

async function setup() {
  console.log('🚀 QuickBase MCP Server Setup\n');
  console.log('This script will help you configure your QuickBase MCP server.\n');

  // Check if .env already exists
  if (existsSync('.env')) {
    const overwrite = await question('📁 .env file already exists. Overwrite? (y/N): ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('✅ Setup cancelled. Using existing .env file.');
      rl.close();
      return;
    }
  }

  try {
    // Get QuickBase configuration
    console.log('📋 QuickBase Configuration:');
    const realm = (await question('   QuickBase Realm (e.g., yourcompany.quickbase.com): ')).trim();
    const userToken = await question('   User Token (input hidden): ', { mask: true });

    // Optional settings
    console.log('\n⚙️  Optional Settings (press Enter for defaults):');
    const timeout = await question('   Timeout in ms (default: 30000): ') || '30000';
    const maxRetries = await question('   Max retries (default: 3): ') || '3';
    const serverName = await question('   Server name (default: quickbase-mcp): ') || 'quickbase-mcp';

    // Validate required fields
    if (!realm || !userToken) {
      console.error('❌ Error: Realm and User Token are required!');
      rl.close();
      process.exit(1);
    }

    // Collect apps
    const apps = await collectApps();
    if (apps.length === 0) {
      console.error('❌ Error: At least one app must be registered. Exiting.');
      rl.close();
      process.exit(1);
    }

    // Build app registry lines
    const appLines = apps.map(({ appId, appName, readOnly, allowDestructive }) =>
      `QB_APP_${appId}_NAME=${appName}\nQB_APP_${appId}_READONLY=${readOnly}\nQB_APP_${appId}_ALLOW_DESTRUCTIVE=${allowDestructive}`
    ).join('\n\n');

    // Create .env content
    const envContent = `# QuickBase Configuration
QB_REALM=${realm}
QB_USER_TOKEN=${userToken}

# Optional: Default settings
QB_DEFAULT_TIMEOUT=${timeout}
QB_MAX_RETRIES=${maxRetries}

# MCP Server Configuration
MCP_SERVER_NAME=${serverName}
MCP_SERVER_VERSION=1.0.0

# Registered QuickBase Applications
# The server discovers apps by scanning for QB_APP_<id>_NAME entries.
# At least one app must be registered for the server to start.
# App IDs are the alphanumeric segment after /db/ in the QuickBase app URL.
#
# Per-app safety flags:
#   QB_APP_<id>_READONLY          default: true   — blocks all write operations
#   QB_APP_<id>_ALLOW_DESTRUCTIVE default: false  — blocks delete operations
${appLines}
`;

    // Write .env file
    writeFileSync('.env', envContent, { mode: 0o600 });
    console.log('\n✅ .env file created successfully!');
    console.log('⚠️  Security notice: This .env file contains your user token.');
    console.log('    Keep it private. Do NOT commit it to version control.');

    // Test connection
    console.log('\n🔍 Testing connection to first registered app...');
    try {
      const { QuickBaseClient } = await import('./dist/quickbase/client.js');
      const firstApp = apps[0];
      const client = new QuickBaseClient({
        realm,
        userToken,
        appId: firstApp.appId,
        timeout: parseInt(timeout),
        maxRetries: parseInt(maxRetries)
      });

      const connected = await client.testConnection();
      if (connected) {
        console.log('✅ Connection successful!');
        const appInfo = await client.getAppInfo();
        console.log(`📱 Connected to app: ${appInfo.name || firstApp.appName}`);
        const tables = await client.getAppTables();
        console.log(`📊 Found ${tables.length} tables`);
      } else {
        console.log('❌ Connection failed. Please check your credentials.');
      }
    } catch (error) {
      console.log('⚠️  Could not test connection (server may need to be built first)');
      console.log('   Run: npm run build && npm start');
    }

    console.log('\n🎉 Setup complete! Next steps:');
    console.log('   1. Build the server: npm run build');
    console.log('   2. Start the server: npm start');
    console.log('   3. Add to your MCP client configuration (see README.md)');
    console.log('   4. Call quickbase_list_apps to verify your registered apps');
    console.log('\n📖 See README.md for detailed usage instructions.');

  } catch (error) {
    console.error('❌ Setup failed:', error.message);
    process.exit(1);
  }

  rl.close();
}

setup().catch(console.error);


const rl = createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.stdoutMuted = false;
rl._writeToOutput = function _writeToOutput(stringToWrite) {
  if (this.stdoutMuted) {
    if (stringToWrite.includes('\n') || stringToWrite.includes('\r')) {
      this.output.write(stringToWrite.replace(/[^\r\n]/g, ''));
    } else {
      this.output.write('*');
    }
    return;
  }
  this.output.write(stringToWrite);
};

function question(prompt, { mask = false } = {}) {
  return new Promise((resolve) => {
    rl.stdoutMuted = mask;
    rl.question(prompt, (answer) => {
      rl.stdoutMuted = false;
      resolve(answer);
    });
  });
}

async function setup() {
  console.log('🚀 QuickBase MCP Server Setup\n');
  console.log('This script will help you configure your QuickBase MCP server.\n');

  // Check if .env already exists
  if (existsSync('.env')) {
    const overwrite = await question('📁 .env file already exists. Overwrite? (y/N): ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('✅ Setup cancelled. Using existing .env file.');
      rl.close();
      return;
    }
  }

  try {
    // Get QuickBase configuration
    console.log('📋 QuickBase Configuration:');
    const realm = (await question('   QuickBase Realm (e.g., yourcompany.quickbase.com): ')).trim();
    const userToken = await question('   User Token (input hidden): ', { mask: true });
    const appId = (await question('   App ID (e.g., bxxxxxxxx): ')).trim();

    // Optional settings
    console.log('\n⚙️  Optional Settings (press Enter for defaults):');
    const timeout = await question('   Timeout in ms (default: 30000): ') || '30000';
    const maxRetries = await question('   Max retries (default: 3): ') || '3';
    const serverName = await question('   Server name (default: quickbase-mcp): ') || 'quickbase-mcp';

    // Validate required fields
    if (!realm || !userToken || !appId) {
      console.error('❌ Error: Realm, User Token, and App ID are required!');
      rl.close();
      process.exit(1);
    }

    // Create .env content
    const envContent = `# QuickBase Configuration
QB_REALM=${realm}
QB_USER_TOKEN=${userToken}
QB_APP_ID=${appId}

# Optional: Default settings
QB_DEFAULT_TIMEOUT=${timeout}
QB_MAX_RETRIES=${maxRetries}

# MCP Server Configuration
MCP_SERVER_NAME=${serverName}
MCP_SERVER_VERSION=1.0.0
`;

    // Write .env file
    writeFileSync('.env', envContent, { mode: 0o600 });
    console.log('\n✅ .env file created successfully!');
    console.log('⚠️  Security notice: This .env file contains sensitive credentials (your user token).');
    console.log('    Keep it private. Do NOT commit it to version control. Add ".env" to your .gitignore.');

    // Test connection
    console.log('\n🔍 Testing connection...');
    try {
      const { QuickBaseClient } = await import('./dist/quickbase/client.js');
      const client = new QuickBaseClient({
        realm,
        userToken,
        appId,
        timeout: parseInt(timeout),
        maxRetries: parseInt(maxRetries)
      });
      
      const connected = await client.testConnection();
      if (connected) {
        console.log('✅ Connection successful!');
        
        // Get app info
        const appInfo = await client.getAppInfo();
        console.log(`📱 Connected to app: ${appInfo.name || 'Unknown'}`);
        
        const tables = await client.getAppTables();
        console.log(`📊 Found ${tables.length} tables`);
      } else {
        console.log('❌ Connection failed. Please check your credentials.');
      }
    } catch (error) {
      console.log('⚠️  Could not test connection (server may need to be built first)');
      console.log('   Run: npm run build && npm start');
    }

    console.log('\n🎉 Setup complete! Next steps:');
    console.log('   1. Build the server: npm run build');
    console.log('   2. Start the server: npm start');
    console.log('   3. Add to your MCP client configuration');
    console.log('\n📖 See README.md for detailed usage instructions.');

  } catch (error) {
    console.error('❌ Setup failed:', error.message);
    process.exit(1);
  }

  rl.close();
}

setup().catch(console.error); 