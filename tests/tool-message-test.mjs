#!/usr/bin/env node
// Integration tests for tool execution + message interaction scenarios.
// Uses pi in RPC mode with the bridge + SlowTool test extension.
// Exercises how the bridge handles messages arriving during tool execution.

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOGDIR = `${DIR}/.test-output`;
mkdirSync(LOGDIR, { recursive: true });
const RPC_LOG = `${LOGDIR}/tool-message.log`;
const DEBUG_LOG = `${LOGDIR}/tool-message-debug.log`;
const TEST_TIMEOUT = 30_000;

// Strip node_modules/.bin from PATH
process.env.PATH = process.env.PATH
	.split(":")
	.filter((p) => !p.includes("node_modules"))
	.join(":");

describe("tool-message integration", () => {
	let pi, buffer, listeners, reqId, rpcLog;

	// --- Pi RPC harness ---

	function startPi() {
		rpcLog = createWriteStream(RPC_LOG, { flags: "a" });
		buffer = "";
		listeners = [];
		reqId = 0;

		pi = spawn("pi", [
			"--no-session", "-ne",
			"-e", DIR,
			"-e", `${DIR}/tests/slow-tool-extension.ts`,
			"--model", "claude-bridge/claude-haiku-4-5",
			"--mode", "rpc",
		], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, CLAUDE_BRIDGE_DEBUG: "1", CLAUDE_BRIDGE_DEBUG_PATH: DEBUG_LOG },
		});

		pi.stderr.on("data", (d) => rpcLog.write(d));

		const decoder = new StringDecoder("utf8");
		pi.stdout.on("data", (chunk) => {
			buffer += decoder.write(chunk);
			while (true) {
				const i = buffer.indexOf("\n");
				if (i === -1) break;
				const line = buffer.slice(0, i);
				buffer = buffer.slice(i + 1);
				try {
					const msg = JSON.parse(line);
					rpcLog.write(`< ${line}\n`);
					for (const fn of listeners) fn(msg);
				} catch {}
			}
		});
	}

	function stopPi() {
		pi.kill();
		return new Promise((r) => rpcLog.end(r));
	}

	function send(cmd) {
		const id = `req_${++reqId}`;
		const full = { ...cmd, id };
		rpcLog.write(`> ${JSON.stringify(full)}\n`);
		pi.stdin.write(JSON.stringify(full) + "\n");
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Timeout: ${cmd.type}`)), TEST_TIMEOUT);
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

	function waitForEvent(type, timeout = TEST_TIMEOUT) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);
			listeners.push(function handler(msg) {
				if (msg.type === type) {
					clearTimeout(timer);
					listeners.splice(listeners.indexOf(handler), 1);
					resolve(msg);
				}
			});
		});
	}

	function waitForMatch(predicate, description, timeout = TEST_TIMEOUT) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${description}`)), timeout);
			listeners.push(function handler(msg) {
				if (predicate(msg)) {
					clearTimeout(timer);
					listeners.splice(listeners.indexOf(handler), 1);
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

	async function promptAndWait(message, timeout = TEST_TIMEOUT) {
		const collector = collectText();
		await send({ type: "prompt", message });
		await waitForEvent("agent_end", timeout);
		return collector.stop();
	}

	// --- Lifecycle ---

	before(async () => {
		startPi();
		await new Promise((r) => setTimeout(r, 2000));
	});

	afterEach(async () => {
		if (pi.exitCode !== null) {
			startPi();
			await new Promise((r) => setTimeout(r, 2000));
		}
	});

	after(async () => {
		await stopPi();
		console.log(`  RPC log: ${RPC_LOG}`);
		console.log(`  Debug log: ${DEBUG_LOG}`);
	});

	// --- Tests ---

	it("tool call completes normally", { timeout: TEST_TIMEOUT }, async () => {
		const text = await promptAndWait(
			"Call SlowTool with seconds=1. Then repeat exactly what it returned, nothing else."
		);
		assert.match(text.toLowerCase(), /slowtool completed/);
	});

	it("followUp during tool execution delivers after tool completes", { timeout: TEST_TIMEOUT }, async () => {
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=5. Then repeat exactly what it returned.",
		});
		await waitForEvent("tool_execution_start");
		// followUp is queued by pi until the current turn finishes
		await send({
			type: "prompt",
			message: "This is a followUp during tool execution.",
			streamingBehavior: "followUp",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		assert.match(text.toLowerCase(), /slowtool completed/);
	});

	it("steer during tool execution still delivers tool result", { timeout: 15_000 }, async () => {
		// Issue #3: steer injects a user message into the context during an active
		// tool call. extractAllToolResults stops at the user message and returns 0
		// results, leaving the pending handler stuck.
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=2. Then repeat exactly what it returned.",
		});
		await waitForEvent("tool_execution_start");
		await send({
			type: "prompt",
			message: "This is a steer message during tool execution.",
			streamingBehavior: "steer",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		assert.match(text.toLowerCase(), /slowtool completed/);
	});

	it("parallel tool calls with steer delivers all results", { timeout: 30_000 }, async () => {
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Call SlowTool three times in parallel: seconds=3, seconds=4, seconds=5. Then list all three results.",
		});
		// Wait for at least one tool to start, then inject steer
		await waitForEvent("tool_execution_start");
		await send({
			type: "prompt",
			message: "This is a steer during parallel tool execution.",
			streamingBehavior: "steer",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		// All three tools should have their results in the response
		const matches = (text.match(/slowtool completed/gi) || []).length;
		assert.ok(matches >= 3, `Expected 3 SlowTool results, found ${matches}: ${text.slice(0, 300)}`);
	});

	it("steer during text response (no tool call) completes both turns", { timeout: 30_000 }, async () => {
		// Steer during text-only streaming: the assistant is generating text (no tool
		// calls), a steer arrives, and pi delivers it after the current turn ends.
		// Risk: if activeQuery hasn't been cleared by the time pi calls streamSimple
		// for the steer, the bridge enters the tool-result-delivery path incorrectly.
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Write at least 5 detailed paragraphs about the history of computing, from Babbage to modern times. Do NOT call any tools. Do NOT stop early.",
		});
		// Wait until text is actually streaming before injecting the steer
		await waitForMatch(
			(msg) => msg.type === "message_update" && msg.assistantMessageEvent?.type === "text_delta",
			"text_delta during assistant response",
		);
		await send({
			type: "prompt",
			message: "After you finish, also say the exact word 'PINEAPPLE' on its own line.",
			streamingBehavior: "steer",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		assert.match(text.toLowerCase(), /pineapple/);
	});

	it("steer during tool execution is visible to assistant", { timeout: 20_000 }, async () => {
		// Bug: when a steer arrives during tool execution, pi drains it at the turn
		// boundary and injects it into context alongside the tool result. The bridge
		// sees activeQuery=true, enters tool-result-delivery mode, extracts the tool
		// result, but silently ignores the trailing user message (the steer). Claude
		// never sees the steer content.
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=2. After it returns, repeat exactly what it returned.",
		});
		await waitForEvent("tool_execution_start");
		await send({
			type: "prompt",
			message: "IMPORTANT: Also say the exact word 'MANGO' on its own line in your response.",
			streamingBehavior: "steer",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		assert.match(text.toLowerCase(), /mango/, `Steer content not visible to assistant: ${text.slice(0, 300)}`);
	});

	it("abort during tool execution recovers cleanly", { timeout: TEST_TIMEOUT }, async () => {
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=30.",
		});
		await waitForEvent("tool_execution_start");
		const idle = waitForEvent("agent_end");
		await send({ type: "abort" });
		await idle;
		// Next prompt should work without hanging
		const text = await promptAndWait("Reply with just the word 'recovered'.");
		assert.match(text.toLowerCase(), /recovered/);
	});
});
