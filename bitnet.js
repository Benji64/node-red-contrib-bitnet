"use strict";

const { spawn, execFile } = require("child_process");
const http = require("http");
const net  = require("net");
const fs   = require("fs");
const os   = require("os");
const path = require("path");

const POLL_INTERVAL_MS = 500;
const LOG_TAIL_LINES   = 25;
const MODES = ["completion", "openai", "chat", "embedding"];

// Le fork llama.cpp embarqué par BitNet évolue (le sous-module a changé de dépôt
// et de branche) : les flags de llama-server ne sont pas les mêmes d'un build à
// l'autre. On lit `--help` une fois par binaire et on n'envoie que ce que le
// build comprend, au lieu de planter sur "invalid argument".
const capsCache = new Map();

// Hypothèse si `--help` est illisible : build récent (fork épinglé par BitNet).
const MODERN_CAPS = Object.freeze({
  jinja: true, flashAttn: true, flashAttnValue: true,
  contBatching: true, noContBatching: true,
  ctxShiftOn: true, ctxShiftOff: true, noWarmup: true,
  embedding: true, pooling: true, chatTemplate: true
});

function parseCaps(help) {
  const has = (re) => re.test(help);
  return {
    jinja:          has(/--jinja\b/),
    flashAttn:      has(/--flash-attn\b/),
    // récent : "-fa on|off|auto" — ancien : "-fa" sans valeur
    flashAttnValue: has(/--flash-attn[^\n]{0,60}\[on\|off\|auto\]/),
    contBatching:   has(/--cont-batching\b/),
    noContBatching: has(/--no-cont-batching\b/),
    ctxShiftOn:     has(/--context-shift\b/),
    ctxShiftOff:    has(/--no-context-shift\b/),
    noWarmup:       has(/--no-warmup\b/),
    embedding:      has(/--embedding\b/),
    pooling:        has(/--pooling\b/),
    chatTemplate:   has(/--chat-template\b/)
  };
}

function fileStamp(p) {
  try { return String(fs.statSync(p).mtimeMs); } catch (e) { return ""; }
}

function probeCaps(binary, cwd, cb) {
  // La clé inclut la date du binaire : recompiler BitNet invalide le cache.
  const key = `${binary}|${cwd || ""}|${path.isAbsolute(binary) ? fileStamp(binary) : ""}`;
  if (capsCache.has(key)) return cb(null, capsCache.get(key));
  execFile(binary, ["--help"], {
    cwd, timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true
  }, (err, stdout, stderr) => {
    const help = String(stdout || "") + "\n" + String(stderr || "");
    if (err && err.code === "ENOENT") return cb(err, null);
    if (help.length < 200)            return cb(err || new Error("sortie --help vide"), null);
    const caps = parseCaps(help);
    capsCache.set(key, caps);
    cb(null, caps);
  });
}

// parseInt(x) || défaut écrase les 0 légitimes (temperature, min-p, top-k…).
function toInt(v, def)   { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; }
function toFloat(v, def) { const n = parseFloat(v);   return Number.isFinite(n) ? n : def; }
function isObj(x)        { return x !== null && typeof x === "object" && !Array.isArray(x); }

function expandHome(p) {
  return (typeof p === "string" && /^~(?=$|[\\/])/.test(p))
    ? path.join(os.homedir(), p.slice(1))
    : p;
}

function contentText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c))      return c.map((part) => (part && part.text) || "").join("");
  return c === undefined || c === null ? "" : JSON.stringify(c);
}

// Découpe un flux en lignes complètes (un chunk peut s'arrêter en milieu de ligne).
function lineReader(onLine) {
  let rest = "";
  return (chunk) => {
    rest += chunk.toString();
    const parts = rest.split(/\r\n|\n|\r/);
    rest = parts.pop();
    for (const l of parts) {
      const t = l.trim();
      if (t) onLine(t);
    }
  };
}

