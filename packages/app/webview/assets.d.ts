/** SVG files are bundled as text (esbuild loader "text"). */
declare module '*.svg' {
  const content: string;
  export default content;
}
