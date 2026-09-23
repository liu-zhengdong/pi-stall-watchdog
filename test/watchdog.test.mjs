import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import watchdogExtension, { RECOVERY_COOLDOWN_MS, buildStallMessage, isSafeguardRefusal, shouldAutoRecover, withStallWatchdog } from "../src/index.ts";
import { buildTranscript } from "../src/transcript.ts";

// 看门狗的计时器是 unref 的（不该让 pi 进程为它活着），测试进程里没有别的
// 活动句柄，事件循环会直接排空。真实运行时底层请求自带 socket/子进程句柄，
// 这里用一个 ref 的心跳补上。
const keepAlive = setInterval(() => {}, 50);
after(() => clearInterval(keepAlive));

const MODEL = { id: "claude-opus-5", provider: "claude-bridge", api: "anthropic-messages" };

function partial(extra = {}) {
	return {
		role: "assistant",
		content: [],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
		...extra,
	};
}

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("停摆触发：底层一直不出事件，看门狗发可重试的 error", async () => {
	let innerSignal;
	const inner = (_model, _ctx, options) => {
		innerSignal = options.signal;
		return createAssistantMessageEventStream(); // 永远不 push
	};
	const wrapped = withStallWatchdog(inner, "test.stall", 120);
	const events = await collect(wrapped(MODEL, {}, {}));

	assert.equal(events.length, 1);
	assert.equal(events[0].type, "error");
	assert.equal(events[0].reason, "error");
	assert.equal(events[0].error.stopReason, "error");
	assert.match(events[0].error.errorMessage, /no stream events for 0s|timeout/);
	assert.equal(innerSignal.aborted, true, "底层请求必须被中断");
	assert.equal(isRetryableAssistantError(events[0].error), true, "Pi 必须认为这条错误可重试");
});

test("正常流：事件原样透传，不触发看门狗", async () => {
	const done = { type: "done", reason: "stop", message: partial({ content: [{ type: "text", text: "hi" }] }) };
	const inner = () => {
		const s = createAssistantMessageEventStream();
		queueMicrotask(() => {
			s.push({ type: "start", partial: partial() });
			s.push({ type: "text_delta", contentIndex: 0, delta: "hi", partial: partial() });
			s.push(done);
		});
		return s;
	};
	const stream = withStallWatchdog(inner, "test.ok", 120)(MODEL, {}, {});
	const events = await collect(stream);
	assert.deepEqual(events.map((e) => e.type), ["start", "text_delta", "done"]);
	assert.equal((await stream.result()).stopReason, "stop");
	await sleep(200); // 超过阈值也不该再冒出 error
});

test("有进展就续命：事件间隔小于阈值时不触发", async () => {
	const inner = () => {
		const s = createAssistantMessageEventStream();
		(async () => {
			for (let i = 0; i < 6; i++) {
				await sleep(40);
				s.push({ type: "text_delta", contentIndex: 0, delta: String(i), partial: partial() });
			}
			s.push({ type: "done", reason: "stop", message: partial() });
		})();
		return s;
	};
	const events = await collect(withStallWatchdog(inner, "test.progress", 100)(MODEL, {}, {}));
	assert.equal(events.filter((e) => e.type === "error").length, 0);
	assert.equal(events.at(-1).type, "done");
});

test("调用方中断：转发 provider 自己的 aborted，不伪造 timeout", async () => {
	const controller = new AbortController();
	const inner = (_m, _c, options) => {
		const s = createAssistantMessageEventStream();
		options.signal.addEventListener("abort", () => {
			s.push({ type: "error", reason: "aborted", error: partial({ stopReason: "aborted", errorMessage: "Operation aborted" }) });
		});
		return s;
	};
	const stream = withStallWatchdog(inner, "test.abort", 5000)(MODEL, {}, { signal: controller.signal });
	setTimeout(() => controller.abort(), 30);
	const events = await collect(stream);
	assert.equal(events.length, 1);
	assert.equal(events[0].reason, "aborted");
	assert.equal(events[0].error.errorMessage, "Operation aborted");
});

