import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Builds the portal into dist/, which the Worker serves; run it locally with `npx wrangler dev`
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
