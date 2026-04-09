/**
 * Tests for skills block extraction and rewriting.
 * Verifies we correctly extract skills from pi's system prompt and rewrite
 * the read tool reference for the Claude Code MCP bridge.
 */
import assert from "node:assert/strict";

const MCP_SERVER_NAME = "custom-tools";

// --- Extracted logic (mirrors index.ts) ---

function rewriteSkillsBlock(skillsBlock) {
	return skillsBlock.replace(
		"Use the read tool to load a skill's file",
		`Use the read tool (mcp__${MCP_SERVER_NAME}__read) to load a skill's file`,
	);
}

function extractSkillsBlock(systemPrompt) {
	if (!systemPrompt) return undefined;
	const startMarker = "The following skills provide specialized instructions for specific tasks.";
	const endMarker = "</available_skills>";
	const start = systemPrompt.indexOf(startMarker);
	if (start === -1) return undefined;
	const end = systemPrompt.indexOf(endMarker, start);
	if (end === -1) return undefined;
	return rewriteSkillsBlock(systemPrompt.slice(start, end + endMarker.length).trim());
}

// --- Tests ---

// Realistic pi system prompt with skills block
const SYSTEM_PROMPT = `You are a coding assistant.

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>br</name>
    <description>Browser automation CLI.</description>
    <location>/Users/esd/projects/pi-my-stuff/skills/br/SKILL.md</location>
  </skill>
  <skill>
    <name>deep-research</name>
    <description>Deep research via parallel web agents.</description>
    <location>/Users/esd/.pi/agent/skills/deep-research/SKILL.md</location>
  </skill>
</available_skills>

Some other system prompt content after skills.`;

{
	const result = extractSkillsBlock(SYSTEM_PROMPT);
	assert.ok(result, "should extract skills block");

	// Tool name is rewritten
	assert.ok(result.includes("Use the read tool (mcp__custom-tools__read) to load a skill's file"), "should rewrite read tool reference");
	assert.ok(!result.includes("Use the read tool to load a skill's file\n"), "should not contain original read tool reference");

	// Skill paths are preserved as-is (no aliasing)
	assert.ok(result.includes("/Users/esd/projects/pi-my-stuff/skills/br/SKILL.md"), "should preserve project skill path");
	assert.ok(result.includes("/Users/esd/.pi/agent/skills/deep-research/SKILL.md"), "should preserve global skill path");

	// Boundaries are correct
	assert.ok(result.startsWith("The following skills"), "should start at skills block");
	assert.ok(result.endsWith("</available_skills>"), "should end at closing tag");
	assert.ok(!result.includes("Some other system prompt"), "should not include content after skills block");
}

// No skills in prompt
{
	assert.strictEqual(extractSkillsBlock("Just a normal prompt"), undefined);
	assert.strictEqual(extractSkillsBlock(undefined), undefined);
	assert.strictEqual(extractSkillsBlock(""), undefined);
}

// Malformed: start marker but no end marker
{
	const partial = "The following skills provide specialized instructions for specific tasks.\nBut no closing tag.";
	assert.strictEqual(extractSkillsBlock(partial), undefined, "should return undefined for incomplete skills block");
}

console.log("skills tests passed");
