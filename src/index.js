// Load environment variables from .env file if it exists
try {
  require('dotenv').config();
} catch (e) {
  // dotenv not installed or .env file doesn't exist - use process.env directly
}

const express = require('express');
const ari = require('ari-client');
const dgram = require('dgram');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const wav = require('wav'); // WAV file writer (matching reference implementation)
const http = require('http');

const app = express();
app.use(express.json());

// Configuration
// Default to localhost for local development, Docker will override via env vars
const ARI_URL = process.env.ARI_URL || 'http://139.59.15.144:8088/ari';
const ARI_USERNAME = process.env.ARI_USERNAME || 'asterisk';
const ARI_PASSWORD = process.env.ARI_PASSWORD || 'asterisk123';
const RTP_PORT = parseInt(process.env.RTP_PORT || '20000');
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(__dirname, '..', 'recordings');

// Determine RTP server address - use IP address that Asterisk can reach
// If running locally, use the Asterisk server's IP or localhost
// If running in Docker, use the Docker hostname
function getRTPServerAddress() {
  if (process.env.RTP_SERVER_ADDRESS) {
    return process.env.RTP_SERVER_ADDRESS;
  }
  
  // Extract IP from ARI_URL if available
  try {
    const ariUrlObj = new URL(ARI_URL);
    const asteriskHost = ariUrlObj.hostname;
    
    // If ARI URL uses an IP address, use that for RTP
    if (asteriskHost && asteriskHost !== 'localhost' && asteriskHost !== '127.0.0.1') {
      // For remote Asterisk, RTP server should be accessible from Asterisk's perspective
      // Use the same IP or detect if we're on the same network
      return asteriskHost; // Use Asterisk's IP - RTP server should be reachable from there
    }
  } catch (e) {
    // Ignore URL parsing errors
  }
  
  // Default fallback
  return 'localhost';
}

// Ensure recordings directory exists
try {
  fs.ensureDirSync(RECORDINGS_DIR);
  console.log(`Recordings directory: ${RECORDINGS_DIR}`);
} catch (error) {
  console.error(`Failed to create recordings directory at ${RECORDINGS_DIR}:`, error.message);
  process.exit(1);
}

// Store active RTP sessions
const activeSessions = new Map();

// Maps to track external media channels and SIP channels with their bridges (matching reference implementation)
const extMap = new Map(); // channelId -> { bridgeId, sessionId }
const sipMap = new Map(); // channelId -> bridge object

// RTP Server - listens for RTP packets
const rtpServer = dgram.createSocket('udp4');

// Track ALL UDP packets received (not just RTP)
let totalUdpPackets = 0;

