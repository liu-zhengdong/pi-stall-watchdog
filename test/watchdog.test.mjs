import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { buildStallMessage, withStallWatchdog } from "../src/index.ts";

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
