# Lib2Dex

[![npm version](https://badge.fury.io/js/lib2dex.svg)](https://www.npmjs.com/package/lib2dex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Synchronize glucose readings from **FreeStyle Libre** (via LibreView/LibreLinkUp) to **Dexcom Share** accounts.

## Why Lib2Dex?

Some diabetes management apps and smartwatch applications only support Dexcom Share as a data source. If you use a FreeStyle Libre CGM but want to use these apps, Lib2Dex bridges the gap by mirroring your Libre glucose data to a Dexcom Share account.

### Use Cases

- **Smartwatch Apps**: Access Libre data on watch faces and apps that only support Dexcom Share
- **Family Monitoring**: Share Libre data with family members using Dexcom Follow app
- **Third-Party Apps**: Use Libre data with apps that integrate with Dexcom Share API
- **Backup Monitoring**: Mirror data to multiple platforms for redundancy

## Features

- Real-time glucose data synchronization
- Support for all LibreView regions (auto-detection)
- Support for US and international (OUS) Dexcom Share regions
- Daemon mode for continuous background sync
- Duplicate reading prevention
- Automatic session renewal
- Minimal dependencies (only `dotenv`)
- Pure Node.js implementation

## Prerequisites

Before using Lib2Dex, you need:

1. **LibreLinkUp Follower Account**
   - LibreLinkUp requires a separate follower account (you cannot use the primary Libre account directly)
   - Set up follower sharing in the LibreLinkUp mobile app
   - Invite yourself or create a second account to follow the primary account

2. **Dexcom Share Account**
   - Create a Dexcom account at [dexcom.com](https://www.dexcom.com)
   - Enable Dexcom Share in the Dexcom app settings
   - Note: You don't need a physical Dexcom device

## Installation

### From npm

```bash
npm install -g lib2dex
```

### From source

```bash
git clone https://github.com/faymaz/lib2dex.git
cd lib2dex
npm install
npm link  # Optional: makes 'lib2dex' command available globally
```

## Configuration

1. Copy the example configuration:

```bash
cp .env.example .env
```

2. Edit `.env` with your credentials:

```env
# Source account (LibreView/LibreLinkUp - where data is read from)
SOURCE_EMAIL=your_libre_email@example.com
SOURCE_PASSWORD=your_libre_password
SOURCE_REGION=eu

# Destination account (Dexcom Share - where data is written to)
DEST_USERNAME=your_dexcom_username
DEST_PASSWORD=your_dexcom_password
DEST_REGION=ous

# Sync settings
SYNC_INTERVAL_MINUTES=5
MAX_READINGS_PER_SYNC=12
```

## Usage

### Test Connections

Verify your credentials are correct:

```bash
lib2dex --test
```

### Single Sync

Run one sync operation and exit:

```bash
lib2dex --once
```

### Daemon Mode (Recommended)

Run continuous synchronization:

```bash
lib2dex --daemon
```

Or simply:

```bash
lib2dex
```

### Verify Data

Check that data was uploaded correctly:

```bash
lib2dex --verify
```

### Help

```bash
lib2dex --help
```

## Running as a Service

### Using systemd (Linux)

Create `/etc/systemd/system/lib2dex.service`:

```ini
[Unit]
Description=Lib2Dex - LibreView to Dexcom Sync
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/path/to/lib2dex
ExecStart=/usr/bin/node index.js --daemon
Restart=always
RestartSec=10
EnvironmentFile=/path/to/lib2dex/.env

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable lib2dex
sudo systemctl start lib2dex
```

### Using PM2

```bash
npm install -g pm2
pm2 start index.js --name lib2dex -- --daemon
pm2 save
pm2 startup
```

### Using Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
CMD ["node", "index.js", "--daemon"]
```

```bash
docker build -t lib2dex .
docker run -d --env-file .env --name lib2dex lib2dex
```

## Configuration Options

| Variable | Description | Default |
|----------|-------------|---------|
| `SOURCE_EMAIL` | LibreLinkUp follower email | Required |
| `SOURCE_PASSWORD` | LibreLinkUp password | Required |
| `SOURCE_REGION` | LibreView region (eu, us, de, etc.) | Auto-detect |
| `DEST_USERNAME` | Dexcom Share username | Required |
| `DEST_PASSWORD` | Dexcom Share password | Required |
| `DEST_REGION` | Dexcom region: us or ous | ous |
| `SYNC_INTERVAL_MINUTES` | Sync frequency in minutes | 5 |
| `MAX_READINGS_PER_SYNC` | Max readings per sync cycle | 12 |
| `SERIAL_NUMBER` | Virtual receiver ID | Auto-generated |
| `LOG_LEVEL` | Logging level: info, debug | info |

## How It Works

```
┌─────────────────┐         ┌─────────────┐         ┌──────────────────┐
│  FreeStyle      │ ──────► │  LibreView  │ ──────► │    Lib2Dex       │
│  Libre Sensor   │         │  Cloud      │         │    (this app)    │
└─────────────────┘         └─────────────┘         └────────┬─────────┘
                                                             │
                                                             ▼
┌─────────────────┐         ┌─────────────┐         ┌──────────────────┐
│  Dexcom Follow  │ ◄────── │  Dexcom     │ ◄────── │  Virtual         │
│  Apps, Loop,    │         │  Share      │         │  Receiver        │
│  Omnipod 5      │         │  Cloud      │         │  (LB-XXXXXX)     │
└─────────────────┘         └─────────────┘         └──────────────────┘
```

1. **Read**: Fetches glucose readings from LibreView/LibreLinkUp API
2. **Transform**: Converts LibreView format to Dexcom format (including trend arrows)
3. **Deduplicate**: Filters out already-synced readings
4. **Upload**: Posts readings to Dexcom Share as a virtual receiver
5. **Repeat**: Runs continuously in daemon mode

## Trend Arrow Mapping

| LibreView | Description | Dexcom |
|-----------|-------------|--------|
| 1 | Falling quickly | ↓↓ (DoubleDown) |
| 2 | Falling | ↓ (SingleDown) |
| 3 | Falling slowly | ↘ (FortyFiveDown) |
| 4 | Stable | → (Flat) |
| 5 | Rising slowly | ↗ (FortyFiveUp) |
| 6 | Rising | ↑ (SingleUp) |
| 7 | Rising quickly | ↑↑ (DoubleUp) |

## Troubleshooting

### "No LibreLinkUp connections found"

- Make sure you've set up follower sharing in the LibreLinkUp mobile app
- Use a follower account, not the primary Libre account
- The person you're following must have shared their data with you

### "Account authentication failed"

- Verify your credentials in the `.env` file
- For LibreView: Use the email/password from the LibreLinkUp app (not FreeStyle Libre app)
- For Dexcom: Use the same credentials as dexcom.com or the Dexcom app

### "Session expired"

This is normal and handled automatically. The app will re-authenticate and retry.

### Rate Limiting (429 errors)

If you see rate limiting errors, increase `SYNC_INTERVAL_MINUTES` to reduce API calls.

## Related Projects

- [dex2com](https://github.com/faymaz/dex2com) - Sync between Dexcom Share accounts
- [jsdexcom](https://github.com/faymaz/jsdexcom) - Pure JS Dexcom Share client
- [libre3view](https://github.com/faymaz/libre3view) - GNOME Shell extension for Libre

## Security Notes

- Credentials are stored locally in your `.env` file
- Never commit your `.env` file to version control
- All API communication uses HTTPS
- No data is stored except temporary timestamps for deduplication

## Disclaimer

This project is not affiliated with, endorsed by, or connected to Abbott (FreeStyle Libre) or Dexcom. Use at your own risk. This is an unofficial tool that uses undocumented APIs which may change at any time.

**This software is not intended for use in any medical decision-making. Always rely on your actual CGM device for treatment decisions.**

## License

MIT License - see [LICENSE](LICENSE) file.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request
