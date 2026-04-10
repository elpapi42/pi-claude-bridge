/**
 * Tests for the symmetric queue synchronization between MCP handlers and tool results.
 * Exercises all timing orderings without hitting any API.
 */
import assert from "node:assert/strict";

// --- Extracted queue logic (mirrors index.ts pendingToolCalls/pendingResults) ---
// ID-based: both maps are keyed by toolCallId.

function createBridge() {
	const pendingHandlers = new Map(); // toolCallId → { resolve }
	const pendingResults = new Map();  // toolCallId → { content, isError? }

	return {
		// Called by MCP handler: resolve immediately from queue, or block.
		waitForResult(toolCallId) {
			if (pendingResults.has(toolCallId)) {
				const result = pendingResults.get(toolCallId);
				pendingResults.delete(toolCallId);
				return Promise.resolve(result);
			}
			return new Promise((resolve) => { pendingHandlers.set(toolCallId, { resolve }); });
		},

		// Called by tool result delivery: resolve a waiting handler, or queue.
		deliverResult(result) {
			const id = result.toolCallId;
			if (pendingHandlers.has(id)) {
				const h = pendingHandlers.get(id);
				pendingHandlers.delete(id);
				h.resolve(result);
			} else {
				pendingResults.set(id, result);
			}
		},

		// Called on abort/query end.
		drain(fallback) {
			for (const h of pendingHandlers.values()) h.resolve(fallback);
			pendingHandlers.clear();
			pendingResults.clear();
		},

		get handlersWaiting() { return pendingHandlers.size; },
		get resultsQueued() { return pendingResults.size; },

		// Invariant: no single ID appears in both maps simultaneously.
		assertMutualExclusion() {
			for (const id of pendingHandlers.keys()) {
				assert.ok(!pendingResults.has(id), `ID ${id} in both maps`);
			}
		},
	};
}

let pass = 0;
let fail = 0;

async function test(name, fn) {
	try {
		await fn();
		console.log(`  PASS  ${name}`);
		pass++;
	} catch (e) {
		console.log(`  FAIL  ${name}: ${e.message}`);
		fail++;
	}
}

// --- Scenario A: results arrive before handlers ---

console.log("Scenario A: results before handlers");

await test("N results queued, then N handlers resolve immediately", async () => {
	const bridge = createBridge();
	for (let i = 0; i < 3; i++) bridge.deliverResult({ toolCallId: `t${i}`, content: [{ type: "text", text: `r${i}` }] });
	assert.equal(bridge.resultsQueued, 3);
	assert.equal(bridge.handlersWaiting, 0);
	bridge.assertMutualExclusion();

	for (let i = 0; i < 3; i++) {
		const got = await bridge.waitForResult(`t${i}`);
		assert.equal(got.content[0].text, `r${i}`);
	}
	assert.equal(bridge.resultsQueued, 0);
	assert.equal(bridge.handlersWaiting, 0);
});

// --- Scenario B: handlers arrive before results ---

console.log("Scenario B: handlers before results");

await test("N handlers block, then N results resolve them by ID", async () => {
	const bridge = createBridge();
	const promises = [];
	for (let i = 0; i < 3; i++) promises.push(bridge.waitForResult(`t${i}`));
	assert.equal(bridge.handlersWaiting, 3);
	assert.equal(bridge.resultsQueued, 0);
	bridge.assertMutualExclusion();

	for (let i = 0; i < 3; i++) bridge.deliverResult({ toolCallId: `t${i}`, content: [{ type: "text", text: `r${i}` }] });
	const resolved = await Promise.all(promises);
	for (let i = 0; i < 3; i++) assert.equal(resolved[i].content[0].text, `r${i}`);
	assert.equal(bridge.handlersWaiting, 0);
	assert.equal(bridge.resultsQueued, 0);
});

// --- Scenario C: interleaved ---

console.log("Scenario C: interleaved");

