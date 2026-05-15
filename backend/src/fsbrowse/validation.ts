import path from 'node:path';

export function validateNewFolderName(name: string): string {
  const folderName = name.trim();
  if (!folderName) throw new Error('Folder name is required');
  if (folderName === '.' || folderName === '..') {
    throw new Error('Folder name must not be . or ..');
  }
  if (folderName.includes('/') || folderName.includes('\\') || path.basename(folderName) !== folderName) {
    throw new Error('Folder name must not include path separators');
  }
  if (/\0/.test(folderName)) {
    throw new Error('Folder name must not contain null bytes');
  }
  if (process.platform === 'win32') {
    if (/[<>:"|?*\x00-\x1F]/.test(folderName)) {
      throw new Error('Folder name contains characters Windows does not allow');
    }
    if (/[ .]$/.test(folderName)) {
      throw new Error('Folder name cannot end with a space or period on Windows');
    }
  }
  return folderName;
}
