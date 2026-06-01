#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';

const localRequire = createRequire(import.meta.url);

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const languageName = options.language ?? languageFromPath(options.file);
  if (languageName === undefined) {
    throw new Error(`Could not infer language for ${options.file}; pass --language <name>.`);
  }

  const Parser = requireModule('tree-sitter');
  const language = loadLanguage(languageName);
  const source = await readFile(options.file, 'utf8');
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  const query = new Parser.Query(language, options.query);
  const matches = query.matches(tree.rootNode).map((match) => ({
    pattern: match.pattern,
    captures: match.captures.map(({ name, node }) => ({
      name,
      text: node.text,
      start: position(node.startPosition),
      end: position(node.endPosition),
    })),
  }));

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          file: options.file,
          language: languageName,
          query: options.query,
          matches,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  for (const match of matches) {
    for (const capture of match.captures) {
      process.stdout.write(
        `${options.file}:${capture.start.line}:${capture.start.column + 1} ${capture.name} ${JSON.stringify(capture.text)}\n`,
      );
    }
  }
}

function parseArgs(args) {
  let json = false;
  let language;
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--language' || arg === '-l') {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error(`${arg} requires a language value.`);
      }
      language = value;
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    positional.push(arg);
  }

  if (positional.length !== 2) {
    printHelp();
    throw new Error('Expected: tree_sitter_query [--json] [--language <name>] <file> <query>');
  }

  return { json, language, file: positional[0], query: positional[1] };
}

function printHelp() {
  process.stdout.write(`Usage: tree_sitter_query [--json] [--language <name>] <file> <query>

Runs a tree-sitter query against one source file and prints structural captures.
Supported languages: javascript, jsx, typescript, tsx.
`);
}

function languageFromPath(file) {
  switch (extname(file).toLowerCase()) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.jsx':
      return 'jsx';
    case '.ts':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.tsx':
      return 'tsx';
    default:
      return undefined;
  }
}

function loadLanguage(name) {
  switch (name.toLowerCase()) {
    case 'javascript':
    case 'jsx':
      return requireModule('tree-sitter-javascript');
    case 'typescript':
    case 'ts':
      return requireModule('tree-sitter-typescript').typescript;
    case 'tsx':
      return requireModule('tree-sitter-typescript').tsx;
    default:
      throw new Error(`Unsupported language ${JSON.stringify(name)}.`);
  }
}

function requireModule(name) {
  try {
    return localRequire(name);
  } catch (localError) {
    for (const root of globalModuleRoots()) {
      try {
        return createRequire(join(root, 'noop.js'))(name);
      } catch {
        // Try the next global module root.
      }
    }
    throw localError;
  }
}

function globalModuleRoots() {
  const roots = [];
  if (process.env.NODE_PATH !== undefined) {
    roots.push(...process.env.NODE_PATH.split(':').filter(Boolean));
  }
  roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules');
  roots.push(join(dirname(process.execPath), '..', 'lib', 'node_modules'));
  return roots;
}

function position(treeSitterPosition) {
  return {
    line: treeSitterPosition.row + 1,
    column: treeSitterPosition.column,
  };
}