rtpServer.on('message', (msg, rinfo) => {
  totalUdpPackets++;
  
  // Check if we have any active 7001/7002 sessions before logging
  const hasTargetSessions = Array.from(activeSessions.values()).some(s => s.extension === '7001' || s.extension === '7002');
  
  // Only log UDP packet details if we have 7001/7002 sessions active
  if (hasTargetSessions) {
    // Log ALL UDP packets for first 20 packets to debug
    if (totalUdpPackets <= 20) {
      console.log(`\n[7001/7002] [UDP] Packet #${totalUdpPackets}: ${msg.length} bytes from ${rinfo.address}:${rinfo.port}`);
      if (msg.length >= 12) {
        const firstByte = msg[0];
        const version = (firstByte >> 6) & 0x3;
        const payloadType = msg[1] & 0x7f;
        console.log(`[7001/7002] [UDP] Looks like RTP: version=${version}, PT=${payloadType}, hex=${msg.slice(0, 12).toString('hex')}`);
      } else {
        console.log(`[7001/7002] [UDP] Too short for RTP, hex=${msg.toString('hex')}`);
      }
    } else if (totalUdpPackets % 100 === 0) {
      const targetSessionCount = Array.from(activeSessions.values()).filter(s => s.extension === '7001' || s.extension === '7002').length;
      console.log(`[7001/7002] [UDP] Total UDP packets received: ${totalUdpPackets} (${targetSessionCount} active 7001/7002 sessions)`);
    }
  }
  
  // RTP packet structure: 12 bytes header + payload
  if (msg.length < 12) {
    if (hasTargetSessions && totalUdpPackets <= 20) {
      console.log(`[7001/7002] [UDP] Packet too short for RTP: ${msg.length} bytes from ${rinfo.address}:${rinfo.port}`);
    }
    return;
  }
  
  // Parse RTP header
  const version = (msg[0] >> 6) & 0x3;
  const padding = (msg[0] >> 5) & 0x1;
  const extension = (msg[0] >> 4) & 0x1;
  const csrcCount = msg[0] & 0xf;
  const marker = (msg[1] >> 7) & 0x1;
  const payloadType = msg[1] & 0x7f;
  const sequenceNumber = (msg[2] << 8) | msg[3];
  const timestamp = (msg[4] << 24) | (msg[5] << 16) | (msg[6] << 8) | msg[7];
  const ssrc = (msg[8] << 24) | (msg[9] << 16) | (msg[10] << 8) | msg[11];
  
  // Only log packet details if we have 7001/7002 sessions active
  if (hasTargetSessions) {
    // Always log first few packets to debug
    const isFirstPacket = !global.rtpPacketCount;
    global.rtpPacketCount = (global.rtpPacketCount || 0) + 1;
    if (isFirstPacket || global.rtpPacketCount <= 10) {
      console.log(`[7001/7002] [RTP] Packet #${global.rtpPacketCount}: SSRC=${ssrc}, PT=${payloadType}, Seq=${sequenceNumber}, From=${rinfo.address}:${rinfo.port}, Size=${msg.length}, ActiveSessions=${activeSessions.size}`);
    }
    
    // Log every 100th packet to show we're receiving data
    if (global.rtpPacketCount % 100 === 0) {
      const targetSessionCount = Array.from(activeSessions.values()).filter(s => s.extension === '7001' || s.extension === '7002').length;
      console.log(`[7001/7002] [RTP] Received ${global.rtpPacketCount} total packets (${targetSessionCount} active 7001/7002 sessions)`);
    }
  } else {
    // Still count packets but don't log if no 7001/7002 sessions
    global.rtpPacketCount = (global.rtpPacketCount || 0) + 1;
  }
  
  // Find session by SSRC first
  let sessionId = findSessionBySSRC(ssrc);
  
  // If not found by SSRC, try matching by address/port
  if (!sessionId) {
    sessionId = findSessionByAddress(rinfo.address, rinfo.port);
  }
  
  // If still not found, try matching ANY active session
  // External media can send RTP from various ports, so be flexible
  if (!sessionId && activeSessions.size > 0) {
    const sessions = Array.from(activeSessions.entries());
    
    // If only one session, use it (most common case)
    if (sessions.length === 1) {
      sessionId = sessions[0][0];
      const session = sessions[0][1];
      if (!session.ssrc) {
        session.ssrc = ssrc;
        console.log(`✓✓✓ Matched RTP packet to only active session ${sessionId}, assigned SSRC ${ssrc} (From=${rinfo.address}:${rinfo.port})`);
      } else if (session.ssrc === ssrc) {
        // SSRC already matches
        console.log(`✓ Matched RTP packet by SSRC ${ssrc} to session ${sessionId}`);
      } else {
        // Different SSRC but only one session - still use it (might be multiple streams)
      }
    } else {
      // Multiple sessions - try to match by port or use first session without SSRC
      for (const [sid, sess] of sessions) {
        // Match by port if it matches our RTP_PORT or session's expected port
        if (rinfo.port === sess.rtpPort || rinfo.port === RTP_PORT || !sess.ssrc) {
          sessionId = sid;
          const session = sess;
          if (!session.ssrc) {
            session.ssrc = ssrc;
            console.log(`✓ Matched RTP packet to session ${sessionId} (no SSRC yet), assigned SSRC ${ssrc}`);
          }
          break;
        }
      }
      
      // If still no match and we have sessions, use the first one without SSRC
      if (!sessionId) {
        for (const [sid, sess] of sessions) {
          if (!sess.ssrc) {
            sessionId = sid;
            sess.ssrc = ssrc;
            console.log(`✓✓✓ Using first session without SSRC ${sessionId}, assigned SSRC ${ssrc}`);
            break;
          }
        }
      }
    }
  }
  
  if (sessionId) {
    const session = activeSessions.get(sessionId);
    
    // FILTER: Only process packets for extensions 7001 and 7002
    if (session && session.extension !== '7001' && session.extension !== '7002') {
      // Skip packets from other extensions - don't log or process
      return;
    }
    
    // Check if session is being cleaned up or already closed
    if (session && session.closing) {
      // Session is being cleaned up - ignore late-arriving packets
      return;
    }
    
    if (session && session.writeStream) {
      // Extract payload (skip 12 byte header + CSRC if present)
      const payloadOffset = 12 + (csrcCount * 4);
      if (msg.length > payloadOffset) {
        const payload = msg.slice(payloadOffset);
        
        // Convert PCMU (G.711 μ-law) to PCM
        if (payloadType === 0 || session.codec === 'PCMU') {
          const pcmData = convertPCMUtoPCM(payload);
          if (pcmData) {
            session.writeStream.write(pcmData);
            session.packetCount = (session.packetCount || 0) + 1;
            if (session.packetCount === 1 || session.packetCount % 100 === 0) {
              console.log(`[7001/7002] Session ${sessionId} (ext: ${session.extension}): Received ${session.packetCount} packets, SSRC=${ssrc}`);
            }
          }
        } else if (payloadType === 8 || session.codec === 'PCMA') {
          // PCMA (G.711 A-law)
          const pcmData = convertPCMAtoPCM(payload);
          if (pcmData) {
            session.writeStream.write(pcmData);
            session.packetCount = (session.packetCount || 0) + 1;
            if (session.packetCount === 1 || session.packetCount % 100 === 0) {
              console.log(`[7001/7002] Session ${sessionId} (ext: ${session.extension}): Received ${session.packetCount} packets, SSRC=${ssrc}`);
            }
          }
        } else {
          console.log(`[7001/7002] Session ${sessionId}: Unsupported payload type ${payloadType}`);
        }
      }
    } else {
      if (!sessionId) {
        // Only log if we have active 7001/7002 sessions
        const hasTargetSessions = Array.from(activeSessions.values()).some(s => s.extension === '7001' || s.extension === '7002');
        if (hasTargetSessions) {
          console.log(`[7001/7002] No session found for SSRC=${ssrc}, From=${rinfo.address}:${rinfo.port}`);
        }
      } else if (!session) {
        console.log(`[7001/7002] Session ${sessionId} not found in activeSessions`);
      } else if (!session.writeStream) {
        console.log(`[7001/7002] Session ${sessionId} has no writeStream`);
      }
    }
  } else {
    // Only log unmatched packets if we have active 7001/7002 sessions
    const hasTargetSessions = Array.from(activeSessions.values()).some(s => s.extension === '7001' || s.extension === '7002');
    
    if (!hasTargetSessions) {
      // No 7001/7002 sessions active - silently ignore all unmatched packets
      return;
    }
    
    // Log unmatched packets only if we have 7001/7002 sessions (might be for them)
    if (activeSessions.size === 0) {
      // Log first few unmatched packets when no sessions exist
      if (global.unmatchedPacketCount === undefined) {
        global.unmatchedPacketCount = 0;
      }
      global.unmatchedPacketCount++;
      if (global.unmatchedPacketCount <= 10 || global.unmatchedPacketCount % 100 === 0) {
        console.log(`[7001/7002] ⚠ Unmatched RTP packet: SSRC=${ssrc}, PT=${payloadType}, From=${rinfo.address}:${rinfo.port}, Active sessions: 0`);
        console.log(`  → No active sessions! Packets arriving but no call in progress.`);
      }
    } else {
      // Log occasionally when we have sessions but can't match
      if (Math.random() < 0.01) {
        const targetSessions = Array.from(activeSessions.entries()).filter(([_, s]) => s.extension === '7001' || s.extension === '7002');
        console.log(`[7001/7002] ⚠ Unmatched RTP packet: SSRC=${ssrc}, PT=${payloadType}, From=${rinfo.address}:${rinfo.port}`);
        console.log(`  → Active 7001/7002 sessions:`, targetSessions.map(([id, s]) => `${id} (${s.extension})`));
        console.log(`  → Session SSRCs:`, targetSessions.map(([_, s]) => s.ssrc || 'none'));
      }
    }
  }
});

