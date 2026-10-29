# Pocket Pet: a small focus timer

Pocket Pet is a synthetic browser project for trying a coding-agent workflow: add a timer, then change its interaction. It needs no hardware, framework, package installation or external assets.

## Requirements

- Node.js 22.19+ and a modern browser. The local server binds only to `127.0.0.1:4173`.
- To ask Shards Code to edit the starter, build it using the [source guide](../../README.md#build-from-source) and configure a compatible model provider. Provider usage may incur charges.
- Running the finished example and its tests requires no account or model call.

## Try the finished pet

From the repository root:

```bash
node examples/pocket-pet/serve.mjs finished
```

Open `http://127.0.0.1:4173`. The mode links switch between a normal session and the 10-second demo; switching modes resets the timer. Click **Start** for a 25-minute focus session. While running, hold the button for 0.8 seconds to pause; **Resume** is an ordinary click. Space and Enter work with the focused button. Completion triggers a short celebration; **Reset** prepares another session.

For a quick demonstration, open `http://127.0.0.1:4173/?demo=1`. The screen explicitly labels its **10-second demo mode**. It is not a sped-up 25-minute session. Stop the server with Ctrl+C before starting another copy.

## Build it yourself

Create an independent copy so an agent does not edit the repository:

```bash
node examples/pocket-pet/setup.mjs ../my-pocket-pet
cd ../my-pocket-pet
node serve.mjs
```

Open the local URL. In a second terminal, change to the same `my-pocket-pet` directory and run the built Shards CLI:

```bash
node /absolute/path/to/shards-code/dist/cli.js
```

Use the normal permission prompts to review file edits and test execution.

### First request

Paste [prompt-1.txt](prompt-1.txt). It asks the agent to add a Pomodoro timer, preserve the starter's visual design, write tests, and avoid network calls or dependencies. Refresh the browser and check the actual behavior and test output.

### Change the requirement

In the same session, paste [prompt-2.txt](prompt-2.txt). It changes pause to an 800 ms hold, covers pointer and keyboard input, and adds a reduced-motion-aware completion effect. Inspect the edits, run the tests, and check the browser behavior yourself; model output may vary.

## Verify the reference implementation

```bash
node --test examples/pocket-pet/finished/timer.test.mjs examples/pocket-pet/finished/hold.test.mjs
```

The finished directory is an example implementation, not a recorded Shards agent session or evidence of a particular provider's performance. The timer keeps state in memory; reloading resets it. It is an educational example, not an alarm service guaranteed to run while a computer sleeps.
