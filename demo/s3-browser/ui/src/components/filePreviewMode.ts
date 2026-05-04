const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'yaml', 'yml', 'xml', 'csv', 'log',
  'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'sh', 'bash', 'py', 'rs', 'js', 'ts', 'html', 'css',
  'sha', 'sha1', 'sha256', 'sha512', 'sum',
  'gitignore', 'dockerignore', 'dockerfile', 'makefile',
  'license', 'readme', 'changelog',
]);

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico',
]);

export function getPreviewMode(filename: string): 'text' | 'image' | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const basename = filename.split('/').pop()?.toLowerCase() ?? '';
  if (TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(basename)) return 'text';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return null;
}