rtpServer.on('error', (err) => {
  console.error('RTP Server error:', err.message || err);
  // Don't crash - RTP server errors are recoverable
});

rtpServer.bind(RTP_PORT, '0.0.0.0', () => {
  console.log(`✓ RTP Server listening on UDP port ${RTP_PORT} on all interfaces (0.0.0.0)`);
  console.log(`  Waiting for RTP packets from Asterisk...`);
  console.log(`\n  ⚠ IMPORTANT: If no packets arrive, check:`);
  console.log(`    1. Firewall allows UDP port ${RTP_PORT}`);
  console.log(`    2. Asterisk can reach this server at ${getRTPServerAddress()}:${RTP_PORT}`);
  console.log(`    3. External media channel is added to bridge`);
  console.log(`    4. Call is actually connected (Dial() answered)`);
  console.log(`    5. External media channel is receiving audio in bridge\n`);
  
  // Test: Log when server is ready
  console.log(`  To test connectivity from Asterisk server, run:`);
  console.log(`    echo "test" | nc -u ${getRTPServerAddress()} ${RTP_PORT}`);
  console.log(`  You should see [UDP] Packet logs if connectivity is OK\n`);
});

// G.711 μ-law to PCM conversion table
const mulawTable = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let sign = (i & 0x80) ? -1 : 1;
  let exponent = (i & 0x70) >> 4;
  let mantissa = i & 0x0f;
  let sample = mantissa << (exponent + 3);
  if (exponent !== 0) sample += (0x84 << exponent);
  mulawTable[i] = sign * sample;
}

// Convert PCMU (μ-law) to PCM
function convertPCMUtoPCM(pcmuData) {
  const pcmData = Buffer.alloc(pcmuData.length * 2);
  for (let i = 0; i < pcmuData.length; i++) {
    const pcmValue = mulawTable[pcmuData[i]];
    pcmData.writeInt16LE(pcmValue, i * 2);
  }
  return pcmData;
}

// G.711 A-law to PCM conversion table
const alawTable = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let sign = (i & 0x80) ? -1 : 1;
  let exponent = (i & 0x70) >> 4;
  let mantissa = i & 0x0f;
  let sample;
  if (exponent === 0) {
    sample = (mantissa << 4) + 8;
  } else {
    sample = ((mantissa << 4) + 0x108) << (exponent - 1);
  }
  alawTable[i] = sign * sample;
}

// Convert PCMA (A-law) to PCM
function convertPCMAtoPCM(pcmaData) {
  const pcmData = Buffer.alloc(pcmaData.length * 2);
  for (let i = 0; i < pcmaData.length; i++) {
    const pcmValue = alawTable[pcmaData[i] ^ 0x55]; // A-law uses XOR
    pcmData.writeInt16LE(pcmValue, i * 2);
  }
  return pcmData;
}

// Find session by SSRC
function findSessionBySSRC(ssrc) {
  for (const [sessionId, session] of activeSessions.entries()) {
    if (session.ssrc === ssrc) {
      return sessionId;
    }
  }
  return null;
}

// Find session by RTP address
function findSessionByAddress(address, port) {
  for (const [sessionId, session] of activeSessions.entries()) {
    // Match by port (since address might vary due to NAT)
    if (session.rtpPort === port) {
      return sessionId;
    }
  }
  return null;
}

// Log session status periodically
function logSessionStatus() {
  if (activeSessions.size > 0) {
    console.log(`\n╔════════════════════════════════════════════════════════════╗`);
    console.log(`║           ACTIVE SESSIONS STATUS (Every 5s)                ║`);
    console.log(`╚════════════════════════════════════════════════════════════╝`);
    for (const [sessionId, session] of activeSessions.entries()) {
      const duration = session.startTime ? ((new Date() - session.startTime) / 1000) : 0;
      console.log(`\nSession: ${sessionId.substring(0, 8)}...`);
      console.log(`  Extension: ${session.extension}`);
      console.log(`  SSRC: ${session.ssrc || '❌ not set'}`);
      console.log(`  RTP Packets: ${session.packetCount || 0} ${session.packetCount > 0 ? '✓' : '❌'}`);
      console.log(`  Duration: ${duration.toFixed(2)}s`);
      console.log(`  Bridge ID: ${session.bridgeId || '❌ NOT IN BRIDGE'}`);
      console.log(`  RTP Target: ${session.rtpAddress}:${session.rtpPort}`);
      
      // Critical warnings
      if (session.packetCount === 0 && duration > 3) {
        console.log(`\n  ⚠⚠⚠ CRITICAL: No RTP packets received after ${duration.toFixed(1)}s! ⚠⚠⚠`);
        console.log(`     Possible issues:`);
        console.log(`     1. External media channel not in bridge`);
        console.log(`     2. Asterisk cannot reach ${session.rtpAddress}:${session.rtpPort}`);
        console.log(`     3. Firewall blocking UDP port ${session.rtpPort}`);
        console.log(`     4. Call not connected (Dial() not answered)`);
        console.log(`     5. External media channel not receiving audio from bridge`);
        
        // Try to check bridge status (async, won't block)
        if (session.bridgeId && ariClient) {
          ariClient.bridges.get({ bridgeId: session.bridgeId }).then(bridgeInfo => {
            console.log(`     Bridge ${session.bridgeId} channels:`, bridgeInfo.channels || []);
            // Find channel info for this session
            for (const [chId, chInfo] of channelsToRecord.entries()) {
              if (chInfo.sessionId === sessionId && bridgeInfo.channels) {
                if (bridgeInfo.channels.includes(chInfo.externalMediaId)) {
                  console.log(`     ✓ External media channel ${chInfo.externalMediaId} IS in bridge`);
                } else {
                  console.log(`     ❌ External media channel ${chInfo.externalMediaId} NOT in bridge!`);
                }
                break;
              }
            }
          }).catch(err => {
            console.log(`     Could not check bridge status: ${err.message || err}`);
          });
        }
      } else if (session.packetCount > 0) {
        const packetsPerSecond = duration > 0 ? (session.packetCount / duration).toFixed(1) : '0';
        console.log(`  ✓ Recording active: ${packetsPerSecond} packets/sec`);
      }
    }
    console.log(`\nTotal UDP packets received by server: ${totalUdpPackets || 0}`);
    if (totalUdpPackets === 0 && activeSessions.size > 0) {
      console.log(`  ❌ NO UDP packets received at all - check network/firewall!`);
    }
    console.log(`════════════════════════════════════════════════════════════\n`);
  }
}

