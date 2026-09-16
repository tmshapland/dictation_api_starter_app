# Voice Dictation Form

A tiny, local, educational web app. A web form whose fields you fill in **by
voice**, using [AssemblyAI's Dictation API](https://www.assemblyai.com/docs/dictation).

Press **🎤 Speak** next to a field, talk, press **■ Stop**, and the transcribed
(and cleaned-up) text appears in the field.

## How it works

```
Browser                          Flask (app.py)                 AssemblyAI
-------                          --------------                 ----------
record mic (Web Audio API)
encode WAV in JS
POST /transcribe  ───────────►  add secret API key
                                POST to Dictation API  ──────►  transcribe + clean up
                                                       ◄──────  { text, llm_response }
             ◄───────────────  return final_text
put text in the field
```

Two things worth understanding:

- **The API key stays on the server.** The browser talks only to our own
  `/transcribe` route; `app.py` adds the key and forwards the request. That way
  the key is never exposed in the page. (See `app.py`.)
- **The browser makes the WAV itself.** The Dictation API only accepts WAV or
  raw PCM, but the browser's `MediaRecorder` produces WebM. So `dictation.js`
  captures raw audio samples with the Web Audio API and writes a 16 kHz WAV by
  hand. (See `encodeWav` in `static/dictation.js`.)

## Run it

1. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
2. Put your AssemblyAI API key in `.env`.  
   ```
   ASSEMBLYAI_API_KEY=your_key_here
   ```
   Get a key from the [AssemblyAI dashboard](https://www.assemblyai.com/dashboard/home).
3. Start the server:
   ```bash
   python app.py
   ```
4. Open <http://127.0.0.1:5000> and allow microphone access when prompted.

> **Microphone note:** browsers only allow microphone access on `localhost` or
> over HTTPS. `http://127.0.0.1:5000` counts as a secure context, so it works.

## Files

| File | What it does |
|------|--------------|
| `app.py` | Flask server: serves the page and proxies audio to AssemblyAI. |
| `templates/index.html` | The form. Fields are defined in one list near the top. |
| `static/dictation.js` | Records the mic, encodes WAV, calls `/transcribe`. |
