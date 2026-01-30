/**
 * Dexcom Share API Client
 *
 * Handles authentication and data upload to Dexcom Share service.
 * Supports both US and international (OUS) regions.
 */

const https = require('https');

// Dexcom Share base URLs
const DEXCOM_URLS = {
    US: 'share2.dexcom.com',
    OUS: 'shareous1.dexcom.com',
    JP: 'shareous1.dexcom.com'
};

// Dexcom application ID (required for API access)
const APPLICATION_ID = 'd89443d2-327c-4a6f-89e5-496bbb0317db';

// Trend mapping from LibreView (1-7) to Dexcom numeric format
// LibreView: 1=falling fast, 4=flat, 7=rising fast
// Dexcom: 1=rising fast, 4=flat, 7=falling fast (inverted!)
const LIBRE_TO_DEXCOM_TREND = {
    1: 7,  
    2: 6,  
    3: 5,  
    4: 4,  
    5: 3,  
    6: 2,  
    7: 1   
};

class DexcomClient {
    constructor(username, password, region = 'US') {
        this.username = username;
        this.password = password;
        this.region = region.toUpperCase();
        this.baseUrl = DEXCOM_URLS[this.region] || DEXCOM_URLS.US;
        this.sessionId = null;
        this.accountId = null;
        this.serialNumber = null;
    }

    /**
     * Make an HTTPS request
     */
    _request(method, path, data = null) {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: this.baseUrl,
                port: 443,
                path: path,
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'User-Agent': 'Dexcom Share/3.0.2.11'
                }
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                       
                        if (!body || body.trim() === '') {
                            resolve({ status: res.statusCode, data: null });
                            return;
                        }
                        const json = JSON.parse(body);
                        resolve({ status: res.statusCode, data: json });
                    } catch (e) {
                       
                        resolve({ status: res.statusCode, data: body });
                    }
                });
            });

            req.on('error', reject);

            if (data) {
                req.write(JSON.stringify(data));
            }
            req.end();
        });
    }

    /**
     * Authenticate with Dexcom Share (Step 1: Get Account ID)
     */
    async _authenticateAccount() {
        const response = await this._request(
            'POST',
            '/ShareWebServices/Services/General/AuthenticatePublisherAccount',
            {
                accountName: this.username,
                password: this.password,
                applicationId: APPLICATION_ID
            }
        );

        if (response.status !== 200 || !response.data) {
            throw new Error(`Account authentication failed: ${JSON.stringify(response.data)}`);
        }

       
        this.accountId = response.data.replace(/"/g, '');
        return this.accountId;
    }

    /**
     * Authenticate with Dexcom Share (Step 2: Get Session ID)
     */
    async _authenticateSession() {
        if (!this.accountId) {
            await this._authenticateAccount();
        }

        const response = await this._request(
            'POST',
            '/ShareWebServices/Services/General/LoginPublisherAccountById',
            {
                accountId: this.accountId,
                password: this.password,
                applicationId: APPLICATION_ID
            }
        );

        if (response.status !== 200 || !response.data) {
            throw new Error(`Session authentication failed: ${JSON.stringify(response.data)}`);
        }

       
        this.sessionId = response.data.replace(/"/g, '');
        return this.sessionId;
    }

    /**
     * Full authentication flow
     */
    async authenticate() {
        await this._authenticateAccount();
        await this._authenticateSession();
        console.log('[Dexcom] OK');
        return true;
    }

    /**
     * Ensure we have a valid session
     */
    async ensureAuthenticated() {
        if (!this.sessionId) {
            await this.authenticate();
        }
    }

    /**
     * Re-authenticate (for session renewal)
     */
    async reauthenticate() {
        this.sessionId = null;
        this.accountId = null;
        await this.authenticate();
    }

    /**
     * Set the virtual receiver serial number
     */
    setSerialNumber(serialNumber) {
        this.serialNumber = serialNumber;
    }

    /**
     * Register as a virtual receiver
     * Note: This step is NOT required - Libre3View extension skips it entirely.
     */
    async registerReceiver() {
       
        return true;
    }

    /**
     * Upload glucose readings to Dexcom Share
     */
    async uploadReadings(readings) {
        await this.ensureAuthenticated();

        if (!this.serialNumber) {
            throw new Error('Serial number not set. Call setSerialNumber() first.');
        }

        if (!readings || readings.length === 0) {
            console.log('[Dexcom] No readings to upload');
            return { uploaded: 0, skipped: 0 };
        }

       
        const egvs = readings.map(r => this._formatForDexcom(r));


       
       
        const response = await this._request(
            'POST',
            `/ShareWebServices/Services/Publisher/PostReceiverEgvRecords?sessionId=${this.sessionId}`,
            {
                SN: this.serialNumber,
                Egvs: egvs
            }
        );

       
        if (response.status === 500 && response.data && response.data.Code === 'SessionIdNotFound') {
            console.log('[Dexcom] Session expired, re-authenticating...');
            await this.reauthenticate();
            return this.uploadReadings(readings);
        }

       
        if (response.status === 429) {
            console.log('[Dexcom] Rate limited, waiting...');
            await new Promise(resolve => setTimeout(resolve, 60000));
            return this.uploadReadings(readings);
        }

        if (response.status !== 200) {
            throw new Error(`Failed to upload readings: ${JSON.stringify(response.data)}`);
        }

        return { uploaded: egvs.length, skipped: 0 };
    }

    /**
     * Format a reading for Dexcom API
     * Uses correct Dexcom EGV format: DT, ST, WT, Value, Trend (numeric)
     */
    _formatForDexcom(reading) {
       
        const dt = reading.timestamp instanceof Date ? reading.timestamp : new Date(reading.timestamp);
        const ticks = dt.getTime();

       
        let trend = 4; 
        if (typeof reading.trend === 'number') {
            trend = LIBRE_TO_DEXCOM_TREND[reading.trend] || 4;
        }

       
        return {
            DT: `/Date(${ticks})/`,  
            ST: `/Date(${ticks})/`,  
            WT: `/Date(${ticks})/`,  
            Value: reading.value,
            Trend: trend             
        };
    }

    /**
     * Read latest glucose values (for verification)
     */
    async readLatestValues(count = 1, minutes = 10) {
        await this.ensureAuthenticated();

        const response = await this._request(
            'POST',
            `/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${this.sessionId}&minutes=${minutes}&maxCount=${count}`,
            null
        );

       
        if (response.status === 500 && response.data && response.data.Code === 'SessionIdNotFound') {
            console.log('[Dexcom] Session expired, re-authenticating...');
            await this.reauthenticate();
            return this.readLatestValues(count, minutes);
        }

        if (response.status !== 200) {
            throw new Error(`Failed to read values: ${JSON.stringify(response.data)}`);
        }

        return response.data || [];
    }

    /**
     * Test connection
     */
    async testConnection() {
        try {
            await this.authenticate();

           
            const values = await this.readLatestValues(1, 1440);

            return {
                success: true,
                region: this.region,
                hasData: values.length > 0,
                latestValue: values.length > 0 ? values[0] : null
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
}

// Export class and constants
module.exports = DexcomClient;
module.exports.DEXCOM_URLS = DEXCOM_URLS;
module.exports.LIBRE_TO_DEXCOM_TREND = LIBRE_TO_DEXCOM_TREND;
