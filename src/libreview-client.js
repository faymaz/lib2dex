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
        // More complete headers to avoid Cloudflare detection
        this.headers = {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Content-Type': 'application/json',
            'product': 'llu.android',
            'version': '4.12.0',
            'User-Agent': 'Mozilla/5.0'
        };

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
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    // Check for Cloudflare errors
                    if (res.statusCode === 403 || res.statusCode === 429 ||
                        body.includes('error code: 1015') || body.includes('error code: 1020')) {
                        reject(new Error(`CLOUDFLARE_BLOCKED:${res.statusCode}:${body.substring(0, 100)}`));
                        return;
                    }

                    try {
                        const json = JSON.parse(body);
                        resolve({ status: res.statusCode, data: json, headers: res.headers });
                    } catch (e) {
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
                    // Exponential backoff for Cloudflare blocks
                    const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
                    console.log(`[LibreView] Cloudflare rate limited. Waiting ${delay/1000}s before retry ${attempt}/${this.maxRetries}...`);
                    await this._sleep(delay);
                } else {
                    // Non-Cloudflare error, don't retry
                    throw error;
                }
            }
        }

        throw new Error(`LibreView API blocked after ${this.maxRetries} retries. Please wait a few minutes. Last error: ${lastError.message}`);
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
