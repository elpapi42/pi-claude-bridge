import { calculateCost, createAssistantMessageEventStream, getModels, StringEnum, type AssistantMessage, type AssistantMessageEventStream, type Context, type ImageContent, type Model, type SimpleStreamOptions, type Tool } from "@mariozechner/pi-ai";
import { buildSessionContext, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createSdkMcpServer, query, type SDKMessage, type SDKUserMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import { pascalCase } from "change-case";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, relative, resolve } from "path";

// --- Constants ---

const PROVIDER_ID = "claude-code-acp";

const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
	read: "read", write: "write", edit: "edit", bash: "bash", grep: "grep", glob: "find",
};
const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
	read: "Read", write: "Write", edit: "Edit", bash: "Bash", grep: "Grep", find: "Glob", glob: "Glob",
};
const DEFAULT_TOOLS = ["Read", "Write", "Edit", "Bash", "Grep", "Glob"];
const BUILTIN_TOOL_NAMES = new Set(Object.keys(PI_TO_SDK_TOOL_NAME));
const TOOL_EXECUTION_DENIED_MESSAGE = "Tool execution is unavailable in this environment.";
const MCP_SERVER_NAME = "custom-tools";
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

const LATEST_MODEL_IDS = new Set(["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]);

const MODELS = getModels("anthropic")
	.filter((model) => LATEST_MODEL_IDS.has(model.id))
	.map((model) => ({
		id: model.id, name: model.name, reasoning: model.reasoning, input: model.input,
		cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
	}));

function resolveModelId(input: string): string {
	const lower = input.toLowerCase();
	for (const id of LATEST_MODEL_IDS) {
		if (id === lower || id.includes(lower)) return id;
	}
	return input;
}

// --- Skills/settings paths ---

const SKILLS_ALIAS_GLOBAL = "~/.claude/skills";
const SKILLS_ALIAS_PROJECT = ".claude/skills";
const GLOBAL_SKILLS_ROOT = join(homedir(), ".pi", "agent", "skills");
const PROJECT_SKILLS_ROOT = join(process.cwd(), ".pi", "skills");
const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const PROJECT_SETTINGS_PATH = join(process.cwd(), ".pi", "settings.json");
const GLOBAL_AGENTS_PATH = join(homedir(), ".pi", "agent", "AGENTS.md");

// --- Config ---

interface Config {
	askClaude?: {
		enabled?: boolean;
		name?: string;
		label?: string;
		description?: string;
		defaultMode?: "full" | "read" | "none";
		allowFullMode?: boolean;
		appendSkills?: boolean;
	};
}

function loadConfig(cwd: string): Config {
	const globalPath = join(homedir(), ".pi", "agent", "claude-code-acp.json");
	const projectPath = join(cwd, ".pi", "claude-code-acp.json");
	let global: Partial<Config> = {};
	let project: Partial<Config> = {};
	if (existsSync(globalPath)) { try { global = JSON.parse(readFileSync(globalPath, "utf-8")); } catch {} }
	if (existsSync(projectPath)) { try { project = JSON.parse(readFileSync(projectPath, "utf-8")); } catch {} }
	return { askClaude: { ...global.askClaude, ...project.askClaude } };
}

// --- Error handling ---

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try { return JSON.stringify(err); } catch {}
	}
	return String(err);
}

// --- Text extraction ---

function messageContentToText(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	let hasText = false;
	for (const block of content) {
		if (block.type === "text" && block.text) { parts.push(block.text); hasText = true; }
		else if (block.type === "image") { /* text-only */ }
		else { parts.push(`[${block.type}]`); }
	}
	return hasText ? parts.join("\n") : "";
}

function contentToText(
	content: string | Array<{ type: string; text?: string; thinking?: string; name?: string; arguments?: Record<string, unknown> }>,
	customToolNameToSdk?: Map<string, string>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block.type === "text") return block.text ?? "";
			if (block.type === "thinking") return block.thinking ?? "";
			if (block.type === "toolCall") {
				const args = block.arguments ? JSON.stringify(block.arguments) : "{}";
				const toolName = mapPiToolNameToSdk(block.name, customToolNameToSdk);
				return `Historical tool call (non-executable): ${toolName} args=${args}`;
			}
			return `[${block.type}]`;
		})
		.join("\n");
}

// --- AskClaude helpers ---

interface ToolCallState {
	name: string;
	status: string;
	rawInput?: unknown;
}

function extractPath(rawInput: unknown): string | undefined {
	if (!rawInput || typeof rawInput !== "object") return undefined;
	const input = rawInput as Record<string, unknown>;
	if (typeof input.file_path === "string") return input.file_path;
	if (typeof input.path === "string") return input.path;
	if (typeof input.command === "string") return input.command.substring(0, 80);
	return undefined;
}

