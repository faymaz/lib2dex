#!/usr/bin/env node

/**
 * Lib2Dex - LibreView to Dexcom Share Sync
 *
 * Synchronizes glucose readings from FreeStyle Libre (via LibreView/LibreLinkUp)
 * to Dexcom Share accounts.
 *
 * Usage:
 *   lib2dex --daemon    Run in continuous sync mode
 *   lib2dex --once      Run a single sync and exit
 *   lib2dex --test      Test connections without syncing
 *   lib2dex --verify    Verify uploaded data
 *   lib2dex --help      Show help
 */

require('dotenv').config();

const Syncer = require('./src/syncer');

// Parse command line arguments
const args = process.argv.slice(2);

// Show help
function showHelp() {
    console.log(`
Lib2Dex - LibreView to Dexcom Share Sync

USAGE:
  lib2dex [OPTIONS]

OPTIONS:
  --daemon      Run in continuous sync mode (default)
  --once        Run a single sync and exit
  --test        Test connections without syncing
  --verify      Verify uploaded data in Dexcom Share
  --help        Show this help message

ENVIRONMENT VARIABLES (create .env file):
  SOURCE_EMAIL             LibreView/LibreLinkUp email (follower account)
  SOURCE_PASSWORD          LibreView/LibreLinkUp password
  SOURCE_REGION            LibreView region (eu, us, de, etc.)

  DEST_USERNAME            Dexcom Share username
  DEST_PASSWORD            Dexcom Share password
  DEST_REGION              Dexcom region: us or ous (default: ous)

  SYNC_INTERVAL_MINUTES    Sync interval in minutes (default: 5)
  MAX_READINGS_PER_SYNC    Max readings per sync (default: 12)
  SERIAL_NUMBER            Virtual receiver serial (auto-generated)
  LOG_LEVEL                Logging level: info, debug (default: info)

EXAMPLE:
  # Create .env file with credentials
  cp .env.example .env
  # Edit .env with your credentials
  nano .env
  # Run in daemon mode
  lib2dex --daemon

NOTES:
  - LibreLinkUp requires a follower account (not the primary Libre account)
  - Set up follower sharing in the LibreLinkUp mobile app first
  - Dexcom Share must have sharing enabled

For more information: https://github.com/faymaz/lib2dex
`);
}

// Validate configuration
function validateConfig() {
    const required = [
        'SOURCE_EMAIL',
        'SOURCE_PASSWORD',
        'DEST_USERNAME',
        'DEST_PASSWORD'
    ];

    const missing = required.filter(key => !process.env[key]);

    if (missing.length > 0) {
        console.error('ERROR: Missing required environment variables:');
        missing.forEach(key => console.error(`  - ${key}`));
        console.error('\nCreate a .env file with these variables or set them in your environment.');
        console.error('See .env.example for a template.\n');
        process.exit(1);
    }

    return {
        libreEmail: process.env.SOURCE_EMAIL,
        librePassword: process.env.SOURCE_PASSWORD,
        libreRegion: process.env.SOURCE_REGION || '',
        dexcomUsername: process.env.DEST_USERNAME,
        dexcomPassword: process.env.DEST_PASSWORD,
        dexcomRegion: process.env.DEST_REGION || 'ous',
        syncIntervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES) || 5,
        maxReadingsPerSync: parseInt(process.env.MAX_READINGS_PER_SYNC) || 12,
        serialNumber: process.env.SERIAL_NUMBER || null,
        logLevel: process.env.LOG_LEVEL || 'info'
    };
}

// Main entry point
async function main() {
    // Handle --help
    if (args.includes('--help') || args.includes('-h')) {
        showHelp();
        return;
    }

    // Validate configuration
    const config = validateConfig();

    // Create syncer
    const syncer = new Syncer(config);

    try {
        // Handle --test
        if (args.includes('--test')) {
            const result = await syncer.testConnections();
            process.exit(result.allOk ? 0 : 1);
            return;
        }

        // Handle --verify
        if (args.includes('--verify')) {
            const ok = await syncer.verify();
            process.exit(ok ? 0 : 1);
            return;
        }

        // Handle --once
        if (args.includes('--once')) {
            await syncer.runOnce();
            process.exit(0);
            return;
        }

        // Default: --daemon mode
        await syncer.runDaemon();

    } catch (error) {
        console.error(`\nFATAL ERROR: ${error.message}`);
        if (process.env.DEBUG) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

// Startup delay to prevent hammering API on PM2 restarts
const fs = require('fs');
const path = require('path');
const CRASH_FILE = '/tmp/lib2dex-crash-state.json';

async function checkStartupDelay() {
    try {
        let state = { lastCrash: 0, crashCount: 0 };

        if (fs.existsSync(CRASH_FILE)) {
            state = JSON.parse(fs.readFileSync(CRASH_FILE, 'utf8'));
        }

        const timeSinceLastCrash = Date.now() - state.lastCrash;
        const fiveMinutes = 5 * 60 * 1000;

        // Reset crash count if last crash was more than 5 minutes ago
        if (timeSinceLastCrash > fiveMinutes) {
            state.crashCount = 0;
        }

        // Calculate delay based on consecutive crashes (exponential backoff)
        // 1st crash: 2 min, 2nd: 4 min, 3rd: 8 min, max: 15 min
        if (state.crashCount > 0) {
            const baseDelay = 2 * 60 * 1000; // 2 minutes
            const maxDelay = 15 * 60 * 1000; // 15 minutes max
            const delay = Math.min(baseDelay * Math.pow(2, state.crashCount - 1), maxDelay);
            const remainingDelay = Math.max(0, delay - timeSinceLastCrash);

            if (remainingDelay > 0) {
                console.log(`[Startup] Crash #${state.crashCount} detected. Waiting ${Math.round(remainingDelay/1000)}s before retry...`);
                console.log(`[Startup] This prevents Cloudflare rate limiting. Do NOT restart manually.`);
                await new Promise(resolve => setTimeout(resolve, remainingDelay));
            }
        }
    } catch (e) {
        // Ignore errors
    }
}

function recordCrash() {
    try {
        let state = { lastCrash: 0, crashCount: 0 };

        if (fs.existsSync(CRASH_FILE)) {
            try {
                state = JSON.parse(fs.readFileSync(CRASH_FILE, 'utf8'));
            } catch (e) { /* ignore */ }
        }

        const timeSinceLastCrash = Date.now() - state.lastCrash;
        const fiveMinutes = 5 * 60 * 1000;

        // Reset count if last crash was > 5 min ago
        if (timeSinceLastCrash > fiveMinutes) {
            state.crashCount = 0;
        }

        state.lastCrash = Date.now();
        state.crashCount++;

        fs.writeFileSync(CRASH_FILE, JSON.stringify(state));
    } catch (e) {
        // Ignore errors
    }
}

function clearCrashState() {
    try {
        if (fs.existsSync(CRASH_FILE)) {
            fs.unlinkSync(CRASH_FILE);
        }
    } catch (e) { /* ignore */ }
}

// Run with crash protection
checkStartupDelay().then(() => {
    main().then(() => {
        // Successful run, clear crash state
        clearCrashState();
    }).catch(err => {
        recordCrash();
        console.error(`FATAL ERROR: ${err.message}`);
        process.exit(1);
    });
});