// Log session status every 5 seconds (more frequent for debugging)
setInterval(logSessionStatus, 5000);

// Create WAV file writer (matching reference implementation)
function createWAVWriter(filePath, sampleRate = 8000, channels = 1, bitDepth = 16) {
  const fileStream = fs.createWriteStream(filePath);
  const wavWriter = new wav.Writer({
    channels: channels,
    sampleRate: sampleRate,
    bitDepth: bitDepth
  });
  wavWriter.pipe(fileStream);
  
  return { writeStream: wavWriter, fileStream: fileStream };
}

// Convert WAV to MP3 using ffmpeg (if available) or keep as WAV
async function convertToMP3(wavPath, mp3Path) {
  // For now, we'll save as WAV. In production, use ffmpeg or a proper library
  // You can add ffmpeg conversion here if needed
  // Skip conversion for now - just return the WAV path
  // TODO: Implement actual MP3 conversion using ffmpeg or similar
  return wavPath;
}

// Initialize ARI client
let ariClient = null;

// Check if ARI is available
async function checkARIReady() {
  return new Promise((resolve) => {
    try {
      const url = new URL(ARI_URL);
      const options = {
        hostname: url.hostname,
        port: url.port || 8088,
        path: '/ari/asterisk/info',
        method: 'GET',
        auth: `${ARI_USERNAME}:${ARI_PASSWORD}`,
        timeout: 3000
      };
      
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode === 200) {
            console.log(`✓ ARI connection successful to ${url.hostname}:${options.port}`);
            resolve(true);
          } else {
            console.log(`✗ ARI returned status ${res.statusCode} (expected 200)`);
            resolve(false);
          }
        });
      });
      
      req.on('error', (error) => {
        console.log(`✗ ARI connection error: ${error.code || error.message} (${url.hostname}:${options.port})`);
        resolve(false);
      });
      
      req.on('timeout', () => {
        console.log(`✗ ARI connection timeout (${url.hostname}:${options.port})`);
        req.destroy();
        resolve(false);
      });
      
      req.end();
    } catch (error) {
      console.log(`✗ ARI URL parsing error: ${error.message}`);
      console.log(`  ARI_URL: ${ARI_URL}`);
      resolve(false);
    }
  });
}

