/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKModelCapabilities } from '../common/byokProvider';
import { AbstractOpenAICompatibleLMProvider, LanguageModelChatConfiguration } from './abstractLanguageModelChatProvider';
import { IBYOKStorageService } from './byokStorageService';

export interface OpenAICompatibleProviderConfig extends LanguageModelChatConfiguration {
	/** Base URL of the OpenAI-compatible API, e.g. `http://localhost:20128/v1` (OmniRoute, 9router, LiteLLM, vLLM, LM Studio). */
	readonly baseUrl?: string;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

/** Model ids that `/models` lists but that cannot chat (embeddings, speech, images, moderation, rerankers). */
const NON_CHAT_MODEL_PATTERN = /(embed|whisper|tts|dall-e|moderation|rerank|transcri|text-to-speech|speech-to-text|image-gen|gpt-image)/i;

/**
 * Normalizes a user-entered base URL: trims it, drops trailing slashes and a pasted `/chat/completions` or
 * `/models` suffix, and adds `/v1` when the URL has no version segment (`http://localhost:20128` becomes
 * `http://localhost:20128/v1`).
 */
export function normalizeOpenAICompatibleBaseUrl(baseUrl: string): string | undefined {
	let url = baseUrl.trim().replace(/\/+$/, '').replace(/\/(chat\/completions|responses|models)$/, '');
	if (!url) {
		return undefined;
	}
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return undefined;
		}
	} catch {
		return undefined;
	}
	if (!/\/v\d+[a-z0-9]*$/i.test(url)) {
		url = `${url}/v1`;
	}
	return url;
}

function firstNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
			return value;
		}
	}
	return undefined;
}

/**
 * Capabilities for one entry of an OpenAI-compatible `GET /models` response. Gateways report very different
 * fields (OpenAI: none, OpenRouter-style: `context_length` and `supported_parameters`, vLLM: `max_model_len`),
 * so this reads what is there and falls back to defaults that suit current chat models.
 * Returns `undefined` for models that cannot chat.
 */
export function resolveOpenAICompatibleModelCapabilities(modelData: unknown): BYOKModelCapabilities | undefined {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const model = modelData as any;
	if (!model || typeof model.id !== 'string' || !model.id) {
		return undefined;
	}
	const type = typeof model.type === 'string' ? model.type.toLowerCase() : undefined;
	if ((type && type !== 'chat' && type !== 'model' && type !== 'llm') || NON_CHAT_MODEL_PATTERN.test(model.id)) {
		return undefined;
	}

	const contextWindow = firstNumber(model.context_length, model.context_window, model.max_model_len, model.max_context_length,
		model.top_provider?.context_length, model.limits?.context) ?? DEFAULT_CONTEXT_WINDOW;
	const requestedMaxOutputTokens = firstNumber(model.max_completion_tokens, model.max_output_tokens,
		model.top_provider?.max_completion_tokens, model.limits?.output) ?? DEFAULT_MAX_OUTPUT_TOKENS;
	const maxOutputTokens = Math.min(requestedMaxOutputTokens, Math.floor(contextWindow / 2));

	const supportedParameters: unknown = model.supported_parameters;
	const inputModalities: unknown = model.architecture?.input_modalities ?? model.input_modalities ?? model.modalities;
	const toolCalling = Array.isArray(supportedParameters)
		? supportedParameters.includes('tools')
		: model.capabilities?.tool_calling ?? model.capabilities?.function_calling ?? true;
	const vision = Array.isArray(inputModalities)
		? inputModalities.includes('image')
		: !!(model.capabilities?.vision ?? false);

	return {
		name: typeof model.name === 'string' && model.name ? model.name : model.id,
		toolCalling: !!toolCalling,
		vision,
		contextWindow,
		maxInputTokens: contextWindow - maxOutputTokens,
		maxOutputTokens,
	};
}

/**
 * Any OpenAI-compatible API (OmniRoute, 9router, LiteLLM, vLLM, LM Studio, ...) from a base URL and API key.
 * Unlike the Custom Endpoint provider, models are discovered from `GET {baseUrl}/models` instead of being listed
 * by hand. Each configured group is one gateway.
 */
export class OpenAICompatibleLMProvider extends AbstractOpenAICompatibleLMProvider<OpenAICompatibleProviderConfig> {

	public static readonly providerName = 'OpenAICompatible';
	public static readonly providerId = this.providerName.toLowerCase();

	constructor(
		byokStorageService: IBYOKStorageService,
		@IFetcherService fetcherService: IFetcherService,
		@ILogService logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService
	) {
		super(
			OpenAICompatibleLMProvider.providerId,
			OpenAICompatibleLMProvider.providerName,
			undefined,
			byokStorageService,
			fetcherService,
			logService,
			instantiationService,
			configurationService,
			expService
		);
	}

	protected override getModelsBaseUrl(configuration: OpenAICompatibleProviderConfig | undefined): string | undefined {
		return configuration?.baseUrl ? normalizeOpenAICompatibleBaseUrl(configuration.baseUrl) : undefined;
	}

	protected override resolveModelCapabilities(modelData: unknown): BYOKModelCapabilities | undefined {
		return resolveOpenAICompatibleModelCapabilities(modelData);
	}
}
