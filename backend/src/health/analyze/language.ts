import type { HealthLanguage } from '../types.js';

const LANGUAGE_BY_EXT: Record<string, HealthLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'csharp',
  '.rb': 'ruby',
};

export function languageForExt(ext: string): HealthLanguage {
  return LANGUAGE_BY_EXT[ext] ?? 'fallback';
}
