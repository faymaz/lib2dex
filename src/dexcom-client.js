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

        // Retry configuration
        this.maxRetries = 3;
        this.retryDelayMs = 5000;
    }

    /**
     * Sleep helper for delays
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Check if error is a network error that should be retried
     */
    _isNetworkError(error) {
        const networkErrorCodes = [
            'EAI_AGAIN',      // DNS temporary failure
            'ENOTFOUND',      // DNS not found
            'ECONNRESET',     // Connection reset
            'ECONNREFUSED',   // Connection refused
            'ETIMEDOUT',      // Connection timed out
            'EPIPE',          // Broken pipe
            'EHOSTUNREACH',   // Host unreachable
            'ENETUNREACH'     // Network unreachable
        ];

        return networkErrorCodes.some(code =>
            error.message.includes(code) || error.code === code
        );
    }

    /**
     * Make an HTTPS request (single attempt)
     */
    _requestOnce(method, path, data = null) {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: this.baseUrl,
                port: 443,
                path: path,
                method: method,
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
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
     * Make an HTTPS request with retry logic
     */
    async _request(method, path, data = null) {
        let lastError;

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                const response = await this._requestOnce(method, path, data);

                // Retry on 500 server errors (but not for specific known errors)
                if (response.status === 500) {
                    const errorCode = response.data?.Code;
                    // Don't retry session errors - they need re-auth, not retry
                    // Don't retry validation errors - they're permanent, not transient
                    if (errorCode === 'SessionIdNotFound' || errorCode === 'SessionNotValid' || errorCode === 'InvalidArgument') {
                        return response;
                    }
                    // Retry other 500 errors
                    const delay = this.retryDelayMs * attempt;
                    console.log(`[Dexcom] Server error 500 (attempt ${attempt}/${this.maxRetries}). Waiting ${Math.round(delay/1000)}s...`);
                    await this._sleep(delay);
                    lastError = new Error(`Server error: ${JSON.stringify(response.data)}`);
                    continue;
                }

                return response;
            } catch (error) {
                lastError = error;

                if (this._isNetworkError(error)) {
                    // Network error - retry with delay
                    const delay = this.retryDelayMs * attempt;
                    console.log(`[Dexcom] Network error: ${error.message} (attempt ${attempt}/${this.maxRetries}). Waiting ${Math.round(delay/1000)}s...`);
                    await this._sleep(delay);
                } else {
                    // Unknown error - don't retry
                    throw error;
                }
            }
        }

        // All retries failed
        if (this._isNetworkError(lastError)) {
            throw new Error(`Network error: ${lastError.message}. Check your internet connection.`);
        }
        throw lastError;
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
            const errorInfo = response.data ? JSON.stringify(response.data) : `HTTP ${response.status}`;
            throw new Error(`Account authentication failed: ${errorInfo}`);
        }

        // Account ID is returned as a quoted GUID string
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
     * This associates the serial number with the account for uploads.
     */
    async registerReceiver() {
        await this.ensureAuthenticated();

        if (!this.serialNumber) {
            throw new Error('Serial number not set');
        }

        console.log(`[Dexcom] Registering receiver: ${this.serialNumber}`);

        // Method 1: Serial number in both query param and body
        try {
            const response = await this._request(
                'POST',
                `/ShareWebServices/Services/Publisher/ReplacePublisherAccountMonitoredReceiver?sessionId=${this.sessionId}&sn=${encodeURIComponent(this.serialNumber)}`,
                this.serialNumber
            );

            if (response.status === 200) {
                console.log('[Dexcom] Receiver registered');
                return true;
            }
        } catch (e) {
            console.log(`[Dexcom] Registration method 1 failed: ${e.message}`);
        }

        // Method 2: Serial number only in body
        try {
            const response2 = await this._request(
                'POST',
                `/ShareWebServices/Services/Publisher/ReplacePublisherAccountMonitoredReceiver?sessionId=${this.sessionId}`,
                this.serialNumber
            );

            if (response2.status === 200) {
                console.log('[Dexcom] Receiver registered (alt method)');
                return true;
            }
        } catch (e) {
            console.log(`[Dexcom] Registration method 2 failed: ${e.message}`);
        }

        // Method 3: Serial number only in query param (legacy)
        try {
            const response3 = await this._request(
                'POST',
                `/ShareWebServices/Services/Publisher/ReplacePublisherAccountMonitoredReceiver?sessionId=${this.sessionId}&sn=${encodeURIComponent(this.serialNumber)}`,
                null
            );

            if (response3.status === 200) {
                console.log('[Dexcom] Receiver registered (legacy method)');
                return true;
            }
        } catch (e) {
            console.log(`[Dexcom] Registration method 3 failed: ${e.message}`);
        }

        console.log('[Dexcom] Warning: Receiver registration failed, continuing...');
        return false;
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


       
        const payload = {
            SN: this.serialNumber,
            Egvs: egvs
        };

       
        const latestTs = egvs[0]?.DT?.match(/Date\((\d+)\)/)?.[1];
        const latestTime = latestTs ? new Date(parseInt(latestTs)).toISOString() : 'unknown';
        console.log(`[Dexcom] Upload: ${egvs[0]?.Value} mg/dL @ ${latestTime}`);

       
        const response = await this._request(
            'POST',
            `/ShareWebServices/Services/Publisher/PostReceiverEgvRecords?sessionId=${this.sessionId}`,
            payload
        );

       
        if (response.status === 500 && response.data &&
            (response.data.Code === 'SessionIdNotFound' || response.data.Code === 'SessionNotValid')) {
            console.log('[Dexcom] Session expired, re-authenticating...');
            await this.reauthenticate();
            return this.uploadReadings(readings);
        }

        // Handle rate limiting
        if (response.status === 429) {
            console.log('[Dexcom] Rate limited, waiting...');
            await new Promise(resolve => setTimeout(resolve, 60000));
            return this.uploadReadings(readings);
        }

       
        if (response.status !== 200) {
            throw new Error(`Failed to upload readings: ${JSON.stringify(response.data)}`);
        }

       
        if (response.data && response.data !== '') {
            console.log(`[Dexcom] API response: ${JSON.stringify(response.data).substring(0, 100)}`);
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

       
        if (response.status === 500 && response.data &&
            (response.data.Code === 'SessionIdNotFound' || response.data.Code === 'SessionNotValid')) {
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
