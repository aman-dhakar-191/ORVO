/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { normalizeOpenAICompatibleBaseUrl, resolveOpenAICompatibleModelCapabilities } from '../openAICompatibleProvider';

describe('OpenAI compatible provider', () => {

	it('normalizes base URLs', () => {
		expect([
			normalizeOpenAICompatibleBaseUrl('http://localhost:20128'),
			normalizeOpenAICompatibleBaseUrl('http://localhost:20128/v1/'),
			normalizeOpenAICompatibleBaseUrl(' https://gateway.example.com/api/v1/chat/completions '),
			normalizeOpenAICompatibleBaseUrl('https://gateway.example.com/openai/v1/models'),
			normalizeOpenAICompatibleBaseUrl('https://gateway.example.com/v1beta'),
			normalizeOpenAICompatibleBaseUrl(''),
			normalizeOpenAICompatibleBaseUrl('not a url'),
			normalizeOpenAICompatibleBaseUrl('file:///etc/passwd'),
		]).toEqual([
			'http://localhost:20128/v1',
			'http://localhost:20128/v1',
			'https://gateway.example.com/api/v1',
			'https://gateway.example.com/openai/v1',
			'https://gateway.example.com/v1beta',
			undefined,
			undefined,
			undefined,
		]);
	});

	it('uses defaults when /models reports only ids (OpenAI style)', () => {
		expect(resolveOpenAICompatibleModelCapabilities({ id: 'gpt-4.1', object: 'model', owned_by: 'openai' })).toEqual({
			name: 'gpt-4.1',
			toolCalling: true,
			vision: false,
			contextWindow: 128_000,
			maxInputTokens: 112_000,
			maxOutputTokens: 16_000,
		});
	});

	it('reads OpenRouter-style and vLLM-style metadata', () => {
		expect(resolveOpenAICompatibleModelCapabilities({
			id: 'cc/claude-sonnet-4', name: 'Claude Sonnet 4', context_length: 200_000,
			top_provider: { max_completion_tokens: 64_000 }, supported_parameters: ['tools', 'reasoning'],
			architecture: { input_modalities: ['text', 'image'] },
		})).toMatchObject({ name: 'Claude Sonnet 4', toolCalling: true, vision: true, contextWindow: 200_000, maxOutputTokens: 64_000, maxInputTokens: 136_000 });

		expect(resolveOpenAICompatibleModelCapabilities({ id: 'qwen3', max_model_len: 32_768, supported_parameters: ['temperature'] }))
			.toMatchObject({ toolCalling: false, contextWindow: 32_768, maxOutputTokens: 16_000, maxInputTokens: 16_768 });
	});

	it('skips models that cannot chat', () => {
		for (const model of [
			{ id: 'text-embedding-3-large' }, { id: 'whisper-1' }, { id: 'tts-1-hd' }, { id: 'dall-e-3' },
			{ id: 'omni-moderation-latest' }, { id: 'bge-reranker' }, { id: 'nomic', type: 'embedding' }, { id: '' }, null,
		]) {
			expect(resolveOpenAICompatibleModelCapabilities(model)).toBeUndefined();
		}
	});
});
