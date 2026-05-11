import { optimizeGLTF } from "@iwsdk/vite-plugin-gltf-optimizer";
import { iwsdkDev } from "@iwsdk/vite-plugin-dev";
import { compileUIKit } from "@iwsdk/vite-plugin-uikitml";
import { defineConfig } from "vite";
import mkcert from "vite-plugin-mkcert";

export default defineConfig({
  plugins: [
    mkcert(),
    iwsdkDev({
      emulator: {
        device: "metaQuest3",
        injectOnBuild: true,
        activation: "always",
        userAgentException: /OculusBrowser/,
      },
      ai: { tools: ["claude"] },
      verbose: true,
    }),

    compileUIKit({ sourceDir: "ui", outputDir: "public/ui", verbose: true }),
    optimizeGLTF({
      level: "medium",
      verbose: true,
    }),
  ],
  server: { host: "0.0.0.0", port: 8081, open: true },
  build: {
    outDir: "dist",
    sourcemap: process.env.NODE_ENV !== "production",
    target: "esnext",
    rollupOptions: { input: "./index.html" },
  },
  esbuild: { target: "esnext" },
  optimizeDeps: {
    exclude: ["@babylonjs/havok"],
    esbuildOptions: { target: "esnext" },
  },
  publicDir: "public",
  base: process.env.NODE_ENV === "production" ? "/lathe-xr/" : "/",
});