await test("handler blocks → result resolves → result queued → handler immediate", async () => {
	const bridge = createBridge();
	const p1 = bridge.waitForResult("t0"); // blocks
	assert.equal(bridge.handlersWaiting, 1);

	bridge.deliverResult({ toolCallId: "t0", content: [{ type: "text", text: "r0" }] }); // resolves p1
	assert.equal(bridge.handlersWaiting, 0);
	const got1 = await p1;
	assert.equal(got1.content[0].text, "r0");

	bridge.deliverResult({ toolCallId: "t1", content: [{ type: "text", text: "r1" }] }); // queued
	assert.equal(bridge.resultsQueued, 1);
	bridge.assertMutualExclusion();

	const got2 = await bridge.waitForResult("t1"); // immediate from queue
	assert.equal(got2.content[0].text, "r1");
	assert.equal(bridge.resultsQueued, 0);
});

// --- Scenario D: ID-based matching with mixed arrival order ---

console.log("Scenario D: ID-based matching");

await test("results match handlers by ID regardless of arrival order", async () => {
	const bridge = createBridge();
	const N = 7;
	// Mix: first 3 handlers arrive, then 5 results, then 4 more handlers
	const promises = [];
	for (let i = 0; i < 3; i++) promises.push(bridge.waitForResult(`t${i}`));
	for (let i = 0; i < 5; i++) bridge.deliverResult({ toolCallId: `t${i}`, content: [{ type: "text", text: `r${i}` }] });
	for (let i = 3; i < N; i++) promises.push(bridge.waitForResult(`t${i}`));
	for (let i = 5; i < N; i++) bridge.deliverResult({ toolCallId: `t${i}`, content: [{ type: "text", text: `r${i}` }] });

	const resolved = await Promise.all(promises);
	for (let i = 0; i < N; i++) {
		assert.equal(resolved[i].content[0].text, `r${i}`, `handler ${i} got wrong result`);
	}
	bridge.assertMutualExclusion();
});

// --- Scenario E: abort ---

console.log("Scenario E: abort");

await test("drain resolves all waiting handlers with fallback", async () => {
	const bridge = createBridge();
	const promises = [];
	for (let i = 0; i < 4; i++) promises.push(bridge.waitForResult(`t${i}`));
	bridge.deliverResult({ toolCallId: "t0", content: [{ type: "text", text: "r0" }] });
	// 3 still waiting, 1 resolved
	const fallback = { content: [{ type: "text", text: "aborted" }] };
	bridge.drain(fallback);
	const resolved = await Promise.all(promises);
	assert.equal(resolved[0].content[0].text, "r0");
	for (let i = 1; i < 4; i++) assert.equal(resolved[i].content[0].text, "aborted");
	assert.equal(bridge.handlersWaiting, 0);
	assert.equal(bridge.resultsQueued, 0);
});

await test("drain clears queued results", async () => {
	const bridge = createBridge();
	bridge.deliverResult({ toolCallId: "t0", content: [{ type: "text", text: "stale" }] });
	bridge.deliverResult({ toolCallId: "t1", content: [{ type: "text", text: "stale" }] });
	assert.equal(bridge.resultsQueued, 2);
	bridge.drain({ content: [] });
	assert.equal(bridge.resultsQueued, 0);
	// New handler should block, not get stale data
	const p = bridge.waitForResult("t2");
	assert.equal(bridge.handlersWaiting, 1);
	bridge.deliverResult({ toolCallId: "t2", content: [{ type: "text", text: "fresh" }] });
	const got = await p;
	assert.equal(got.content[0].text, "fresh");
});

// --- Scenario F: isError propagation ---

console.log("Scenario F: isError propagation");

await test("isError flag flows through both paths", async () => {
	const bridge = createBridge();
	// Path 1: result queued, handler picks up
	bridge.deliverResult({ toolCallId: "t0", content: [{ type: "text", text: "err" }], isError: true });
	const got1 = await bridge.waitForResult("t0");
	assert.equal(got1.isError, true);

	// Path 2: handler blocks, result resolves
	const p = bridge.waitForResult("t1");
	bridge.deliverResult({ toolCallId: "t1", content: [{ type: "text", text: "ok" }], isError: false });
	const got2 = await p;
	assert.equal(got2.isError, false);
});

// --- Scenario G: fresh query after drain (no stale state) ---