function shortPath(p: string): string {
	const cwd = process.cwd();
	if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
	if (p.startsWith("/")) {
		const parts = p.split("/");
		if (parts.length > 3) return parts.slice(-2).join("/");
	}
	return p;
}

function buildActionSummary(calls: Map<string, ToolCallState>): string {
	const reads = new Set<string>();
	const edits = new Set<string>();
	const commands: string[] = [];
	const other: string[] = [];

	for (const [, tc] of calls) {
		const path = extractPath(tc.rawInput);
		const verb = tc.name.toLowerCase().split(/\s/)[0];
		if (verb === "read" || verb === "readfile") {
			if (path) reads.add(shortPath(path));
		} else if (verb === "edit" || verb === "write" || verb === "writefile" || verb === "multiedit") {
			if (path) edits.add(shortPath(path));
		} else if (verb === "bash" || verb === "terminal") {
			commands.push(path ?? "command");
		} else {
			other.push(tc.name);
		}
	}

	const parts: string[] = [];
	if (reads.size) parts.push(`read ${[...reads].join(", ")}`);
	if (edits.size) parts.push(`edited ${[...edits].join(", ")}`);
	if (commands.length) parts.push(`ran ${commands.join("; ")}`);
	if (other.length) parts.push(other.join("; "));
	return parts.join("; ");
}

// AskClaude mode presets — controls which CC tools are blocked per mode
const MODE_DISALLOWED_TOOLS: Record<string, string[]> = {
	full: [],
	read: [
		"Write", "Edit", "Bash", "NotebookEdit",
		"EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
	],
	none: [
		"Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
		"NotebookEdit", "EnterWorktree", "ExitWorktree",
		"CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
		"WebFetch", "WebSearch",
	],
};

// Build a text summary of conversation history for AskClaude shared mode
function buildContextSummary(messages: Context["messages"]): string {
	return messages.map((msg) => {
		if (msg.role === "user") return `USER:\n${messageContentToText(msg.content) || "[image]"}`;
		if (msg.role === "assistant") return `ASSISTANT:\n${contentToText(msg.content)}`;
		if (msg.role === "toolResult") return `TOOL RESULT (${msg.toolName}):\n${messageContentToText(msg.content)}`;
		return "";
	}).filter(Boolean).join("\n\n");
}

// Extract skills block from pi's system prompt for forwarding to Claude Code
function extractSkillsBlock(systemPrompt: string): string | undefined {
	const startMarker = "The following skills provide specialized instructions for specific tasks.";
	const endMarker = "</available_skills>";
	const start = systemPrompt.indexOf(startMarker);
	if (start === -1) return undefined;
	const end = systemPrompt.indexOf(endMarker, start);
	if (end === -1) return undefined;
	return systemPrompt.slice(start, end + endMarker.length).trim();
}

// --- Provider helpers: tool name mapping ---

function mapPiToolNameToSdk(name?: string, customToolNameToSdk?: Map<string, string>): string {
	if (!name) return "";
	const normalized = name.toLowerCase();
	if (customToolNameToSdk) {
		const mapped = customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized);
		if (mapped) return mapped;
	}
	if (PI_TO_SDK_TOOL_NAME[normalized]) return PI_TO_SDK_TOOL_NAME[normalized];
	return pascalCase(name);
}

function mapToolName(name: string, customToolNameToPi?: Map<string, string>): string {
	const normalized = name.toLowerCase();
	const builtin = SDK_TO_PI_TOOL_NAME[normalized];
	if (builtin) return builtin;
	if (customToolNameToPi) {
		const mapped = customToolNameToPi.get(name) ?? customToolNameToPi.get(normalized);
		if (mapped) return mapped;
	}
	if (normalized.startsWith(MCP_TOOL_PREFIX)) return name.slice(MCP_TOOL_PREFIX.length);
	return name;
}

function rewriteSkillAliasPath(pathValue: unknown): unknown {
	if (typeof pathValue !== "string") return pathValue;
	if (pathValue.startsWith(SKILLS_ALIAS_GLOBAL)) {
		return pathValue.replace(SKILLS_ALIAS_GLOBAL, "~/.pi/agent/skills");
	}
	if (pathValue.startsWith(`./${SKILLS_ALIAS_PROJECT}`)) {
		return pathValue.replace(`./${SKILLS_ALIAS_PROJECT}`, PROJECT_SKILLS_ROOT);
	}
	if (pathValue.startsWith(SKILLS_ALIAS_PROJECT)) {
		return pathValue.replace(SKILLS_ALIAS_PROJECT, PROJECT_SKILLS_ROOT);
	}
	const projectAliasAbs = join(process.cwd(), SKILLS_ALIAS_PROJECT);
	if (pathValue.startsWith(projectAliasAbs)) {
		return pathValue.replace(projectAliasAbs, PROJECT_SKILLS_ROOT);
	}
	return pathValue;
}

