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
       
        this.libreClient = new LibreViewClient(
            config.libreEmail,
            config.librePassword,
            config.libreRegion || ''
        );

       
        this.dexcomClient = new DexcomClient(
            config.dexcomUsername,
            config.dexcomPassword,
            config.dexcomRegion || 'US'
        );

       
        const serialNumber = config.serialNumber || this._generateSerialNumber();
        this.dexcomClient.setSerialNumber(serialNumber);

       
        this.syncInterval = (config.syncIntervalMinutes || 5) * 60 * 1000;
        this.maxReadings = config.maxReadingsPerSync || 12;

       
        this.syncedTimestamps = new Set();
        this.lastSyncTime = null;

       
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
     * Format: SM + 8 digits (matching Dexcom receiver format)
     */
    _generateSerialNumber() {
       
        const hash = this.dexcomClient.username.split('').reduce((acc, char) => {
            return ((acc << 5) - acc) + char.charCodeAt(0);
        }, 0);
        const absHash = Math.abs(hash);
        return `SM${absHash.toString().padStart(8, '0').slice(0, 8)}`;
    }

    /**
     * Initialize connections
     */
    async initialize() {
        console.log('');
        console.log('Lib2Dex - LibreView to Dexcom Share Sync');
        console.log('-'.repeat(42));

       
        console.log('[Init] Connecting to LibreView...');
        await this.libreClient.authenticate();

       
        console.log('[Init] Connecting to Dexcom Share...');
        await this.dexcomClient.authenticate();

        console.log('[Init] Ready!');
        console.log(`       Serial: ${this.dexcomClient.serialNumber} | Interval: ${this.syncInterval / 60000}min`);
    }

    /**
     * Perform a single sync operation
     */
    async sync() {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        console.log(`\n[Sync] ${timeStr} - Starting...`);

        try {
           
            const readings = await this.libreClient.getGlucoseReadings();

            if (readings.length === 0) {
                console.log('[Sync] No readings available from LibreView');
                this.stats.lastSync = new Date();
                return { synced: 0, skipped: 0 };
            }

           
            const newReadings = readings.filter(r => {
                const timestamp = r.timestamp.getTime();
                return !this.syncedTimestamps.has(timestamp);
            });

           
            const toSync = newReadings.slice(0, this.maxReadings);

            if (toSync.length === 0) {
                console.log('[Sync] No new readings');
                this.stats.lastSync = new Date();
                return { synced: 0, skipped: readings.length };
            }

           
            const latest = toSync[0];
            console.log(`[Sync] Latest: ${latest.value} mg/dL | Syncing ${toSync.length} readings...`);

           
            const result = await this.dexcomClient.uploadReadings(toSync);

           
            try {
                const dexcomValues = await this.dexcomClient.readLatestValues(1, 60);
                if (dexcomValues.length > 0) {
                    const dexVal = dexcomValues[0];
                    const match = dexVal.ST && dexVal.ST.match(/Date\((\d+)\)/);
                    const dexTime = match ? new Date(parseInt(match[1])) : null;
                    const latestTime = latest.timestamp;
                    const timeDiff = dexTime ? Math.abs(dexTime - latestTime) / 1000 : -1;

                    if (dexVal.Value === latest.value && timeDiff < 60) {
                        console.log(`[Sync] Verified: ${dexVal.Value} mg/dL in Dexcom`);
                    } else {
                        console.log(`[Sync] Warning: Dexcom shows ${dexVal.Value} mg/dL, expected ${latest.value}`);
                    }
                }
            } catch (e) {
               
            }

           
            for (const r of toSync) {
                this.syncedTimestamps.add(r.timestamp.getTime());
            }

           
            this._cleanupSyncedTimestamps();

           
            this.stats.totalSynced += result.uploaded;
            this.stats.totalSkipped += readings.length - toSync.length;
            this.stats.lastSync = new Date();

            console.log(`[Sync] Done: ${result.uploaded} synced`);

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

        console.log('[Daemon] Running... (Ctrl+C to stop)');

       
        await this.sync();

       
        const syncLoop = async () => {
            try {
                await this.sync();
            } catch (error) {
                console.error(`[Daemon] Sync error: ${error.message}`);
               
            }

           
            setTimeout(syncLoop, this.syncInterval);
        };

       
        setTimeout(syncLoop, this.syncInterval);

       
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

       
        const dexcomValues = await this.dexcomClient.readLatestValues(5, 60);

        if (dexcomValues.length === 0) {
            console.log('[Verify] No data found in Dexcom Share');
            return false;
        }

        console.log('[Verify] Latest Dexcom Share values:');
        for (const v of dexcomValues) {
           
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
