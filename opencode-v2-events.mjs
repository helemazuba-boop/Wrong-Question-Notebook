#!/usr/bin/env node
/**
 * OpenCode v2 Event Stream Probe
 * Captures first 10 events to document v2 event types
 *
 * Credentials come from the environment; nothing is hardcoded:
 *
 *   WQN_OPENCODE_SERVER_PASSWORD=... node opencode-v2-events.mjs
 *
 * Optional overrides: WQN_OPENCODE_SERVER_URL (default http://localhost:49374)
 * and WQN_OPENCODE_SERVER_USERNAME (default opencode).
 */

const BASE_URL = (
  process.env.WQN_OPENCODE_SERVER_URL || 'http://localhost:49374'
).replace(/\/+$/, '');
const USERNAME = process.env.WQN_OPENCODE_SERVER_USERNAME || 'opencode';
const PASSWORD = process.env.WQN_OPENCODE_SERVER_PASSWORD || '';

if (!PASSWORD) {
  console.error('Set WQN_OPENCODE_SERVER_PASSWORD first.');
  process.exit(2);
}

const AUTH =
  'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');

async function probeEventStream() {
  console.log('🔍 Probing OpenCode v2 Event Stream\n');

  try {
    const res = await fetch(`${BASE_URL}/api/event`, {
      headers: {
        'Authorization': AUTH,
        'Accept': 'text/event-stream',
      },
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    if (!res.ok) {
      console.log(`❌ HTTP ${res.status}`);
      const text = await res.text();
      console.log(text.slice(0, 500));
      return;
    }

    console.log('✅ Connected to event stream (will read first 10 events)\n');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let eventCount = 0;
    let buffer = '';

    while (eventCount < 10) {
      const { value, done } = await reader.read();
      if (done) {
        console.log('Stream closed');
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Incomplete line stays in buffer

      for (const line of lines) {
        if (line.startsWith('event:')) {
          const eventName = line.slice(6).trim();
          console.log(`\n📡 Event ${++eventCount}: ${eventName}`);
        } else if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          try {
            const json = JSON.parse(data);
            console.log(JSON.stringify(json, null, 2).slice(0, 500));
          } catch {
            console.log(`Raw data: ${data.slice(0, 200)}`);
          }
        }
      }
    }

    reader.releaseLock();
    console.log(`\n✅ Captured ${eventCount} events`);
  } catch (err) {
    console.log(`❌ Error: ${err.message}`);
  }
}

probeEventStream();