function mapToolArgs(
	toolName: string, args: Record<string, unknown> | undefined, allowSkillAliasRewrite = true,
): Record<string, unknown> {
	const normalized = toolName.toLowerCase();
	const input = args ?? {};
	const resolvePath = (value: unknown) => (allowSkillAliasRewrite ? rewriteSkillAliasPath(value) : value);
	switch (normalized) {
		case "read": return { path: resolvePath(input.file_path ?? input.path), offset: input.offset, limit: input.limit };
		case "write": return { path: resolvePath(input.file_path ?? input.path), content: input.content };
		case "edit": return { path: resolvePath(input.file_path ?? input.path), oldText: input.old_string ?? input.oldText ?? input.old_text, newText: input.new_string ?? input.newText ?? input.new_text };
		case "bash": return { command: input.command, timeout: input.timeout };
		case "grep": return { pattern: input.pattern, path: resolvePath(input.path), glob: input.glob, limit: input.head_limit ?? input.limit };
		case "find": return { pattern: input.pattern, path: resolvePath(input.path) };
		default: return input;
	}
}

// --- Provider helpers: system prompt ---

function extractSkillsAppend(systemPrompt?: string): string | undefined {
	if (!systemPrompt) return undefined;
	const startMarker = "The following skills provide specialized instructions for specific tasks.";
	const endMarker = "</available_skills>";
	const startIndex = systemPrompt.indexOf(startMarker);
	if (startIndex === -1) return undefined;
	const endIndex = systemPrompt.indexOf(endMarker, startIndex);
	if (endIndex === -1) return undefined;
	const skillsBlock = systemPrompt.slice(startIndex, endIndex + endMarker.length).trim();
	return rewriteSkillsLocations(skillsBlock);
}

function rewriteSkillsLocations(skillsBlock: string): string {
	return skillsBlock.replace(/<location>([^<]+)<\/location>/g, (_match, location: string) => {
		let rewritten = location;
		if (location.startsWith(GLOBAL_SKILLS_ROOT)) {
			const relPath = relative(GLOBAL_SKILLS_ROOT, location).replace(/^\.+/, "");
			rewritten = `${SKILLS_ALIAS_GLOBAL}/${relPath}`.replace(/\/\/+/g, "/");
		} else if (location.startsWith(PROJECT_SKILLS_ROOT)) {
			const relPath = relative(PROJECT_SKILLS_ROOT, location).replace(/^\.+/, "");
			rewritten = `${SKILLS_ALIAS_PROJECT}/${relPath}`.replace(/\/\/+/g, "/");
		}
		return `<location>${rewritten}</location>`;
	});
}

function resolveAgentsMdPath(): string | undefined {
	const fromCwd = findAgentsMdInParents(process.cwd());
	if (fromCwd) return fromCwd;
	if (existsSync(GLOBAL_AGENTS_PATH)) return GLOBAL_AGENTS_PATH;
	return undefined;
}

