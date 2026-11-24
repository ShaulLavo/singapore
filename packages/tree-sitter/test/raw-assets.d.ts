// Real documents the browser tests read as text through Vite.
declare module '*.md?raw' {
  const source: string
  export default source
}

declare module '*.js?raw' {
  const source: string
  export default source
}
