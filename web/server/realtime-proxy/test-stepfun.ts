/**
 * test-stepfun.ts - Simulated client that connects DIRECTLY to StepFun
 * (bypassing the cloud relay) using Bun's native WebSocket + the exact
 * session.update the cloud sends. Measures audio.delta gapMs to determine
 * whether StepFun segments TTS for this client.
 *
 * Run: bun test-stepfun.ts
 *   (needs STEP_API_KEY in .env or env)
 *
 * If gapMs is continuous (10-30ms) -> Bun native WebSocket solves it,
 *    production Docker must switch from node+tsx to bun.
 * If gapMs still has 300-900ms stalls -> StepFun server-side segmentation,
 *    submit ticket.
 */
import 'dotenv/config';

const API_KEY = process.env.STEP_API_KEY;
if (!API_KEY) {
  console.error('STEP_API_KEY not set (put it in .env or export it)');
  process.exit(1);
}

const URL =
  'wss://api.stepfun.com/step_plan/v1/realtime?model=stepaudio-2.5-realtime';

// Bun native WebSocket (cast: bun-types doesn't declare headers option)
const ws = new WebSocket(URL, {
  headers: { authorization: `Bearer ${API_KEY}` },
} as unknown as string[]);

const t0 = performance.now();
let lastAudioPerf = 0;
const gaps: number[] = [];
let thinkingStart = 0;
let thinkingEnd = 0;
let transcriptStart = 0;
let transcriptEnd = 0;
let audioStart = 0;
let audioEnd = 0;
let audioCount = 0;

ws.addEventListener('open', () => {
  console.log(`[+${Math.round(performance.now() - t0)}ms] connected to StepFun`);
  ws.send(
    JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: '中文回答，4-6句',
        voice: 'qingchunshaonv',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: null,
        turn_detection: null,
        tools: [],
        tool_choice: 'auto',
        temperature: 0.8,
        max_response_output_tokens: 4096,
      },
    })
  );
  ws.send(
    JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '你好' }],
      },
    })
  );
  ws.send(JSON.stringify({ type: 'response.create' }));
});

ws.addEventListener('message', (event: MessageEvent) => {
  const evt = JSON.parse(event.data as string);
  const t = Math.round(performance.now() - t0);

  if (evt.type === 'response.thinking.delta' && !thinkingStart) thinkingStart = t;
  if (evt.type === 'response.thinking.done') thinkingEnd = t;
  if (evt.type === 'response.audio_transcript.delta' && !transcriptStart)
    transcriptStart = t;
  if (evt.type === 'response.audio_transcript.done') transcriptEnd = t;

  if (evt.type === 'response.audio.delta') {
    if (!audioStart) audioStart = t;
    audioEnd = t;
    audioCount++;
    const now = performance.now();
    const gap = lastAudioPerf > 0 ? now - lastAudioPerf : 0;
    lastAudioPerf = now;
    if (gap > 0) gaps.push(gap);
    if (gap > 100) {
      console.log(`[+${t}ms] audio.delta gapMs=${Math.round(gap)} <- STOP`);
    }
  }

  if (evt.type === 'response.audio.done') {
    console.log(`\n[+${t}ms] response.audio.done`);
    console.log('--- summary ---');
    console.log(
      `thinking:  ${thinkingStart}-${thinkingEnd}ms (${thinkingEnd - thinkingStart}ms)`
    );
    console.log(
      `transcript: ${transcriptStart}-${transcriptEnd}ms (${transcriptEnd - transcriptStart}ms)`
    );
    console.log(
      `audio:     ${audioStart}-${audioEnd}ms (${audioEnd - audioStart}ms, ${audioCount} delta)`
    );
    if (gaps.length) {
      const sorted = [...gaps].sort((a, b) => a - b);
      const sum = gaps.reduce((a, b) => a + b, 0);
      console.log(
        `gapMs: count=${gaps.length} min=${Math.round(sorted[0])} ` +
          `median=${Math.round(sorted[Math.floor(gaps.length / 2)])} ` +
          `p90=${Math.round(sorted[Math.floor(gaps.length * 0.9)])} ` +
          `max=${Math.round(sorted[sorted.length - 1])} ` +
          `avg=${Math.round(sum / gaps.length)}`
      );
      const stops = gaps.filter(g => g > 100).map(g => Math.round(g));
      console.log(`stops >100ms: ${stops.length} [${stops.join(', ')}]`);
      if (stops.length === 0) {
        console.log('RESULT: continuous (no stalls) -> Bun native solves it');
      } else {
        console.log(
          'RESULT: segmented -> StepFun server-side, not connection layer'
        );
      }
    }
    ws.close();
    process.exit(0);
  }

  if (evt.type === 'error') {
    console.error('StepFun error:', JSON.stringify(evt));
  }
});

ws.addEventListener('error', (event: Event) => {
  console.error('WS error:', String(event));
  process.exit(1);
});

ws.addEventListener('close', (event: CloseEvent) => {
  console.log(`closed code=${event.code} reason=${event.reason}`);
});

console.log('connecting to StepFun...');