console.log("Scenario G: fresh query after drain");

await test("new query sees clean state after drain", async () => {
	const bridge = createBridge();
	// Query 1: deliver results and handlers, then drain mid-flight
	bridge.deliverResult({ toolCallId: "t0", content: [{ type: "text", text: "q1-stale" }] });
	const p = bridge.waitForResult("t0");
	bridge.deliverResult({ toolCallId: "t1", content: [{ type: "text", text: "q1-stale2" }] });
	await p; // resolves with q1-stale
	assert.equal(bridge.resultsQueued, 1); // q1-stale2 sitting in queue
	bridge.drain({ content: [] });
	assert.equal(bridge.resultsQueued, 0);
	assert.equal(bridge.handlersWaiting, 0);

	// Query 2: fresh start — handler must not see q1 data
	const p2 = bridge.waitForResult("t2");
	assert.equal(bridge.handlersWaiting, 1);
	bridge.deliverResult({ toolCallId: "t2", content: [{ type: "text", text: "q2-fresh" }] });
	const got = await p2;
	assert.equal(got.content[0].text, "q2-fresh");
});

// --- Scenario H: extractAllToolResults must stop at assistant messages ---
// Regression: extractAllToolResults only stopped at "user", not "assistant".
// In a multi-turn agentic loop (user → assistant → toolResult × N → assistant → toolResult × M),
// it collected ALL tool results from the entire conversation, not just the current turn.
// This fed stale results into the queue, causing result/tool_use mismatches.

console.log("Scenario H: extractAllToolResults boundaries");

// Mirrors the core logic of extractAllToolResults from index.ts.
// Skips toolResultToMcpContent (content conversion) and debug logging —
// we're testing the backward walk and stop conditions, not content mapping.
// If the real function's walk logic changes, update this to match.
function extractAllToolResults(messages) {
	const results = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "toolResult") {
			results.unshift({ content: msg.content, isError: msg.isError, toolCallId: msg.toolCallId });
		} else if (msg.role === "assistant") {
			break;
		}
		// user messages: skip (steer/followUp injected mid-tool-execution)
	}
	return results;
}

await test("single turn: collects all tool results after assistant", async () => {
	const messages = [
		{ role: "user", content: "prompt" },
		{ role: "assistant", content: [{ type: "toolCall", name: "read", id: "t1" }, { type: "toolCall", name: "read", id: "t2" }] },
		{ role: "toolResult", toolCallId: "t1", content: "file1" },
		{ role: "toolResult", toolCallId: "t2", content: "file2" },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 2);
	assert.equal(results[0].content, "file1");
	assert.equal(results[1].content, "file2");
});

await test("multi-turn: only collects results from current turn, not previous", async () => {
	const messages = [
		{ role: "user", content: "prompt" },
		{ role: "assistant", content: [{ type: "toolCall", name: "read", id: "t1" }, { type: "toolCall", name: "read", id: "t2" }] },
		{ role: "toolResult", toolCallId: "t1", content: "file1-OLD" },
		{ role: "toolResult", toolCallId: "t2", content: "file2-OLD" },
		// Second turn
		{ role: "assistant", content: [{ type: "toolCall", name: "grep", id: "t3" }] },
		{ role: "toolResult", toolCallId: "t3", content: "grep-result-NEW" },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 1, `expected 1 result (current turn), got ${results.length}`);
	assert.equal(results[0].content, "grep-result-NEW");
});

await test("three turns: only last turn's results", async () => {
	const messages = [
		{ role: "user", content: "prompt" },
		{ role: "assistant", content: [{ type: "toolCall", id: "t1" }] },
		{ role: "toolResult", toolCallId: "t1", content: "turn1" },
		{ role: "assistant", content: [{ type: "toolCall", id: "t2" }] },
		{ role: "toolResult", toolCallId: "t2", content: "turn2" },
		{ role: "assistant", content: [{ type: "toolCall", id: "t3" }, { type: "toolCall", id: "t4" }] },
		{ role: "toolResult", toolCallId: "t3", content: "turn3a" },
		{ role: "toolResult", toolCallId: "t4", content: "turn3b" },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 2);
	assert.equal(results[0].content, "turn3a");
	assert.equal(results[1].content, "turn3b");
});

