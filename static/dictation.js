/*
 * dictation.js — record the microphone and fill a form field by voice.
 * ====================================================================
 *
 * The flow when you press "Speak":
 *   1. Ask the browser for microphone access (getUserMedia).
 *   2. Use the Web Audio API to capture the raw audio samples.
 *   3. When you press "Stop", turn those samples into a 16 kHz WAV file
 *      *in the browser* and POST it to our Flask server (/transcribe).
 *   4. The server forwards it to AssemblyAI and returns the text, which we
 *      write into the field.
 *
 * Why build a WAV ourselves instead of using MediaRecorder?
 *   MediaRecorder produces compressed formats (WebM/Opus), but the Dictation
 *   API only accepts WAV or raw PCM. So we capture raw samples and write a
 *   minimal WAV file by hand. It is a great way to see what a WAV actually is.
 */

// AssemblyAI's Dictation model works well at 16 kHz mono, and a lower sample
// rate means a smaller upload. We record at the microphone's native rate and
// downsample to this before sending.
const TARGET_SAMPLE_RATE = 16000;

// We keep one "recorder" object per field so two fields can't clash. Only one
// is ever active at a time, tracked by `activeButton`.
let activeButton = null;

// Wire up every mic button on the page. Each button's data-target attribute
// names the input it dictates into (set in index.html).
document.querySelectorAll(".mic-button").forEach((button) => {
  button.addEventListener("click", () => toggleRecording(button));
});

/*
 * Start recording if this button is idle, or stop-and-transcribe if it is
 * already recording. This is the "press once to start, press again to stop"
 * behavior.
 */
async function toggleRecording(button) {
  const fieldId = button.dataset.target;

  // If THIS button is the one currently recording, stop it.
  if (button === activeButton) {
    await stopRecordingAndTranscribe(button);
    return;
  }

  // Don't allow starting a second recording while another is in progress.
  if (activeButton) return;

  try {
    await startRecording(button);
  } catch (err) {
    setStatus(fieldId, "Could not access the microphone: " + err.message, true);
  }
}

/*
 * Begin capturing microphone audio. We stash everything we need to stop later
 * (the audio nodes and the collected samples) on the button element itself via
 * button._recorder, so each button is self-contained.
 */
async function startRecording(button) {
  const fieldId = button.dataset.target;

  // Ask for the microphone. This prompts the user for permission the first time.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  // An AudioContext is the entry point to the Web Audio API. Its sampleRate is
  // whatever the hardware uses (often 44100 or 48000) — we downsample later.
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);

  // ScriptProcessorNode hands us raw audio samples in a callback. It is
  // technically deprecated in favor of AudioWorklet, but it is far simpler and
  // still works everywhere — a good trade-off for a learning app.
  // 4096 = buffer size (samples per callback); 1 input channel, 1 output.
  const processor = audioContext.createScriptProcessor(4096, 1, 1);

  // We accumulate chunks of samples here as recording proceeds.
  const chunks = [];

  processor.onaudioprocess = (event) => {
    // getChannelData(0) is a Float32Array of samples in the range [-1, 1].
    // We copy it (slice) because the underlying buffer gets reused.
    const input = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
  };

  // Wire the graph up: microphone -> processor -> speakers. The processor must
  // connect to a destination to actually run, even though we don't want to hear
  // ourselves; sending silence to the destination is harmless.
  source.connect(processor);
  processor.connect(audioContext.destination);

  // Remember everything we need to tear this down later.
  button._recorder = { stream, audioContext, source, processor, chunks };

  // Update the UI to the "recording" state.
  activeButton = button;
  button.classList.add("recording");
  button.textContent = "■ Stop";
  setStatus(fieldId, "Listening… press Stop when you're done.");
}

/*
 * Stop the recording, assemble a WAV file, and send it for transcription.
 */
