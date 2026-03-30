/**
 * LLM Providers — Thin fetch() wrappers for Gemini, Anthropic, Ollama
 * ====================================================================
 *
 * Zero daemon imports. Pure HTTP calls.
 */

import { join } from 'path';
import type { LLMCallFn, ImproveConfig } from './types.js';
import { createClaudeProvider } from '../campaign/claude-brain.js';
import { createClaudeCodeFileProvider } from '../campaign/claude-code-brain.js';

// ---------------------------------------------------------------------------
// RETRY WRAPPER — exponential backoff for transient API failures
// ---------------------------------------------------------------------------

function withRetry(fn: LLMCallFn, maxRetries = 3): LLMCallFn {
  return async (systemPrompt, userPrompt) => {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn(systemPrompt, userPrompt);
      } catch (err: any) {
        lastError = err;
        const status = parseInt(err.message?.match(/error (\d+)/)?.[1] ?? '0');
        const isRetryable = status === 429 || status === 500 || status === 502
          || status === 503 || status === 529
          || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT'
          || err.code === 'UND_ERR_CONNECT_TIMEOUT'
          || err.message?.includes('fetch failed');

        if (!isRetryable || attempt === maxRetries) {
          throw err;
        }

        // Exponential backoff: 2s, 4s, 8s (with jitter)
        const delayMs = (2 ** (attempt + 1)) * 1000 + Math.random() * 1000;
        const retryIn = (delayMs / 1000).toFixed(1);
        console.log(`        [LLM RETRY] Attempt ${attempt + 1}/${maxRetries} failed (${status || err.code || 'network'}), retrying in ${retryIn}s...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    throw lastError!;
  };
}

export function createLLMProvider(config: ImproveConfig): LLMCallFn | null {
  switch (config.llm) {
    case 'gemini':
      if (!config.apiKey) throw new Error('Gemini requires --api-key');
      return withRetry(createGeminiProvider(config.apiKey));
    case 'anthropic':
      if (!config.apiKey) throw new Error('Anthropic requires --api-key');
      return withRetry(createAnthropicProvider(config.apiKey));
    case 'claude':
      if (!config.apiKey) throw new Error('Claude requires --api-key (ANTHROPIC_API_KEY)');
      return withRetry(createClaudeProvider(config.apiKey, { model: config.claudeModel }));
    case 'claude-code': {
      // Claude Code IS the LLM — exchange via filesystem, no retry needed
      const exchangeDir = join(import.meta.dir, '../../.verify');
      return createClaudeCodeFileProvider(exchangeDir);
    }
    case 'ollama':
      return withRetry(createOllamaProvider(config.ollamaHost ?? 'http://localhost:11434', config.ollamaModel ?? 'qwen3:4b'));
    case 'none':
      return null;
  }
}

function createGeminiProvider(apiKey: string): LLMCallFn {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  return async (systemPrompt, userPrompt) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 65536, thinkingConfig: { thinkingBudget: 8192 } },
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Gemini API error ${resp.status}: ${body.substring(0, 200)}`);
    }

    const data = await resp.json() as any;
    // Gemini 2.5 Flash thinking models return thought + text in parts
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const textParts = parts
      .filter((p: any) => p.text && !p.thought)
      .map((p: any) => p.text)
      .join('');
    const text = textParts || (parts?.[0]?.text ?? '');
    const finishReason = data.candidates?.[0]?.finishReason;
    if (finishReason === 'MAX_TOKENS') {
      console.log('        [LLM WARN] Gemini response truncated (MAX_TOKENS)');
    }
    const usage = data.usageMetadata ?? {};
    return {
      text,
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
    };
  };
}

function createAnthropicProvider(apiKey: string): LLMCallFn {
  return async (systemPrompt, userPrompt) => {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        temperature: 0.2,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Anthropic API error ${resp.status}: ${body.substring(0, 200)}`);
    }

    const data = await resp.json() as any;
    const text = data.content?.map((c: any) => c.text).join('') ?? '';
    return {
      text,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    };
  };
}

function createOllamaProvider(host: string, model: string): LLMCallFn {
  return async (systemPrompt, userPrompt) => {
    const resp = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        prompt: userPrompt,
        stream: false,
        options: { temperature: 0.2 },
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Ollama API error ${resp.status}: ${body.substring(0, 200)}`);
    }

    const data = await resp.json() as any;
    return {
      text: data.response ?? '',
      inputTokens: data.prompt_eval_count ?? 0,
      outputTokens: data.eval_count ?? 0,
    };
  };
}