function findAgentsMdInParents(startDir: string): string | undefined {
	let current = resolve(startDir);
	while (true) {
		const candidate = join(current, "AGENTS.md");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

function extractAgentsAppend(): string | undefined {
	const agentsPath = resolveAgentsMdPath();
	if (!agentsPath) return undefined;
	try {
		const content = readFileSync(agentsPath, "utf-8").trim();
		if (!content) return undefined;
		const sanitized = sanitizeAgentsContent(content);
		return sanitized.length > 0 ? `# CLAUDE.md\n\n${sanitized}` : undefined;
	} catch {
		return undefined;
	}
}

function sanitizeAgentsContent(content: string): string {
	let sanitized = content;
	sanitized = sanitized.replace(/~\/\.pi\b/gi, "~/.claude");
	sanitized = sanitized.replace(/(^|[\s'"`])\.pi\//g, "$1.claude/");
	sanitized = sanitized.replace(/\b\.pi\b/gi, ".claude");
	sanitized = sanitized.replace(/\bpi\b/gi, "environment");
	return sanitized;
}

// --- Provider helpers: settings ---

type ProviderSettings = {
	appendSystemPrompt?: boolean;
	settingSources?: SettingSource[];
	strictMcpConfig?: boolean;
};

function loadProviderSettings(): ProviderSettings {
	const globalSettings = readSettingsFile(GLOBAL_SETTINGS_PATH);
	const projectSettings = readSettingsFile(PROJECT_SETTINGS_PATH);
	return { ...globalSettings, ...projectSettings };
}

function readSettingsFile(filePath: string): ProviderSettings {
	if (!existsSync(filePath)) return {};
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const settingsBlock =
			(parsed["claudeAgentSdkProvider"] as Record<string, unknown> | undefined) ??
			(parsed["claude-agent-sdk-provider"] as Record<string, unknown> | undefined) ??
			(parsed["claudeAgentSdk"] as Record<string, unknown> | undefined);
		if (!settingsBlock || typeof settingsBlock !== "object") return {};
		const appendSystemPrompt =
			typeof settingsBlock["appendSystemPrompt"] === "boolean" ? settingsBlock["appendSystemPrompt"] : undefined;
		const settingSourcesRaw = settingsBlock["settingSources"];
		const settingSources =
			Array.isArray(settingSourcesRaw) &&
			settingSourcesRaw.every((value) => typeof value === "string" && (value === "user" || value === "project" || value === "local"))
				? (settingSourcesRaw as SettingSource[])
				: undefined;
		const strictMcpConfig =
			typeof settingsBlock["strictMcpConfig"] === "boolean" ? settingsBlock["strictMcpConfig"] : undefined;
		return { appendSystemPrompt, settingSources, strictMcpConfig };
	} catch {
		return {};
	}
}

// --- Provider helpers: prompt building ---

function buildPromptBlocks(
	context: Context, customToolNameToSdk: Map<string, string> | undefined,
): ContentBlockParam[] {
	const blocks: ContentBlockParam[] = [];

	const pushText = (text: string) => { blocks.push({ type: "text", text }); };
	const pushImage = (image: ImageContent) => {
		blocks.push({
			type: "image",
			source: { type: "base64", media_type: image.mimeType as Base64ImageSource["media_type"], data: image.data },
		});
	};
	const pushPrefix = (label: string) => {
		pushText(`${blocks.length ? "\n\n" : ""}${label}\n`);
	};

	const appendContentBlocks = (
		content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
	): boolean => {
		if (typeof content === "string") {
			if (content.length > 0) { pushText(content); return content.trim().length > 0; }
			return false;
		}
		if (!Array.isArray(content)) return false;
		let hasText = false;
		for (const block of content) {
			if (block.type === "text") {
				const text = block.text ?? "";
				if (text.trim().length > 0) hasText = true;
				pushText(text);
			} else if (block.type === "image") {
				pushImage(block as ImageContent);
			} else {
				pushText(`[${block.type}]`);
			}
		}
		return hasText;
	};

	for (const message of context.messages) {
		if (message.role === "user") {
			pushPrefix("USER:");
			if (!appendContentBlocks(message.content)) pushText("(see attached image)");
		} else if (message.role === "assistant") {
			pushPrefix("ASSISTANT:");
			const text = contentToText(message.content, customToolNameToSdk);
			if (text.length > 0) pushText(text);
		} else if (message.role === "toolResult") {
			pushPrefix(`TOOL RESULT (historical ${mapPiToolNameToSdk(message.toolName, customToolNameToSdk)}):`);
			if (!appendContentBlocks(message.content)) pushText("(see attached image)");
		}
	}

	if (!blocks.length) return [{ type: "text", text: "" }];
	return blocks;
}

function buildPromptStream(promptBlocks: ContentBlockParam[]): AsyncIterable<SDKUserMessage> {
	async function* generator() {
		yield {
			type: "user" as const,
			message: { role: "user", content: promptBlocks } as MessageParam,
			parent_tool_use_id: null,
			session_id: "prompt",
		};
	}
	return generator();
}

// --- Provider helpers: tool resolution ---

function resolveSdkTools(context: Context): {
	sdkTools: string[];
	customTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	if (!context.tools) {
		return { sdkTools: [...DEFAULT_TOOLS], customTools: [], customToolNameToSdk: new Map(), customToolNameToPi: new Map() };
	}

	const sdkTools = new Set<string>();
	const customTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	for (const tool of context.tools) {
		const normalized = tool.name.toLowerCase();
		if (BUILTIN_TOOL_NAMES.has(normalized)) {
			const sdkName = PI_TO_SDK_TOOL_NAME[normalized];
			if (sdkName) sdkTools.add(sdkName);
			continue;
		}
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		customTools.push(tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(normalized, sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { sdkTools: Array.from(sdkTools), customTools, customToolNameToSdk, customToolNameToPi };
}

function buildCustomToolServers(customTools: Tool[]): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
	if (!customTools.length) return undefined;
	const mcpTools = customTools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters as unknown,
		handler: async () => ({
			content: [{ type: "text", text: TOOL_EXECUTION_DENIED_MESSAGE }],
			isError: true,
		}),
	}));
	const server = createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools: mcpTools });
	return { [MCP_SERVER_NAME]: server };
}

// --- Thinking budget mapping ---

type ThinkingLevel = NonNullable<SimpleStreamOptions["reasoning"]>;
type NonXhighThinkingLevel = Exclude<ThinkingLevel, "xhigh">;

const DEFAULT_THINKING_BUDGETS: Record<NonXhighThinkingLevel, number> = {
	minimal: 2048, low: 8192, medium: 16384, high: 31999,
};

// "xhigh" is unavailable in the TUI because pi-ai's supportsXhigh() doesn't
// recognize the "claude-code-acp" api type. Opus-4-6 gets shifted budgets so
// "high" uses the budget that xhigh would normally use.
const OPUS_46_THINKING_BUDGETS: Record<ThinkingLevel, number> = {
	minimal: 2048, low: 8192, medium: 31999, high: 63999, xhigh: 63999,
};

function mapThinkingTokens(
	reasoning?: ThinkingLevel, modelId?: string, thinkingBudgets?: SimpleStreamOptions["thinkingBudgets"],
): number | undefined {
	if (!reasoning) return undefined;

	const isOpus46 = modelId?.includes("opus-4-6") || modelId?.includes("opus-4.6");
	if (isOpus46) return OPUS_46_THINKING_BUDGETS[reasoning];

	const effectiveReasoning: NonXhighThinkingLevel = reasoning === "xhigh" ? "high" : reasoning;
	const customBudgets = thinkingBudgets as (Partial<Record<NonXhighThinkingLevel, number>> | undefined);
	const customBudget = customBudgets?.[effectiveReasoning];
	if (typeof customBudget === "number" && Number.isFinite(customBudget) && customBudget > 0) return customBudget;

	return DEFAULT_THINKING_BUDGETS[effectiveReasoning];
}

// --- Provider helpers: misc ---

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		case "end_turn": default: return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}

