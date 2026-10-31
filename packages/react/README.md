# @singapore-editor/react

React components and hooks for mounting and controlling the Singapore editor.

Part of [Singapore](https://singapore.shaulavo.dev/). A code editor for the browser that keeps every version.

## Install

```sh
npm install @singapore-editor/core @singapore-editor/react react@19 react-dom@19
```

## Usage

Render this component in your app. Pass the controller's `ref` to the element that hosts the editor, and give that element a height.

```tsx
import { useEditor } from '@singapore-editor/react'
import '@singapore-editor/core/style.css'

export function EditorPanel() {
  const controller = useEditor({
    document: {
      documentId: 'example.ts',
      defaultText: 'const value = 1;\n',
      languageId: 'typescript',
    },
  })
  const { ref } = controller

  return <div ref={ref} style={{ height: '32rem' }} />
}
```

Take `ref` out of the controller before you pass it to JSX. The React Compiler treats `ref={controller.ref}` as a ref read and then rejects later render reads of the controller, such as `controller.getEditor()`.

## API highlights

- `useEditor()` creates a controller from props.
- The controller's `ref` mounts the view into an element. It needs React 19 ref cleanups.
- `document.defaultText` sets the text when the document opens; `document.text` with `onTextChange` keeps it in React state.
- `useEditorSelector()` subscribes to a state selection.

[Generated API reference](https://singapore.shaulavo.dev/docs/reference/api/react/overview/)

## In the Singapore family

`@singapore-editor/core` owns the editor view. This optional package adds React lifecycle and state bindings. Choose the other plugins your app needs.

[Singapore README](https://github.com/ShaulLavo/singapore/blob/main/README.md) · [Documentation](https://singapore.shaulavo.dev/docs/start-here/introduction/)

## License

MIT. [License](https://github.com/ShaulLavo/singapore/blob/main/LICENSE)
