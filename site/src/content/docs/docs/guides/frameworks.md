# React and Solid

Use the adapter for your framework so the editor mounts and disposes with its component. You need a client-side component and the core stylesheet.

## React

Install the core and adapter alongside React 19 and React DOM.

```sh
npm install @singapore-editor/core @singapore-editor/react react react-dom
```

### Mount an editor

`useEditor` returns a controller. Pass its `ref` to the element that hosts the editor, and give that element a height.

```tsx
import { useEditor } from '@singapore-editor/react'
import '@singapore-editor/core/style.css'

export function EditorPanel() {
  const controller = useEditor({
    document: {
      documentId: 'example.ts',
      defaultText: 'const value = 1\n',
      languageId: 'typescript',
    },
  })
  const { ref } = controller
  return <div ref={ref} style={{ height: '32rem' }} />
}
```

Take `ref` out of the controller before you pass it to JSX. The React Compiler treats `ref={controller.ref}` as a ref read and then rejects later render reads of the controller, such as `controller.getEditor()`.

The editor owns the text. It reads `defaultText` when the document opens and ignores later changes to it, the same way an `<input>` treats `defaultValue`.

### Open a different file

A new `documentId` opens a new document with its `defaultText`. Rendering again with the same id keeps whatever the user typed.

```tsx
import { useEditor } from '@singapore-editor/react'

export function FileEditor({ path, contents }: { path: string; contents: string }) {
  const { ref } = useEditor({
    document: { documentId: path, defaultText: contents },
  })
  return <div ref={ref} style={{ height: '32rem' }} />
}
```

### Replace the text from outside

To load new contents into the open document, for example after the file changed on disk, call `commands.setText`.

```tsx
import { useEditor } from '@singapore-editor/react'

export function ReloadableEditor({ url }: { url: string }) {
  const controller = useEditor({ document: { documentId: url, defaultText: '' } })
  const { ref } = controller

  const reload = async () => {
    const response = await fetch(url)
    controller.commands.setText(await response.text())
  }

  return (
    <>
      <button onClick={reload}>Reload</button>
      <div ref={ref} style={{ height: '32rem' }} />
    </>
  )
}
```

### Show text you compute

For a read-only view of text that comes from props, such as a preview or a generated file, pass `text`. The editor applies each new value as an edit, so the scroll position survives.

```tsx
import { useEditor } from '@singapore-editor/react'

export function JsonPreview({ value }: { value: unknown }) {
  const { ref } = useEditor({
    document: { documentId: 'preview.json', text: JSON.stringify(value, null, 2) },
    editability: 'readonly',
  })
  return <div ref={ref} style={{ height: '16rem' }} />
}
```

### Keep the text in React state

`text` with `onTextChange` makes React state the source of the text. Each keystroke copies the whole document into a string and re-renders your component, so use this for small fields. For files, use `defaultText` and read the text when you need it with `controller.materializeFullText()`.

```tsx
import { useState } from 'react'
import { useEditor } from '@singapore-editor/react'

export function ConfigField() {
  const [config, setConfig] = useState('{\n  "debug": false\n}\n')
  const { ref } = useEditor({
    document: { documentId: 'config.json', text: config },
    onTextChange: setConfig,
  })
  return <div ref={ref} style={{ height: '8rem' }} />
}
```

`onTextChange` also works with `defaultText`. It never fires for text the adapter applied from `text` or `defaultText`. If you pass `text` without `onTextChange` to an editable editor, the adapter warns on the first edit, because the next `text` will replace it.

### Read editor state

`useEditorSelector` re-renders the component only when the value it selects changes.

```tsx
import { useEditor, useEditorSelector } from '@singapore-editor/react'

export function EditorWithStatus() {
  const controller = useEditor({ document: { documentId: 'notes.md', defaultText: '' } })
  const { ref } = controller
  const cursor = useEditorSelector(
    controller,
    (snapshot) => snapshot.state?.cursor ?? null,
    (a, b) => a?.row === b?.row && a?.column === b?.column,
  )

  return (
    <>
      <div ref={ref} style={{ height: '32rem' }} />
      <p>{cursor ? `Ln ${cursor.row + 1}, Col ${cursor.column + 1}` : null}</p>
    </>
  )
}
```

### Run editor actions from your UI

`controller.commands` is safe to call before the editor mounts, and does nothing then.

```tsx
import { useEditor } from '@singapore-editor/react'
import { createEditorFindPlugin } from '@singapore-editor/find'
import '@singapore-editor/find/style.css'

// Created once. A new plugin instance on each render would reinstall it every time.
const plugins = [createEditorFindPlugin()]

export function EditorWithFind() {
  const controller = useEditor({ document: { documentId: 'a.ts', defaultText: '' }, plugins })
  const { ref } = controller
  return (
    <>
      <button onClick={() => controller.commands.openFind()}>Find</button>
      <div ref={ref} style={{ height: '32rem' }} />
    </>
  )
}
```

## Solid

Install the Solid adapter alongside Solid.

```sh
npm install @singapore-editor/core @singapore-editor/solid solid-js
```

`createEditor` returns a controller with a `ref` and state accessors. Call it inside a component or Solid root so its owner controls cleanup. Options accept a value or an accessor, and changing a signal updates the mounted editor.

```tsx
import { createSignal } from 'solid-js'
import { createEditor } from '@singapore-editor/solid'
import '@singapore-editor/core/style.css'

export function EditorPanel() {
  const [wordWrap, setWordWrap] = createSignal(false)
  const controller = createEditor({
    document: {
      documentId: 'example.ts',
      defaultText: 'const value = 1\n',
      languageId: 'typescript',
    },
    wordWrap,
  })
  return (
    <>
      <button onClick={() => setWordWrap(!wordWrap())}>Toggle wrapping</button>
      <div ref={controller.ref} style={{ height: '32rem' }} />
    </>
  )
}
```

The document fields work as in React. `defaultText` is read when the document opens, `text` with `onTextChange` keeps a signal in sync, and `controller.commands.setText` replaces the text from outside.

```tsx
import { createSignal } from 'solid-js'
import { createEditor } from '@singapore-editor/solid'

export function ConfigField() {
  const [config, setConfig] = createSignal('{\n  "debug": false\n}\n')
  const controller = createEditor({
    document: () => ({ documentId: 'config.json', text: config() }),
    onTextChange: setConfig,
  })
  return <div ref={controller.ref} style={{ height: '8rem' }} />
}
```

## If it doesn't work

### The container is empty

Check the `ref` binding, the container height, flex layout and the stylesheet. In an SSR application, mount this component on the client.

### New text does not show up

`defaultText` is read only when the document opens. Change `documentId` to open another document, call `commands.setText` to replace the text of the open one, or pass `text` if the prop should always win.

Continue with [documents and sessions](documents.md), or the generated [React](/docs/reference/api/react/overview/) and [Solid](/docs/reference/api/solid/overview/) references.
