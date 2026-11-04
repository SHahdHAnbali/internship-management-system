/** Vite `?raw` imports in tests: the file's text (test/security-headers.test.ts reads wrangler.jsonc this way). */
declare module '*?raw' {
  const content: string;
  export default content;
}