// Wait for ARI to be ready
async function waitForARI(maxAttempts = 60, delay = 5000) {
  console.log('='.repeat(60));
  console.log('RTP Server Configuration:');
  console.log(`  ARI URL: ${ARI_URL}`);
  console.log(`  ARI Username: ${ARI_USERNAME}`);
  console.log(`  RTP Port: ${RTP_PORT}`);
  console.log(`  Recordings Directory: ${RECORDINGS_DIR}`);
  console.log('='.repeat(60));
  console.log(`Connecting to ARI...`);
  
  for (let i = 0; i < maxAttempts; i++) {
    const ready = await checkARIReady();
    if (ready) {
      console.log('✓ Asterisk ARI is ready!');
      return true;
    }
    
    if (i < maxAttempts - 1) {
      console.log(`Waiting ${delay / 1000}s before retry... (attempt ${i + 1}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  console.error(`✗ Failed to connect to ARI after ${maxAttempts} attempts`);
  console.error(`  Check that Asterisk is running and ARI is enabled`);
  console.error(`  ARI_URL: ${ARI_URL}`);
  console.error(`  Verify http://${new URL(ARI_URL).hostname}:${new URL(ARI_URL).port || 8088}/ari/asterisk/info is accessible`);
  return false;
}

async function connectARI() {
  try {
    // Wait for ARI to be ready
    const ready = await waitForARI();
    if (!ready) {
      throw new Error('Asterisk ARI is not available after waiting');
    }
    
    // Try to connect with retries
    let retries = 5;
    let connected = false;
    while (retries > 0 && !connected) {
      try {
        console.log(`Attempting to connect to ARI (${6 - retries}/5)...`);
        // Wrap ari.connect in a Promise to catch all errors
        ariClient = await new Promise((resolve, reject) => {
          ari.connect(ARI_URL, ARI_USERNAME, ARI_PASSWORD)
            .then(client => resolve(client))
            .catch(err => reject(err));
        });
        console.log('Connected to Asterisk ARI');
        connected = true;
      } catch (error) {
        retries--;
        const errorMsg = error.message || error.toString();
        console.log(`ARI connection failed: ${errorMsg}`);
        if (retries === 0) {
          throw new Error(`Failed to connect to ARI after 5 attempts: ${errorMsg}`);
        }
        console.log(`Retrying in 3 seconds... (${retries} attempts remaining)`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    // Track channels that need recording
    const channelsToRecord = new Map();
    
    // Helper function to add external media channel to bridge (with retry logic, matching reference)
    async function addExtToBridge(client, channel, bridgeId, retries = 5, delay = 500) {
      try {
        // Check if bridge still exists before attempting
        const bridge = await ariClient.bridges.get({ bridgeId });
        if (!bridge) throw new Error('Bridge not found');
        
        // Check if mapping still exists (session might be closing)
        const mapping = extMap.get(channel.id);
        if (!mapping || mapping.bridgeId !== bridgeId) {
          console.log(`  → Mapping changed or removed, stopping retry for channel ${channel.id}`);
          return;
        }
        
        await bridge.addChannel({ channel: channel.id });
        console.log(`✓✓✓ ExternalMedia channel ${channel.id} added to bridge ${bridgeId} ✓✓✓`);
      } catch (err) {
        if (retries > 0) {
          // Check if mapping still exists before retrying
          const mapping = extMap.get(channel.id);
          if (!mapping || mapping.bridgeId !== bridgeId) {
            console.log(`  → Mapping changed or removed during retry, stopping for channel ${channel.id}`);
            return;
          }
          
          console.log(`Retrying to add externalMedia channel ${channel.id} to bridge ${bridgeId} (${retries} attempts remaining)`);
          await new Promise(r => setTimeout(r, delay));
          return addExtToBridge(client, channel, bridgeId, retries - 1, delay);
        }
        console.error(`Error adding externalMedia channel ${channel.id} to bridge ${bridgeId}: ${err}`);
      }
    }
    
    // Set up Stasis application - matching reference implementation pattern
    ariClient.on('StasisStart', async (event, channel) => {
      console.log(`Channel ${channel.id} entered Stasis application`);
      const extension = channel.dialplan?.exten || 'unknown';
      console.log(`Channel destination: ${extension}`);
      
      // Check if this is an external media channel (UnicastRTP) - matching reference pattern
      if (channel.name && channel.name.startsWith('UnicastRTP')) {
        console.log(`\n=== External Media Channel Entered Stasis ===`);
        console.log(`ExternalMedia channel ${channel.id} started`);
        let mapping = extMap.get(channel.id);
        if (!mapping) { 
          console.log(`  → Mapping not found, waiting 500ms...`);
          await new Promise(r => setTimeout(r, 500)); 
          mapping = extMap.get(channel.id); 
        }
        if (mapping) {
          // Check if bridgeId is set (Dial()'s bridge should be created by now)
          if (mapping.bridgeId) {
            console.log(`  → Found mapping for bridge ${mapping.bridgeId}, adding to bridge...`);
            await addExtToBridge(ariClient, channel, mapping.bridgeId);
            console.log(`  ✓ ExternalMedia channel ${channel.id} successfully added to bridge ${mapping.bridgeId}`);
          } else {
            console.log(`  → Mapping found but bridgeId not set yet (Dial() bridge not created yet)`);
            console.log(`  → Will wait for BridgeCreated event to add external media to Dial()'s bridge`);
            // BridgeCreated handler will add it when Dial() creates the bridge
          }
        } else {
          console.warn(`  ⚠ ExternalMedia channel ${channel.id} not found in tracking map`);
          console.warn(`  Available tracked channels:`, Array.from(extMap.keys()));
        }
        return;
      }
      
      // Only handle extensions 7001 and 7002
      if (extension !== '7001' && extension !== '7002') {
        // Continue in dialplan for other extensions
        await channel.continueInDialplan();
        return;
      }
      
      console.log(`SIP channel started: ${channel.id}`);
      try {
        // Answer the channel first
        await channel.answer();
        console.log(`Channel ${channel.id} answered`);
        
        // Set up recording session BEFORE creating external media
        const sessionId = uuidv4();
        const rtpPort = RTP_PORT;
        const rtpAddress = getRTPServerAddress();
        
        const wavPath = path.join(RECORDINGS_DIR, `${sessionId}.wav`);
        const { writeStream, fileStream } = createWAVWriter(wavPath, 8000, 1, 16);
        
        // Store session (no bridgeId yet - will be set when Dial() creates bridge)
        activeSessions.set(sessionId, {
          channelId: channel.id,
          rtpAddress: rtpAddress,
          rtpPort: rtpPort,
          codec: 'PCMU',
          writeStream: writeStream,
          fileStream: fileStream,
          wavPath: wavPath,
          startTime: new Date(),
          packetCount: 0,
          ssrc: null,
          extension: extension,
          bridgeId: null, // Will be set when Dial() creates bridge
          closing: false // Flag to mark session as being cleaned up
        });
        
        console.log(`Created RTP session ${sessionId} for extension ${extension} on ${rtpAddress}:${rtpPort}`);
        
        // Create external media channel (matching reference implementation)
        // NOTE: We DON'T add it to a bridge yet - we'll add it to Dial()'s bridge when it's created
        try {
          const extParams = {
            app: 'rtp-recorder',
            external_host: `${rtpAddress}:${rtpPort}`,
            format: 'ulaw',
            transport: 'udp',
            encapsulation: 'rtp',
            connection_type: 'client',
            direction: 'both'
          };
          const extChannel = await ariClient.channels.externalMedia(extParams);
          // Store mapping but WITHOUT bridgeId - will be set when Dial() creates bridge
          extMap.set(extChannel.id, { bridgeId: null, sessionId: sessionId });
          console.log(`ExternalMedia channel ${extChannel.id} created (will be added to Dial() bridge when created)`);
          
          // Store channel info for bridge monitoring
          channelsToRecord.set(channel.id, {
            sessionId: sessionId,
            externalMediaId: extChannel.id,
            extension: extension
          });
          
          // Continue channel in dialplan - Dial() will create its bridge
          // BridgeCreated handler will add external media channel to Dial()'s bridge
          await channel.continueInDialplan();
          
          // Handle channel hangup - cleanup session when call ends
          channel.on('ChannelHangupRequest', async () => {
            console.log(`[7001/7002] Channel ${channel.id} hangup requested - cleaning up session ${sessionId}`);
            const session = activeSessions.get(sessionId);
            if (session) {
              session.closing = true; // Mark as closing to ignore late packets
            }
            await cleanupSession(sessionId);
            channelsToRecord.delete(channel.id);
          });
          
          // Handle external media channel hangup
          extChannel.on('ChannelHangupRequest', async () => {
            console.log(`[7001/7002] External media channel ${extChannel.id} hangup requested`);
            const channelInfo = channelsToRecord.get(channel.id);
            if (channelInfo) {
              const session = activeSessions.get(channelInfo.sessionId);
              if (session) {
                session.closing = true; // Mark as closing to ignore late packets
              }
              await cleanupSession(channelInfo.sessionId);
            }
          });
        } catch (externalMediaError) {
          console.error(`Error creating external media channel:`, externalMediaError);
          const errorMsg = externalMediaError.message || JSON.stringify(externalMediaError);
          console.error(`Error details: ${errorMsg}`);
          
          // Clean up session resources safely
          try {
            const session = activeSessions.get(sessionId);
            if (session) {
              // Close streams safely
              if (session.writeStream) {
                try {
                  session.writeStream.destroy();
                } catch (e) {
                  // Ignore
                }
              }
              if (session.fileStream) {
                try {
                  session.fileStream.destroy();
                } catch (e) {
                  // Ignore
                }
              }
              // Delete incomplete WAV file if it exists
              try {
                if (fs.existsSync(session.wavPath)) {
                  fs.unlinkSync(session.wavPath);
                }
              } catch (e) {
                // Ignore
              }
            }
            activeSessions.delete(sessionId);
          } catch (cleanupErr) {
            console.error(`Error during cleanup:`, cleanupErr);
          }
          
          // If external media fails, we can't record, but continue with call
          console.log(`Recording unavailable (${errorMsg}), continuing call without recording`);
          console.log(`Note: If running locally, ensure RTP server at ${rtpAddress}:${rtpPort} is accessible from Asterisk`);
          try {
            await channel.continueInDialplan();
          } catch (continueError) {
            console.error(`Error continuing in dialplan:`, continueError);
            try {
              await channel.hangup();
            } catch (hangupError) {
              console.error(`Error hanging up channel:`, hangupError);
            }
          }
          return;
        }
        
      } catch (error) {
        console.error('Error in StasisStart:', error);
        try {
          await channel.continueInDialplan();
        } catch (e) {
          // Ignore
        }
      }
    });
    
    // Monitor for bridges created by Dial() and move external media channel to Dial's bridge
    // If we have a recording bridge, move channels to Dial's bridge for proper call flow
    ariClient.on('BridgeCreated', async (event, bridge) => {
      console.log(`\n=== Bridge Created Event ===`);
      console.log(`Bridge ID: ${bridge.id}`);
      console.log(`Bridge Type: ${bridge.bridge_type || 'N/A'}`);
      console.log(`Bridge channels:`, bridge.channels || []);
      
      // Check if any channel in this bridge needs recording
      if (bridge.channels && bridge.channels.length > 0) {
        for (const channelId of bridge.channels) {
          const channelInfo = channelsToRecord.get(channelId);
          if (channelInfo) {
            console.log(`\n✓✓✓ Found channel ${channelId} in bridge ${bridge.id} ✓✓✓`);
            
            const session = activeSessions.get(channelInfo.sessionId);
            if (!session) {
              console.error(`  ⚠ Session ${channelInfo.sessionId} not found!`);
              continue;
            }
            
            // This is Dial()'s bridge - add external media channel to it
            console.log(`  → This is Dial()'s bridge - adding external media channel ${channelInfo.externalMediaId} to it`);
            
            // Update session with Dial()'s bridge ID
            session.bridgeId = bridge.id;
            
            // Update extMap with Dial()'s bridge ID
            const extMapping = extMap.get(channelInfo.externalMediaId);
            if (extMapping) {
              extMapping.bridgeId = bridge.id;
            }
            
            try {
              // Get bridge object and add external media channel to Dial()'s bridge
              const dialBridge = await ariClient.bridges.get({ bridgeId: bridge.id });
              if (!dialBridge) {
                console.error(`  ⚠ Bridge ${bridge.id} not found!`);
                continue;
              }
              
              await dialBridge.addChannel({ channel: channelInfo.externalMediaId });
              console.log(`✓✓✓✓✓ CRITICAL: Added external media channel ${channelInfo.externalMediaId} to Dial() bridge ${bridge.id} ✓✓✓✓✓`);
              console.log(`  → RTP packets should now flow to our RTP server!`);
              
              // Verify it was added
              const bridgeInfo = await ariClient.bridges.get({ bridgeId: bridge.id });
              console.log(`  → Bridge ${bridge.id} now has channels:`, bridgeInfo.channels || []);
              
            } catch (addErr) {
              console.error(`  ⚠ Error adding external media to Dial() bridge:`, addErr.message || addErr);
              // Retry adding to bridge
              setTimeout(async () => {
                try {
                  const dialBridge = await ariClient.bridges.get({ bridgeId: bridge.id });
                  await dialBridge.addChannel({ channel: channelInfo.externalMediaId });
                  console.log(`✓ Retry successful: Added external media channel ${channelInfo.externalMediaId} to Dial() bridge ${bridge.id}`);
                } catch (retryErr) {
                  console.error(`  ⚠ Retry failed:`, retryErr.message || retryErr);
                }
              }, 1000);
            }
            
            break; // Only process first matching channel
          }
        }
      }
    });
    
    // Monitor ChannelDialState to detect when Dial() connects
    ariClient.on('ChannelDialState', async (event, channel) => {
      const channelInfo = channelsToRecord.get(channel.id);
      if (channelInfo && event.dialstatus === 'ANSWER') {
        console.log(`Dial answered for channel ${channel.id}, checking for bridge...`);
        // Wait a moment for bridge to be created
        await new Promise(resolve => setTimeout(resolve, 500));
        await addRecordingChannelToBridge(channelInfo, channel.id);
      }
    });
    
    // Also monitor ChannelStateChange to catch when Dial connects
    ariClient.on('ChannelStateChange', async (event, channel) => {
      const channelInfo = channelsToRecord.get(channel.id);
      if (channelInfo && channel.state === 'Up') {
        console.log(`Channel ${channel.id} state changed to Up, checking for bridge...`);
        // Channel is up, check if it's in a bridge
        await addRecordingChannelToBridge(channelInfo, channel.id);
      }
    });
    
    // Periodic check for bridges (in case events are missed)
    setInterval(async () => {
      for (const [channelId, channelInfo] of channelsToRecord.entries()) {
        const session = activeSessions.get(channelInfo.sessionId);
        // Only check if not already in a bridge
        if (session && !session.bridgeId) {
          await addRecordingChannelToBridge(channelInfo, channelId);
        }
      }
    }, 2000); // Check every 2 seconds
    
    // Helper function to add recording channel to bridge
    async function addRecordingChannelToBridge(channelInfo, channelId) {
      try {
        const bridges = await ariClient.bridges.list();
        for (const bridge of bridges) {
          if (bridge.channels && bridge.channels.includes(channelId)) {
            // Channel is in a bridge, add recording channel if not already added
            if (!bridge.channels.includes(channelInfo.externalMediaId)) {
              console.log(`Found bridge ${bridge.id} with channel ${channelId}, adding recording channel ${channelInfo.externalMediaId}`);
              try {
                // Verify external media channel exists
                const extChannel = await ariClient.channels.get({ channelId: channelInfo.externalMediaId });
                console.log(`External media channel ${channelInfo.externalMediaId} exists, state: ${extChannel.state}`);
                
                // Get bridge object
                const bridgeObj = ariClient.Bridge();
                bridgeObj.id = bridge.id;
                
                // Add external media recording channel to the bridge
                await bridgeObj.addChannel({ channel: channelInfo.externalMediaId });
                console.log(`✓ Added recording channel ${channelInfo.externalMediaId} to bridge ${bridge.id}`);
                
                // Verify it was added
                const bridgeInfo = await ariClient.bridges.get({ bridgeId: bridge.id });
                console.log(`Bridge ${bridge.id} now has channels:`, bridgeInfo.channels || []);
                
                // Store bridge ID in session
                const session = activeSessions.get(channelInfo.sessionId);
                if (session) {
                  session.bridgeId = bridge.id;
                  console.log(`Session ${channelInfo.sessionId} is now recording from bridge ${bridge.id}`);
                }
                
                // Monitor bridge destruction
                bridgeObj.on('BridgeDestroyed', async () => {
                  console.log(`Bridge ${bridge.id} destroyed, cleaning up session ${channelInfo.sessionId}`);
                  await cleanupSession(channelInfo.sessionId);
                  channelsToRecord.delete(channelId);
                });
                
              } catch (addErr) {
                console.error(`Error adding recording channel:`, addErr.message || addErr);
              }
            } else {
              console.log(`Recording channel ${channelInfo.externalMediaId} already in bridge ${bridge.id}`);
            }
            break;
          }
        }
      } catch (err) {
        console.error(`Error checking bridges:`, err.message || err);
      }
    }
    
    ariClient.on('StasisEnd', async (event, channel) => {
      console.log(`Channel ${channel.id} left Stasis application`);
      
      // Handle external media channel cleanup (matching reference implementation)
      if (channel.name && channel.name.startsWith('UnicastRTP')) {
        const mapping = extMap.get(channel.id);
        extMap.delete(channel.id);
        console.log(`ExternalMedia channel ${channel.id} removed from map`);
        
        // If this was the last external media channel for a bridge, check if we should destroy it
        if (mapping && mapping.bridgeId) {
          // Check if any other external media channels are still using this bridge
          const bridgeStillInUse = Array.from(extMap.values()).some(m => m.bridgeId === mapping.bridgeId);
          if (!bridgeStillInUse) {
            // No more external media channels using this bridge
            // Find the bridge in sipMap and destroy it if SIP channel is also gone
            const sipEntry = Array.from(sipMap.entries()).find(([_, bridge]) => bridge.id === mapping.bridgeId);
            if (sipEntry) {
              const [sipChannelId, bridge] = sipEntry;
              // Check if SIP channel still exists (it might have left Stasis earlier)
              try {
                const sipChannel = await ariClient.channels.get({ channelId: sipChannelId });
                if (!sipChannel || sipChannel.state === 'Down') {
                  // SIP channel is down, safe to destroy bridge
                  try {
                    await bridge.destroy();
                    console.log(`Bridge ${bridge.id} destroyed (external media ended, SIP channel down)`);
                    sipMap.delete(sipChannelId);
                  } catch (e) {
                    console.error(`Error destroying bridge ${bridge.id}: ${e}`);
                  }
                }
              } catch (e) {
                // SIP channel doesn't exist or already gone, safe to destroy bridge
                try {
                  await bridge.destroy();
                  console.log(`Bridge ${bridge.id} destroyed (external media ended, SIP channel gone)`);
                  sipMap.delete(sipChannelId);
                } catch (destroyErr) {
                  console.error(`Error destroying bridge ${bridge.id}: ${destroyErr}`);
                }
              }
            }
          }
        }
      } else {
        // Handle SIP channel cleanup (matching reference implementation)
        const bridge = sipMap.get(channel.id);
        const channelInfo = channelsToRecord.get(channel.id);
        
        if (channelInfo) {
          // Mark session as closing before cleanup
          const session = activeSessions.get(channelInfo.sessionId);
          if (session) {
            session.closing = true; // Mark as closing to ignore late-arriving packets
            console.log(`[7001/7002] Channel ${channel.id} ended - marking session ${channelInfo.sessionId} as closing`);
          }
          
          // Cleanup session
          await cleanupSession(channelInfo.sessionId);
          channelsToRecord.delete(channel.id);
          
          // Check if external media channel is still active before destroying bridge
          const extMediaId = channelInfo.externalMediaId;
          if (extMediaId && extMap.has(extMediaId)) {
            // External media channel is still active - don't destroy bridge yet
            // It will be destroyed when external media channel ends
            console.log(`[7001/7002] SIP channel ${channel.id} ended, but external media ${extMediaId} still active - keeping bridge ${bridge?.id} alive`);
            sipMap.delete(channel.id); // Remove SIP channel from map but keep bridge
          } else {
            // External media channel is gone, safe to destroy bridge
            if (bridge) {
              try {
                await bridge.destroy();
                console.log(`Bridge ${bridge.id} destroyed (SIP channel ended, external media gone)`);
              } catch (e) {
                console.error(`Error destroying bridge ${bridge.id}: ${e}`);
              }
              sipMap.delete(channel.id);
            }
          }
        } else {
          // No channel info, just clean up bridge
          if (bridge) {
            try {
              await bridge.destroy();
              console.log(`Bridge ${bridge.id} destroyed`);
            } catch (e) {
              console.error(`Error destroying bridge ${bridge.id}: ${e}`);
            }
            sipMap.delete(channel.id);
          }
        }
      }
      console.log(`Channel ended: ${channel.id}`);
    });
    
    // Start Stasis application
    ariClient.start('rtp-recorder');
    console.log('Stasis application "rtp-recorder" started');
    
  } catch (error) {
    console.error('Error connecting to ARI:', error.message || error);
    console.log('Retrying ARI connection in 10 seconds...');
    setTimeout(connectARI, 10000); // Retry after 10 seconds
  }
}

// Handle voicemail when dial fails or no answer
async function handleVoicemail(channel, extension, bridge, sessionId) {
  try {
    console.log(`Handling voicemail for extension ${extension}`);
    
    // Play "nobody available" message
    try {
      await channel.play({ media: 'sound:vm-nobodyavail' });
    } catch (playError) {
      console.error(`Error playing vm-nobodyavail:`, playError);
      // Try alternative playback method
      try {
        await channel.play({ media: 'vm-nobodyavail' });
      } catch (e) {
        console.error(`Alternative playback also failed:`, e);
      }
    }
    
    // Send to voicemail using ARI externalMedia or continue in dialplan
    try {
      const voicemailBox = `${extension}@main`;
      console.log(`Sending to voicemail: ${voicemailBox}`);
      
      // Use ARI to execute VoiceMail application via external script
      // We'll use continueInDialplan to jump to voicemail context
      try {
        await channel.continueInDialplan({
          context: 'internal',
          extension: extension,
          priority: 4  // VoiceMail priority
        });
      } catch (continueError) {
        console.error(`Error continuing in dialplan:`, continueError);
        // Fallback: Use external script or direct voicemail
        // For now, just hangup after playing message
        await channel.hangup();
        await cleanupSession(sessionId);
      }
    } catch (vmError) {
      console.error(`Error sending to voicemail:`, vmError);
      // If voicemail fails, just hangup
      await channel.hangup();
      await cleanupSession(sessionId);
    }
  } catch (error) {
    console.error(`Error in handleVoicemail:`, error);
    await cleanupSession(sessionId);
  }
}

// Cleanup session
async function cleanupSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  
  // Mark session as closing IMMEDIATELY to prevent processing late-arriving packets
  session.closing = true;
  console.log(`[7001/7002] Session ${sessionId} marked as closing - ignoring late packets`);
  
  try {
    // Bridge cleanup is handled in StasisEnd handler, no need to destroy here
    
    // End WAV writer if it exists (matching reference implementation)
    if (session.writeStream) {
      try {
        // Check if stream is already ended
        if (!session.writeStream.destroyed && !session.writeStream.writableEnded) {
          // End WAV writer with callback (matching reference pattern)
          session.writeStream.end(() => {
            console.log(`WAV file closed: ${session.wavPath}`);
          });
        }
      } catch (err) {
        console.error(`Error ending WAV writer:`, err.message || err);
      }
    }
    
    // Wait for file to be written (with timeout) - matching reference implementation
    await new Promise((resolve) => {
      if (session.fileStream && !session.fileStream.destroyed) {
        const timeout = setTimeout(resolve, 2000);
        const cleanup = () => {
          clearTimeout(timeout);
          resolve();
        };
        session.fileStream.once('close', cleanup);
        session.fileStream.once('error', cleanup);
        session.fileStream.once('finish', cleanup);
      } else {
        setTimeout(resolve, 500);
      }
    });
    
    const duration = session.startTime ? ((new Date() - session.startTime) / 1000) : 0;
    console.log(`Recording ${sessionId} completed. Duration: ${duration.toFixed(2)}s. Packets: ${session.packetCount || 0}. File: ${session.wavPath}`);
    
    // Convert to MP3 if needed (for now, keep as WAV)
    if (session.wavPath && fs.existsSync(session.wavPath)) {
      try {
        const mp3Path = session.wavPath.replace('.wav', '.mp3');
        await convertToMP3(session.wavPath, mp3Path);
      } catch (convertError) {
        console.error(`Error converting to MP3:`, convertError.message || convertError);
      }
    } else if (session.wavPath) {
      console.log(`Warning: Recording file ${session.wavPath} does not exist`);
    }
    
    activeSessions.delete(sessionId);
  } catch (error) {
    console.error(`Error cleaning up session ${sessionId}:`, error.message || error);
    // Ensure session is removed even on error
    try {
      activeSessions.delete(sessionId);
    } catch (e) {
      // Ignore
    }
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    activeSessions: activeSessions.size,
    rtpPort: RTP_PORT 
  });
});

// Get recordings list
app.get('/recordings', async (req, res) => {
  try {
    const files = await fs.readdir(RECORDINGS_DIR);
    const recordings = await Promise.all(
      files
        .filter(f => f.endsWith('.wav') || f.endsWith('.mp3'))
        .map(async (file) => {
          const filePath = path.join(RECORDINGS_DIR, file);
          const stats = await fs.stat(filePath);
          return {
            filename: file,
            size: stats.size,
            created: stats.birthtime,
            path: filePath
          };
        })
    );
    res.json(recordings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Download recording
app.get('/recordings/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(RECORDINGS_DIR, filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Recording not found' });
  }
  
  res.download(filePath, filename);
});

// Start HTTP server
const HTTP_PORT = process.env.HTTP_PORT || 3000;
app.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`HTTP Server listening on port ${HTTP_PORT}`);
});

// Connect to ARI
connectARI();

// Process error handlers to prevent crashes
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error.message || error);
  console.error('Stack:', error.stack);
  // Don't exit - log and continue
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
  // Don't exit - log and continue
});

// Handle writeStream errors
process.on('error', (error) => {
  console.error('Process error:', error.message || error);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  rtpServer.close();
  if (ariClient) {
    try {
      ariClient.stop();
    } catch (e) {
      console.error('Error stopping ARI client:', e);
    }
  }
  // Cleanup all sessions
  for (const sessionId of activeSessions.keys()) {
    try {
      cleanupSession(sessionId);
    } catch (e) {
      console.error(`Error cleaning up session ${sessionId}:`, e);
    }
  }
  setTimeout(() => process.exit(0), 2000);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  rtpServer.close();
  if (ariClient) {
    try {
      ariClient.stop();
    } catch (e) {
      console.error('Error stopping ARI client:', e);
    }
  }
  // Cleanup all sessions
  for (const sessionId of activeSessions.keys()) {
    try {
      cleanupSession(sessionId);
    } catch (e) {
      console.error(`Error cleaning up session ${sessionId}:`, e);
    }
  }
  setTimeout(() => process.exit(0), 2000);
});

