// 模型流停摆看门狗。
//
// 解决的问题：provider 的流式响应会出现「连接还活着但长时间不出内容」的停摆。
// Claude Code 的字节级 watchdog 只看有没有字节，SSE 保活会把它的计时器重置；
// pi-ai 这边除 openai-codex-responses 外没有流级停摆检测。两边都不放弃，用户
// 只能按 ESC 再说「继续」。
//
// 做法：包装 provider 的 streamSimple / stream。每收到一个流事件就重置计时器，
// 超过 stallMs 没有任何事件就中断底层请求，并向上发一条 stopReason="error"、
// errorMessage 含 "timeout" 的消息。该文本命中 pi-ai 的
// RETRYABLE_PROVIDER_ERROR_PATTERN，Pi 自带的 auto-retry（settings.retry，默认
// 3 次、2s/4s/8s 退避）会重发这一轮，并把这条错误消息从 agent state 里移除。
//
// 为什么不发 aborted：pi-ai 的 retryAssistantCall 永远不重试 stopReason
// 为 "aborted" 的消息，发 aborted 只会停在那里等用户。
//
// 中断走派生的 AbortController，所以 provider 自己的中断清理照常跑。对
// claude-bridge 而言这条路和用户按 ESC 完全一样：它会标记 CC 会话需要重建，
// 下一次调用从 Pi 的历史重建。代价是丢一次 prompt cache，所以阈值要保守。
//
// 配置：
//   PI_STALL_WATCHDOG_MS     无事件多少毫秒判定停摆，默认 120000，设 0 关闭
//   PI_STALL_WATCHDOG_DEBUG  设为 1 时把包装和触发记录到
//                            ~/.pi/agent/stall-watchdog.log

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_STALL_MS = 120_000;
const WRAPPED = Symbol.for("pi-stall-watchdog:wrapped");
const LOG_PATH = join(homedir(), ".pi", "agent", "stall-watchdog.log");

// 流函数的结构类型。provider 的签名是 (model, context, options?) => AssistantMessageEventStream，
// 这里只需要能原样转发，不需要精确到 pi-ai 的泛型。
type StreamFn = (model: any, context: any, options?: any) => any;

function parseMs(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") return DEFAULT_STALL_MS;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) return DEFAULT_STALL_MS;
	return value;
}

export const stallMs = parseMs(process.env.PI_STALL_WATCHDOG_MS);
const debugEnabled = process.env.PI_STALL_WATCHDOG_DEBUG === "1";

