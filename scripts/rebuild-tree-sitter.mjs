import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();

if (existsSync('node_modules/tree-sitter')) {
  for (const packageName of ['tree-sitter', 'tree-sitter-javascript', 'tree-sitter-typescript']) {
    const packagePath = join('node_modules', packageName);
    if (!existsSync(packagePath)) {
      continue;
    }

    rmSync(join(packagePath, 'build'), { recursive: true, force: true });
    const result = spawnSync(nodeGypBin(), ['rebuild'], {
      cwd: packagePath,
      stdio: 'inherit',
      env: {
        ...process.env,
        CXXFLAGS: withCpp20(process.env.CXXFLAGS),
      },
    });

    if (result.error !== undefined) {
      process.stderr.write(`${packageName} rebuild failed: ${result.error.message}\n`);
      process.exitCode = 1;
      break;
    }
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
}

function nodeGypBin() {
  return join(
    repoRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'node-gyp.cmd' : 'node-gyp',
  );
}

function withCpp20(value) {
  if (value?.includes('-std=c++20')) {
    return value;
  }
  return value === undefined || value.trim().length === 0 ? '-std=c++20' : `${value} -std=c++20`;
}
