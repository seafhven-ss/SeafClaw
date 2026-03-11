import path from 'node:path';

export interface PathValidation {
  valid: boolean;
  error?: string;
  resolvedPath?: string;
}

/**
 * Validate that a path is:
 * - Relative (not absolute)
 * - Does not escape the project directory (no ../)
 * - Within the allowed project path
 */
export function validateRelativePath(
  inputPath: string,
  projectPath: string
): PathValidation {
  // Reject empty paths
  if (!inputPath || inputPath.trim() === '') {
    return { valid: false, error: 'Path cannot be empty' };
  }

  // Normalize the input
  const trimmed = inputPath.trim();

  // Reject absolute paths (Windows and Unix)
  if (path.isAbsolute(trimmed)) {
    return { valid: false, error: 'Absolute paths are not allowed' };
  }

  // Reject paths starting with drive letters (Windows)
  if (/^[a-zA-Z]:/.test(trimmed)) {
    return { valid: false, error: 'Absolute paths are not allowed' };
  }

  // Reject obvious path traversal attempts
  if (trimmed.includes('..')) {
    return { valid: false, error: 'Path traversal (..) is not allowed' };
  }

  // Resolve the full path
  const resolvedPath = path.resolve(projectPath, trimmed);

  // Normalize both paths for comparison (handle Windows backslashes)
  const normalizedProject = path.normalize(projectPath).toLowerCase();
  const normalizedResolved = path.normalize(resolvedPath).toLowerCase();

  // Ensure resolved path is within project directory
  if (!normalizedResolved.startsWith(normalizedProject)) {
    return { valid: false, error: 'Path escapes project directory' };
  }

  return { valid: true, resolvedPath };
}
