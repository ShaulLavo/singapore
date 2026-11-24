/**
 * Tree-sitter languages for Singapore. Each language plugin has its own entry point, such as
 * `@singapore-editor/tree-sitter-languages/typescript`, because a bundler emits every grammar its
 * import graph names, even when tree-shaking drops the code. One shared entry would put every
 * language's grammar into every app's build output.
 *
 * Plugins: `/typescript` (`typeScript()`), `/tsx` (`tsx()`), `/javascript` (`javaScript()`),
 * `/html` (`html()`), `/css` (`css()`), `/json` (`json()`) and `/markdown` (`markdown()`).
 * `/catalog` lists every bundled language contribution; `/metadata` lists ids and extensions
 * without loading any grammar.
 *
 * @module
 */
export { TREE_SITTER_LANGUAGE_METADATA } from './metadata'
