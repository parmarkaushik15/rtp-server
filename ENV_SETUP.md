# Environment Configuration

## Setup .env File

Create a `.env` file in the `rtp-server` directory with the following content:

```bash
# Asterisk ARI Configuration
# ARI URL - Asterisk REST Interface endpoint
ARI_URL=http://127.0.0.1:8088/ari
# Use 127.0.0.1 since RTP server is on same server as Asterisk
# Alternative: http://139.59.15.144:8088/ari (if accessing remotely)

# ARI Authentication
ARI_USERNAME=asterisk
ARI_PASSWORD=asterisk123

# RTP Server Configuration
# UDP port for receiving RTP packets from Asterisk
RTP_PORT=20000

# RTP Server Address (IP that Asterisk will use to send RTP)
# Since RTP server is on same server as Asterisk, use localhost
RTP_SERVER_ADDRESS=127.0.0.1
# Alternative: Use server's public IP if needed
# RTP_SERVER_ADDRESS=139.59.15.144

# Recordings Directory
# Directory where WAV recordings will be saved
RECORDINGS_DIR=./recordings

# HTTP Server Port (for health checks/API if needed)
HTTP_PORT=3000

# Node Environment (optional)
# NODE_ENV=production
```

## Quick Setup Command

On the server, run:

```bash
cd /path/to/rtp-server
cat > .env << 'EOF'
ARI_URL=http://127.0.0.1:8088/ari
ARI_USERNAME=asterisk
ARI_PASSWORD=asterisk123
RTP_PORT=20000
RTP_SERVER_ADDRESS=127.0.0.1
RECORDINGS_DIR=./recordings
HTTP_PORT=3000
EOF
```

## Install Dependencies

After creating .env file, install dotenv package:

```bash
npm install
# or
npm install dotenv
```

## Verify Configuration

Check that environment variables are loaded:

```bash
node -e "require('dotenv').config(); console.log('RTP_PORT:', process.env.RTP_PORT);"
```

