/// <reference types="vite/client" />
// vite/client provides the `import.meta.glob` types used in docs-imports.ts.

declare module '*.md?raw' {
  const content: string;
  export default content;
}
