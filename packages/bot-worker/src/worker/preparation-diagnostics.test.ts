import { describe, expect, it } from 'vitest';
import { preparationDiagnostic, preparationDiagnosticMarkdown } from './preparation-diagnostics.js';

describe('preparation diagnostics', () => {
  it('retains the command failure while removing credentials and terminal control text', () => {
    const error = new Error(
      '\u001b[31mUnknown option: frozen-lockfile\u001b[0m\nhttps://user:private@registry.test/path?sig=signature\nBearer bearer-value\n"token": "json secret"\nNPM_TOKEN=assignment-secret\nghp_exampleToken',
    );
    const diagnostic = preparationDiagnostic(error);
    expect(diagnostic).toContain('Unknown option: frozen-lockfile');
    expect(diagnostic).not.toMatch(
      /private|signature|bearer-value|json secret|assignment-secret|exampleToken/,
    );
  });

  it('bounds output while preserving both startup and final failure details', () => {
    const result = preparationDiagnostic(`startup error ${'detail '.repeat(2000)}final failure`);
    expect(result.length).toBeLessThanOrEqual(1800);
    expect(result).toContain('startup error');
    expect(result).toContain('final failure');
    expect(result).toContain('[output truncated]');
  });

  it('prevents reviewed output from creating Markdown links or mentions in the review summary', () => {
    const result = preparationDiagnosticMarkdown('[click](https://test.invalid) <script> @someone');
    expect(result).toContain('\\[click\\]');
    expect(result).toContain('\\<script\\>');
    expect(result).not.toContain('@someone');
  });
});
