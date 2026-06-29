const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

// 🧠 memoria de pedidos
let pedidos = [];

io.on("connection", (socket) => {
  console.log("🟢 Usuario conectado:", socket.id);

  // 📦 enviar historial al conectar
  socket.emit("pedidos-iniciales", pedidos);

  // 📦 NUEVO PEDIDO
  socket.on("nuevo-pedido", (data) => {
    const pedido = {
      ...data,
      id: Date.now(),
      estado: "pendiente"
    };

    pedidos.push(pedido);

    // 🔥 enviar a TODOS (cliente + repartidor)
    io.emit("pedido-actualizado", pedido);
  });

  // 🔄 CAMBIAR ESTADO (aceptado / en camino / entregado)
  socket.on("cambiar-estado", (pedidoActualizado) => {
    pedidos = pedidos.map((p) =>
      p.id === pedidoActualizado.id ? pedidoActualizado : p
    );

    io.emit("pedido-actualizado", pedidoActualizado);
  });

  // ❌ CANCELAR PEDIDO (NUEVO IMPORTANTE)
  socket.on("cancelar-pedido", (data) => {
    pedidos = pedidos.map((p) =>
      p.id === data.id ? { ...p, estado: "cancelado" } : p
    );

    const actualizado = pedidos.find((p) => p.id === data.id);

    io.emit("pedido-actualizado", actualizado);
  });

  // 🛵 GPS REPARTIDOR
  socket.on("repartidor-ubicacion", (data) => {
    io.emit("repartidor-movimiento", data);
  });

  socket.on("disconnect", () => {
    console.log("🔴 Usuario desconectado:", socket.id);
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log("🚀 Servidor Socket.io corriendo en puerto " + PORT);
});