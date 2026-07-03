/**
 * Main entry point for @cpdevtools/ts-dev-utilities
 * Re-exports common utilities for convenience
 */

// Re-export globby for file searching
export { globby, type Options as GlobbyOptions } from 'globby';

// Re-export change-case for string formatting
export * as changeCase from 'change-case';
