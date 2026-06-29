// Ambient declaration so TypeScript accepts side-effect CSS imports
// (e.g. `import "./globals.css"` in app/layout.tsx). Next/webpack handles the
// actual CSS bundling at build time; this only satisfies the type checker.
declare module "*.css";
