import path from 'node:path';
import { normalizeOutputPath, resolveExistingInputPath } from './path-utils.mjs';

export function createRunContext(options) {
  const inputPath = resolveExistingInputPath(options.input);
  const outputPath = normalizeOutputPath(options.output, inputPath);
  const reportDir = options.reportDir ? path.resolve(options.reportDir) : path.join(outputPath, '_build', 'reports');

  return {
    inputPath,
    outputPath,
    reportDir,
    timezone: options.timezone,
    force: options.force,
    open: options.open,
    dryRun: options.dryRun,
    configPath: options.config ? path.resolve(options.config) : null,
    compareReferencePath: options.compareReference ? path.resolve(options.compareReference) : null
  };
}