module.exports = function (RED) {
  function BitNetNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // ── Installation BitNet ────────────────────────────────
    node.bitnetDir    = expandHome((config.bitnetDir    || "").trim());
    node.bitnetBinary = expandHome((config.bitnetBinary || "").trim());
    node.modelPath    = expandHome((config.modelPath    || "").trim());
    node.alias        = (config.alias || "").trim();

    // ── Mode API : "completion" | "openai" | "chat" | "embedding" ──
    node.mode = MODES.includes(config.mode) ? config.mode : "completion";

    // ── Server ─────────────────────────────────────────────
    node.serverPort   = toInt(config.serverPort, 8080);
    node.host         = (config.host || "127.0.0.1").trim();
    node.nSlots       = Math.max(1, toInt(config.nSlots, 1));
    node.contBatching = config.contBatching !== false;
    node.noMmap       = config.noMmap    === true;
    node.mlock        = config.mlock     === true;
    node.noWarmup     = config.noWarmup  === true;
    node.flashAttn    = config.flashAttn === true;

    // ── Context ────────────────────────────────────────────
    node.contextSize = toInt(config.contextSize, 2048);   // 0 = valeur du modèle
    node.batchSize   = toInt(config.batchSize, 512);
    node.ubatchSize  = toInt(config.ubatchSize, 512);
    // "" = défaut du build (désactivé sur les builds récents) | "on" | "off"
    node.ctxShift    = (config.ctxShift === "on" || config.ctxShift === "off") ? config.ctxShift : "";

    // ── Threads ────────────────────────────────────────────
    node.threads      = toInt(config.threads, -1);
    node.threadsBatch = toInt(config.threadsBatch, -1);

    // ── Sampling ───────────────────────────────────────────
    node.temperature   = toFloat(config.temperature, 0.8);
    node.maxTokens     = toInt(config.maxTokens, 512);
    node.topK          = toInt(config.topK, 40);
    node.topP          = toFloat(config.topP, 0.95);
    node.minP          = toFloat(config.minP, 0.05);
    node.repeatPenalty = toFloat(config.repeatPenalty, 1.1);
    node.repeatLastN   = toInt(config.repeatLastN, 64);
    node.seed          = toInt(config.seed, -1);
    node.mirostat      = toInt(config.mirostat, 0);
    node.mirostatTau   = toFloat(config.mirostatTau, 5.0);
    node.mirostatEta   = toFloat(config.mirostatEta, 0.1);

    // ── Chat / Prompt / Embedding ──────────────────────────
    node.promptFormat = ["template", "raw", "plain"].includes(config.promptFormat)
                          ? config.promptFormat : "template";
    node.chatTemplate = (config.chatTemplate || "").trim();
    node.systemPrompt = config.systemPrompt || "";
    // none / rank sont refusés par /v1/embeddings (« not OAI compatible »)
    node.pooling      = ["mean", "cls", "last"].includes(config.pooling)
                          ? config.pooling : "";

    // ── Debug ──────────────────────────────────────────────
    node.debugTrace = config.debugTrace === true;

    // ── Internal state ─────────────────────────────────────
    node.serverProcess = null;
    node.serverReady   = false;
    node.pendingQueue  = [];

    let starting       = false;   // évite un double spawn pendant les étapes asynchrones
    let closing        = false;
    let inflight       = 0;
    let caps           = null;
    let binaryResolved = "";
    let lastArgs       = null;
    let logTail        = [];
    let applyTemplateBroken = false;   // /apply-template absent (build ancien)
    let pollTimer      = null;
    let pollToken      = 0;
    const warned       = new Set();

    // ──────────────────────────────────────────────────────
    // Utilitaires
    // ──────────────────────────────────────────────────────

    function setStatus(color, text) {
      node.status({ fill: color, shape: "dot", text });
    }

    function warnOnce(key, text) {
      if (warned.has(key)) return;
      warned.add(key);
      node.warn(text);
    }

    function statusReadyText() { return `ready :${node.serverPort}`; }

    function isPortFree(port, cb) {
      const srv = net.createServer();
      srv.once("error", (e) => cb(e.code === "EADDRINUSE" ? false : null));
      srv.once("listening", () => srv.close(() => cb(true)));
      srv.listen(port, "127.0.0.1");
    }

    // 0.0.0.0 / :: sont des adresses d'écoute, pas des destinations.
    function reqHost() {
      return (!node.host || node.host === "0.0.0.0" || node.host === "::") ? "127.0.0.1" : node.host;
    }

    // Requête JSON vers le serveur local. cb(err, parsed, statusCode)
    function httpJson(method, urlPath, body, cb) {
      let finished = false;
      const finish = (err, parsed, status) => {
        if (finished) return;
        finished = true;
        cb(err, parsed, status);
      };
      const payload = body === undefined ? null : JSON.stringify(body);
      const headers = payload
        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
        : {};
      const req = http.request(
        { hostname: reqHost(), port: node.serverPort, path: urlPath, method, headers },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("error", (e) => finish(e));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed = null;
            if (text) {
              try { parsed = JSON.parse(text); }
              catch (e) {
                return finish(new Error(`HTTP ${res.statusCode} — réponse non JSON : ${text.slice(0, 200)}`), null, res.statusCode);
              }
            }
            if (res.statusCode >= 400) {
              const em = parsed && parsed.error;
              const msg = (em && (em.message || (typeof em === "string" ? em : ""))) || `HTTP ${res.statusCode}`;
              return finish(new Error(msg), parsed, res.statusCode);
            }
            finish(null, parsed, res.statusCode);
          });
        }
      );
      req.on("error", (e) => finish(e));
      if (payload) req.write(payload);
      req.end();
    }

    function parsePayload(p) {
      if (Buffer.isBuffer(p)) p = p.toString("utf8");
      if (typeof p === "string") {
        const t = p.trim();
        if (t.startsWith("{") || t.startsWith("[")) {
          try { return JSON.parse(t); } catch (e) { /* pas du JSON : prompt texte */ }
        }
      }
      return p;
    }

    function samplingDefaults() {
      return {
        temperature:    node.temperature,
        max_tokens:     node.maxTokens,
        top_k:          node.topK,
        top_p:          node.topP,
        min_p:          node.minP,
        repeat_penalty: node.repeatPenalty,
        repeat_last_n:  node.repeatLastN,
        ...(node.seed !== -1  && { seed: node.seed }),
        ...(node.mirostat > 0 && {
          mirostat:     node.mirostat,
          mirostat_tau: node.mirostatTau,
          mirostat_eta: node.mirostatEta
        })
      };
    }

    // ──────────────────────────────────────────────────────
    // Chemins : dossier BitNet, binaire, modèle
    // ──────────────────────────────────────────────────────

    function spawnCwd() {
      return node.bitnetDir ? path.resolve(node.bitnetDir) : undefined;
    }

    function resolveFromCwd(p) {
      return path.isAbsolute(p) ? p : path.resolve(spawnCwd() || process.cwd(), p);
    }

    function looksLikePath(p) { return /[\\/]/.test(p); }

    // Même logique que run_inference_server.py : build/bin/llama-server
    // (Windows : build/bin/Release/llama-server.exe, sinon build/bin/llama-server.exe)
    function resolveBinary() {
      if (node.bitnetBinary) {
        return looksLikePath(node.bitnetBinary) ? resolveFromCwd(node.bitnetBinary) : node.bitnetBinary;
      }
      if (!node.bitnetDir) return "llama-server";   // dernier recours : $PATH
      const exe  = process.platform === "win32" ? "llama-server.exe" : "llama-server";
      const base = path.resolve(node.bitnetDir, "build", "bin");
      const candidates = process.platform === "win32"
        ? [path.join(base, "Release", exe), path.join(base, exe)]
        : [path.join(base, exe)];
      return candidates.find((c) => fs.existsSync(c)) || candidates[0];
    }

    // ──────────────────────────────────────────────────────
    // Build args — llama-server (BitNet)
    // ──────────────────────────────────────────────────────

    function buildArgs(c) {
      const a = [];
      a.push("--model",         resolveFromCwd(node.modelPath));
      a.push("--port",          String(node.serverPort));
      a.push("--host",          node.host);
      a.push("--ctx-size",      String(node.contextSize));
      a.push("--batch-size",    String(node.batchSize));
      a.push("--ubatch-size",   String(node.ubatchSize));
      a.push("--threads",       String(node.threads));
      a.push("--threads-batch", String(node.threadsBatch));
      a.push("--parallel",      String(node.nSlots));
      a.push("-ngl", "0");   // BitNet : CPU uniquement (comme run_inference_server.py)
      if (node.seed !== -1) a.push("--seed", String(node.seed));
      if (node.alias)       a.push("--alias", node.alias);

      if (node.mode === "embedding") {
        a.push("--embedding");
        if (node.pooling) {
          if (c.pooling) a.push("--pooling", node.pooling);
          else warnOnce("pooling", "bitnet: ce build ne connaît pas --pooling, réglage ignoré.");
        }
      } else {
        // /v1/chat/completions (openai, chat) et /apply-template (completion + template)
        const needsTemplate = node.mode !== "completion" || node.promptFormat === "template";
        if (needsTemplate) {
          if (c.jinja) a.push("--jinja");
          else warnOnce("jinja", "bitnet: ce build n'a pas --jinja — le chat template intégré au GGUF n'est appliqué que s'il fait partie des templates natifs. Renseignez « Chat template » si les réponses sont incohérentes.");
        }
        if (node.chatTemplate) a.push("--chat-template", node.chatTemplate);
      }

      if (node.contBatching) {
        if (c.contBatching) a.push("--cont-batching");
      } else if (c.noContBatching) {
        a.push("--no-cont-batching");
      }

      if (node.flashAttn) {
        if (!c.flashAttn) warnOnce("fa", "bitnet: ce build ne connaît pas --flash-attn, réglage ignoré.");
        else if (c.flashAttnValue) a.push("-fa", "on");
        else a.push("-fa");
      }
      if (node.mlock)  a.push("--mlock");
      if (node.noMmap) a.push("--no-mmap");
      if (node.noWarmup) {
        if (c.noWarmup) a.push("--no-warmup");
        else warnOnce("warmup", "bitnet: ce build ne connaît pas --no-warmup, réglage ignoré.");
      }

      if (node.ctxShift === "on" && c.ctxShiftOn)  a.push("--context-shift");
      if (node.ctxShift === "off") {
        if (c.ctxShiftOff) a.push("--no-context-shift");
        else warnOnce("ctxshift", "bitnet: ce build ne connaît pas --no-context-shift, réglage ignoré.");
      }
      return a;
    }

    // ──────────────────────────────────────────────────────
    // Construction des prompts / messages
    // ──────────────────────────────────────────────────────

    function withSystem(msgs) {
      if (node.systemPrompt && !msgs.some((m) => m && m.role === "system")) {
        return [{ role: "system", content: node.systemPrompt }, ...msgs];
      }
      return msgs;
    }

    function toMessages(p, useSystem) {
      let msgs;
      if (isObj(p) && Array.isArray(p.messages)) msgs = p.messages.slice();
      else if (Array.isArray(p))                 msgs = p.slice();
      else {
        const text = typeof p === "string" ? p : JSON.stringify(p);
        msgs = [{ role: "user", content: text }];
      }
      return useSystem === false ? msgs : withSystem(msgs);
    }

    // Format historique du node llama.cpp (### Human / ### Assistant)
    function plainPrompt(msgs) {
      const label = (r) => (r === "system" ? "System" : r === "assistant" ? "Assistant" : "Human");
      return {
        prompt: msgs.map((m) => `### ${label(m.role)}:\n${contentText(m.content)}`).join("\n\n") + "\n\n### Assistant:\n",
        stop:   ["\n### Human:", "\n### User:"]
      };
    }

    // cb(prompt, stop?)
    function buildCompletionPrompt(p, cb) {
      if (isObj(p) && typeof p.prompt === "string") return cb(p.prompt);   // natif /completion

      if (node.promptFormat === "raw") {
        if (typeof p === "string") return cb(p);
        return cb(toMessages(p, false).map((m) => contentText(m.content)).join("\n"));
      }

      const msgs = toMessages(p, true);
      if (node.promptFormat === "template" && !applyTemplateBroken) {
        return httpJson("POST", "/apply-template", { messages: msgs }, (err, parsed, status) => {
          if (!err && parsed && typeof parsed.prompt === "string") return cb(parsed.prompt);
          if (status === 404 || status === 405 || status === 501) applyTemplateBroken = true;
          node.warn(`bitnet: /apply-template indisponible (${err ? err.message : "réponse vide"}) — repli sur le format « plain » (### Human / ### Assistant).`);
          const f = plainPrompt(msgs);
          cb(f.prompt, f.stop);
        });
      }
      const f = plainPrompt(msgs);
      cb(f.prompt, f.stop);
    }

    // ──────────────────────────────────────────────────────
    // Suivi des requêtes en cours + timing
    // ──────────────────────────────────────────────────────

    function beginRequest() { inflight++; setStatus("blue", "inferring..."); }

    function endRequest(errText) {
      inflight = Math.max(0, inflight - 1);
      if (errText) setStatus("red", String(errText).slice(0, 60));
      else if (inflight === 0) setStatus("green", statusReadyText());
    }

    function failRequest(msg, err) {
      const text = (err && err.message) || String(err);
      node.error(text, msg);
      endRequest(text);
    }

    // Les stats viennent de `timings` dans la réponse HTTP (plus fiable que les logs,
    // dont le format change d'une version de llama.cpp à l'autre).
    function emitTiming(parsed, startedAt) {
      const t = parsed && parsed.timings;
      const payload = { port: node.serverPort };
      if (t) {
        const pMs = t.prompt_ms || 0, gMs = t.predicted_ms || 0;
        const pN  = t.prompt_n  || 0, gN  = t.predicted_n  || 0;
        Object.assign(payload, {
          source:             "response",
          cacheTokens:        t.cache_n || 0,
          promptEvalMs:       pMs,
          promptTokens:       pN,
          promptTokensPerSec: t.prompt_per_second,
          evalMs:             gMs,
          evalTokens:         gN,
          evalTokensPerSec:   t.predicted_per_second,
          totalMs:            pMs + gMs,
          totalTokens:        pN + gN,
          raw:                t
        });
      } else {
        // Build sans `timings` : on ne connaît que la durée totale et le nombre de tokens.
        const u = (parsed && parsed.usage) || {};
        const pN = u.prompt_tokens     !== undefined ? u.prompt_tokens     : (parsed && parsed.tokens_evaluated);
        const gN = u.completion_tokens !== undefined ? u.completion_tokens : (parsed && parsed.tokens_predicted);
        Object.assign(payload, {
          source:       "client",
          totalMs:      Date.now() - startedAt,
          promptTokens: pN,
          evalTokens:   gN,
          totalTokens:  (pN || 0) + (gN || 0)
        });
      }
      node.send([null, { topic: "timing", payload }]);
    }

    // ──────────────────────────────────────────────────────
    // Mode completion — /completion
    // ──────────────────────────────────────────────────────

    function handleCompletion(msg) {
      const p  = parsePayload(msg.payload);
      const sp = isObj(p) ? p : {};
      const startedAt = Date.now();
      beginRequest();

      buildCompletionPrompt(p, (prompt, stop) => {
        const d    = samplingDefaults();
        const body = {
          prompt,
          n_predict:      sp.n_predict !== undefined ? sp.n_predict
                        : sp.max_tokens !== undefined ? sp.max_tokens : d.max_tokens,
          temperature:    sp.temperature    !== undefined ? sp.temperature    : d.temperature,
          top_k:          sp.top_k          !== undefined ? sp.top_k          : d.top_k,
          top_p:          sp.top_p          !== undefined ? sp.top_p          : d.top_p,
          min_p:          sp.min_p          !== undefined ? sp.min_p          : d.min_p,
          repeat_penalty: sp.repeat_penalty !== undefined ? sp.repeat_penalty : d.repeat_penalty,
          repeat_last_n:  sp.repeat_last_n  !== undefined ? sp.repeat_last_n  : d.repeat_last_n
        };
        if (d.seed !== undefined) body.seed = d.seed;
        if (d.mirostat !== undefined) {
          body.mirostat = d.mirostat; body.mirostat_tau = d.mirostat_tau; body.mirostat_eta = d.mirostat_eta;
        }
        if (stop) body.stop = stop;

        // Tout le reste du payload objet est transmis tel quel (grammar, json_schema, n_keep…)
        const extra = Object.assign({}, sp);
        delete extra.messages; delete extra.prompt; delete extra.max_tokens;
        Object.assign(body, extra, { stream: false });

        httpJson("POST", "/completion", body, (err, parsed) => {
          if (err) return failRequest(msg, err);
          msg.payload = (parsed.content || "").trim();
          msg.bitnet  = parsed;
          node.send([msg, null]);
          emitTiming(parsed, startedAt);
          endRequest();
        });
      });
    }

    // ──────────────────────────────────────────────────────
    // Modes openai / chat — /v1/chat/completions
    // openai : proxy pur ; chat : idem, destiné aux conversations multi-tours
    // (msg.messages est renvoyé à chaque tour, à repasser en payload au suivant)
    // ──────────────────────────────────────────────────────

    function handleChatCompletions(msg) {
      const p     = parsePayload(msg.payload);
      const model = node.alias || "bitnet";
      let body;

      if (isObj(p) && Array.isArray(p.messages)) {
        // Les champs du payload l'emportent sur les défauts de sampling du node.
        body = Object.assign({ model }, samplingDefaults(), p, { messages: toMessages(p, true) });
      } else {
        body = Object.assign({ model }, samplingDefaults(), { messages: toMessages(p, true) });
      }
      body.stream = false;

      const startedAt = Date.now();
      beginRequest();
      httpJson("POST", "/v1/chat/completions", body, (err, parsed) => {
        if (err) return failRequest(msg, err);
        const choice = parsed && parsed.choices && parsed.choices[0];
        if (!choice || !choice.message) return failRequest(msg, new Error("Réponse vide du serveur"));

        msg.payload  = choice.message.content || "";
        msg.bitnet   = parsed;
        msg.messages = body.messages.concat([choice.message]);
        node.send([msg, null]);
        emitTiming(parsed, startedAt);
        endRequest();
      });
    }

    // ──────────────────────────────────────────────────────
    // Mode embedding — /v1/embeddings (modèles BitNet-embedding)
    // ──────────────────────────────────────────────────────

    function handleEmbedding(msg) {
      const p     = parsePayload(msg.payload);
      const model = node.alias || "bitnet";
      let body;
      if (isObj(p) && p.input !== undefined) body = Object.assign({ model }, p);
      else if (typeof p === "string" || Array.isArray(p)) body = { model, input: p };
      else body = { model, input: JSON.stringify(p) };

      const startedAt = Date.now();
      beginRequest();
      httpJson("POST", "/v1/embeddings", body, (err, parsed) => {
        if (err) return failRequest(msg, err);
        const data = parsed && Array.isArray(parsed.data) ? parsed.data.slice() : null;
        if (!data || data.length === 0) return failRequest(msg, new Error("Réponse vide du serveur"));
        data.sort((x, y) => (x.index || 0) - (y.index || 0));
        const vectors = data.map((d) => d.embedding);

        // string en entrée → un vecteur ; tableau en entrée → un vecteur par entrée
        msg.payload = typeof body.input === "string" ? vectors[0] : vectors;
        msg.bitnet  = parsed;
        node.send([msg, null]);
        emitTiming(parsed, startedAt);
        endRequest();
      });
    }

    // ──────────────────────────────────────────────────────
    // Dispatch inférence
    // ──────────────────────────────────────────────────────

    function handleMessage(msg) {
      if (msg.payload === undefined || msg.payload === null || msg.payload === "") {
        node.warn("bitnet: msg.payload vide, message ignoré.");
        return;
      }
      if      (node.mode === "embedding")  handleEmbedding(msg);
      else if (node.mode === "completion") handleCompletion(msg);
      else                                 handleChatCompletions(msg);
    }

    function flushQueue(reason) {
      const q = node.pendingQueue;
      node.pendingQueue = [];
      for (const m of q) node.error(reason, m);
    }

    // ──────────────────────────────────────────────────────
    // Debug info (sortie 2)
    // ──────────────────────────────────────────────────────

    function emitDebugInfo(label) {
      const bin  = binaryResolved || resolveBinary();
      const args = lastArgs || (() => {
        try { return buildArgs(caps || MODERN_CAPS); } catch (e) { return []; }
      })();
      node.send([null, {
        topic: "debug",
        payload: {
          message:          label || "server ready",
          mode:             node.mode,
          command:          bin + " " + args.join(" "),
          binary:           bin,
          cwd:              spawnCwd() || process.cwd(),
          args,
          capabilities:     caps,
          samplingDefaults: samplingDefaults(),
          port:             node.serverPort
        }
      }]);
    }

    // ──────────────────────────────────────────────────────
    // Démarrage
    // ──────────────────────────────────────────────────────

    function stopHealthPoll() {
      pollToken++;
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    }

    // Prêt = /health répond 200. Pendant le chargement du modèle le serveur
    // écoute déjà mais répond 503 : on attend donc le 200, quelle que soit
    // la version et le format des logs.
    function startHealthPoll(proc) {
      stopHealthPoll();
      const token = pollToken;
      const t0 = Date.now();
      let n = 0;
      (function attempt() {
        pollTimer = null;
        if (token !== pollToken || node.serverProcess !== proc) return;
        httpJson("GET", "/health", undefined, (err, parsed, status) => {
          if (token !== pollToken || node.serverProcess !== proc) return;
          if (!err && status === 200) return markReady();
          n++;
          if (n % 10 === 0) {
            setStatus("yellow", `loading model :${node.serverPort} (${Math.round((Date.now() - t0) / 1000)}s)`);
          }
          pollTimer = setTimeout(attempt, POLL_INTERVAL_MS);
        });
      })();
    }

    function markReady() {
      if (node.serverReady) return;
      node.serverReady = true;
      setStatus("green", statusReadyText());
      node.log(`bitnet server ready [${node.mode}] :${node.serverPort}`);
      emitDebugInfo("server ready");
      while (node.pendingQueue.length > 0) handleMessage(node.pendingQueue.shift());
    }

    function failStart(statusText, errText) {
      starting = false;
      setStatus("red", statusText);
      node.error(errText);
      flushQueue(errText);
    }

    function spawnServer() {
      const args = buildArgs(caps);
      lastArgs = args;
      logTail  = [];
      node.log(`Spawn: ${binaryResolved} ${args.join(" ")}`);
      setStatus("yellow", `loading model :${node.serverPort}...`);

      const proc = spawn(binaryResolved, args, {
        cwd: spawnCwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true
      });
      node.serverProcess = proc;

      const onLine = (t) => {
        logTail.push(t);
        if (logTail.length > LOG_TAIL_LINES) logTail.shift();
        if (node.debugTrace) node.warn(`[bitnet:${node.serverPort}] ${t}`);
      };
      proc.stdout.on("data", lineReader(onLine));
      proc.stderr.on("data", lineReader(onLine));

      proc.on("error", (err) => {
        if (node.serverProcess !== proc) return;
        stopHealthPoll();
        node.serverProcess = null;
        node.serverReady   = false;
        failStart("spawn error", `bitnet: échec du lancement (${binaryResolved}) : ${err.message}`);
      });

      proc.on("close", (code, signal) => {
        if (node.serverProcess !== proc) return;
        node.log(`bitnet server :${node.serverPort} exited (${code !== null ? code : signal})`);
        stopHealthPoll();
        node.serverProcess = null;
        node.serverReady   = false;
        if (closing) return;
        if (code !== 0) {
          // Les dernières lignes de log disent presque toujours pourquoi (modèle illisible, flag inconnu…)
          const tail = logTail.length ? "\nDernières lignes :\n" + logTail.join("\n") : "";
          failStart(`exited (${code !== null ? code : signal})`, `bitnet: llama-server arrêté (${code !== null ? code : signal}).${tail}`);
        } else {
          setStatus("grey", "stopped");
          flushQueue("bitnet: le serveur s'est arrêté avant de répondre.");
        }
      });

      starting = false;
      startHealthPoll(proc);
    }

    function startServer() {
      if (starting || node.serverProcess || closing) return;
      starting = true;

      if (!node.modelPath) {
        return failStart("no model path", "bitnet: chemin du modèle non défini.");
      }
      if (node.bitnetDir && !fs.existsSync(spawnCwd())) {
        return failStart("BitNet dir not found", `bitnet: dossier BitNet introuvable : ${spawnCwd()}`);
      }

      binaryResolved = resolveBinary();
      if (path.isAbsolute(binaryResolved) && !fs.existsSync(binaryResolved)) {
        return failStart("binary not found",
          `bitnet: binaire introuvable : ${binaryResolved}. ` +
          `Compilez BitNet avec « python setup_env.py » (produit build/bin/llama-server) ` +
          `ou renseignez « Dossier BitNet » / « Binaire ».`);
      }
      const modelFile = resolveFromCwd(node.modelPath);
      if (!fs.existsSync(modelFile)) {
        return failStart("model not found", `bitnet: modèle introuvable : ${modelFile}`);
      }

      isPortFree(node.serverPort, (free) => {
        if (closing) { starting = false; return; }
        if (free === false) {
          return failStart(`port ${node.serverPort} déjà utilisé`, `bitnet: port ${node.serverPort} déjà utilisé`);
        }
        probeCaps(binaryResolved, spawnCwd(), (err, c) => {
          if (closing) { starting = false; return; }
          if (err && err.code === "ENOENT") {
            return failStart("binary not found", `bitnet: binaire introuvable : ${binaryResolved}`);
          }
          if (!c) {
            node.warn(`bitnet: impossible de lire « ${path.basename(binaryResolved)} --help » (${err ? err.message : "?"}) — on suppose un build récent.`);
          }
          caps = c || MODERN_CAPS;
          spawnServer();
        });
      });
    }

    // ──────────────────────────────────────────────────────
    // Input / Close
    // ──────────────────────────────────────────────────────

    node.on("input", (msg) => {
      if (msg.topic === "debug") { emitDebugInfo("manual debug"); return; }
      if (msg.topic === "trace") {
        node.debugTrace = !!msg.payload;
        node.log(`trace ${node.debugTrace ? "ON" : "OFF"}`);
        return;
      }

      if (!node.serverReady) {
        node.pendingQueue.push(msg);
        if (!node.serverProcess && !starting) startServer();
        else setStatus("yellow", `queued (${node.pendingQueue.length}) :${node.serverPort}`);
        return;
      }
      handleMessage(msg);
    });

    node.on("close", (done) => {
      closing = true;
      stopHealthPoll();
      node.serverReady  = false;
      node.pendingQueue = [];
      const proc = node.serverProcess;
      if (!proc) return done();

      let killTimer = null;
      let finished  = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(killTimer);
        node.serverProcess = null;
        done();
      };
      proc.once("close", finish);
      proc.once("error", finish);
      proc.kill("SIGTERM");
      killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch (e) { /* déjà arrêté */ }
      }, 3000);
    });

    // Démarrage immédiat au deploy
    startServer();
  }

  RED.nodes.registerType("bitnet", BitNetNode);
};
