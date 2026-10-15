import { stat } from 'fs/promises'
import { delimiter, join, resolve } from 'path'

/** Locate a nonstandard Git for Windows install from PATH, without executing it. */
export async function findGitBashFromPath(pathValue = process.env.PATH || ''): Promise<string | null> {
  for (const part of pathValue.split(delimiter)) {
    const directory = part.trim().replace(/^"|"$/g, '')
    if (!directory) continue
    try {
      if (!(await stat(join(directory, 'git.exe'))).isFile()) continue
    } catch { continue }
    const candidates = [
      resolve(directory, '..', 'bin', 'bash.exe'),
      resolve(directory, '..', 'usr', 'bin', 'bash.exe'),
      resolve(directory, '..', '..', 'usr', 'bin', 'bash.exe'),
    ]
    for (const candidate of candidates) {
      if (await isUsableGitBashPath(candidate)) return candidate
    }
  }
  return null
}

/**
 * Basic file-name validation for Git Bash executable paths.
 * Accepts Windows-style and POSIX-style separators to support cross-platform tests.
 */
export function isGitBashExecutablePath(filePath: string): boolean {
  return /(?:^|[\\/])bash\.exe$/i.test(filePath.trim())
}

/**
 * Validate a user-provided Git Bash executable path.
 * Enforces bash.exe filename and existence on disk.
 */
export async function validateGitBashPath(filePath: string): Promise<{ valid: true; path: string } | { valid: false; error: string }> {
  const trimmedPath = filePath.trim()

  if (!isGitBashExecutablePath(trimmedPath)) {
    return { valid: false, error: 'Path must point to bash.exe' }
  }

  try {
    const info = await stat(trimmedPath)
    if (!info.isFile()) {
      return { valid: false, error: 'Path must point to a file' }
    }
    return { valid: true, path: trimmedPath }
  } catch {
    return { valid: false, error: 'File does not exist at the specified path' }
  }
}

/**
 * Check if a Git Bash path is usable without returning UI-facing errors.
 */
export async function isUsableGitBashPath(filePath: string): Promise<boolean> {
  const result = await validateGitBashPath(filePath)
  return result.valid
}
