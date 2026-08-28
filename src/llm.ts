import { SYSTEM_PROMPT, buildUserPrompt, extractVerdictJson } from "./baseline/prompt.ts";
import { config } from "./config.ts";
import { type AccountSignals, Verdict } from "./schema.ts";

interface ChatResponse {
  choices: { message: { content: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const CHAT_TIMEOUT_MS = 30_000;
const CHAT_MAX_ATTEMPTS = 3; // 1 try + 2 retries on 429/5xx/network errors

function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
}

/**
 * One chat-completions HTTP call with a 30s timeout and up to 2 retries with
 * exponential backoff on 429/5xx/network errors. Non-retryable HTTP errors
 * (e.g. 400/401) throw immediately.
 */
async function chat(messages: { role: string; content: string }[]): Promise<ChatResponse> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= CHAT_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await backoff(attempt - 1);
    let res: Response;
    try {
      res = await fetch(`${config.LLM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.LLM_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.LLM_MODEL,
          temperature: 0,
          max_tokens: 600,
          messages,
        }),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });
    } catch (err) {
      lastErr = err; // network error or timeout — retryable
      continue;
    }
    if (res.ok) return (await res.json()) as ChatResponse;
    const detail = `LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
    if (res.status !== 429 && res.status < 500) throw new Error(detail);
    lastErr = new Error(detail);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface ClassifyResult {
  verdict: Verdict;
  usage: ChatResponse["usage"];
}

/** One classification call, with a single self-correcting retry on bad JSON. */
export async function classifyWithLlm(signals: AccountSignals): Promise<ClassifyResult> {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(signals) },
  ];

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await chat(messages);
    const content = resp.choices[0]?.message?.content ?? "";
    try {
      const verdict = Verdict.parse(extractVerdictJson(content));
      return { verdict, usage: resp.usage };
    } catch (err) {
      lastErr = err;
      messages.push(
        { role: "assistant", content },
        {
          role: "user",
          content:
            "That was not valid. Reply with ONLY the JSON object in the exact required shape.",
        },
      );
    }
  }
  throw new Error(`LLM did not return a valid verdict: ${String(lastErr)}`);
}
