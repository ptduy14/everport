export type Style = 'red' | 'green' | 'yellow' | 'dim';
export type Paint = (text: string, style: Style) => string;

const CODES: Record<Style, number> = { red: 31, green: 32, yellow: 33, dim: 2 };

export const plain: Paint = (text) => text;
export const ansi: Paint = (text, style) => `\x1b[${CODES[style]}m${text}\x1b[0m`;

/** Colour only for a person at a terminal: never when piped, nor with NO_COLOR set (https://no-color.org). */
export const useColor = (isTty: boolean | undefined, env: NodeJS.ProcessEnv): boolean =>
  !!isTty && !env['NO_COLOR'] && env['TERM'] !== 'dumb';

/** "Run x." → "run x." so it reads after "Fix:"; leaves acronyms and names alone. */
export const lowerFirst = (s: string): string => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);
