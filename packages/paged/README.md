# @singapore-editor/paged

A read-only model for viewing UTF-8 files on demand.

## Install

```sh
npm install @singapore-editor/paged
```

## Usage

```ts
import { blobRangeSource, PagedDocument } from '@singapore-editor/paged'

const blob = new Blob(['First line\nSecond line\n'])
const document = new PagedDocument(blobRangeSource(blob, { id: 'example', revision: '1' }))
const view = document.createView()
const first = await view.first(2)
console.log(first.fragments.map((piece) => piece.text))
view.dispose()
document.dispose()
```

[Paging contract](docs/contract.md) · [API reference](https://singapore.shaulavo.dev/docs/reference/api/paged/overview/) · [License](../../LICENSE)