// --- Scenario H2: interleaved messages in tool result sequences ---
// Tests all permutations of non-toolResult messages appearing in contexts
// where extractAllToolResults needs to find tool results.
// Issue #3: pi can inject user messages (steer, followUp, orchestrator context)
// between tool_use and toolResult, breaking the backward walk.

console.log("Scenario H2: interleaved messages in tool result sequences");

// Helper: extract tool call IDs from the last assistant message (like turnToolCallIds)
function getToolCallIds(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			return msg.content.filter((b) => b.type === "toolCall").map((b) => b.id);
		}
	}
	return [];
}

// Helper: run extractAllToolResults and also simulate bridge delivery
function simulateDelivery(messages, expectedHandlers) {
	const results = extractAllToolResults(messages);
	const ids = getToolCallIds(messages);
	const bridge = createBridge();
	for (let i = 0; i < expectedHandlers; i++) bridge.waitForResult(ids[i] ?? `unknown_${i}`);
	for (const r of results) bridge.deliverResult(r);
	return { results, bridge };
}

// -- User message at tail (no toolResult yet) --

await test("user message at tail, no toolResult → must find 0 and not enter delivery", async () => {
	// Defensive: shouldn't happen with current pi (steer arrives after tool
	// execution, so toolResult is always present), but tests the boundary
	const messages = [
		{ role: "user", content: "prompt" },
		{ role: "assistant", content: [{ type: "toolCall", name: "read", id: "t1" }] },
		{ role: "user", content: "steer message" },
	];
	const { results, bridge } = simulateDelivery(messages, 1);
	assert.equal(results.length, 0);
	// Caller must check lastMsgRole before delivering — handler should stay available
	assert.equal(bridge.handlersWaiting, 1, "handler still stuck — caller should have skipped delivery");
	bridge.drain({ content: [] });
});

// -- User message hides toolResult behind it --

await test("assistant → toolResult → user at tail → must find toolResult", async () => {
	const messages = [
		{ role: "user", content: "prompt" },
		{ role: "assistant", content: [{ type: "toolCall", name: "read", id: "t1" }] },
		{ role: "toolResult", toolCallId: "t1", content: "result" },
		{ role: "user", content: "steer arrived after result" },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 1, `expected 1, got ${results.length}`);
	assert.equal(results[0].content, "result");
});

// -- User message splits toolResults --

await test("user message between 2 toolResults → must find both", async () => {
	const messages = [
		{ role: "user", content: "prompt" },
		{ role: "assistant", content: [{ type: "toolCall", id: "t1" }, { type: "toolCall", id: "t2" }] },
		{ role: "toolResult", toolCallId: "t1", content: "first" },
		{ role: "user", content: "injected" },
		{ role: "toolResult", toolCallId: "t2", content: "second" },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 2, `expected 2, got ${results.length}`);
	assert.equal(results[0].content, "first");
	assert.equal(results[1].content, "second");
});

await test("user message splits 5 toolResults (3 before, 2 after)", async () => {
	const messages = [
		{ role: "user", content: "prompt" },
		{ role: "assistant", content: [{ type: "toolCall", id: "t1" }, { type: "toolCall", id: "t2" }, { type: "toolCall", id: "t3" }, { type: "toolCall", id: "t4" }, { type: "toolCall", id: "t5" }] },
		{ role: "toolResult", toolCallId: "t1", content: "r1" },
		{ role: "toolResult", toolCallId: "t2", content: "r2" },
		{ role: "toolResult", toolCallId: "t3", content: "r3" },
		{ role: "user", content: "injected" },
		{ role: "toolResult", toolCallId: "t4", content: "r4" },
		{ role: "toolResult", toolCallId: "t5", content: "r5" },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 5, `expected 5, got ${results.length}`);
	for (let i = 0; i < 5; i++) assert.equal(results[i].content, `r${i + 1}`);
});

// -- Multiple user messages interleaved --

