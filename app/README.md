# ComputerAnything (MVP)

A macOS agent with its own blue cursor. It looks at your screen, answers out loud, and points at, circles or clicks things. The cursor idea comes from [Clicky](https://github.com/farzaa/clicky) (MIT).

## Setup

```sh
cp .env.example .env    # fill in the keys
./run.sh                # builds the overlay, then prompts for requests
```

| Variable | Needed for |
|---|---|
| `OPENROUTER_API_KEY` | the brain: `google/gemini-4-argon` via OpenRouter |
| `ELEVENLABS_API_KEY` | voice (TTS, `--voice` STT); without it, macOS `say` speaks |
| `ELEVENLABS_VOICE_ID` | optional voice choice |

Grant Screen Recording to your terminal. Clicks also need Accessibility.

## Demo

```sh
./run.sh
> where is the Wi-Fi menu?
> circle the close button of this window
```

One-off: `python3 agent.py "point at the search field"`, or `python3 agent.py --voice` to speak for 5 s (needs ffmpeg).

## How it works

1. `agent.py` takes a screenshot (`screencapture`, resized to 1280 px with `sips`) and sends it with the prompt to Gemini.
2. The model replies with a short answer plus tags: `[POINT:x,y:label]`, `[DRAW:circle|rect|arrow:x,y,w,h]`, `[HIGHLIGHT:x,y,w,h]`, `[CLICK:x,y]`.
3. Tags are scaled from screenshot pixels to screen points and written as JSON lines to `overlay/overlay`. That's a single-file Swift app: one transparent, click-through panel per screen.
4. Clicks only run after you answer `y` in the terminal.

Overlay protocol on stdin, top-left-origin screen points:

```json
{"op":"point","x":600,"y":400,"label":"Save"}
{"op":"draw","shape":"circle","x":550,"y":350,"w":200,"h":120}
{"op":"highlight","x":800,"y":300,"w":200,"h":80}
{"op":"click","x":600,"y":400}
```

Self-check without network: `python3 agent.py --selftest`.

Limits: main display only. Shapes fade after 4 s.
