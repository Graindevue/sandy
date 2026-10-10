export interface DependencyPlatformPolicy {
  key: string;
  environment: string;
  description: string;
}

/** pnpm 12's JSON environment override works for both fetch and install. */
export function dependencyPlatformPolicy(
  runtimeCommand: string,
): DependencyPlatformPolicy | undefined {
  if (!/^npx --yes pnpm@12\./.test(runtimeCommand)) return undefined;
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  const header = report?.header;
  const libc =
    process.platform === 'linux' ? (header?.glibcVersionRuntime ? 'glibc' : 'musl') : 'none';
  return {
    key: `native-${process.platform}-${process.arch}-${libc}`,
    environment: `pnpm_config_supported_architectures='{"os":["current"],"cpu":["current"],"libc":["current"]}'`,
    description: `Native platform only (${process.platform}/${process.arch}/${libc}); all dependency categories retained. Cross-platform installation is left to repository CI.`,
  };
}
