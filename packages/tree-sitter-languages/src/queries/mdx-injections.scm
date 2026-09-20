; Only query conventions evaluated by this runtime are admitted.
(fenced_code_block
  (info_string (language) @injection.language)
  (code_fence_content) @injection.content)

((markdown_inline) @injection.content (#set! injection.language "markdown_inline"))
((jsx_text) @injection.content (#set! injection.language "markdown"))