async function stopRecordingAndTranscribe(button) {
  const fieldId = button.dataset.target;
  const recorder = button._recorder;

  // Tear down the audio graph and release the microphone.
  recorder.processor.disconnect();
  recorder.source.disconnect();
  recorder.stream.getTracks().forEach((track) => track.stop());
  const nativeSampleRate = recorder.audioContext.sampleRate;
  await recorder.audioContext.close();

  // Reset the button UI (and free the shared "active" slot) right away.
  button.classList.remove("recording");
  button.textContent = "🎤 Speak";
  button._recorder = null;
  activeButton = null;

  // Turn the collected Float32 chunks into a single WAV file at 16 kHz.
  const samples = mergeChunks(recorder.chunks);
  if (samples.length === 0) {
    setStatus(fieldId, "No audio captured — try again.", true);
    return;
  }
  const downsampled = downsample(samples, nativeSampleRate, TARGET_SAMPLE_RATE);
  const wavBlob = encodeWav(downsampled, TARGET_SAMPLE_RATE);

  // Send it to our server, which forwards it to AssemblyAI.
  setStatus(fieldId, "Transcribing…");
  button.disabled = true;
  try {
    const text = await sendForTranscription(wavBlob);
    // Put the transcribed text into the field. If the field already had text,
    // append so a second dictation adds to it rather than replacing it.
    const input = document.getElementById(fieldId);
    input.value = input.value ? input.value + " " + text : text;
    setStatus(fieldId, "Done.");
  } catch (err) {
    setStatus(fieldId, err.message, true);
  } finally {
    button.disabled = false;
  }
}

/*
 * POST the WAV blob to our Flask /transcribe route and return the text.
 */
async function sendForTranscription(wavBlob) {
  // FormData builds a multipart/form-data body. The field name "audio" is what
  // the server looks for (request.files.get("audio") in app.py).
  const formData = new FormData();
  formData.append("audio", wavBlob, "clip.wav");

  const response = await fetch("/transcribe", { method: "POST", body: formData });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Transcription failed.");
  }
  return data.final_text;
}

/* ------------------------------------------------------------------ *
 * Audio helpers: merge -> downsample -> WAV encode.
 * These are plain array math, nothing AssemblyAI-specific.
 * ------------------------------------------------------------------ */

// Concatenate the list of Float32Array chunks into one Float32Array.
function mergeChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

// Reduce the sample rate (e.g. 48000 -> 16000) by averaging samples. This is a
// simple, good-enough downsampler for speech.
function downsample(samples, fromRate, toRate) {
  if (toRate >= fromRate) return samples; // nothing to do
  const ratio = fromRate / toRate;
  const newLength = Math.round(samples.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    // Average all the original samples that map to this output sample.
    const start = Math.floor(i * ratio);
    const end = Math.floor((i + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end && j < samples.length; j++) {
      sum += samples[j];
      count++;
    }
    result[i] = count > 0 ? sum / count : 0;
  }
  return result;
}

// Build a minimal 16-bit mono WAV file (44-byte header + PCM samples) and
// return it as a Blob. This is the "raw PCM wrapped in a WAV header" the
// Dictation API expects.
function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  // Helper to write an ASCII string into the header.
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  const bytesPerSample = 2; // 16-bit
  const blockAlign = bytesPerSample; // mono
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;

  // ---- RIFF header ----
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true); // file size minus first 8 bytes
  writeString(8, "WAVE");

  // ---- fmt chunk ----
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);        // fmt chunk length
  view.setUint16(20, 1, true);         // audio format 1 = PCM
  view.setUint16(22, 1, true);         // channels = 1 (mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);        // bits per sample

  // ---- data chunk ----
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  // Convert each Float32 sample [-1, 1] to a signed 16-bit integer.
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([view], { type: "audio/wav" });
}

/* ------------------------------------------------------------------ *
 * UI helpers.
 * ------------------------------------------------------------------ */

// Show a short message under a field (the small grey line). isError makes it red.
function setStatus(fieldId, message, isError = false) {
  const el = document.getElementById("status-" + fieldId);
  el.textContent = message;
  el.classList.toggle("error", isError);
}

// On submit, don't actually send anywhere — just show the collected values so
// you can confirm the dictation landed in the fields.
document.getElementById("dictation-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target).entries());
  const output = document.getElementById("submitted");
  output.textContent = "Submitted:\n" + JSON.stringify(data, null, 2);
  output.hidden = false;
});