await test("multiple user messages interleaved with toolResults", async () => {
	const messages = [
		{ role: "user", content: "prompt" },
		{ role: "assistant", content: [{ type: "toolCall", id: "t1" }, { type: "toolCall", id: "t2" }, { type: "toolCall", id: "t3" }] },
		{ role: "toolResult", toolCallId: "t1", content: "r1" },
		{ role: "user", content: "steer 1" },
		{ role: "toolResult", toolCallId: "t2", content: "r2" },
		{ role: "user", content: "steer 2" },
		{ role: "toolResult", toolCallId: "t3", content: "r3" },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 3, `expected 3, got ${results.length}`);
	for (let i = 0; i < 3; i++) assert.equal(results[i].content, `r${i + 1}`);
});

await test("user message before every toolResult", async () => {
	const messages = [
		{ role: "user", content: "prompt" },
		{ role: "assistant", content: [{ type: "toolCall", id: "t1" }, { type: "toolCall", id: "t2" }] },
		{ role: "user", content: "steer 1" },
		{ role: "toolResult", toolCallId: "t1", content: "r1" },
		{ role: "user", content: "steer 2" },
		{ role: "toolResult", toolCallId: "t2", content: "r2" },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 2, `expected 2, got ${results.length}`);
});

// -- Assistant message interleaved (shouldn't happen, but defensive) --

await test("assistant message between toolResults → must find results after it", async () => {
	// If pi somehow inserts an assistant message mid-results, we should still
	// collect the results after it (current-turn boundary)
	const messages = [
		{ role: "user", content: "prompt" },
		{ role: "assistant", content: [{ type: "toolCall", id: "t1" }, { type: "toolCall", id: "t2" }] },
		{ role: "toolResult", toolCallId: "t1", content: "old" },
		{ role: "assistant", content: [{ type: "text", text: "spurious" }] },
		{ role: "toolResult", toolCallId: "t2", content: "new" },
	];
	const results = extractAllToolResults(messages);
	// Current behavior: stops at assistant, only gets "new"
	// This is arguably correct — assistant message starts a new turn
	assert.equal(results.length, 1);
	assert.equal(results[0].content, "new");
});

// -- Unknown/custom roles interleaved --

// Note: pi's Context.messages only has roles "user", "assistant", "toolResult".
// Custom roles (bashExecution, custom, branchSummary) are converted to "user"
// by convertToLlm() before reaching the provider. No need to test other roles.

// -- Bridge-level consequence: partial delivery --

await test("partial delivery leaves handlers stuck", async () => {
	// 3 handlers waiting, but user message hides 1 toolResult → only 2 delivered
	const messages = [
		{ role: "user", content: "prompt" },
		{ role: "assistant", content: [{ type: "toolCall", id: "t1" }, { type: "toolCall", id: "t2" }, { type: "toolCall", id: "t3" }] },
		{ role: "toolResult", toolCallId: "t1", content: "r1" },
		{ role: "user", content: "injected" },
		{ role: "toolResult", toolCallId: "t2", content: "r2" },
		{ role: "toolResult", toolCallId: "t3", content: "r3" },
	];
	const { results, bridge } = simulateDelivery(messages, 3);
	// Must deliver all 3
	assert.equal(results.length, 3, `expected 3 results, got ${results.length}`);
	assert.equal(bridge.handlersWaiting, 0, `${bridge.handlersWaiting} handlers still stuck`);
});

// -- Multi-turn with interleaved messages in current turn only --

await test("multi-turn: user message in current turn only, previous turn clean", async () => {
	const messages = [
		{ role: "user", content: "prompt" },
		{ role: "assistant", content: [{ type: "toolCall", id: "t1" }] },
		{ role: "toolResult", toolCallId: "t1", content: "turn1-clean" },
		// Turn 2: has interleaved user message
		{ role: "assistant", content: [{ type: "toolCall", id: "t2" }, { type: "toolCall", id: "t3" }] },
		{ role: "toolResult", toolCallId: "t2", content: "turn2-r1" },
		{ role: "user", content: "steer" },
		{ role: "toolResult", toolCallId: "t3", content: "turn2-r2" },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 2, `expected 2 (current turn only), got ${results.length}`);
	assert.equal(results[0].content, "turn2-r1");
	assert.equal(results[1].content, "turn2-r2");
});

