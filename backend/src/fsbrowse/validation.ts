import path from 'node:path';

// Windows reserved DOS device names. Reserved regardless of extension, so
// `NUL`, `nul`, and `NUL.txt` are all forbidden while boundary names like
// `COM10` / `LPT10` remain allowed. Windows also reserves the superscript-digit
// ports (`COM¹`–`COM³`, `LPT¹`–`LPT³`) and the console handles `CONIN$` /
// `CONOUT$`.
const WIN32_RESERVED_DEVICE_NAME =
  /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;

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
    if (WIN32_RESERVED_DEVICE_NAME.test(folderName)) {
      throw new Error('Folder name is a reserved Windows device name');
    }
  }
  return folderName;
}
