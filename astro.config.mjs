// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import vercel from '@astrojs/vercel';
import tailwindcss from '@tailwindcss/vite';

// Static output; only /api/* routes opt into SSR with `export const prerender = false`.
// maxDuration 300 covers the audit pipeline (extraction can run 20-90s).
export default defineConfig({
  site: 'https://xcapfactoring.com',
  output: 'static',
  adapter: vercel({ maxDuration: 300 }),
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
  build: {
    inlineStylesheets: 'auto',
  },
});
