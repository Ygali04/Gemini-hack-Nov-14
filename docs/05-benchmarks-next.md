# 05 · Verdict and next benchmarks

**Verdict: the computer-use core is ready to benchmark on Mac apps that expose an accessibility tree, and to measure learning over time. It is not ready for games or canvas apps yet.** It can't see pixels it can't read through accessibility, and keys meant for a game window would have to take the user's focus.

What the verdict rests on, all measured on one Mac with Gemini 4 Argon:

| Check | Result |
|---|---|
| Calculator 23 × 19, 31 × 17, 48 × 25 | right answer each time; 48 × 25 cost $0.024 over 10 model calls |
| Two agents in parallel (Calculator and System Settings) | both finished, each in its own lane |
| Messages search, read-only | 7 matches |
| Focus changes during live runs | 0 (frontmost app sampled at 10 Hz) |
| Workspace UI end to end (`backend/scripts/ui_e2e.py`) | 12 of 12 checks |
| WhatsApp search | fails: its search field has no SetValue, and background keys don't land |

## Where to benchmark

```mermaid
flowchart LR
  A[Learning curve on our own tasks<br/>now, under $1] --> B[Disturbance on a real Mac<br/>mac-agent-bench]
  B --> C[MacArena<br/>421 tasks, Apple Silicon VMs]
  C --> D[Help and guidance<br/>ShowMe-Mac, ours]
  C --> E[Games<br/>GameWorld, then 30-minute sessions]
```

### 1. Operating the Mac

| Benchmark | What it measures | Fit |
|---|---|---|
| [MacArena](https://github.com/MacPaw/MacArena) | 421 human-checked tasks across 50 apps, run in Apple Silicon VMs that reset each episode; an OSWorld fork | Best target: our hardware, macOS apps, accessibility tree allowed. The best published agent scores 36.7% on its 49 Mac-native tasks |
| [mac-agent-bench](https://github.com/PrithviSeran/mac-agent-bench) | success, cost, and *disturbance*: did the agent take your focus or cursor | Tests our main design claim directly. It drives tools through MCP, so it needs the MCP server (issue #5) |
| [MacAgentBench](https://github.com/JetAstra/MacAgentBench) | 676 tasks in 25 apps with partial credit per checkpoint | Partial credit shows where long tasks break |
| OSWorld-Verified | the standard Linux benchmark | Needs an adapter from our actions to its Ubuntu VM; second priority |

### 2. Getting better with practice

Our action graph already turns successful runs into replayable skills. These benchmarks test whether that memory helps:

- **CL-Bench** ([2606.05661](https://arxiv.org/abs/2606.05661)) defines the gain metric we use below.
- **PreAct** ([2606.17929](https://arxiv.org/abs/2606.17929)) compiles a first success into a state machine and replays it 8.5 to 13 times faster on OSWorld. That is close to our graph, so it is the baseline to beat.
- **Skill evolution on OSWorld** ([2609.04869](https://arxiv.org/abs/2609.04869)) gained 5.7 to 18.6 points over an empty-library control in four app domains.
- **OS-Marathon** ([2601.20650](https://arxiv.org/html/2601.20650)) tests long, repetitive workflows, where replay should pay off most.

**The gain metric.** For trial *t*, let *r*<sub>sf,t</sub> be the reward with memory carried across trials (stateful) and *r*<sub>sl,t</sub> the reward with a fresh, empty memory (stateless). Then

> *g*<sub>t</sub> = *r*<sub>sf,t</sub> − *r*<sub>sl,t</sub>, and total gain *G* = Σ<sub>t</sub> *g*<sub>t</sub>.

Whatever makes a task easy or hard shows up in both terms, so *g* is what memory bought. Example: if the stateful agent solves a task and the stateless one fails, *g* = 1 − 0 = 1. If both solve it, *g* = 0, and memory can still pay off in cost: fewer model calls for the same answer. So we report steps, calls, dollars and seconds beside *G*.

### 3. Help and guidance ("where is this feature?", "what is it for?")

The closest published pieces:

- **"Where is it?"** AutoGUI-v2 FuncElemGnd ([2604.24441](https://arxiv.org/html/2604.24441)): find the element that does a described thing, among look-alikes.
- **"What does it do?"** AutoGUI-v2 FuncElemCap: predict what clicking an element does. GUI Knowledge Bench ([2510.26098](https://arxiv.org/pdf/2510.26098)) covers macOS among its six platforms.
- **Exploring an unfamiliar app.** UIExplore-Bench ([2506.17779](https://arxiv.org/pdf/2506.17779v1.pdf)).
- **"Show me, then undo it."** LegacyWorld's atomicity score: a run must finish the task or leave no side effects.

None of these scores the whole loop we want: find the feature, point at it, explain it, show it working, then put everything back. So we will build a small one, **ShowMe-Mac**: 30 prompts across built-in apps. Each prompt gets three scores:

1. **Point.** Did the cursor land on the right element? Checked against the element's accessibility id.
2. **Explain.** Is the explanation right? Checked with a FuncElemCap-style rubric.
3. **Revert.** Is the app state the same as before? An accessibility snapshot diff of 0 means yes.

The overlay already points and draws, and the graph already logs every action, so most of the parts exist.

### 4. Games

| Benchmark | Scope |
|---|---|
| [GameWorld](https://arxiv.org/html/2604.07429v1) | 34 browser games, 170 tasks, a computer-use action interface. The game pauses during inference, so the score reflects decisions, not model latency |
| [VideoGameBench](https://vgbench.com/) | 23 classic games; the goal is to finish the game |
| [LongPuzzleBench](https://arxiv.org/abs/2609.34769v1) | 114 puzzle levels; a human needs over 1,000 actions for one level |
| [PlaySuite](https://arxiv.org/html/2610.07127) | about 5,700 itch.io and PyWeek games |
| [Cradle](https://arxiv.org/html/2403.03186v1) | 40-minute missions in Red Dead Redemption 2 |
| [LOLPlay](https://arxiv.org/abs/2611.03685) | League of Legends; the best model reaches 25% |

A 30-minute game demo needs three things the agent lacks today:

- **Seeing pixels.** Games draw on a canvas with no accessibility tree, so the decide step needs a screenshot path.
- **Holding keys in real time.** Games need keys held down, not single presses.
- **Sending keys to the game window.** Today that would take the user's focus. GameWorld avoids both the focus and the timing problems by running browser games that pause while the model thinks, with keys injected in-page.

So the first game target is GameWorld. Long sessions can then reuse the graph, as OmniGameArena's improvement curve does.

## Models to compare

On every benchmark above, the same harness runs with Gemini 4 Argon (decide and verify), Gemini 4 Hydrogen, and Gemini 3.5 Flash-Lite. Flash-Lite answered in 1.29 s per decision against 3.8 s for Argon, but needed 17 decisions where Argon needed 9. Which one is cheaper per *solved* task is the question these runs answer.

## Pilot: learning curve on our own tasks

Runner: `backend/bench/learning_curve.py`. Four tasks (three Calculator sums, one System Settings pane), three repetitions, stateful and stateless runs interleaved.

Results: pending; this section is filled from `backend/bench/results/argon-pilot/trials.csv` when the run ends.
