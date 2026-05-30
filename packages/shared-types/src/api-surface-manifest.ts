export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ApiSurfaceRepoSha {
  repo: string;
  sha: string;
}

export interface ApiSurfaceRepoInput {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  worktreePath: string;
  sha: string;
}

export interface ApiSurfaceExtractorContext {
  productId: string;
  repo: ApiSurfaceRepoInput;
  readFile(relativePath: string): Promise<string | null>;
  listFiles(): Promise<string[]>;
}

export interface ApiSurfaceExtractorResult {
  markdown: string;
  data: JsonValue;
}

export interface ApiSurfaceExtractor {
  key: string;
  title: string;
  extract(context: ApiSurfaceExtractorContext): Promise<ApiSurfaceExtractorResult>;
}

export interface ApiSurfaceManifestSection {
  key: string;
  title: string;
  markdown: string;
  data: JsonValue;
}

export interface ApiSurfaceRepoManifest {
  repo: string;
  sha: string;
  sections: ApiSurfaceManifestSection[];
}

export interface ApiSurfaceManifest {
  productId: string;
  builtAt: number;
  repoShas: ApiSurfaceRepoSha[];
  repos: ApiSurfaceRepoManifest[];
}

export interface ApiSurfaceManifestBuildResult {
  markdown: string;
  structured: ApiSurfaceManifest;
}
