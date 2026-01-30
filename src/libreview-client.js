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

class LibreViewClient {
    constructor(email, password, region = '') {
        this.email = email;
        this.password = password;
        this.region = region;
        this.token = null;
        this.tokenExpiry = null;
        this.patientId = null;

        // Base URL - will be updated after region redirect
        this.baseUrl = region
            ? `api-${region}.libreview.io`
            : 'api.libreview.io';

        // API version and headers (simulating LibreLinkUp Android app)
        // Headers based on actual LibreLinkUp app traffic
        this.headers = {
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Content-Type': 'application/json',
            'product': 'llu.android',
            'version': '4.12.0'
        };

        // Retry configuration
        this.maxRetries = 3;
        this.retryDelayMs = 10000;  // Start with 10 seconds
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

                    // Check for Cloudflare errors
                    if (res.statusCode === 403 || res.statusCode === 429 ||
                        body.includes('error code: 1015') || body.includes('error code: 1020') ||
                        body.includes('cloudflare') || body.includes('Cloudflare')) {
                        reject(new Error(`CLOUDFLARE_BLOCKED:${res.statusCode}:${body.substring(0, 100)}`));
                        return;
                    }

                    // Check for empty or invalid responses (another sign of rate limiting)
                    if (!body || body.trim() === '' || body.trim() === '{}') {
                        reject(new Error(`CLOUDFLARE_BLOCKED:${res.statusCode}:Empty response - likely rate limited`));
                        return;
                    }

                    try {
                        const json = JSON.parse(body);
                        resolve({ status: res.statusCode, data: json, headers: res.headers });
                    } catch (e) {
                        // If we can't parse JSON, might be HTML error page from Cloudflare
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
                    // Exponential backoff for Cloudflare blocks: 10s, 30s, 90s
                    const delay = this.retryDelayMs * Math.pow(3, attempt - 1);
                    console.log(`[LibreView] Rate limited (attempt ${attempt}/${this.maxRetries}). Waiting ${Math.round(delay/1000)}s...`);
                    await this._sleep(delay);
                } else {
                    // Non-Cloudflare error, don't retry
                    throw error;
                }
            }
        }

        // More helpful error message
        throw new Error(`LibreView API blocked. Your IP may be temporarily blocked by Cloudflare. Please wait 10-15 minutes and try again.`);
    }

    /**
     * Authenticate with LibreView
     */
    async authenticate() {
        console.log('[LibreView] Authenticating...');

        const response = await this._request('POST', '/llu/auth/login', {
            email: this.email,
            password: this.password
        });

        // Handle region redirect
        if (response.data.data && response.data.data.redirect) {
            const newRegion = response.data.data.region;
            console.log(`[LibreView] Redirecting to region: ${newRegion}`);
            this.baseUrl = `api-${newRegion}.libreview.io`;
            this.region = newRegion;

            // Retry authentication with new region
            return this.authenticate();
        }

        if (response.data.status !== 0 || !response.data.data || !response.data.data.authTicket) {
            throw new Error(`Authentication failed: ${JSON.stringify(response.data)}`);
        }

        this.token = response.data.data.authTicket.token;
        this.tokenExpiry = new Date(response.data.data.authTicket.expires * 1000);

        console.log(`[LibreView] Authenticated successfully (expires: ${this.tokenExpiry.toISOString()})`);
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

        console.log('[LibreView] Fetching connections...');
        const response = await this._request('GET', '/llu/connections');

        if (response.data.status !== 0 || !response.data.data) {
            throw new Error(`Failed to get connections: ${JSON.stringify(response.data)}`);
        }

        const connections = response.data.data;
        console.log(`[LibreView] Found ${connections.length} connection(s)`);

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

        // Use the first connection
        this.patientId = connections[0].patientId;
        console.log(`[LibreView] Using patient ID: ${this.patientId}`);

        return this.patientId;
    }

    /**
     * Get glucose readings for a patient
     */
    async getGlucoseReadings(patientId = null) {
        await this.ensureAuthenticated();

        const pid = patientId || await this.getPatientId();

        console.log('[LibreView] Fetching glucose readings...');
        const response = await this._request('GET', `/llu/connections/${pid}/graph`);

        if (response.data.status !== 0 || !response.data.data) {
            throw new Error(`Failed to get glucose readings: ${JSON.stringify(response.data)}`);
        }

        const data = response.data.data;
        const readings = [];

        // Get current/latest reading
        if (data.connection && data.connection.glucoseMeasurement) {
            const gm = data.connection.glucoseMeasurement;
            readings.push(this._formatReading(gm));
        }

        // Get historical readings from graph data
        if (data.graphData && Array.isArray(data.graphData)) {
            for (const point of data.graphData) {
                readings.push(this._formatReading(point));
            }
        }

        // Sort by timestamp descending (newest first)
        readings.sort((a, b) => b.timestamp - a.timestamp);

        // Remove duplicates based on timestamp
        const unique = [];
        const seen = new Set();
        for (const r of readings) {
            const key = r.timestamp.getTime();
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(r);
            }
        }

        console.log(`[LibreView] Retrieved ${unique.length} glucose readings`);
        return unique;
    }

    /**
     * Format a reading to standard format
     */
    _formatReading(data) {
        // Parse timestamp
        let timestamp;
        if (data.FactoryTimestamp) {
            timestamp = new Date(data.FactoryTimestamp);
        } else if (data.Timestamp) {
            timestamp = new Date(data.Timestamp);
        } else {
            timestamp = new Date();
        }

        // Get glucose value
        const value = data.ValueInMgPerDl || data.Value || data.value || 0;

        // Get trend (LibreView uses 1-7 scale)
        const trend = data.TrendArrow || data.trendArrow || 4; // 4 = stable

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
