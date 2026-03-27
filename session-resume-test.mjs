#!/usr/bin/env node
// Context continuity test for pi-claude-code-acp provider.
// Verifies that switching away from the provider and back correctly
// preserves conversation context (all messages are flattened into
// each query, so "missed" messages are automatically included).
//
// Also tests AskClaude shared mode (sees conversation history) vs
// isolated mode (clean slate).
//
// Requires: pi CLI, Claude Code (for Agent SDK subprocess).

console.log("=== session-resume-test.mjs ===");

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const DIR = dirname(fileURLToPath(import.meta.url));
const LOGDIR = `${DIR}/.test-output`;
const LOGFILE = `${LOGDIR}/session-resume.log`;
const TIMEOUT = 180_000;

const ACP_MODEL = "claude-code-acp/claude-haiku-4-5";
const OTHER_PROVIDER = "openrouter";
const OTHER_MODEL = "openai/gpt-oss-120b";

// Random words to avoid Claude memorizing test values across runs
const WORD_A = `alpha${Math.random().toString(36).slice(2, 6)}`;
const WORD_B = `beta${Math.random().toString(36).slice(2, 6)}`;


// Strip node_modules/.bin from PATH (shadows pi with vendored types package)
process.env.PATH = process.env.PATH
  .split(":")
  .filter((p) => !p.includes("node_modules"))
  .join(":");

const log = createWriteStream(LOGFILE);

// Spawn pi in RPC mode with the ACP extension
const pi = spawn("pi", [
  "--no-session", "-ne",
  "-e", DIR,
  "--model", ACP_MODEL,
  "--mode", "rpc",
], { stdio: ["pipe", "pipe", "pipe"] });

pi.stderr.on("data", (d) => log.write(d));

// JSONL reader
let buffer = "";
const decoder = new StringDecoder("utf8");
const listeners = [];

pi.stdout.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  while (true) {
    const i = buffer.indexOf("\n");
    if (i === -1) break;
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    try {
      const msg = JSON.parse(line);
      log.write(`< ${line}\n`);
      for (const fn of listeners) fn(msg);
    } catch {}
  }
});