function getToolsForProvider(tools?: Tool[], excludeName?: string): Tool[] {
	if (!tools) return [];
	return excludeName ? tools.filter((t) => t.name !== excludeName) : tools;
}

// --- Provider: streaming function ---

function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		let sdkQuery: ReturnType<typeof query> | undefined;
		let wasAborted = false;
		const requestAbort = () => {
			if (!sdkQuery) return;
			void sdkQuery.interrupt().catch(() => { try { sdkQuery?.close(); } catch {} });
		};
		const onAbort = () => { wasAborted = true; requestAbort(); };
		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		const blocks = output.content as Array<
			| { type: "text"; text: string; index: number }
			| { type: "thinking"; thinking: string; thinkingSignature?: string; index: number }
			| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; partialJson: string; index: number }
		>;

		let started = false;
		let sawStreamEvent = false;
		let sawToolCall = false;
		let shouldStopEarly = false;

		try {
			const { sdkTools, customTools, customToolNameToSdk, customToolNameToPi } = resolveSdkTools(context);
			const promptBlocks = buildPromptBlocks(context, customToolNameToSdk);
			const prompt = buildPromptStream(promptBlocks);

			const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
			const mcpServers = buildCustomToolServers(customTools);
			const providerSettings = loadProviderSettings();
			const appendSystemPrompt = providerSettings.appendSystemPrompt !== false;
			const agentsAppend = appendSystemPrompt ? extractAgentsAppend() : undefined;
			const skillsAppend = appendSystemPrompt ? extractSkillsAppend(context.systemPrompt) : undefined;
			const appendParts = [agentsAppend, skillsAppend].filter((part): part is string => Boolean(part));
			const systemPromptAppend = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
			const allowSkillAliasRewrite = Boolean(skillsAppend);

			const settingSources: SettingSource[] | undefined = appendSystemPrompt
				? undefined
				: providerSettings.settingSources ?? ["user", "project"];

			const strictMcpConfigEnabled = !appendSystemPrompt && providerSettings.strictMcpConfig !== false;

			const extraArgs: Record<string, string | null> = { model: model.id };
			if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;

			const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
				cwd,
				tools: sdkTools,
				permissionMode: "dontAsk",
				includePartialMessages: true,
				canUseTool: async () => ({ behavior: "deny", message: TOOL_EXECUTION_DENIED_MESSAGE }),
				systemPrompt: {
					type: "preset", preset: "claude_code",
					append: systemPromptAppend ? systemPromptAppend : undefined,
				},
				extraArgs,
				...(settingSources ? { settingSources } : {}),
				...(mcpServers ? { mcpServers } : {}),
			};

			const maxThinkingTokens = mapThinkingTokens(options?.reasoning, model.id, options?.thinkingBudgets);
			if (maxThinkingTokens != null) queryOptions.maxThinkingTokens = maxThinkingTokens;

			sdkQuery = query({ prompt, options: queryOptions });
			if (wasAborted) requestAbort();

			for await (const message of sdkQuery) {
				if (!started) { stream.push({ type: "start", partial: output }); started = true; }

				switch (message.type) {
					case "stream_event": {
						sawStreamEvent = true;
						const event = (message as SDKMessage & { event: any }).event;

						if (event?.type === "message_start") {
							const usage = event.message?.usage;
							output.usage.input = usage?.input_tokens ?? 0;
							output.usage.output = usage?.output_tokens ?? 0;
							output.usage.cacheRead = usage?.cache_read_input_tokens ?? 0;
							output.usage.cacheWrite = usage?.cache_creation_input_tokens ?? 0;
							output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
							calculateCost(model, output.usage);
							break;
						}

						if (event?.type === "content_block_start") {
							if (event.content_block?.type === "text") {
								blocks.push({ type: "text", text: "", index: event.index });
								stream.push({ type: "text_start", contentIndex: blocks.length - 1, partial: output });
							} else if (event.content_block?.type === "thinking") {
								blocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
								stream.push({ type: "thinking_start", contentIndex: blocks.length - 1, partial: output });
							} else if (event.content_block?.type === "tool_use") {
								sawToolCall = true;
								blocks.push({
									type: "toolCall", id: event.content_block.id,
									name: mapToolName(event.content_block.name, customToolNameToPi),
									arguments: (event.content_block.input as Record<string, unknown>) ?? {},
									partialJson: "", index: event.index,
								});
								stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
							}
							break;
						}

						if (event?.type === "content_block_delta") {
							if (event.delta?.type === "text_delta") {
								const index = blocks.findIndex((b) => b.index === event.index);
								const block = blocks[index];
								if (block?.type === "text") {
									block.text += event.delta.text;
									stream.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: output });
								}
							} else if (event.delta?.type === "thinking_delta") {
								const index = blocks.findIndex((b) => b.index === event.index);
								const block = blocks[index];
								if (block?.type === "thinking") {
									block.thinking += event.delta.thinking;
									stream.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: output });
								}
							} else if (event.delta?.type === "input_json_delta") {
								const index = blocks.findIndex((b) => b.index === event.index);
								const block = blocks[index];
								if (block?.type === "toolCall") {
									block.partialJson += event.delta.partial_json;
									block.arguments = parsePartialJson(block.partialJson, block.arguments);
									stream.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: output });
								}
							} else if (event.delta?.type === "signature_delta") {
								const index = blocks.findIndex((b) => b.index === event.index);
								const block = blocks[index];
								if (block?.type === "thinking") {
									block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
								}
							}
							break;
						}

						if (event?.type === "content_block_stop") {
							const index = blocks.findIndex((b) => b.index === event.index);
							const block = blocks[index];
							if (!block) break;
							delete (block as any).index;
							if (block.type === "text") {
								stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
							} else if (block.type === "thinking") {
								stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
							} else if (block.type === "toolCall") {
								sawToolCall = true;
								block.arguments = mapToolArgs(
									block.name, parsePartialJson(block.partialJson, block.arguments), allowSkillAliasRewrite,
								);
								delete (block as any).partialJson;
								stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
							}
							break;
						}

						if (event?.type === "message_delta") {
							output.stopReason = mapStopReason(event.delta?.stop_reason);
							const usage = event.usage ?? {};
							if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
							if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
							if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
							if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
							output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
							calculateCost(model, output.usage);
							break;
						}

						if (event?.type === "message_stop" && sawToolCall) {
							output.stopReason = "toolUse";
							shouldStopEarly = true;
							break;
						}

						break;
					}

					case "result": {
						if (!sawStreamEvent && message.subtype === "success") {
							output.content.push({ type: "text", text: message.result || "" });
						}
						break;
					}
				}

				if (shouldStopEarly) break;
			}

			if (wasAborted || options?.signal?.aborted) {
				output.stopReason = "aborted";
				output.errorMessage = "Operation aborted";
				stream.push({ type: "error", reason: "aborted", error: output });
				stream.end();
				return;
			}

			stream.push({
				type: "done",
				reason: output.stopReason === "toolUse" ? "toolUse" : output.stopReason === "length" ? "length" : "stop",
				message: output,
			});
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
			stream.end();
		} finally {
			if (options?.signal) options.signal.removeEventListener("abort", onAbort);
			sdkQuery?.close();
		}
	})();

	return stream;
}

