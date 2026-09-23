// 拒答恢复用的原会话正文。
//
// 恢复出来的新会话要知道之前在做什么。只给原会话 JSONL 的路径时，模型会自己去
// 解析文件，把里面的推理（thinking）连同工具输出一起打印进上下文；2026-09-23
// 连续三次拦截的类别都是 reasoning_extraction，其中两次紧跟在打印旧推理之后。
// 所以恢复时先把当前分支整理成对话正文：用户消息、助手文字、工具调用各一行、
// 摘要与显示出来的扩展消息；推理和工具输出都不收（工具输出里可能就是之前打印
// 过的推理）。

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** 会话条目的结构类型：只用到这里读的字段，不绑定 pi-coding-agent 的版本。 */
export type BranchEntry = {
	type: string;
	id?: string;
	message?: any;
	summary?: string;
	firstKeptEntryId?: string;
	customType?: string;
	content?: unknown;
	display?: boolean;
};

const TOOL_ARGS_MAX = 200;
const CUSTOM_MAX = 1000;
const ERROR_MAX = 200;

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 文本块拼起来；图片记一个占位。 */
function plainText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: any) => (block?.type === "text" ? block.text ?? "" : block?.type === "image" ? "[图片]" : ""))
		.filter(Boolean)
		.join("\n");
}

/** 当前分支里模型实际看到的条目：最近一次压缩之前的部分换成它的摘要。 */
function effectiveEntries(branch: BranchEntry[]): BranchEntry[] {
	let last = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			last = i;
			break;
		}
	}
	if (last === -1) return branch;
	const compaction = branch[last];
	const keptAt = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	const kept = keptAt === -1 || keptAt > last ? [] : branch.slice(keptAt, last);
	return [compaction, ...kept, ...branch.slice(last + 1)];
}

/** 一条条目的正文；不收的返回 null。 */
function renderEntry(entry: BranchEntry): string | null {
	if (entry.type === "compaction") return `### 早先对话的摘要\n\n${entry.summary ?? ""}`;
	if (entry.type === "branch_summary") return `### 另一分支的摘要\n\n${entry.summary ?? ""}`;
	if (entry.type === "custom_message") {
		return entry.display ? `### 扩展消息（${entry.customType ?? "custom"}）\n\n${clip(plainText(entry.content), CUSTOM_MAX)}` : null;
	}
	if (entry.type !== "message" || !entry.message) return null;

	const message = entry.message;
	switch (message.role) {
		case "user":
			return `### 用户\n\n${plainText(message.content)}`;
		case "assistant": {
			const lines: string[] = [];
			for (const block of Array.isArray(message.content) ? message.content : []) {
				// thinking 不收：这是整份正文存在的原因。
				if (block?.type === "text" && block.text?.trim()) lines.push(block.text);
				else if (block?.type === "toolCall") lines.push(`- 调用 ${block.name} ${clip(JSON.stringify(block.arguments ?? {}), TOOL_ARGS_MAX)}`);
			}
			if (message.stopReason === "error" && message.errorMessage) {
				lines.push(`（这一轮出错：${clip(String(message.errorMessage), ERROR_MAX)}）`);
			}
			return lines.length > 0 ? `### 助手\n\n${lines.join("\n\n")}` : null;
		}
		case "bashExecution":
			return `### 用户执行命令\n\n\`${message.command}\``;
		case "custom":
			return message.display ? `### 扩展消息（${message.customType ?? "custom"}）\n\n${clip(plainText(message.content), CUSTOM_MAX)}` : null;
		// toolResult 不收：工具输出里可能就是之前打印过的推理。
		default:
			return null;
	}
}

/** 把当前分支整理成对话正文（Markdown）。开头先放最后一条用户消息。 */
export function buildTranscript(branch: BranchEntry[]): string {
	const entries = effectiveEntries(branch);
	const sections = entries.map(renderEntry).filter((section): section is string => section !== null);
	const lastUser = [...entries].reverse().find((entry) => entry.type === "message" && entry.message?.role === "user");
	return [
		"# 上一个会话的对话正文",
		"已去掉推理（thinking）和工具输出；工具调用只留名称和参数开头。",
		"## 最后一条用户消息",
		lastUser ? plainText(lastUser.message.content) : "（没有）",
		"## 全文",
		...sections,
	].join("\n\n") + "\n";
}

/** 正文写到哪里：按原会话文件名放在 watchdog 自己的目录下。 */
export function transcriptPath(parentSessionFile: string | undefined, now = Date.now()): string {
	const name = parentSessionFile ? basename(parentSessionFile, ".jsonl") : `session-${now}`;
	return join(homedir(), ".pi", "agent", "stall-watchdog", "recovered", `${name}.md`);
}

/** 写出正文并返回路径。 */
export function writeTranscript(branch: BranchEntry[], parentSessionFile: string | undefined): string {
	const path = transcriptPath(parentSessionFile);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, buildTranscript(branch));
	return path;
}
