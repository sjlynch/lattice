import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5183,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:5184',
      '/ws': {
        target: 'ws://127.0.0.1:5184',
        ws: true,
      },
    },
  },
});