// --- AskClaude: prompt and wait ---

async function promptAndWait(
	prompt: string,
	mode: "full" | "read" | "none",
	toolCalls: Map<string, ToolCallState>,
	signal?: AbortSignal,
	options?: {
		systemPrompt?: string;
		appendSkills?: boolean;
		onStreamUpdate?: (responseText: string) => void;
		model?: string;
		thinking?: string;
		isolated?: boolean;
		context?: Context["messages"];
	},
): Promise<{ responseText: string; stopReason: string }> {
	const cwd = process.cwd();

	// Build prompt — prepend conversation context for shared mode
	let fullPrompt: string;
	if (!options?.isolated && options?.context?.length) {
		const summary = buildContextSummary(options.context);
		fullPrompt = `<conversation_context>\n${summary}\n</conversation_context>\n\n${prompt}`;
	} else {
		fullPrompt = prompt;
	}

	// Mode → disallowed tools
	const disallowedTools = MODE_DISALLOWED_TOOLS[mode] ?? [];

	// Skills append
	const skillsBlock = options?.appendSkills !== false && options?.systemPrompt
		? extractSkillsBlock(options.systemPrompt) : undefined;

	// Model
	const modelId = resolveModelId(options?.model ?? "opus");

	// Thinking
	const thinkingMap: Record<string, ThinkingLevel> = {
		minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh",
	};
	const thinkingLevel = options?.thinking && options.thinking !== "off"
		? thinkingMap[options.thinking] : undefined;
	const maxThinkingTokens = thinkingLevel ? mapThinkingTokens(thinkingLevel, modelId) : undefined;

	const extraArgs: Record<string, string | null> = {
		"strict-mcp-config": null,
		model: modelId,
	};

	const sdkQuery = query({
		prompt: fullPrompt,
		options: {
			cwd,
			permissionMode: "bypassPermissions",
			...(disallowedTools.length ? { disallowedTools } : {}),
			...(maxThinkingTokens != null ? { maxThinkingTokens } : {}),
			systemPrompt: skillsBlock
				? { type: "preset", preset: "claude_code", append: skillsBlock }
				: undefined,
			settingSources: ["user", "project"] as SettingSource[],
			extraArgs,
		},
	});

	// Abort handling
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		sdkQuery.interrupt().catch(() => { try { sdkQuery.close(); } catch {} });
	};
	if (signal?.aborted) { onAbort(); throw new Error("Aborted"); }
	signal?.addEventListener("abort", onAbort, { once: true });

	let responseText = "";

	try {
		for await (const message of sdkQuery) {
			if (wasAborted) break;

			switch (message.type) {
				case "stream_event": {
					const event = (message as SDKMessage & { event: any }).event;
					// Text deltas → accumulate and stream
					if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
						responseText += event.delta.text;
						options?.onStreamUpdate?.(responseText);
					}
					// Tool call start → track for action summary progress
					if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
						toolCalls.set(event.content_block.id, {
							name: event.content_block.name,
							status: "running",
						});
					}
					break;
				}
				case "assistant": {
					// Update tool calls with full input for action summary
					for (const block of (message as any).message?.content ?? []) {
						if (block.type === "tool_use") {
							toolCalls.set(block.id, {
								name: block.name,
								status: "complete",
								rawInput: block.input,
							});
						}
					}
					break;
				}
				case "result": {
					if (!responseText && message.subtype === "success" && message.result) {
						responseText = message.result;
					}
					break;
				}
			}
		}

		return { responseText, stopReason: wasAborted ? "cancelled" : "stop" };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		sdkQuery.close();
	}
}

