// Vite's ?raw suffix imports a file as a string. The Workers types have no
// node:fs, and tests should not need it just to read a migration.
declare module '*?raw' {
  const content: string;
  export default content;
}
