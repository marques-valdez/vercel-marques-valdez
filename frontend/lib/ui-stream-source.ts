import fs from 'node:fs';
import path from 'node:path';

export function loadUiStreamSource(): string {
  const candidates = [
    path.resolve(process.cwd(), '..', 'backend', 'app', 'ui_stream.py'),
    path.resolve(process.cwd(), 'backend', 'app', 'ui_stream.py'),
  ];

  for (const candidatePath of candidates) {
    try {
      if (fs.existsSync(candidatePath)) {
        return fs.readFileSync(candidatePath, 'utf8');
      }
    } catch {
      // Try next candidate path
    }
  }

  return '# backend/app/ui_stream.py will load automatically when available.\n';
}
