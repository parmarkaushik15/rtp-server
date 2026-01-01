# Asterisk RTP Recorder

Node.js RTP server that receives RTP streams from Asterisk PBX via ARI ExternalMedia and saves them as audio files.

## How It Works

1. **Caller** → Calls Asterisk PBX
2. **Asterisk PBX** → Routes call to Stasis application via dialplan
3. **ARI** → Creates ExternalMedia channel pointing to RTP server
4. **RTP Server** → Receives RTP packets, converts to PCM, saves as WAV/MP3

## Architecture

```
Caller → SIP → Asterisk → Stasis App → ExternalMedia Channel → RTP Server → MP3 File
```

## Features

- Receives RTP streams via UDP
- Converts G.711 (PCMU/PCMA) to PCM
- Saves recordings as WAV files
- REST API for managing recordings
- Health check endpoint
- Automatic session cleanup

## API Endpoints

### GET /health
Health check endpoint

### GET /recordings
List all recordings

### GET /recordings/:filename
Download a recording file

## Environment Variables

- `ARI_URL` - Asterisk ARI URL 
  - Default: `http://localhost:8088/ari` (for local development)
  - Docker: `http://asterisk:8088/ari` (set automatically in docker-compose.yml)
- `ARI_USERNAME` - ARI username (default: asterisk)
- `ARI_PASSWORD` - ARI password (default: asterisk123)
- `RTP_PORT` - RTP server UDP port (default: 20000)
- `RTP_SERVER_ADDRESS` - RTP server address (default: rtp-server)
- `HTTP_PORT` - HTTP API port (default: 3000)
- `RECORDINGS_DIR` - Directory to save recordings 
  - Default: `./recordings` (relative to project root for local dev)
  - Docker: `/recordings` (set automatically in docker-compose.yml)

## Usage

### Running Locally (Development)

When running locally (outside Docker), the server defaults to connecting to `localhost:8088`:

```bash
# Make sure Asterisk is running and accessible on localhost:8088
npm start

# Or for development with auto-reload
npm run dev
```

**Note**: If Asterisk is running in Docker, you may need to:
1. Expose port 8088 from the Docker container: `docker run -p 8088:8088 ...`
2. Or use `host.docker.internal` if on Mac/Windows: `ARI_URL=http://host.docker.internal:8088/ari npm start`

### Running in Docker

The server is configured to run in Docker via `docker-compose.yml`. It will automatically:
- Connect to Asterisk using the Docker network hostname `asterisk`
- Use the `/recordings` volume mount
- Wait for Asterisk to be healthy before starting

```bash
# From the asterisk-docker directory
docker-compose up rtp-server
```

## Testing

1. Make a call to extension 500 (configured in dialplan)
2. The call will be routed to the RTP recorder
3. Recording will be saved automatically
4. Access recordings via `/recordings` endpoint

## Notes

- Currently saves as WAV format
- For MP3 conversion, install ffmpeg and update the conversion function
- Supports G.711 μ-law (PCMU) and A-law (PCMA) codecs
- RTP packets are parsed and converted to PCM before saving

