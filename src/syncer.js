/**
 * Lib2Dex Syncer
 *
 * Orchestrates the synchronization of glucose readings
 * from LibreView to Dexcom Share.
 */

const LibreViewClient = require('./libreview-client');
const DexcomClient = require('./dexcom-client');

class Syncer {
    constructor(config) {
        // LibreView configuration
        this.libreClient = new LibreViewClient(
            config.libreEmail,
            config.librePassword,
            config.libreRegion || ''
        );

        // Dexcom configuration
        this.dexcomClient = new DexcomClient(
            config.dexcomUsername,
            config.dexcomPassword,
            config.dexcomRegion || 'US'
        );

        // Set serial number for virtual receiver
        const serialNumber = config.serialNumber || this._generateSerialNumber();
        this.dexcomClient.setSerialNumber(serialNumber);

        // Sync settings
        this.syncInterval = (config.syncIntervalMinutes || 5) * 60 * 1000;
        this.maxReadings = config.maxReadingsPerSync || 12;

        // Track synced readings to avoid duplicates
        this.syncedTimestamps = new Set();
        this.lastSyncTime = null;

        // Statistics
        this.stats = {
            totalSynced: 0,
            totalSkipped: 0,
            errors: 0,
            lastSync: null,
            lastError: null
        };
    }

    /**
     * Generate a serial number for the virtual receiver
     */
    _generateSerialNumber() {
        // Format: LB-XXXXXX (Libre Bridge)
        const random = Math.random().toString(36).substring(2, 8).toUpperCase();
        return `LB-${random}`;
    }

    /**
     * Initialize connections
     */
    async initialize() {
        console.log('='.repeat(50));
        console.log('Lib2Dex - LibreView to Dexcom Share Sync');
        console.log('='.repeat(50));

        // Authenticate with LibreView
        console.log('\n[Init] Connecting to LibreView...');
        await this.libreClient.authenticate();

        // Authenticate with Dexcom
        console.log('\n[Init] Connecting to Dexcom Share...');
        await this.dexcomClient.authenticate();

        // Register as virtual receiver
        console.log('\n[Init] Registering virtual receiver...');
        await this.dexcomClient.registerReceiver();

        console.log('\n[Init] Initialization complete!');
        console.log(`[Init] Serial Number: ${this.dexcomClient.serialNumber}`);
        console.log(`[Init] Sync Interval: ${this.syncInterval / 60000} minutes`);
        console.log(`[Init] Max Readings: ${this.maxReadings}`);
    }

    /**
     * Perform a single sync operation
     */
    async sync() {
        console.log('\n' + '-'.repeat(50));
        console.log(`[Sync] Starting sync at ${new Date().toISOString()}`);

        try {
            // Get readings from LibreView
            const readings = await this.libreClient.getGlucoseReadings();

            if (readings.length === 0) {
                console.log('[Sync] No readings available from LibreView');
                this.stats.lastSync = new Date();
                return { synced: 0, skipped: 0 };
            }

            // Filter out already synced readings
            const newReadings = readings.filter(r => {
                const timestamp = r.timestamp.getTime();
                return !this.syncedTimestamps.has(timestamp);
            });

            // Limit number of readings
            const toSync = newReadings.slice(0, this.maxReadings);

            if (toSync.length === 0) {
                console.log('[Sync] All readings already synced');
                this.stats.lastSync = new Date();
                return { synced: 0, skipped: readings.length };
            }

            console.log(`[Sync] Found ${toSync.length} new readings to sync`);

            // Log the readings
            for (const r of toSync) {
                console.log(`  - ${r.timestamp.toISOString()}: ${r.value} mg/dL (trend: ${r.trend})`);
            }

            // Upload to Dexcom
            const result = await this.dexcomClient.uploadReadings(toSync);

            // Mark as synced
            for (const r of toSync) {
                this.syncedTimestamps.add(r.timestamp.getTime());
            }

            // Cleanup old timestamps (keep last 24 hours)
            this._cleanupSyncedTimestamps();

            // Update stats
            this.stats.totalSynced += result.uploaded;
            this.stats.totalSkipped += readings.length - toSync.length;
            this.stats.lastSync = new Date();

            console.log(`[Sync] Completed: ${result.uploaded} uploaded, ${readings.length - toSync.length} skipped`);

            return {
                synced: result.uploaded,
                skipped: readings.length - toSync.length
            };

        } catch (error) {
            console.error(`[Sync] Error: ${error.message}`);
            this.stats.errors++;
            this.stats.lastError = error.message;
            throw error;
        }
    }