// -- isError propagation through interleaved messages --

await test("isError propagates through interleaved user messages", async () => {
	const messages = [
		{ role: "user", content: "prompt" },
		{ role: "assistant", content: [{ type: "toolCall", id: "t1" }, { type: "toolCall", id: "t2" }] },
		{ role: "toolResult", toolCallId: "t1", content: "ok", isError: false },
		{ role: "user", content: "steer" },
		{ role: "toolResult", toolCallId: "t2", content: "failed", isError: true },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 2);
	assert.equal(results[0].isError, false);
	assert.equal(results[1].isError, true);
});

// -- Edge cases --

await test("empty context returns empty", async () => {
	const results = extractAllToolResults([]);
	assert.equal(results.length, 0);
});

await test("context with only user message returns empty", async () => {
	const results = extractAllToolResults([{ role: "user", content: "hello" }]);
	assert.equal(results.length, 0);
});

await test("context with only toolResults (no assistant) returns all", async () => {
	// Degenerate case — shouldn't happen, but function should handle it
	const messages = [
		{ role: "toolResult", toolCallId: "t1", content: "orphan1" },
		{ role: "toolResult", toolCallId: "t2", content: "orphan2" },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 2);
});

await test("single toolResult returns it", async () => {
	const messages = [
		{ role: "assistant", content: [{ type: "toolCall", id: "t1" }] },
		{ role: "toolResult", toolCallId: "t1", content: "only" },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 1);
	assert.equal(results[0].content, "only");
});

await test("consecutive user messages at tail with toolResult behind both", async () => {
	const messages = [
		{ role: "assistant", content: [{ type: "toolCall", id: "t1" }] },
		{ role: "toolResult", toolCallId: "t1", content: "result" },
		{ role: "user", content: "steer 1" },
		{ role: "user", content: "steer 2" },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 1, `expected 1, got ${results.length}`);
});

await test("user message at tail with no toolResult and no assistant", async () => {
	const messages = [
		{ role: "user", content: "steer into void" },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 0);
});

await test("assistant with tool_calls but no toolResults yet → empty", async () => {
	const messages = [
		{ role: "user", content: "prompt" },
		{ role: "assistant", content: [{ type: "toolCall", id: "t1" }, { type: "toolCall", id: "t2" }] },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 0);
});

await test("no tool results at end returns empty", async () => {
	const messages = [
		{ role: "user", content: "prompt" },
		{ role: "assistant", content: [{ type: "text", text: "done" }] },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 0);
});

// --- Scenario I: property-based fuzz (FUZZ=1 to enable) ---

if (process.env.FUZZ) {
console.log("Scenario G: fuzz (1000 random orderings)");

await test("random delivery/handler orderings always drain correctly", async () => {
	for (let trial = 0; trial < 1000; trial++) {
		const bridge = createBridge();
		const n = Math.floor(Math.random() * 8) + 1;
		const ops = [];
		for (let i = 0; i < n; i++) ops.push({ type: "deliver", idx: i });
		for (let i = 0; i < n; i++) ops.push({ type: "handler", idx: i });
		// Fisher-Yates shuffle
		for (let i = ops.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[ops[i], ops[j]] = [ops[j], ops[i]];
		}

		const promises = new Array(n);
		for (const op of ops) {
			if (op.type === "deliver") {
				bridge.deliverResult({ toolCallId: `t${op.idx}`, content: [{ type: "text", text: `r${op.idx}` }] });
			} else {
				promises[op.idx] = bridge.waitForResult(`t${op.idx}`);
			}
			bridge.assertMutualExclusion();
		}

		const resolved = await Promise.all(promises);
		// All should resolve, queues should be empty
		assert.equal(resolved.length, n);
		assert.equal(bridge.handlersWaiting, 0);
		assert.equal(bridge.resultsQueued, 0);
	}
});
}

// --- Summary ---

console.log(`\nPassed: ${pass}  Failed: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
