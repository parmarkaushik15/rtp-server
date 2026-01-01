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
const { Transform } = require('stream');
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

// Global persistent recording bridge (created at startup, reused for all calls)
let persistentRecordingBridge = null;

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

// Create WAV file writer
function createWAVWriter(filePath, sampleRate = 8000, channels = 1, bitDepth = 16) {
  const fileStream = fs.createWriteStream(filePath);
  
  // WAV header
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(0, 4); // File size (will be updated later)
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // Audio format (PCM)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28); // Byte rate
  header.writeUInt16LE(channels * (bitDepth / 8), 32); // Block align
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(0, 40); // Data size (will be updated later)
  
  fileStream.write(header);
  
  let dataSize = 0;
  let headerUpdated = false;
  
  const writeStream = new Transform({
    transform(chunk, encoding, callback) {
      try {
        dataSize += chunk.length;
        if (fileStream && !fileStream.destroyed && fileStream.writable) {
          fileStream.write(chunk);
        }
        callback();
      } catch (err) {
        console.error('Error in writeStream transform:', err.message || err);
        callback(err);
      }
    },
    flush(callback) {
      // Handle flush safely with error handling
      try {
        // Close the file stream first
        fileStream.end(() => {
          try {
            // Update file size and data size in header by reading and rewriting
            fs.readFile(filePath, (err, data) => {
              if (err) {
                console.error('Error reading file to update header:', err.message || err);
                callback();
                return;
              }
              
              try {
                // Update header in buffer
                const fileSize = 36 + dataSize;
                data.writeUInt32LE(fileSize, 4);
                data.writeUInt32LE(dataSize, 40);
                
                // Write updated header back
                fs.writeFile(filePath, data, (writeErr) => {
                  if (writeErr) {
                    console.error('Error writing updated header:', writeErr.message || writeErr);
                  }
                  callback();
                });
              } catch (bufferErr) {
                console.error('Error updating WAV header buffer:', bufferErr.message || bufferErr);
                callback();
              }
            });
          } catch (readErr) {
            console.error('Error in file read operation:', readErr.message || readErr);
            callback();
          }
        });
      } catch (flushErr) {
        console.error('Error in flush operation:', flushErr.message || flushErr);
        callback();
      }
    }
  });
  
  return { writeStream, fileStream };
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
    
    // Track external media channels that need to be added to bridges
    const externalMediaChannels = new Map(); // channelId -> { sessionId, recordingBridgeId }
    
    // Create PERSISTENT recording bridge at startup - reuse for all calls
    console.log('\n=== Creating Persistent Recording Bridge ===');
    try {
      persistentRecordingBridge = await ariClient.bridges.create({
        type: 'mixing',
        name: 'rtp-recording-bridge'
      });
      console.log(`✓✓✓ Created persistent recording bridge: ${persistentRecordingBridge.id} ✓✓✓`);
      console.log(`  This bridge will be reused for all recordings\n`);
      
      // Monitor bridge for destruction (shouldn't happen, but handle it)
      persistentRecordingBridge.on('BridgeDestroyed', async () => {
        console.error(`❌ CRITICAL: Persistent recording bridge was destroyed! Attempting to recreate...`);
        try {
          persistentRecordingBridge = await ariClient.bridges.create({
            type: 'mixing',
            name: 'rtp-recording-bridge'
          });
          console.log(`✓ Recreated persistent recording bridge: ${persistentRecordingBridge.id}`);
        } catch (recreateErr) {
          console.error(`❌ Failed to recreate bridge:`, recreateErr.message || recreateErr);
        }
      });
    } catch (bridgeErr) {
      console.error(`❌ CRITICAL: Failed to create persistent recording bridge:`, bridgeErr.message || bridgeErr);
      throw new Error(`Cannot proceed without persistent recording bridge: ${bridgeErr.message || bridgeErr}`);
    }
    
    // Set up Stasis application - just set up recording, then continue in dialplan
    ariClient.on('StasisStart', async (event, channel) => {
      console.log(`Channel ${channel.id} entered Stasis application`);
      const extension = channel.dialplan?.exten || 'unknown';
      console.log(`Channel destination: ${extension}`);
      
      // Check if this is an external media channel (starts with "external-")
      if (channel.id.startsWith('external-')) {
        console.log(`\n=== External Media Channel Entered Stasis ===`);
        console.log(`External Media Channel ID: ${channel.id}`);
        
        // Find the session for this external media channel
        const externalMediaInfo = externalMediaChannels.get(channel.id);
        if (externalMediaInfo) {
          console.log(`Found session ${externalMediaInfo.sessionId} for external media channel`);
          
          // Use PERSISTENT recording bridge (created at startup)
          if (persistentRecordingBridge) {
            try {
              // Add external media channel to PERSISTENT bridge IMMEDIATELY - this is CRITICAL!
              await persistentRecordingBridge.addChannel({ channel: channel.id });
              console.log(`✓✓✓✓✓ URGENT: Added external media channel ${channel.id} to PERSISTENT bridge ${persistentRecordingBridge.id} ✓✓✓✓✓`);
              
              // Verify it was added immediately
              setTimeout(async () => {
                try {
                  const bridgeInfo = await ariClient.bridges.get({ bridgeId: persistentRecordingBridge.id });
                  console.log(`\n  === Persistent Bridge Verification ===`);
                  console.log(`  Bridge ${persistentRecordingBridge.id} channels:`, bridgeInfo.channels || []);
                  if (bridgeInfo.channels && bridgeInfo.channels.includes(channel.id)) {
                    console.log(`  ✓✓✓ CONFIRMED: External media IS in persistent bridge - RTP should flow! ✓✓✓`);
                  } else {
                    console.warn(`  ⚠⚠⚠ WARNING: External media NOT in bridge channels! ⚠⚠⚠`);
                  }
                } catch (e) {
                  console.warn(`Could not verify: ${e.message || e}`);
                }
              }, 300);
              
            } catch (addErr) {
              console.error(`❌ CRITICAL: Failed to add external media to persistent bridge:`, addErr.message || addErr);
              // Try retry
              await new Promise(resolve => setTimeout(resolve, 100));
              try {
                await persistentRecordingBridge.addChannel({ channel: channel.id });
                console.log(`✓ Added external media channel to persistent bridge on retry`);
              } catch (retryErr) {
                console.error(`❌ FAILED even on retry:`, retryErr.message || retryErr);
              }
            }
          } else {
            console.error(`❌ CRITICAL: Persistent recording bridge not available!`);
          }
        } else {
          console.warn(`⚠ External media channel ${channel.id} not found in tracking map`);
          console.warn(`  Available tracked channels:`, Array.from(externalMediaChannels.keys()));
        }
        
        // Don't continue in dialplan for external media channels - they should stay in Stasis
        return;
      }
      
      // Only handle extensions 7001 and 7002
      if (extension !== '7001' && extension !== '7002') {
        // Continue in dialplan for other extensions
        await channel.continueInDialplan();
        return;
      }
      
      try {
        // Channel is already answered in dialplan
        // Set up recording session
        const sessionId = uuidv4();
        const rtpPort = RTP_PORT;
        const rtpAddress = getRTPServerAddress();
        
        const wavPath = path.join(RECORDINGS_DIR, `${sessionId}.wav`);
        const { writeStream, fileStream } = createWAVWriter(wavPath, 8000, 1, 16);
        
        // Store session
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
          extension: extension
        });
        
        console.log(`Created RTP session ${sessionId} for extension ${extension} on ${rtpAddress}:${rtpPort}`);
        
        // Use PERSISTENT recording bridge (created at startup) - no need to create per call
        console.log(`\n=== Using Persistent Recording Bridge ===`);
        console.log(`  Persistent bridge ID: ${persistentRecordingBridge.id}`);
        
        // Store bridge reference in session
        const session = activeSessions.get(sessionId);
        if (session) {
          session.recordingBridgeId = persistentRecordingBridge.id;
          session.bridgeId = persistentRecordingBridge.id;
          console.log(`  Stored persistent bridge ID ${persistentRecordingBridge.id} in session`);
        }
        
        // Track external media channel BEFORE creating it (to handle race condition)
        const externalMediaChannelId = `external-${sessionId}`;
        externalMediaChannels.set(externalMediaChannelId, {
          sessionId: sessionId,
          recordingBridgeId: persistentRecordingBridge.id
        });
        console.log(`  Pre-tracked external media channel ${externalMediaChannelId} - ready for StasisStart`);
        
        // Create external media channel using ARI for recording
        let externalMedia;
        try {
          // Try creating external media channel
          // Format: external_host should be "host:port" or "host/port"
          const externalHost = `${rtpAddress}:${rtpPort}`;
          console.log(`Creating external media channel with host: ${externalHost}`);
          
          externalMedia = await ariClient.channels.externalMedia({
            app: 'rtp-recorder',
            external_host: externalHost,
            format: 'ulaw', // PCMU
            channelId: externalMediaChannelId
          });
          
          console.log(`Created external media channel: ${externalMedia.id}`);
          
          // External media channel will enter Stasis immediately
          // Our StasisStart handler will catch it and add it to bridge
          
          // Note: We're using persistent bridge, so no need to monitor destruction per call
          // The persistent bridge stays alive for all calls
          
          // Try to add external media channel immediately (backup in case StasisStart handler misses it)
          setTimeout(async () => {
            try {
              const bridgeInfo = await ariClient.bridges.get({ bridgeId: persistentRecordingBridge.id });
              if (!bridgeInfo.channels || !bridgeInfo.channels.includes(externalMedia.id)) {
                console.log(`  Attempting backup: add external media channel ${externalMedia.id} to persistent bridge`);
                await persistentRecordingBridge.addChannel({ channel: externalMedia.id });
                console.log(`  ✓ Backup: Added external media channel to persistent bridge`);
              }
            } catch (e) {
              // Ignore - StasisStart handler should handle it
            }
          }, 150);
          
          // Get channel details to extract SSRC (for packet matching)
          try {
            const channelDetails = await ariClient.channels.get({ channelId: externalMedia.id });
            console.log(`External media channel state: ${channelDetails.state}`);
            
            if (channelDetails.channelvars) {
              const rtpLocalSSRC = channelDetails.channelvars.RTP_LOCAL_SSRC;
              if (rtpLocalSSRC) {
                const session = activeSessions.get(sessionId);
                if (session) {
                  session.ssrc = parseInt(rtpLocalSSRC);
                  console.log(`Set SSRC ${session.ssrc} for session ${sessionId}`);
                }
              }
            }
          } catch (detailsError) {
            console.log(`Note: Could not get channel details: ${detailsError.message || 'Unknown error'}`);
          }
          
          // Add original channel to PERSISTENT bridge so audio flows
          try {
            await persistentRecordingBridge.addChannel({ channel: channel.id });
            console.log(`✓ Added original channel ${channel.id} to PERSISTENT recording bridge`);
            console.log(`✓ Persistent bridge ${persistentRecordingBridge.id} now has both channels - RTP should flow!\n`);
          } catch (addChannelErr) {
            console.warn(`Could not add original channel to persistent bridge:`, addChannelErr.message || addChannelErr);
            console.log(`  Will add to Dial() bridge when it's created\n`);
          }
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
        
        // Store channel info for bridge monitoring
        channelsToRecord.set(channel.id, {
          sessionId: sessionId,
          externalMediaId: externalMedia.id,
          extension: extension
        });
        
        // Get session again to verify bridge status
        const sessionForVerification = activeSessions.get(sessionId);
        
        console.log(`\n=== External Media Channel Created ===`);
        console.log(`External Media Channel ID: ${externalMedia.id}`);
        console.log(`RTP Target: ${rtpAddress}:${rtpPort}`);
        console.log(`Format: ulaw (PCMU)`);
        console.log(`Recording Bridge ID: ${sessionForVerification?.recordingBridgeId || 'N/A'}`);
        
        // Verify bridge status
        if (sessionForVerification && sessionForVerification.recordingBridgeId) {
          try {
            const bridgeInfo = await ariClient.bridges.get({ bridgeId: sessionForVerification.recordingBridgeId });
            console.log(`\n=== Bridge Status Verification ===`);
            console.log(`Bridge ${sessionForVerification.recordingBridgeId} channels:`, bridgeInfo.channels || []);
            if (bridgeInfo.channels && bridgeInfo.channels.includes(externalMedia.id)) {
              console.log(`✓✓✓ CONFIRMED: External media channel IS in bridge ✓✓✓`);
              console.log(`✓✓✓ RTP packets should now flow to ${rtpAddress}:${rtpPort} ✓✓✓\n`);
            } else {
              console.warn(`⚠⚠⚠ WARNING: External media channel NOT in bridge! ⚠⚠⚠`);
              console.warn(`  Bridge channels:`, bridgeInfo.channels || []);
              console.warn(`  This means NO RTP packets will be received!\n`);
            }
          } catch (bridgeErr) {
            console.warn(`Could not verify bridge: ${bridgeErr.message || bridgeErr}\n`);
          }
        } else {
          console.warn(`⚠ No recording bridge ID found in session - bridge may not have been created\n`);
        }
        
        // Continue channel in dialplan - Dial() will create its bridge
        // When Dial() creates bridge, we'll add external media channel to it (see BridgeCreated handler)
        // Note: We keep channels in persistent bridge, but also add external media to Dial() bridge for recording
        await channel.continueInDialplan();
        
        // Handle channel hangup
        channel.on('ChannelHangupRequest', async () => {
          const channelInfo = channelsToRecord.get(channel.id);
          if (channelInfo) {
            await cleanupSession(channelInfo.sessionId);
            channelsToRecord.delete(channel.id);
          }
        });
        
        externalMedia.on('ChannelHangupRequest', async () => {
          const channelInfo = channelsToRecord.get(channel.id);
          if (channelInfo) {
            await cleanupSession(channelInfo.sessionId);
            channelsToRecord.delete(channel.id);
          }
        });
        
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
            
            // If Dial() created a new bridge, add external media channel to it
            // Note: We're using PERSISTENT bridge, so we don't destroy it
            // When we add external media to Dial() bridge, it will automatically be removed from persistent bridge
            if (session && session.recordingBridgeId && session.recordingBridgeId !== bridge.id) {
              console.log(`  Dial() created bridge ${bridge.id}, adding external media channel to it`);
              console.log(`  (External media will be moved from persistent bridge ${session.recordingBridgeId} to Dial() bridge)`);
              
              try {
                // Add external media to Dial's bridge (will auto-remove from persistent bridge)
                const dialBridgeObj = ariClient.Bridge();
                dialBridgeObj.id = bridge.id;
                await dialBridgeObj.addChannel({ channel: channelInfo.externalMediaId });
                console.log(`✓✓✓ Added external media channel ${channelInfo.externalMediaId} to Dial() bridge ${bridge.id} ✓✓✓`);
                
                // Update session
                session.bridgeId = bridge.id;
                
                // Verify
                setTimeout(async () => {
                  try {
                    const bridgeInfo = await ariClient.bridges.get({ bridgeId: bridge.id });
                    console.log(`Bridge ${bridge.id} channels:`, bridgeInfo.channels || []);
                    if (bridgeInfo.channels && bridgeInfo.channels.includes(channelInfo.externalMediaId)) {
                      console.log(`✓✓✓ CONFIRMED: External media IS in Dial() bridge - RTP should flow! ✓✓✓\n`);
                    }
                  } catch (e) {
                    console.warn(`Could not verify: ${e.message || e}`);
                  }
                }, 200);
                
              } catch (addErr) {
                console.error(`Error adding external media to Dial() bridge:`, addErr.message || addErr);
                // Fall through to try adding directly
              }
            } else {
              // No recording bridge yet, or same bridge - just add external media
              console.log(`  Adding external media channel ${channelInfo.externalMediaId} to bridge ${bridge.id}`);
              
              let retries = 5;
              let added = false;
              
              while (retries > 0 && !added) {
                try {
                  await new Promise(resolve => setTimeout(resolve, 200));
                  
                  const bridgeObj = ariClient.Bridge();
                  bridgeObj.id = bridge.id;
                  await bridgeObj.addChannel({ channel: channelInfo.externalMediaId });
                  added = true;
                  console.log(`✓✓✓ Added external media channel to bridge ${bridge.id} ✓✓✓`);
                  
                  if (session) {
                    session.bridgeId = bridge.id;
                  }
                  
                } catch (err) {
                  retries--;
                  if (retries > 0) {
                    console.log(`  Retry ${6 - retries}/5: ${err.message || err}`);
                    await new Promise(resolve => setTimeout(resolve, 300));
                  } else {
                    console.error(`❌ Failed to add external media after 5 retries: ${err.message || err}\n`);
                  }
                }
              }
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
      
      // CRITICAL: Do NOT cleanup session here! Channels leave Stasis when continueInDialplan() is called,
      // but RTP packets continue to arrive during the call. We'll cleanup only on actual channel hangup.
      const channelInfo = channelsToRecord.get(channel.id);
      if (channelInfo) {
        console.log(`  → Channel ${channel.id} left Stasis, but keeping session ${channelInfo.sessionId} alive for RTP recording`);
        console.log(`  → Session will be cleaned up when channel hangs up (ChannelHangupRequest event)`);
      }
      // Don't delete from channelsToRecord - we need it for hangup detection
      // Sessions stay alive until ChannelHangupRequest fires
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
  
  try {
    // Note: We're using PERSISTENT bridge, so we don't destroy it here
    // The persistent bridge stays alive for all calls
    // Only destroy if it's NOT the persistent bridge (shouldn't happen, but safety check)
    if (session.bridgeId && ariClient && session.bridgeId !== persistentRecordingBridge?.id) {
      try {
        const bridge = ariClient.Bridge();
        bridge.id = session.bridgeId;
        await bridge.destroy();
        console.log(`Destroyed non-persistent bridge ${session.bridgeId}`);
      } catch (err) {
        // Bridge might already be destroyed, ignore
        console.log(`Bridge ${session.bridgeId} cleanup: ${err.message || 'already destroyed'}`);
      }
    } else if (session.bridgeId === persistentRecordingBridge?.id) {
      console.log(`Skipping destruction of persistent bridge ${session.bridgeId} (stays alive for all calls)`);
    }
    
    // End write stream if it exists
    if (session.writeStream) {
      try {
        // Check if stream is already ended
        if (!session.writeStream.destroyed && !session.writeStream.writableEnded) {
          session.writeStream.end();
        }
      } catch (err) {
        console.error(`Error ending write stream:`, err.message || err);
      }
    }
    
    // Wait for file to be written (with timeout)
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

