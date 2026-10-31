// The two files the playground edits. In your application they come from wherever you keep code.
export const MAIN_TS = `import { twice } from './math'

// twice takes a number, so TypeScript flags this call.
console.log(twice('two'))

type Order = { id: string; quantity: number; price: number }

const orders: Order[] = [
  { id: 'a-1', quantity: 2, price: 4.5 },
  { id: 'b-7', quantity: 1, price: 12 },
  { id: 'c-3', quantity: 5, price: 0.8 },
]

function total(order: Order): number {
  return order.quantity * order.price
}

export function summary(): string {
  const sum = orders.reduce((acc, o) => acc + total(o), 0)
  return \`\${orders.length} orders, \${sum.toFixed(2)} total\`
}
`

export const MATH_TS = `export const twice = (n: number) => n * 2
`
