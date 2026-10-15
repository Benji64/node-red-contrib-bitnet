# node-red-contrib-bitnet

[![npm version](https://img.shields.io/npm/v/node-red-contrib-bitnet.svg)](https://www.npmjs.com/package/node-red-contrib-bitnet)
[![Node-RED](https://img.shields.io/badge/Node--RED-%3E%3D3.0-red)](https://nodered.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Node-RED node that runs **llama-server** from [bitnet.cpp](https://github.com/microsoft/BitNet) (Microsoft's inference framework for 1-bit / BitNet b1.58 LLMs) as a child process and exposes on-device LLM inference directly in your flows — no cloud, no Docker, no external service required.

Designed for edge devices and SBCs (Raspberry Pi, Radxa, Orange Pi…), but works on any machine where bitnet.cpp builds. **CPU only.**

**Single responsibility**: this node manages the llama-server process and handles inference requests. Tool-call orchestration and agentic loops belong to your orchestration layer.

It is the BitNet counterpart of [`node-red-contrib-llama-cpp`](https://github.com/Benji64/node-red-contrib-llama-cpp) — same modes, same two outputs, same control messages — see [Differences with the llama.cpp node](#differences-with-the-llamacpp-node).

---

## Features

- 🚀 **Four focused API modes** — raw completion, OpenAI-compatible proxy, multi-turn chat, **embeddings** (BitNet-embedding models)
- ⚡ **Automatic lifecycle** — spawns `llama-server` on deploy, queues messages during model load, kills cleanly on redeploy
- 🧭 **Knows where BitNet lives** — point it at your BitNet checkout; the binary (`build/bin/llama-server`) and relative model paths are resolved for you
- 🔎 **Build-aware flags** — BitNet's llama.cpp fork changes between versions; the node reads `llama-server --help` once and only sends options your build understands
- 📊 **Performance metrics** — tokens/sec, eval time… emitted on output 2 after every request
- 🔌 **Multi-model** — each node instance manages its own server on its own port
- 🔍 **Live trace toggle** — enable/disable server logs at runtime without redeploying
- 🤝 **Orchestrator-friendly** — raw API response available in `msg.bitnet` for downstream agents

---

## Prerequisites

- **Node-RED** ≥ 3.0 (Node.js ≥ 18)
- **bitnet.cpp built from source** — the node needs the `llama-server` binary that `setup_env.py` produces in `build/bin/`
- A **GGUF model** supported by bitnet.cpp (for example `ggml-model-i2_s.gguf` of BitNet-b1.58-2B-4T)

No npm dependencies — uses only Node.js built-in modules (`child_process`, `http`, `net`, `fs`).

### Build BitNet (once)

Requirements, per the [BitNet README](https://github.com/microsoft/BitNet#installation): Python ≥ 3.10, CMake ≥ 3.22, clang ≥ 18 (Windows: Visual Studio 2022 with the C++/clang components, and use a *Developer* prompt).

```bash
git clone --recursive https://github.com/microsoft/BitNet.git
cd BitNet

# (Recommended by BitNet) use a dedicated conda environment
conda create -n bitnet-cpp python=3.10
conda activate bitnet-cpp

pip install -r requirements.txt

huggingface-cli download microsoft/BitNet-b1.58-2B-4T-gguf --local-dir models/BitNet-b1.58-2B-4T
python setup_env.py -md models/BitNet-b1.58-2B-4T -q i2_s
```

Python and conda are only needed for this build step: the node runs the compiled `llama-server` directly and needs neither at runtime.

You should now have `build/bin/llama-server` (on Windows: `build\bin\Release\llama-server.exe`) and `models/BitNet-b1.58-2B-4T/ggml-model-i2_s.gguf`.

---

## Installation

### Via Node-RED Palette Manager

Search for `node-red-contrib-bitnet` in **Manage Palette → Install**.

### Via npm

```bash
cd ~/.node-red
npm install node-red-contrib-bitnet
```

### Manual, from the zip (for development / SBC without internet)

```bash
unzip node-red-contrib-bitnet.zip -d ~/.node-red/node_modules/
sudo systemctl restart nodered
```

The zip contains a `node-red-contrib-bitnet/` folder, so this creates `~/.node-red/node_modules/node-red-contrib-bitnet/`. There are no npm dependencies to install.

If you only have the files from the repository, copy them by hand instead:

```bash
mkdir -p ~/.node-red/node_modules/node-red-contrib-bitnet
cp bitnet.js bitnet.html package.json \
   ~/.node-red/node_modules/node-red-contrib-bitnet/
sudo systemctl restart nodered
```

---

## Quick Start

1. Drop a **BitNet** node (category *AI*) onto your flow
2. Set **BitNet directory** to your checkout, e.g. `/home/pi/BitNet`
3. Set **Model path** to `models/BitNet-b1.58-2B-4T/ggml-model-i2_s.gguf` (relative to the BitNet directory, or absolute)
4. Set **Port** (default `8080`) — each node needs a unique port
5. Set **Threads** to your physical core count (or leave `-1` for auto)
6. Deploy — the badge shows `loading model…` then `ready :8080`
7. Wire an **inject** node with a string payload and connect to the input

---

## Modes

### `completion`

Uses the `/completion` endpoint. Simple string in, string out. How the text is turned into a prompt is controlled by **Prompt format**:

| Prompt format | What is sent | Use it for |
| ------------- | ------------ | ---------- |
| `template` *(default)* | Messages are rendered by the model's own chat template (server `/apply-template`), then sent to `/completion` | Instruct models, e.g. BitNet-b1.58-2B-4T |
| `raw` | The string, untouched. The System prompt is ignored | Base (non-instruct) models, prompt continuation |
| `plain` | `### System:` / `### Human:` / `### Assistant:` blocks (the llama.cpp node's format) | Models with no usable chat template |

If the server has no `/apply-template` route (older builds), the node warns once and falls back to `plain`.

**Input:**

```js
// String simple
msg.payload = "What is the boiling point of water?"

// Or an OpenAI-style object / messages array
msg.payload = { messages: [{ role: "user", content: "..." }], temperature: 0.2 }

// Or the server's native shape — sent as-is, no formatting at all
msg.payload = { prompt: "The capital of France is", n_predict: 16, grammar: "root ::= ..." }
```

Extra fields of an object payload (`grammar`, `n_keep`, …) are forwarded to the server. `stream` is always forced to `false`.

**Output 1:**

```js
msg.payload = "Water boils at 100°C at standard pressure."
msg.bitnet  = { /* raw /completion response */ }
```

---

### `openai`

Pure proxy to `/v1/chat/completions`. The payload is forwarded, the response is returned as-is. No internal state, no loops. Use this when your orchestration layer drives the conversation.

The node starts the server with `--jinja` when the build supports it, so the chat template stored in the GGUF is applied.

**Input — full OpenAI request object (recommended):**

```js
msg.payload = {
  messages: [
    { role: "system", content: "You are a smart home assistant..." },
    { role: "user",   content: "Turn off the living room light" }
  ],
  temperature: 0.1,
  max_tokens:  400
}
```

Fields present in `msg.payload` **override** the node's default sampling values; fields that are absent take the node's defaults. `stream` is always forced to `false`.

**Input — string or messages array (auto-wrapped):**

```js
msg.payload = "Turn off the living room light"
// or
msg.payload = [{ role: "user", content: "..." }]
```

If a **System prompt** is configured and the messages contain no `system` message, it is inserted first.

**Output 1:**

```js
msg.payload  = "Done, the living room light is now off."  // content string
msg.bitnet   = {                                           // full API response
  id:      "chatcmpl-...",
  choices: [{ message: { role: "assistant", content: "..." }, finish_reason: "stop" }],
  usage:   { prompt_tokens: 214, completion_tokens: 33, total_tokens: 247 },
  timings: { predicted_per_second: 12.4, ... }
}
msg.messages = [ /* full history including assistant reply */ ]
```

---

### `chat`

Same wire behaviour as `openai`, intended for multi-turn conversations. `msg.messages` holds the updated history — pass it back as `msg.payload` on the next message.

```js
// Turn 1
msg.payload = "What is the temperature in the salon?"
// → msg.messages = [{ role:"user", ... }, { role:"assistant", content:"..." }]

// Turn 2 — continue the conversation
msg.payload = msg.messages
```

---

### `embedding`

For the **BitNet-embedding** models (0.6B and 270M). The server is started with `--embedding` and the node calls `/v1/embeddings`.

```js
// One text → one vector
msg.payload = "query: What is BitNet?"
// → msg.payload = [0.0239, 0.6826, -0.0000, ...]      (number[])

// Several texts → one vector per text, in input order
msg.payload = ["first document", "second document"]
// → msg.payload = [[...], [...]]                      (number[][])

// Or an object, forwarded as-is (e.g. to change the normalisation)
msg.payload = { input: "text", embd_normalize: 2 }
```

`msg.bitnet` holds the raw response. Things to know (see the upstream [embeddings guide](https://github.com/microsoft/BitNet/blob/main/docs/bitnet-embeddings-i2s-guide.md)):

- The models use last-token pooling with L2 normalisation (the server normalises with L2 unless you pass `embd_normalize`).
- Queries are expected to carry a short task instruction, documents are not — the guide's own example uses a `query: …` prefix.
- In the BitNet README's supported-models table, these models are listed for the I2_S kernel on **x86** only (ARM is marked ❌).
- **Pooling** can be overridden in the node (`last`, `mean`, `cls`); leave it on *model default* unless you know why. `none` and `rank` are refused by the OpenAI-compatible endpoint, so they are not offered.
- If long inputs are rejected, raise **Batch size** / **μBatch size**.

Sampling and Chat/Prompt settings are hidden in this mode — they do not apply.

---

## Output 2 — metrics & debug

All non-inference messages are emitted on output 2. Use a **Switch** node on `msg.topic` to route them.

### `timing` — after every request

Taken from the `timings` object of the server's response (more reliable than scraping logs, whose format changes between llama.cpp versions):

```js
{
  topic: "timing",
  payload: {
    port:               8080,
    source:             "response",
    cacheTokens:        0,
    promptEvalMs:       53.6,
    promptTokens:       209,
    promptTokensPerSec: 3898.0,
    evalMs:             1399.9,
    evalTokens:         33,
    evalTokensPerSec:   23.6,
    totalMs:            1453.5,
    totalTokens:        242,
    raw:                { /* the server's timings object */ }
  }
}
```

If a build returns no `timings`, the node emits `source: "client"` with the wall-clock `totalMs` and the token counts it could read (`promptTokens`, `evalTokens`, `totalTokens`).

### `debug` — on deploy or on demand

```js
{
  topic: "debug",
  payload: {
    message:          "server ready",
    mode:             "openai",
    command:          "/home/pi/BitNet/build/bin/llama-server --model … --port 8080 -ngl 0 --jinja …",
    binary:           "/home/pi/BitNet/build/bin/llama-server",
    cwd:              "/home/pi/BitNet",
    args:             [ … ],
    capabilities:     { jinja: true, flashAttnValue: true, ctxShiftOn: true, … },
    samplingDefaults: { temperature: 0.8, max_tokens: 512, … },
    port:             8080
  }
}
```

`capabilities` shows what the node detected in your build's `--help`; if a setting seems to be ignored, look here first.

---

## Control messages

| `msg.topic` | `msg.payload`    | Effect                                                                   |
| ----------- | ---------------- | ------------------------------------------------------------------------ |
| `"debug"`   | *(ignored)*      | Emits full config on output 2                                            |
| `"trace"`   | `true` / `false` | Enables/disables llama-server log forwarding to the Node-RED debug panel |

---

## Configuration Reference

### Mode (API)

| Value        | Endpoint               | Use case                                  |
| ------------ | ---------------------- | ----------------------------------------- |
| `completion` | `/completion`          | Simple stateless inference                |
| `openai`     | `/v1/chat/completions` | Orchestrated flows, agentic pipelines     |
| `chat`       | `/v1/chat/completions` | Multi-turn conversations                  |
| `embedding`  | `/v1/embeddings`       | Text embeddings (BitNet-embedding models) |

### BitNet

| Field          | Default       | Description                                                                                                                         |
| -------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| BitNet directory | *(empty)*   | Root of your BitNet checkout. The server runs from there (`cwd`) and the binary is `build/bin/llama-server` (Windows: `build\bin\Release\llama-server.exe`, mirroring BitNet's `run_inference_server.py`) |
| Model path     | *(required)*  | Absolute, or relative to the BitNet directory. `~` is expanded                                                                     |
| Binary         | *(empty)*     | Override: absolute path, a path relative to the BitNet directory, or a bare name looked up in `$PATH`                              |
| Alias          | *(empty)*     | Model name exposed in the API (`--alias`)                                                                                          |

### Server

| Field               | Default     | Flag              | Description                                          |
| ------------------- | ----------- | ----------------- | ---------------------------------------------------- |
| Port                | `8080`      | `--port`          | Each node needs a unique port                        |
| Host                | `127.0.0.1` | `--host`          | Bind address (`0.0.0.0` is fine — the node still connects through `127.0.0.1`) |
| Parallel slots      | `1`         | `--parallel`      | Simultaneous requests; each slot uses extra RAM      |
| Continuous batching | `true`      | `--cont-batching` | Better throughput with multiple slots                |
| Flash Attention     | `false`     | `-fa`             | Sent as `-fa on` or `-fa` depending on the build     |
| mlock               | `false`     | `--mlock`         | Lock model in RAM, prevents swap                     |
| Disable mmap        | `false`     | `--no-mmap`       | Load fully into RAM (faster inference, slower start) |
| No warmup           | `false`     | `--no-warmup`     | Skip warmup pass at startup                          |

> ⚠️ `llama-server` is started **without an API key**. Keep **Host** on `127.0.0.1` unless every machine on your network is trusted.

### Context

| Field         | Default | Flag                                    | Description                                                   |
| ------------- | ------- | --------------------------------------- | ------------------------------------------------------------- |
| Context size  | `2048`  | `--ctx-size`                            | Token window. `0` = use model's built-in value               |
| Batch size    | `512`   | `--batch-size`                          | Tokens processed in parallel during prefill                   |
| μBatch size   | `512`   | `--ubatch-size`                         | Physical micro-batch, must be ≤ batch size                    |
| Context shift | *build default* | `--context-shift` / `--no-context-shift` | Roll the context when full. Recent builds ship with it disabled; older builds had it always on |

### CPU / Threads

| Field             | Default | Flag              | Description                                   |
| ----------------- | ------- | ----------------- | --------------------------------------------- |
| Inference threads | `-1`    | `--threads`       | CPU threads for generation. `-1` = auto       |
| Batch threads     | `-1`    | `--threads-batch` | CPU threads for prefill. `-1` = same as above |

There is no GPU section: BitNet's CPU kernels are what this node drives, and the server is always started with `-ngl 0` (like `run_inference_server.py` does).

### Sampling (node defaults — overridden by payload fields)

| Field          | Default | Description                     |
| -------------- | ------- | ------------------------------- |
| Max tokens     | `512`   | Maximum tokens to generate      |
| Temperature    | `0.8`   | Randomness. `0` = deterministic |
| Top-K          | `40`    | `0` = disabled                  |
| Top-P          | `0.95`  | `1.0` = disabled                |
| Min-P          | `0.05`  | `0` = disabled                  |
| Repeat penalty | `1.1`   | `1.0` = no penalty              |
| Repeat last N  | `64`    | `0` = disabled                  |
| Seed           | `-1`    | `-1` = random, not sent         |
| Mirostat       | `off`   | Adaptive sampling. v1 or v2     |
| Mirostat τ     | `5.0`   | Target entropy                  |
| Mirostat η     | `0.1`   | Learning rate                   |

### Chat / Prompt

| Field         | Description                                                                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt format | `completion` mode only — `template` / `raw` / `plain`, see [Modes](#completion)                                                                                                                      |
| Chat template | Leave blank to use the template stored in the GGUF (recommended). Otherwise a built-in template name such as `chatml`, `llama3`… If a model carries no template, recent llama-server builds fall back to ChatML |
| System prompt | `completion` (`template`/`plain`) and `openai`/`chat`: inserted as a system message when the input has none. Ignored in `raw` format                                                                    |

### Embedding

| Field   | Default        | Description                                                  |
| ------- | -------------- | ------------------------------------------------------------ |
| Pooling | *model default* | `--pooling` override: `last`, `mean` or `cls`                |

### Debug

| Field         | Description                                                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enable traces | Forwards every stdout/stderr line from llama-server to the Node-RED debug panel as `[bitnet:port] …`. Also togglable at runtime: `msg.topic = "trace"`, `msg.payload = true/false` |

---

## Differences with the llama.cpp node

| | `node-red-contrib-llama-cpp` | `node-red-contrib-bitnet` |
| --- | --- | --- |
| Binary | `llama-server` from `$PATH` or a full path | `<BitNet directory>/build/bin/llama-server`, resolved for you |
| Model path | Absolute | Absolute or relative to the BitNet directory |
| Modes | `completion`, `openai`, `chat` | + `embedding` |
| Cluster / RPC (master, worker) | Yes | No — BitNet's build files (`setup_env.py`, `CMakeLists.txt`) have no RPC backend option |
| GPU settings | `-ngl`, split mode, main GPU, tensor split | None — CPU only, `-ngl 0` |
| Flags | Fixed set | Probed from `--help`, unsupported options are skipped with a warning |
| `completion` prompt | `### Human:` / `### Assistant:` | `template` (default) / `raw` / `plain` |
| Raw response | `msg.llamacpp` | `msg.bitnet` |
| `timing` source | Parsed from server logs | `timings` of the HTTP response |
| Readiness | Log lines, then an HTTP probe | `/health` returns 200 (the server answers 503 while loading) |
| Start-up failure | Status only | Status + the server's last log lines in the error |
| Numeric fields | `0` falls back to the default | `0` is honoured (temperature, Min-P, Top-K, Repeat last N, Context size) |

---

## Integration with agentic orchestrators

The `openai` mode is designed to be a transparent inference brick in an agentic pipeline:

```
[orchestrator]
  │  msg.payload = { messages, tools, temperature… }
  ▼
[bitnet (openai mode)]
  │  msg.payload  = content string
  │  msg.bitnet   = full API response (inspect choices[0].message)
  │  msg.messages = updated history
  ▼
[orchestrator]
  → inspects msg.bitnet, runs its own tools, appends results to msg.messages
  → re-sends to bitnet for the next turn
```

The node never interprets or acts on `tool_calls` — it forwards raw API output and lets the orchestrator decide what to do next.

> BitNet-b1.58-2B-4T is a small research model. Its model card does not recommend commercial or real-world use without further testing, so validate tool-calling and instruction-following on your own prompts before putting it in a control loop.

---

## Multiple models

Each node instance spawns its own `llama-server` process on its own port. Nodes are fully independent.

```
Node A: BitNet-b1.58-2B-4T         port = 8080  → chat / reasoning
Node B: BitNet-embedding-0.6B      port = 8081  → embeddings for retrieval
```

Total RAM usage = sum of all loaded models.

---

## Tips for edge / SBC devices

- **Threads**: set to the physical core count. BitNet's own server script defaults to 2, which leaves most cores idle.
- **Context**: BitNet's script defaults to 2048; BitNet-b1.58-2B-4T's model card lists a 4096-token maximum sequence length. Start small and grow only if needed.
- **μBatch size**: reduce to `128` if you hit OOM errors during prefill.
- **mlock**: useful if you have enough RAM and want to avoid swap latency.
- **Rebuild for your hardware**: `setup_env.py` generates kernel code for the model layout you give it and compiles the binary, so re-run it when you change model family. Pick the quantization with `-q` (`i2_s` on ARM and x86, `tl1` on ARM only, `tl2` on x86 only). Tiling is configurable in BitNet's `include/gemm-config.h` (rebuild after editing), and `setup_env.py --quant-embd` enables embedding quantization — see BitNet's `src/README.md`.
- **Memory**: the BitNet-b1.58-2B-4T model card lists about 0.4 GB of non-embedding memory, far below the full-precision models it is compared with.

---

## Troubleshooting

### Status `binary not found`

The node looks for `<BitNet directory>/build/bin/llama-server`. Make sure `python setup_env.py …` completed, or set **Binary** to the real path.

### Status `model not found`

Relative model paths are resolved from the **BitNet directory**; use an absolute path otherwise. Node-RED may also run as a different user with a different home directory (`~` is that user's home).

### Node stays on `loading model…`

Enable **traces**, redeploy, and watch the Node-RED debug panel. You can also probe manually — `503` means still loading, `200` means ready:

```bash
curl -i http://127.0.0.1:8080/health
```

### Status `exited (N)`

The error written to the debug panel ends with the server's last log lines, which usually name the cause (unreadable GGUF, wrong model for this build, unknown flag…).

### A setting seems ignored

Send `msg.topic = "debug"` and look at `capabilities`: options your build does not know are skipped, with one warning each in the Node-RED log.

### Odd answers in `openai` / `chat` mode

The reply format depends on the chat template. Leave **Chat template** empty to use the one stored in the GGUF, and check that `capabilities.jinja` is `true` — a build without `--jinja` only knows its built-in templates (the node warns about it at start-up).

### Port already in use

Each node needs a unique port. The badge shows `port XXXX déjà utilisé` at deploy time.

---

## License

MIT