// --- Extension registration ---

const DEFAULT_TOOL_DESCRIPTION_FULL = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself.";
const DEFAULT_TOOL_DESCRIPTION = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories). Read-only — Claude Code can explore the codebase but not make changes. Prefer to handle straightforward tasks yourself.";

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

let askClaudeToolName = "AskClaude";

export default function (pi: ExtensionAPI) {
	const config = loadConfig(process.cwd());

	// --- Provider ---

	pi.registerProvider(PROVIDER_ID, {
		baseUrl: "claude-code-acp",
		apiKey: "not-used",
		api: "claude-code-acp",
		models: MODELS,
		streamSimple: streamClaudeAgentSdk,
	});

	// --- AskClaude tool ---

	const askConf = config.askClaude;
	const allowFull = askConf?.allowFullMode === true;
	const defaultMode = askConf?.defaultMode ?? "read";
	askClaudeToolName = askConf?.name ?? "AskClaude";

	const modeValues = allowFull ? ["read", "full", "none"] as const : ["read", "none"] as const;
	let modeDesc = `"read" (default): questions about the codebase — review, analysis, explain. "none": general knowledge only (no file access).`;
	if (allowFull) modeDesc += ` "full": allows writing and bash execution (careful: runs without feedback to pi).`;

	if (askConf?.enabled !== false) {
		pi.registerTool({
			name: askConf?.name ?? "AskClaude",
			label: askConf?.label ?? "Ask Claude Code",
			description: askConf?.description ?? (allowFull ? DEFAULT_TOOL_DESCRIPTION_FULL : DEFAULT_TOOL_DESCRIPTION),
			parameters: Type.Object({
				prompt: Type.String({ description: "The question or task for Claude Code. By default Claude sees the full conversation history. Don't research up front, let Claude explore." }),
				mode: Type.Optional(StringEnum(modeValues, { description: modeDesc })),
				model: Type.Optional(Type.String({ description: 'Claude model (e.g. "opus", "sonnet", "haiku", or full ID). Defaults to "opus".' })),
				thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, { description: "Thinking effort level. Omit to use Claude Code's default." })),
				isolated: Type.Optional(Type.Boolean({ description: "When true, Claude sees only this prompt (clean session). When false (default), Claude sees the full conversation history." })),
			}),
			renderCall(args, theme) {
				let text = theme.fg("mdLink", theme.bold("AskClaude "));
				const mode = args.mode ?? defaultMode;
				const tags: string[] = [];
				if (mode !== "full") tags.push(`tools=${mode}`);
				if (args.model) tags.push(`model=${args.model}`);
				if (args.thinking) tags.push(`thinking=${args.thinking}`);
				if (args.isolated) tags.push("isolated");
				if (tags.length) text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;
				const truncated = args.prompt.length > PREVIEW_MAX_CHARS ? args.prompt.substring(0, PREVIEW_MAX_CHARS) : args.prompt;
				const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
				text += theme.fg("muted", `"${lines.join("\n")}"`);
				if (args.prompt.length > PREVIEW_MAX_CHARS || args.prompt.split("\n").length > PREVIEW_MAX_LINES) text += theme.fg("dim", " …");
				return new Text(text, 0, 0);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) {
					const status = result.content[0]?.type === "text" ? result.content[0].text : "working...";
					return new Text(theme.fg("mdLink", "◉ Claude Code ") + theme.fg("muted", status), 0, 0);
				}

				const details = result.details as { prompt?: string; executionTime?: number; actions?: string; error?: boolean } | undefined;
				const body = result.content[0]?.type === "text" ? result.content[0].text : "";

				let text = details?.error
					? theme.fg("error", "✗ Claude Code error")
					: theme.fg("mdLink", "✓ Claude Code");

				if (details?.executionTime) text += ` ${theme.fg("dim", `${(details.executionTime / 1000).toFixed(1)}s`)}`;
				if (details?.actions) text += ` ${theme.fg("muted", details.actions)}`;

				if (expanded) {
					if (details?.prompt) text += `\n${theme.fg("dim", `Prompt: ${details.prompt}`)}`;
					if (details?.prompt && body) text += `\n${theme.fg("dim", "─".repeat(40))}`;
					if (body) text += `\n${theme.fg("toolOutput", body)}`;
				} else {
					const truncated = body.length > PREVIEW_MAX_CHARS ? body.substring(0, PREVIEW_MAX_CHARS) : body;
					const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
					if (lines.length) text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
					if (body.length > PREVIEW_MAX_CHARS || body.split("\n").length > PREVIEW_MAX_LINES) text += `\n${theme.fg("dim", "…")}`;
				}

				return new Text(text, 0, 0);
			},
			async execute(_id, params, signal, onUpdate, ctx) {
				// Guard: circular delegation
				if (ctx.model?.baseUrl === "claude-code-acp") {
					return {
						content: [{ type: "text" as const, text: "Error: AskClaude cannot be used when the active provider is claude-code-acp — you're already running through Claude Code." }],
						details: { error: true },
					};
				}

				const mode = (params.mode ?? defaultMode) as "full" | "read" | "none";
				const toolCalls = new Map<string, ToolCallState>();
				const start = Date.now();

				const progressInterval = setInterval(() => {
					const elapsed = ((Date.now() - start) / 1000).toFixed(0);
					const summary = buildActionSummary(toolCalls);
					const status = summary ? `${elapsed}s — ${summary}` : `${elapsed}s — working...`;
					onUpdate?.({
						content: [{ type: "text", text: status }],
						details: { prompt: params.prompt, executionTime: Date.now() - start },
					});
				}, 1000);

				try {
					const result = await promptAndWait(params.prompt, mode, toolCalls, signal, {
						systemPrompt: ctx.getSystemPrompt(),
						appendSkills: askConf?.appendSkills,
						model: params.model,
						thinking: params.thinking,
						isolated: params.isolated,
						context: params.isolated ? undefined : buildSessionContext(ctx.sessionManager.getBranch()).messages as Context["messages"],
					});
					clearInterval(progressInterval);
					const executionTime = Date.now() - start;
					const actions = buildActionSummary(toolCalls);

					const text = actions
						? `${result.responseText}\n\n[Claude Code actions: ${actions}]`
						: result.responseText;
					return {
						content: [{ type: "text" as const, text }],
						details: { prompt: params.prompt, executionTime, actions },
					};
				} catch (err) {
					clearInterval(progressInterval);
					console.error("[claude-code-acp] AskClaude error:", err);
					const msg = errorMessage(err);
					return {
						content: [{ type: "text" as const, text: `Error: ${msg}` }],
						details: { prompt: params.prompt, executionTime: Date.now() - start, error: true },
					};
				}
			},
		});
	}
}
