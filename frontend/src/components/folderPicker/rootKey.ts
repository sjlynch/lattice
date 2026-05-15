export function rootKey(folderPath: string): string {
  const winDrive = folderPath.match(/^([A-Za-z]:)[\\/]/);
  if (winDrive) return winDrive[1].toUpperCase();
  if (folderPath.startsWith('/')) return '/';
  return folderPath;
}
