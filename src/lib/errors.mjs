export class UsageError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = exitCode;
  }
}

export class InputError extends Error {
  constructor(message, exitCode = 3) {
    super(message);
    this.name = 'InputError';
    this.exitCode = exitCode;
  }
}

export class GenerationError extends Error {
  constructor(message, exitCode = 4) {
    super(message);
    this.name = 'GenerationError';
    this.exitCode = exitCode;
  }
}
