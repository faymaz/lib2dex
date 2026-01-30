/**
 * LibreView/LibreLinkUp API Client
 *
 * Connects to the LibreLinkUp service to fetch glucose readings
 * from FreeStyle Libre CGM devices.
 *
 * Note: Requires LibreLinkUp follower sharing to be set up.
 * The primary Libre account cannot be used directly.
 */

const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');

class LibreViewClient {
    constructor(email, password, region = '') {
        this.email = email;
        this.password = password;
        this.region = region;
        this.token = null;
        this.tokenExpiry = null;
        this.patientId = null;
        this.hashedAccountId = null; 

       
        this.baseUrl = region
            ? `api-${region}.libreview.io`
            : 'api.libreview.io';

       
        this.headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'product': 'llu.android',
            'version': '4.16.0',
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
        };

       
        this.maxRetries = 3;
        this.retryDelayMs = 10000; 
    }

    /**
     * Sleep helper for delays
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Decompress response body if needed
     */
    _decompressBody(buffer, encoding) {
        return new Promise((resolve, reject) => {
            if (encoding === 'gzip') {
                zlib.gunzip(buffer, (err, result) => {
                    if (err) reject(err);
                    else resolve(result.toString('utf8'));
                });
            } else if (encoding === 'deflate') {
                zlib.inflate(buffer, (err, result) => {
                    if (err) reject(err);
                    else resolve(result.toString('utf8'));
                });
            } else if (encoding === 'br') {
                zlib.brotliDecompress(buffer, (err, result) => {
                    if (err) reject(err);
                    else resolve(result.toString('utf8'));
                });
            } else {
                resolve(buffer.toString('utf8'));
            }
        });
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
                headers: { ...this.headers }
            };

            if (this.token) {
                options.headers['Authorization'] = `Bearer ${this.token}`;
               
                if (this.hashedAccountId) {
                    options.headers['account-id'] = this.hashedAccountId;
                }
            }

            const req = https.request(options, (res) => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', async () => {
                    const buffer = Buffer.concat(chunks);
                    const encoding = res.headers['content-encoding'];

                    let body;
                    try {
                        body = await this._decompressBody(buffer, encoding);
                    } catch (e) {
                        body = buffer.toString('utf8');
                    }

                   
                    if (res.statusCode === 403 || res.statusCode === 429 ||
                        body.includes('error code: 1015') || body.includes('error code: 1020') ||
                        body.includes('cloudflare') || body.includes('Cloudflare')) {
                        reject(new Error(`CLOUDFLARE_BLOCKED:${res.statusCode}:${body.substring(0, 100)}`));
                        return;
                    }

                   
                    if (!body || body.trim() === '' || body.trim() === '{}') {
                        reject(new Error(`CLOUDFLARE_BLOCKED:${res.statusCode}:Empty response - likely rate limited`));
                        return;
                    }

                    try {
                        const json = JSON.parse(body);
                        resolve({ status: res.statusCode, data: json, headers: res.headers });
                    } catch (e) {
                       
                        if (body.includes('<html') || body.includes('<!DOCTYPE')) {
                            reject(new Error(`CLOUDFLARE_BLOCKED:${res.statusCode}:HTML response - likely blocked`));
                            return;
                        }
                        reject(new Error(`Failed to parse response: ${body.substring(0, 200)}`));
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
                return await this._requestOnce(method, path, data);
            } catch (error) {
                lastError = error;

                if (error.message.startsWith('CLOUDFLARE_BLOCKED')) {
                   
                    const delay = this.retryDelayMs * Math.pow(3, attempt - 1);
                    console.log(`[LibreView] Rate limited (attempt ${attempt}/${this.maxRetries}). Waiting ${Math.round(delay/1000)}s...`);
                    await this._sleep(delay);
                } else {
                   
                    throw error;
                }
            }
        }

       
        throw new Error(`LibreView API blocked. Your IP may be temporarily blocked by Cloudflare. Please wait 10-15 minutes and try again.`);
    }

    /**
     * Authenticate with LibreView
     */
    async authenticate(isRetry = false) {
        if (!isRetry) console.log('[LibreView] Authenticating...');

        const response = await this._request('POST', '/llu/auth/login', {
            email: this.email,
            password: this.password
        });

       
        if (response.data.data && response.data.data.redirect) {
            const newRegion = response.data.data.region;
            this.baseUrl = `api-${newRegion}.libreview.io`;
            this.region = newRegion;
           
            return this.authenticate(true);
        }

        if (response.data.status !== 0 || !response.data.data || !response.data.data.authTicket) {
            throw new Error(`Authentication failed: ${JSON.stringify(response.data)}`);
        }

        this.token = response.data.data.authTicket.token;
        this.tokenExpiry = new Date(response.data.data.authTicket.expires * 1000);

       
        if (response.data.data.user && response.data.data.user.id) {
            this.hashedAccountId = crypto.createHash('sha256')
                .update(response.data.data.user.id)
                .digest('hex');
        }

        console.log(`[LibreView] OK (region: ${this.region || 'default'})`);
        return true;
    }

    /**
     * Check if token is valid
     */
    isTokenValid() {
        if (!this.token || !this.tokenExpiry) return false;
        return new Date() < this.tokenExpiry;
    }

    /**
     * Ensure we have a valid token
     */
    async ensureAuthenticated() {
        if (!this.isTokenValid()) {
            await this.authenticate();
        }
    }

    /**
     * Get list of connections (patients being followed)
     */
    async getConnections() {
        await this.ensureAuthenticated();

        const response = await this._request('GET', '/llu/connections');

        if (response.data.status !== 0 || !response.data.data) {
            throw new Error(`Failed to get connections: ${JSON.stringify(response.data)}`);
        }

        const connections = response.data.data;

        return connections;
    }

    /**
     * Get patient ID (first connection by default)
     */
    async getPatientId() {
        if (this.patientId) return this.patientId;

        const connections = await this.getConnections();

        if (connections.length === 0) {
            throw new Error('No LibreLinkUp connections found. Please set up follower sharing in the LibreLinkUp app.');
        }

       
        this.patientId = connections[0].patientId;

        return this.patientId;
    }

    /**
     * Get glucose readings for a patient
     */
    async getGlucoseReadings(patientId = null) {
        await this.ensureAuthenticated();

        const pid = patientId || await this.getPatientId();

        const response = await this._request('GET', `/llu/connections/${pid}/graph`);

        if (response.data.status !== 0 || !response.data.data) {
            throw new Error(`Failed to get glucose readings: ${JSON.stringify(response.data)}`);
        }

        const data = response.data.data;
        const readings = [];

       
        if (data.connection && data.connection.glucoseMeasurement) {
            const gm = data.connection.glucoseMeasurement;
            const currentReading = this._formatReading(gm);
            console.log(`[LibreView] Current: ${currentReading.value} mg/dL @ ${currentReading.timestamp.toISOString()}`);
            readings.push(currentReading);
        } else {
            console.log('[LibreView] Warning: No current glucoseMeasurement!');
        }

       
        if (data.graphData && Array.isArray(data.graphData)) {
            for (const point of data.graphData) {
                readings.push(this._formatReading(point));
            }
        }

       
        readings.sort((a, b) => b.timestamp - a.timestamp);

       
        const unique = [];
        const seen = new Set();
        for (const r of readings) {
            const key = r.timestamp.getTime();
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(r);
            }
        }

       
        return unique;
    }

    /**
     * Format a reading to standard format
     */
    _formatReading(data) {
       
        let timestamp;
        let rawTs = data.Timestamp || data.FactoryTimestamp;

        if (rawTs) {
           
            timestamp = new Date(rawTs);
            if (isNaN(timestamp.getTime())) {
               
                console.log(`[LibreView] Warning: Invalid timestamp "${rawTs}"`);
                timestamp = new Date();
            }
        } else {
            timestamp = new Date();
        }

       
        const value = data.ValueInMgPerDl || data.Value || data.value || 0;

       
        const trend = data.TrendArrow || data.trendArrow || 4;

        return {
            value: value,
            trend: trend,
            timestamp: timestamp,
            source: 'libreview'
        };
    }

    /**
     * Get latest reading only
     */
    async getLatestReading() {
        const readings = await this.getGlucoseReadings();
        return readings.length > 0 ? readings[0] : null;
    }

    /**
     * Test connection
     */
    async testConnection() {
        try {
            await this.authenticate();
            const connections = await this.getConnections();
            const reading = await this.getLatestReading();

            return {
                success: true,
                region: this.region,
                connections: connections.length,
                latestReading: reading
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
}

module.exports = LibreViewClient;
