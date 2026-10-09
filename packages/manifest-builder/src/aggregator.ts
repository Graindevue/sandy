import type {
  ApiSurfaceExtractor,
  ApiSurfaceManifest,
  ApiSurfaceManifestBuildResult,
  ApiSurfaceManifestSection,
  ApiSurfaceRepoInput,
  ApiSurfaceRepoManifest,
} from '@sandy/shared-types';
import { createRepoFileSnapshot } from './fs-utils.js';
import { code } from './markdown.js';

export async function aggregateManifest(input: {
  productId: string;
  repos: ApiSurfaceRepoInput[];
  extractors: ApiSurfaceExtractor[];
  builtAt: number;
}): Promise<ApiSurfaceManifestBuildResult> {
  const repos = await Promise.all(
    input.repos.map(async (repo): Promise<ApiSurfaceRepoManifest> => {
      const snapshot = await createRepoFileSnapshot(repo.worktreePath, repo.sha);
      const context = {
        productId: input.productId,
        repo,
        readFile: (relativePath: string) => snapshot.readText(relativePath),
        listFiles: async () => snapshot.listFiles(),
      };
      const sections = await Promise.all(
        input.extractors.map(async (extractor): Promise<ApiSurfaceManifestSection> => {
          const result = await extractor.extract(context);
          return {
            key: extractor.key,
            title: extractor.title,
            markdown: normalizeSectionMarkdown(result.markdown),
            data: result.data,
          };
        }),
      );
      return { repo: repo.fullName, sha: repo.sha, sections };
    }),
  );

  const structured: ApiSurfaceManifest = {
    productId: input.productId,
    builtAt: input.builtAt,
    repoShas: input.repos.map((repo) => ({ repo: repo.fullName, sha: repo.sha })),
    repos,
  };

  return { structured, markdown: renderManifest(structured) };
}

function renderManifest(manifest: ApiSurfaceManifest): string {
  const lines = [
    '# API Surface Manifest',
    '',
    `Product: ${code(manifest.productId)}`,
    `Built: ${code(new Date(manifest.builtAt).toISOString())}`,
    '',
    'This manifest lists public API surface and framework versions only. Use it as a trigger for Cross-Repo Search; it does not enumerate callers.',
    '',
    '## Repos',
    '',
    ...manifest.repoShas.map((repo) => `- ${code(repo.repo)} @ ${code(repo.sha)}`),
  ];

  for (const repo of manifest.repos) {
    lines.push('', `## ${repo.repo} @ ${repo.sha}`, '');
    for (const section of repo.sections) {
      lines.push(`### ${section.title}`, '', section.markdown, '');
    }
  }

  return `${lines
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

function normalizeSectionMarkdown(markdown: string): string {
  const trimmed = markdown.trim();
  return trimmed.length === 0 ? 'None detected.' : trimmed;
}
