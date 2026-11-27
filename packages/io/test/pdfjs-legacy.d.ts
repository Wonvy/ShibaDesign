/** pdf.js 给 Node 用的构建没有自带类型声明，接口和浏览器构建相同 */
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export * from 'pdfjs-dist';
}