    /**
     * Cleanup old synced timestamps (older than 24 hours)
     */
    _cleanupSyncedTimestamps() {
        const cutoff = Date.now() - (24 * 60 * 60 * 1000);
        const oldSize = this.syncedTimestamps.size;

        for (const ts of this.syncedTimestamps) {
            if (ts < cutoff) {
                this.syncedTimestamps.delete(ts);
            }
        }

        const removed = oldSize - this.syncedTimestamps.size;
        if (removed > 0) {
            console.log(`[Sync] Cleaned up ${removed} old timestamp entries`);
        }
    }

    /**
     * Run in daemon mode (continuous sync)
     */
    async runDaemon() {
        await this.initialize();

        console.log('\n[Daemon] Starting continuous sync...');
        console.log('[Daemon] Press Ctrl+C to stop\n');

        // Perform initial sync
        await this.sync();

        // Schedule periodic syncs
        const syncLoop = async () => {
            try {
                await this.sync();
            } catch (error) {
                console.error(`[Daemon] Sync error: ${error.message}`);
                // Continue running despite errors
            }

            // Schedule next sync
            setTimeout(syncLoop, this.syncInterval);
        };

        // Start the loop
        setTimeout(syncLoop, this.syncInterval);

        // Handle graceful shutdown
        process.on('SIGINT', () => {
            console.log('\n[Daemon] Shutting down...');
            console.log(`[Daemon] Total synced: ${this.stats.totalSynced}`);
            console.log(`[Daemon] Total errors: ${this.stats.errors}`);
            process.exit(0);
        });
    }

    /**
     * Run once (single sync)
     */
    async runOnce() {
        await this.initialize();
        const result = await this.sync();
        console.log('\n[Done] Single sync completed');
        return result;
    }

    /**
     * Test connections
     */
    async testConnections() {
        console.log('='.repeat(50));
        console.log('Lib2Dex - Connection Test');
        console.log('='.repeat(50));

        // Test LibreView
        console.log('\n[Test] Testing LibreView connection...');
        const libreResult = await this.libreClient.testConnection();

        if (libreResult.success) {
            console.log('[Test] LibreView: OK');
            console.log(`  - Region: ${libreResult.region || 'auto'}`);
            console.log(`  - Connections: ${libreResult.connections}`);
            if (libreResult.latestReading) {
                console.log(`  - Latest: ${libreResult.latestReading.value} mg/dL at ${libreResult.latestReading.timestamp.toISOString()}`);
            }
        } else {
            console.log(`[Test] LibreView: FAILED - ${libreResult.error}`);
        }

        // Test Dexcom
        console.log('\n[Test] Testing Dexcom Share connection...');
        const dexcomResult = await this.dexcomClient.testConnection();

        if (dexcomResult.success) {
            console.log('[Test] Dexcom Share: OK');
            console.log(`  - Region: ${dexcomResult.region}`);
            console.log(`  - Has Data: ${dexcomResult.hasData}`);
        } else {
            console.log(`[Test] Dexcom Share: FAILED - ${dexcomResult.error}`);
        }

        console.log('\n' + '='.repeat(50));

        return {
            libreview: libreResult,
            dexcom: dexcomResult,
            allOk: libreResult.success && dexcomResult.success
        };
    }

    /**
     * Verify data was uploaded correctly
     */
    async verify() {
        await this.initialize();

        console.log('\n[Verify] Checking uploaded data...');

        // Get latest from Dexcom
        const dexcomValues = await this.dexcomClient.readLatestValues(5, 60);

        if (dexcomValues.length === 0) {
            console.log('[Verify] No data found in Dexcom Share');
            return false;
        }

        console.log('[Verify] Latest Dexcom Share values:');
        for (const v of dexcomValues) {
            // Parse Dexcom date format
            const match = v.ST.match(/\/Date\((\d+)\)\//);
            const date = match ? new Date(parseInt(match[1])) : 'Unknown';
            console.log(`  - ${date.toISOString ? date.toISOString() : date}: ${v.Value} mg/dL`);
        }

        return true;
    }

    /**
     * Get current statistics
     */
    getStats() {
        return {
            ...this.stats,
            syncedTimestampsCount: this.syncedTimestamps.size,
            serialNumber: this.dexcomClient.serialNumber
        };
    }
}

module.exports = Syncer;