test("底层抛异常：原样转发错误文本，不当成停摆", async () => {
	const inner = () => {
		throw new Error("boom from provider");
	};
	const events = await collect(withStallWatchdog(inner, "test.throw", 5000)(MODEL, {}, {}));
	assert.equal(events.length, 1);
	assert.equal(events[0].error.errorMessage, "boom from provider");
});

test("deferred 请求豁免：不装看门狗，不会被误杀", async () => {
	let innerSignal;
	const inner = (_m, _c, options) => {
		innerSignal = options.signal;
		const s = createAssistantMessageEventStream();
		setTimeout(() => s.push({ type: "done", reason: "deferred", message: partial({ stopReason: "deferred" }) }), 200);
		return s;
	};
	const events = await collect(withStallWatchdog(inner, "test.deferred", 50)(MODEL, {}, { deferred: true }));
	assert.equal(events.length, 1);
	assert.equal(events[0].type, "done");
	assert.equal(innerSignal, undefined, "deferred 路径不应该被换成派生 signal");
});

test("阈值为 0 时原样返回，不做任何包装", () => {
	const inner = () => createAssistantMessageEventStream();
	assert.equal(withStallWatchdog(inner, "test.off", 0), inner);
});

test("停摆消息保留已收到的内容与用量", () => {
	const seen = partial({ content: [{ type: "thinking", thinking: "半截" }], usage: { input: 5, output: 7, cacheRead: 1, cacheWrite: 2, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
	const message = buildStallMessage(MODEL, seen, 120_000);
	assert.equal(message.stopReason, "error");
	assert.equal(message.content.length, 1);
	assert.equal(message.usage.output, 7);
	assert.equal(message.errorMessage, "Provider stream timeout: no stream events for 120s (pi stall watchdog)");
	assert.equal(isRetryableAssistantError(message), true);
});

test("反向：几种不该被当成可重试的文本确实不可重试", () => {
	for (const text of ["quota exceeded", "insufficient_quota", "billing problem", "context window exceeded"]) {
		assert.equal(isRetryableAssistantError({ ...partial(), stopReason: "error", errorMessage: text }), false, text);
	}
	// aborted 永远不重试，这正是看门狗不能发 aborted 的原因
	assert.equal(isRetryableAssistantError({ ...partial(), stopReason: "aborted", errorMessage: "Provider stream timeout" }), false);
});

test("拒答判定：只认 safeguards flagged 文本", () => {
	const refusal = partial({ stopReason: "error", errorMessage: "API Error: Opus 5 (1M context)'s safeguards flagged this message (https://www.anthropic.com/legal/aup)." });
	assert.equal(isSafeguardRefusal(refusal), true);
	assert.equal(isSafeguardRefusal(partial({ stopReason: "error", errorMessage: "Provider stream timeout: no stream events for 120s (pi stall watchdog)" })), false);
	assert.equal(isSafeguardRefusal(partial({ stopReason: "error", errorMessage: "quota exceeded" })), false);
	assert.equal(isSafeguardRefusal(partial({ stopReason: "error" })), false);
	assert.equal(isSafeguardRefusal(partial()), false);
	assert.equal(isSafeguardRefusal({ role: "user", content: [] }), false);
	assert.equal(isSafeguardRefusal(undefined), false);
});

test("恢复决策：开关、hasUI 与冷却", () => {
	const now = 1_000_000_000_000;
	const base = { hasUI: true, env: undefined, now, lastAt: 0 };
	assert.equal(shouldAutoRecover(base), true);
	assert.equal(shouldAutoRecover({ ...base, hasUI: false }), false, "默认无 UI 不恢复");
	assert.equal(shouldAutoRecover({ ...base, hasUI: false, env: "1" }), true, "设 1 后无 UI 也恢复");
	assert.equal(shouldAutoRecover({ ...base, env: "0" }), false, "设 0 关闭");
	assert.equal(shouldAutoRecover({ ...base, lastAt: now - 1 }), false, "冷却内不恢复");
	assert.equal(shouldAutoRecover({ ...base, lastAt: now - RECOVERY_COOLDOWN_MS }), true, "冷却边界可恢复");
});

test("终态回调：拒答在停稳时派发 /recover，普通消息不派发", () => {
	delete globalThis[Symbol.for("pi-stall-watchdog:recovery")];
	const savedEnv = process.env.PI_STALL_WATCHDOG_RECOVER;
	delete process.env.PI_STALL_WATCHDOG_RECOVER;
	try {
		const handlers = {};
		const sent = [];
		const fakePi = {
			on: (name, handler) => { (handlers[name] ??= []).push(handler); },
			registerCommand: () => {},
			sendUserMessage: (content, options) => { sent.push({ content, options }); },
		};
		watchdogExtension(fakePi);
		const fireMessage = (message) => { for (const handler of handlers.message_end ?? []) handler({ message }, {}); };
		const settle = (ctx = { hasUI: true }) => { for (const handler of handlers.agent_settled ?? []) handler({}, ctx); };
		const refusal = () => partial({ stopReason: "error", errorMessage: "API Error: Opus 5 (1M context)'s safeguards flagged this message (https://www.anthropic.com/legal/aup)." });

		fireMessage(partial({ content: [{ type: "text", text: "hi" }] }));
		settle();
		assert.equal(sent.length, 0, "普通消息不触发");

		fireMessage(refusal());
		settle();
		assert.deepEqual(sent, [{ content: "/recover", options: { expandPromptTemplates: true } }], "拒答后停稳派发 /recover");

		fireMessage(refusal());
		settle();
		assert.equal(sent.length, 1, "冷却内不重复派发");

		delete globalThis[Symbol.for("pi-stall-watchdog:recovery")];
		fireMessage(refusal());
		settle({ hasUI: false });
		assert.equal(sent.length, 1, "无 UI 默认不派发");
	} finally {
		if (savedEnv === undefined) delete process.env.PI_STALL_WATCHDOG_RECOVER;
		else process.env.PI_STALL_WATCHDOG_RECOVER = savedEnv;
	}
});

test("恢复命令：新会话带 parentSession，先写接续说明再发「继续上次的任务」", async () => {
	const commands = {};
	const fakePi = {
		on: () => {},
		registerCommand: (name, options) => { commands[name] = options; },
		sendUserMessage: () => {},
	};
	watchdogExtension(fakePi);
	assert.ok(commands.recover, "注册了 recover 命令");
	const calls = [];
	const rctx = {
		sendMessage: async (message) => { calls.push(["sendMessage", message]); },
		sendUserMessage: async (text) => { calls.push(["sendUserMessage", text]); },
	};
	const ctx = {
		waitForIdle: async () => { calls.push(["waitForIdle"]); },
		sessionManager: { getSessionFile: () => "/tmp/parent-session.jsonl" },
		newSession: async (options) => {
			calls.push(["newSession", options.parentSession]);
			await options.withSession(rctx);
			return { cancelled: false };
		},
	};
	await commands.recover.handler("", ctx);
	assert.deepEqual(calls.map((call) => call[0]), ["waitForIdle", "newSession", "sendMessage", "sendUserMessage"]);
	assert.equal(calls[1][1], "/tmp/parent-session.jsonl");
	assert.equal(calls[2][1].customType, "stall-watchdog-recovery");
	assert.equal(calls[2][1].display, true);
	assert.match(String(calls[2][1].content), /safeguards/);
	assert.match(String(calls[2][1].content), /parent-session\.jsonl/);
	assert.equal(calls[3][1], "继续上次的任务");
});

// 2026-09-23 连续三次拦截（reasoning_extraction）都发生在恢复出来的新会话里：
// 模型自己解析原会话 JSONL，把旧推理打印进了上下文。正文里不能有推理，也不能
// 有工具输出（里面可能就是之前打印过的推理）。
const RECOVERY_BRANCH = [
	{ type: "message", id: "1", message: { role: "user", content: "旧任务，已被压缩" } },
	{ type: "message", id: "2", message: { role: "user", content: "修一下 #16" } },
	{ type: "message", id: "3", message: { role: "assistant", content: [
		{ type: "thinking", thinking: "SECRET-REASONING" },
		{ type: "text", text: "先读代码。" },
		{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "cat src/a.ts" } },
	] } },
	{ type: "message", id: "4", message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "SECRET-TOOL-OUTPUT" }] } },
	{ type: "compaction", id: "5", summary: "之前讨论了 bridge 的问题", firstKeptEntryId: "2" },
	{ type: "custom_message", id: "6", customType: "note", content: "可见的扩展消息", display: true },
	{ type: "custom_message", id: "7", customType: "hidden", content: "HIDDEN-EXTENSION", display: false },
	{ type: "message", id: "8", message: { role: "user", content: [{ type: "text", text: "继续" }, { type: "image", data: "x", mimeType: "image/png" }] } },
	{ type: "message", id: "9", message: { role: "assistant", content: [{ type: "thinking", thinking: "MORE-REASONING" }], stopReason: "error", errorMessage: "API Error: Opus 5's safeguards flagged this message" } },
];

