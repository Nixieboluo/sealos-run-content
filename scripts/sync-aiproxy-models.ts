#!/usr/bin/env tsx

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

type RawModelConfig = {
	max_input_tokens?: number;
	max_output_tokens?: number;
	max_context_tokens?: number;
	vision?: boolean;
	tool_choice?: boolean;
	coder?: boolean;
};

type RawModelPrice = {
	input_price?: number;
	output_price?: number;
};

type RawModel = {
	config?: RawModelConfig;
	model: string;
	owner: string;
	type: number;
	rpm?: number;
	price?: RawModelPrice;
};

const TYPE_MAP = {
	0: 'unknown',
	1: 'chat-completion',
	2: 'text-completion',
	3: 'embedding',
	4: 'moderation',
	5: 'image-generation',
	6: 'text-edit',
	7: 'text-to-speech',
	8: 'speech-to-text',
	9: 'audio-translation',
	10: 'rerank',
	11: 'pdf-parse',
} as const;

const CAPABILITY_KEYS = ['tool_choice', 'vision', 'coder'] as const;

type AiproxyModelType = (typeof TYPE_MAP)[keyof typeof TYPE_MAP];
type ModelCapability = (typeof CAPABILITY_KEYS)[number];

type OutputModel = {
	name: string;
	ownerKey: string;
	type: AiproxyModelType;
	contextSize?: number;
	maxOutputTokens?: number;
	maxInputTokens?: number;
	rpm: number;
	inputPrice: number;
	outputPrice: number;
	capabilities: ModelCapability[];
};

function slugify(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function normalizePositiveNumber(value: number | undefined) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.trunc(value);
}

function normalizePrice(value: number | undefined) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
	return value;
}

function mapType(type: number): AiproxyModelType {
	return TYPE_MAP[type as keyof typeof TYPE_MAP] ?? 'unknown';
}

function mapCapabilities(config: RawModelConfig | undefined) {
	if (!config) return [];

	return CAPABILITY_KEYS.filter((key) => config[key] === true);
}

function mapModel(model: RawModel): OutputModel {
	return {
		name: model.model,
		ownerKey: model.owner || 'unknown',
		type: mapType(model.type),
		contextSize: normalizePositiveNumber(model.config?.max_context_tokens),
		maxOutputTokens: normalizePositiveNumber(model.config?.max_output_tokens),
		maxInputTokens: normalizePositiveNumber(model.config?.max_input_tokens),
		rpm: normalizePositiveNumber(model.rpm) ?? 0,
		inputPrice: normalizePrice(model.price?.input_price),
		outputPrice: normalizePrice(model.price?.output_price),
		capabilities: mapCapabilities(model.config),
	};
}

async function readRawModels(inputPath: string) {
	const source = await readFile(inputPath, { encoding: 'utf8' });
	const parsed = JSON.parse(source) as RawModel[];

	if (!Array.isArray(parsed)) {
		throw new Error('AIProxy raw model config must be an array');
	}

	return parsed;
}

async function writeModelFiles(outputDir: string, models: OutputModel[]) {
	await rm(outputDir, { force: true, recursive: true });
	await mkdir(outputDir, { recursive: true });

	const seen = new Set<string>();

	for (const model of models) {
		const filename = `${slugify(model.name)}.json`;
		if (!filename || filename === '.json') {
			throw new Error(`failed to generate filename for model: ${model.name}`);
		}

		if (seen.has(filename)) {
			throw new Error(`duplicate output filename detected: ${filename}`);
		}

		seen.add(filename);

		const outputPath = path.join(outputDir, filename);
		await writeFile(
			outputPath,
			`${JSON.stringify(model, null, '\t')}
`,
			{
				encoding: 'utf8',
			},
		);
	}

	return seen.size;
}

async function main() {
	const workspaceRoot = process.cwd();
	const inputPath = path.join(workspaceRoot, 'config', 'aiproxy-models.json');
	const outputDir = path.join(workspaceRoot, 'content', 'aiproxy-models');
	const rawModels = await readRawModels(inputPath);
	const mappedModels = rawModels.map(mapModel).sort((a, b) => a.name.localeCompare(b.name));
	const writtenCount = await writeModelFiles(outputDir, mappedModels);

	console.log(`generated ${writtenCount} AIProxy model files in ${outputDir}`);
	console.log(`read ${rawModels.length} raw models from ${inputPath}`);
	console.log('AIProxy model content sync completed.');
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