let reqId = 0;
function send(cmd) {
  const id = `req_${++reqId}`;
  const full = { ...cmd, id };
  log.write(`> ${JSON.stringify(full)}\n`);
  pi.stdin.write(JSON.stringify(full) + "\n");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${cmd.type}`)), 30_000);
    listeners.push(function handler(msg) {
      if (msg.type === "response" && msg.id === id) {
        clearTimeout(timer);
        listeners.splice(listeners.indexOf(handler), 1);
        if (msg.success) resolve(msg.data);
        else reject(new Error(`${cmd.type}: ${msg.error}`));
      }
    });
  });
}

function waitForIdle(timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout waiting for idle")), timeout);
    listeners.push(function handler(msg) {
      if (msg.type === "agent_end") {
        clearTimeout(timer);
        listeners.splice(listeners.indexOf(handler), 1);
        // Extract last tool result text for assertion
        const toolResults = msg.messages?.filter((m) => m.role === "toolResult") ?? [];
        if (toolResults.length > 0) {
          const last = toolResults[toolResults.length - 1];
          lastToolResult = last.content?.map((c) => c.text ?? "").join("") ?? "";
        }
        resolve(msg);
      }
    });
  });
}

function collectText() {
  let text = "";
  const handler = (msg) => {
    if (msg.type === "message_update") {
      const ae = msg.assistantMessageEvent;
      if (ae?.type === "text_delta") text += ae.delta;
    }
  };
  listeners.push(handler);
  return { stop() { listeners.splice(listeners.indexOf(handler), 1); return text; } };
}

let lastToolResult = null;

async function promptAndWait(message) {
  const collector = collectText();
  await send({ type: "prompt", message });
  await waitForIdle();
  return collector.stop();
}

function finish(code, msg) {
  console.log(msg);
  if (code !== 0) console.log(`  Log: ${LOGFILE}`);
  pi.kill();
  log.end(() => process.exit(code));
}

// Give pi a moment to initialize
await new Promise((r) => setTimeout(r, 2000));

try {
  // Turn 1: Provider prompt — establishes context
  console.log("Turn 1: ACP prompt (establish session)...");
  const text1 = await promptAndWait(`The secret word is '${WORD_A}'. Acknowledge and be very brief.`);
  if (!text1) finish(1, "FAIL: Turn 1 produced no text");
  console.log(`  Response: ${text1.slice(0, 80)}`);

  // Switch to other model — context should still be preserved on switch-back
  console.log(`Switching to ${OTHER_PROVIDER}/${OTHER_MODEL}...`);
  await send({ type: "set_model", provider: OTHER_PROVIDER, modelId: OTHER_MODEL });

  // Turn 2: Other-model prompt — adds context that provider must see on switch-back
  console.log("Turn 2: Non-ACP prompt (creates missed messages)...");
  const text2 = await promptAndWait(`The backup word is '${WORD_B}'. Acknowledge briefly.`);
  if (!text2) finish(1, "FAIL: Turn 2 produced no text");
  console.log(`  Response: ${text2.slice(0, 80)}`);

  // Switch back to provider — context includes all prior turns
  const [acpProvider, acpModelId] = ACP_MODEL.split("/");
  console.log(`Switching back to ${ACP_MODEL}...`);
  await send({ type: "set_model", provider: acpProvider, modelId: acpModelId });

  // Turn 3: Provider prompt — should have context from all turns
  console.log("Turn 3: Provider prompt (tests context continuity)...");
  const text3 = await promptAndWait(
    "What was the secret word and the backup word? Reply with just the two words separated by a comma."
  );
  console.log(`  Response: ${text3.slice(0, 80)}`);

  // Assertions
  const lower = text3.toLowerCase();
  if (!lower.includes(WORD_A)) finish(1, `FAIL: Turn 3 response missing '${WORD_A}': ${text3}`);
  if (!lower.includes(WORD_B)) finish(1, `FAIL: Turn 3 response missing '${WORD_B}': ${text3}`);

  // Turn 4: AskClaude shared mode — should see WORD_B which was only told to the non-ACP model
  console.log(`Switching to ${OTHER_PROVIDER}/${OTHER_MODEL}...`);
  await send({ type: "set_model", provider: OTHER_PROVIDER, modelId: OTHER_MODEL });

  console.log("Turn 4: AskClaude shared mode (should see non-ACP context)...");
  const text4 = await promptAndWait(
    'Use the AskClaude tool with prompt="What was the backup word mentioned earlier? Reply with just the word."'
  );
  // Check AskClaude's tool result (not the calling model's response, which knows WORD_B from its own context)
  console.log(`  AskClaude result: ${(lastToolResult || "").slice(0, 120)}`);
  if (!lastToolResult?.toLowerCase().includes(WORD_B)) finish(1, `FAIL: Turn 4 AskClaude tool result missing '${WORD_B}': ${lastToolResult}`);

  // Turn 5: AskClaude isolated mode — should NOT see conversation history
  console.log("Turn 5: AskClaude isolated mode (should not see context)...");
  lastToolResult = null;
  const text5 = await promptAndWait(
    'Use the AskClaude tool with prompt="What was the backup word mentioned earlier? If you don\'t know, say UNKNOWN." and isolated=true'
  );
  console.log(`  AskClaude result: ${(lastToolResult || "").slice(0, 120)}`);
  if (lastToolResult?.toLowerCase().includes(WORD_B)) finish(1, `FAIL: Turn 5 isolated AskClaude should not know '${WORD_B}': ${lastToolResult}`);

  finish(0, "PASS");
} catch (e) {
  finish(1, `FAIL: ${e.message}`);
}