test("原会话正文：只留对话，不收推理、工具输出和隐藏的扩展消息", () => {
	const text = buildTranscript(RECOVERY_BRANCH);
	for (const kept of ["修一下 #16", "先读代码。", "- 调用 bash", "cat src/a.ts", "之前讨论了 bridge 的问题", "可见的扩展消息", "[图片]", "safeguards flagged"]) {
		assert.ok(text.includes(kept), `应收录：${kept}`);
	}
	for (const dropped of ["SECRET-REASONING", "MORE-REASONING", "SECRET-TOOL-OUTPUT", "HIDDEN-EXTENSION"]) {
		assert.ok(!text.includes(dropped), `不应收录：${dropped}`);
	}
	assert.ok(!text.includes("旧任务，已被压缩"), "压缩掉的部分只留摘要");
	assert.match(text, /## 最后一条用户消息\n\n继续\n\[图片\]\n\n## 全文/, "最后一条用户消息放在最前面");
});

test("恢复命令：写出原会话正文，接续说明指向它，并提醒别打印原会话文件", async () => {
	const home = mkdtempSync(join(tmpdir(), "stall-watchdog-home-"));
	const savedHome = process.env.HOME;
	process.env.HOME = home;
	try {
		const commands = {};
		watchdogExtension({ on: () => {}, registerCommand: (name, options) => { commands[name] = options; }, sendUserMessage: () => {} });
		const sent = [];
		const ctx = {
			waitForIdle: async () => {},
			sessionManager: { getSessionFile: () => "/tmp/sessions/parent-session.jsonl", getBranch: () => RECOVERY_BRANCH },
			newSession: async (options) => {
				await options.withSession({ sendMessage: async (message) => { sent.push(message); }, sendUserMessage: async () => {} });
				return { cancelled: false };
			},
		};
		await commands.recover.handler("", ctx);

		const path = join(home, ".pi", "agent", "stall-watchdog", "recovered", "parent-session.md");
		const note = String(sent[0].content);
		assert.ok(note.includes(path), "接续说明指向正文");
		assert.match(note, /parent-session\.jsonl 含推理内容，不要把它打印进上下文/);
		const written = readFileSync(path, "utf8");
		assert.ok(written.includes("修一下 #16"));
		assert.ok(!written.includes("SECRET-REASONING"));
	} finally {
		process.env.HOME = savedHome;
		rmSync(home, { recursive: true, force: true });
	}
});
