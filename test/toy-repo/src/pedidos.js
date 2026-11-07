// Pedidos de ejemplo para el repo de juguete de flowrunner.
export const pedidos = [
  { id: 1, estado: "confirmado", monto: 1250.5, fecha: "2026-10-01" },
  { id: 2, estado: "cancelado", monto: 300, fecha: "2026-10-02" },
  { id: 3, estado: "entregado", monto: 89.99, fecha: "2026-10-03" },
];

export function total(lista) {
  return lista.reduce((suma, pedido) => suma + pedido.monto, 0);
}