function log(line: string): void {
	if (!debugEnabled) return;
	try {
		appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
	} catch {
		// 日志写不进去不影响主流程
	}
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 停摆时交给 Pi 的 assistant 消息。以流里最后一次 partial 为底，保住已收到的
 *  内容和用量；没有 partial 就按 model 现造一条空的。 */
export function buildStallMessage(model: any, lastPartial: any, timeoutMs: number): any {
	const seconds = Math.round(timeoutMs / 1000);
	const base = lastPartial ?? {
		role: "assistant",
		content: [],
		api: model?.api,
		provider: model?.provider,
		model: model?.id,
		usage: EMPTY_USAGE,
	};
	return {
		...base,
		role: "assistant",
		content: Array.isArray(base.content) ? [...base.content] : [],
		stopReason: "error",
		// "timeout" 这个词是 pi-ai 判定可重试的依据，改文案时必须保留。
		errorMessage: `Provider stream timeout: no stream events for ${seconds}s (pi stall watchdog)`,
		timestamp: Date.now(),
	};
}

/** 给一个流函数套上停摆看门狗。返回的函数签名与入参一致。 */
export function withStallWatchdog(inner: StreamFn, label: string, timeoutMs: number = stallMs): StreamFn {
	if (timeoutMs <= 0) return inner;

	const wrapped: StreamFn = (model, context, options) => {
		// deferred 请求本来就是「先拿句柄、之后再取结果」，长时间没有事件是正常的。
		if (options?.deferred) return inner(model, context, options);

		const out = createAssistantMessageEventStream();
		const controller = new AbortController();
		const caller: AbortSignal | undefined = options?.signal;
		const onCallerAbort = () => controller.abort(caller?.reason);
		if (caller) {
			if (caller.aborted) controller.abort(caller.reason);
			else caller.addEventListener("abort", onCallerAbort, { once: true });
		}

		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		let lastPartial: any;

		const cleanup = () => {
			if (timer) clearTimeout(timer);
			timer = undefined;
			caller?.removeEventListener("abort", onCallerAbort);
		};

		const fire = () => {
			if (settled) return;
			settled = true;
			cleanup();
			const message = buildStallMessage(model, lastPartial, timeoutMs);
			log(`fired ${label}: ${message.errorMessage}`);
			// 先中断底层，让 provider 自己的清理跑起来，再把错误交给 Pi 重试。
			controller.abort(new Error(message.errorMessage));
			out.push({ type: "error", reason: "error", error: message });
			out.end();
		};

		const arm = () => {
			if (settled) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(fire, timeoutMs);
			// 看门狗不该让进程活着等它
			(timer as { unref?: () => void }).unref?.();
		};

		arm();

		void (async () => {
			try {
				const source = inner(model, context, { ...(options ?? {}), signal: controller.signal });
				for await (const event of source) {
					// 看门狗已经收尾，后面的事件（包括 provider 自己的 abort 回执）丢掉。
					if (settled) return;
					if (event?.partial !== undefined) lastPartial = event.partial;
					else if (event?.type === "done") lastPartial = event.message;
					else if (event?.type === "error") lastPartial = event.error;

					out.push(event);

					if (event?.type === "done" || event?.type === "error") {
						settled = true;
						cleanup();
						out.end();
						return;
					}
					arm();
				}
				// 底层流没给终态就结束了：按原样收尾，交给 Pi 既有的处理。
				if (!settled) {
					settled = true;
					cleanup();
					out.end();
				}
			} catch (error) {
				if (settled) return;
				settled = true;
				cleanup();
				// 底层抛异常时保持原有语义：原样抛给消费者，不伪装成停摆。
				const failure = {
					...buildStallMessage(model, lastPartial, timeoutMs),
					errorMessage: error instanceof Error ? error.message : String(error),
				};
				out.push({ type: "error", reason: "error", error: failure });
				out.end();
			}
		})();

		return out;
	};

	(wrapped as Record<symbol, unknown>)[WRAPPED] = true;
	return wrapped;
}

function isWrapped(ctx: ExtensionContext, providerId: string | undefined): boolean {
	if (!providerId) return false;
	const provider = (ctx as any)?.modelRegistry?.getProvider?.(providerId);
	const fn = provider?.streamSimple;
	return typeof fn === "function" && Boolean((fn as Record<symbol, unknown>)[WRAPPED]);
}

/** 给某个 provider 的流函数就地套上看门狗。幂等：已包装过的不再包。 */
function patchProvider(ctx: ExtensionContext, providerId: string | undefined): void {
	if (!providerId || stallMs <= 0) return;
	let provider: Record<string, unknown> | undefined;
	try {
		provider = (ctx as any)?.modelRegistry?.getProvider?.(providerId);
	} catch (error) {
		log(`getProvider(${providerId}) threw: ${String(error)}`);
		return;
	}
	if (!provider) return;

	for (const key of ["streamSimple", "stream"] as const) {
		const fn = provider[key];
		if (typeof fn !== "function") continue;
		if ((fn as Record<symbol, unknown>)[WRAPPED]) continue;
		try {
			provider[key] = withStallWatchdog((fn as StreamFn).bind(provider), `${providerId}.${key}`);
			log(`wrapped ${providerId}.${key} (stallMs=${stallMs})`);
		} catch (error) {
			// provider 对象被冻结等情况：放弃包装，不影响正常使用
			log(`wrap ${providerId}.${key} failed: ${String(error)}`);
		}
	}
}

export default function (pi: ExtensionAPI) {
	if (stallMs <= 0) return;

	// session_start 覆盖开局；turn_start 覆盖 registry 重建 provider 的情况；
	// model_select 覆盖换模型后换了 provider。三处都是幂等的。
	const patchActive = (_event: unknown, ctx: ExtensionContext) => {
		patchProvider(ctx, ctx.model?.provider);
	};

	pi.on("session_start", patchActive);
	pi.on("turn_start", patchActive);
	pi.on("model_select", (event: { model?: { provider?: string } }, ctx: ExtensionContext) => {
		patchProvider(ctx, event.model?.provider ?? ctx.model?.provider);
	});

	// 包装依赖 ModelRuntime 每次请求都从 registry 取 provider 对象。若 Pi 改了这个
	// 解析方式，包装会静默失效、卡死照旧。这个命令让失效当场可查，不用等复现。
	pi.registerCommand("stall-watchdog", {
		description: "查看模型流停摆看门狗的阈值与当前 provider 是否已挂上",
		handler: async (_args: unknown, ctx: ExtensionContext) => {
			const providerId = ctx.model?.provider;
			const state = isWrapped(ctx, providerId) ? "已挂上" : "未挂上";
			const text = `停摆看门狗：阈值 ${Math.round(stallMs / 1000)}s，provider ${providerId ?? "(无)"} ${state}`;
			log(`status: ${text}`);
			ctx.ui.notify(text, "info");
		},
	});
}
