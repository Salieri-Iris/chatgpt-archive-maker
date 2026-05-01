export function createLogger({ quiet = false, verbose = false } = {}) {
  return {
    info(message) {
      if (!quiet) console.log(message);
    },
    warn(message) {
      if (!quiet) console.warn(message);
    },
    debug(message) {
      if (verbose && !quiet) console.log(message);
    }
  };
}
