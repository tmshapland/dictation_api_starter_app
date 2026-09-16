"""
Dictation webform — Flask backend
=================================

A tiny, local, educational app that shows how to use AssemblyAI's Dictation API
to fill in a web form by voice.

How the pieces fit together
---------------------------
1. The browser (static/dictation.js) records the microphone and encodes a WAV
   clip entirely in JavaScript.
2. The browser POSTs that WAV clip to THIS server at /transcribe.
3. This server forwards the clip to AssemblyAI's Dictation API, adding the
   secret API key, and returns the cleaned-up text to the browser.

Why route through the server instead of calling AssemblyAI from the browser?
Primarily, it is because this is an educational app, so we chose a language for calling the AssemblyAI Dictation API that all developers of almost every level are familiar with. Also, it makes security convenient. The API key never leaves the machine. If the browser called AssemblyAI directly, anyone opening the page could read your key from the network tab. This "backend proxy" pattern is the normal way to use a secret API key from a web page, so it's worth learning here.

Run it:
    pip install -r requirements.txt
    # put ASSEMBLYAI_API_KEY=... in the .env file (already present here)
    python app.py
    # then open http://127.0.0.1:5000 in your browser
"""

import json
import os

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

# Load ASSEMBLYAI_API_KEY (and anything else) from the local .env file into the
# environment. Keeping the key in .env — not in the code — means you can share
# the code without leaking your key.
load_dotenv()

# The Dictation API endpoint. It is a single HTTP call: send audio, get text
# back. Note it lives on its own hostname, separate from AssemblyAI's other
# products. See https://www.assemblyai.com/docs/dictation
DICTATION_URL = "https://dictation.assemblyai.com/v1/transcribe/live"

# All the tunable knobs for the Dictation API in one place. Edit these to change
# how the audio is transcribed and cleaned up; they get passed to the API on
# every request below. Leave a field blank ("" or []) to not use it.
#
#   stt_prompt      — context for the speech-to-text pass (who's speaking / about
#                     what), which helps it get ambiguous words right.
#   keyterms_prompt — a list of tricky words/names to bias the transcript toward.
#   llm_instruction — how to rewrite the verbatim text into `llm_response`.
CONFIG = {
    "stt_prompt": "A dinner guest providing information requested from the host about a dinner they're attending",
    "keyterms_prompt": ["Guacamole"],
    "llm_instruction": "Do not add any punctuation. Also, write Guacamole in capitals, like GUACAMOLE",
}

app = Flask(__name__)


@app.route("/")
def index():
    """Serve the single-page form (templates/index.html)."""
    return render_template("index.html")


@app.route("/transcribe", methods=["POST"])
def transcribe():
    """
    Receive a WAV clip from the browser, send it to AssemblyAI's Dictation API,
    and return the transcript as JSON.

    The browser sends the audio as a multipart file upload under the field name
    "audio" (see the fetch() call in static/dictation.js).
    """
    # Read the API key at request time so a missing key produces a clear error
    # instead of crashing at startup.
    api_key = os.environ.get("ASSEMBLYAI_API_KEY")
    if not api_key:
        return jsonify(error="ASSEMBLYAI_API_KEY is not set (check your .env file)."), 500

    # Pull the uploaded audio out of the request. request.files is populated by
    # Flask from the multipart/form-data body the browser sent.
    uploaded = request.files.get("audio")
    if uploaded is None:
        return jsonify(error="No audio was uploaded."), 400
    audio_bytes = uploaded.read()

    # Build the Dictation API request. It is multipart/form-data with two parts,
    # and the order matters: "config" MUST come before "audio", because the
    # server starts transcribing the audio as it arrives and needs the config
    # first. `requests` sends the parts in the order of this dict.
    #
    # The response's `text` field is always the words exactly as spoken
    # (verbatim), while `llm_response` is a cleaned-up rewrite (filler words
    # removed, self-corrections resolved). CONFIG (defined at the top of this
    # file) steers all of this — including the "llm_instruction" that shapes the
    # rewrite. Whatever the model returns in `llm_response` is what lands in the
    # form field below.
    files = {
        "config": (None, json.dumps(CONFIG), "application/json"),
        "audio": ("clip.wav", audio_bytes, "audio/wav"),
    }
    headers = {
        # AssemblyAI wants the raw key in the Authorization header — no "Bearer".
        "Authorization": api_key,
    }

    try:
        # timeout=90 per the docs: short clips usually return in under a second,
        # but the ceiling allows for the LLM cleanup pass.
        resp = requests.post(DICTATION_URL, headers=headers, files=files, timeout=90)
    except requests.RequestException as exc:
        # Network-level failure (DNS, connection refused, timeout, ...).
        return jsonify(error=f"Could not reach the Dictation API: {exc}"), 502

    # If AssemblyAI returned an error status, pass a readable message back to the
    # browser. The API uses a couple of different error shapes, so we try both.
    if not resp.ok:
        try:
            body = resp.json()
            message = body.get("detail") or body.get("error") or resp.text
        except ValueError:
            message = resp.text
        return jsonify(error=f"Dictation API error ({resp.status_code}): {message}"), 502

    result = resp.json()

    # `llm_response` is the cleaned-up text, but it can be null if the cleanup
    # step failed — in that case we fall back to the verbatim `text`. This
    # "final text" is what we put into the form field.
    verbatim = result.get("text", "")
    cleaned = result.get("llm_response")
    final_text = cleaned if cleaned else verbatim

    return jsonify(
        final_text=final_text,  # what to drop into the form field
        verbatim=verbatim,      # exactly what was said, shown for comparison
    )


if __name__ == "__main__":
    # debug=True gives auto-reload and helpful error pages while you learn.
    # host stays on localhost so the app is only reachable from this machine.
    app.run(host="127.0.0.1", port=5000, debug=True)
