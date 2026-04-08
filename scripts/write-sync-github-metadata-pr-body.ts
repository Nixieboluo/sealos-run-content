#!/usr/bin/env tsx

import { writeFile } from 'node:fs/promises';

function readRequiredEnv(name: string) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}

	return value;
}

async function main() {
	const outputPath = process.argv[2] ?? 'pr-body.md';
	const matchedGitHubMetadataCount = readRequiredEnv('MATCHED_GITHUB_METADATA_COUNT');
	const matchedGitHubMetadataFiles = readRequiredEnv('MATCHED_GITHUB_METADATA_FILES');
	const otherChangedCount = readRequiredEnv('OTHER_CHANGED_COUNT');
	const otherChangedFiles = readRequiredEnv('OTHER_CHANGED_FILES');

	const body = `## Summary
- sync GitHub repository metadata for appstore templates
- apply biome formatting to generated files

## GitHub Metadata Changes
- matched files: ${matchedGitHubMetadataCount}

\u0000text
${matchedGitHubMetadataFiles}
\u0000

## Other Changes Included
- matched files: ${otherChangedCount}

\u0000text
${otherChangedFiles}
\u0000
`
		.replaceAll('\u0000text', '```text')
		.replaceAll('\u0000', '```');

	await writeFile(outputPath, body, { encoding: 'utf8' });
	console.log(`Wrote PR body to ${outputPath}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
